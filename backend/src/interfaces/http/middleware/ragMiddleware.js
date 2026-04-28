// Express middleware that intercepts POST /chat/stream to add RAG augmentation
// If RAG handles the request, it responds directly. If not, it calls next() and the original handler takes over.

const express = require("express");
const axios = require("axios");
const https = require("https");
// ID validation: accepts MongoDB ObjectId (24 hex chars) or UUID (36 chars with dashes).
// Post-migration, IDs stored in Postgres preserve the original ObjectId format for
// historical data and use UUIDs for new records.
function isValidId(v) {
  if (typeof v !== "string") return false;
  return /^[a-f0-9]{24}$/i.test(v) || /^[0-9a-f-]{36}$/i.test(v);
}
const fs = require("fs");
const path = require("path");
const config = require("../../../infrastructure/llm/config");
const { runFullPipeline } = require("../../../domain/services/rag/ragPipeline");
const { checkSolutionLeak, getStrongerInstruction, checkFalseConfirmation, getFalseConfirmationInstruction, checkPrematureConfirmation, getPartialConfirmationInstruction, checkStateReveal, getStateRevealInstruction, checkElementNaming, removeOpeningConfirmation, redactElementMentions, redactStateRevealSentence, loadConceptPatternsFromKG, enforceDatasetStyle, checkDidacticExplanation, getScaffoldInstruction } = require("../../../domain/services/rag/guardrails");
const { loadKG, getAllEntries } = require("../../../infrastructure/search/knowledgeGraph");
const { loadIndex } = require("../../../infrastructure/search/bm25");
const { logInteraction } = require("../../../infrastructure/llm/logger");
const { setRequestId, emitEvent } = require("../../../infrastructure/events/ragEventBus");
const { buildTutorSystemPrompt } = require("../../../domain/services/promptBuilder");
const { resolveLanguage, getFinishMessages, getElementNamingInstruction, getRandomIntermediatePhrase, getAllPatterns, frustrationPatterns: frustrationDict } = require("../../../domain/services/languageManager");
const container = require("../../../container");
const Message = require("../../../domain/entities/Message");
const HeuristicSecurityAdapter = require("../../../infrastructure/security/HeuristicSecurityAdapter");
const trace = require("../../../infrastructure/events/pipelineDebugLogger");

// Repos del container (para el path legacy; si container no está listo, fallthrough)
function repos() {
  if (!container._initialized) return null;
  return {
    ejercicioRepo: container.ejercicioRepo,
    interaccionRepo: container.interaccionRepo,
    messageRepo: container.messageRepo,
  };
}

const securityService = new HeuristicSecurityAdapter({
  logger: function (event, payload) {
    emitEvent(event, "end", payload);
  },
});

let requestCounter = 0;

const router = express.Router();
const httpsAgent = new https.Agent({ rejectUnauthorized: false });
const FIN_TOKEN = "<FIN_EJERCICIO>";

// Canonical exercise number mapping (exercise 2 → 1 because they share the same dataset in ChromaDB)
const canonicalExercise = {};

// RAG initialization: load KG + BM25 at the start
let ragReady = false;
let kgConceptPatterns = [];

function initRAG() {
  try {
    // Load knowledge graph into memory
    loadKG();
    try {
      kgConceptPatterns = loadConceptPatternsFromKG(getAllEntries());
      console.log("[RAG] Loaded " + kgConceptPatterns.length + " KG concept patterns for state-reveal guardrail");
    } catch (kgErr) {
      console.warn("[RAG] Could not derive concept patterns from KG:", kgErr.message);
    }

    // Build canonical mapping and load BM25 for all exercises
    const fileToFirst = {};
    const exerciseNums = Object.keys(config.EXERCISE_DATASET_MAP);

    for (let i = 0; i < exerciseNums.length; i++) {
      const num = Number(exerciseNums[i]);
      const fileName = config.EXERCISE_DATASET_MAP[num];

      // Track first exercise number for each dataset file (for ChromaDB collection lookup)
      if (fileToFirst[fileName] == null) {
        fileToFirst[fileName] = num;
      }
      canonicalExercise[num] = fileToFirst[fileName];

      // Load BM25 index for this exercise
      const filePath = path.join(config.DATASETS_DIR, fileName);
      const raw = fs.readFileSync(filePath, "utf-8");
      const pairs = JSON.parse(raw);
      loadIndex(num, pairs);
    }

    ragReady = true;
    console.log("[RAG] Ready");
  } catch (err) {
    console.error("[RAG] Init failed:", err.message);
  }
}

initRAG();

// Extract exercise number from title ("Ejercicio 1" → 1)
function getExerciseNum(ejercicio) {
  const match = (ejercicio.titulo || "").match(/(\d+)/);
  if (match != null) {
    return Number(match[1]);
  }
  return null;
}

// Get correct answer as normalized array ["R1", "R2", "R4"]
function getCorrectAnswer(ejercicio) {
  const answer = ejercicio.tutorContext && ejercicio.tutorContext.respuestaCorrecta;
  if (!Array.isArray(answer)) {
    return [];
  }
  const result = [];
  for (let i = 0; i < answer.length; i++) {
    result.push(String(answer[i]).toUpperCase().trim());
  }
  return result;
}

// Get all evaluable elements for generic extraction (correct + incorrect)
// 1. Explicit field in tutorContext (for non-electronics subjects)
// 2. Extract from netlist (backwards compatibility for circuits)
// 3. Fallback: only the correct answer
function getEvaluableElements(ejercicio) {
  var tc = ejercicio.tutorContext || {};

  // 1. Explicit field
  if (Array.isArray(tc.elementosEvaluables) && tc.elementosEvaluables.length > 0) {
    return tc.elementosEvaluables.map(function (e) { return String(e).toUpperCase().trim(); });
  }

  // 2. Extract from netlist (only passive/active components that can be answers: R, C, L, D, I)
  //    Excludes node identifiers (N*) and voltage sources (V*) which are structural,
  //    not answer elements. Students mentioning nodes in reasoning (e.g. "from N1 to N2")
  //    should NOT be treated as proposing wrong answer elements.
  if (tc.netlist) {
    var matches = tc.netlist.match(/[RCLDI]\d+/gi);
    if (matches) {
      var seen = {};
      var unique = [];
      for (var i = 0; i < matches.length; i++) {
        var m = matches[i].toUpperCase();
        if (!seen[m]) {
          seen[m] = true;
          unique.push(m);
        }
      }
      return unique;
    }
  }

  // 3. Fallback: only the correct answer
  return (tc.respuestaCorrecta || []).map(function (e) { return String(e).toUpperCase().trim(); });
}

// Send SSE event to client (same format as the existing handler)
function sseSend(res, payload) {
  res.write("data: " + JSON.stringify(payload) + "\n\n");
  if (typeof res.flush === "function") res.flush();
}

