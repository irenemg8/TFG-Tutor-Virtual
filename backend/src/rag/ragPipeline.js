/*------------------------------------------------------------------------------
            _________________________________________________________
            |                      RAG PIPELINE                     |
            |  Agentic RAG module: a query classifier routes the    |
            |  student message, hybrid + KG retrieval gathers        |
            |  context, CRAG reformulates on low scores, and the     |
            |  augmentation block is assembled for the tutor LLM.    |
            |  LEGACY duplicate kept under src/rag/ for A/B testing  |
            |  against the hexagonal pipeline.                       |
        ____|________________________                               |
   IN -> | runFullPipeline() | -> OUT                                |
          ---------------------                                      |
            |_______________________________________________________|
------------------------------------------------------------------------------*/

const config = require("./config");
const { classifyQuery, extractResistances, types } = require("./queryClassifier");
const { hybridSearch } = require("./hybridSearch");
const { searchKG, searchKGByAC } = require("./knowledgeGraph");
const { emitEvent } = require("./ragEventBus");
const Resultado = require("../models/resultado");

/*
   IN -> ____|________________
        | formatExamples() | -> Txt
         ------------------
      Renders the retrieved dataset examples ([Obj]) into a reference
      block of student/tutor pairs for the LLM. Returns "" when empty.
*/
function formatExamples(results) {
  if (results.length === 0) {
    return "";
  }

  let text = "[REFERENCE EXAMPLES]\n";
  text = text + "The following are examples of how an expert tutor responds to similar student answers.\n";
  text = text + "Use them as reference for tone and pedagogical approach. Adapt to the specific situation.\n\n";

  for (let i = 0; i < results.length; i++) {
    text = text + "Example " + (i + 1) + ":\n";
    text = text + "Student: \"" + results[i].student + "\"\n";
    text = text + "Tutor: \"" + results[i].tutor + "\"\n\n";
  }
  return text;
}

/*
   IN -> ____|_________________
        | formatKGContext() | -> Txt
         -------------------
      Renders knowledge-graph entries ([Obj]) into a domain-knowledge
      block with concepts, expert reasoning, Socratic questions and ACs.
*/
function formatKGContext(kgResults) {
  if (kgResults.length === 0) {
    return "";
  }

  let text = "[DOMAIN KNOWLEDGE]\n";
  for (let i = 0; i < kgResults.length; i++) {
    const entry = kgResults[i];
    text = text + "Concept: \"" + entry.node1 + " " + entry.relation + " " + entry.node2 + "\"\n";
    if (entry.expertReasoning) {
      text = text + "Expert reasoning: \"" + entry.expertReasoning + "\"\n";
    }
    if (entry.socraticQuestions) {
      text = text + "Socratic questions: \"" + entry.socraticQuestions + "\"\n";
    }
    if (entry.acName) {
      text = text + "Alternative conception (AC): \"" + entry.acName + "\"\n";
    }
    if (entry.acDescription) {
      text = text + "AC description: \"" + entry.acDescription + "\"\n";
    }
    if (entry.acErrors) {
      text = text + "Common student errors: \"" + entry.acErrors + "\"\n";
    }
    if (entry.ac2Name) {
      text = text + "Alternative conception 2 (AC): \"" + entry.ac2Name + "\"\n";
    }
    if (entry.ac2Description) {
      text = text + "AC2 description: \"" + entry.ac2Description + "\"\n";
    }
    if (entry.ac2Errors) {
      text = text + "Common student errors 2: \"" + entry.ac2Errors + "\"\n";
    }
    text = text + "\n";
  }
  return text;
}

