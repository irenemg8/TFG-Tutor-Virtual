// Main agentic RAG pipeline: classifier -> retrieval -> CRAG -> augmentation

const config = require("../../../infrastructure/llm/config");
const { classifyQuery, extractResistances, types } = require("./queryClassifier");
const { hybridSearch } = require("../../../infrastructure/search/hybridSearch");
const { searchKG } = require("../../../infrastructure/search/knowledgeGraph");
const { emitEvent } = require("../../../infrastructure/events/ragEventBus");
const container = require("../../../container");
const { getAllPatterns, conceptKeywords: conceptDict, normalizeToSpanish, getIntermediateFeedback } = require("../languageManager");

// Foundational KG concepts to scaffold the tutor's hints when the student is
// wrong/partial but did NOT use any concept keyword. Picks the building blocks
// most circuits exercises hinge on.
const SCAFFOLD_CONCEPTS = [
  "serie", "paralelo", "cortocircuito", "circuito abierto",
  "divisor de tensión", "interruptor abierto",
];

// Format dataset examples as context for the LLM
function formatExamples(results) {
  if (results.length === 0) {
    return "";
  }

/*-------------------------------------------------------------------------
[REFERENCE EXAMPLES]
The following are examples of how an expert tutor responds...

Example 1:
Student: "R1 y R2 por el divisor de tensión"
Tutor: "En un divisor de tensión todos los componentes están en serie..."

Example 2:
Student: "R5"
Tutor: "¿Por qué piensas que R5 ...?"
-------------------------------------------------------------------------*/

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

// Format knowledge graph results as context for the LLM
function formatKGContext(kgResults) {
  if (kgResults.length === 0) {
    return "";
  }

/*-------------------------------------------------------------------------
[DOMAIN KNOWLEDGE]
Concept: "Dispositivos pueden conectarse en serie y en paralelo"
Expert reasoning: "En una conexión en serie, los dispositivos se conectan uno tras otro,
formando un único camino para la corriente..."
Socratic questions: "¿En un divisor de tensión todos los componentes están conectados en serie?"

Concept: "Un cortocircuito tiene diferencia de potencial cero"
Expert reasoning: "Cuando un componente está cortocircuitado, la corriente no pasa por él..."
Socratic questions: "¿Qué ocurre con la corriente cuando un componente está cortocircuitado?"
-------------------------------------------------------------------------*/

  let text = "[DOMAIN KNOWLEDGE]\n";
  text += "IMPORTANT: Use the following knowledge as internal reference ONLY. Do NOT copy the Socratic questions verbatim. ";
  text += "Adapt them to the current conversation context, what the student has already answered, and avoid repeating anything you already asked.\n\n";
  for (let i = 0; i < kgResults.length; i++) {
    const entry = kgResults[i];
    text = text + "Concept: \"" + entry.node1 + " " + entry.relation + " " + entry.node2 + "\"\n";
    if (entry.expertReasoning) {
      text = text + "Expert reasoning: \"" + entry.expertReasoning + "\"\n";
    }
    if (entry.socraticQuestions) {
      text = text + "Socratic questions: \"" + entry.socraticQuestions + "\"\n";
    }
    // Render every AC associated with this KG entry. Some entries carry two
    // alternative conceptions on the same concept; both are pedagogically
    // relevant. Falls back to the legacy primary fields when the new
    // alternativeConceptions array is missing (defensive).
    const acs = Array.isArray(entry.alternativeConceptions) && entry.alternativeConceptions.length > 0
      ? entry.alternativeConceptions
      : (entry.acName || entry.acDescription
          ? [{ ac: entry.ac, acName: entry.acName, acDescription: entry.acDescription }]
          : []);
    for (let a = 0; a < acs.length; a++) {
      if (acs[a].acName) {
        text = text + "Alternative conception: \"" + acs[a].acName + "\"\n";
      }
      if (acs[a].acDescription) {
        text = text + "AC description: \"" + acs[a].acDescription + "\"\n";
      }
    }
    text = text + "\n";
  }
  return text;
}

// Analyze each element the student mentioned: which are proposed, which are negated, which are correct/wrong
// Generic: works with any evaluable elements (resistances, concepts, definitions, etc.)
function analyzeStudentElements(classification, correctAnswer) {
  var proposed = classification.proposed || [];
  var negated = classification.negated || [];

  if (proposed.length === 0 && negated.length === 0) {
    return "";
  }

  var correctSet = {};
  for (var i = 0; i < correctAnswer.length; i++) {
    correctSet[correctAnswer[i]] = true;
  }

  // Analyze proposed elements
  var correctProposals = [];
  var wrongProposals = [];
  for (var i = 0; i < proposed.length; i++) {
    if (correctSet[proposed[i]]) {
      correctProposals.push(proposed[i]);
    } else {
      wrongProposals.push(proposed[i]);
    }
  }

  // Analyze negated elements
  var correctNegations = [];  // student rejects something NOT in the answer (correct rejection)
  var wrongNegations = [];    // student rejects something IN the answer (wrong rejection)
  for (var i = 0; i < negated.length; i++) {
    if (correctSet[negated[i]]) {
      wrongNegations.push(negated[i]);
    } else {
      correctNegations.push(negated[i]);
    }
  }

  // Find missing elements (in correct answer, not proposed, not negated)
  var allMentioned = {};
  for (var i = 0; i < proposed.length; i++) allMentioned[proposed[i]] = true;
  for (var i = 0; i < negated.length; i++) allMentioned[negated[i]] = true;
  var missed = [];
  for (var i = 0; i < correctAnswer.length; i++) {
    if (!allMentioned[correctAnswer[i]]) {
      missed.push(correctAnswer[i]);
    }
  }

  var text = "[PER-ELEMENT ANALYSIS] (internal, NEVER reveal to student)\n";

  if (proposed.length > 0) {
    text += "The student PROPOSES: " + proposed.join(", ") + ".\n";
  }
  if (negated.length > 0) {
    text += "The student REJECTS: " + negated.join(", ") + ".\n";
  }

  if (correctProposals.length > 0) {
    text += "- CORRECT PROPOSALS: " + correctProposals.join(", ") + " ARE in the correct answer.\n";
  }
  if (wrongProposals.length > 0) {
    text += "- WRONG PROPOSALS: " + wrongProposals.join(", ") + " are NOT in the correct answer.\n";
  }
  if (wrongNegations.length > 0) {
    text += "- WRONG REJECTION: The student REJECTS " + wrongNegations.join(", ") + ", but " + wrongNegations.join(", ") + " IS/ARE in the correct answer.\n";
    text += "  → Do NOT agree that " + wrongNegations.join(", ") + " should be excluded. The student is WRONG about this.\n";
  }
  if (correctNegations.length > 0) {
    text += "- CORRECT REJECTION: The student correctly rejects " + correctNegations.join(", ") + " (not in the correct answer).\n";
  }
  if (missed.length > 0) {
    text += "- MISSING: The student has not mentioned " + missed.join(", ") + " which ARE in the correct answer.\n";
  }

  text += "CRITICAL: Evaluate EACH element independently. ";
  text += "When the student says an element 'does not contribute/apply/matter' but it IS in the correct answer, you MUST NOT agree. ";
  text += "Guide them to reconsider with a Socratic question about CONCEPTS, not about the element directly.\n\n";
  return text;
}

// Format classification hint for the LLM
// lang parameter enables intermediate feedback phrases in the correct language
function formatClassificationHint(classification, correctAnswer, lang) {
  lang = lang || "es";

  var hints = {
    dont_know: "The student does not know where to start. Ask ONE question about a fundamental concept (e.g., 'What conditions does a component need for current to flow through it?'). Do NOT mention specific elements.",
    single_word: "The student gave an answer without reasoning. Ask them to explain WHY they think that. Do not move forward until they reason.",
    wrong_answer: "The student gave an incorrect answer. Ask them to explain their reasoning. If you detect an alternative conception (AC), focus on challenging THAT concept with a Socratic question. Do NOT mention specific elements or reveal states.",
    correct_no_reasoning: "The student got the right answer but has not explained why. Ask them to justify their answer using concepts. Do NOT accept the answer as correct until they reason. Do NOT use phrases like 'Perfect', 'Correct', 'Very good', 'Exactly'. Indicate they are on the right track but you need them to explain their reasoning.",
    correct_wrong_reasoning: "The student got the right answer but uses a wrong concept. Focus on correcting the alternative conception with a Socratic question about the concept, NOT about specific elements. Do NOT use phrases like 'Perfect', 'Correct', 'Very good', 'Exactly'. Acknowledge they are on the right track but challenge the wrong reasoning.",
    correct_good_reasoning: "The student got the right answer with good reasoning. Confirm briefly and finish.",
    wrong_concept: "The student shows an alternative conception. Focus ONLY on challenging that wrong concept with a Socratic question. Do NOT guide towards specific elements.",
    partial_correct: "The student is partially correct — their reasoning about excluded elements is right, but they haven't given the complete answer yet. Acknowledge their correct reasoning briefly and guide them to think about which elements DO contribute, using a Socratic question. Do NOT reveal specific elements or say 'Correct' / 'Perfect'.",
  };

  var hint = hints[classification.type];
  if (hint == null) {
    return "";
  }

  // When the student doesn't mention specific elements, they are likely responding
  // to a Socratic sub-question (not giving the final answer). In this case, soften
  // aggressive hints so the LLM can evaluate the response using conversation history.
  var noElementsMentioned = classification.resistances.length === 0;
  var aggressiveTypes = ["wrong_concept", "wrong_answer", "single_word"];
  var isAggressiveType = aggressiveTypes.indexOf(classification.type) >= 0;

  if (noElementsMentioned && isAggressiveType) {
    hint = "The student is responding to your previous Socratic question without mentioning specific elements. "
      + "Evaluate their response IN CONTEXT of your last question and the conversation history. "
      + "If their response correctly addresses your question, acknowledge it briefly and advance to the next reasoning step. "
      + "Do NOT re-ask the same question. Do NOT assume the student is wrong just because they didn't name specific elements.";
  }

  var text = "[RESPONSE MODE]\n";
  text += "The student's message has been classified as: " + classification.type + ".\n";
  text += hint + "\n";

  if (classification.concepts.length > 0) {
    text += "The student mentions: " + classification.concepts.join(", ") + ".\n";
  }

  // Inject intermediate feedback phrases for wrong/partial classifications (hybrid approach)
  // Skip injecting "wrong" starter phrases when hints were softened (no elements mentioned)
  if ((classification.type === "wrong_answer" || classification.type === "wrong_concept") && !(noElementsMentioned && isAggressiveType)) {
    var wrongPhrases = getIntermediateFeedback("wrong", lang);
    if (wrongPhrases.length > 0) {
      text += "\nSTART your response with one of these phrases (choose the most appropriate):\n";
      for (var i = 0; i < wrongPhrases.length; i++) {
        text += '- "' + wrongPhrases[i] + '"\n';
      }
      text += "NEVER start with 'Perfecto', 'Correcto', 'Interesante', 'Muy bien' or similar positive confirmation.\n";
    }
  }

  if (classification.type === "partial_correct" || classification.type === "correct_no_reasoning" || classification.type === "correct_wrong_reasoning") {
    var partialPhrases = getIntermediateFeedback("partial", lang);
    if (partialPhrases.length > 0) {
      text += "\nSTART your response with one of these phrases (choose the most appropriate):\n";
      for (var i = 0; i < partialPhrases.length; i++) {
        text += '- "' + partialPhrases[i] + '"\n';
      }
      text += "Do NOT say 'Perfecto' or 'Correcto' until reasoning is validated.\n";
    }
  }

  text += "\nFollow the reference examples below to guide your response style.\n\n";

  // Add per-element analysis when the student mentions specific elements (with negation awareness)
  if ((classification.resistances.length > 0 || (classification.negated && classification.negated.length > 0)) && correctAnswer != null) {
    text += analyzeStudentElements(classification, correctAnswer);
  }

  return text;
}

// Load the student's past AC errors via the Resultado repository (Pg-backed).
async function loadStudentHistory(userId) {
  if (userId == null) return "";
  if (!container._initialized || !container.resultadoRepo) return "";

  try {
    const resultados = await container.resultadoRepo.findByUserId(userId);

    // Count error tags across all exercises
    const errorCounts = {};
    for (const r of resultados) {
      for (const err of r.errores || []) {
        const tag = err?.etiqueta;
        if (tag) errorCounts[tag] = (errorCounts[tag] || 0) + 1;
      }
    }

    const tags = Object.keys(errorCounts);
    if (tags.length === 0) return "";

    let text = "[STUDENT HISTORY]\n";
    text += "This student has previously shown these misconceptions:\n";
    for (const tag of tags) {
      text += "- " + tag + " (" + errorCounts[tag] + " times)\n";
    }
    text += "Pay special attention to these recurring errors.\n\n";
    return text;
  } catch (err) {
    console.error("Error loading student history:", err.message);
    return "";
  }
}

// CRAG: extract key entities from the user message for query reformulation
// Uses multi-language concept keywords and normalizes to Spanish for dataset retrieval
function extractKeyEntities(userMessage) {
  const resistances = extractResistances(userMessage);
  const lower = userMessage.toLowerCase();

  // Collect important terms: resistances + concept keywords found (all languages)
  const parts = [];
  for (let i = 0; i < resistances.length; i++) {
    parts.push(resistances[i]);
  }

  const allConcepts = getAllPatterns(conceptDict);
  for (let i = 0; i < allConcepts.length; i++) {
    if (lower.includes(allConcepts[i])) {
      parts.push(allConcepts[i]);
    }
  }

  if (parts.length === 0) {
    return normalizeToSpanish(userMessage);
  }
  return normalizeToSpanish(parts.join(" "));
}

// Main pipeline: classifies, retrieves, evaluates quality, and builds augmentation
// evaluableElements: optional array of all possible answer elements for generic extraction
// lang: language for intermediate feedback phrases
async function runPipeline(userMessage, exerciseNum, correctAnswer, userId, evaluableElements, lang) {
  // Step A: Classify the query (now with generic element extraction + negation detection)
  emitEvent("classify_start", "start", { userMessage: userMessage, correctAnswer: correctAnswer, messageLength: userMessage.length });
  var classification = classifyQuery(userMessage, correctAnswer, evaluableElements);
  // Use PROPOSED elements (not negated) to determine if the student gave the correct answer
  var isCorrectAnswer = classification.proposed.length > 0 && classification.proposed.slice().sort().join(",") === correctAnswer.slice().sort().join(",");
  emitEvent("classify_end", "end", {
    type: classification.type,
    resistances: classification.resistances,
    proposed: classification.proposed,
    negated: classification.negated,
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
    mentionedElements: classification.resistances,  // all elements the student mentioned
    proposed: classification.proposed,               // elements proposed (not negated)
    negated: classification.negated,                 // elements the student rejected
  };

  // Step B: Route to appropriate retrieval strategy
  if (classification.type === types.greeting) {
    emitEvent("routing_decision", "end", { classification: classification.type, decision: "no_rag", path: "greeting → no_rag" });
    return result;
  }

  if (classification.type === types.dontKnow) {
    emitEvent("routing_decision", "end", { classification: classification.type, decision: "scaffold", path: "dont_know → scaffold" });
    // Only fetch the most relevant KG concepts for scaffolding (limit to 3 to avoid context overflow)
    emitEvent("kg_search_start", "start", { concepts: ["serie", "paralelo", "cortocircuito"] });
    const kgResults = searchKG(["serie", "paralelo", "cortocircuito"]);
    const limited = kgResults.slice(0, 3);
    emitEvent("kg_search_end", "end", { resultCount: limited.length, entries: limited.map(function(e) { return { node1: e.node1, relation: e.relation, node2: e.node2, acName: e.acName || null, acDescription: e.acDescription || null, expertReasoning: e.expertReasoning || "", socraticQuestions: e.socraticQuestions || "" }; }) });
    result.augmentation = formatClassificationHint(classification, correctAnswer, lang) + formatKGContext(limited);
    result.decision = "scaffold";
    result.sources = limited;
    return result;
  }

  if (classification.type === types.singleWord) {
    emitEvent("routing_decision", "end", { classification: classification.type, decision: "demand_reasoning", path: "single_word → demand_reasoning" });
    result.augmentation = formatClassificationHint(classification, correctAnswer, lang);
    result.decision = "demand_reasoning";
    return result;
  }

  if (classification.type === types.wrongAnswer) {
    emitEvent("routing_decision", "end", { classification: classification.type, decision: "rag_examples", path: "wrong_answer → rag_examples" });
    emitEvent("hybrid_search_start", "start", { query: userMessage, exerciseNum: exerciseNum, topK: config.TOP_K_FINAL });
    let datasetResults = await hybridSearch(userMessage, exerciseNum);
    emitEvent("hybrid_search_end", "end", { resultCount: datasetResults.length, topScore: datasetResults.length > 0 ? Math.round(datasetResults[0].score * 10000) / 10000 : 0, results: datasetResults.map(function(r, i) { return { rank: i + 1, index: r.index, score: Math.round(r.score * 10000) / 10000, student: r.student || "", tutor: r.tutor || "" }; }) });

    // CRAG: if top score is too low, reformulate and retry
    if (datasetResults.length === 0 || datasetResults[0].score < config.MED_THRESHOLD) {
      const reformulated = extractKeyEntities(userMessage);
      emitEvent("crag_reformulate", "end", { originalQuery: userMessage, topScore: datasetResults.length > 0 ? Math.round(datasetResults[0].score * 10000) / 10000 : 0, threshold: config.MED_THRESHOLD, reformulatedQuery: reformulated, reason: "topScore < MED_THRESHOLD (" + config.MED_THRESHOLD + ")", extractedEntities: reformulated.split(" ") });
      emitEvent("hybrid_search_start", "start", { query: reformulated, exerciseNum: exerciseNum, topK: config.TOP_K_FINAL });
      datasetResults = await hybridSearch(reformulated, exerciseNum);
      emitEvent("hybrid_search_end", "end", { resultCount: datasetResults.length, topScore: datasetResults.length > 0 ? Math.round(datasetResults[0].score * 10000) / 10000 : 0, results: datasetResults.map(function(r, i) { return { rank: i + 1, index: r.index, score: Math.round(r.score * 10000) / 10000, student: r.student || "", tutor: r.tutor || "" }; }) });
    }

    // KG scaffolding: when the student is wrong but used no concept words, the
    // tutor still benefits from foundational concepts to anchor a Socratic hint
    // (current path, divisor de tensión, cortocircuito, interruptor abierto).
    const kgConcepts = classification.concepts && classification.concepts.length > 0
      ? classification.concepts
      : SCAFFOLD_CONCEPTS;
    emitEvent("kg_search_start", "start", { concepts: kgConcepts });
    const kgResults = searchKG(kgConcepts).slice(0, 3);
    emitEvent("kg_search_end", "end", { resultCount: kgResults.length, entries: kgResults.map(function(e) { return { node1: e.node1, relation: e.relation, node2: e.node2, acName: e.acName || null, acDescription: e.acDescription || null, expertReasoning: e.expertReasoning || "", socraticQuestions: e.socraticQuestions || "" }; }) });

    result.augmentation = formatClassificationHint(classification, correctAnswer, lang) + formatKGContext(kgResults) + formatExamples(datasetResults);
    result.decision = "rag_examples";
    result.sources = datasetResults.concat(kgResults);
    return result;
  }

  if (classification.type === types.correctNoReasoning) {
    emitEvent("routing_decision", "end", { classification: classification.type, decision: "demand_reasoning", path: "correct_no_reasoning → demand_reasoning" });
    emitEvent("hybrid_search_start", "start", { query: userMessage, exerciseNum: exerciseNum, topK: config.TOP_K_FINAL });
    const datasetResults = await hybridSearch(userMessage, exerciseNum);
    emitEvent("hybrid_search_end", "end", { resultCount: datasetResults.length, topScore: datasetResults.length > 0 ? Math.round(datasetResults[0].score * 10000) / 10000 : 0, results: datasetResults.map(function(r, i) { return { rank: i + 1, index: r.index, score: Math.round(r.score * 10000) / 10000, student: r.student || "", tutor: r.tutor || "" }; }) });
    result.augmentation = formatClassificationHint(classification, correctAnswer, lang) + formatExamples(datasetResults);
    result.decision = "demand_reasoning";
    result.sources = datasetResults;
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
    result.augmentation = formatClassificationHint(classification, correctAnswer, lang) + formatKGContext(kgResults) + formatExamples(datasetResults);
    result.decision = "correct_concept";
    result.sources = datasetResults.concat(kgResults);
    return result;
  }

  if (classification.type === types.correctGoodReasoning) {
    emitEvent("routing_decision", "end", { classification: classification.type, decision: "rag_examples", path: "correct_good_reasoning → rag_examples" });
    emitEvent("hybrid_search_start", "start", { query: userMessage, exerciseNum: exerciseNum, topK: config.TOP_K_FINAL });
    const datasetResults = await hybridSearch(userMessage, exerciseNum);
    emitEvent("hybrid_search_end", "end", { resultCount: datasetResults.length, topScore: datasetResults.length > 0 ? Math.round(datasetResults[0].score * 10000) / 10000 : 0, results: datasetResults.map(function(r, i) { return { rank: i + 1, index: r.index, score: Math.round(r.score * 10000) / 10000, student: r.student || "", tutor: r.tutor || "" }; }) });
    result.augmentation = formatClassificationHint(classification, correctAnswer, lang) + formatExamples(datasetResults);
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
    result.augmentation = formatClassificationHint(classification, correctAnswer, lang) + formatKGContext(kgResults) + formatExamples(datasetResults);
    result.decision = "concept_correction";
    result.sources = datasetResults.concat(kgResults);
    return result;
  }

  if (classification.type === types.partialCorrect) {
    emitEvent("routing_decision", "end", { classification: classification.type, decision: "rag_examples", path: "partial_correct → rag_examples" });
    emitEvent("hybrid_search_start", "start", { query: userMessage, exerciseNum: exerciseNum, topK: config.TOP_K_FINAL });
    var datasetResults = await hybridSearch(userMessage, exerciseNum);
    emitEvent("hybrid_search_end", "end", { resultCount: datasetResults.length, topScore: datasetResults.length > 0 ? Math.round(datasetResults[0].score * 10000) / 10000 : 0, results: datasetResults.map(function(r, i) { return { rank: i + 1, index: r.index, score: Math.round(r.score * 10000) / 10000, student: r.student || "", tutor: r.tutor || "" }; }) });

    // KG scaffolding: partial answers benefit from foundational concepts so the
    // tutor can ask "what about <concept>?" instead of pointing at a resistor.
    const kgConcepts = classification.concepts && classification.concepts.length > 0
      ? classification.concepts
      : SCAFFOLD_CONCEPTS;
    emitEvent("kg_search_start", "start", { concepts: kgConcepts });
    const kgResults = searchKG(kgConcepts).slice(0, 3);
    emitEvent("kg_search_end", "end", { resultCount: kgResults.length, entries: kgResults.map(function(e) { return { node1: e.node1, relation: e.relation, node2: e.node2, acName: e.acName || null, acDescription: e.acDescription || null, expertReasoning: e.expertReasoning || "", socraticQuestions: e.socraticQuestions || "" }; }) });

    result.augmentation = formatClassificationHint(classification, correctAnswer, lang) + formatKGContext(kgResults) + formatExamples(datasetResults);
    result.decision = "rag_examples";
    result.sources = datasetResults.concat(kgResults);
    return result;
  }

  return result;
}

// Full pipeline with student history appended
// evaluableElements: optional array of all possible answer elements
// lang: language for intermediate feedback phrases
async function runFullPipeline(userMessage, exerciseNum, correctAnswer, userId, evaluableElements, lang) {
  var result = await runPipeline(userMessage, exerciseNum, correctAnswer, userId, evaluableElements, lang);

  // If no RAG needed, skip
  if (result.decision === "no_rag") {
    return result;
  }

  // Load student's past errors and append
  emitEvent("student_history_start", "start", { userId: userId });
  var history = await loadStudentHistory(userId);
  emitEvent("student_history_end", "end", { hasHistory: history.length > 0, historyLength: history.length, historyPreview: history });
  if (history.length > 0) {
    result.augmentation += history;
  }

  // Append guardrail reminder
  result.augmentation += "[GUARDRAIL]\n";
  result.augmentation += "CRITICAL RULES FOR YOUR RESPONSE:\n";
  result.augmentation += "1. Do NOT reveal the correct answer or list the correct elements together.\n";
  result.augmentation += "2. Do NOT confirm incorrect answers ('Perfect', 'Correct', 'Interesting', 'Very good'). If the student is wrong, use nuanced language like 'Not quite', 'Let's reconsider', 'There are concepts to review'.\n";
  result.augmentation += "3. Do NOT name specific elements for the student to analyze ('What about R5?', 'Look at R3').\n";
  result.augmentation += "4. Do NOT reveal element states (short-circuited, open), switch positions, or internal connections.\n";
  result.augmentation += "5. Ask ONE Socratic question about a CONCEPT, not about a specific component.\n";
  result.augmentation += "6. If the student shows an AC (alternative conception), focus on challenging THAT concept.\n";
  result.augmentation += "7. If the student gets the right answer but without reasoning or with wrong reasoning, do NOT confirm as complete. Acknowledge progress but ask for justification or challenge the wrong concept.\n";
  result.augmentation += "8. If the student REJECTS an element that IS in the correct answer, do NOT agree. Guide them to reconsider.\n";
  result.augmentation += "9. NEVER repeat a question the student has already answered correctly. If they demonstrated understanding, move forward to the next step.\n";
  result.augmentation += "10. Evaluate the student considering the FULL conversation history, not just their last message. They may have justified their reasoning in previous messages.\n";

  emitEvent("augmentation_built", "end", { augmentationLength: result.augmentation.length, decision: result.decision, classification: result.classification, sourcesCount: result.sources.length, sections: ["hint", history.length > 0 ? "history" : null, result.sources.length > 0 ? "examples" : null, "guardrail_reminder"].filter(Boolean), augmentationPreview: result.augmentation });

  return result;
}

module.exports = { runFullPipeline };
