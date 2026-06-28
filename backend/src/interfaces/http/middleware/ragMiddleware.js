const express = require("express");
const axios = require("axios");
const https = require("https");

/*------------------------------------------------------------------------------
            _________________________________________________________
            |                    RAG MIDDLEWARE                     |
            |  Express middleware that intercepts POST /chat/stream  |
            |  to add RAG augmentation. When RAG handles the turn it |
            |  responds directly over SSE (input guardrail, pipeline,|
            |  deterministic finish, LLM call + output guardrails,   |
            |  persistence, logging); otherwise it calls next() so   |
            |  the legacy handler takes over.                       |
        ____|_____________                                           |
   Txt -> | isValidId() | -> T/F                   (pure check)      |
          -------------                                              |
            |   Helpers: repos, initRAG, ensureRagReady,            |
            |   getExerciseNum, getCorrectAnswer,                   |
            |   getEvaluableElements, sseSend, axiosOpts,           |
            |   buildSystemPrompt, callOllama,                      |
            |   countPreviousCorrectTurns, countTotalAssistantTurns,|
            |   countConsecutiveWrongTurns, loadHistory,            |
            |   buildConversationProgressHint, detectTutorRepetition,|
            |   detectFrustration, endSSE, logFallthrough            |
            |_______________________________________________________|
------------------------------------------------------------------------------*/

/*
 Txt -> ____|_____________
       | isValidId() | -> T/F
        -------------
    True when v is a legacy MongoDB ObjectId (24 hex) or a UUID. Postgres
    keeps the ObjectId format for historical data and uses UUIDs for new rows.
*/
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

/*
       ____|________
      | repos() | -> Obj | null    (reads container (Obj))
       ----------
    Resolves ejercicio/interaccion/message repositories from the container.
    Returns null when the container is not initialized (caller falls through).
*/
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
const FIN_TOKEN = "<END_EXERCISE>";

const canonicalExercise = {};

let ragReady = false;
let kgConceptPatterns = [];

/*
       ____|__________
      | initRAG() | -> void
       -----------
    One-time RAG setup: fills the canonical exercise map and, when the
    container has not already exposed them, derives KG concept patterns and
    loads the BM25 indices. Sets ragReady on success.
*/
function initRAG() {
  try {
    Object.assign(canonicalExercise, config.CANONICAL_EXERCISE_MAP);
    const exerciseNums = Object.keys(config.EXERCISE_DATASET_MAP);

    if (container._initialized && Array.isArray(container.kgConceptPatterns) && container.kgConceptPatterns.length > 0) {
      kgConceptPatterns = container.kgConceptPatterns;
    } else {
      try {
        loadKG();
      } catch (kgErr) {
        console.warn("[RAG] KG load fallback failed:", kgErr.message);
      }
      try {
        kgConceptPatterns = loadConceptPatternsFromKG(getAllEntries());
      } catch (e) {
        console.warn("[RAG] Could not derive concept patterns from KG:", e.message);
      }
      for (let i = 0; i < exerciseNums.length; i++) {
        const num = Number(exerciseNums[i]);
        const fileName = config.EXERCISE_DATASET_MAP[num];
        try {
          const filePath = path.join(config.DATASETS_DIR, fileName);
          const pairs = JSON.parse(fs.readFileSync(filePath, "utf-8"));
          loadIndex(num, pairs);
        } catch (e) {
          console.warn("[RAG] BM25 fallback load failed for ex " + num + ":", e.message);
        }
      }
    }

    ragReady = true;
    console.log("[RAG] Ready (kgPatterns=" + kgConceptPatterns.length + ")");
  } catch (err) {
    console.error("[RAG] Init failed:", err.message);
  }
}

/*
       ____|________________
      | ensureRagReady() | -> void
       ------------------
    Lazy init guard: runs initRAG once on the first request, by which time
    the container has finished initialize() and its KG/BM25 can be reused.
*/
function ensureRagReady() {
  if (!ragReady) initRAG();
}