/*
   IN -> ____|___________________________
        | analyzeStudentResistances() | -> Txt
         -----------------------------
      Compares the student's resistances ([Txt]) against the correct
      answer ([Txt]) and builds an internal per-resistance + tone hint.
*/
function analyzeStudentResistances(resistances, correctAnswer) {
  if (resistances.length === 0) {
    return "";
  }

  const correctSet = {};
  for (let i = 0; i < correctAnswer.length; i++) {
    correctSet[correctAnswer[i]] = true;
  }

  const correctOnes = [];
  const wrongOnes = [];
  for (let i = 0; i < resistances.length; i++) {
    if (correctSet[resistances[i]]) {
      correctOnes.push(resistances[i]);
    } else {
      wrongOnes.push(resistances[i]);
    }
  }

  const mentionedSet = {};
  for (let i = 0; i < resistances.length; i++) {
    mentionedSet[resistances[i]] = true;
  }
  const missed = [];
  for (let i = 0; i < correctAnswer.length; i++) {
    if (!mentionedSet[correctAnswer[i]]) {
      missed.push(correctAnswer[i]);
    }
  }

  let text = "[PER-RESISTANCE ANALYSIS] (internal, NEVER reveal to student)\n";
  text = text + "The student mentioned: " + resistances.join(", ") + ".\n";

  if (correctOnes.length > 0) {
    text = text + "- CORRECT: " + correctOnes.join(", ") + " ARE in the correct answer.\n";
  }
  if (wrongOnes.length > 0) {
    text = text + "- WRONG: " + wrongOnes.join(", ") + " are NOT in the correct answer.\n";
  }
  if (missed.length > 0) {
    text = text + "- MISSING: The student has NOT mentioned " + missed.length + " resistance(s) that ARE in the correct answer. Do NOT name which ones — the student must discover them.\n";
  }

  text = text + "CRITICAL: Do NOT name any resistance the student has not mentioned yet. ";
  text = text + "If resistances are missing, ask a CONCEPTUAL question (about current paths, series/parallel, short circuits) that leads the student to discover them. ";
  text = text + "Example: '¿Hay otros caminos por los que pueda circular corriente?' instead of '¿Qué pasa con R4?'.\n";

  if (wrongOnes.length > 0 && correctOnes.length > 0) {
    text = text + "TONO: La respuesta es PARCIALMENTE correcta. NO uses 'Perfecto', 'Muy bien', 'Genial'. Di algo como 'Vas por buen camino, pero no todo es correcto' y guía para reconsiderar las partes incorrectas.\n";
  } else if (wrongOnes.length > 0 && correctOnes.length === 0) {
    text = text + "TONO: La respuesta es INCORRECTA. NO uses ninguna validación positiva. Di 'No es del todo correcto' y haz una pregunta guía.\n";
  } else if (missed.length > 0) {
    text = text + "TONO: La respuesta es INCOMPLETA (correcta hasta ahora, pero faltan resistencias). NO uses 'Perfecto' ni 'Muy bien'. Di algo como 'Vas por buen camino' y guía a pensar qué más puede faltar.\n";
  }
  text = text + "\n";
  return text;
}

/*
   IN -> ____|__________________________
        | formatClassificationHint() | -> Txt
         ----------------------------
      Turns the classification (Obj) into a response-mode hint, and
      appends the per-resistance analysis when concrete Rs are present.
*/
function formatClassificationHint(classification, correctAnswer) {
  const hints = {
    dont_know: "El estudiante no sabe por dónde empezar. Hazle UNA pregunta sobre un concepto fundamental (ej: '¿Qué condiciones necesita una resistencia para que circule corriente por ella?'). NO menciones resistencias concretas.",
    single_word: "El estudiante ha dado una respuesta sin razonamiento. Pídele que explique POR QUÉ cree eso. No avances hasta que razone.",
    wrong_answer: "El estudiante ha dado resistencias incorrectas. Pídele que explique su razonamiento. Si detectas una concepción alternativa (AC), céntrate en cuestionar ESE concepto con una pregunta socrática. NO menciones resistencias concretas ni reveles estados.",
    correct_no_reasoning: "El estudiante ha acertado pero no ha explicado por qué. Pídele que justifique su respuesta con conceptos de circuitos. NO des por buena la respuesta hasta que razone.",
    correct_wrong_reasoning: "El estudiante ha acertado pero usa un concepto erróneo. Céntrate en corregir la concepción alternativa con una pregunta socrática sobre el concepto, NO sobre las resistencias.",
    correct_good_reasoning: "El estudiante ha acertado con buen razonamiento. Confirma brevemente y finaliza.",
    wrong_concept: "El estudiante muestra una concepción alternativa. Céntrate SOLO en cuestionar ese concepto erróneo con una pregunta socrática. NO guíes hacia resistencias concretas.",
  };

  const hint = hints[classification.type];
  if (hint == null) {
    return "";
  }

  let text = "[RESPONSE MODE]\n";
  text = text + "The student's message has been classified as: " + classification.type + ".\n";
  text = text + hint + "\n";

  if (classification.concepts.length > 0) {
    text = text + "The student mentions: " + classification.concepts.join(", ") + ".\n";
  }

  text = text + "Follow the reference examples below to guide your response style.\n\n";

  if (classification.resistances.length > 0 && correctAnswer != null) {
    text = text + analyzeStudentResistances(classification.resistances, correctAnswer);
  }

  return text;
}

