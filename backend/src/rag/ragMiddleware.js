/*------------------------------------------------------------------------------
            _________________________________________________________
            |                     RAG MIDDLEWARE                    |
            |  Express middleware that intercepts POST /chat/stream  |
            |  to add RAG augmentation, runs the guardrail checks    |
            |  over the LLM output, and streams the answer back via  |
            |  Server-Sent Events. LEGACY duplicate kept under       |
            |  src/rag/ for A/B testing against the hexagonal        |
            |  orchestrator.                                         |
        ____|_______________________________                        |
   [Obj],Txt -> | injectLangIntoLastUserMsg() | -> void              |
                -----------------------------                        |
        ____|___________                                            |
        | initRAG() | -> void                                       |
        ------------                                                |
        ____|__________________                                     |
   Obj -> | getExerciseNum() | -> Z | null                          |
          ------------------                                        |
        ____|____________________                                   |
   Obj -> | getCorrectAnswer() | -> [Txt]                           |
          --------------------                                      |
        ____|___________                                            |
   Obj,Obj -> | sseSend() | -> void                                 |
              -----------                                           |
        ____|_____________                                          |
        | axiosOpts() | -> Obj                                      |
        -------------                                               |
        ____|____________________                                   |
   Obj -> | buildSystemPrompt() | -> Txt                            |
          ---------------------                                     |
        ____|_____________                                          |
   [Obj] -> | callOllama() | -> Promise<Txt>                        |
            ------------                                            |
        ____|_______________                                        |
   Txt -> | loadHistory() | -> Promise<[Obj]>                       |
          ---------------                                           |
        ____|__________                                             |
   Obj,Obj -> | endSSE() | -> void                                  |
              ----------                                            |
        ____|___________________________                            |
   Obj,Obj,Fn -> | router.post("/chat/stream") | -> Promise<void>   |
                 -----------------------------                      |
            |                                                       |
            |_______________________________________________________|
------------------------------------------------------------------------------*/

const express = require("express");
const axios = require("axios");
const https = require("https");
const mongoose = require("mongoose");
const fs = require("fs");
const path = require("path");
const config = require("./config");
const { runFullPipeline } = require("./ragPipeline");
const { checkSolutionLeak, getStrongerInstruction, checkFalseConfirmation, getFalseConfirmationInstruction, checkStateReveal, getStateRevealInstruction, checkLanguageMix, getLanguageMixInstruction, checkAnswerDirective, getAnswerDirectiveInstruction, checkNewElementIntroduction, getNewElementIntroductionInstruction } = require("./guardrails");
const { loadKG } = require("./knowledgeGraph");
const { loadIndex } = require("./bm25");
const { logInteraction } = require("./logger");
const { setRequestId, emitEvent } = require("./ragEventBus");
const { buildTutorSystemPrompt, getLanguageInstruction, detectLanguage } = require("../utils/promptBuilder");
const Ejercicio = require("../models/ejercicio");
const Interaccion = require("../models/interaccion");

/*
   [Obj],Txt -> ____|___________________________
               | injectLangIntoLastUserMsg() | -> void
                -----------------------------
      Appends the language instruction to the last user message
      (recency bias). Used only in the main flow, not on retries.
*/
function injectLangIntoLastUserMsg(msgs, langInstr) {
  if (!langInstr) return;
  for (var j = msgs.length - 1; j >= 0; j--) {
    if (msgs[j].role === "user") {
      msgs[j] = { role: "user", content: msgs[j].content + "\n" + langInstr.trim() };
      return;
    }
  }
}

let requestCounter = 0;

const router = express.Router();
const httpsAgent = new https.Agent({ rejectUnauthorized: false });
const FIN_TOKEN = "<END_EXERCISE>";

const canonicalExercise = {};

let ragReady = false;