/*
 Ejercicio -> ____|__________________
             | getExerciseNum() | -> Z | null
              ------------------
    Extracts the exercise number from the title ("Ejercicio 1" -> 1).
*/
function getExerciseNum(ejercicio) {
  const match = (ejercicio.title || "").match(/(\d+)/);
  if (match != null) {
    return Number(match[1]);
  }
  return null;
}

/*
 Ejercicio -> ____|___________________
             | getCorrectAnswer() | -> [Txt]
              -------------------
    Returns the exercise's correct answer as a normalized uppercase array
    (e.g. ["R1", "R2", "R4"]), or [] when none is configured.
*/
function getCorrectAnswer(ejercicio) {
  const answer = ejercicio.tutorContext && ejercicio.tutorContext.correctAnswer;
  if (!Array.isArray(answer)) {
    return [];
  }
  const result = [];
  for (let i = 0; i < answer.length; i++) {
    result.push(String(answer[i]).toUpperCase().trim());
  }
  return result;
}

/*
 Ejercicio -> ____|________________________
             | getEvaluableElements() | -> [Txt]
              ------------------------
    Returns all evaluable elements (correct + incorrect) for generic
    extraction: the explicit tutorContext field, else the answer-eligible
    components parsed from the netlist (R/C/L/D/I, excluding nodes and
    sources), else just the correct answer.
*/
function getEvaluableElements(ejercicio) {
  var tc = ejercicio.tutorContext || {};

  if (Array.isArray(tc.evaluableElements) && tc.evaluableElements.length > 0) {
    return tc.evaluableElements.map(function (e) { return String(e).toUpperCase().trim(); });
  }

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

  return (tc.correctAnswer || []).map(function (e) { return String(e).toUpperCase().trim(); });
}

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
       ____|____________
      | axiosOpts() | -> Obj
       -------------
    Returns axios options (the shared https agent) when the Ollama URL is
    https, otherwise {}.
*/
function axiosOpts() {
  if (config.OLLAMA_CHAT_URL.startsWith("https://")) {
    return { httpsAgent: httpsAgent };
  }
  return {};
}

/*
 Ejercicio, Txt -> ____|____________________
                  | buildSystemPrompt() | -> Txt
                   --------------------
    Builds the tutor system prompt for an exercise + language, with a
    minimal Socratic fallback when the builder yields empty text.
*/
function buildSystemPrompt(ejercicio, lang) {
  var systemPrompt = buildTutorSystemPrompt(ejercicio, lang);
  if (typeof systemPrompt !== "string" || systemPrompt.trim() === "") {
    systemPrompt = "Eres un tutor socrático. Responde en español. No des la solución: guía con preguntas concretas.";
  }
  return systemPrompt;
}

/*
 [Obj] -> ____|_____________
         | callOllama() | -> Promise<Txt>
          --------------
    Calls Ollama /api/chat non-streaming so guardrails can run before the
    text reaches the client. Returns the full response content.
*/
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
    {
      timeout: Number(process.env.OLLAMA_TIMEOUT_MS || 60000),
      ...axiosOpts(),
    }
  );
  return (response.data.message && response.data.message.content) || "";
}

/*
 Txt -> ____|____________________________
       | countPreviousCorrectTurns() | -> Promise<Z>
        ----------------------------
    Counts prior assistant turns classified as "correct-ish" (used for
    loop detection / demanding justification).
*/
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

/*
 Txt -> ____|___________________________
       | countTotalAssistantTurns() | -> Promise<Z>
        ---------------------------
    Counts all assistant turns in the interaction.
*/
async function countTotalAssistantTurns(interaccionId) {
  const r = repos(); if (!r) return 0;
  return r.messageRepo.countAssistantMessages(interaccionId);
}

