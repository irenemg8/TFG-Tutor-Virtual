// routes/ollamaChatRoutes
const express = require("express");
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const https = require("https");

const container = require("../../../container");
const Message = require("../../../domain/entities/Message");
const { buildTutorSystemPrompt } = require("../../../domain/services/promptBuilder");

// Helper: repos from container (fallback path — orchestrator handles most cases)
function repos() {
  if (!container._initialized) return null;
  return {
    ejercicioRepo: container.ejercicioRepo,
    interaccionRepo: container.interaccionRepo,
    messageRepo: container.messageRepo,
  };
}
const { resolveLanguage, getFinishMessages } = require("../../../domain/services/languageManager");

// ⚠️ Recomendación: dotenv se carga UNA vez en index.js.
// Lo dejo para no romperte nada, pero si ya lo cargas en index.js, puedes quitar esta línea.
require("dotenv").config();

const router = express.Router();

// =====================
// Warmup endpoint
// =====================
// POST /api/ollama/warmup
// Fired by the frontend the moment the chat screen mounts, before the
// student even types. The goal is to pay the model's cold-start latency
// (LiteLLM loading llama / qwen3 / phi4 into VRAM on the UPV side) in
// background while the user is still reading the exercise statement, so
// the first real turn is warm-fast instead of cold-slow.
//
// Idempotent: if the model is already resident, PoliGPT returns in <1s.
// Fire-and-forget on the client; we still return {ok, ms, model} so the
// browser console can show whether the warm-up actually completed.
//
// Disabled with WARMUP_ENABLED=false (default ON when LLM_PROVIDER=poligpt
// AND when LLM_PROVIDER=ollama; only useful where there is a cold start).
router.post("/warmup", async function (req, res) {
  const llmCfg = require("../../../infrastructure/llm/config");
  if (process.env.WARMUP_ENABLED === "false") {
    return res.json({ ok: true, skipped: true, reason: "WARMUP_ENABLED=false" });
  }

  const t0 = Date.now();
  const provider = (llmCfg.LLM_PROVIDER || "ollama").toLowerCase();

  try {
    if (provider === "poligpt") {
      if (!container._initialized || !container.llmService) {
        return res.status(503).json({ ok: false, error: "LLM service not ready" });
      }
      // Minimal prompt — PoliGPT bills by tokens and we only care about
      // forcing the model to load. max_tokens=1, temperature=0.
      await container.llmService.chatCompletion(
        [{ role: "user", content: "ping" }],
        { temperature: 0, numPredict: 1, budgetMs: 30000 }
      );
      const ms = Date.now() - t0;
      console.log("[WARMUP] PoliGPT ok (" + ms + "ms, model=" + llmCfg.POLIGPT_MODEL + ")");
      return res.json({ ok: true, ms: ms, provider: "poligpt", model: llmCfg.POLIGPT_MODEL });
    }

    // provider = ollama → same shape as warmupOllamaUPV() in index.js,
    // but on-demand from the client instead of only at backend boot.
    const url = String(llmCfg.OLLAMA_CHAT_URL).replace(/\/$/, "");
    const model = llmCfg.OLLAMA_MODEL;
    await axios.post(
      url + "/api/chat",
      {
        model: model,
        stream: false,
        keep_alive: llmCfg.OLLAMA_KEEP_ALIVE,
        messages: [
          { role: "system", content: "Responde solo con OK." },
          { role: "user", content: "OK" },
        ],
        options: { num_predict: 1, temperature: 0 },
      },
      { timeout: 30000 }
    );
    const ms = Date.now() - t0;
    console.log("[WARMUP] Ollama ok (" + ms + "ms, model=" + model + ")");
    return res.json({ ok: true, ms: ms, provider: "ollama", model: model });
  } catch (err) {
    const ms = Date.now() - t0;
    const msg = (err && err.message) || String(err);
    console.warn("[WARMUP] FAILED (" + ms + "ms):", msg);
    // 502 (bad gateway upstream) — the warmup is best-effort; the frontend
    // should swallow this and let the first real turn pay the cold start.
    return res.status(502).json({ ok: false, ms: ms, error: msg });
  }
});

// =====================
// Config (base)
// =====================

// Compatibilidad: si tienes OLLAMA_BASE_URL en algún sitio, también lo aceptamos.
const OLLAMA_API_URL_FALLBACK =
  process.env.OLLAMA_API_URL ||
  process.env.OLLAMA_BASE_URL ||
  "http://127.0.0.1:11434";

