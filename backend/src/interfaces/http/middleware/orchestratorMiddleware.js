"use strict";

// Thin HTTP adapter that dispatches POST /chat/stream through the orchestrator.
// Replaces ragMiddleware when USE_ORCHESTRATOR=1.
//
// Preserves the EXACT frontend SSE contract:
//   data: { interaccionId: "..." }        (sent once when a new interaccion is created)
//   data: { chunk: "tutor response..." }  (the full response as a single chunk)
//   data: [DONE]                          (terminator)
//
// Preserves MongoDB metadata: Interaccion.conversacion entries keep classification,
// guardrails.*, timing.*, sourcesCount, isCorrectAnswer, decision.

const express = require("express");
const fs = require("fs");
const path = require("path");
// ID validator accepting ObjectId (legacy) or UUID (new).
function _isValidId(v) {
  if (typeof v !== "string") return false;
  return /^[a-f0-9]{24}$/i.test(v) || /^[0-9a-f-]{36}$/i.test(v);
}
const container = require("../../../container");
const trace = require("../../../infrastructure/events/pipelineDebugLogger");
const ragBus = require("../../../infrastructure/events/ragEventBus");
const Message = require("../../../domain/entities/Message");
const { resolveLanguage, getGreetingResponse } = require("../../../domain/services/languageManager");

// DEBUG_DUMP_CONTEXT — replica de ollamaChatRoutes.dumpToFile() para que el
// dump funcione también bajo USE_ORCHESTRATOR=1. Sin esto, /tmp/tv_dump
// quedaba vacío en local porque la ruta legacy no se ejecutaba.
const DEBUG_DUMP_CONTEXT = process.env.DEBUG_DUMP_CONTEXT === "1";
const DEBUG_DUMP_PATH = process.env.DEBUG_DUMP_PATH || "./debug_ollama";

function dumpToFile(reqId, label, content) {
  if (!DEBUG_DUMP_CONTEXT) return;
  try {
    if (!fs.existsSync(DEBUG_DUMP_PATH)) fs.mkdirSync(DEBUG_DUMP_PATH, { recursive: true });
    const filename = path.join(
      DEBUG_DUMP_PATH,
      new Date().toISOString().replace(/[:.]/g, "-") + "_" + reqId + "_" + label + ".txt"
    );
    fs.writeFileSync(filename, content, "utf8");
  } catch (err) {
    console.warn("[Orchestrator dump] failed to write " + label + ":", err.message);
  }
}

function dumpOrchestratorContext(reqId, ctx) {
  if (!DEBUG_DUMP_CONTEXT) return;
  // 1) Prompt (system message del LLM): EXACTAMENTE lo que recibió Ollama.
  const systemMsg = (ctx.llmMessages && ctx.llmMessages[0] && ctx.llmMessages[0].content) || "";
  dumpToFile(reqId, "prompt", systemMsg);

  // 2) Messages array completo (system + history + user actual).
  dumpToFile(reqId, "messages", JSON.stringify(ctx.llmMessages || [], null, 2));

  // 3) Snapshot del context (clasificación, ragResult, guardrails, timing).
  //    No volcamos el ejercicio entero (puede ser grande); solo lo esencial.
  const summary = {
    reqId: reqId,
    userId: ctx.userId,
    exerciseId: ctx.exerciseId,
    exerciseNum: ctx.exerciseNum,
    interaccionId: ctx.interaccionId,
    userMessage: ctx.userMessage,
    lang: ctx.lang,
    classification: ctx.classification,
    detectedConcepts: (ctx.classification && ctx.classification.concepts) || [],
    ac_refs: (ctx.ejercicio && ctx.ejercicio.tutorContext && ctx.ejercicio.tutorContext.ac_refs) || [],
    correctAnswer: ctx.correctAnswer,
    evaluableElements: ctx.evaluableElements,
    loopState: ctx.loopState,
    ragResult: {
      decision: ctx.ragResult && ctx.ragResult.decision,
      sourcesCount: (ctx.ragResult && ctx.ragResult.sources && ctx.ragResult.sources.length) || 0,
      augmentationLength: (ctx.ragResult && ctx.ragResult.augmentation && ctx.ragResult.augmentation.length) || 0,
      augmentation: (ctx.ragResult && ctx.ragResult.augmentation) || "",
    },
    budget: {
      totalMs: ctx.budgetMs,
      retrievalSliceMs: ctx.retrievalBudgetMs,
      tutorSliceMs: ctx.tutorBudgetMs,
      guardrailSliceMs: ctx.guardrailBudgetMs,
    },
    timing: ctx.timing,
    guardrailsTriggered: ctx.guardrailsTriggered,
    guardrailPath: ctx.guardrailPath,
    guardrailLlmRetries: ctx.guardrailLlmRetries,
    guardrailSurgicalFixes: ctx.guardrailSurgicalFixes,
    llmResponse: ctx.llmResponse,
    finalResponse: ctx.finalResponse,
    fallbackUsed: ctx.fallbackUsed,
    deterministicFinish: ctx.deterministicFinish,
    error: ctx.error ? { message: ctx.error.message, stack: ctx.error.stack } : null,
  };
  dumpToFile(reqId, "summary", JSON.stringify(summary, null, 2));
}

