const {
  getAllPatterns,
  greetingPatterns: greetingDict,
  dontKnowPatterns: dontKnowDict,
  reasoningPatterns: reasoningDict,
  conceptKeywords: conceptDict,
} = require("../languageManager");

/*------------------------------------------------------------------------------
            _________________________________________________________
            |                    QUERY CLASSIFIER                   |
            |  Rule-based, no-LLM classifier of student messages.   |
            |  Generic over evaluable elements; multi-language      |
            |  (es/val/en). Detects negation, quantifiers,          |
            |  reasoning, concepts and closed-question yes/no       |
            |  answers, and produces a classification type.         |
        ____|________________________                              |
        | classifyQuery() | -> Obj                                 |
        -------------------                                         |
        ____|__________________________                            |
        | extractResistances() | -> [Txt]                          |
        -----------------------                                     |
        ____|________________________________                      |
        | extractMentionedElements() | -> [Obj]                    |
        -----------------------------                              |
        ____|___________________________                           |
        | detectClosedQuestion() | -> Obj                          |
        -------------------------                                  |
        ____|___________________                                   |
        | isYesNoAnswer() | -> T/F                                 |
        ------------------                                         |
        ____|________________________                              |
        | isExplanationRequest() | -> T/F                          |
        -------------------------                                  |
        ____|________                                              |
        | types | -> Obj                                           |
        --------                                                   |
            |                                                       |
            |_______________________________________________________|
------------------------------------------------------------------------------*/

