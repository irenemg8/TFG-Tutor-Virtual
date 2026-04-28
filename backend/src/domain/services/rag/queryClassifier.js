// Rule-based query classifier for student messages (no LLM needed)
// Generic: works with any evaluable elements (resistances, concepts, definitions, etc.)

const {
  getAllPatterns,
  greetingPatterns: greetingDict,
  dontKnowPatterns: dontKnowDict,
  reasoningPatterns: reasoningDict,
  conceptKeywords: conceptDict,
} = require("../languageManager");

// Normalize accented characters for accent-insensitive matching
// Students often skip accents when typing (e.g. "tension" instead of "tensión")
function stripAccents(str) {
  return str.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

// Classification types
const types = {
  greeting: "greeting",                                 // Hola, ¿qué tal?
  dontKnow: "dont_know",                                // No lo sé
  singleWord: "single_word",                            // Todas
  wrongAnswer: "wrong_answer",                          // R5
  correctNoReasoning: "correct_no_reasoning",           // R1, R2 y R4
  correctWrongReasoning: "correct_wrong_reasoning",     // R1, R2 y R4 porque forman un divisor de tensión
  correctGoodReasoning: "correct_good_reasoning",       // R1, R2 y R4 porque R3 está en abierto y R5 cortocircuitada, no pasando corriente por ellos
  wrongConcept: "wrong_concept",                        // R1 y R2 dado que forman un divisor de tensión
  partialCorrect: "partial_correct",                    // "no pasa por R3" (correct exclusion, incomplete answer)
};
// Note: in the correctWrongReasoning option, if the student gives the right resistances and uses a concept keyword, it will classify the answer as incorrect, so that the RAG will look for the knowledge graph and check if the concept was misunderstood or not.

// Patterns for detection (multi-language: Spanish, Valencian, English)
const greetingPatterns = getAllPatterns(greetingDict);
const dontKnowPatterns = getAllPatterns(dontKnowDict);
const reasoningPatterns = getAllPatterns(reasoningDict);

// Concept keywords that may indicate wrong reasoning if used incorrectly
const conceptKeywords = getAllPatterns(conceptDict);

// State-description concepts: factual circuit states, NOT alternative conceptions.
// When a student uses ONLY these terms (e.g. "porque está en cortocircuito y abierto"),
// they are describing real circuit states as justification, not applying a wrong concept.
var stateDescriptionConcepts = [
  // es
  "cortocircuito", "cortocircuitada", "cortocircuitado", "corto",
  "circuito abierto", "abierto", "abierta",
  "interruptor cerrado", "interruptor abierto",
  // val
  "curtcircuit", "curtcircuitada", "curtcircuitat", "curt",
  "circuit obert", "obert", "oberta",
  "interruptor tancat", "interruptor obert",
  // en
  "short circuit", "shorted", "short",
  "open circuit", "open",
  "switch closed", "switch open",
];

// Check if ALL found concepts are state descriptions (not ACs like "divisor de tensión")
function allConceptsAreStateDescriptions(concepts) {
  for (var i = 0; i < concepts.length; i++) {
    var lower = concepts[i].toLowerCase();
    var isState = false;
    for (var j = 0; j < stateDescriptionConcepts.length; j++) {
      if (lower === stateDescriptionConcepts[j]) {
        isState = true;
        break;
      }
    }
    if (!isState) return false;
  }
  return true;
}

// =====================
// Negation detection (multi-language)
// =====================

// Words that BEFORE an element indicate the student is rejecting it
const preNegationWords = [
  // es
  "no", "sin", "ni", "tampoco", "excepto", "salvo", "menos", "quitando", "descartando",
  // val
  "sense", "tampoc", "excepte", "llevat de", "menys",
  // en
  "not", "without", "nor", "neither", "except", "excluding",
];

// Multi-word pre-negation phrases checked with a wider window (30 chars)
// These are less prone to false positives than single words, so a bigger window is safe
const preNegationPhrases = [
  // es - flow negation before element
  "no pasa corriente por", "no circula corriente por", "no pasa por",
  "no circula por", "no fluye por", "no hay corriente en", "no hay corriente por",
  // val
  "no passa corrent per", "no circula corrent per", "no passa per",
  // en
  "no current flows through", "current doesn't flow through",
  "no current through", "doesn't flow through",
];

// Phrases that AFTER an element indicate the student is rejecting it
const postNegationPhrases = [
  // es - direct rejection
  "no contribuye", "no participa", "no afecta", "no influye", "no cuenta",
  "no interviene", "se elimina", "se descarta", "sobra", "no importa",
  "no tiene que ver", "es incorrecto", "es incorrecta", "está mal",
  "no es", "no forma parte", "no es relevante",
  // es - flow/current negation (implies element is excluded)
  "no circula", "no pasa corriente", "no fluye", "no hay corriente",
  "no tiene corriente", "no pasa", "no llega",
  // val - direct rejection
  "no contribueix", "no participa", "no afecta", "no influeix", "no compta",
  "s'elimina", "es descarta", "no té a veure", "és incorrecte",
  "no és", "no forma part", "no és rellevant",
  // val - flow negation
  "no circula", "no passa corrent", "no flueix", "no hi ha corrent",
  // en - direct rejection
  "doesn't contribute", "does not contribute", "doesn't affect", "does not affect",
  "is not relevant", "isn't part", "doesn't matter", "is wrong", "is incorrect",
  "should not", "shouldn't be", "is not", "isn't",
  // en - flow negation
  "no current flows", "current doesn't flow", "no current", "doesn't flow",
  // es - state description (implies element is excluded: "R3 está en abierto" = R3 doesn't contribute)
  "está en abierto", "en abierto", "en circuito abierto",
  "está cortocircuitada", "está cortocircuitado", "cortocircuitada", "cortocircuitado",
  "en cortocircuito", "en corto",
  // val - state description
  "està en obert", "en circuit obert", "curtcircuitada", "curtcircuitat", "en curtcircuit",
  // en - state description
  "is open", "is shorted", "is short-circuited", "in open circuit", "in short circuit",
];

// Check if there is a negation around a specific position in the message
// Windows are tight to avoid false positives on distant negations
function detectNegation(message, position, elementLength) {
  var lower = message.toLowerCase();
  var PRE_WINDOW = 15;
  var POST_WINDOW = 25;

  // Check pre-negation: look for negation words before the element
  var preStart = Math.max(0, position - PRE_WINDOW);
  var prefix = lower.substring(preStart, position);

  for (var i = 0; i < preNegationWords.length; i++) {
    var word = preNegationWords[i];
    var idx = prefix.lastIndexOf(word);
    if (idx >= 0) {
      // Ensure it's a word boundary (preceded by space/start, followed by space)
      var charBefore = idx > 0 ? prefix[idx - 1] : " ";
      var charAfter = idx + word.length < prefix.length ? prefix[idx + word.length] : " ";
      if (/[\s,;:(]/.test(charBefore) || idx === 0) {
        if (/[\s,;:)]/.test(charAfter) || idx + word.length === prefix.length) {
          return true;
        }
      }
    }
  }

  // Check pre-negation phrases with wider window (multi-word → less false positive risk)
  var PHRASE_PRE_WINDOW = 30;
  var phrasePreStart = Math.max(0, position - PHRASE_PRE_WINDOW);
  var phrasePrefix = lower.substring(phrasePreStart, position);
  for (var i = 0; i < preNegationPhrases.length; i++) {
    if (phrasePrefix.includes(preNegationPhrases[i])) {
      return true;
    }
  }

  // Check post-negation: look for negation phrases after the element
  // Truncate at sentence boundary to avoid cross-sentence false positives
  // e.g. "R2 y R4. No pasa por R3" — the "no pasa" is about R3, not R2/R4
  var postStart = position + elementLength;
  var postEnd = Math.min(lower.length, postStart + POST_WINDOW);
  var suffix = lower.substring(postStart, postEnd);
  var sentBoundary = suffix.search(/[.!?]/);
  if (sentBoundary >= 0) {
    suffix = suffix.substring(0, sentBoundary);
  }

  for (var i = 0; i < postNegationPhrases.length; i++) {
    if (suffix.includes(postNegationPhrases[i])) {
      return true;
    }
  }

  return false;
}

// =====================
// Generic element extraction
// =====================

// Extract mentioned elements from a message, given a list of evaluable elements.
// If evaluableElements is provided, searches for those. Otherwise, falls back to R\d+ regex.
// Returns array of { element: "R4", position: 5 }
function extractMentionedElements(message, evaluableElements) {
  var mentions = [];
  var seen = {};

  if (Array.isArray(evaluableElements) && evaluableElements.length > 0) {
    var lower = message.toLowerCase();
    for (var i = 0; i < evaluableElements.length; i++) {
      var elem = evaluableElements[i];
      var elemLower = elem.toLowerCase();
      var searchFrom = 0;

      while (searchFrom < lower.length) {
        var idx = lower.indexOf(elemLower, searchFrom);
        if (idx < 0) break;

        // Word boundary check: element should not be part of a larger word
        var charBefore = idx > 0 ? lower[idx - 1] : " ";
        var charAfter = idx + elemLower.length < lower.length ? lower[idx + elemLower.length] : " ";
        var validBefore = /[\s,;:(¿¡"'\-]/.test(charBefore) || idx === 0;
        var validAfter = /[\s,;:).?!"'\-]/.test(charAfter) || idx + elemLower.length === lower.length;

        if (validBefore && validAfter) {
          var normalized = elem.toUpperCase();
          if (!seen[normalized]) {
            seen[normalized] = true;
            mentions.push({ element: normalized, position: idx });
          }
        }
        searchFrom = idx + 1;
      }
    }
  } else {
    // Fallback: extract using R\d+ regex (backwards compatibility for circuits)
    var regex = /R\d+/gi;
    var match;
    while ((match = regex.exec(message)) !== null) {
      var normalized = match[0].toUpperCase();
      if (!seen[normalized]) {
        seen[normalized] = true;
        mentions.push({ element: normalized, position: match.index });
      }
    }
  }

  return mentions;
}

// Legacy function: extract resistance names using regex (kept for backward compatibility)
function extractResistances(message) {
  var matches = message.match(/R\d+/gi);
  if (matches == null) {
    return [];
  }
  var unique = [];
  var seen = {};
  for (var i = 0; i < matches.length; i++) {
    var r = matches[i].toUpperCase();
    if (seen[r] == null) {
      seen[r] = true;
      unique.push(r);
    }
  }
  return unique;
}

// Check if two arrays contain the same elements (order doesn't matter)
function sameSet(a, b) {
  if (a.length !== b.length) {
    return false;
  }
  var sorted1 = a.slice().sort();
  var sorted2 = b.slice().sort();
  for (var i = 0; i < sorted1.length; i++) {
    if (sorted1[i] !== sorted2[i]) {
      return false;
    }
  }
  return true;
}

// Check if the message contains reasoning keywords (accent-insensitive)
function hasReasoning(message) {
  var lower = stripAccents(message.toLowerCase());
  for (var i = 0; i < reasoningPatterns.length; i++) {
    if (lower.includes(stripAccents(reasoningPatterns[i]))) {
      return true;
    }
  }
  return false;
}

// Find which concept keywords appear in the message (accent-insensitive)
function findConcepts(message) {
  var lower = stripAccents(message.toLowerCase());
  var found = [];
  for (var i = 0; i < conceptKeywords.length; i++) {
    if (lower.includes(stripAccents(conceptKeywords[i]))) {
      found.push(conceptKeywords[i]);
    }
  }
  return found;
}

// Check if the message is a greeting (accent-insensitive)
function isGreeting(message) {
  var lower = stripAccents(message.toLowerCase().trim());
  for (var i = 0; i < greetingPatterns.length; i++) {
    if (lower.startsWith(stripAccents(greetingPatterns[i]))) {
      return true;
    }
  }
  return false;
}

// Check if the message expresses "I don't know" (accent-insensitive)
function isDontKnow(message) {
  var lower = stripAccents(message.toLowerCase());
  for (var i = 0; i < dontKnowPatterns.length; i++) {
    if (lower.includes(stripAccents(dontKnowPatterns[i]))) {
      return true;
    }
  }
  return false;
}

/*------------------------------------------------------
  Classify a student message based on:
    - correctAnswer: array of correct elements ["R1", "R2", "R4"]
    - evaluableElements: (optional) all possible answer elements ["R1","R2","R3","R4","R5"]
  Returns: { type, resistances, proposed, negated, hasReasoning, concepts }
--------------------------------------------------------*/
function classifyQuery(userMessage, correctAnswer, evaluableElements) {
  // Extract mentioned elements with positions (generic or regex fallback)
  var mentions = extractMentionedElements(userMessage, evaluableElements);

  // Separate proposed vs negated elements
  var proposed = [];
  var negated = [];
  for (var i = 0; i < mentions.length; i++) {
    if (detectNegation(userMessage, mentions[i].position, mentions[i].element.length)) {
      negated.push(mentions[i].element);
    } else {
      proposed.push(mentions[i].element);
    }
  }

  // All mentioned elements (for backward compatibility)
  var allMentioned = mentions.map(function (m) { return m.element; });

  var reasoning = hasReasoning(userMessage);
  var concepts = findConcepts(userMessage);

  // 1. Greeting — ONLY if message has no resistance mentions and is short.
  // This prevents "hola, ahora R1 R2" from being swallowed as a greeting and
  // routed to a fallback handler that ignores the actual answer.
  if (allMentioned.length === 0 && userMessage.trim().length <= 30 && isGreeting(userMessage)) {
    return { type: types.greeting, resistances: allMentioned, proposed: proposed, negated: negated, hasReasoning: reasoning, concepts: concepts };
  }

  // 2. Don't know
  if (isDontKnow(userMessage)) {
    return { type: types.dontKnow, resistances: allMentioned, proposed: proposed, negated: negated, hasReasoning: reasoning, concepts: concepts };
  }

  // 3. Single word / short answer without elements
  if (userMessage.trim().length < 15 && allMentioned.length === 0) {
    return { type: types.singleWord, resistances: allMentioned, proposed: proposed, negated: negated, hasReasoning: reasoning, concepts: concepts };
  }

  // 4. Check if PROPOSED elements match correct answer (ignoring negated ones)
  if (sameSet(proposed, correctAnswer)) {
    // Correct answer with concepts — check BEFORE reasoning, since concepts ARE implicit reasoning
    // (student referencing "serie", "paralelo", "divisor de tensión" = they're trying to reason)
    // If student correctly negates elements AND uses concept keywords, the concepts are likely correct
    // (e.g. "R1, R2 y R4 porque R3 está en abierto y R5 cortocircuitada" → correct usage)
    if (concepts.length > 0) {
      if (negated.length > 0) {
        var allNegCorrect = true;
        for (var i = 0; i < negated.length; i++) {
          for (var j = 0; j < correctAnswer.length; j++) {
            if (negated[i] === correctAnswer[j]) {
              allNegCorrect = false;
              break;
            }
          }
          if (!allNegCorrect) break;
        }
        if (allNegCorrect) {
          // Correct answer + correct negations + concepts = good reasoning
          return { type: types.correctGoodReasoning, resistances: allMentioned, proposed: proposed, negated: negated, hasReasoning: reasoning, concepts: concepts };
        }
      }
      // If concepts are purely state descriptions (cortocircuito, abierto, etc.)
      // AND student has reasoning connectors → correct reasoning about circuit states
      // e.g. "R1 R2 R4 porque el resto está en cortocircuito y abierto"
      if (reasoning && allConceptsAreStateDescriptions(concepts)) {
        return { type: types.correctGoodReasoning, resistances: allMentioned, proposed: proposed, negated: negated, hasReasoning: reasoning, concepts: concepts };
      }
      // Concepts without correct negations → potentially wrong reasoning
      return { type: types.correctWrongReasoning, resistances: allMentioned, proposed: proposed, negated: negated, hasReasoning: reasoning, concepts: concepts };
    }
    // Correct answer but no reasoning and no concepts
    if (!reasoning) {
      return { type: types.correctNoReasoning, resistances: allMentioned, proposed: proposed, negated: negated, hasReasoning: reasoning, concepts: concepts };
    }
    // Correct answer with good reasoning (no wrong concepts)
    return { type: types.correctGoodReasoning, resistances: allMentioned, proposed: proposed, negated: negated, hasReasoning: reasoning, concepts: concepts };
  }

  // 5. Partial correct: student correctly excludes elements and/or proposes only correct ones, but answer is incomplete
  //    e.g. "no pasa por R3" when R3 is NOT in the correct answer → correct exclusion
  //    e.g. "R1 y R2 pero no R3" → R1,R2 correct, R3 correctly excluded, but missing R4
  if (negated.length > 0 || proposed.length > 0) {
    var allNegationsCorrect = true;
    for (var i = 0; i < negated.length; i++) {
      for (var j = 0; j < correctAnswer.length; j++) {
        if (negated[i] === correctAnswer[j]) {
          allNegationsCorrect = false;
          break;
        }
      }
      if (!allNegationsCorrect) break;
    }

    var allProposalsCorrect = true;
    for (var i = 0; i < proposed.length; i++) {
      var inCorrect = false;
      for (var j = 0; j < correctAnswer.length; j++) {
        if (proposed[i] === correctAnswer[j]) {
          inCorrect = true;
          break;
        }
      }
      if (!inCorrect) {
        allProposalsCorrect = false;
        break;
      }
    }

    if (allNegationsCorrect && allProposalsCorrect) {
      // If student has correct negations, they're reasoning correctly even if they use concept keywords
      // Only require no concepts when there are no negations (can't verify concept usage)
      if (negated.length > 0 || concepts.length === 0) {
        return { type: types.partialCorrect, resistances: allMentioned, proposed: proposed, negated: negated, hasReasoning: reasoning, concepts: concepts };
      }
    }
  }

  // 6. Wrong elements with concept keywords -> wrong concept
  if (concepts.length > 0) {
    return { type: types.wrongConcept, resistances: allMentioned, proposed: proposed, negated: negated, hasReasoning: reasoning, concepts: concepts };
  }

  // 7. Wrong answer
  return { type: types.wrongAnswer, resistances: allMentioned, proposed: proposed, negated: negated, hasReasoning: reasoning, concepts: concepts };
}

module.exports = { classifyQuery, extractResistances, extractMentionedElements, types };
