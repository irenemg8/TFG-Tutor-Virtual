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
  closedAnswer: "closed_answer",                        // "Sí" / "No" replying to a closed-form tutor question
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
  // es - state description (implies element is excluded: "R3 está abierto" = R3 doesn't contribute)
  "está en abierto", "en abierto", "en circuito abierto",
  "está abierto", "está abierta", "están abiertos", "están abiertas",
  "está cortocircuitada", "está cortocircuitado", "cortocircuitada", "cortocircuitado",
  "en cortocircuito", "en corto", "está en corto", "está en cortocircuito",
  // val - state description
  "està en obert", "en circuit obert", "està obert", "està oberta",
  "curtcircuitada", "curtcircuitat", "en curtcircuit", "està curtcircuitada", "està curtcircuitat",
  // en - state description
  "is open", "is shorted", "is short-circuited", "in open circuit", "in short circuit",
];

// Length-preserving lowercase + accent fold. Students routinely drop accents
// ("esta abierto" instead of "está abierto"), so negation matching must be
// accent-insensitive. We CANNOT use the NFD-based stripAccents here because it
// changes the string length, and detectNegation indexes the message with
// positions computed (without accent folding) in extractMentionedElements —
// any length shift would misalign them. This 1:1 map keeps every char index.
var ACCENT_FOLD = {
  "á": "a", "à": "a", "ä": "a", "â": "a",
  "é": "e", "è": "e", "ë": "e", "ê": "e",
  "í": "i", "ì": "i", "ï": "i", "î": "i",
  "ó": "o", "ò": "o", "ö": "o", "ô": "o",
  "ú": "u", "ù": "u", "ü": "u", "û": "u",
};
function foldForMatch(str) {
  var lower = str.toLowerCase();
  var out = "";
  for (var i = 0; i < lower.length; i++) {
    var ch = lower[i];
    out += ACCENT_FOLD[ch] || ch;
  }
  return out;
}

// Accent-folded copies of the negation dictionaries, computed once. Both sides
// of the comparison (message + dictionary) must be folded, otherwise an
// accented dictionary entry like "está abierto" would never match a folded
// message substring "esta abierto".
var preNegationWordsF = preNegationWords.map(foldForMatch);
var preNegationPhrasesF = preNegationPhrases.map(foldForMatch);
var postNegationPhrasesF = postNegationPhrases.map(foldForMatch);

// Index of the last sentence terminator (.!?) in `s`, treating a RUN of dots
// (ellipsis "...") as hesitation rather than a sentence break. Returns -1 when
// there is no real terminator. Ellipses are blanked to spaces (same length) so
// the returned index still aligns with the original string.
function _lastSentenceCut(s) {
  var scan = s.replace(/\.{2,}/g, function (run) {
    return new Array(run.length + 1).join(" ");
  });
  return scan.search(/[.!?][^.!?]*$/);
}