/*
       ____|___________
      | initRAG() | -> void
       ------------
      Loads the knowledge graph and the per-exercise BM25 indexes
      into memory at startup, then flips the ready flag.
*/
function initRAG() {
  try {
    loadKG();

    Object.assign(canonicalExercise, config.CANONICAL_EXERCISE_MAP);
    const exerciseNums = Object.keys(config.EXERCISE_DATASET_MAP);

    for (let i = 0; i < exerciseNums.length; i++) {
      const num = Number(exerciseNums[i]);
      const fileName = config.EXERCISE_DATASET_MAP[num];

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

/*
   Obj -> ____|__________________
         | getExerciseNum() | -> Z | null
          ------------------
      Extracts the exercise number from the title ("Ejercicio 1" -> 1),
      or null when no digit is present.
*/
function getExerciseNum(ejercicio) {
  const match = (ejercicio.titulo || "").match(/(\d+)/);
  if (match != null) {
    return Number(match[1]);
  }
  return null;
}

/*
   Obj -> ____|____________________
         | getCorrectAnswer() | -> [Txt]
          --------------------
      Returns the correct answer as a normalized, upper-cased array
      (e.g. ["R1", "R2", "R4"]), or [] when none is configured.
*/
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

/*
   Obj,Obj -> ____|___________
             | sseSend() | -> void
              -----------
      Writes a single SSE event to the client and flushes the
      response when flushing is supported.
*/
function sseSend(res, payload) {
  res.write("data: " + JSON.stringify(payload) + "\n\n");
  if (typeof res.flush === "function") res.flush();
}

/*
       ____|_____________
      | axiosOpts() | -> Obj
       -------------
      Returns the axios options needed for HTTPS Ollama endpoints
      (the permissive https agent), or {} for plain HTTP.
*/
function axiosOpts() {
  if (config.OLLAMA_CHAT_URL.startsWith("https://")) {
    return { httpsAgent: httpsAgent };
  }
  return {};
}

/*
   Obj -> ____|____________________
         | buildSystemPrompt() | -> Txt
          ---------------------
      Builds the tutor system prompt for the exercise, falling back
      to a minimal Socratic prompt when the builder returns empty.
*/
function buildSystemPrompt(ejercicio) {
  var systemPrompt = buildTutorSystemPrompt(ejercicio);
  if (typeof systemPrompt !== "string" || systemPrompt.trim() === "") {
    systemPrompt = "Eres un tutor socrático. Responde en español. No des la solución: guía con preguntas concretas.";
  }
  return systemPrompt;
}

/*
   [Obj] -> ____|_____________
           | callOllama() | -> Promise<Txt>
            ------------
      Calls Ollama non-streaming so guardrails can inspect the full
      reply before it is sent, and returns the message content.
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
    { timeout: 180000, ...axiosOpts() }
  );
  return (response.data.message && response.data.message.content) || "";
}

/*
   Txt -> ____|_______________
         | loadHistory() | -> Promise<[Obj]>
          ---------------
      Loads the last N conversation messages for an interaction and
      returns them as plain {role, content} objects.
*/
async function loadHistory(interaccionId) {
  const doc = await Interaccion.findById(interaccionId)
    .select({ conversacion: 1 })
    .slice("conversacion", -config.HISTORY_MAX_MESSAGES)
    .lean();

  if (doc == null || !Array.isArray(doc.conversacion)) {
    return [];
  }

  const messages = [];
  for (let i = 0; i < doc.conversacion.length; i++) {
    messages.push({ role: doc.conversacion[i].role, content: doc.conversacion[i].content });
  }
  return messages;
}

/*
   Obj,Obj -> ____|__________
             | endSSE() | -> void
              ----------
      Clears the heartbeat, emits the terminal [DONE] event and
      closes the SSE response cleanly.
*/
function endSSE(res, hb) {
  clearInterval(hb);
  res.write("data: [DONE]\n\n");
  if (typeof res.flush === "function") res.flush();
  res.end();
}

/*
   Obj,Obj,Fn -> ____|___________________________
                | router.post("/chat/stream") | -> Promise<void>
                 -----------------------------
      Intercepts POST /chat/stream: validates inputs, runs the RAG
      pipeline, optionally finishes deterministically, calls Ollama,
      applies the guardrail retries and streams the reply over SSE.
      Falls through to next() whenever RAG does not handle the request.
*/
router.post("/chat/stream", async function (req, res, next) {
  if (!config.RAG_ENABLED || !ragReady) {
    return next();
  }

  const startTime = Date.now();
  requestCounter++;
  setRequestId("req_" + requestCounter + "_" + Date.now());

  try {
    var userId = req.body.userId;
    var exerciseId = req.body.exerciseId;
    var userMessage = req.body.userMessage;
    var interaccionId = req.body.interaccionId;

    if (!userId || !mongoose.Types.ObjectId.isValid(userId)) return next();
    if (!exerciseId || !mongoose.Types.ObjectId.isValid(exerciseId)) return next();
    if (typeof userMessage !== "string" || userMessage.trim() === "") return next();

    emitEvent("request_start", "start", { userId: userId, exerciseId: exerciseId, userMessage: userMessage, interaccionId: interaccionId });

    var ejercicio = await Ejercicio.findById(exerciseId).lean();
    if (ejercicio == null) return next();

    var exerciseNum = getExerciseNum(ejercicio);
    if (exerciseNum == null) return next();

    var correctAnswer = getCorrectAnswer(ejercicio);
    if (correctAnswer.length === 0) return next();

    var tc = ejercicio.tutorContext || {};
    var acRefs = Array.isArray(tc.ac_refs) ? tc.ac_refs.map(function(a) { return String(a).toUpperCase().trim(); }).filter(Boolean) : [];

    emitEvent("exercise_loaded", "end", { exerciseNum: exerciseNum, titulo: ejercicio.titulo, correctAnswer: correctAnswer, acRefs: acRefs, canonicalExercise: canonicalExercise[exerciseNum] || exerciseNum, datasetFile: config.EXERCISE_DATASET_MAP[exerciseNum] || "unknown" });

    var searchNum = canonicalExercise[exerciseNum] || exerciseNum;

    emitEvent("pipeline_start", "start", { userMessage: userMessage.trim(), exerciseNum: searchNum, correctAnswer: correctAnswer, acRefs: acRefs, userId: userId });
    var pipelineStart = Date.now();
    var ragResult = await runFullPipeline(userMessage.trim(), searchNum, correctAnswer, userId, acRefs);
    var pipelineTime = Date.now() - pipelineStart;
    emitEvent("pipeline_end", "end", { decision: ragResult.decision, classification: ragResult.classification, augmentationLength: (ragResult.augmentation || "").length, sourcesCount: (ragResult.sources || []).length, pipelineTimeMs: pipelineTime });

    if (ragResult.decision === "no_rag") {
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
        var exists = await Interaccion.exists({ _id: iid });
        if (!exists) iid = null;
      }
      if (iid == null) {
        var created = await Interaccion.create({
          usuario_id: userId,
          ejercicio_id: exerciseId,
          inicio: new Date(),
          fin: new Date(),
          conversacion: [],
        });
        iid = created._id.toString();
        sseSend(res, { interaccionId: iid });
      }

      var text = userMessage.trim();
      var langInstruction = getLanguageInstruction(text);
      await Interaccion.updateOne(
        { _id: iid },
        { $push: { conversacion: { role: "user", content: text } }, $set: { fin: new Date() } }
      );

      var isCorrect = ragResult.classification === "correct_good_reasoning"
        || ragResult.classification === "correct_no_reasoning"
        || ragResult.classification === "correct_wrong_reasoning";

      if (isCorrect) {
        var prevHistory = await loadHistory(iid);
        var hasConversation = prevHistory.length >= 2;

        if (ragResult.classification === "correct_good_reasoning") {
          emitEvent("deterministic_finish", "end", { classification: ragResult.classification, historyLength: prevHistory.length, finished: true });

          var userLang = detectLanguage(text);
          var finishMsg;
          if (userLang === "en") {
            finishMsg = "Correct! You have correctly identified the resistors. Do you have any remaining questions about the exercise?" + FIN_TOKEN;
          } else if (userLang === "fr") {
            finishMsg = "Correct ! Vous avez bien identifié les résistances. Avez-vous des questions sur l'exercice ?" + FIN_TOKEN;
          } else if (userLang === "ca") {
            finishMsg = "Correcte! Has identificat bé les resistències. Tens algun dubte sobre l'exercici?" + FIN_TOKEN;
          } else {
            finishMsg = "¡Correcto! Has identificado bien las resistencias. ¿Te ha quedado alguna duda sobre el ejercicio?" + FIN_TOKEN;
          }
          sseSend(res, { chunk: finishMsg });

          await Interaccion.updateOne(
            { _id: iid },
            { $push: { conversacion: { role: "assistant", content: finishMsg } }, $set: { fin: new Date() } }
          );

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

      var basePrompt = buildSystemPrompt(ejercicio);
      var augmentedPrompt = basePrompt + "\n\n" + ragResult.augmentation + langInstruction;
      emitEvent("prompt_built", "end", { systemPromptLength: basePrompt.length, ragAugmentationLength: ragResult.augmentation.length, totalPromptLength: augmentedPrompt.length, augmentationPreview: ragResult.augmentation });

      var history = await loadHistory(iid);
      emitEvent("history_loaded", "end", { interaccionId: iid, messageCount: history.length, maxMessages: config.HISTORY_MAX_MESSAGES, messages: history.map(function (m) { return { role: m.role, content: m.content || "" }; }) });

      var messages = [{ role: "system", content: augmentedPrompt }];
      for (let i = 0; i < history.length; i++) {
        messages.push(history[i]);
      }
      injectLangIntoLastUserMsg(messages, langInstruction);

      emitEvent("ollama_call_start", "start", { model: config.OLLAMA_MODEL, temperature: config.OLLAMA_TEMPERATURE, num_ctx: config.OLLAMA_NUM_CTX, num_predict: config.OLLAMA_NUM_PREDICT, keep_alive: config.OLLAMA_KEEP_ALIVE, messageCount: messages.length, ollamaUrl: config.OLLAMA_CHAT_URL });
      var ollamaStart = Date.now();
      var fullResponse = await callOllama(messages);
      emitEvent("ollama_call_end", "end", { responseLength: fullResponse.length, responsePreview: fullResponse, durationMs: Date.now() - ollamaStart, reason: "non-streaming (guardrail check)" });

      var guardrailTriggered = false;

      var leakCheck = checkSolutionLeak(fullResponse, correctAnswer);
      emitEvent("guardrail_leak", "end", { responsePreview: fullResponse, correctAnswer: correctAnswer, result: leakCheck, passed: !leakCheck.leaked, check: "Checks if LLM response reveals the correct answer resistances" });
      if (leakCheck.leaked) {
        guardrailTriggered = true;
        console.log("[RAG] Guardrail triggered (leak): " + leakCheck.details);
        emitEvent("ollama_retry", "start", { reason: "solution_leak", retryCount: 1 });

        var strongerPrompt = augmentedPrompt + getStrongerInstruction();
        var retryMessages = [{ role: "system", content: strongerPrompt }];
        for (let i = 0; i < history.length; i++) {
          retryMessages.push(history[i]);
        }
        fullResponse = await callOllama(retryMessages);
        emitEvent("ollama_retry", "end", { reason: "solution_leak", responseLength: fullResponse.length });
      }

      var confirmCheck = checkFalseConfirmation(fullResponse, ragResult.classification);
      emitEvent("guardrail_false_confirm", "end", { responsePreview: fullResponse, classification: ragResult.classification, result: confirmCheck, passed: !confirmCheck.confirmed, check: "Checks if LLM falsely confirms a wrong answer as correct" });
      if (confirmCheck.confirmed) {
        guardrailTriggered = true;
        console.log("[RAG] Guardrail triggered (false confirm): " + confirmCheck.details);
        emitEvent("ollama_retry", "start", { reason: "false_confirmation", retryCount: 1 });

        var confirmPrompt = augmentedPrompt + getFalseConfirmationInstruction();
        var confirmRetry = [{ role: "system", content: confirmPrompt }];
        for (let i = 0; i < history.length; i++) {
          confirmRetry.push(history[i]);
        }
        fullResponse = await callOllama(confirmRetry);
        emitEvent("ollama_retry", "end", { reason: "false_confirmation", responseLength: fullResponse.length });
      }

      var stateCheck = checkStateReveal(fullResponse);
      emitEvent("guardrail_state_reveal", "end", { responsePreview: fullResponse, result: stateCheck, passed: !stateCheck.revealed, check: "Checks if LLM reveals internal resistance states (open/short/topology)" });
      if (stateCheck.revealed) {
        guardrailTriggered = true;
        console.log("[RAG] Guardrail triggered (state reveal): " + stateCheck.details);
        emitEvent("ollama_retry", "start", { reason: "state_reveal", retryCount: 1 });

        var statePrompt = augmentedPrompt + getStateRevealInstruction();
        var stateRetry = [{ role: "system", content: statePrompt }];
        for (let i = 0; i < history.length; i++) {
          stateRetry.push(history[i]);
        }
        fullResponse = await callOllama(stateRetry);
        emitEvent("ollama_retry", "end", { reason: "state_reveal", responseLength: fullResponse.length });
      }

      var directiveCheck = checkAnswerDirective(fullResponse, correctAnswer);
      emitEvent("guardrail_answer_directive", "end", { responsePreview: fullResponse, correctAnswer: correctAnswer, result: directiveCheck, passed: !directiveCheck.directed, check: "Checks if LLM directs student to a specific correct answer element" });
      if (directiveCheck.directed) {
        guardrailTriggered = true;
        console.log("[RAG] Guardrail triggered (answer directive): " + directiveCheck.details);
        emitEvent("ollama_retry", "start", { reason: "answer_directive", retryCount: 1 });

        var directivePrompt = augmentedPrompt + getAnswerDirectiveInstruction();
        var directiveRetry = [{ role: "system", content: directivePrompt }];
        for (let i = 0; i < history.length; i++) {
          directiveRetry.push(history[i]);
        }
        fullResponse = await callOllama(directiveRetry);
        emitEvent("ollama_retry", "end", { reason: "answer_directive", responseLength: fullResponse.length });
      }

      var studentMentioned = {};
      for (let i = 0; i < history.length; i++) {
        if (history[i].role === "user") {
          var rm = (history[i].content || "").match(/R\d+/gi);
          if (rm) { for (let r = 0; r < rm.length; r++) { studentMentioned[rm[r].toUpperCase()] = true; } }
        }
      }
      var studentMentionedArr = Object.keys(studentMentioned);
      var introCheck = checkNewElementIntroduction(fullResponse, studentMentionedArr, correctAnswer);
      emitEvent("guardrail_new_element", "end", { responsePreview: fullResponse, studentMentioned: studentMentionedArr, result: introCheck, passed: !introCheck.introduced, check: "Checks if LLM names a resistance the student has never mentioned" });
      if (introCheck.introduced) {
        guardrailTriggered = true;
        console.log("[RAG] Guardrail triggered (new element): " + introCheck.details);
        emitEvent("ollama_retry", "start", { reason: "new_element_introduction", retryCount: 1 });

        var introPrompt = augmentedPrompt + getNewElementIntroductionInstruction();
        var introRetry = [{ role: "system", content: introPrompt }];
        for (let i = 0; i < history.length; i++) {
          introRetry.push(history[i]);
        }
        fullResponse = await callOllama(introRetry);
        emitEvent("ollama_retry", "end", { reason: "new_element_introduction", responseLength: fullResponse.length });
      }

      var userLangCode = detectLanguage(text);
      var mixCheck = checkLanguageMix(fullResponse, userLangCode);
      emitEvent("guardrail_language_mix", "end", { responsePreview: fullResponse, userLangCode: userLangCode, result: mixCheck, passed: !mixCheck.mixed, check: "Checks if LLM response mixes languages (e.g. Chinese characters in a Spanish response)" });
      if (mixCheck.mixed) {
        guardrailTriggered = true;
        console.log("[RAG] Guardrail triggered (language mix): " + mixCheck.details);
        emitEvent("ollama_retry", "start", { reason: "language_mix", retryCount: 1 });

        var mixPrompt = augmentedPrompt + getLanguageMixInstruction();
        var mixRetry = [{ role: "system", content: mixPrompt }];
        for (let i = 0; i < history.length; i++) {
          mixRetry.push(history[i]);
        }
        fullResponse = await callOllama(mixRetry);
        emitEvent("ollama_retry", "end", { reason: "language_mix", responseLength: fullResponse.length });
      }

      sseSend(res, { chunk: fullResponse });
      emitEvent("response_sent", "end", { responseLength: fullResponse.length, responsePreview: fullResponse, containsFIN: fullResponse.includes(FIN_TOKEN), guardrailTriggered: guardrailTriggered });

      await Interaccion.updateOne(
        { _id: iid },
        { $push: { conversacion: { role: "assistant", content: fullResponse } }, $set: { fin: new Date() } }
      );
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
    } catch (innerErr) {
      clearInterval(hb);
      console.error("[RAG] Error:", innerErr.message);
      emitEvent("request_error", "end", { error: innerErr.message });
      sseSend(res, { error: "Error en el sistema RAG." });
      res.write("data: [DONE]\n\n");
      if (typeof res.flush === "function") res.flush();
      res.end();
    }
  } catch (err) {
    console.error("[RAG] Fallback to original handler:", err.message);
    emitEvent("request_error", "end", { error: err.message });
    return next();
  }
});

module.exports = router;