// Axios config for HTTPS connections
function axiosOpts() {
  if (config.OLLAMA_CHAT_URL.startsWith("https://")) {
    return { httpsAgent: httpsAgent };
  }
  return {};
}

// Build system prompt with fallback (same as existing handler)
function buildSystemPrompt(ejercicio, lang) {
  var systemPrompt = buildTutorSystemPrompt(ejercicio, lang);
  if (typeof systemPrompt !== "string" || systemPrompt.trim() === "") {
    systemPrompt = "Eres un tutor socrático. Responde en español. No des la solución: guía con preguntas concretas.";
  }
  return systemPrompt;
}

// Call Ollama and get the full response (non-streaming, so we can check guardrails before sending to client)
async function callOllama(messages) {
  const response = await axios.post(
    config.OLLAMA_CHAT_URL + "/api/chat",
    {
      model: config.OLLAMA_MODEL,
      stream: false,
      keep_alive: config.OLLAMA_KEEP_ALIVE,
      messages: messages,
      options: {
        num_predict: config.OLLAMA_NUM_PREDICT,
        num_ctx: config.OLLAMA_NUM_CTX,
        temperature: config.OLLAMA_TEMPERATURE,
      },
    },
    { timeout: 180000, ...axiosOpts() }
  );
  return (response.data.message && response.data.message.content) || "";
}

// Count previous turns classified as "correct-ish" (for loop detection).
async function countPreviousCorrectTurns(interaccionId) {
  const r = repos(); if (!r) return 0;
  const all = await r.messageRepo.getAllMessages(interaccionId);
  const correctTypes = ["correct_no_reasoning", "correct_wrong_reasoning", "correct_good_reasoning", "partial_correct"];
  let count = 0;
  for (const m of all) {
    const c = m.metadata?.classification || m.classification;
    if (m.role === "assistant" && c && correctTypes.includes(c)) count++;
  }
  return count;
}

async function countTotalAssistantTurns(interaccionId) {
  const r = repos(); if (!r) return 0;
  return r.messageRepo.countAssistantMessages(interaccionId);
}

async function countConsecutiveWrongTurns(interaccionId) {
  const r = repos(); if (!r) return 0;
  return r.messageRepo.countConsecutiveFromEnd(
    interaccionId,
    ["wrong_answer", "wrong_concept", "single_word"]
  );
}

async function loadHistory(interaccionId) {
  const r = repos(); if (!r) return [];
  const msgs = await r.messageRepo.getLastMessages(interaccionId, config.HISTORY_MAX_MESSAGES);
  return msgs.map((m) => ({ role: m.role, content: m.content }));
}

// Build a short hint reminding the LLM what its last question was,
// so it can evaluate the student's response in context and avoid re-asking.
function buildConversationProgressHint(history) {
  if (!Array.isArray(history) || history.length < 2) return "";

  var lastAssistant = null;
  for (var i = history.length - 1; i >= 0; i--) {
    if (history[i].role === "assistant") {
      lastAssistant = history[i].content;
      break;
    }
  }
  if (!lastAssistant) return "";

  var questions = lastAssistant.match(/[^.!?]*\?/g);
  var lastQuestion = questions && questions.length > 0
    ? questions[questions.length - 1].trim()
    : null;
  if (!lastQuestion) return "";

  return "[CONVERSATION CONTEXT]\n"
    + "Your last question to the student was: \"" + lastQuestion + "\"\n"
    + "Evaluate the student's current response as an answer to THIS question.\n"
    + "If they answered it correctly, acknowledge and advance. Do NOT re-ask.\n\n";
}

// Detect if the tutor has been asking the same question repeatedly.
// Uses a sliding window: compares ALL pairs among the last 4 assistant questions.
// This catches alternating patterns (A-B-A-B) that a 2-message comparison would miss.
async function detectTutorRepetition(interaccionId) {
  const r = repos(); if (!r) return { repeating: false };
  const lastAssistant = await r.messageRepo.getLastAssistantMessages(interaccionId, 4);
  if (lastAssistant.length < 2) return { repeating: false };
  const assistantMessages = lastAssistant.map((m) => m.content || "");

  // Extract the last question from each assistant message
  function extractLastQuestion(text) {
    var qs = text.match(/[^.!?]*\?/g);
    return qs && qs.length > 0 ? qs[qs.length - 1].toLowerCase().trim() : "";
  }

  // Compute word overlap between two questions (words > 3 chars)
  function questionSimilarity(qa, qb) {
    var wordsA = qa.split(/\s+/).filter(function(w) { return w.length > 3; });
    var wordsB = qb.split(/\s+/).filter(function(w) { return w.length > 3; });
    if (wordsA.length === 0) return 0;
    var overlap = 0;
    for (var w = 0; w < wordsA.length; w++) {
      if (wordsB.indexOf(wordsA[w]) >= 0) overlap++;
    }
    return overlap / wordsA.length;
  }

  // Extract questions from all collected messages
  var questions = [];
  for (var m = 0; m < assistantMessages.length; m++) {
    var q = extractLastQuestion(assistantMessages[m]);
    if (q) questions.push(q);
  }
  if (questions.length < 2) return { repeating: false };

  // Compare all pairs: if ANY pair has > 50% overlap, repetition detected
  for (var a = 0; a < questions.length; a++) {
    for (var b = a + 1; b < questions.length; b++) {
      var sim = questionSimilarity(questions[a], questions[b]);
      if (sim > 0.5) {
        return { repeating: true, lastQuestion: questions[0] };
      }
    }
  }
  return { repeating: false };
}

// Detect if the student is expressing frustration (repeating themselves, "I already told you", etc.)
var frustrationPatternsAll = getAllPatterns(frustrationDict);
function detectFrustration(message) {
  var lower = message.toLowerCase();
  for (var i = 0; i < frustrationPatternsAll.length; i++) {
    if (lower.includes(frustrationPatternsAll[i])) {
      return true;
    }
  }
  return false;
}

// End SSE connection cleanly
function endSSE(res, hb) {
  clearInterval(hb);
  res.write("data: [DONE]\n\n");
  if (typeof res.flush === "function") res.flush();
  res.end();
}

// Helper: ALWAYS-ON log for when RAG middleware falls through. This is critical for debugging
// and should never be gated behind DEBUG_PIPELINE.
function logFallthrough(reason, details) {
  console.log("[RAG_SKIP] ⛔ reason=" + reason + (details ? " " + JSON.stringify(details) : ""));
}