// Check if there is a negation around a specific position in the message
// Windows are tight to avoid false positives on distant negations
function detectNegation(message, position, elementLength) {
  var lower = foldForMatch(message);
  var PRE_WINDOW = 15;
  var POST_WINDOW = 25;

  // Check pre-negation: look for negation words before the element
  var preStart = Math.max(0, position - PRE_WINDOW);
  var prefix = lower.substring(preStart, position);
  // H1-bleed guard (2026-06-10): truncate the pre-window at the last sentence
  // terminator so a "no" that closes the PREVIOUS sentence doesn't bleed into
  // this element ("R3 no influye. R1 si va" must NOT negate R1). The post-window
  // already truncates on .!?; this symmetrises the pre-window. Without it, the
  // H1 sticky-negation rule would lock the element negated permanently.
  // ADV2 (2026-06-10): a run of dots ("no... R3") is hesitation, NOT a sentence
  // break, so we blank out ellipses before locating the terminator (same length
  // so the slice index still aligns with the original prefix).
  var pSent = _lastSentenceCut(prefix);
  if (pSent >= 0) prefix = prefix.slice(pSent + 1);

  for (var i = 0; i < preNegationWordsF.length; i++) {
    var word = preNegationWordsF[i];
    var idx = prefix.lastIndexOf(word);
    if (idx >= 0) {
      // Ensure it's a word boundary (preceded by space/start, followed by space)
      var charBefore = idx > 0 ? prefix[idx - 1] : " ";
      var charAfter = idx + word.length < prefix.length ? prefix[idx + word.length] : " ";
      if (/[\s,;:(]/.test(charBefore) || idx === 0) {
        if (/[\s,;:)]/.test(charAfter) || idx + word.length === prefix.length) {
          // H5 clause-boundary guard: a comma/semicolon between the negation
          // word and the element means the negation closes the PREVIOUS clause
          // and must not bleed into this one. "R1 no, R2 sí" — the "no" rejects
          // R1; without this guard it would wrongly negate R2. (Conversely
          // "R1, no R2" has the comma BEFORE "no", so the guard doesn't fire
          // and R2 is correctly negated.)
          var between = prefix.substring(idx + word.length);
          if (/[,;]/.test(between)) continue;
          return true;
        }
      }
    }
  }

  // Check pre-negation phrases with wider window (multi-word → less false positive risk)
  var PHRASE_PRE_WINDOW = 30;
  var phrasePreStart = Math.max(0, position - PHRASE_PRE_WINDOW);
  var phrasePrefix = lower.substring(phrasePreStart, position);
  // Same sentence-boundary guard as the single-word window above (ellipsis-safe).
  var phSent = _lastSentenceCut(phrasePrefix);
  if (phSent >= 0) phrasePrefix = phrasePrefix.slice(phSent + 1);
  for (var i = 0; i < preNegationPhrasesF.length; i++) {
    if (phrasePrefix.includes(preNegationPhrasesF[i])) {
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
  // Truncate at the next element mention so that "R4 porque R3 está
  // abierto" does NOT mark R4 as negated — the "está abierto" belongs
  // to R3's own context, not R4's. Element pattern is generic
  // letter+digits (R3, C2, L1, ...).
  var nextElem = suffix.search(/[a-z][\d]+/i);
  if (nextElem >= 0) {
    suffix = suffix.substring(0, nextElem);
  }

  // H5: a trailing standalone "no" right after the element ("R1 no", "R3 no.")
  // is a direct rejection of THIS element. Bare "no" is too risky as a general
  // post phrase, but immediately after the element it is unambiguous. We only
  // strip leading WHITESPACE (not commas): "R1, no R2" keeps its comma, so the
  // "no" there is NOT read as trailing for R1 — it belongs to R2.
  var immediateAfter = suffix.replace(/^\s+/, "");
  if (/^no(?:[\s.,;:!?]|$)/.test(immediateAfter)) {
    return true;
  }

  for (var i = 0; i < postNegationPhrasesF.length; i++) {
    if (suffix.includes(postNegationPhrasesF[i])) {
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
// Returns array of { element: "R4", position: 5, positions: [5, 42] } — ONE entry
// per element (first-seen order), with `position` = first occurrence (kept for
// backward compatibility) and `positions` = ALL occurrences in ascending order.
//
// Why positions[]: previously we kept only the first occurrence, so negation
// attached to a LATER restatement was lost (e.g. "...corriente por R3, por lo
// que R3 no influye" — the "no influye" hangs off the SECOND R3, which used to
// be discarded). classifyQuery now evaluates negation across every occurrence.
function extractMentionedElements(message, evaluableElements) {
  var order = [];   // element names in first-seen order
  var posMap = {};  // normalized name -> [positions]

  function record(normalized, idx) {
    if (!posMap[normalized]) {
      posMap[normalized] = [];
      order.push(normalized);
    }
    posMap[normalized].push(idx);
  }

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
          record(elem.toUpperCase(), idx);
        }
        searchFrom = idx + 1;
      }
    }
  } else {
    // Fallback: extract using R\d+ regex (backwards compatibility for circuits)
    var regex = /R\d+/gi;
    var match;
    while ((match = regex.exec(message)) !== null) {
      record(match[0].toUpperCase(), match.index);
    }
  }

  var mentions = [];
  for (var k = 0; k < order.length; k++) {
    var name = order[k];
    var positions = posMap[name].slice().sort(function (a, b) { return a - b; });
    mentions.push({ element: name, position: positions[0], positions: positions });
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
  Closed-question detection (heuristic — multilingual)
  ----------------------------------------------------
  Returns { isClosed, isDiagnostic } for a tutor message. A closed question
  starts with "¿Es...?", "¿Está...?", "¿Tienes...?", "¿Puede...?", etc.,
  and expects a yes/no answer.
  isDiagnostic = the question is checking the student's state ("¿tienes
  dudas?", "¿quieres repasar?") rather than asking them to commit to a
  reasoning step. A yes/no answer to a diagnostic question is fully valid
  and should NOT trigger demand_reasoning.
--------------------------------------------------------*/
function detectClosedQuestion(lastAssistantText) {
  if (typeof lastAssistantText !== "string" || lastAssistantText.length === 0) {
    return { isClosed: false, isDiagnostic: false };
  }
  // Last interrogative sentence (with or without leading ¿).
  var matches = lastAssistantText.match(/[^.!?]*\?/g);
  if (!matches || matches.length === 0) return { isClosed: false, isDiagnostic: false };
  var last = matches[matches.length - 1].toLowerCase().trim();
  // The interrogative clause may carry a preamble before the real question
  // ("Vale, ¿tienes dudas?"). In Spanish the question starts at "¿", so slice
  // from the last "¿" to drop the lead-in — otherwise the closed-opener check
  // (anchored at index 0) misses the opener. For markerless (English)
  // questions there is no "¿" and this is a no-op.
  var qOpen = last.lastIndexOf("¿");
  if (qOpen >= 0) {
    last = last.slice(qOpen + 1).trim();
  }

  // Closed-form openers across es / val / en. The patterns must match the
  // BEGINNING of the last interrogative — open-ended interrogatives like
  // "¿qué...?" or "¿por qué...?" are intentionally excluded.
  var closedOpeners = [
    // es — yes/no openers
    "es ", "es la ", "es el ", "es un", "es una",
    "está ", "estan ", "están ", "estás ", "estoy",
    "tienes", "te has ", "te queda ", "tendrías", "te apetece",
    "puedes", "puede ", "podrías",
    "has ", "hay ", "hace falta", "necesitas", "necesitarías",
    "crees", "consideras", "sabes", "entiendes", "ves ",
    "sigues", "quieres", "quisieras", "deseas",
    // val
    "tens", "t'has ", "te queda", "saps", "pots", "vols", "vols saber",
    "està ", "estan ", "estàs", "creus",
    // en
    "is ", "are ", "do you", "did you", "have you", "has the", "have we",
    "can you", "could you", "would you", "should you",
    "is there", "are there", "do we",
  ];
  var isClosed = false;
  for (var i = 0; i < closedOpeners.length; i++) {
    if (last.indexOf(closedOpeners[i]) === 0) { isClosed = true; break; }
  }

  // Diagnostic markers — meta-questions about the student's state, not the
  // exercise itself. A yes/no here is a legitimate final answer.
  var diagnosticMarkers = [
    // es
    "duda", "dudas", "alguna duda", "te apetece", "quieres repasar",
    "te ha quedado", "te ha quedado claro", "te queda claro", "lo entiendes",
    "lo has entendido", "has entendido", "lo entendiste", "entendido",
    "necesitas ayuda", "quieres seguir", "estás seguro", "estás segura",
    "todo bien", "vamos bien", "te queda alguna", "alguna pregunta",
    // val
    "dubte", "dubtes", "vols repassar", "ho entens", "necessites ajuda",
    "ho has entès", "ho entengueres",
    // en
    "any doubts", "any questions", "do you understand", "are you sure",
    "want to review", "need help", "got it", "make sense",
  ];
  var isDiagnostic = false;
  if (isClosed) {
    for (var j = 0; j < diagnosticMarkers.length; j++) {
      if (last.indexOf(diagnosticMarkers[j]) >= 0) { isDiagnostic = true; break; }
    }
  }
  return { isClosed: isClosed, isDiagnostic: isDiagnostic };
}

// Yes/no detector — used in conjunction with detectClosedQuestion.
// We intentionally avoid `\b` because JavaScript's word boundary is
// ASCII-only and would fail to match after non-ASCII letters (e.g. the
// "í" in "sí"). Instead we require either end-of-string or one of the
// usual punctuation/whitespace separators after the keyword.
function isYesNoAnswer(message) {
  var trimmed = (message || "").trim().toLowerCase();
  if (trimmed.length === 0) return false;
  return /^(s[ií]|no|vale|ok|okay|sip|nop|claro|por supuesto|nope|yep|yes|yeah|yup|nah|sure|of course|exactly|exacto|exacte)(?:[\s.,!?¡¿]|$)/.test(trimmed);
}

// BUG-006 (2026-05-03): extrae el ÚLTIMO Rn que el tutor nombra dentro de
// la pregunta de cierre. Si la pregunta es "¿Crees que la resistencia R5
// influya en la diferencia de potencial?", devuelve "R5". Si la pregunta
// no nombra ningún Rn (o la pregunta del tutor es puramente conceptual),
// devuelve null. Sólo mira la ÚLTIMA frase interrogativa para no capturar
// elementos mencionados en la introducción de la respuesta del tutor.
function _extractElementFromQuestion(lastAssistantText, evaluableElements) {
  if (typeof lastAssistantText !== "string" || lastAssistantText.length === 0) return null;
  var matches = lastAssistantText.match(/[^.!?]*\?/g);
  if (!matches || matches.length === 0) return null;
  var lastQ = matches[matches.length - 1];
  // Acepta cualquier Rn (genérico, no restringido a evaluableElements)
  // pero si tenemos la lista evaluable la usamos para filtrar matches que
  // no estén en el set canónico (p. ej. R10 mencionado por error).
  var rns = lastQ.match(/\bR\d+\b/gi);
  if (!rns || rns.length === 0) return null;
  // Devuelve el ÚLTIMO Rn de la pregunta (el más cercano al "?"). Es el
  // sujeto pedagógico del enunciado en la mayoría de casos.
  var candidate = rns[rns.length - 1].toUpperCase();
  if (Array.isArray(evaluableElements) && evaluableElements.length > 0) {
    var upper = evaluableElements.map(function (e) { return String(e).toUpperCase(); });
    if (upper.indexOf(candidate) < 0) return null;
  }
  return candidate;
}

// =====================
// Quantifier / set expansion ("todas", "todas menos R3", "ninguna", "el resto")
// =====================

// Set-quantifier tokens (accent-folded, lowercase). Multi-word entries are the
// safest; bare plural forms are accepted but guarded against common idioms
// ("de todos modos", "del todo") via ALL_FALSE_CONTEXTS.
var ALL_TOKENS = [
  // es
  "todas las resistencias", "todas las resistencia", "todas ellas",
  "todos ellos", "todas", "todos",
  // val
  "totes les resistencies", "totes", "tots",
  // en
  "all of them", "all the resistances", "all resistances", "all",
];
var NONE_TOKENS = [
  // es
  "ninguna resistencia", "ninguna", "ninguno", "ningun", "ningunas", "ningunos",
  // val
  "cap resistencia", "cap",
  // en
  "none of them", "no resistances", "no resistance", "none",
];
var REST_TOKENS = [
  // es
  "el resto", "los demas", "las demas", "las restantes", "los restantes", "la resta",
  // en
  "the rest", "the others", "the remaining",
];
// Idiom guards: a bare ALL hit inside one of these is NOT a set quantifier.
var ALL_FALSE_CONTEXTS = ["de todos modos", "del todo", "todos modos", "todo el"];
// Idiom guards for NONE: "no tengo ninguna duda" must NOT be read as the set
// quantifier "ninguna" (which would wrongly negate every element). These are
// conversational uses of "ninguna/ningún/none" that talk about doubts,
// questions, ideas or problems — not about the circuit elements.
var NONE_FALSE_CONTEXTS = [
  // es
  "ninguna duda", "ninguna pregunta", "ninguna idea", "ningun problema",
  "ningun comentario", "ninguna gana", "ninguna otra",
  // val
  "cap dubte", "cap pregunta", "cap idea", "cap problema",
  // en
  "no doubt", "no question", "no idea", "no problem",
];

// Post-only negation check for a token (e.g. "el resto"). We deliberately do
// NOT look before the token: the relevant polarity for "el resto" sits AFTER
// it ("el resto no influye" vs "el resto sí"), and a preceding "no" almost
// always belongs to a previous clause about another element
// ("R3 no influye, el resto sí").
function tokenHasPostNegation(message, position, length) {
  var lower = foldForMatch(message);
  var POST_WINDOW = 25;
  var start = position + length;
  var suffix = lower.substring(start, Math.min(lower.length, start + POST_WINDOW));
  var sb = suffix.search(/[.!?]/);
  if (sb >= 0) suffix = suffix.substring(0, sb);
  var ne = suffix.search(/[a-z][\d]+/i);
  if (ne >= 0) suffix = suffix.substring(0, ne);
  for (var i = 0; i < postNegationPhrasesF.length; i++) {
    if (suffix.includes(postNegationPhrasesF[i])) return true;
  }
  return false;
}

// Find any token from `tokens` present in `folded` as a standalone word.
// Returns { index, length } of the first match, or null.
function findToken(folded, tokens) {
  for (var i = 0; i < tokens.length; i++) {
    var t = tokens[i];
    var from = 0;
    while (from <= folded.length) {
      var idx = folded.indexOf(t, from);
      if (idx < 0) break;
      var before = idx > 0 ? folded[idx - 1] : " ";
      var after = idx + t.length < folded.length ? folded[idx + t.length] : " ";
      var okBefore = /[\s,;:(¿¡"'\-]/.test(before) || idx === 0;
      var okAfter = /[\s,;:).?!"'\-]/.test(after) || idx + t.length === folded.length;
      if (okBefore && okAfter) return { index: idx, length: t.length };
      from = idx + 1;
    }
  }
  return null;
}

// Expand set quantifiers against the full element list. Runs AFTER the explicit
// proposed/negated split and builds on it:
//   - "todas [menos/excepto/salvo R3]" → proposed = evaluable \ negated. The
//     excluded element is already in `negated` because "menos/excepto/salvo"
//     are pre-negation words detectNegation recognises.
//   - "ninguna" → every element negated.
//   - "el resto / las demás" → the elements NOT explicitly mentioned; their
//     polarity is decided by negation around the token ("el resto no influye"
//     → negated; "el resto sí" → proposed).
// Returns { proposed, negated, applied }. When no quantifier is present the
// input arrays are returned unchanged (applied=false) → zero impact on the
// normal element-naming path.
function expandQuantifiers(message, evaluableElements, proposed, negated) {
  if (!Array.isArray(evaluableElements) || evaluableElements.length === 0) {
    return { proposed: proposed, negated: negated, applied: false };
  }
  var folded = foldForMatch(message);
  var allUpper = evaluableElements.map(function (e) { return String(e).toUpperCase(); });

  function unionInto(target, items) {
    for (var i = 0; i < items.length; i++) {
      if (target.indexOf(items[i]) < 0) target.push(items[i]);
    }
  }
  function removeFrom(arr, items) {
    return arr.filter(function (x) { return items.indexOf(x) < 0; });
  }

  var negatedOut = negated.slice();
  var proposedOut = proposed.slice();
  var applied = false;

  // Adversarial-pass guard (2026-06-10): BARE all/none tokens ("todas",
  // "todos", "ninguno"…) leaked into idiomatic chatter ("he probado todas las
  // opciones", "a todas horas", "ninguno de estos", "todos los caminos") and
  // expanded to the whole element set even with NO element named — fabricating
  // or mass-rejecting answers. A real set quantifier is anchored to the
  // circuit: either an element is already mentioned, or a resistance/element
  // noun appears. Multi-word tokens ("todas las resistencias", "todas ellas")
  // are self-anchoring and trusted as-is.
  // ADV1-tighten (2026-06-10): the circuit anchor/idiom allowlist must match
  // whole NOUNS, not substrings/prefixes — otherwise adjectives that merely
  // CONTAIN "resist"/"element" ("elemental", "resistente", "elementales") let a
  // bare quantifier expand on non-answer chatter ("muy elemental todo, todas").
  // These forms are excluded because the noun forms below are anchored with \b
  // and don't prefix-match the adjectives ("elementos?\b" ≠ "elementales").
  var CIRCUIT_NOUN_RE = /\b(resistenci\w*|resistors?|resistances?|elementos?|elements?|componentes?|components?|dispositivos?)\b/;
  var anchored = (proposed.length + negated.length) > 0 || CIRCUIT_NOUN_RE.test(folded);
  function _tokenIsMultiWord(hit) {
    return folded.substr(hit.index, hit.length).indexOf(" ") >= 0;
  }
  function _bareQuantifierOk(hit) {
    if (!anchored) return false;
    // "<token> las/los/de <non-circuit-noun>" is an idiom ("todas las opciones",
    // "todos los caminos", "ninguno de estos"). When the noun IS a circuit noun
    // ("todos los elementos") it stays a real quantifier.
    var after = folded.slice(hit.index + hit.length).replace(/^\s+/, "");
    var m = after.match(/^(las|los|les|the|de|del|d'|of)\s+(\S+)/);
    if (m && !CIRCUIT_NOUN_RE.test(m[2])) return false;
    return true;
  }
  function _quantifierIsReal(hit) {
    return _tokenIsMultiWord(hit) || _bareQuantifierOk(hit);
  }

  // 1. "ninguna" → every element negated. Strongest signal, checked first.
  //    Guarded against conversational idioms ("no tengo ninguna duda"), which
  //    are NOT about the circuit elements.
  var noneHit = findToken(folded, NONE_TOKENS);
  if (noneHit) {
    var noneFalseCtx = false;
    for (var n = 0; n < NONE_FALSE_CONTEXTS.length; n++) {
      if (folded.indexOf(NONE_FALSE_CONTEXTS[n]) >= 0) { noneFalseCtx = true; break; }
    }
    if (!noneFalseCtx && _quantifierIsReal(noneHit)) {
      return { proposed: [], negated: allUpper.slice(), applied: true };
    }
  }

  // 2. "todas [menos X]" → all evaluable proposed, minus whatever is negated.
  var allHit = findToken(folded, ALL_TOKENS);
  if (allHit) {
    var falseCtx = false;
    for (var f = 0; f < ALL_FALSE_CONTEXTS.length; f++) {
      if (folded.indexOf(ALL_FALSE_CONTEXTS[f]) >= 0) { falseCtx = true; break; }
    }
    if (!falseCtx && _quantifierIsReal(allHit)) {
      proposedOut = removeFrom(allUpper.slice(), negatedOut);
      applied = true;
    }
  }

  // 3. "el resto / las demás" → elements not explicitly mentioned; polarity by
  //    negation around the token. Requires a circuit anchor: "the rest" is only
  //    meaningful relative to already-named elements (or an explicit resistance
  //    noun) — "no entiendo el resto" must NOT expand to the full set.
  var restHit = anchored ? findToken(folded, REST_TOKENS) : null;
  if (restHit) {
    var mentioned = proposedOut.concat(negatedOut);
    var rest = allUpper.filter(function (e) { return mentioned.indexOf(e) < 0; });
    if (rest.length > 0) {
      if (tokenHasPostNegation(message, restHit.index, restHit.length)) {
        unionInto(negatedOut, rest);
      } else {
        unionInto(proposedOut, rest);
      }
      applied = true;
    }
  }

  // Negation wins: no element may sit in both lists.
  proposedOut = removeFrom(proposedOut, negatedOut);
  return { proposed: proposedOut, negated: negatedOut, applied: applied };
}

/*------------------------------------------------------
  Classify a student message based on:
    - correctAnswer: array of correct elements ["R1", "R2", "R4"]
    - evaluableElements: (optional) all possible answer elements ["R1","R2","R3","R4","R5"]
    - lastAssistantText: (optional) last tutor message — enables yes/no
      answers to closed-form tutor questions to be classified properly.
  Returns: { type, resistances, proposed, negated, hasReasoning, concepts }
--------------------------------------------------------*/
function classifyQuery(userMessage, correctAnswer, evaluableElements, lastAssistantText) {
  // Extract mentioned elements with positions (generic or regex fallback)
  var mentions = extractMentionedElements(userMessage, evaluableElements);

  // Separate proposed vs negated elements.
  // An element can appear several times; evaluate negation at EACH occurrence.
  // H1 (2026-06-10): STICKY NEGATION — if ANY occurrence is negated, the
  // element is negated. This strictly improves on the previous "last mention
  // wins" rule:
  //   - "...corriente por R3, por lo que R3 no influye" → 2nd occurrence
  //     negated → negated (the case last-wins was introduced for; still works).
  //   - "R3 no influye, pero R3 tiene resistencia alta" → 1st occurrence
  //     negated, 2nd neutral → last-wins WRONGLY proposed R3; sticky negation
  //     keeps it negated, which is the student's real intent (they reject R3 and
  //     then explain WHY — a very common restatement pattern).
  // Trade-off: a same-message flip-FLOP toward acceptance ("R3 no… mejor sí,
  // R3") stays negated. That phrasing is far rarer than the restate-to-explain
  // pattern above, and the harm is symmetric, so net this is the safer rule.
  var proposed = [];
  var negated = [];
  for (var i = 0; i < mentions.length; i++) {
    var positions = mentions[i].positions || [mentions[i].position];
    var negatedHere = false;
    for (var p = 0; p < positions.length; p++) {
      if (detectNegation(userMessage, positions[p], mentions[i].element.length)) {
        negatedHere = true;
        break;
      }
    }
    if (negatedHere) {
      negated.push(mentions[i].element);
    } else {
      proposed.push(mentions[i].element);
    }
  }

  // Quantifier / set expansion ("todas", "todas menos R3", "ninguna", "el
  // resto"). When no quantifier is present this is a no-op.
  var qexp = expandQuantifiers(userMessage, evaluableElements, proposed, negated);
  proposed = qexp.proposed;
  negated = qexp.negated;

  // All mentioned elements (for backward compatibility). Now reflects any
  // quantifier expansion so the greeting/short-answer length checks below see
  // the expanded set — otherwise a bare "todas" (< 15 chars, no Rn) would fall
  // into the short-answer wrong_answer bucket.
  var allMentioned = proposed.concat(negated);

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

  // 2.5. Pregunta del alumno (reformulación del enunciado o metapregunta).
  //      Cuando el alumno termina su mensaje en "?" o "¿...?" SIN nombrar
  //      elementos canónicos (R1, R2…), normalmente está repitiendo lo que
  //      cree que se le pide ("Por cuáles resistencias pasa la corriente,
  //      cierto?") o pidiendo aclaración. Tratarlas como dont_know dispara
  //      el banner SCAFFOLD (baja la complejidad y guía con una pregunta
  //      simple) en lugar de etiquetarlas como wrong_answer y arruinar la
  //      respuesta del LLM con la lógica agresiva.
  var trimmed = userMessage.trim();
  if (allMentioned.length === 0 && /[?¿]/.test(trimmed)) {
    return { type: types.dontKnow, resistances: allMentioned, proposed: proposed, negated: negated, hasReasoning: reasoning, concepts: concepts };
  }

  // 3. Short answer without elements (formerly "single_word"). Now we look
  //    at the tutor's last question. If it was a closed yes/no question and
  //    the student answered yes/no, the answer is VALID — we don't punish
  //    them for being concise. Diagnostic checks ("¿tienes dudas?") are
  //    accepted as final; closed reasoning checks evaluate the IMPLICIT
  //    correctness based on the Rn the tutor named in the question.
  //
  //    BUG-006 (2026-05-03): antes esto devolvía correctNoReasoning sin
  //    mirar QUÉ Rn había nombrado el tutor en su pregunta. Si el tutor
  //    preguntaba "¿Influye R5?" y el alumno decía "Sí" (R5 NO influye),
  //    la respuesta quedaba como correctNoReasoning y el LLM la confirmaba
  //    con "¡Correcto!" — false_confirmation a un wrong implícito.
  //    El fix extrae el Rn de la última pregunta del tutor y cruza el
  //    yes/no con correctAnswer:
  //
  //                        sí + Rn∈correct      → correctNoReasoning
  //                        sí + Rn∉correct      → wrong_concept (proposed=[Rn])
  //                        no + Rn∈correct      → wrong_concept (negated=[Rn])
  //                        no + Rn∉correct      → correctNoReasoning
  //    H6 (2026-06-10): el gate length<15 cortaba respuestas sí/no VERBOSAS
  //    ("sí, lo tengo claro" = 18 chars, "no, ninguna duda" = 16) antes de
  //    llegar a esta lógica, mandándolas a wrong_answer. Una respuesta yes/no a
  //    una pregunta CERRADA del tutor es válida aunque sea larga, así que
  //    ampliamos el gate: además del caso corto-sin-elementos, entramos si el
  //    mensaje (sin elementos) empieza por un marcador yes/no Y el tutor hizo
  //    una pregunta cerrada.
  var ctxQ = detectClosedQuestion(lastAssistantText);
  var yesNo = isYesNoAnswer(userMessage);
  var shortNoElements = userMessage.trim().length < 15 && allMentioned.length === 0;
  var verboseYesNoToClosed = allMentioned.length === 0 && yesNo && ctxQ.isClosed;
  if (shortNoElements || verboseYesNoToClosed) {
    if (ctxQ.isClosed && yesNo) {
      if (ctxQ.isDiagnostic) {
        return { type: types.closedAnswer, resistances: allMentioned, proposed: proposed, negated: negated, hasReasoning: reasoning, concepts: concepts };
      }
      var lastQRn = _extractElementFromQuestion(lastAssistantText, evaluableElements);
      var isYes = /^s[ií]|^yes|^yeah|^yep|^sip|^claro|^por supuesto|^exact/i.test(userMessage.trim());
      var isNo = /^no|^nope|^nah/i.test(userMessage.trim());
      if (lastQRn && (isYes || isNo)) {
        var rnIsCorrect = Array.isArray(correctAnswer) &&
          correctAnswer.indexOf(lastQRn) >= 0;
        // sí + correcto, no + incorrecto → la afirmación implícita coincide
        // con la verdad → correctNoReasoning. El resto → wrong_concept.
        var implicitTrue = (isYes && rnIsCorrect) || (isNo && !rnIsCorrect);
        if (implicitTrue) {
          return {
            type: types.correctNoReasoning,
            resistances: [lastQRn],
            proposed: isYes ? [lastQRn] : [],
            negated: isNo ? [lastQRn] : [],
            hasReasoning: reasoning,
            concepts: concepts,
          };
        }
        // Wrong implícito: el tutor preguntó por Rn, alumno dijo "sí" pero
        // Rn NO está en correct (o "no" pero Rn SÍ está). La clasificación
        // wrong_concept con proposed/negated rellenado dispara
        // FalseConfirmationGuardrail si el LLM responde con "¡Correcto!".
        return {
          type: types.wrongConcept,
          resistances: [lastQRn],
          proposed: isYes ? [lastQRn] : [],
          negated: isNo ? [lastQRn] : [],
          hasReasoning: reasoning,
          concepts: concepts,
        };
      }
      // Sin Rn explícita en la pregunta del tutor (pregunta puramente
      // conceptual: "¿hay corriente?"): conservar correctNoReasoning para
      // no romper el flujo socrático de razonamiento abierto.
      return { type: types.correctNoReasoning, resistances: allMentioned, proposed: proposed, negated: negated, hasReasoning: reasoning, concepts: concepts };
    }
    // No closed-question context (or non yes/no short answer): treat as a
    // wrong answer — there's nothing concrete to evaluate.
    return { type: types.wrongAnswer, resistances: allMentioned, proposed: proposed, negated: negated, hasReasoning: reasoning, concepts: concepts };
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

    // 5b. Mixed proposal: at least one CORRECT element and at least one WRONG one.
    //     Treating this as plain wrong_answer wastes the alumno's correct insight
    //     (e.g. "R4 y R5" cuando la correcta es R1,R2,R4: R4 sí va, R5 no). El
    //     tutor necesita reconocer lo bueno y cuestionar lo malo, igual que con
    //     partial_correct puro. El AcDetectorAgent + el banner [PER-ELEMENT
    //     ANALYSIS] aprovechan esta señal para guiar específicamente.
    var someCorrect = false;
    var someWrong = false;
    for (var i = 0; i < proposed.length; i++) {
      var found = false;
      for (var j = 0; j < correctAnswer.length; j++) {
        if (proposed[i] === correctAnswer[j]) { found = true; break; }
      }
      if (found) someCorrect = true; else someWrong = true;
      if (someCorrect && someWrong) break;
    }
    if (someCorrect && someWrong) {
      return { type: types.partialCorrect, resistances: allMentioned, proposed: proposed, negated: negated, hasReasoning: reasoning, concepts: concepts };
    }
  }

  // 6. Wrong elements with concept keywords -> wrong concept
  if (concepts.length > 0) {
    return { type: types.wrongConcept, resistances: allMentioned, proposed: proposed, negated: negated, hasReasoning: reasoning, concepts: concepts };
  }

  // 7. Wrong answer
  return { type: types.wrongAnswer, resistances: allMentioned, proposed: proposed, negated: negated, hasReasoning: reasoning, concepts: concepts };
}

module.exports = { classifyQuery, extractResistances, extractMentionedElements, detectClosedQuestion, isYesNoAnswer, types };