/*
   IN -> ____|_____________________
        | loadStudentHistory() | -> Promise<Txt>
         ----------------------
      Reads the student's stored Resultado error tags (by userId Txt),
      counts recurring misconceptions, and renders a history block.
*/
async function loadStudentHistory(userId) {
  if (userId == null) {
    return "";
  }

  try {
    const resultados = await Resultado.find({ usuario_id: userId }).select("errores");

    const errorCounts = {};
    for (let i = 0; i < resultados.length; i++) {
      const errores = resultados[i].errores;
      if (errores == null) {
        continue;
      }
      for (let j = 0; j < errores.length; j++) {
        const tag = errores[j].etiqueta;
        if (tag != null) {
          if (errorCounts[tag] == null) {
            errorCounts[tag] = 1;
          } 
          else {
            errorCounts[tag] = errorCounts[tag] + 1;
          }
        }
      }
    }

    const tags = Object.keys(errorCounts);
    if (tags.length === 0) {
      return "";
    }

    let text = "[STUDENT HISTORY]\n";
    text = text + "This student has previously shown these misconceptions:\n";
    for (let i = 0; i < tags.length; i++) {
      text = text + "- " + tags[i] + " (" + errorCounts[tags[i]] + " times)\n";
    }
    text = text + "Pay special attention to these recurring errors.\n\n";
    return text;
  } catch (err) {
    console.error("Error loading student history:", err.message);
    return "";
  }
}

/*
   IN -> ____|____________________
        | extractKeyEntities() | -> Txt
         ----------------------
      CRAG helper: extracts resistances and concept keywords from the
      message (Txt) to build a reformulated retrieval query.
*/
function extractKeyEntities(userMessage) {
  const resistances = extractResistances(userMessage);
  const lower = userMessage.toLowerCase();

  const parts = [];
  for (let i = 0; i < resistances.length; i++) {
    parts.push(resistances[i]);
  }

  const conceptKeywords = [
    "divisor de tensión", "divisor de corriente",
    "serie", "paralelo",
    "corriente", "tensión", "resistencia",
    "cortocircuito", "cortocircuitada", "cortocircuitado", "corto",
    "circuito abierto", "abierto", "abierta",
    "se consume", "se gasta", "atenuación",
    "interruptor cerrado", "interruptor abierto",
  ];
  for (let i = 0; i < conceptKeywords.length; i++) {
    if (lower.includes(conceptKeywords[i])) {
      parts.push(conceptKeywords[i]);
    }
  }

  if (parts.length === 0) {
    return userMessage;
  }
  return parts.join(" ");
}

/*
   IN -> ____|________________
        | deduplicateKG() | -> [Obj]
         -----------------
      Removes duplicate KG entries ([Obj]) keyed by node1|relation|node2,
      preserving first-seen order.
*/
function deduplicateKG(entries) {
  var seen = {};
  var result = [];
  for (var i = 0; i < entries.length; i++) {
    var key = (entries[i].node1 || "") + "|" + (entries[i].relation || "") + "|" + (entries[i].node2 || "");
    if (!seen[key]) {
      seen[key] = true;
      result.push(entries[i]);
    }
  }
  return result;
}