const OLLAMA_MODEL = process.env.OLLAMA_MODEL || "qwen2.5:latest";
const OLLAMA_KEEP_ALIVE = process.env.OLLAMA_KEEP_ALIVE || "60m";

// Stream: NO uses axios timeout (timeout=0), usamos un maxTimer propio.
const OLLAMA_STREAM_MAX_MS = Number(process.env.OLLAMA_STREAM_MAX_MS || 1800000); // 30 min
const OLLAMA_TIMEOUT_MS = Number(process.env.OLLAMA_TIMEOUT_MS || 60000); // 60s (NO-stream)

const OLLAMA_NUM_PREDICT = Number(process.env.OLLAMA_NUM_PREDICT || 120);
const OLLAMA_NUM_CTX = Number(process.env.OLLAMA_NUM_CTX || 8192);
const OLLAMA_TEMPERATURE = Number(process.env.OLLAMA_TEMPERATURE || 0.4);

const HISTORY_MAX_MESSAGES = Number(process.env.HISTORY_MAX_MESSAGES || 20);

const DEFAULT_START_MESSAGE =
  process.env.DEFAULT_START_MESSAGE ||
  "Quiero empezar el ejercicio. Guíame paso a paso con preguntas socráticas y explícame qué debo analizar primero.";

// Debug
const DEBUG_OLLAMA = process.env.DEBUG_OLLAMA === "1";
const DEBUG_DUMP_CONTEXT = process.env.DEBUG_DUMP_CONTEXT === "1";
const DEBUG_DUMP_PATH = process.env.DEBUG_DUMP_PATH || "./debug_ollama";
const trace = require("../../../infrastructure/events/pipelineDebugLogger");

// TLS (solo si hiciera falta en DEV)
const ALLOW_INSECURE_TLS = process.env.OLLAMA_INSECURE_TLS === "1";

// Token fin (para que el frontend lo detecte)
const FIN_TOKEN = "<FIN_EJERCICIO>";

// =====================
// Helpers
// =====================
function nowMs() {
  return Number(process.hrtime.bigint() / 1000000n);
}
function mkReqId() {
  return Math.random().toString(16).slice(2) + "-" + Date.now().toString(16);
}
function dlog(reqId, ...args) {
  if (DEBUG_OLLAMA) console.log(`[OLLAMA][${reqId}]`, ...args);
}
function dumpToFile(reqId, label, content) {
  if (!DEBUG_DUMP_CONTEXT) return;
  if (!fs.existsSync(DEBUG_DUMP_PATH)) fs.mkdirSync(DEBUG_DUMP_PATH, { recursive: true });
  const filename = path.join(
    DEBUG_DUMP_PATH,
    `${new Date().toISOString().replace(/[:.]/g, "-")}_${reqId}_${label}.txt`
  );
  fs.writeFileSync(filename, content, "utf8");
}

function isValidObjectId(x) {
  if (typeof x !== "string") return false;
  // Acepta ObjectId (24 hex chars) o UUID (36 chars con guiones)
  return /^[a-f0-9]{24}$/i.test(x) || /^[0-9a-f-]{36}$/i.test(x);
}

function normalizeBaseUrl(url) {
  if (!url || typeof url !== "string") return "";
  return url.replace(/\/$/, ""); // quita "/" final
}

// Decide a qué servidor llamar:
// 1) override por header (x-llm-mode)
// 2) LLM_MODE en .env
// 3) fallback OLLAMA_API_URL
function getOllamaBaseUrl(req) {
  const headerMode = String(req.headers["x-llm-mode"] || "").toLowerCase().trim(); // "local" | "upv"
  const envMode = String(process.env.LLM_MODE || "").toLowerCase().trim();
  const mode = headerMode || envMode;

  const upvUrl =
    process.env.OLLAMA_API_URL_UPV ||
    process.env.OLLAMA_BASE_URL_UPV ||
    "";

  const localUrl =
    process.env.OLLAMA_API_URL_LOCAL ||
    process.env.OLLAMA_BASE_URL_LOCAL ||
    "";

  let chosen = OLLAMA_API_URL_FALLBACK;

  if (mode === "upv" && upvUrl) chosen = upvUrl;
  if (mode === "local" && localUrl) chosen = localUrl;

  return { mode: mode || "default", baseUrl: normalizeBaseUrl(chosen) };
}

