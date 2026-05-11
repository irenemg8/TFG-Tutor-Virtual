// Main agentic RAG pipeline: classifier -> retrieval -> CRAG -> augmentation

const config = require("../../../infrastructure/llm/config");
const { classifyQuery, extractResistances, types } = require("./queryClassifier");
const { hybridSearch } = require("../../../infrastructure/search/hybridSearch");
const { searchKG } = require("../../../infrastructure/search/knowledgeGraph");
const { emitEvent } = require("../../../infrastructure/events/ragEventBus");
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

  // Top-1 only and ONLY the student side as a tone reference. Including the
  // tutor response inside the prompt made qwen2.5 regurgitate it verbatim —
  // observed in production where multiple turns produced identical replies
  // copied from the dataset (e.g. "Razona tu respuesta, para ello piensa por
  // donde circula la corriente..."). The LLM has its own pedagogical rules
  // in the system prompt; the example is now just context, not a template.
  const limited = results.slice(0, 1);
  let text = "[STUDENT TONE REFERENCE — for context only, DO NOT copy phrases]\n";
  for (let i = 0; i < limited.length; i++) {
    text += 'A previous student in this exercise wrote: "' + limited[i].student + '"\n';
  }
  text += "Use this only to gauge the student's level. Write your OWN response in your own words.\n";
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

  // Top-2 max + truncated reasoning + skip socratic-questions verbatim.
  // The previous block dumped 3 entries × ~500 chars each into the prompt
  // every turn. Limited here to keep RAG augmentation under ~1500 chars.
  const REASONING_MAX = 220;
  const limited = kgResults.slice(0, 2);
  let text = "[DOMAIN KNOWLEDGE — internal reference, do not quote or copy verbatim]\n";
  for (let i = 0; i < limited.length; i++) {
    const entry = limited[i];
    text += '· ' + entry.node1 + ' ' + entry.relation + ' ' + entry.node2 + '\n';
    if (entry.expertReasoning) {
      const r = entry.expertReasoning.length > REASONING_MAX
        ? entry.expertReasoning.slice(0, REASONING_MAX) + "…"
        : entry.expertReasoning;
      text += '  reasoning: ' + r + '\n';
    }
    const acs = Array.isArray(entry.alternativeConceptions) && entry.alternativeConceptions.length > 0
      ? entry.alternativeConceptions
      : (entry.acName ? [{ acName: entry.acName }] : []);
    for (let a = 0; a < acs.length && a < 1; a++) {
      if (acs[a].acName) text += '  AC: ' + acs[a].acName + '\n';
    }
    text += '\n';
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
    dont_know: "The student is stuck. Defer to the [STUDENT DOESN'T KNOW] block above for the exact response shape — do NOT add a generic concept question here.",
    closed_answer: "The student answered yes/no to a diagnostic question (e.g., '¿tienes dudas?'). Acknowledge briefly and either close gracefully or move to the next step. Do NOT escalate or demand reasoning for this turn.",
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
  var aggressiveTypes = ["wrong_concept", "wrong_answer"];
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

  // Removed: el bloque de "intermediate feedback phrases" (lista de frases
  // candidatas tipo "Estás cerca", "Pero hay que pulir algunos conceptos")
  // hacía que qwen2.5 a veces repitiera la misma frase dos veces seguidas
  // ("Pero hay que pulir algunos conceptos. Pero hay que pulir algunos
  // conceptos.") y añadía 300-500 bytes al prompt. La regla "no confirmes
  // wrong como Perfecto" ya está en el system prompt y en el hint de cada
  // classification, así que el LLM elige la apertura sin repetición.
  text += "\nFollow the reference examples below to guide your response style.\n\n";

  // Add per-element analysis when the student mentions specific elements (with negation awareness)
  if ((classification.resistances.length > 0 || (classification.negated && classification.negated.length > 0)) && correctAnswer != null) {
    text += analyzeStudentElements(classification, correctAnswer);
  }

  return text;
}