/*
 Txt -> ____|____________________________
       | countConsecutiveWrongTurns() | -> Promise<Z>
        -----------------------------
    Counts wrong_answer/wrong_concept assistant turns in a row from the end.
*/
async function countConsecutiveWrongTurns(interaccionId) {
  const r = repos(); if (!r) return 0;
  return r.messageRepo.countConsecutiveFromEnd(
    interaccionId,
    ["wrong_answer", "wrong_concept"]
  );
}

/*
 Txt -> ____|______________
       | loadHistory() | -> Promise<[Obj]>
        --------------
    Loads the last HISTORY_MAX_MESSAGES messages as {role, content} entries.
*/
async function loadHistory(interaccionId) {
  const r = repos(); if (!r) return [];
  const msgs = await r.messageRepo.getLastMessages(interaccionId, config.HISTORY_MAX_MESSAGES);
  return msgs.map((m) => ({ role: m.role, content: m.content }));
}

/*
 [Obj] -> ____|________________________________
         | buildConversationProgressHint() | -> Txt
          --------------------------------
    Builds a short hint reminding the LLM of its last question so it can
    evaluate the student's reply in context and avoid re-asking. Returns ""
    when there is no prior question.
*/
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

/*
 Txt -> ____|________________________
       | detectTutorRepetition() | -> Promise<Obj>
        ------------------------
    Detects whether the tutor keeps asking the same question, comparing all
    pairs among the last 4 assistant questions (catches A-B-A-B patterns).
    Returns { repeating, lastQuestion? }.
*/
async function detectTutorRepetition(interaccionId) {
  const r = repos(); if (!r) return { repeating: false };
  const lastAssistant = await r.messageRepo.getLastAssistantMessages(interaccionId, 4);
  if (lastAssistant.length < 2) return { repeating: false };
  const assistantMessages = lastAssistant.map((m) => m.content || "");

  function extractLastQuestion(text) {
    var qs = text.match(/[^.!?]*\?/g);
    return qs && qs.length > 0 ? qs[qs.length - 1].toLowerCase().trim() : "";
  }

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

  var questions = [];
  for (var m = 0; m < assistantMessages.length; m++) {
    var q = extractLastQuestion(assistantMessages[m]);
    if (q) questions.push(q);
  }
  if (questions.length < 2) return { repeating: false };

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

var frustrationPatternsAll = getAllPatterns(frustrationDict);

/*
 Txt -> ____|___________________
       | detectFrustration() | -> T/F
        -------------------
    True when the message contains a known frustration pattern ("I already
    told you", etc.).
*/
function detectFrustration(message) {
  var lower = message.toLowerCase();
  for (var i = 0; i < frustrationPatternsAll.length; i++) {
    if (lower.includes(frustrationPatternsAll[i])) {
      return true;
    }
  }
  return false;
}

/*
 Obj, Obj -> ____|__________
            | endSSE() | -> void
             ----------
    Clears the heartbeat, writes the [DONE] terminator and ends the response.
*/
function endSSE(res, hb) {
  clearInterval(hb);
  res.write("data: [DONE]\n\n");
  if (typeof res.flush === "function") res.flush();
  res.end();
}

/*
 Txt, Obj -> ____|________________
            | logFallthrough() | -> void
             ----------------
    Always-on log marking when the RAG middleware falls through to the
    legacy handler (critical for debugging; never gated behind DEBUG_PIPELINE).
*/
function logFallthrough(reason, details) {
  console.log("[RAG_SKIP] ⛔ reason=" + reason + (details ? " " + JSON.stringify(details) : ""));
}

router.post("/chat/stream", async function (req, res, next) {
  ensureRagReady();
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
    var userId = req.userId;
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
      logFallthrough("no_exercise_number_in_title", { titulo: ejercicio.title });
      trace.traceRagGate(reqId, "no_exercise_number_in_title", { titulo: ejercicio.title });
      return next();
    }

    var correctAnswer = getCorrectAnswer(ejercicio);
    if (correctAnswer.length === 0) {
      logFallthrough("no_correct_answer", { exerciseNum: exerciseNum, hasTutorContext: !!ejercicio.tutorContext, respuestaCorrecta: ejercicio.tutorContext && ejercicio.tutorContext.correctAnswer });
      trace.traceRagGate(reqId, "no_correct_answer", { exerciseNum: exerciseNum, tutorContext: !!ejercicio.tutorContext });
      return next();
    }

    emitEvent("exercise_loaded", "end", { exerciseNum: exerciseNum, titulo: ejercicio.title, correctAnswer: correctAnswer, canonicalExercise: canonicalExercise[exerciseNum] || exerciseNum, datasetFile: config.EXERCISE_DATASET_MAP[exerciseNum] || "unknown" });

    var searchNum = canonicalExercise[exerciseNum] || exerciseNum;

    var evaluableElements = getEvaluableElements(ejercicio);

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
    trace.traceBudgetSet(reqId, 45000);

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
            userId: userId,
            exerciseId: exerciseId,
          });
          iidBlock = createdB.id;
          sseSend(res, { interaccionId: iidBlock });
        }

        await _r.messageRepo.appendMessage(iidBlock, new Message({
          interactionId: iidBlock, role: "user", content: userMessage.trim(),
        }));
        await _r.messageRepo.appendMessage(iidBlock, new Message({
          interactionId: iidBlock, role: "assistant", content: securityResult.redirectMessage,
          metadata: {
            blockedByInputGuardrail: true,
            category: securityResult.category,
            matchedPattern: securityResult.matchedPattern,
          },
        }));
        await _r.interaccionRepo.updateEndTime(iidBlock, new Date());

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

    if (ragResult.decision === "no_rag") {
      logFallthrough("no_rag_decision", { classification: ragResult.classification, pipelineMs: pipelineTime });
      trace.traceRagGate(reqId, "no_rag_decision", { classification: ragResult.classification, pipelineMs: pipelineTime });
      emitEvent("no_rag", "end", { reason: "greeting or non-RAG classification" });
      emitEvent("request_end", "end", { totalTimeMs: Date.now() - startTime });
      return next();
    }

    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    if (typeof res.flushHeaders === "function") res.flushHeaders();
    res.write(": ok\n\n");
    if (typeof res.flush === "function") res.flush();

    var hb = setInterval(function () {
      res.write(": ping\n\n");
      if (typeof res.flush === "function") res.flush();
    }, 15000);

    try {
      var iid = interaccionId || null;
      if (iid) {
        var exists = await _r.interaccionRepo.existsForUser(iid, userId);
        if (!exists) iid = null;
      }
      if (iid == null) {
        var created = await _r.interaccionRepo.create({
          userId: userId, exerciseId: exerciseId,
        });
        iid = created.id;
        sseSend(res, { interaccionId: iid });
      }

      var text = userMessage.trim();
      var studentResponseMs = null;
      var lastMsg = await _r.messageRepo.getLastMessage(iid);
      if (lastMsg && lastMsg.role === "assistant" && lastMsg.timestamp) {
        studentResponseMs = Date.now() - new Date(lastMsg.timestamp).getTime();
      }
      await _r.messageRepo.appendMessage(iid, new Message({
        interactionId: iid, role: "user", content: text,
        metadata: studentResponseMs != null ? { studentResponseMs } : null,
      }));
      await _r.interaccionRepo.updateEndTime(iid, new Date());

      var isCorrect = ragResult.classification === "correct_good_reasoning"
        || ragResult.classification === "correct_no_reasoning"
        || ragResult.classification === "correct_wrong_reasoning";

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
        var prevHistory = await loadHistory(iid);
        var hasConversation = prevHistory.length >= 2;
        var lang = resolveLanguage(prevHistory);

        if (ragResult.classification === "correct_good_reasoning") {
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
            interactionId: iid, role: "assistant", content: finishMsg,
            metadata: {
              classification: ragResult.classification,
              decision: "deterministic_finish",
              isCorrectAnswer: true,
              timing: { pipelineMs: pipelineTime, totalMs: Date.now() - startTime },
            },
          }));
          await _r.interaccionRepo.updateEndTime(iid, new Date());

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
        emitEvent("deterministic_finish", "skip", { classification: ragResult.classification, historyLength: prevHistory.length, finished: false });
      }

      var history = await loadHistory(iid);
      var lang = resolveLanguage(history);
      var basePrompt = buildSystemPrompt(ejercicio, lang);
      var progressHint = buildConversationProgressHint(history);
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
      var scaffoldHint = "";
      if (ragResult.classification === "dont_know") {
        scaffoldHint = "[STUDENT DOESN'T KNOW]\n"
          + "CRITICAL: The student just said they don't know. You MUST:\n"
          + "- NOT explain concepts. NOT give definitions. NOT say 'this means that...' or 'when a resistor is X, then Y'.\n"
          + "- NOT reveal internal states (short-circuited, open, same potential, etc.).\n"
          + "- Lower the scaffolding: ask ONE simpler, more concrete question about a VISIBLE feature of the circuit (e.g. 'Look at where the two terminals of one of the elements are connected. Do you notice anything?').\n"
          + "- Keep the response to a SINGLE question, no preamble, no explanation.\n\n";
      }

      var justificationHint = "";
      if (demandJustification) {
        justificationHint = "[DEMAND JUSTIFICATION]\n"
          + "CRITICAL: The student has given the CORRECT answer " + prevCorrectCount + " time(s) WITHOUT any justification, or with INCORRECT reasoning.\n"
          + "You MUST NOT accept the answer as final. You MUST NOT emit <END_EXERCISE>.\n"
          + "Your ONLY task this turn is:\n"
          + "1. Briefly acknowledge that they have the right elements.\n"
          + "2. Ask DIRECTLY and CLEARLY: 'Explica por que' / 'Explain why' / 'Explica per que', requiring them to use a concept such as cortocircuito, circuito abierto, divisor de tension, ley de Ohm, Kirchhoff, etc.\n"
          + "3. Do NOT name the correct elements in your question. Use generic wording like 'esos elementos' / 'those elements'.\n"
          + "4. Do NOT provide the reasoning yourself. The student must produce it.\n\n";
      }

      var augmentedPrompt = basePrompt + "\n\n" + progressHint + repetitionHint + frustrationHint + stuckHint + scaffoldHint + justificationHint + ragResult.augmentation;
      emitEvent("prompt_built", "end", { systemPromptLength: basePrompt.length, ragAugmentationLength: ragResult.augmentation.length, totalPromptLength: augmentedPrompt.length, augmentationPreview: ragResult.augmentation });

      emitEvent("history_loaded", "end", { interaccionId: iid, messageCount: history.length, maxMessages: config.HISTORY_MAX_MESSAGES, messages: history.map(function (m) { return { role: m.role, content: m.content || "" }; }) });

      var messages = [{ role: "system", content: augmentedPrompt }];
      for (let i = 0; i < history.length; i++) {
        messages.push(history[i]);
      }

      trace.traceLlmCall(reqId, "start", { model: config.OLLAMA_MODEL, messagesCount: messages.length, promptLen: augmentedPrompt.length, reason: "primary" });
      emitEvent("ollama_call_start", "start", { model: config.OLLAMA_MODEL, temperature: config.OLLAMA_TEMPERATURE, num_ctx: config.OLLAMA_NUM_CTX, num_predict: config.OLLAMA_NUM_PREDICT, keep_alive: config.OLLAMA_KEEP_ALIVE, messageCount: messages.length, ollamaUrl: config.OLLAMA_CHAT_URL });
      var ollamaStart = Date.now();
      var fullResponse = await callOllama(messages);
      trace.traceLlmCall(reqId, "end", { durationMs: Date.now() - ollamaStart, responseLen: fullResponse.length, reason: "primary", response: fullResponse });
      emitEvent("ollama_call_end", "end", { responseLength: fullResponse.length, responsePreview: fullResponse, durationMs: Date.now() - ollamaStart, reason: "non-streaming (guardrail check)" });

      var guardrailTriggered = false;

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

      if (stateCheck.revealed) {
        var _tSurg0 = Date.now();
        var _placeholderRe = require("../../../domain/services/rag/guardrails").STATE_REVEAL_PLACEHOLDER_REGEX;
        var _priorHits = 0;
        for (var _hi = 0; _hi < history.length; _hi++) {
          var _hm = history[_hi];
          if (_hm && _hm.role === "assistant" && typeof _hm.content === "string") {
            if (_placeholderRe.test(_hm.content)) _priorHits++;
          }
        }
        var stateRedact = redactStateRevealSentence(fullResponse, evaluableElements, stateCheck.pattern, lang, _priorHits);
        trace.traceSurgicalFix(reqId, "state_reveal", { applied: stateRedact.redacted, durationMs: Date.now() - _tSurg0, before: fullResponse, after: stateRedact.text });
        if (stateRedact.redacted) {
          guardrailTriggered = true;
          console.log("[RAG] Deterministic state-reveal redaction applied");
          emitEvent("guardrail_redaction", "end", { reason: "state_reveal_fallback", before: fullResponse, after: stateRedact.text, pattern: stateCheck.pattern });
          fullResponse = stateRedact.text;
        }
      }

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

      var studentMentionedElements = ragResult.mentionedElements && ragResult.mentionedElements.length > 0;
      if (studentMentionedElements) {
        var finalConfirmCheck = checkFalseConfirmation(fullResponse, ragResult.classification);
        if (finalConfirmCheck.confirmed) {
          var prefix = getRandomIntermediatePhrase("wrong", lang);
          if (prefix) {
            console.log("[RAG] Deterministic prefix forced: " + prefix);
            var cleaned = removeOpeningConfirmation(fullResponse, lang);
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

      var styleResult = enforceDatasetStyle(fullResponse);
      if (styleResult && styleResult.changed) {
        console.log("[RAG] Dataset-style filter removed markdown formatting");
        emitEvent("guardrail_style", "end", { before: fullResponse, after: styleResult.text });
        fullResponse = styleResult.text;
        guardrailTriggered = true;
      }

      if (ragResult.classification !== "correct_good_reasoning" && fullResponse.includes(FIN_TOKEN)) {
        console.log("[RAG] Stripping END_EXERCISE token: classification=" + ragResult.classification + " (closure requires correct_good_reasoning)");
        fullResponse = fullResponse.replaceAll(FIN_TOKEN, "").trimEnd();
        guardrailTriggered = true;
        emitEvent("guardrail_fin_stripped", "end", { classification: ragResult.classification });
      }

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

      sseSend(res, { chunk: fullResponse });
      trace.traceResponse(reqId, { len: fullResponse.length, containsFIN: fullResponse.includes(FIN_TOKEN), response: fullResponse });
      emitEvent("response_sent", "end", { responseLength: fullResponse.length, responsePreview: fullResponse, containsFIN: fullResponse.includes(FIN_TOKEN), guardrailTriggered: guardrailTriggered });

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
        interactionId: iid, role: "assistant", content: fullResponse, metadata: assistantMetadata,
      }));
      await _r.interaccionRepo.updateEndTime(iid, new Date());
      emitEvent("mongodb_save", "end", { interaccionId: iid, messagesAdded: 2 });

      endSSE(res, hb);

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
    logFallthrough("EXCEPTION", { error: err.message, stack: err.stack ? err.stack.split("\n").slice(0, 3).join(" | ") : "-" });
    trace.traceRagGate(reqId, "exception_before_sse", { error: err.message, stack: err.stack ? err.stack.split("\n").slice(0, 3).join(" | ") : "-" });
    console.error("[RAG] Fallback to original handler:", err.message);
    emitEvent("request_error", "end", { error: err.message });
    return next();
  }
});

module.exports = router;
