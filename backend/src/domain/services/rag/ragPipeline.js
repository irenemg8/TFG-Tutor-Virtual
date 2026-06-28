/*------------------------------------------------------------------------------
            _________________________________________________________
            |                     RAG PIPELINE                      |
            |  Main agentic RAG pipeline: classify -> retrieve ->     |
            |  CRAG -> augment. Builds the prompt augmentation the    |
            |  tutor LLM consumes, routing each classification to its  |
            |  retrieval strategy. Infrastructure is injected.       |
        ____|________________                                       |
   [Obj] -> | formatExamples()             | -> Txt                 |
            ---------------------------------                       |
   [Obj] -> | formatKGContext()            | -> Txt                 |
            ---------------------------------                       |
   Obj, [Txt] -> | analyzeStudentElements()  | -> Txt              |
                 ------------------------------                     |
   Obj, [Txt], Txt -> | formatClassificationHint() | -> Txt        |
                      -------------------------------               |
   Txt, Obj -> | loadStudentHistory()      | -> Promise<Txt>        |
               ----------------------------                         |
   Txt -> | extractKeyEntities()           | -> Txt                 |
          ---------------------------------                         |
   ... -> | runPipeline()                  | -> Promise<Obj>        |
          ---------------------------------                         |
   ... -> | runFullPipeline()              | -> Promise<Obj>        |
          ---------------------------------                         |
   Obj -> | createRagPipeline()            | -> Obj                 |
          ---------------------------------                         |
            |_______________________________________________________|
------------------------------------------------------------------------------*/

const { classifyQuery, extractResistances, types } = require("./queryClassifier");
const { getAllPatterns, conceptKeywords: conceptDict, normalizeToSpanish } = require("../languageManager");

/* Infrastructure deps injected by createRagPipeline() at startup. Domain code
   never require()s infrastructure directly. */
let hybridSearch, searchKG, emitEvent, config;

/* Foundational KG concepts used to scaffold hints when the student is
   wrong/partial but used no concept keyword. */
const SCAFFOLD_CONCEPTS = [
  "serie", "paralelo", "cortocircuito", "circuito abierto",
  "divisor de tensión", "interruptor abierto",
];

/*
   [Obj] -> ____|__________________
           | formatExamples() | -> Txt
            ------------------
      Formats the top dataset example (student side only) as a tone reference
      for the LLM. Returns "" when there are no results.
*/
function formatExamples(results) {
  if (results.length === 0) {
    return "";
  }

  const limited = results.slice(0, 1);
  let text = "[STUDENT TONE REFERENCE — for context only, DO NOT copy phrases]\n";
  for (let i = 0; i < limited.length; i++) {
    text += 'A previous student in this exercise wrote: "' + limited[i].student + '"\n';
  }
  text += "Use this only to gauge the student's level. Write your OWN response in your own words.\n";
  return text;
}