/*
   IN -> ____|______________
        | runPipeline() | -> Promise<Obj>
         ---------------
      Core pipeline: classifies the message (Txt), routes to the matching
      retrieval strategy (hybrid + KG, with CRAG retry), and assembles the
      augmentation Obj. acRefs ([Txt]) are exercise-level AC IDs for KG.
*/
async function runPipeline(userMessage, exerciseNum, correctAnswer, userId, acRefs) {
  emitEvent("classify_start", "start", { userMessage: userMessage, correctAnswer: correctAnswer, messageLength: userMessage.length });
  const classification = classifyQuery(userMessage, correctAnswer);
  var isCorrectAnswer = classification.resistances.length > 0 && classification.resistances.slice().sort().join(",") === correctAnswer.slice().sort().join(",");
  emitEvent("classify_end", "end", {
    type: classification.type,
    resistances: classification.resistances,
    hasReasoning: classification.hasReasoning,
    concepts: classification.concepts,
    isCorrectAnswer: isCorrectAnswer,
    resistanceCount: classification.resistances.length,
    conceptCount: classification.concepts.length,
  });

  const result = {
    augmentation: "",
    decision: "no_rag",
    sources: [],
    classification: classification.type,
  };

  if (classification.type === types.greeting) {
    emitEvent("routing_decision", "end", { classification: classification.type, decision: "no_rag", path: "greeting → no_rag" });
    return result;
  }

  if (classification.type === types.dontKnow) {
    emitEvent("routing_decision", "end", { classification: classification.type, decision: "scaffold", path: "dont_know → scaffold" });
    var dkAcResults = searchKGByAC(acRefs);
    var dkConceptResults = classification.concepts.length > 0 ? searchKG(classification.concepts) : [];
    var dkAll = deduplicateKG(dkAcResults.concat(dkConceptResults));
    var dkLimited = dkAll.slice(0, 4);
    emitEvent("kg_search_start", "start", { acRefs: acRefs, concepts: classification.concepts });
    emitEvent("kg_search_end", "end", { resultCount: dkLimited.length, entries: dkLimited.map(function(e) { return { node1: e.node1, relation: e.relation, node2: e.node2, acName: e.acName || null, acDescription: e.acDescription || null, expertReasoning: e.expertReasoning || "", socraticQuestions: e.socraticQuestions || "" }; }) });
    result.augmentation = formatClassificationHint(classification, correctAnswer) + formatKGContext(dkLimited);
    result.decision = "scaffold";
    result.sources = dkLimited;
    return result;
  }

  if (classification.type === types.singleWord) {
    emitEvent("routing_decision", "end", { classification: classification.type, decision: "demand_reasoning", path: "single_word → demand_reasoning" });
    result.augmentation = formatClassificationHint(classification, correctAnswer);
    result.decision = "demand_reasoning";
    return result;
  }

  if (classification.type === types.wrongAnswer) {
    emitEvent("routing_decision", "end", { classification: classification.type, decision: "rag_examples", path: "wrong_answer → rag_examples" });
    emitEvent("hybrid_search_start", "start", { query: userMessage, exerciseNum: exerciseNum, topK: config.TOP_K_FINAL });
    let datasetResults = await hybridSearch(userMessage, exerciseNum);
    emitEvent("hybrid_search_end", "end", { resultCount: datasetResults.length, topScore: datasetResults.length > 0 ? Math.round(datasetResults[0].score * 10000) / 10000 : 0, results: datasetResults.map(function(r, i) { return { rank: i + 1, index: r.index, score: Math.round(r.score * 10000) / 10000, student: r.student || "", tutor: r.tutor || "" }; }) });

    if (datasetResults.length === 0 || datasetResults[0].score < config.MED_THRESHOLD) {
      const reformulated = extractKeyEntities(userMessage);
      emitEvent("crag_reformulate", "end", { originalQuery: userMessage, topScore: datasetResults.length > 0 ? Math.round(datasetResults[0].score * 10000) / 10000 : 0, threshold: config.MED_THRESHOLD, reformulatedQuery: reformulated, reason: "topScore < MED_THRESHOLD (" + config.MED_THRESHOLD + ")", extractedEntities: reformulated.split(" ") });
      emitEvent("hybrid_search_start", "start", { query: reformulated, exerciseNum: exerciseNum, topK: config.TOP_K_FINAL });
      datasetResults = await hybridSearch(reformulated, exerciseNum);
      emitEvent("hybrid_search_end", "end", { resultCount: datasetResults.length, topScore: datasetResults.length > 0 ? Math.round(datasetResults[0].score * 10000) / 10000 : 0, results: datasetResults.map(function(r, i) { return { rank: i + 1, index: r.index, score: Math.round(r.score * 10000) / 10000, student: r.student || "", tutor: r.tutor || "" }; }) });
    }

    var waConceptResults = classification.concepts.length > 0 ? searchKG(classification.concepts) : [];
    var waAcResults = searchKGByAC(acRefs);
    var waKG = deduplicateKG(waConceptResults.concat(waAcResults)).slice(0, 3);
    emitEvent("kg_search_start", "start", { acRefs: acRefs, concepts: classification.concepts });
    emitEvent("kg_search_end", "end", { resultCount: waKG.length, entries: waKG.map(function(e) { return { node1: e.node1, relation: e.relation, node2: e.node2, acName: e.acName || null, acDescription: e.acDescription || null, expertReasoning: e.expertReasoning || "", socraticQuestions: e.socraticQuestions || "" }; }) });
    result.augmentation = formatClassificationHint(classification, correctAnswer) + formatKGContext(waKG) + formatExamples(datasetResults);
    result.decision = "rag_examples";
    result.sources = datasetResults.concat(waKG);
    return result;
  }

  if (classification.type === types.correctNoReasoning) {
    emitEvent("routing_decision", "end", { classification: classification.type, decision: "demand_reasoning", path: "correct_no_reasoning → demand_reasoning" });
    emitEvent("hybrid_search_start", "start", { query: userMessage, exerciseNum: exerciseNum, topK: config.TOP_K_FINAL });
    const datasetResults = await hybridSearch(userMessage, exerciseNum);
    emitEvent("hybrid_search_end", "end", { resultCount: datasetResults.length, topScore: datasetResults.length > 0 ? Math.round(datasetResults[0].score * 10000) / 10000 : 0, results: datasetResults.map(function(r, i) { return { rank: i + 1, index: r.index, score: Math.round(r.score * 10000) / 10000, student: r.student || "", tutor: r.tutor || "" }; }) });
    var cnrKG = searchKGByAC(acRefs).slice(0, 3);
    emitEvent("kg_search_start", "start", { acRefs: acRefs });
    emitEvent("kg_search_end", "end", { resultCount: cnrKG.length, entries: cnrKG.map(function(e) { return { node1: e.node1, relation: e.relation, node2: e.node2, acName: e.acName || null, acDescription: e.acDescription || null, expertReasoning: e.expertReasoning || "", socraticQuestions: e.socraticQuestions || "" }; }) });
    result.augmentation = formatClassificationHint(classification, correctAnswer) + formatKGContext(cnrKG) + formatExamples(datasetResults);
    result.decision = "demand_reasoning";
    result.sources = datasetResults.concat(cnrKG);
    return result;
  }

  if (classification.type === types.correctWrongReasoning) {
    emitEvent("routing_decision", "end", { classification: classification.type, decision: "correct_concept", path: "correct_wrong_reasoning → correct_concept" });
    emitEvent("hybrid_search_start", "start", { query: userMessage, exerciseNum: exerciseNum, topK: config.TOP_K_FINAL });
    const datasetResults = await hybridSearch(userMessage, exerciseNum);
    emitEvent("hybrid_search_end", "end", { resultCount: datasetResults.length, topScore: datasetResults.length > 0 ? Math.round(datasetResults[0].score * 10000) / 10000 : 0, results: datasetResults.map(function(r, i) { return { rank: i + 1, index: r.index, score: Math.round(r.score * 10000) / 10000, student: r.student || "", tutor: r.tutor || "" }; }) });
    emitEvent("kg_search_start", "start", { concepts: classification.concepts });
    const kgResults = searchKG(classification.concepts);
    emitEvent("kg_search_end", "end", { resultCount: kgResults.length, entries: kgResults.map(function(e) { return { node1: e.node1, relation: e.relation, node2: e.node2, acName: e.acName || null, acDescription: e.acDescription || null, expertReasoning: e.expertReasoning || "", socraticQuestions: e.socraticQuestions || "" }; }) });
    result.augmentation = formatClassificationHint(classification, correctAnswer) + formatKGContext(kgResults) + formatExamples(datasetResults);
    result.decision = "correct_concept";
    result.sources = datasetResults.concat(kgResults);
    return result;
  }

  if (classification.type === types.correctGoodReasoning) {
    emitEvent("routing_decision", "end", { classification: classification.type, decision: "rag_examples", path: "correct_good_reasoning → rag_examples" });
    emitEvent("hybrid_search_start", "start", { query: userMessage, exerciseNum: exerciseNum, topK: config.TOP_K_FINAL });
    const datasetResults = await hybridSearch(userMessage, exerciseNum);
    emitEvent("hybrid_search_end", "end", { resultCount: datasetResults.length, topScore: datasetResults.length > 0 ? Math.round(datasetResults[0].score * 10000) / 10000 : 0, results: datasetResults.map(function(r, i) { return { rank: i + 1, index: r.index, score: Math.round(r.score * 10000) / 10000, student: r.student || "", tutor: r.tutor || "" }; }) });
    result.augmentation = formatClassificationHint(classification, correctAnswer) + formatExamples(datasetResults);
    result.decision = "rag_examples";
    result.sources = datasetResults;
    return result;
  }

  if (classification.type === types.wrongConcept) {
    emitEvent("routing_decision", "end", { classification: classification.type, decision: "concept_correction", path: "wrong_concept → concept_correction" });
    emitEvent("kg_search_start", "start", { concepts: classification.concepts });
    const kgResults = searchKG(classification.concepts);
    emitEvent("kg_search_end", "end", { resultCount: kgResults.length, entries: kgResults.map(function(e) { return { node1: e.node1, relation: e.relation, node2: e.node2, acName: e.acName || null, acDescription: e.acDescription || null, expertReasoning: e.expertReasoning || "", socraticQuestions: e.socraticQuestions || "" }; }) });
    emitEvent("hybrid_search_start", "start", { query: userMessage, exerciseNum: exerciseNum, topK: config.TOP_K_FINAL });
    const datasetResults = await hybridSearch(userMessage, exerciseNum);
    emitEvent("hybrid_search_end", "end", { resultCount: datasetResults.length, topScore: datasetResults.length > 0 ? Math.round(datasetResults[0].score * 10000) / 10000 : 0, results: datasetResults.map(function(r, i) { return { rank: i + 1, index: r.index, score: Math.round(r.score * 10000) / 10000, student: r.student || "", tutor: r.tutor || "" }; }) });
    result.augmentation = formatClassificationHint(classification, correctAnswer) + formatKGContext(kgResults) + formatExamples(datasetResults);
    result.decision = "concept_correction";
    result.sources = datasetResults.concat(kgResults);
    return result;
  }

  return result;
}