// Load the student's past AC errors via the Resultado repository (Pg-backed).
// resultadoRepo is injected by the caller (retrievalAgent passes it through
// runFullPipeline options). Domain code no longer reaches into the container.
async function loadStudentHistory(userId, resultadoRepo) {
  if (userId == null) return "";
  if (!resultadoRepo) return "";

  try {
    const resultados = await resultadoRepo.findByUserId(userId);

    // Count error tags across all exercises
    const errorCounts = {};
    for (const r of resultados) {
      for (const err of r.errors || []) {
        const tag = err?.label;
        if (tag) errorCounts[tag] = (errorCounts[tag] || 0) + 1;
      }
    }

    const tags = Object.keys(errorCounts);
    if (tags.length === 0) return "";

    // Show only the top-3 most frequent ACs to keep the prompt compact and
    // weight the LLM towards what truly recurs. Long histories used to bury
    // strong signals among noise and inflated num_ctx unnecessarily.
    const topTags = tags
      .sort(function (a, b) { return errorCounts[b] - errorCounts[a]; })
      .slice(0, 3);

    let text = "[STUDENT HISTORY]\n";
    text += "This student has previously shown these recurring misconceptions:\n";
    for (const tag of topTags) {
      text += "- " + tag + " (" + errorCounts[tag] + " times)\n";
    }
    text += "Pay special attention to these.\n\n";
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
// options: { signal?: AbortSignal } — when provided, slow embedding/Chroma
//          calls inside hybridSearch can be cancelled mid-flight by the
//          enclosing budget watchdog set up in runFullPipeline.
async function runPipeline(userMessage, exerciseNum, correctAnswer, userId, evaluableElements, lang, options) {
  options = options || {};
  const signal = options.signal || null;
  const hsOpts = signal ? { signal: signal } : undefined;
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

  if (classification.type === types.closedAnswer) {
    // Yes/no replies to diagnostic questions: acknowledge & advance.
    emitEvent("routing_decision", "end", { classification: classification.type, decision: "acknowledge_diagnostic", path: "closed_answer → acknowledge_diagnostic" });
    result.augmentation = formatClassificationHint(classification, correctAnswer, lang);
    result.decision = "acknowledge_diagnostic";
    return result;
  }

  if (classification.type === types.wrongAnswer) {
    emitEvent("routing_decision", "end", { classification: classification.type, decision: "rag_examples", path: "wrong_answer → rag_examples" });
    emitEvent("hybrid_search_start", "start", { query: userMessage, exerciseNum: exerciseNum, topK: config.TOP_K_FINAL });
    let datasetResults = await hybridSearch(userMessage, exerciseNum, config.TOP_K_FINAL, hsOpts);
    emitEvent("hybrid_search_end", "end", { resultCount: datasetResults.length, topScore: datasetResults.length > 0 ? Math.round(datasetResults[0].score * 10000) / 10000 : 0, results: datasetResults.map(function(r, i) { return { rank: i + 1, index: r.index, score: Math.round(r.score * 10000) / 10000, student: r.student || "", tutor: r.tutor || "" }; }) });

    // CRAG: if top score is too low, reformulate and retry
    if (datasetResults.length === 0 || datasetResults[0].score < config.MED_THRESHOLD) {
      const reformulated = extractKeyEntities(userMessage);
      emitEvent("crag_reformulate", "end", { originalQuery: userMessage, topScore: datasetResults.length > 0 ? Math.round(datasetResults[0].score * 10000) / 10000 : 0, threshold: config.MED_THRESHOLD, reformulatedQuery: reformulated, reason: "topScore < MED_THRESHOLD (" + config.MED_THRESHOLD + ")", extractedEntities: reformulated.split(" ") });
      emitEvent("hybrid_search_start", "start", { query: reformulated, exerciseNum: exerciseNum, topK: config.TOP_K_FINAL });
      datasetResults = await hybridSearch(reformulated, exerciseNum, config.TOP_K_FINAL, hsOpts);
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
    const datasetResults = await hybridSearch(userMessage, exerciseNum, config.TOP_K_FINAL, hsOpts);
    emitEvent("hybrid_search_end", "end", { resultCount: datasetResults.length, topScore: datasetResults.length > 0 ? Math.round(datasetResults[0].score * 10000) / 10000 : 0, results: datasetResults.map(function(r, i) { return { rank: i + 1, index: r.index, score: Math.round(r.score * 10000) / 10000, student: r.student || "", tutor: r.tutor || "" }; }) });
    result.augmentation = formatClassificationHint(classification, correctAnswer, lang) + formatExamples(datasetResults);
    result.decision = "demand_reasoning";
    result.sources = datasetResults;
    return result;
  }

  if (classification.type === types.correctWrongReasoning) {
    emitEvent("routing_decision", "end", { classification: classification.type, decision: "correct_concept", path: "correct_wrong_reasoning → correct_concept" });
    emitEvent("hybrid_search_start", "start", { query: userMessage, exerciseNum: exerciseNum, topK: config.TOP_K_FINAL });
    const datasetResults = await hybridSearch(userMessage, exerciseNum, config.TOP_K_FINAL, hsOpts);
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
    const datasetResults = await hybridSearch(userMessage, exerciseNum, config.TOP_K_FINAL, hsOpts);
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
    const datasetResults = await hybridSearch(userMessage, exerciseNum, config.TOP_K_FINAL, hsOpts);
    emitEvent("hybrid_search_end", "end", { resultCount: datasetResults.length, topScore: datasetResults.length > 0 ? Math.round(datasetResults[0].score * 10000) / 10000 : 0, results: datasetResults.map(function(r, i) { return { rank: i + 1, index: r.index, score: Math.round(r.score * 10000) / 10000, student: r.student || "", tutor: r.tutor || "" }; }) });
    result.augmentation = formatClassificationHint(classification, correctAnswer, lang) + formatKGContext(kgResults) + formatExamples(datasetResults);
    result.decision = "concept_correction";
    result.sources = datasetResults.concat(kgResults);
    return result;
  }

  if (classification.type === types.partialCorrect) {
    emitEvent("routing_decision", "end", { classification: classification.type, decision: "rag_examples", path: "partial_correct → rag_examples" });
    emitEvent("hybrid_search_start", "start", { query: userMessage, exerciseNum: exerciseNum, topK: config.TOP_K_FINAL });
    var datasetResults = await hybridSearch(userMessage, exerciseNum, config.TOP_K_FINAL, hsOpts);
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
// options: {
//   budgetMs?: number,         — arms an AbortController that cancels
//                                in-flight Chroma/embedding calls when
//                                budgetMs * 0.95 elapses (NS-3).
//   resultadoRepo?: object     — injected so loadStudentHistory doesn't
//                                require('container') from the domain (NS-5).
// }
async function runFullPipeline(userMessage, exerciseNum, correctAnswer, userId, evaluableElements, lang, options) {
  options = options || {};
  const budgetMs = typeof options.budgetMs === "number" && options.budgetMs > 0 ? options.budgetMs : null;

  let controller = null;
  let abortTimer = null;
  let signal = null;
  if (budgetMs) {
    controller = new AbortController();
    signal = controller.signal;
    // 95% leaves a small slack so the surrounding orchestrator can still
    // emit "retrieval timed out" telemetry before its own outer budget
    // triggers and forces a hard fallback.
    abortTimer = setTimeout(() => {
      try { controller.abort(); } catch (_) {}
    }, Math.max(500, Math.floor(budgetMs * 0.95)));
  }

  let result;
  try {
    result = await runPipeline(
      userMessage, exerciseNum, correctAnswer, userId, evaluableElements, lang,
      signal ? { signal: signal } : undefined
    );
  } catch (err) {
    if (err && (err.name === "AbortError" || err.code === "ERR_CANCELED" || err.code === "ECONNABORTED" || err.message === "canceled")) {
      if (abortTimer) clearTimeout(abortTimer);
      emitEvent("rag_aborted", "end", { reason: "budget_exhausted", budgetMs: budgetMs });
      return {
        augmentation: "",
        decision: "no_rag",
        sources: [],
        classification: null,
        retrievalTimedOut: true,
      };
    }
    if (abortTimer) clearTimeout(abortTimer);
    throw err;
  }
  if (abortTimer) clearTimeout(abortTimer);

  // If no RAG needed, skip
  if (result.decision === "no_rag") {
    return result;
  }

  // Load student's past errors and append
  emitEvent("student_history_start", "start", { userId: userId });
  var history = await loadStudentHistory(userId, options.resultadoRepo);
  emitEvent("student_history_end", "end", { hasHistory: history.length > 0, historyLength: history.length, historyPreview: history });
  if (history.length > 0) {
    result.augmentation += history;
  }

  // NS-22: the 10-rule [GUARDRAIL] block was a verbatim duplicate of the
  // system prompt's RULES section (~1500 bytes per turn). The system block
  // already covers don't-reveal, don't-confirm-wrong, don't-name-elements,
  // ground-truth and history-aware evaluation. Removed here to keep the
  // user-message turn payload small and let Ollama prefill faster.

  emitEvent("augmentation_built", "end", { augmentationLength: result.augmentation.length, decision: result.decision, classification: result.classification, sourcesCount: result.sources.length, sections: ["hint", history.length > 0 ? "history" : null, result.sources.length > 0 ? "examples" : null].filter(Boolean), augmentationPreview: result.augmentation });

  return result;
}

module.exports = { runFullPipeline };