function buildSystemPrompt(ejercicio, lang) {
  let systemPrompt = buildTutorSystemPrompt(ejercicio, lang);

  if (typeof systemPrompt !== "string" || systemPrompt.trim() === "") {
    systemPrompt =
      "Eres un tutor socrático. Responde en español. No des la solución: guía con preguntas concretas.";
  }
  return systemPrompt;
}

function sseSend(res, payload) {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
  if (typeof res.flush === "function") res.flush();
}

function axiosConfigForBaseUrl(baseUrl) {
  // Para HTTPS, podemos setear un agent (y opcionalmente permitir TLS inseguro en DEV).
  if (baseUrl.startsWith("https://")) {
    return {
      httpsAgent: new https.Agent({ rejectUnauthorized: !ALLOW_INSECURE_TLS }),
    };
  }
  return {};
}

// =====================
// ✅ Validación determinista (respuesta correcta)
// =====================
function extractResistencias(text) {
  if (typeof text !== "string") return [];
  const matches = text.toUpperCase().match(/\bR\d+\b/g);
  if (!matches) return [];
  return [...new Set(matches.map((x) => x.trim()))];
}

function sameSet(a, b) {
  const A = new Set((a || []).map((x) => String(x).toUpperCase().trim()).filter(Boolean));
  const B = new Set((b || []).map((x) => String(x).toUpperCase().trim()).filter(Boolean));
  if (A.size !== B.size) return false;
  for (const x of A) if (!B.has(x)) return false;
  return true;
}

function isCorrectAnswerForExercise({ userText, ejercicio }) {
  const correct = ejercicio?.tutorContext?.correctAnswer;
  if (!Array.isArray(correct) || correct.length === 0) return false;

  const userSet = extractResistencias(userText);
  if (userSet.length === 0) return false;

  return sameSet(userSet, correct);
}

// ==============================
// Logs de arranque (solo informativos). Suprimidos cuando el provider
// activo es PoliGPT — esta ruta legacy Ollama sigue cargada por compat
// pero no se usa, y los prints confundían al ver "MODEL=qwen2.5:latest"
// junto al log real "[Container] LLM provider: poligpt (model=llama)".
// ==============================
if ((process.env.LLM_PROVIDER || "ollama").toLowerCase() === "ollama") {
  console.log("[OLLAMA CFG] MODEL =", OLLAMA_MODEL);
  console.log("[OLLAMA CFG] KEEP_ALIVE =", OLLAMA_KEEP_ALIVE);
  console.log(
    "[OLLAMA CFG] timeout(ms) =",
    OLLAMA_TIMEOUT_MS,
    "streamMax(ms) =",
    OLLAMA_STREAM_MAX_MS,
    "ctx =",
    OLLAMA_NUM_CTX,
    "predict =",
    OLLAMA_NUM_PREDICT,
    "history =",
    HISTORY_MAX_MESSAGES
  );
  console.log("[OLLAMA CFG] fallback URL =", normalizeBaseUrl(OLLAMA_API_URL_FALLBACK));
  console.log("[OLLAMA CFG] local URL =", normalizeBaseUrl(process.env.OLLAMA_API_URL_LOCAL || process.env.OLLAMA_BASE_URL_LOCAL || ""));
  console.log("[OLLAMA CFG] upv URL   =", normalizeBaseUrl(process.env.OLLAMA_API_URL_UPV || process.env.OLLAMA_BASE_URL_UPV || ""));
  console.log("[OLLAMA CFG] insecureTLS =", ALLOW_INSECURE_TLS ? "ON (DEV)" : "OFF");
}

// ==============================
// Healthcheck Ollama (según modo)
// ==============================
router.get("/health", async (req, res) => {
  const { mode, baseUrl } = getOllamaBaseUrl(req);

  try {
    const r = await axios.get(`${baseUrl}/api/version`, {
      timeout: 3000,
      ...axiosConfigForBaseUrl(baseUrl),
    });
    res.json({ ok: true, mode, url: baseUrl, model: OLLAMA_MODEL, version: r.data });
  } catch (e) {
    res.status(503).json({
      ok: false,
      mode,
      url: baseUrl,
      model: OLLAMA_MODEL,
      error: e?.message,
      code: e?.code,
      status: e?.response?.status || null,
    });
  }
});

// ==============================
// Util: lee SOLO últimos N mensajes (ligero)
// ==============================
async function loadLastMessages(interaccionId) {
  const r = repos();
  if (!r) return [];
  const msgs = await r.messageRepo.getLastMessages(interaccionId, HISTORY_MAX_MESSAGES);
  return msgs.map((m) => ({ role: m.role, content: m.content }));
}