/*
   IN -> ____|__________________
        | runFullPipeline() | -> Promise<Obj>
         -------------------
      Public entry point: runs runPipeline, then appends the student
      history block and the guardrail reminder to the augmentation Obj.
      acRefs ([Txt]) are optional exercise-level AC IDs (default []).
*/
async function runFullPipeline(userMessage, exerciseNum, correctAnswer, userId, acRefs) {
  const result = await runPipeline(userMessage, exerciseNum, correctAnswer, userId, acRefs || []);

  if (result.decision === "no_rag") {
    return result;
  }

  emitEvent("student_history_start", "start", { userId: userId });
  const history = await loadStudentHistory(userId);
  emitEvent("student_history_end", "end", { hasHistory: history.length > 0, historyLength: history.length, historyPreview: history });
  if (history.length > 0) {
    result.augmentation += history;
  }

  result.augmentation += "[GUARDRAIL]\n";
  result.augmentation += "REGLAS CRÍTICAS PARA TU RESPUESTA:\n";
  result.augmentation += "1. NO reveles la respuesta correcta ni listes resistencias correctas juntas.\n";
  result.augmentation += "2. NO confirmes respuestas incorrectas ('Perfecto', 'Correcto', 'Muy bien').\n";
  result.augmentation += "3. NO nombres resistencias concretas para que el alumno las analice ('¿Qué pasa con R5?', 'Observa R3').\n";
  result.augmentation += "4. NO reveles estados de resistencias (cortocircuitada, abierto), posiciones de interruptores, ni conexiones entre nudos.\n";
  result.augmentation += "5. Haz UNA sola pregunta socrática sobre un CONCEPTO, no sobre un componente.\n";
  result.augmentation += "6. Si el alumno muestra una AC (concepción alternativa), céntrate en cuestionar ESE concepto.\n";

  emitEvent("augmentation_built", "end", { augmentationLength: result.augmentation.length, decision: result.decision, classification: result.classification, sourcesCount: result.sources.length, sections: ["hint", history.length > 0 ? "history" : null, result.sources.length > 0 ? "examples" : null, "guardrail_reminder"].filter(Boolean), augmentationPreview: result.augmentation });

  return result;
}

module.exports = { runFullPipeline };