const router = express.Router();
const FIN_TOKEN = "<FIN_EJERCICIO>";

function sseSend(res, payload) {
  res.write("data: " + JSON.stringify(payload) + "\n\n");
  if (typeof res.flush === "function") res.flush();
}

function endSSE(res, hb) {
  if (hb) clearInterval(hb);
  res.write("data: [DONE]\n\n");
  if (typeof res.flush === "function") res.flush();
  res.end();
}

/**
 * Deterministic greeting handler. Skips both the orchestrator and the legacy
 * ollamaChatRoutes fallback (which would otherwise call the LLM with the full
 * 17 KB tutor prompt — including the correct answer — without any guardrails).
 * Returns a varied canned greeting in the conversation language and persists
 * both messages so the chat history is consistent.
 */
async function handleGreeting(req, res, hb, userId, exerciseId, interaccionId) {
  const sseHeadersSent = res.headersSent;
  if (!sseHeadersSent) {
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    if (typeof res.flushHeaders === "function") res.flushHeaders();
    res.write(": ok\n\n");
  }

  let iid = interaccionId || null;
  if (iid) {
    const exists = await container.interaccionRepo.existsForUser(iid, userId);
    if (!exists) iid = null;
  }
  let isFirstTurn = false;
  if (!iid) {
    const created = await container.interaccionRepo.create({ usuarioId: userId, ejercicioId: exerciseId });
    iid = created.id;
    isFirstTurn = true;
    sseSend(res, { interaccionId: iid });
  }

  const userText = String(req.body.userMessage || "").trim();
  await container.messageRepo.appendMessage(iid, new Message({
    interaccionId: iid, role: "user", content: userText,
  }));

  // Resolve language from prior turns; fall back to Spanish on first turn.
  const prior = await container.messageRepo.getLastMessages(iid, 6);
  if (!isFirstTurn) {
    isFirstTurn = prior.filter(m => m.isAssistant()).length === 0;
  }
  const lang = resolveLanguage(prior.map(m => m.toOllamaFormat()));

  const greeting = getGreetingResponse(lang, isFirstTurn);

  await container.messageRepo.appendMessage(iid, new Message({
    interaccionId: iid, role: "assistant", content: greeting,
    metadata: { classification: "greeting", decision: "deterministic_greeting" },
  }));
  await container.interaccionRepo.updateFin(iid, new Date());

  sseSend(res, { chunk: greeting });
  endSSE(res, hb);
}

const ENABLED = process.env.USE_ORCHESTRATOR === "1";