// ==============================
// STREAM: /api/ollama/chat/stream
// ==============================
router.post("/chat/stream", async (req, res) => {
  const reqId = mkReqId();
  const t0 = nowMs();

  const { mode, baseUrl } = getOllamaBaseUrl(req);

  // SSE headers
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders?.();

  // abre SSE
  res.write(": ok\n\n");
  if (typeof res.flush === "function") res.flush();

  // heartbeat
  const hb = setInterval(() => {
    res.write(": ping\n\n");
    if (typeof res.flush === "function") res.flush();
  }, 15000);

  let aborted = false;
  req.on("close", () => {
    aborted = true;
    clearInterval(hb);
  });

  let finalized = false;
  const finalizeOnce = async ({ interaccionId, fullAssistant, reason, metadata }) => {
    if (finalized) return;
    finalized = true;

    clearInterval(hb);

    try {
      const r = repos();
      if (r) {
        if (typeof fullAssistant === "string" && fullAssistant.trim() !== "") {
          await r.messageRepo.appendMessage(interaccionId, new Message({
            interactionId: interaccionId, role: "assistant", content: fullAssistant, metadata: metadata || null,
          }));
        }
        await r.interaccionRepo.updateEndTime(interaccionId, new Date());
      }
    } catch (e) {
      console.error("Error guardando interacción tras stream:", e?.message || e);
    }

    res.write("data: [DONE]\n\n");
    if (typeof res.flush === "function") res.flush();
    res.end();

    dlog(reqId, "✅ finalize", {
      reason,
      totalMs: nowMs() - t0,
      assistantLen: (fullAssistant || "").length,
      mode,
      baseUrl,
    });
  };

  // Controller para abortar stream (timeout propio)
  const controller = new AbortController();
  const maxTimer = setTimeout(() => {
    if (!aborted) {
      dlog(reqId, "⏱️ abort por OLLAMA_STREAM_MAX_MS");
      controller.abort();
    }
  }, OLLAMA_STREAM_MAX_MS);

  try {
    const userId = req.userId; // From session via globalAuth (NEVER from client)
    const { exerciseId, interaccionId, userMessage } = req.body || {};

    // This handler only runs if ragMiddleware called next()
    var traceId = trace.traceRequestStart("ollamaChatRoutes_FALLBACK", {
      userId: userId,
      exerciseId: exerciseId,
      interaccionId: interaccionId,
      userMessage: userMessage,
    });
    trace.traceRouteHandler(traceId, "rag_middleware_did_not_handle", { mode: mode, baseUrl: baseUrl });

    dlog(reqId, "➡️ request", {
      mode,
      baseUrl,
      userId,
      exerciseId,
      interaccionId: interaccionId || null,
      msgLen: userMessage?.length || 0,
    });

    if (!isValidObjectId(userId) || !isValidObjectId(exerciseId)) {
      sseSend(res, { error: "IDs inválidos (userId/exerciseId)." });
      clearTimeout(maxTimer);
      return res.end();
    }
    if (interaccionId && !isValidObjectId(interaccionId)) {
      sseSend(res, { error: "interaccionId inválido." });
      clearTimeout(maxTimer);
      return res.end();
    }
    if (typeof userMessage !== "string" || userMessage.trim() === "") {
      sseSend(res, { error: "userMessage vacío." });
      clearTimeout(maxTimer);
      return res.end();
    }

    // Ejercicio
    const tDb0 = nowMs();
    const rx = repos();
    if (!rx) {
      sseSend(res, { error: "service_unavailable" });
      clearTimeout(maxTimer);
      return res.end();
    }
    const ejercicio = await rx.ejercicioRepo.findById(exerciseId);
    dlog(reqId, "🗄️ ejercicio", { found: !!ejercicio, ms: nowMs() - tDb0 });
    if (!ejercicio) {
      sseSend(res, { error: "Ejercicio no encontrado." });
      clearTimeout(maxTimer);
      return res.end();
    }

    // Interacción: cargar o crear
    let iid = interaccionId || null;
    if (iid) {
      const exists = await rx.interaccionRepo.existsForUser(iid, userId);
      if (!exists) iid = null;
    }
    if (!iid) {
      const created = await rx.interaccionRepo.create({
        userId: userId,
        exerciseId: exerciseId,
      });
      iid = created.id;
      sseSend(res, { interaccionId: iid });
      dlog(reqId, "🆕 interaccion creada", iid);
    }

    // Guardar mensaje user (atómico)
    const text = userMessage.trim();
    await rx.messageRepo.appendMessage(iid, new Message({
      interactionId: iid, role: "user", content: text,
    }));
    await rx.interaccionRepo.updateEndTime(iid, new Date());

    // ============================
    // ✅ CIERRE DETERMINISTA (SIN LLM)
    // ============================
    const correctNow = isCorrectAnswerForExercise({ userText: text, ejercicio });

    // Resolve active language from conversation history
    const history = await loadLastMessages(iid);
    const lang = resolveLanguage(history);

    if (correctNow) {
      const assistant = `${getFinishMessages(lang).exactAnswer}${FIN_TOKEN}`;
      trace.traceDeterministicFinish(traceId, {
        classification: "exact_match",
        prevCorrectTurns: -1,
        source: "ollamaChatRoutes (NO RAG, simple match)",
        responseLen: assistant.length,
      });
      sseSend(res, { chunk: assistant });

      clearTimeout(maxTimer);
      await finalizeOnce({
        interaccionId: iid,
        fullAssistant: assistant,
        reason: "deterministic_finish",
        metadata: {
          classification: "exact_match",
          decision: "deterministic_finish",
          isCorrectAnswer: true,
          timing: { totalMs: nowMs() - t0 },
        },
      });
      trace.traceRequestEnd(traceId, { outcome: "deterministic_finish_no_rag", totalMs: nowMs() - t0, responseLen: assistant.length });
      return;
    }

    // Construir messages: system + últimos N
    const systemPrompt = buildSystemPrompt(ejercicio, lang);
    const messages = [{ role: "system", content: systemPrompt }, ...history];

    dlog(reqId, "🧱 messages", {
      total: messages.length,
      systemLen: systemPrompt.length,
      lastUserLen: text.length,
    });

    dumpToFile(reqId, "system_prompt", systemPrompt);
    dumpToFile(reqId, "messages_json", JSON.stringify(messages, null, 2));

    // Llamada a Ollama stream (NDJSON)
    const ollamaStartMs = nowMs();
    const ollamaResp = await axios.post(
      `${baseUrl}/api/chat`,
      {
        model: OLLAMA_MODEL,
        stream: true,
        keep_alive: OLLAMA_KEEP_ALIVE,
        messages,
        options: {
          num_predict: OLLAMA_NUM_PREDICT,
          num_ctx: OLLAMA_NUM_CTX,
          temperature: OLLAMA_TEMPERATURE,
        },
      },
      {
        responseType: "stream",
        timeout: 0,
        signal: controller.signal,
        ...axiosConfigForBaseUrl(baseUrl),
      }
    );

    let fullAssistant = "";
    let buffer = "";
    let firstChunk = true;
    let doneSeen = false;

    let streamTraced = false;
    const endStream = async (reason) => {
      clearTimeout(maxTimer);
      if (aborted) return;
      if (!streamTraced) {
        streamTraced = true;
        trace.traceRequestEnd(traceId, { outcome: "stream_" + reason, totalMs: nowMs() - t0, responseLen: fullAssistant.length });
      }
      await finalizeOnce({
        interaccionId: iid,
        fullAssistant,
        reason,
        metadata: {
          decision: "no_rag_stream",
          timing: {
            ollamaMs: nowMs() - ollamaStartMs,
            totalMs: nowMs() - t0,
          },
        },
      });
    };

    ollamaResp.data.on("data", (chunk) => {
      if (aborted) return;

      if (firstChunk) {
        firstChunk = false;
        dlog(reqId, "🟢 primer chunk", { msFromStart: nowMs() - t0 });
      }

      buffer += chunk.toString("utf-8");

      // Ollama suele mandar NDJSON con \n. A veces viene \r\n.
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        try {
          const json = JSON.parse(trimmed);

          if (json?.done) {
            doneSeen = true;
            endStream("done");
            continue;
          }

          const piece = json?.message?.content;
          if (typeof piece === "string" && piece.length > 0) {
            fullAssistant += piece;
            sseSend(res, { chunk: piece });
          }
        } catch (parseErr) {
          console.error("[Ollama] Malformed chunk:", trimmed);
        }
      }
    });

    ollamaResp.data.on("end", () => {
      endStream(doneSeen ? "end_after_done" : "end_without_done");
    });

    ollamaResp.data.on("error", (err) => {
      clearTimeout(maxTimer);
      console.error("Stream error Ollama:", err?.message || err);
      if (!aborted) sseSend(res, { error: "Error en stream de Ollama." });
      endStream("ollama_stream_error");
    });
  } catch (error) {
    clearTimeout(maxTimer);
    clearInterval(hb);

    dlog(reqId, "❌ error", {
      message: error?.message,
      code: error?.code,
      status: error?.response?.status || null,
      name: error?.name,
      mode,
      baseUrl,
    });

    if (error?.name === "AbortError") {
      sseSend(res, { error: "Stream abortado por timeout máximo configurado." });
      return res.end();
    }

    sseSend(res, { error: error?.message || "Error interno en stream." });
    return res.end();
  }
});