/*
   [Obj] -> ____|___________________
           | formatKGContext() | -> Txt
            -------------------
      Formats up to two knowledge-graph entries (truncated reasoning, no
      verbatim Socratic questions) as internal domain context, kept compact to
      bound the augmentation size. Returns "" when there are no results.
*/
function formatKGContext(kgResults) {
  if (kgResults.length === 0) {
    return "";
  }

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

/*
   Obj, [Txt] -> ____|________________________
                | analyzeStudentElements() | -> Txt
                 ---------------------------
      Builds the internal [PER-ELEMENT ANALYSIS] block: which mentioned
      elements are proposed/negated and correct/wrong, plus already-established
      and missing ones. Generic over any evaluable element type.
*/
function analyzeStudentElements(classification, correctAnswer) {
  var proposed = classification.proposed || [];
  var negated = classification.negated || [];

  if (proposed.length === 0 && negated.length === 0) {
    return "";
  }

  function _norm(x) { return typeof x === "string" ? x.toUpperCase().trim() : x; }

  var correctSet = {};
  for (var i = 0; i < correctAnswer.length; i++) {
    correctSet[_norm(correctAnswer[i])] = true;
  }

  var correctProposals = [];
  var wrongProposals = [];
  for (var i = 0; i < proposed.length; i++) {
    if (correctSet[_norm(proposed[i])]) {
      correctProposals.push(proposed[i]);
    } else {
      wrongProposals.push(proposed[i]);
    }
  }

  var correctNegations = [];
  var wrongNegations = [];
  for (var i = 0; i < negated.length; i++) {
    if (correctSet[_norm(negated[i])]) {
      wrongNegations.push(negated[i]);
    } else {
      correctNegations.push(negated[i]);
    }
  }

  var alreadyNamed = {};
  var cumNamed = classification.cumulativeNamedCorrect || [];
  for (var i = 0; i < cumNamed.length; i++) alreadyNamed[_norm(cumNamed[i])] = true;
  var allMentioned = {};
  for (var i = 0; i < proposed.length; i++) allMentioned[_norm(proposed[i])] = true;
  for (var i = 0; i < negated.length; i++) allMentioned[_norm(negated[i])] = true;
  var missed = [];
  var established = [];
  for (var i = 0; i < correctAnswer.length; i++) {
    if (allMentioned[_norm(correctAnswer[i])]) continue;
    if (alreadyNamed[_norm(correctAnswer[i])]) established.push(correctAnswer[i]);
    else missed.push(correctAnswer[i]);
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
  if (established.length > 0) {
    text += "- ALREADY ESTABLISHED in earlier turns: " + established.join(", ") +
      " — the student named these before. Do NOT treat them as missing and do NOT re-ask for them.\n";
  }
  if (missed.length > 0) {
    text += "- MISSING: The student has not mentioned " + missed.join(", ") + " which ARE in the correct answer.\n";
  }

  text += "CRITICAL: Evaluate EACH element independently. ";
  text += "When the student says an element 'does not contribute/apply/matter' but it IS in the correct answer, you MUST NOT agree. ";
  text += "Guide them to reconsider with a Socratic question about CONCEPTS, not about the element directly.\n\n";
  return text;
}

/*
   Obj, [Txt], Txt -> ____|___________________________
                     | formatClassificationHint() | -> Txt
                      -----------------------------
      Builds the [RESPONSE MODE] block from the classification type, softening
      aggressive hints when no element was named, and appends the per-element
      analysis. lang defaults to "es".
*/
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

  text += "\nFollow the reference examples below to guide your response style.\n\n";

  if ((classification.resistances.length > 0 || (classification.negated && classification.negated.length > 0)) && correctAnswer != null) {
    text += analyzeStudentElements(classification, correctAnswer);
  }

  return text;
}

/*
   Txt, Obj -> ____|______________________
              | loadStudentHistory() | -> Promise<Txt>
               ------------------------
      Loads the student's recurring AC errors via the injected Resultado
      repository and formats the top-3 as a [STUDENT HISTORY] block. Returns ""
      when there is no user, repo or history.
*/
async function loadStudentHistory(userId, resultadoRepo) {
  if (userId == null) return "";
  if (!resultadoRepo) return "";

  try {
    const resultados = await resultadoRepo.findByUserId(userId);

    const errorCounts = {};
    for (const r of resultados) {
      for (const err of r.errors || []) {
        const tag = err?.label;
        if (tag) errorCounts[tag] = (errorCounts[tag] || 0) + 1;
      }
    }

    const tags = Object.keys(errorCounts);
    if (tags.length === 0) return "";

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

/*
   Txt -> ____|____________________
         | extractKeyEntities() | -> Txt
          ----------------------
      CRAG query reformulation: collects resistances plus matched concept
      keywords (all languages) and normalizes them to Spanish for dataset
      retrieval. Falls back to normalizing the whole message.
*/
function extractKeyEntities(userMessage) {
  const resistances = extractResistances(userMessage);
  const lower = userMessage.toLowerCase();

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

/*
   Txt, Z, [Txt], Txt, [Txt], Txt, Obj -> ____|_______________
                                          | runPipeline() | -> Promise<Obj>
                                           ---------------
      Core pipeline: classifies the message, routes the classification to its
      retrieval strategy (greeting/dont_know/closed/wrong/correct/partial) and
      builds the augmentation. evaluableElements and lang are optional; options
      may carry an AbortSignal to cancel slow retrieval mid-flight.
*/
async function runPipeline(userMessage, exerciseNum, correctAnswer, userId, evaluableElements, lang, options) {
  options = options || {};
  const signal = options.signal || null;
  const hsOpts = signal ? { signal: signal } : undefined;
  emitEvent("classify_start", "start", { userMessage: userMessage, correctAnswer: correctAnswer, messageLength: userMessage.length });
  var classification = classifyQuery(userMessage, correctAnswer, evaluableElements);
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
    mentionedElements: classification.resistances,
    proposed: classification.proposed,
    negated: classification.negated,
  };

  if (classification.type === types.greeting) {
    emitEvent("routing_decision", "end", { classification: classification.type, decision: "no_rag", path: "greeting → no_rag" });
    return result;
  }

  if (classification.type === types.dontKnow) {
    emitEvent("routing_decision", "end", { classification: classification.type, decision: "scaffold", path: "dont_know → scaffold" });
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

    if (datasetResults.length === 0 || datasetResults[0].score < config.MED_THRESHOLD) {
      const reformulated = extractKeyEntities(userMessage);
      emitEvent("crag_reformulate", "end", { originalQuery: userMessage, topScore: datasetResults.length > 0 ? Math.round(datasetResults[0].score * 10000) / 10000 : 0, threshold: config.MED_THRESHOLD, reformulatedQuery: reformulated, reason: "topScore < MED_THRESHOLD (" + config.MED_THRESHOLD + ")", extractedEntities: reformulated.split(" ") });
      emitEvent("hybrid_search_start", "start", { query: reformulated, exerciseNum: exerciseNum, topK: config.TOP_K_FINAL });
      datasetResults = await hybridSearch(reformulated, exerciseNum, config.TOP_K_FINAL, hsOpts);
      emitEvent("hybrid_search_end", "end", { resultCount: datasetResults.length, topScore: datasetResults.length > 0 ? Math.round(datasetResults[0].score * 10000) / 10000 : 0, results: datasetResults.map(function(r, i) { return { rank: i + 1, index: r.index, score: Math.round(r.score * 10000) / 10000, student: r.student || "", tutor: r.tutor || "" }; }) });
    }

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

/*
   Txt, Z, [Txt], Txt, [Txt], Txt, Obj -> ____|___________________
                                          | runFullPipeline() | -> Promise<Obj>
                                           -------------------
      Wraps runPipeline with a budget watchdog (options.budgetMs arms an
      AbortController) and appends the student history block. Returns a
      no-rag/timed-out result on abort. options.resultadoRepo is injected.
*/
async function runFullPipeline(userMessage, exerciseNum, correctAnswer, userId, evaluableElements, lang, options) {
  options = options || {};
  const budgetMs = typeof options.budgetMs === "number" && options.budgetMs > 0 ? options.budgetMs : null;

  let controller = null;
  let abortTimer = null;
  let signal = null;
  if (budgetMs) {
    controller = new AbortController();
    signal = controller.signal;
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

  if (result.decision === "no_rag") {
    return result;
  }

  emitEvent("student_history_start", "start", { userId: userId });
  var history = await loadStudentHistory(userId, options.resultadoRepo);
  emitEvent("student_history_end", "end", { hasHistory: history.length > 0, historyLength: history.length, historyPreview: history });
  if (history.length > 0) {
    result.augmentation += history;
  }

  emitEvent("augmentation_built", "end", { augmentationLength: result.augmentation.length, decision: result.decision, classification: result.classification, sourcesCount: result.sources.length, sections: ["hint", history.length > 0 ? "history" : null, result.sources.length > 0 ? "examples" : null].filter(Boolean), augmentationPreview: result.augmentation });

  return result;
}

/*
   Obj -> ____|____________________
         | createRagPipeline() | -> Obj
          ---------------------
      Factory that injects the infrastructure dependencies (hybridSearch,
      searchKG, emitEvent, config) once at startup and returns
      { runFullPipeline } for the agent registry.
*/
function createRagPipeline(deps) {
  hybridSearch = deps.hybridSearch;
  searchKG    = deps.searchKG;
  emitEvent   = deps.emitEvent;
  config      = deps.config;
  return { runFullPipeline };
}

module.exports = { createRagPipeline };
module.exports.analyzeStudentElements = analyzeStudentElements;