/*
   Txt -> ____|_____________
         | stripAccents() | -> Txt
          ------------------
      Normalizes accented characters to their base form for
      accent-insensitive matching.
*/
function stripAccents(str) {
  return str.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

/* Classification type tokens returned by classifyQuery. */
const types = {
  greeting: "greeting",
  dontKnow: "dont_know",
  closedAnswer: "closed_answer",
  wrongAnswer: "wrong_answer",
  correctNoReasoning: "correct_no_reasoning",
  correctWrongReasoning: "correct_wrong_reasoning",
  correctGoodReasoning: "correct_good_reasoning",
  wrongConcept: "wrong_concept",
  partialCorrect: "partial_correct",
};

/* Detection pattern lists assembled from the language manager (es/val/en). */
const greetingPatterns = getAllPatterns(greetingDict);
const dontKnowPatterns = getAllPatterns(dontKnowDict);
const reasoningPatterns = getAllPatterns(reasoningDict);

/* Concept keywords that may indicate wrong reasoning if misused. */
const conceptKeywords = getAllPatterns(conceptDict);

/* Factual circuit-state terms (not alternative conceptions). */
var stateDescriptionConcepts = [
  "cortocircuito", "cortocircuitada", "cortocircuitado", "corto",
  "circuito abierto", "abierto", "abierta",
  "interruptor cerrado", "interruptor abierto",
  "curtcircuit", "curtcircuitada", "curtcircuitat", "curt",
  "circuit obert", "obert", "oberta",
  "interruptor tancat", "interruptor obert",
  "short circuit", "shorted", "short",
  "open circuit", "open",
  "switch closed", "switch open",
];

/*
   [Txt] -> ____|_______________________________
           | allConceptsAreStateDescriptions() | -> T/F
            -----------------------------------
      True when every found concept is a factual circuit state
      rather than an alternative conception.
*/
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

/* Words that, placed BEFORE an element, mark it as rejected. */
const preNegationWords = [
  "no", "sin", "ni", "tampoco", "excepto", "salvo", "menos", "quitando", "descartando",
  "descarto", "descartaria", "descartar", "descartamos", "descartaba",
  "quito", "quitaria", "quitar", "elimino", "eliminaria", "eliminar",
  "excluyo", "excluiria", "excluir", "excluyendo", "eliminando",
  "sense", "tampoc", "excepte", "llevat de", "menys",
  "not", "without", "nor", "neither", "except", "excluding",
];

/* Multi-word pre-negation phrases checked with a wider window. */
const preNegationPhrases = [
  "no pasa corriente por", "no circula corriente por", "no pasa por",
  "no circula por", "no fluye por", "no hay corriente en", "no hay corriente por",
  "no passa corrent per", "no circula corrent per", "no passa per",
  "no current flows through", "current doesn't flow through",
  "no current through", "doesn't flow through",
];

/* Phrases that, placed AFTER an element, mark it as rejected. */
const postNegationPhrases = [
  "no contribuye", "no participa", "no afecta", "no influye", "no cuenta",
  "no interviene", "se elimina", "se descarta", "sobra", "no importa",
  "no tiene que ver", "es incorrecto", "es incorrecta", "está mal",
  "no es", "no forma parte", "no es relevante",
  "no circula", "no pasa corriente", "no fluye", "no hay corriente",
  "no tiene corriente", "no pasa", "no llega",
  "no contribueix", "no participa", "no afecta", "no influeix", "no compta",
  "s'elimina", "es descarta", "no té a veure", "és incorrecte",
  "no és", "no forma part", "no és rellevant",
  "no circula", "no passa corrent", "no flueix", "no hi ha corrent",
  "doesn't contribute", "does not contribute", "doesn't affect", "does not affect",
  "is not relevant", "isn't part", "doesn't matter", "is wrong", "is incorrect",
  "should not", "shouldn't be", "is not", "isn't",
  "no current flows", "current doesn't flow", "no current", "doesn't flow",
  "está en abierto", "en abierto", "en circuito abierto",
  "está abierto", "está abierta", "están abiertos", "están abiertas",
  "en interruptor abierto", "en un interruptor abierto", "en el interruptor abierto",
  "con un interruptor abierto", "con el interruptor abierto",
  "tras un interruptor abierto", "tras el interruptor abierto",
  "detras de un interruptor", "detras del interruptor",
  "tiene el interruptor abierto", "tiene un interruptor abierto",
  "en interruptor obert", "en un interruptor obert", "té l'interruptor obert",
  "behind an open switch", "has an open switch",
  "desconectada", "desconectado", "desconectadas", "desconectados",
  "queda fuera", "quedan fuera", "fuera del circuito",
  "se anula", "se anulan", "anulada", "anulado",
  "aislada", "aislado", "queda aislada", "queda aislado",
  "puenteada", "puenteado",
  "desconnectada", "desconnectat", "aillada", "aillat",
  "disconnected", "bypassed", "isolated",
  "está cortocircuitada", "está cortocircuitado", "cortocircuitada", "cortocircuitado",
  "en cortocircuito", "en corto", "está en corto", "está en cortocircuito",
  "estaba abierto", "estaba abierta", "estaban abiertos", "estaban abiertas",
  "quedaba abierto", "quedaba abierta", "queda abierto", "queda abierta",
  "terminal abierto", "terminal abierta", "un terminal abierto",
  "tiene un terminal abierto", "tiene el terminal abierto",
  "terminal sin conectar", "terminal sin conexion", "un terminal sin conectar",
  "terminal que no esta conectado", "un terminal que no esta conectado",
  "tiene un terminal que no esta conectado", "tiene un terminal sin conectar",
  "linea abierta", "en linea abierta", "en una linea abierta",
  "rama abierta", "en rama abierta", "en una rama abierta",
  "hay un interruptor abierto", "hay interruptor abierto", "hay un cortocircuito",
  "un cortocircuito", "en un cortocircuito", "con un cortocircuito",
  "està en obert", "en circuit obert", "està obert", "està oberta",
  "curtcircuitada", "curtcircuitat", "en curtcircuit", "està curtcircuitada", "està curtcircuitat",
  "is open", "is shorted", "is short-circuited", "in open circuit", "in short circuit",
];

/* Length-preserving lowercase accent-fold map (1:1 char indices). */
var ACCENT_FOLD = {
  "á": "a", "à": "a", "ä": "a", "â": "a",
  "é": "e", "è": "e", "ë": "e", "ê": "e",
  "í": "i", "ì": "i", "ï": "i", "î": "i",
  "ó": "o", "ò": "o", "ö": "o", "ô": "o",
  "ú": "u", "ù": "u", "ü": "u", "û": "u",
};

/*
   Txt -> ____|_____________
         | foldForMatch() | -> Txt
          ----------------
      Length-preserving lowercase + accent fold so negation matching
      is accent-insensitive while keeping every character index aligned.
*/
function foldForMatch(str) {
  var lower = str.toLowerCase();
  var out = "";
  for (var i = 0; i < lower.length; i++) {
    var ch = lower[i];
    out += ACCENT_FOLD[ch] || ch;
  }
  return out;
}

/* Accent-folded copies of the negation dictionaries, computed once. */
var preNegationWordsF = preNegationWords.map(foldForMatch);
var preNegationPhrasesF = preNegationPhrases.map(foldForMatch);
var postNegationPhrasesF = postNegationPhrases.map(foldForMatch);

/* Per-phrase flag: long self-disambiguating phrases earn the wide window. */
var postNegationPhraseWideF = postNegationPhrasesF.map(function (p) {
  return p.indexOf("interruptor") >= 0 || p.indexOf("switch") >= 0 ||
    p.indexOf("terminal") >= 0 || p.indexOf("linea") >= 0 || p.indexOf("rama") >= 0;
});

/*
   Txt -> ____|___________________
         | _lastSentenceCut() | -> Z
          --------------------
      Index of the last sentence terminator (.!?) in the string,
      treating a run of dots (ellipsis) as hesitation, not a break.
      Returns -1 when there is no real terminator.
*/
function _lastSentenceCut(s) {
  var scan = s.replace(/\.{2,}/g, function (run) {
    return new Array(run.length + 1).join(" ");
  });
  return scan.search(/[.!?][^.!?]*$/);
}

/*
   Txt -> ____|_________________
         | _lastClauseCut() | -> Z
          ------------------
      Like _lastSentenceCut but also breaks at a contrastive connector
      (pero/sino/aunque/but). Returns the index of the last boundary char.
*/
function _lastClauseCut(s) {
  var scan = s.replace(/\.{2,}/g, function (run) {
    return new Array(run.length + 1).join(" ");
  });
  var re = /[.!?]|\b(?:pero|sino|aunque|but)\b/g;
  var m, last = -1;
  while ((m = re.exec(scan)) !== null) { last = m.index + m[0].length - 1; }
  return last;
}

/*
   Txt, Z, Z -> ____|_________________
               | detectNegation() | -> T/F
                ------------------
      True when a negation surrounds the element at the given position.
      Windows are tight to avoid false positives on distant negations.
*/
function detectNegation(message, position, elementLength) {
  var lower = foldForMatch(message);
  var PRE_WINDOW = 15;
  var POST_WINDOW = 25;
  var POST_WINDOW_WIDE = 40;

  var preStart = Math.max(0, position - PRE_WINDOW);
  var prefix = lower.substring(preStart, position);
  var pSent = _lastSentenceCut(prefix);
  if (pSent >= 0) prefix = prefix.slice(pSent + 1);

  for (var i = 0; i < preNegationWordsF.length; i++) {
    var word = preNegationWordsF[i];
    var idx = prefix.lastIndexOf(word);
    if (idx >= 0) {
      var charBefore = idx > 0 ? prefix[idx - 1] : " ";
      var charAfter = idx + word.length < prefix.length ? prefix[idx + word.length] : " ";
      if (/[\s,;:(]/.test(charBefore) || idx === 0) {
        if (/[\s,;:)]/.test(charAfter) || idx + word.length === prefix.length) {
          var between = prefix.substring(idx + word.length);
          if (/[,;]/.test(between)) continue;
          return true;
        }
      }
    }
  }

  var PHRASE_PRE_WINDOW = 30;
  var phrasePreStart = Math.max(0, position - PHRASE_PRE_WINDOW);
  var phrasePrefix = lower.substring(phrasePreStart, position);
  var phSent = _lastClauseCut(phrasePrefix);
  if (phSent >= 0) phrasePrefix = phrasePrefix.slice(phSent + 1);
  for (var i = 0; i < preNegationPhrasesF.length; i++) {
    if (phrasePrefix.includes(preNegationPhrasesF[i])) {
      return true;
    }
  }

  var postStart = position + elementLength;
  var postEnd = Math.min(lower.length, postStart + POST_WINDOW_WIDE);
  var suffixWide = lower.substring(postStart, postEnd);
  var sentBoundary = suffixWide.search(/[.!?]/);
  if (sentBoundary >= 0) {
    suffixWide = suffixWide.substring(0, sentBoundary);
  }
  var nextElem = suffixWide.search(/[a-z][\d]+/i);
  if (nextElem >= 0) {
    suffixWide = suffixWide.substring(0, nextElem);
  }
  var suffix = suffixWide.substring(0, POST_WINDOW);

  var immediateAfter = suffix.replace(/^\s+/, "");
  var rawAfter = lower.substring(postStart, postStart + 8);
  if (/^\s*no\s*[?¿]/.test(rawAfter)) {
  } else if (/^no(?:[\s.,;:!?]|$)/.test(immediateAfter)) {
    return true;
  }

  for (var i = 0; i < postNegationPhrasesF.length; i++) {
    var span = postNegationPhraseWideF[i] ? suffixWide : suffix;
    if (span.includes(postNegationPhrasesF[i])) {
      return true;
    }
  }

  return false;
}

/* Flow-negation heads that introduce a LIST of excluded elements (accent-folded). */
var FLOW_NEGATION_HEADS = [
  "no pasa corriente por", "no pasa la corriente por", "no circula corriente por",
  "no circula la corriente por", "no deja pasar corriente por", "no deja pasar la corriente por",
  "no fluye corriente por", "no fluye por", "no pasa por", "no circula por",
  "no hay corriente por", "no hay corriente en", "no llega corriente a", "sin corriente por",
  "no puede pasar corriente por", "no puede pasar la corriente por",
  "no puede circular corriente por", "no puede circular la corriente por",
  "no puede fluir corriente por", "no puede fluir la corriente por",
  "no puede pasar por", "no puede circular por", "no puede fluir por",
  "no podria pasar corriente por", "no podria circular corriente por",
  "no podria pasar por", "no podria circular por",
  "es imposible que pase corriente por", "es imposible que pase la corriente por",
  "es imposible que circule corriente por", "es imposible que circule la corriente por",
  "imposible que pase corriente por", "imposible que pase la corriente por",
  "es imposible que pase por", "es imposible que circule por",
  "imposible que pase por", "imposible que circule por",
  "no puede haber corriente por", "no puede haber corriente en",
  "impide el paso de la corriente por", "impide el paso de corriente por",
  "impide que pase la corriente por", "impide el paso por",
  "bloquea la corriente por", "bloquea el paso de la corriente por",
  "corta la corriente por", "corta el paso de la corriente por",
  "evita que pase la corriente por", "evita que pase corriente por",
  "evita el paso de la corriente por", "evita el paso de corriente por",
  "evita que circule la corriente por", "evita que circule corriente por",
  "no atraviesa", "no cruza",
  "en vez de pasar por", "en lugar de pasar por",
  "en vez de circular por", "en lugar de circular por",
  "en vez de pasar la corriente por", "en lugar de pasar la corriente por",
  "no passa corrent per", "no circula corrent per", "no passa per", "no deixa passar corrent per",
  "no pot passar corrent per", "no pot circular corrent per", "no pot passar per",
  "es impossible que passe corrent per", "impossible que passe corrent per",
  "no current flows through", "no current through", "current doesn't flow through",
  "doesn't flow through", "no current flows",
  "current can't flow through", "current cannot flow through",
  "no current can flow through", "current can't pass through", "can't flow through",
].map(foldForMatch);

/* Clause-boundary regex that stops a flow-negation span. */
var FLOW_STOP_RE = /[.!?]|\bpero\b|\bsino\b|\baunque\b|\bbut\b/;

/*
   Txt, [Txt] -> ____|___________________________
                | detectFlowNegatedElements() | -> [Txt]
                 -----------------------------
      Returns every evaluable element falling inside a flow-negation
      span (head up to the next clause boundary), uppercased.
*/
function detectFlowNegatedElements(message, evaluableElements) {
  if (!Array.isArray(evaluableElements) || evaluableElements.length === 0) return [];
  var folded = foldForMatch(message);
  var out = [];
  for (var h = 0; h < FLOW_NEGATION_HEADS.length; h++) {
    var head = FLOW_NEGATION_HEADS[h];
    var from = 0;
    var idx;
    while ((idx = folded.indexOf(head, from)) >= 0) {
      var rest = folded.slice(idx + head.length);
      var stop = rest.search(FLOW_STOP_RE);
      var span = stop >= 0 ? rest.slice(0, stop) : rest;
      for (var e = 0; e < evaluableElements.length; e++) {
        var el = String(evaluableElements[e]).toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        var re = new RegExp("(^|[^a-z0-9])" + el + "([^a-z0-9]|$)", "i");
        var up = String(evaluableElements[e]).toUpperCase();
        if (re.test(span) && out.indexOf(up) < 0) out.push(up);
      }
      from = idx + head.length;
    }
  }
  return out;
}

/*
   Txt, [Txt] -> ____|___________________________
                | extractMentionedElements() | -> [Obj]
                 ----------------------------
      Extracts mentioned elements (or falls back to R\d+ regex) as one
      entry per element { element, position, positions } in first-seen
      order, where positions lists every occurrence in ascending order.
*/
function extractMentionedElements(message, evaluableElements) {
  var order = [];
  var posMap = {};

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

/*
   Txt -> ____|____________________
         | extractResistances() | -> [Txt]
          ----------------------
      Legacy regex extraction of unique resistance names (R\d+),
      kept for backward compatibility.
*/
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

/*
   [Txt], [Txt] -> ____|___________
                  | sameSet() | -> T/F
                   -----------
      True when both arrays contain the same elements (order-insensitive).
*/
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

/*
   Txt -> ____|______________
         | hasReasoning() | -> T/F
          ----------------
      True when the message contains reasoning keywords (accent-insensitive).
*/
function hasReasoning(message) {
  var lower = stripAccents(message.toLowerCase());
  for (var i = 0; i < reasoningPatterns.length; i++) {
    if (lower.includes(stripAccents(reasoningPatterns[i]))) {
      return true;
    }
  }
  return false;
}

/*
   Txt -> ____|_____________
         | findConcepts() | -> [Txt]
          ----------------
      Returns the concept keywords present in the message (accent-insensitive).
*/
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

/*
   Txt -> ____|___________
         | isGreeting() | -> T/F
          --------------
      True when the message starts with a greeting (accent-insensitive).
*/
function isGreeting(message) {
  var lower = stripAccents(message.toLowerCase().trim());
  for (var i = 0; i < greetingPatterns.length; i++) {
    if (lower.startsWith(stripAccents(greetingPatterns[i]))) {
      return true;
    }
  }
  return false;
}

/*
   Txt -> ____|___________
         | isDontKnow() | -> T/F
          --------------
      True when the message expresses "I don't know" (accent-insensitive).
*/
function isDontKnow(message) {
  var lower = stripAccents(message.toLowerCase());
  for (var i = 0; i < dontKnowPatterns.length; i++) {
    if (lower.includes(stripAccents(dontKnowPatterns[i]))) {
      return true;
    }
  }
  return false;
}

/* Patterns where the student asks the tutor to explain a concept. */
var EXPLAIN_REQUEST_PATTERNS = [
  "explica", "explicame", "explicarme", "explicar", "me explicas", "puedes explicar",
  "podrias explicar", "que es", "que significa", "no entiendo el concepto",
  "no se que es", "que quiere decir", "en que consiste", "me explicas",
  "explicam", "no entenc el concepte", "que vol dir", "en que consisteix",
  "explain", "what is", "what does", "can you explain", "i don't understand the concept",
];

/*
   Txt -> ____|_________________________
         | isExplanationRequest() | -> T/F
          -------------------------
      True when the student asks the tutor to explain a concept
      (accent-insensitive).
*/
function isExplanationRequest(message) {
  var lower = stripAccents(String(message || "").toLowerCase());
  for (var i = 0; i < EXPLAIN_REQUEST_PATTERNS.length; i++) {
    if (lower.includes(stripAccents(EXPLAIN_REQUEST_PATTERNS[i]))) return true;
  }
  return false;
}

/*
   Txt -> ____|_______________________
         | detectClosedQuestion() | -> Obj
          -------------------------
      Returns { isClosed, isDiagnostic } for a tutor message. A closed
      question opens a yes/no form; isDiagnostic flags meta-questions
      about the student's state rather than a reasoning step.
*/
function detectClosedQuestion(lastAssistantText) {
  if (typeof lastAssistantText !== "string" || lastAssistantText.length === 0) {
    return { isClosed: false, isDiagnostic: false };
  }
  var matches = lastAssistantText.match(/[^.!?]*\?/g);
  if (!matches || matches.length === 0) return { isClosed: false, isDiagnostic: false };
  var last = matches[matches.length - 1].toLowerCase().trim();
  var qOpen = last.lastIndexOf("¿");
  if (qOpen >= 0) {
    last = last.slice(qOpen + 1).trim();
  }

  var closedOpeners = [
    "es ", "es la ", "es el ", "es un", "es una",
    "está ", "estan ", "están ", "estás ", "estoy",
    "tienes", "te has ", "te queda ", "tendrías", "te apetece",
    "puedes", "puede ", "podrías",
    "has ", "hay ", "hace falta", "necesitas", "necesitarías",
    "crees", "consideras", "sabes", "entiendes", "ves ",
    "sigues", "quieres", "quisieras", "deseas",
    "tens", "t'has ", "te queda", "saps", "pots", "vols", "vols saber",
    "està ", "estan ", "estàs", "creus",
    "is ", "are ", "do you", "did you", "have you", "has the", "have we",
    "can you", "could you", "would you", "should you",
    "is there", "are there", "do we",
  ];
  var isClosed = false;
  for (var i = 0; i < closedOpeners.length; i++) {
    if (last.indexOf(closedOpeners[i]) === 0) { isClosed = true; break; }
  }

  var diagnosticMarkers = [
    "duda", "dudas", "alguna duda", "te apetece", "quieres repasar",
    "te ha quedado", "te ha quedado claro", "te queda claro", "lo entiendes",
    "lo has entendido", "has entendido", "lo entendiste", "entendido",
    "necesitas ayuda", "quieres seguir", "estás seguro", "estás segura",
    "todo bien", "vamos bien", "te queda alguna", "alguna pregunta",
    "dubte", "dubtes", "vols repassar", "ho entens", "necessites ajuda",
    "ho has entès", "ho entengueres",
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

/*
   Txt -> ____|_________________
         | isYesNoAnswer() | -> T/F
          -----------------
      True when the message is a yes/no answer (multi-language),
      using punctuation separators instead of ASCII-only word boundaries.
*/
function isYesNoAnswer(message) {
  var trimmed = (message || "").trim().toLowerCase();
  if (trimmed.length === 0) return false;
  return /^(s[ií]|no|vale|ok|okay|sip|nop|claro|por supuesto|nope|yep|yes|yeah|yup|nah|sure|of course|exactly|exacto|exacte)(?:[\s.,!?¡¿]|$)/.test(trimmed);
}

/*
   Txt, [Txt] -> ____|____________________________
                | _extractElementFromQuestion() | -> Txt | null
                 ------------------------------
      Returns the LAST Rn the tutor names inside its closing question
      (filtered by evaluableElements when given), or null when none.
*/
function _extractElementFromQuestion(lastAssistantText, evaluableElements) {
  if (typeof lastAssistantText !== "string" || lastAssistantText.length === 0) return null;
  var matches = lastAssistantText.match(/[^.!?]*\?/g);
  if (!matches || matches.length === 0) return null;
  var lastQ = matches[matches.length - 1];
  var rns = lastQ.match(/\bR\d+\b/gi);
  if (!rns || rns.length === 0) return null;
  var candidate = rns[rns.length - 1].toUpperCase();
  if (Array.isArray(evaluableElements) && evaluableElements.length > 0) {
    var upper = evaluableElements.map(function (e) { return String(e).toUpperCase(); });
    if (upper.indexOf(candidate) < 0) return null;
  }
  return candidate;
}

/* Set-quantifier tokens meaning ALL (accent-folded, lowercase). */
var ALL_TOKENS = [
  "todas las resistencias", "todas las resistencia", "todas ellas",
  "todos ellos", "todas", "todos",
  "todo", "toda",
  "totes les resistencies", "totes", "tots", "tot",
  "all of them", "all the resistances", "all resistances", "all", "everything",
];

/* Set-quantifier tokens meaning NONE (accent-folded, lowercase). */
var NONE_TOKENS = [
  "ninguna resistencia", "ninguna", "ninguno", "ningun", "ningunas", "ningunos",
  "cap resistencia", "cap",
  "none of them", "no resistances", "no resistance", "none",
];

/* Set-quantifier tokens meaning THE REST (accent-folded, lowercase). */
var REST_TOKENS = [
  "el resto", "los demas", "las demas", "las restantes", "los restantes", "la resta",
  "the rest", "the others", "the remaining",
];

/* Idiom guards: a bare ALL hit inside one of these is NOT a set quantifier. */
var ALL_FALSE_CONTEXTS = [
  "de todos modos", "del todo", "todos modos", "todo el",
  "entiendo todas", "entiendo todos", "entendido todas", "entendido todos",
  "comprendo todas", "comprendo todos", "veo todas", "veo todos",
  "entenc totes", "entenc tots", "understand all", "i see all",
];

/* Idiom guards: a NONE hit inside one of these is conversational, not a quantifier. */
var NONE_FALSE_CONTEXTS = [
  "ninguna duda", "ninguna pregunta", "ninguna idea", "ningun problema",
  "ningun comentario", "ninguna gana", "ninguna otra",
  "ningun momento", "ningun caso", "ningun modo", "ningun sentido", "ningun lado",
  "ningun sitio", "ninguna manera", "ninguna forma", "ninguna parte",
  "cap dubte", "cap pregunta", "cap idea", "cap problema", "cap moment",
  "no doubt", "no question", "no idea", "no problem",
];

/*
   Txt, Z, Z -> ____|_______________________
               | tokenHasPostNegation() | -> T/F
                ------------------------
      Post-only negation check for a token (e.g. "el resto"); only the
      text after the token decides its polarity.
*/
function tokenHasPostNegation(message, position, length) {
  var lower = foldForMatch(message);
  var POST_WINDOW = 25;
  var POST_WINDOW_WIDE = 40;
  var start = position + length;
  var suffixWide = lower.substring(start, Math.min(lower.length, start + POST_WINDOW_WIDE));
  var sb = suffixWide.search(/[.!?]/);
  if (sb >= 0) suffixWide = suffixWide.substring(0, sb);
  var ne = suffixWide.search(/[a-z][\d]+/i);
  if (ne >= 0) suffixWide = suffixWide.substring(0, ne);
  var suffix = suffixWide.substring(0, POST_WINDOW);
  for (var i = 0; i < postNegationPhrasesF.length; i++) {
    var span = postNegationPhraseWideF[i] ? suffixWide : suffix;
    if (span.includes(postNegationPhrasesF[i])) return true;
  }
  return false;
}

/*
   Txt, [Txt] -> ____|_____________
                | findToken() | -> Obj | null
                 -------------
      Returns { index, length } of the first token present as a
      standalone word in the folded string, or null.
*/
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

/*
   Txt, [Txt], [Txt], [Txt] -> ____|_____________________
                              | expandQuantifiers() | -> Obj
                               ---------------------
      Expands set quantifiers (todas / ninguna / el resto) against the
      full element list, building on the explicit proposed/negated split.
      Returns { proposed, negated, applied }; applied=false when no
      quantifier is present (input arrays returned unchanged).
*/
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

  var CIRCUIT_NOUN_RE = /\b(resistenci\w*|resistors?|resistances?|elementos?|elements?|componentes?|components?|dispositivos?)\b/;
  var anchored = (proposed.length + negated.length) > 0 || CIRCUIT_NOUN_RE.test(folded);
  function _tokenIsMultiWord(hit) {
    return folded.substr(hit.index, hit.length).indexOf(" ") >= 0;
  }
  function _bareQuantifierOk(hit) {
    if (!anchored) return false;
    var after = folded.slice(hit.index + hit.length).replace(/^\s+/, "");
    var m = after.match(/^(las|los|les|the|de|del|d'|of)\s+(\S+)/);
    if (m && !CIRCUIT_NOUN_RE.test(m[2])) return false;
    return true;
  }
  function _quantifierIsReal(hit) {
    return _tokenIsMultiWord(hit) || _bareQuantifierOk(hit);
  }

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

  proposedOut = removeFrom(proposedOut, negatedOut);
  return { proposed: proposedOut, negated: negatedOut, applied: applied };
}

/*
   Txt, [Txt], [Txt], Txt -> ____|________________
                            | classifyQuery() | -> Obj
                             -----------------
      Classifies a student message against the correct answer and
      (optionally) the evaluable elements and last tutor message.
      Returns { type, resistances, proposed, negated, hasReasoning, concepts }.
*/
function classifyQuery(userMessage, correctAnswer, evaluableElements, lastAssistantText) {
  var mentions = extractMentionedElements(userMessage, evaluableElements);

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

  (function _propagateCoordinatedNegation() {
    var folded = foldForMatch(userMessage);
    var occ = [];
    for (var m = 0; m < mentions.length; m++) {
      var ps = mentions[m].positions || [mentions[m].position];
      for (var q = 0; q < ps.length; q++) {
        occ.push({ el: mentions[m].element, pos: ps[q], end: ps[q] + mentions[m].element.length });
      }
    }
    if (occ.length < 2) return;
    occ.sort(function (a, b) { return a.pos - b.pos; });
    var PURE_SEP = /^[\s,]*(?:(?:y|e|i|o|and|ni|la|el|las|los|les)\b[\s,]*)*$/;
    var EXCEPT_BEFORE = /\b(menos|excepto|salvo|quitando|descartando|descarto|descartaria|descartar|quito|quitaria|quitar|elimino|eliminaria|eliminar|excluyo|excluir|excluyendo|eliminando|sin|ni|menys|excepte|llevat|except|excluding|without)\b[\s,]*(?:la|el|las|los|les)?[\s,]*$/;
    var chains = [[occ[0]]];
    for (var k = 1; k < occ.length; k++) {
      var sep = folded.substring(occ[k - 1].end, occ[k].pos);
      if (PURE_SEP.test(sep)) chains[chains.length - 1].push(occ[k]);
      else chains.push([occ[k]]);
    }
    for (var c = 0; c < chains.length; c++) {
      var chain = chains[c];
      if (chain.length < 2) continue;
      var last = chain[chain.length - 1];
      var first = chain[0];
      var after = folded.substring(last.end, Math.min(folded.length, last.end + 10));
      var trailingNo = /^\s*no(?!\s*[?¿])(?:[\s.,;:!]|$)/.test(after) ||
        /^\s*tampoco\b/.test(after);
      var exceptGoverned = EXCEPT_BEFORE.test(folded.substring(Math.max(0, first.pos - 24), first.pos)) &&
        chain.some(function (o) { return negated.indexOf(o.el) >= 0; });
      var afterWide = folded.substring(last.end, Math.min(folded.length, last.end + 48));
      var EXCL_STATE_RE = /(corto|cortocircuit|curtcircuit|abiert|obert|interruptor|desconect|desconnect|aislad|aillad|anulad|puentead|fuera|no influye|no contribuye|no pasa|no circula|no cuenta)/;
      var bothGoverned = /^\s*(ambas|ambos|les dues|totes dues|las dos|los dos|both)\b/.test(afterWide) &&
        EXCL_STATE_RE.test(afterWide);
      if (!trailingNo && !exceptGoverned && !bothGoverned) continue;
      for (var j = 0; j < chain.length; j++) {
        var el = chain[j].el;
        if (negated.indexOf(el) < 0) negated.push(el);
        var pi = proposed.indexOf(el);
        if (pi >= 0) proposed.splice(pi, 1);
      }
    }
  })();

  var flowNeg = detectFlowNegatedElements(userMessage, evaluableElements);
  for (var fn = 0; fn < flowNeg.length; fn++) {
    if (negated.indexOf(flowNeg[fn]) < 0) negated.push(flowNeg[fn]);
    var pidx = proposed.indexOf(flowNeg[fn]);
    if (pidx >= 0) proposed.splice(pidx, 1);
  }

  var qexp = expandQuantifiers(userMessage, evaluableElements, proposed, negated);
  proposed = qexp.proposed;
  negated = qexp.negated;

  var allMentioned = proposed.concat(negated);

  var reasoning = hasReasoning(userMessage);
  var concepts = findConcepts(userMessage);

  if (allMentioned.length === 0 && userMessage.trim().length <= 30 && isGreeting(userMessage)) {
    return { type: types.greeting, resistances: allMentioned, proposed: proposed, negated: negated, hasReasoning: reasoning, concepts: concepts };
  }

  if (allMentioned.length === 0 && isDontKnow(userMessage)) {
    return { type: types.dontKnow, resistances: allMentioned, proposed: proposed, negated: negated, hasReasoning: reasoning, concepts: concepts };
  }

  var trimmed = userMessage.trim();
  if (allMentioned.length === 0 && /[?¿]/.test(trimmed)) {
    return { type: types.dontKnow, resistances: allMentioned, proposed: proposed, negated: negated, hasReasoning: reasoning, concepts: concepts };
  }

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
        var EXCLUDING_STATE_RE =
          /(en corto|cortocircuit|curtcircuit|en ambos extremos|ambdos extrems|both ends|circuito abierto|circuit obert|open circuit|interruptor abiert|interruptor obert|open switch|shorted|short-?circuited)/;
        var qFoldedA5 = foldForMatch(String(lastAssistantText || ""));
        var contributionQ =
          /(influye|influyen|contribuye|contribuyen|afecta|afectan|cuenta|cuentan|importa|importan|interviene|forma parte|esta en el camino|contributes?|matters?|affects?)/
            .test(qFoldedA5);
        var excludingStateQ = !contributionQ && EXCLUDING_STATE_RE.test(qFoldedA5);
        var claimsContributes;
        if (EXCLUDING_STATE_RE.test(foldForMatch(userMessage))) {
          claimsContributes = false;
        } else {
          claimsContributes = excludingStateQ ? isNo : isYes;
        }
        var implicitTrue = (claimsContributes && rnIsCorrect) || (!claimsContributes && !rnIsCorrect);
        var proposedOut = claimsContributes ? [lastQRn] : [];
        var negatedOut = claimsContributes ? [] : [lastQRn];
        if (implicitTrue) {
          return {
            type: types.correctNoReasoning,
            resistances: [lastQRn],
            proposed: proposedOut,
            negated: negatedOut,
            hasReasoning: reasoning,
            concepts: concepts,
          };
        }
        return {
          type: types.wrongConcept,
          resistances: [lastQRn],
          proposed: proposedOut,
          negated: negatedOut,
          hasReasoning: reasoning,
          concepts: concepts,
        };
      }
      return { type: types.correctNoReasoning, resistances: allMentioned, proposed: proposed, negated: negated, hasReasoning: reasoning, concepts: concepts };
    }
    return { type: types.wrongAnswer, resistances: allMentioned, proposed: proposed, negated: negated, hasReasoning: reasoning, concepts: concepts };
  }

  if (sameSet(proposed, correctAnswer)) {
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
          return { type: types.correctGoodReasoning, resistances: allMentioned, proposed: proposed, negated: negated, hasReasoning: reasoning, concepts: concepts };
        }
      }
      if (reasoning && allConceptsAreStateDescriptions(concepts)) {
        return { type: types.correctGoodReasoning, resistances: allMentioned, proposed: proposed, negated: negated, hasReasoning: reasoning, concepts: concepts };
      }
      return { type: types.correctWrongReasoning, resistances: allMentioned, proposed: proposed, negated: negated, hasReasoning: reasoning, concepts: concepts };
    }
    if (!reasoning) {
      return { type: types.correctNoReasoning, resistances: allMentioned, proposed: proposed, negated: negated, hasReasoning: reasoning, concepts: concepts };
    }
    return { type: types.correctGoodReasoning, resistances: allMentioned, proposed: proposed, negated: negated, hasReasoning: reasoning, concepts: concepts };
  }

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
      if (negated.length > 0 || concepts.length === 0) {
        return { type: types.partialCorrect, resistances: allMentioned, proposed: proposed, negated: negated, hasReasoning: reasoning, concepts: concepts };
      }
    }

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

  if (concepts.length > 0) {
    return { type: types.wrongConcept, resistances: allMentioned, proposed: proposed, negated: negated, hasReasoning: reasoning, concepts: concepts };
  }

  return { type: types.wrongAnswer, resistances: allMentioned, proposed: proposed, negated: negated, hasReasoning: reasoning, concepts: concepts };
}

module.exports = { classifyQuery, extractResistances, extractMentionedElements, detectClosedQuestion, isYesNoAnswer, isExplanationRequest, types };