// =======================================
// start-exercise (NO stream) — compatibilidad
// =======================================
router.post("/chat/start-exercise", async (req, res) => {
  const { mode, baseUrl } = getOllamaBaseUrl(req);

  try {
    const userId = req.userId; // From session via globalAuth (NEVER from client)
    const { exerciseId, userMessage } = req.body || {};

    if (!isValidObjectId(exerciseId)) {
      return res.status(400).json({ message: "ID de ejercicio inválido." });
    }

    const firstMsg =
      typeof userMessage === "string" && userMessage.trim() !== ""
        ? userMessage.trim()
        : DEFAULT_START_MESSAGE;

    const rx = repos();
    if (!rx) return res.status(503).json({ message: "service_unavailable" });
    const ejercicio = await rx.ejercicioRepo.findById(exerciseId);
    if (!ejercicio) return res.status(404).json({ message: "Ejercicio no encontrado." });

    // First message: no history yet, default to Spanish
    const systemPrompt = buildSystemPrompt(ejercicio, "es");

    const interaccion = await rx.interaccionRepo.create({
      userId: userId,
      exerciseId: exerciseId,
    });
    await rx.messageRepo.appendMessage(interaccion.id, new Message({
      interactionId: interaccion.id, role: "user", content: firstMsg,
    }));

    // ✅ Si el primer mensaje ya es respuesta correcta, cerramos determinista también aquí
    if (isCorrectAnswerForExercise({ userText: firstMsg, ejercicio })) {
      const assistant = `${getFinishMessages("es").exactAnswer}${FIN_TOKEN}`;

      await rx.messageRepo.appendMessage(interaccion.id, new Message({
        interactionId: interaccion.id, role: "assistant", content: assistant,
      }));
      await rx.interaccionRepo.updateEndTime(interaccion.id, new Date());

      return res.status(201).json({
        message: "Interacción iniciada (resuelta al instante)",
        mode,
        interaccionId: interaccion.id,
        assistantMessage: assistant,
        fullHistory: [
          { role: "user", content: firstMsg },
          { role: "assistant", content: assistant },
        ],
      });
    }

    const ollamaResp = await axios.post(
      `${baseUrl}/api/chat`,
      {
        model: OLLAMA_MODEL,
        stream: false,
        keep_alive: OLLAMA_KEEP_ALIVE,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: firstMsg },
        ],
        options: {
          num_predict: OLLAMA_NUM_PREDICT,
          num_ctx: OLLAMA_NUM_CTX,
          temperature: OLLAMA_TEMPERATURE,
        },
      },
      { timeout: OLLAMA_TIMEOUT_MS, ...axiosConfigForBaseUrl(baseUrl) }
    );

    let assistant = ollamaResp?.data?.message?.content ?? "";

    await rx.messageRepo.appendMessage(interaccion.id, new Message({
      interactionId: interaccion.id, role: "assistant", content: assistant,
    }));
    await rx.interaccionRepo.updateEndTime(interaccion.id, new Date());

    return res.status(201).json({
      message: "Interacción iniciada",
      mode,
      interaccionId: interaccion.id,
      assistantMessage: assistant,
      fullHistory: [
        { role: "user", content: firstMsg },
        { role: "assistant", content: assistant },
      ],
    });
  } catch (error) {
    console.error("Error start-exercise:", error?.message || error);
    if (error.code === "ECONNABORTED") {
      return res.status(504).json({
        message: "Timeout esperando respuesta de Ollama.",
        error: error.message,
        mode,
      });
    }
    return res.status(500).json({
      message: "Error interno del servidor al iniciar interacción.",
      error: error?.message || "unknown",
      mode,
    });
  }
});

module.exports = router;