// Middleware: intercepts POST /chat/stream
router.post("/chat/stream", async function (req, res, next) {
  // Skip if RAG is disabled or not initialized
  if (!config.RAG_ENABLED || !ragReady) {
    logFallthrough("rag_disabled_or_not_ready", { RAG_ENABLED: config.RAG_ENABLED, ragReady: ragReady });
    trace.traceRagGate("", "rag_disabled_or_not_ready", { RAG_ENABLED: config.RAG_ENABLED, ragReady: ragReady });
    return next();
  }

  const startTime = Date.now();
  requestCounter++;
  setRequestId("req_" + requestCounter + "_" + Date.now());

  var reqId = trace.traceRequestStart("ragMiddleware", {
    userId: req.userId,
    exerciseId: (req.body || {}).exerciseId,
    interaccionId: (req.body || {}).interaccionId,
    userMessage: (req.body || {}).userMessage,
  });

  try {
    // 1. Extract and validate inputs
    var userId = req.userId; // From session via globalAuth (NEVER from client)
    var exerciseId = req.body.exerciseId;
    var userMessage = req.body.userMessage;
    var interaccionId = req.body.interaccionId;

    if (!userId || !isValidId(userId)) {
      logFallthrough("invalid_userId", { userId: userId });
      trace.traceRagGate(reqId, "invalid_userId", { userId: userId });
      return next();
    }
    if (!exerciseId || !isValidId(exerciseId)) {
      logFallthrough("invalid_exerciseId", { exerciseId: exerciseId });
      trace.traceRagGate(reqId, "invalid_exerciseId", { exerciseId: exerciseId });
      return next();
    }
    if (typeof userMessage !== "string" || userMessage.trim() === "") {
      logFallthrough("empty_userMessage");
      trace.traceRagGate(reqId, "empty_userMessage");
      return next();
    }

    emitEvent("request_start", "start", { userId: userId, exerciseId: exerciseId, userMessage: userMessage, interaccionId: interaccionId });

    // 2. Load exercise from MongoDB
    var _r = repos();
    if (!_r) return next();
    var ejercicio = await _r.ejercicioRepo.findById(exerciseId);
    if (ejercicio == null) {
      logFallthrough("exercise_not_found", { exerciseId: exerciseId });
      trace.traceRagGate(reqId, "exercise_not_found", { exerciseId: exerciseId });
      return next();
    }

    var exerciseNum = getExerciseNum(ejercicio);
    if (exerciseNum == null) {
      logFallthrough("no_exercise_number_in_title", { titulo: ejercicio.titulo });
      trace.traceRagGate(reqId, "no_exercise_number_in_title", { titulo: ejercicio.titulo });
      return next();
    }

    var correctAnswer = getCorrectAnswer(ejercicio);
    if (correctAnswer.length === 0) {
      logFallthrough("no_correct_answer", { exerciseNum: exerciseNum, hasTutorContext: !!ejercicio.tutorContext, respuestaCorrecta: ejercicio.tutorContext && ejercicio.tutorContext.respuestaCorrecta });
      trace.traceRagGate(reqId, "no_correct_answer", { exerciseNum: exerciseNum, tutorContext: !!ejercicio.tutorContext });
      return next();
    }

    emitEvent("exercise_loaded", "end", { exerciseNum: exerciseNum, titulo: ejercicio.titulo, correctAnswer: correctAnswer, canonicalExercise: canonicalExercise[exerciseNum] || exerciseNum, datasetFile: config.EXERCISE_DATASET_MAP[exerciseNum] || "unknown" });

    // Use canonical exercise number for retrieval (exercise 2 → 1 in ChromaDB)
    var searchNum = canonicalExercise[exerciseNum] || exerciseNum;

    // Get all evaluable elements for generic extraction (correct + incorrect)
    var evaluableElements = getEvaluableElements(ejercicio);

    // Resolve language early (needed for intermediate feedback phrases in pipeline)
    var earlyLang = "es";
    if (interaccionId && isValidId(interaccionId)) {
      var earlyHistory = await loadHistory(interaccionId);
      earlyLang = resolveLanguage(earlyHistory);
    }

    trace.traceRagAccepted(reqId, {
      exerciseNum: exerciseNum,
      correctAnswer: correctAnswer,
      evaluableElements: evaluableElements,
      lang: earlyLang,
    });
    // Phase-0 baseline: declare a theoretical budget (not enforced yet; Phase 3 will enforce).
    // Captures what the refactored pipeline will target — lets us measure overshoot today.
    trace.traceBudgetSet(reqId, 45000);

    // 2b. Input guardrail: block prompt injection / off-topic BEFORE the LLM
    var securityResult = securityService.analyzeInput(userMessage.trim(), {
      lang: earlyLang,
      ejercicio: ejercicio,
      evaluableElements: evaluableElements,
    });
    trace.traceSecurity(reqId, securityResult);
    if (!securityResult.safe) {
      emitEvent("security_block", "end", {
        category: securityResult.category,
        matchedPattern: securityResult.matchedPattern,
        userMessage: userMessage.trim(),
      });

      // Open SSE and answer with the redirect, persisting both user + assistant msgs
      res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
      res.setHeader("Cache-Control", "no-cache, no-transform");
      res.setHeader("Connection", "keep-alive");
      res.setHeader("X-Accel-Buffering", "no");
      if (typeof res.flushHeaders === "function") res.flushHeaders();
      res.write(": ok\n\n");

      var hbBlock = setInterval(function () {
        res.write(": ping\n\n");
        if (typeof res.flush === "function") res.flush();
      }, 15000);

      try {
        var iidBlock = interaccionId || null;
        if (iidBlock) {
          var existsB = await _r.interaccionRepo.existsForUser(iidBlock, userId);
          if (!existsB) iidBlock = null;
        }
        if (iidBlock == null) {
          var createdB = await _r.interaccionRepo.create({
            usuarioId: userId,
            ejercicioId: exerciseId,
          });
          iidBlock = createdB.id;
          sseSend(res, { interaccionId: iidBlock });
        }

        await _r.messageRepo.appendMessage(iidBlock, new Message({
          interaccionId: iidBlock, role: "user", content: userMessage.trim(),
        }));
        await _r.messageRepo.appendMessage(iidBlock, new Message({
          interaccionId: iidBlock, role: "assistant", content: securityResult.redirectMessage,
          metadata: {
            blockedByInputGuardrail: true,
            category: securityResult.category,
            matchedPattern: securityResult.matchedPattern,
          },
        }));
        await _r.interaccionRepo.updateFin(iidBlock, new Date());

        sseSend(res, { chunk: securityResult.redirectMessage });
        endSSE(res, hbBlock);

        emitEvent("request_end", "end", {
          totalTimeMs: Date.now() - startTime,
          blockedByInputGuardrail: true,
          category: securityResult.category,
        });
      } catch (blockErr) {
        clearInterval(hbBlock);
        console.error("[RAG] Input guardrail error:", blockErr.message);
        sseSend(res, { error: "Error en el sistema RAG." });
        res.write("data: [DONE]\n\n");
        if (typeof res.flush === "function") res.flush();
        res.end();
      }
      return;
    }

    // 3. Run RAG pipeline (with generic evaluable elements and language)
    emitEvent("pipeline_start", "start", { userMessage: userMessage.trim(), exerciseNum: searchNum, correctAnswer: correctAnswer, userId: userId, evaluableElements: evaluableElements });
    var pipelineStart = Date.now();
    var ragResult = await runFullPipeline(userMessage.trim(), searchNum, correctAnswer, userId, evaluableElements, earlyLang);
    var pipelineTime = Date.now() - pipelineStart;
    emitEvent("pipeline_end", "end", { decision: ragResult.decision, classification: ragResult.classification, augmentationLength: (ragResult.augmentation || "").length, sourcesCount: (ragResult.sources || []).length, pipelineTimeMs: pipelineTime });

    trace.traceClassify(reqId, {
      type: ragResult.classification,
      decision: ragResult.decision,
      proposed: ragResult.proposed,
      negated: ragResult.negated,
      concepts: ragResult.mentionedElements,
      hasReasoning: ragResult.classification === "correct_good_reasoning" || ragResult.classification === "correct_wrong_reasoning",
    });

    // If no RAG needed (greeting, etc.), fall through to original handler
    if (ragResult.decision === "no_rag") {
      logFallthrough("no_rag_decision", { classification: ragResult.classification, pipelineMs: pipelineTime });
      trace.traceRagGate(reqId, "no_rag_decision", { classification: ragResult.classification, pipelineMs: pipelineTime });
      emitEvent("no_rag", "end", { reason: "greeting or non-RAG classification" });
      emitEvent("request_end", "end", { totalTimeMs: Date.now() - startTime });
      return next();
    }

    // --- From here, RAG handles the full request ---

    // 4. Set up SSE (same headers as existing handler)
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    if (typeof res.flushHeaders === "function") res.flushHeaders();
    res.write(": ok\n\n");
    if (typeof res.flush === "function") res.flush();

    // Heartbeat every 15 seconds
    var hb = setInterval(function () {
      res.write(": ping\n\n");
      if (typeof res.flush === "function") res.flush();
    }, 15000);

    try {
      // 5. Load or create Interaccion
      var iid = interaccionId || null;
      if (iid) {
        var exists = await _r.interaccionRepo.existsForUser(iid, userId);
        if (!exists) iid = null;
      }
      if (iid == null) {
        var created = await _r.interaccionRepo.create({
          usuarioId: userId, ejercicioId: exerciseId,
        });
        iid = created.id;
        sseSend(res, { interaccionId: iid });
      }

      // 6. Save user message (with student response time if there is a previous assistant message)
      var text = userMessage.trim();
      var studentResponseMs = null;
      var lastMsg = await _r.messageRepo.getLastMessage(iid);
      if (lastMsg && lastMsg.role === "assistant" && lastMsg.timestamp) {
        studentResponseMs = Date.now() - new Date(lastMsg.timestamp).getTime();
      }
      await _r.messageRepo.appendMessage(iid, new Message({
        interaccionId: iid, role: "user", content: text,
        metadata: studentResponseMs != null ? { studentResponseMs } : null,
      }));
      await _r.interaccionRepo.updateFin(iid, new Date());

      // 7. Deterministic finish: correct answer → check if we can finish directly
      var isCorrect = ragResult.classification === "correct_good_reasoning"
        || ragResult.classification === "correct_no_reasoning"
        || ragResult.classification === "correct_wrong_reasoning";

      // 7a. Pedagogical rule: we NEVER close an exercise without real justification.
      // If the student keeps giving the right elements but no reasoning, we do NOT
      // override the classification. Instead, we raise a flag that will inject a
      // strong instruction into the tutor prompt (see section 8 below) demanding
      // that the student explicitly justify WHY, using concepts from the KG
      // (cortocircuito, circuito abierto, divisor de tension, etc.).
      var repetitionInfo = await detectTutorRepetition(iid);
      var demandJustification = false;
      var prevCorrectCount = 0;
      if (isCorrect && ragResult.classification !== "correct_good_reasoning") {
        prevCorrectCount = await countPreviousCorrectTurns(iid);
        if (prevCorrectCount >= 1) {
          demandJustification = true;
          console.log("[RAG] Student has given correct answer " + prevCorrectCount + " times without reasoning; demanding justification");
        }
      }

      // 7b. Global loop-breaking: independent of classification
      // Counts consecutive wrong turns and total turns to prevent infinite loops
      var wrongStreak = await countConsecutiveWrongTurns(iid);
      var totalTurns = await countTotalAssistantTurns(iid);
      var stuckHint = "";

      trace.traceLoopState(reqId, {
        prevCorrectTurns: prevCorrectCount,
        wrongStreak: wrongStreak,
        totalTurns: totalTurns,
        repetition: repetitionInfo.repeating,
        frustration: detectFrustration(text),
        demandJustification: demandJustification,
        stuckHint: wrongStreak >= config.MAX_WRONG_STREAK || totalTurns >= config.MAX_TOTAL_TURNS,
      });

      if (wrongStreak >= config.MAX_WRONG_STREAK || totalTurns >= config.MAX_TOTAL_TURNS) {
        console.log("[RAG] Global loop-break: wrongStreak=" + wrongStreak + " totalTurns=" + totalTurns);
        stuckHint = "[STUDENT IS STUCK]\n"
          + "CRITICAL: The student has been struggling for many turns (" + totalTurns + " total, " + wrongStreak + " wrong in a row).\n"
          + "CHANGE YOUR STRATEGY COMPLETELY. Do NOT repeat any previous question.\n"
          + "Instead:\n"
          + "1. Briefly summarize what the student has gotten right so far.\n"
          + "2. Give a CONCRETE HINT: describe a property of the circuit that helps narrow down the answer (e.g., 'In this circuit, there is a component whose two terminals are connected to the same node — what does that imply?').\n"
          + "3. Ask a very specific, NEW question that directly advances toward the answer.\n"
          + "Keep your response short and focused.\n\n";
      }

      if (isCorrect) {
        // Load history to check if the student has already been reasoning
        var prevHistory = await loadHistory(iid);
        var hasConversation = prevHistory.length >= 2; // At least 1 exchange before this
        var lang = resolveLanguage(prevHistory);

        if (ragResult.classification === "correct_good_reasoning") {
          // Student gave correct answer and has been reasoning (or gave reasoning now) → finish
          trace.traceDeterministicFinish(reqId, {
            classification: ragResult.classification,
            prevCorrectTurns: prevCorrectCount || 0,
            source: "ragMiddleware",
            responseLen: (getFinishMessages(lang).identifiedResistances + FIN_TOKEN).length,
          });
          emitEvent("deterministic_finish", "end", { classification: ragResult.classification, historyLength: prevHistory.length, finished: true });
          var finishMsg = getFinishMessages(lang).identifiedResistances + FIN_TOKEN;
          sseSend(res, { chunk: finishMsg });

          await _r.messageRepo.appendMessage(iid, new Message({
            interaccionId: iid, role: "assistant", content: finishMsg,
            metadata: {
              classification: ragResult.classification,
              decision: "deterministic_finish",
              isCorrectAnswer: true,
              timing: { pipelineMs: pipelineTime, totalMs: Date.now() - startTime },
            },
          }));
          await _r.interaccionRepo.updateFin(iid, new Date());

          emitEvent("mongodb_save", "end", { interaccionId: iid, messagesAdded: 2 });
          endSSE(res, hb);

          logInteraction({
            exerciseNum: exerciseNum, userId: userId,
            correctAnswer: correctAnswer,
            classification: ragResult.classification, decision: "deterministic_finish",
            query: text, response: finishMsg,
            timing: { total: Date.now() - startTime },
          });
          emitEvent("log_written", "end", { logPath: "logs/rag/" });
          emitEvent("response_sent", "end", { responseLength: finishMsg.length, containsFIN: true });
          emitEvent("request_end", "end", { totalTimeMs: Date.now() - startTime });
          return;
        }
        // correct_no_reasoning without history → fall through to LLM to ask for reasoning
        // correct_wrong_reasoning → fall through to LLM to correct the concept
        emitEvent("deterministic_finish", "skip", { classification: ragResult.classification, historyLength: prevHistory.length, finished: false });
      }

      // 8. Build augmented system prompt (base prompt + RAG context)
      var history = await loadHistory(iid);
      var lang = resolveLanguage(history);
      var basePrompt = buildSystemPrompt(ejercicio, lang);
      var progressHint = buildConversationProgressHint(history);
      // If tutor repetition detected, inject a strong instruction to move forward
      var repetitionHint = "";
      if (repetitionInfo.repeating) {
        console.log("[RAG] Tutor repetition detected, injecting move-forward instruction");
        repetitionHint = "[ANTI-LOOP]\n"
          + "CRITICAL: You have been asking similar questions repeatedly and the student is stuck.\n"
          + "DO NOT ask any question you have asked before. Instead:\n"
          + "1. Briefly acknowledge what the student has said correctly so far.\n"
          + "2. Give a CONCRETE HINT about the circuit (without revealing the answer).\n"
          + "3. Ask a NEW, DIFFERENT question that the student has NOT been asked before.\n\n";
      }
      // If the student is frustrated, inject an empathetic instruction
      var frustrationHint = "";
      if (detectFrustration(text)) {
        console.log("[RAG] Student frustration detected");
        frustrationHint = "[STUDENT FRUSTRATED]\n"
          + "The student is expressing frustration because they feel they already answered your question.\n"
          + "DO NOT repeat any previous question. Instead:\n"
          + "1. Acknowledge their effort and validate what they said correctly.\n"
          + "2. If they have already provided correct reasoning, ACCEPT IT and move forward.\n"
          + "3. If something is still missing, give a more concrete hint before asking.\n"
          + "Be empathetic and brief.\n\n";
      }
      // Scaffold hint: when the student says "I don't know" / "no lo sé",
      // the tutor MUST NOT explain the concept. It must lower the scaffold
      // and ask a SIMPLER, more CONCRETE question about a visible feature of
      // the circuit so the student can reason themselves.
      var scaffoldHint = "";
      if (ragResult.classification === "dont_know") {
        scaffoldHint = "[STUDENT DOESN'T KNOW]\n"
          + "CRITICAL: The student just said they don't know. You MUST:\n"
          + "- NOT explain concepts. NOT give definitions. NOT say 'this means that...' or 'when a resistor is X, then Y'.\n"
          + "- NOT reveal internal states (short-circuited, open, same potential, etc.).\n"
          + "- Lower the scaffolding: ask ONE simpler, more concrete question about a VISIBLE feature of the circuit (e.g. 'Look at where the two terminals of one of the elements are connected. Do you notice anything?').\n"
          + "- Keep the response to a SINGLE question, no preamble, no explanation.\n\n";
      }

      // Demand justification hint: when the student has given correct elements
      // multiple times but never justified, force the tutor to ask explicitly.
      var justificationHint = "";
      if (demandJustification) {
        justificationHint = "[DEMAND JUSTIFICATION]\n"
          + "CRITICAL: The student has given the CORRECT answer " + prevCorrectCount + " time(s) WITHOUT any justification, or with INCORRECT reasoning.\n"
          + "You MUST NOT accept the answer as final. You MUST NOT emit <FIN_EJERCICIO>.\n"
          + "Your ONLY task this turn is:\n"
          + "1. Briefly acknowledge that they have the right elements.\n"
          + "2. Ask DIRECTLY and CLEARLY: 'Explica por que' / 'Explain why' / 'Explica per que', requiring them to use a concept such as cortocircuito, circuito abierto, divisor de tension, ley de Ohm, Kirchhoff, etc.\n"
          + "3. Do NOT name the correct elements in your question. Use generic wording like 'esos elementos' / 'those elements'.\n"
          + "4. Do NOT provide the reasoning yourself. The student must produce it.\n\n";
      }

      var augmentedPrompt = basePrompt + "\n\n" + progressHint + repetitionHint + frustrationHint + stuckHint + scaffoldHint + justificationHint + ragResult.augmentation;
      emitEvent("prompt_built", "end", { systemPromptLength: basePrompt.length, ragAugmentationLength: ragResult.augmentation.length, totalPromptLength: augmentedPrompt.length, augmentationPreview: ragResult.augmentation });

      // 9. Load conversation history (last N messages)
      emitEvent("history_loaded", "end", { interaccionId: iid, messageCount: history.length, maxMessages: config.HISTORY_MAX_MESSAGES, messages: history.map(function (m) { return { role: m.role, content: m.content || "" }; }) });

      var messages = [{ role: "system", content: augmentedPrompt }];
      for (let i = 0; i < history.length; i++) {
        messages.push(history[i]);
      }

      // 10. Call Ollama (non-streaming so we can check guardrails before sending to client)
      trace.traceLlmCall(reqId, "start", { model: config.OLLAMA_MODEL, messagesCount: messages.length, promptLen: augmentedPrompt.length, reason: "primary" });
      emitEvent("ollama_call_start", "start", { model: config.OLLAMA_MODEL, temperature: config.OLLAMA_TEMPERATURE, num_ctx: config.OLLAMA_NUM_CTX, num_predict: config.OLLAMA_NUM_PREDICT, keep_alive: config.OLLAMA_KEEP_ALIVE, messageCount: messages.length, ollamaUrl: config.OLLAMA_CHAT_URL });
      var ollamaStart = Date.now();
      var fullResponse = await callOllama(messages);
      trace.traceLlmCall(reqId, "end", { durationMs: Date.now() - ollamaStart, responseLen: fullResponse.length, reason: "primary", response: fullResponse });
      emitEvent("ollama_call_end", "end", { responseLength: fullResponse.length, responsePreview: fullResponse, durationMs: Date.now() - ollamaStart, reason: "non-streaming (guardrail check)" });

      // 11. Guardrail checks: solution leak + false confirmation
      var guardrailTriggered = false;

      // 11a. Check if the LLM revealed the solution (iterative: up to 2 retries)
      var _tLeak0 = Date.now();
      var leakCheck = checkSolutionLeak(fullResponse, correctAnswer);
      trace.traceGuardrailCheck(reqId, "solution_leak", { violated: leakCheck.leaked, checkMs: Date.now() - _tLeak0, evidence: leakCheck.details });
      emitEvent("guardrail_leak", "end", { responsePreview: fullResponse, correctAnswer: correctAnswer, result: leakCheck, passed: !leakCheck.leaked, check: "Checks if LLM response reveals the correct answer resistances" });
      for (var leakAttempt = 1; leakAttempt <= 2 && leakCheck.leaked; leakAttempt++) {
        guardrailTriggered = true;
        console.log("[RAG] Guardrail triggered (leak) attempt " + leakAttempt + ": " + leakCheck.details);
        trace.traceLlmRetry(reqId, "solution_leak", leakAttempt);
        emitEvent("ollama_retry", "start", { reason: "solution_leak", retryCount: leakAttempt });

        var strongerPrompt = augmentedPrompt + getStrongerInstruction(lang);
        var retryMessages = [{ role: "system", content: strongerPrompt }];
        for (let i = 0; i < history.length; i++) {
          retryMessages.push(history[i]);
        }
        var _tRetry = Date.now();
        fullResponse = await callOllama(retryMessages);
        trace.traceLlmCall(reqId, "end", { durationMs: Date.now() - _tRetry, responseLen: fullResponse.length, reason: "retry_solution_leak_" + leakAttempt, response: fullResponse });
        emitEvent("ollama_retry", "end", { reason: "solution_leak", responseLength: fullResponse.length });
        leakCheck = checkSolutionLeak(fullResponse, correctAnswer);
      }

      // 11b. Check if the LLM confirmed a wrong answer as correct
      var _tConfirm0 = Date.now();
      var confirmCheck = checkFalseConfirmation(fullResponse, ragResult.classification);
      trace.traceGuardrailCheck(reqId, "false_confirmation", { violated: confirmCheck.confirmed, checkMs: Date.now() - _tConfirm0, evidence: confirmCheck.details });
      emitEvent("guardrail_false_confirm", "end", { responsePreview: fullResponse, classification: ragResult.classification, result: confirmCheck, passed: !confirmCheck.confirmed, check: "Checks if LLM falsely confirms a wrong answer as correct" });
      if (confirmCheck.confirmed) {
        guardrailTriggered = true;
        console.log("[RAG] Guardrail triggered (false confirm): " + confirmCheck.details);
        trace.traceLlmRetry(reqId, "false_confirmation", 1);
        emitEvent("ollama_retry", "start", { reason: "false_confirmation", retryCount: 1 });

        var confirmPrompt = augmentedPrompt + getFalseConfirmationInstruction(lang);
        var confirmRetry = [{ role: "system", content: confirmPrompt }];
        for (let i = 0; i < history.length; i++) {
          confirmRetry.push(history[i]);
        }
        var _tCR = Date.now();
        fullResponse = await callOllama(confirmRetry);
        trace.traceLlmCall(reqId, "end", { durationMs: Date.now() - _tCR, responseLen: fullResponse.length, reason: "retry_false_confirmation", response: fullResponse });
        emitEvent("ollama_retry", "end", { reason: "false_confirmation", responseLength: fullResponse.length });
      }

      // 11b2. Check if the LLM prematurely confirms a partially correct answer
      var _tPrem0 = Date.now();
      var prematureCheck = checkPrematureConfirmation(fullResponse, ragResult.classification);
      trace.traceGuardrailCheck(reqId, "premature_confirmation", { violated: prematureCheck.premature, checkMs: Date.now() - _tPrem0, evidence: prematureCheck.details });
      emitEvent("guardrail_premature_confirm", "end", { responsePreview: fullResponse, classification: ragResult.classification, result: prematureCheck, passed: !prematureCheck.premature, check: "Checks if LLM prematurely confirms correct answer without reasoning" });
      if (prematureCheck.premature) {
        guardrailTriggered = true;
        console.log("[RAG] Guardrail triggered (premature confirm): " + prematureCheck.details);
        trace.traceLlmRetry(reqId, "premature_confirmation", 1);
        emitEvent("ollama_retry", "start", { reason: "premature_confirmation", retryCount: 1 });

        var partialPrompt = augmentedPrompt + getPartialConfirmationInstruction(lang, ragResult.classification);
        var partialRetry = [{ role: "system", content: partialPrompt }];
        for (let i = 0; i < history.length; i++) {
          partialRetry.push(history[i]);
        }
        var _tPR = Date.now();
        fullResponse = await callOllama(partialRetry);
        trace.traceLlmCall(reqId, "end", { durationMs: Date.now() - _tPR, responseLen: fullResponse.length, reason: "retry_premature_confirmation", response: fullResponse });
        emitEvent("ollama_retry", "end", { reason: "premature_confirmation", responseLength: fullResponse.length });
      }

      // 11c. Check if the LLM reveals the state/topology/concept bound to a
      // specific evaluable element. Generic: any element type + any concept
      // name loaded from the knowledge graph. Iterative (up to 2 retries)
      // plus deterministic redaction fallback — the student must discover
      // states themselves, so we prefer a clunky placeholder to a leak.
      var _tState0 = Date.now();
      var stateCheck = checkStateReveal(fullResponse, evaluableElements, kgConceptPatterns);
      trace.traceGuardrailCheck(reqId, "state_reveal", { violated: stateCheck.revealed, checkMs: Date.now() - _tState0, evidence: stateCheck.details });
      emitEvent("guardrail_state_reveal", "end", { responsePreview: fullResponse, result: stateCheck, passed: !stateCheck.revealed, check: "Checks if LLM reveals internal element states or KG concepts bound to a specific element" });
      for (var stateAttempt = 1; stateAttempt <= 2 && stateCheck.revealed; stateAttempt++) {
        guardrailTriggered = true;
        console.log("[RAG] Guardrail triggered (state reveal) attempt " + stateAttempt + ": " + stateCheck.details);
        trace.traceLlmRetry(reqId, "state_reveal", stateAttempt);
        emitEvent("ollama_retry", "start", { reason: "state_reveal", retryCount: stateAttempt });

        var statePrompt = augmentedPrompt + getStateRevealInstruction(lang);
        var stateRetry = [{ role: "system", content: statePrompt }];
        for (let i = 0; i < history.length; i++) {
          stateRetry.push(history[i]);
        }
        var _tSR = Date.now();
        fullResponse = await callOllama(stateRetry);
        trace.traceLlmCall(reqId, "end", { durationMs: Date.now() - _tSR, responseLen: fullResponse.length, reason: "retry_state_reveal_" + stateAttempt, response: fullResponse });
        emitEvent("ollama_retry", "end", { reason: "state_reveal", responseLength: fullResponse.length });
        stateCheck = checkStateReveal(fullResponse, evaluableElements, kgConceptPatterns);
      }

      // 11c-bis. Surgical redaction: if the LLM still reveals state, rewrite
      // the offending sentence only, keeping the rest of the response intact.
      if (stateCheck.revealed) {
        var _tSurg0 = Date.now();
        var stateRedact = redactStateRevealSentence(fullResponse, evaluableElements, stateCheck.pattern, lang);
        trace.traceSurgicalFix(reqId, "state_reveal", { applied: stateRedact.redacted, durationMs: Date.now() - _tSurg0, before: fullResponse, after: stateRedact.text });
        if (stateRedact.redacted) {
          guardrailTriggered = true;
          console.log("[RAG] Deterministic state-reveal redaction applied");
          emitEvent("guardrail_redaction", "end", { reason: "state_reveal_fallback", before: fullResponse, after: stateRedact.text, pattern: stateCheck.pattern });
          fullResponse = stateRedact.text;
        }
      }

      // 11d. Check if the LLM names specific evaluable elements in questions/directives
      // Iterative: up to 2 retries. Final fallback: deterministic redaction.
      var _tNaming0 = Date.now();
      var namingCheck = checkElementNaming(fullResponse, evaluableElements);
      trace.traceGuardrailCheck(reqId, "element_naming", { violated: namingCheck.named, checkMs: Date.now() - _tNaming0, evidence: namingCheck.details });
      emitEvent("guardrail_element_naming", "end", { responsePreview: fullResponse, result: namingCheck, passed: !namingCheck.named, check: "Checks if LLM names specific elements in questions or directives" });
      for (var namingAttempt = 1; namingAttempt <= 2 && namingCheck.named; namingAttempt++) {
        guardrailTriggered = true;
        console.log("[RAG] Guardrail triggered (element naming) attempt " + namingAttempt + ": " + namingCheck.details);
        trace.traceLlmRetry(reqId, "element_naming", namingAttempt);
        emitEvent("ollama_retry", "start", { reason: "element_naming", retryCount: namingAttempt });

        var namingPrompt = augmentedPrompt + getElementNamingInstruction(lang);
        var namingRetry = [{ role: "system", content: namingPrompt }];
        for (var ni = 0; ni < history.length; ni++) {
          namingRetry.push(history[ni]);
        }
        var _tNR = Date.now();
        fullResponse = await callOllama(namingRetry);
        trace.traceLlmCall(reqId, "end", { durationMs: Date.now() - _tNR, responseLen: fullResponse.length, reason: "retry_element_naming_" + namingAttempt, response: fullResponse });
        emitEvent("ollama_retry", "end", { reason: "element_naming", responseLength: fullResponse.length });
        namingCheck = checkElementNaming(fullResponse, evaluableElements);
      }

      // 11d-bis. Deterministic redaction fallback: if after the retries the
      // response STILL names correct elements in questions/directives, rewrite
      // them with a generic placeholder. Prefer clunky-but-safe over leaking.
      if (namingCheck.named) {
        var _tSurgN = Date.now();
        var redactResult = redactElementMentions(fullResponse, correctAnswer, lang);
        trace.traceSurgicalFix(reqId, "element_naming", { applied: redactResult.redacted, durationMs: Date.now() - _tSurgN, before: fullResponse, after: redactResult.text });
        if (redactResult.redacted) {
          guardrailTriggered = true;
          console.log("[RAG] Deterministic redaction applied (element naming could not be fixed by LLM)");
          emitEvent("guardrail_redaction", "end", { reason: "element_naming_fallback", before: fullResponse, after: redactResult.text });
          fullResponse = redactResult.text;
        }
      }

      // 11d-ter. Extra safety: if the response still literally contains ALL
      // correct elements together (e.g. "R1, R2, R4") redact them even when
      // they appear outside a question — this catches leaks in statements.
      var finalLeak = checkSolutionLeak(fullResponse, correctAnswer);
      if (finalLeak.leaked) {
        var _tSurgL = Date.now();
        var redactResult2 = redactElementMentions(fullResponse, correctAnswer, lang);
        trace.traceSurgicalFix(reqId, "final_leak_safeguard", { applied: redactResult2.redacted, durationMs: Date.now() - _tSurgL, before: fullResponse, after: redactResult2.text });
        if (redactResult2.redacted) {
          guardrailTriggered = true;
          console.log("[RAG] Deterministic redaction applied (final leak safeguard)");
          emitEvent("guardrail_redaction", "end", { reason: "final_leak_safeguard", before: fullResponse, after: redactResult2.text });
          fullResponse = redactResult2.text;
        }
      }

      // 11e. Deterministic prefix fallback: if after all retries the response STILL
      // starts with a confirmation phrase for a wrong/partial answer, force a prefix.
      // ONLY apply when the student mentioned specific elements (they're answering the question).
      // When no elements are mentioned, the student is responding to a Socratic question about concepts —
      // the LLM confirming a correct concept is fine and forcing a negative prefix creates contradictions.
      var studentMentionedElements = ragResult.mentionedElements && ragResult.mentionedElements.length > 0;
      if (studentMentionedElements) {
        var finalConfirmCheck = checkFalseConfirmation(fullResponse, ragResult.classification);
        if (finalConfirmCheck.confirmed) {
          var prefix = getRandomIntermediatePhrase("wrong", lang);
          if (prefix) {
            console.log("[RAG] Deterministic prefix forced: " + prefix);
            var cleaned = removeOpeningConfirmation(fullResponse, lang);
            // Double pass: strip confirmations that survived after the first cleanup
            var secondPass = removeOpeningConfirmation(cleaned, lang);
            fullResponse = prefix + " " + secondPass;
            guardrailTriggered = true;
          }
        }
        var finalPrematureCheck = checkPrematureConfirmation(fullResponse, ragResult.classification);
        if (finalPrematureCheck.premature) {
          var partialPrefix = getRandomIntermediatePhrase("partial", lang);
          if (partialPrefix) {
            console.log("[RAG] Deterministic prefix forced (partial): " + partialPrefix);
            var cleaned = removeOpeningConfirmation(fullResponse, lang);
            var secondPass = removeOpeningConfirmation(cleaned, lang);
            fullResponse = partialPrefix + " " + secondPass;
            guardrailTriggered = true;
          }
        }
      }

      // 11d-quater. Didactic explanation check: the tutor must scaffold, not
      // explain. If the response contains definitional/explanatory patterns
      // ("this means that...", "when a resistor is X, then..."), retry up to
      // 2 times asking for a pure scaffolding question instead.
      var _tDidactic0 = Date.now();
      var didacticCheck = checkDidacticExplanation(fullResponse);
      trace.traceGuardrailCheck(reqId, "didactic_explanation", { violated: didacticCheck.explaining, checkMs: Date.now() - _tDidactic0, evidence: didacticCheck.details });
      for (var didacticAttempt = 1; didacticAttempt <= 2 && didacticCheck.explaining; didacticAttempt++) {
        guardrailTriggered = true;
        console.log("[RAG] Guardrail triggered (didactic explanation) attempt " + didacticAttempt + ": " + didacticCheck.details);
        trace.traceLlmRetry(reqId, "didactic_explanation", didacticAttempt);
        emitEvent("ollama_retry", "start", { reason: "didactic_explanation", retryCount: didacticAttempt });

        var scaffoldPrompt = augmentedPrompt + getScaffoldInstruction(lang);
        var scaffoldRetry = [{ role: "system", content: scaffoldPrompt }];
        for (var si = 0; si < history.length; si++) {
          scaffoldRetry.push(history[si]);
        }
        var _tDR = Date.now();
        fullResponse = await callOllama(scaffoldRetry);
        trace.traceLlmCall(reqId, "end", { durationMs: Date.now() - _tDR, responseLen: fullResponse.length, reason: "retry_didactic_" + didacticAttempt, response: fullResponse });
        emitEvent("ollama_retry", "end", { reason: "didactic_explanation", responseLength: fullResponse.length });
        didacticCheck = checkDidacticExplanation(fullResponse);
      }

      // 11e-bis. Enforce dataset style: strip markdown (bullets, bold,
      // numbered lists, headings) so the tutor output matches the concise
      // prose + one final question style of the training dataset.
      var styleResult = enforceDatasetStyle(fullResponse);
      if (styleResult && styleResult.changed) {
        console.log("[RAG] Dataset-style filter removed markdown formatting");
        emitEvent("guardrail_style", "end", { before: fullResponse, after: styleResult.text });
        fullResponse = styleResult.text;
        guardrailTriggered = true;
      }

      // 11f. Pedagogical safeguard: never allow <FIN_EJERCICIO> unless the
      // classification is correct_good_reasoning. Strips the token (and any
      // partial prefix) if the LLM tried to close without real justification.
      if (ragResult.classification !== "correct_good_reasoning" && fullResponse.includes(FIN_TOKEN)) {
        console.log("[RAG] Stripping FIN_EJERCICIO token: classification=" + ragResult.classification + " (closure requires correct_good_reasoning)");
        fullResponse = fullResponse.replaceAll(FIN_TOKEN, "").trimEnd();
        guardrailTriggered = true;
        emitEvent("guardrail_fin_stripped", "end", { classification: ragResult.classification });
      }

      // 11g. Trace all guardrail results
      trace.traceGuardrails(reqId, {
        solutionLeak: leakCheck.leaked,
        falseConfirmation: confirmCheck.confirmed,
        prematureConfirmation: prematureCheck.premature,
        stateReveal: stateCheck.revealed,
        elementNaming: namingCheck.named,
        didacticExplanation: didacticCheck.explaining,
        styleFixed: styleResult && styleResult.changed,
        finStripped: ragResult.classification !== "correct_good_reasoning" && fullResponse.includes(FIN_TOKEN),
        retries: (leakAttempt > 1 ? leakAttempt - 1 : 0) + (stateAttempt > 1 ? stateAttempt - 1 : 0) + (namingAttempt > 1 ? namingAttempt - 1 : 0) + (didacticAttempt > 1 ? didacticAttempt - 1 : 0),
        finalLen: fullResponse.length,
        finalResponse: fullResponse,
      });

      // 12. Send response to client as SSE
      sseSend(res, { chunk: fullResponse });
      trace.traceResponse(reqId, { len: fullResponse.length, containsFIN: fullResponse.includes(FIN_TOKEN), response: fullResponse });
      emitEvent("response_sent", "end", { responseLength: fullResponse.length, responsePreview: fullResponse, containsFIN: fullResponse.includes(FIN_TOKEN), guardrailTriggered: guardrailTriggered });

      // 13. Save assistant response to MongoDB with detailed metadata
      var ollamaMs = Date.now() - ollamaStart;
      var totalMs = Date.now() - startTime;
      var assistantMetadata = {
        classification: ragResult.classification,
        decision: ragResult.decision,
        guardrails: {
          solutionLeak: leakCheck.leaked,
          falseConfirmation: confirmCheck.confirmed,
          prematureConfirmation: prematureCheck.premature,
          stateReveal: stateCheck.revealed,
          elementNaming: namingCheck.named,
        },
        timing: {
          pipelineMs: pipelineTime,
          ollamaMs: ollamaMs,
          totalMs: totalMs,
        },
        sourcesCount: (ragResult.sources || []).length,
        isCorrectAnswer: isCorrect || false,
      };
      await _r.messageRepo.appendMessage(iid, new Message({
        interaccionId: iid, role: "assistant", content: fullResponse, metadata: assistantMetadata,
      }));
      await _r.interaccionRepo.updateFin(iid, new Date());
      emitEvent("mongodb_save", "end", { interaccionId: iid, messagesAdded: 2 });

      // 14. Close SSE connection
      endSSE(res, hb);

      // 15. Log for evaluation
      logInteraction({
        exerciseNum: exerciseNum, userId: userId,
        correctAnswer: correctAnswer,
        classification: ragResult.classification, decision: ragResult.decision,
        query: text, retrievedDocs: ragResult.sources,
        augmentation: ragResult.augmentation, response: fullResponse,
        guardrailTriggered: guardrailTriggered,
        timing: { pipeline: pipelineTime, total: Date.now() - startTime },
      });
      emitEvent("log_written", "end", { logPath: config.LOG_DIR, fields: ["exerciseNum", "userId", "correctAnswer", "classification", "decision", "query", "retrievedDocs", "augmentation", "response", "guardrailTriggered", "timing"] });
      emitEvent("request_end", "end", { totalTimeMs: Date.now() - startTime, guardrailTriggered: guardrailTriggered, pipelineTimeMs: pipelineTime, llmDurationMs: Date.now() - ollamaStart });

      trace.traceRequestEnd(reqId, {
        outcome: "rag_handled",
        totalMs: Date.now() - startTime,
        responseLen: fullResponse.length,
        classification: ragResult.classification,
        decision: ragResult.decision,
        guardrailTriggered: guardrailTriggered,
      });
    } catch (innerErr) {
      // Error after SSE headers were sent → send error event and close
      clearInterval(hb);
      trace.traceError(reqId, "rag_inner", innerErr);
      console.error("[RAG] Error:", innerErr.message);
      emitEvent("request_error", "end", { error: innerErr.message });
      sseSend(res, { error: "Error en el sistema RAG." });
      res.write("data: [DONE]\n\n");
      if (typeof res.flush === "function") res.flush();
      res.end();
    }
  } catch (err) {
    // Error before SSE headers → fall through to original handler
    logFallthrough("EXCEPTION", { error: err.message, stack: err.stack ? err.stack.split("\n").slice(0, 3).join(" | ") : "-" });
    trace.traceRagGate(reqId, "exception_before_sse", { error: err.message, stack: err.stack ? err.stack.split("\n").slice(0, 3).join(" | ") : "-" });
    console.error("[RAG] Fallback to original handler:", err.message);
    emitEvent("request_error", "end", { error: err.message });
    return next();
  }
});

module.exports = router;
