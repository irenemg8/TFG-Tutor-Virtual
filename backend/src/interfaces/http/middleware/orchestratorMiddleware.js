"use strict";

const express = require("express");
const fs = require("fs");
const path = require("path");

/*------------------------------------------------------------------------------
            _________________________________________________________
            |                ORCHESTRATOR MIDDLEWARE                |
            |  Thin HTTP adapter that dispatches POST /chat/stream  |
            |  through the orchestrator when USE_ORCHESTRATOR=1,     |
            |  replacing ragMiddleware. Preserves the exact frontend |
            |  SSE contract (interaccionId, chunk, [DONE]) and the  |
            |  per-message metadata (classification, guardrails,    |
            |  timing, sourcesCount, isCorrectAnswer, decision).    |
        ____|________________                                       |
   Txt -> | _isValidId() | -> T/F                  (pure check)      |
          --------------                                            |
        ____|_____________________                                  |
   Txt -> | detectGreetingLang() | -> Txt | null   (pure)           |
          ----------------------                                    |
        ____|_______________                                        |
   Txt, Txt, Txt -> | dumpToFile() | -> void        (debug dump)     |
                   --------------                                   |
        ____|_____________________________                          |
   Txt, Obj -> | dumpOrchestratorContext() | -> void  (debug dump)   |
              ---------------------------                            |
        ____|___________                                            |
   Obj, Obj -> | sseSend() | -> void                (SSE write)      |
              -----------                                           |
        ____|__________                                             |
   Obj, Obj -> | endSSE() | -> void                 (SSE close)      |
              ----------                                            |
        ____|__________________                                     |
   ... -> | handleGreeting() | -> Promise<void>     (deterministic)  |
          ------------------                                        |
            |                                                       |
            |   router.post("/chat/stream", ...) handles the turn,  |
            |   gated by USE_ORCHESTRATOR=1 (ENABLED).              |
            |_______________________________________________________|
------------------------------------------------------------------------------*/

/*
 Txt -> ____|________________
       | _isValidId() | -> T/F
        --------------
    True when v is a legacy ObjectId (24 hex) or a UUID.
*/
function _isValidId(v) {
  if (typeof v !== "string") return false;
  return /^[a-f0-9]{24}$/i.test(v) || /^[0-9a-f-]{36}$/i.test(v);
}
const container = require("../../../container");
const trace = require("../../../infrastructure/events/pipelineDebugLogger");
const ragBus = require("../../../infrastructure/events/ragEventBus");
const Message = require("../../../domain/entities/Message");
const { resolveLanguage, getGreetingResponse, greetingPatterns } = require("../../../domain/services/languageManager");

/*
 Txt -> ____|_____________________
       | detectGreetingLang() | -> Txt | null
        ----------------------
    Detects the language of a bare greeting ("hello", "hola", "bon dia")
    by matching greetingPatterns directly, since resolveLanguage needs more
    tokens. Returns null when no greeting pattern matches.
*/
function detectGreetingLang(message) {
  if (typeof message !== "string") return null;
  const lower = message.toLowerCase().trim().replace(/[¿?¡!.,]/g, "");
  if (!lower) return null;
  for (const lang of Object.keys(greetingPatterns)) {
    for (const pat of greetingPatterns[lang]) {
      if (lower === pat || lower.startsWith(pat + " ") || lower.endsWith(" " + pat)) {
        return lang;
      }
    }
  }
  return null;
}

const DEBUG_DUMP_CONTEXT = process.env.DEBUG_DUMP_CONTEXT === "1";
const DEBUG_DUMP_PATH = process.env.DEBUG_DUMP_PATH || "./debug_ollama";

/*
 Txt, Txt, Txt -> ____|_______________
                 | dumpToFile() | -> void
                  --------------
    Writes a labeled debug dump to disk when DEBUG_DUMP_CONTEXT is on, so
    dumps work under USE_ORCHESTRATOR=1 too. Errors are swallowed with a warn.
*/
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