router.post("/chat/stream", async function (req, res, next) {
  if (!ENABLED) return next();
  if (!container._initialized) {
    // Container not ready — fall through to legacy
    trace.traceRouteHandler && trace.traceRouteHandler("", "orchestrator_container_not_ready", {});
    return next();
  }

  const userId = req.userId;
  const { exerciseId, interaccionId, userMessage } = req.body || {};

  // Quick validation (matches ragMiddleware pre-checks)
  if (!userId || !_isValidId(userId)) return next();
  if (!exerciseId || !_isValidId(exerciseId)) return next();
  if (typeof userMessage !== "string" || userMessage.trim() === "") return next();
  if (interaccionId && !_isValidId(interaccionId)) return next();

  // Pre-check: greetings are handled INLINE with a deterministic response.
  // We must NOT fall through to ollamaChatRoutes because that path runs the
  // LLM with the full 17 KB tutor prompt (which contains the correct answer)
  // and applies NO guardrails — a guaranteed leak vector. classifyQuery is
  // pure/sync and <1ms.
  try {
    const { classifyQuery } = require("../../../domain/services/rag/queryClassifier");
    const pre = classifyQuery(userMessage.trim(), [], []);
    if (pre && (pre.type === "greeting" || pre.type === "off_topic")) {
      trace.traceRouteHandler("", "orchestrator_greeting_inline", { classification: pre.type });
      try {
        await handleGreeting(req, res, null, userId, exerciseId, interaccionId);
      } catch (err) {
        trace.traceError("", "greeting", err);
        try {
          if (!res.headersSent) {
            res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
            if (typeof res.flushHeaders === "function") res.flushHeaders();
          }
          sseSend(res, { chunk: "¡Hola! ¿Por dónde te gustaría empezar?" });
          endSSE(res);
        } catch (_) { /* response may already be in bad state */ }
      }
      return;
    }
  } catch (e) {
    // If the pre-check itself fails, keep going — the orchestrator still runs.
  }

  const reqId = trace.traceRequestStart("orchestrator", {
    userId: userId, exerciseId: exerciseId, interaccionId: interaccionId, userMessage: userMessage,
  });
  // Tag every ragBus event emitted during this request so the SSE listener
  // below can filter by reqId. ragBus.setRequestId is a global singleton —
  // safe under Node's single-threaded model because the orchestrator pipeline
  // is fully awaited within this handler.
  ragBus.setRequestId(reqId);
  // Default 30s. Lower than the previous 45s so we fail fast when Ollama is
  // slow under load — better UX to show a fallback than to keep the user
  // staring at a spinner that ultimately times out at the SSE layer too.
  const budgetMs = Number(process.env.ORCHESTRATOR_BUDGET_MS || 30000);
  trace.traceBudgetSet(reqId, budgetMs);

  // Set SSE headers
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  if (typeof res.flushHeaders === "function") res.flushHeaders();
  res.write(": ok\n\n");

  const hb = setInterval(function () {
    res.write(": ping\n\n");
    if (typeof res.flush === "function") res.flush();
  }, 15000);

  // Forward intermediate pipeline events to the SSE client. Without this the
  // user only sees the final chunk after 5-30s of silence. ragBus is a global
  // singleton so we filter by reqId to avoid leaking events from concurrent
  // requests. Frontends that don't recognise `phase` payloads simply ignore
  // them — additive change, no breaking contract.
  const onRagEvent = (envelope) => {
    if (!envelope || envelope.requestId !== reqId) return;
    try {
      sseSend(res, {
        phase: envelope.event,
        status: envelope.status,
        ts: envelope.timestamp,
        data: envelope.data,
      });
    } catch (_) { /* response may already be closed */ }
  };
  ragBus.on("rag", onRagEvent);
  const detachRagListener = () => ragBus.off("rag", onRagEvent);

  try {
    // Pre-create Interaccion if needed so we can emit interaccionId early
    let iid = interaccionId || null;
    if (iid) {
      const exists = await container.interaccionRepo.existsForUser(iid, userId);
      if (!exists) iid = null;
    }
    if (!iid) {
      const created = await container.interaccionRepo.create({ usuarioId: userId, ejercicioId: exerciseId });
      iid = created.id;
      sseSend(res, { interaccionId: iid });
    }

    // Process through orchestrator
    const ctx = await container.orchestrator.process({
      userId: userId,
      exerciseId: exerciseId,
      userMessage: userMessage.trim(),
      interaccionId: iid,
      budgetMs: budgetMs,
      reqId: reqId,
    });

    // Attach the KG patterns and budget the orchestrator's agents need
    // (we do this INSIDE container initialization; here we're just reading results)

    // Handle fallthrough (greeting / off_topic / pipeline error without finalResponse)
    if (ctx.fallthrough && !ctx.finalResponse) {
      // Let the legacy handler take over
      trace.traceRagGate(reqId, "orchestrator_fallthrough", { reason: "fallthrough flag set" });
      clearInterval(hb);
      detachRagListener();
      // NOTE: headers already sent, so we can't call next(). Send a minimal "try again" chunk.
      // In practice fallthrough should happen BEFORE SSE headers are sent.
      // For greetings we still want to stream — defer to ragMiddleware by ending here.
      sseSend(res, { error: "Orchestrator deferred to fallback. Please retry." });
      endSSE(res);
      return;
    }

    // Send response as a single chunk (same as ragMiddleware).
    // Belt-and-suspenders: orchestrator's catch already fills finalResponse on
    // error, but if anything still slips through with an empty payload, send a
    // localized fallback so the chat never goes silent on the user.
    let responseText = ctx.finalResponse || ctx.llmResponse || "";
    if (!responseText) {
      const lang = ctx.lang || "es";
      const fallbacks = {
        es: "Disculpa, el tutor está tardando demasiado en responder ahora mismo. ¿Puedes reformular tu mensaje o intentarlo de nuevo en un momento?",
        val: "Disculpa, el tutor està tardant massa a respondre ara mateix. Pots reformular el teu missatge o tornar-ho a provar d'ací a un moment?",
        en: "Sorry, the tutor is taking too long to respond right now. Could you rephrase your message or try again in a moment?",
      };
      responseText = fallbacks[lang] || fallbacks.es;
    }
    sseSend(res, { chunk: responseText });
    trace.traceResponse(reqId, {
      len: responseText.length,
      containsFIN: responseText.includes(FIN_TOKEN),
      response: responseText,
    });

    // Dump prompt + messages + summary al disco si DEBUG_DUMP_CONTEXT=1.
    // Tres archivos por request: <ts>_<reqId>_prompt.txt, _messages.txt,
    // _summary.txt en DEBUG_DUMP_PATH (default /tmp/tv_dump en linux).
    dumpOrchestratorContext(reqId, ctx);

    detachRagListener();
    endSSE(res, hb);

    trace.traceRequestEnd(reqId, {
      outcome: "orchestrator_ok",
      totalMs: Date.now() - (ctx.timing.pipelineStartMs || Date.now()),
      responseLen: responseText.length,
      classification: ctx.classification && ctx.classification.type,
      decision: ctx.ragResult && ctx.ragResult.decision,
      guardrailTriggered: Object.values(ctx.guardrailsTriggered || {}).some(Boolean),
    });
  } catch (err) {
    clearInterval(hb);
    detachRagListener();
    trace.traceError(reqId, "orchestrator", err);
    console.error("[Orchestrator HTTP] Error:", err && err.message);
    try {
      sseSend(res, { error: "Error en el sistema RAG." });
      endSSE(res);
    } catch (_) { /* headers may be in bad state */ }
  }
});

module.exports = router;