/*
 Txt, Obj -> ____|___________________________
            | dumpOrchestratorContext() | -> void
             ---------------------------
    When DEBUG_DUMP_CONTEXT is on, writes three debug files per request:
    the LLM system prompt, the full messages array, and an essential
    summary of the orchestrator context (classification, ragResult,
    guardrails, timing) — without dumping the whole exercise.
*/
function dumpOrchestratorContext(reqId, ctx) {
  if (!DEBUG_DUMP_CONTEXT) return;
  const systemMsg = (ctx.llmMessages && ctx.llmMessages[0] && ctx.llmMessages[0].content) || "";
  dumpToFile(reqId, "prompt", systemMsg);

  dumpToFile(reqId, "messages", JSON.stringify(ctx.llmMessages || [], null, 2));

  const summary = {
    reqId: reqId,
    userId: ctx.userId,
    exerciseId: ctx.exerciseId,
    exerciseNum: ctx.exerciseNum,
    interaccionId: ctx.interactionId,
    userMessage: ctx.userMessage,
    lang: ctx.lang,
    classification: ctx.classification,
    detectedConcepts: (ctx.classification && ctx.classification.concepts) || [],
    ac_refs: (ctx.exercise && ctx.exercise.tutorContext && ctx.exercise.tutorContext.acRefs) || [],
    correctAnswer: ctx.correctAnswer,
    evaluableElements: ctx.evaluableElements,
    loopState: ctx.loopState,
    detectedACs: ctx.detectedACs || [],
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
const FIN_TOKEN = "<END_EXERCISE>";

/*
 Obj, Obj -> ____|___________
            | sseSend() | -> void
             -----------
    Writes one SSE data frame with the JSON payload and flushes.
*/
function sseSend(res, payload) {
  res.write("data: " + JSON.stringify(payload) + "\n\n");
  if (typeof res.flush === "function") res.flush();
}

/*
 Obj, Obj -> ____|__________
            | endSSE() | -> void
             ----------
    Clears the heartbeat, writes the [DONE] terminator and ends the response.
*/
function endSSE(res, hb) {
  if (hb) clearInterval(hb);
  res.write("data: [DONE]\n\n");
  if (typeof res.flush === "function") res.flush();
  res.end();
}

/*
 Obj, Obj, Obj, Txt, Txt, Txt -> ____|__________________
                                | handleGreeting() | -> Promise<void>
                                 ------------------
    Deterministic greeting handler that skips both the orchestrator and the
    legacy fallback (which would call the LLM with the full tutor prompt and
    no guardrails). Sends a varied canned greeting in the conversation
    language over SSE and persists both messages for a consistent history.
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
    const created = await container.interaccionRepo.create({ userId: userId, exerciseId: exerciseId });
    iid = created.id;
    isFirstTurn = true;
    sseSend(res, { interaccionId: iid });
  }

  const userText = String(req.body.userMessage || "").trim();
  await container.messageRepo.appendMessage(iid, new Message({
    interactionId: iid, role: "user", content: userText,
  }));

  const prior = await container.messageRepo.getLastMessages(iid, 6);
  if (!isFirstTurn) {
    isFirstTurn = prior.filter(m => m.isAssistant()).length === 0;
  }
  const greetingLang = detectGreetingLang(userText);
  const lang = greetingLang || resolveLanguage(prior.map(m => m.toOllamaFormat()));

  const greeting = getGreetingResponse(lang, isFirstTurn);

  await container.messageRepo.appendMessage(iid, new Message({
    interactionId: iid, role: "assistant", content: greeting,
    metadata: { classification: "greeting", decision: "deterministic_greeting" },
  }));
  await container.interaccionRepo.updateEndTime(iid, new Date());

  sseSend(res, { chunk: greeting });
  endSSE(res, hb);
}

const ENABLED = process.env.USE_ORCHESTRATOR === "1";

router.post("/chat/stream", async function (req, res, next) {
  if (!ENABLED) return next();
  if (!container._initialized) {
    trace.traceRouteHandler && trace.traceRouteHandler("", "orchestrator_container_not_ready", {});
    return next();
  }

  const userId = req.userId;
  const { exerciseId, interaccionId, userMessage } = req.body || {};

  if (!userId || !_isValidId(userId)) return next();
  if (!exerciseId || !_isValidId(exerciseId)) return next();
  if (typeof userMessage !== "string" || userMessage.trim() === "") return next();
  if (interaccionId && !_isValidId(interaccionId)) return next();

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
        } catch (_) {}
      }
      return;
    }
  } catch (e) {
  }

  const reqId = trace.traceRequestStart("orchestrator", {
    userId: userId, exerciseId: exerciseId, interaccionId: interaccionId, userMessage: userMessage,
  });
  ragBus.setRequestId(reqId);
  const budgetMs = Number(process.env.ORCHESTRATOR_BUDGET_MS || 30000);
  trace.traceBudgetSet(reqId, budgetMs);

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

  const onRagEvent = (envelope) => {
    if (!envelope || envelope.requestId !== reqId) return;
    try {
      sseSend(res, {
        phase: envelope.event,
        status: envelope.status,
        ts: envelope.timestamp,
        data: envelope.data,
      });
      if (envelope.event === "guardrail_rewriting" && envelope.status === "start") {
        sseSend(res, { rewriting: true, reason: "guardrail" });
      }
    } catch (_) {}
  };
  ragBus.on("rag", onRagEvent);
  const detachRagListener = () => ragBus.off("rag", onRagEvent);

  try {
    let iid = interaccionId || null;
    if (iid) {
      const exists = await container.interaccionRepo.existsForUser(iid, userId);
      if (!exists) iid = null;
    }
    if (!iid) {
      const created = await container.interaccionRepo.create({ userId: userId, exerciseId: exerciseId });
      iid = created.id;
      sseSend(res, { interaccionId: iid });
    }

    const streamTokens = process.env.ORCHESTRATOR_STREAM_TOKENS !== "0";
    const tokenStreamHandler = streamTokens
      ? (token) => {
          try { sseSend(res, { chunk: token, partial: true }); } catch (_) {}
        }
      : null;

    const ctx = await container.orchestrator.process({
      userId: userId,
      exerciseId: exerciseId,
      userMessage: userMessage.trim(),
      interactionId: iid,
      budgetMs: budgetMs,
      reqId: reqId,
      tokenStreamHandler: tokenStreamHandler,
    });

    if (ctx.fallthrough && !ctx.finalResponse) {
      trace.traceRagGate(reqId, "orchestrator_fallthrough", { reason: "fallthrough flag set" });
      clearInterval(hb);
      detachRagListener();
      sseSend(res, { error: "Orchestrator deferred to fallback. Please retry." });
      endSSE(res);
      return;
    }

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
    const streamed = ctx.streamedText || "";
    const tokensSentToClient = streamTokens && streamed.length > 0;
    if (!tokensSentToClient) {
      sseSend(res, { chunk: responseText });
    } else if (responseText !== streamed) {
      sseSend(res, { chunk: responseText, replace: true, correction: true });
    }
    sseSend(res, {
      done: true,
      fullText: responseText,
      timing: {
        totalMs: Date.now() - (ctx.timing.pipelineStartMs || Date.now()),
        ollamaMs: ctx.timing.ollamaMs,
        firstTokenMs: ctx.timing.firstTokenMs || null,
        pipelineMs: ctx.timing.pipelineMs || null,
      },
    });
    trace.traceResponse(reqId, {
      len: responseText.length,
      containsFIN: responseText.includes(FIN_TOKEN),
      response: responseText,
    });

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
    } catch (_) {}
  }
});

module.exports = router;
