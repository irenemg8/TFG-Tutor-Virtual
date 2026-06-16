const {
  getAllPatterns,
  revealPhrases: revealDict,
  confirmPhrases: confirmDict,
  stateRevealPatterns: stateRevealDict,
  getStrongerInstruction: getLangStrongerInstruction,
  getFalseConfirmationInstruction: getLangFalseConfirmationInstruction,
  getPartialConfirmationInstruction: getLangPartialConfirmationInstruction,
  getStateRevealInstruction: getLangStateRevealInstruction,
} = require("../languageManager");

/*------------------------------------------------------------------------------
            _________________________________________________________
            |                       GUARDRAILS                      |
            |  Checks and redacts the LLM tutor response: detects   |
            |  solution leaks, false/premature confirmations, state |
            |  reveals, element naming in questions and didactic    |
            |  explanations; and provides redaction / instruction   |
            |  helpers used by the tutoring pipeline.               |
        ____|_______________________                                |
   Txt -> | checkSolutionLeak() | -> Obj                            |
          ---------------------                                     |
        ____|_______________________                                |
   Txt -> | getStrongerInstruction() | -> Txt                       |
          --------------------------                                |
        ____|__________________________                             |
   Txt -> | checkFalseConfirmation() | -> Obj                       |
          --------------------------                                |
        ____|_____________________________________                  |
   Txt -> | getFalseConfirmationInstruction() | -> Txt              |
          -----------------------------------                       |
        ____|______________________________                         |
   Txt -> | checkPrematureConfirmation() | -> Obj                   |
          -----------------------------                             |
        ____|_______________________________________                |
   Txt -> | getPartialConfirmationInstruction() | -> Txt            |
          -------------------------------------                     |
        ____|____________________                                   |
   Txt -> | checkStateReveal() | -> Obj                             |
          --------------------                                      |
        ____|___________________________                            |
   Txt -> | getStateRevealInstruction() | -> Txt                    |
          ----------------------------                              |
        ____|______________________                                 |
   Txt -> | checkElementNaming() | -> Obj                           |
          ----------------------                                    |
        ____|___________________________                            |
   Txt -> | removeOpeningConfirmation() | -> Txt                    |
          ----------------------------                              |
        ____|_________________________                              |
   Txt -> | redactElementMentions() | -> Obj                        |
          -------------------------                                 |
        ____|__________________________                             |
   Txt -> | fixPlaceholderAgreement() | -> Txt                      |
          --------------------------                                |
        ____|_______________________                                |
   Txt -> | fixOpeningAntecedent() | -> Txt                         |
          -----------------------                                   |
        ____|____________________________                           |
   Txt -> | redactStateRevealSentence() | -> Obj                    |
          ----------------------------                              |
        ____|___________________________                            |
   Txt -> | ensureResponseHasQuestion() | -> Txt                    |
          ----------------------------                              |
        ____|________________________                               |
   Txt -> | extractElementMentions() | -> [Txt]                     |
          -------------------------                                 |
        ____|________________________                               |
   Obj -> | loadConceptPatternsFromKG() | -> [Txt]                  |
          ----------------------------                              |
        ____|_________________________                              |
   Txt -> | enforceDatasetStyle() | -> Obj                          |
          ----------------------                                    |
        ____|___________________________                            |
   Txt -> | checkDidacticExplanation() | -> Obj                     |
          ---------------------------                               |
        ____|_________________________                              |
   Txt -> | getScaffoldInstruction() | -> Txt                       |
          -------------------------                                 |
            |   STATE_REVEAL_PLACEHOLDER_REGEX (exported const)     |
            |_______________________________________________________|
------------------------------------------------------------------------------*/

/* Phrases that signal the tutor is revealing the solution directly (multi-language). */
const revealPhrases = getAllPatterns(revealDict);

/*
   IN -> ____|_______________
        | extractResistances() | -> [Txt]
         ----------------------
      Returns the unique, upper-cased resistance ids (R1, R2, ...) mentioned
      in the text.
*/
function extractResistances(text) {
  const matches = text.match(/R\d+/gi);
  if (matches == null) {
    return [];
  }

  const unique = [];
  const seen = {};
  for (let i = 0; i < matches.length; i++) {
    const r = matches[i].toUpperCase();
    if (seen[r] == null) {
      seen[r] = true;
      unique.push(r);
    }
  }
  return unique;
}

/*
   IN -> ____|_______
        | sameSet() | -> T/F
         -----------
      True when both arrays contain the same elements (order irrelevant).
*/
function sameSet(a, b) {
  if (a.length !== b.length) {
    return false;
  }
  const sorted1 = a.slice().sort();
  const sorted2 = b.slice().sort();
  for (let i = 0; i < sorted1.length; i++) {
    if (sorted1[i] !== sorted2[i]) {
      return false;
    }
  }
  return true;
}

/*
   IN -> ____|___________
        | containsAll() | -> T/F
         ---------------
      True when every element of subset is present in superset.
*/
function containsAll(superset, subset) {
  for (let i = 0; i < subset.length; i++) {
    var found = false;
    for (let j = 0; j < superset.length; j++) {
      if (superset[j] === subset[i]) {
        found = true;
        break;
      }
    }
    if (!found) return false;
  }
  return true;
}

/*
   IN -> ____|__________________
        | checkSolutionLeak() | -> Obj
         ---------------------
      Detects whether the response gives away the correct answer, either via an
      explicit reveal phrase or by listing all correct resistances in one
      affirmative sentence. Returns { leaked, details }.
*/
function checkSolutionLeak(response, correctAnswer) {
  const lower = response.toLowerCase();
  const mentioned = extractResistances(response);

  if (!containsAll(mentioned, correctAnswer)) {
    return {
      leaked: false,
      details: ""
    };
  }

  for (let i = 0; i < revealPhrases.length; i++) {
    if (lower.includes(revealPhrases[i])) {
      return {
        leaked: true,
        details: "Response contains reveal phrase: '" + revealPhrases[i] + "' with all correct resistances",
      };
    }
  }

  if (correctAnswer.length >= 2) {
    const sorted = correctAnswer.slice().sort();
    let pattern = sorted[0];
    for (let i = 1; i < sorted.length; i++) {
      pattern += "[,\\s]+(y\\s+)?" + sorted[i];
    }
    const regex = new RegExp(pattern, "i");
    if (regex.test(response)) {
      const sentences = response.split(/[.!?\n]/);
      for (let i = 0; i < sentences.length; i++) {
        if (regex.test(sentences[i]) && !sentences[i].includes("?")) {
          return {
            leaked: true,
            details: "Response lists all correct resistances together in an affirmative sentence",
          };
        }
      }
    }
  }

  return { leaked: false, details: "" };
}

/*
   IN -> ____|____________
        | stripAccents() | -> Txt
         ----------------
      Normalises accented characters for accent-insensitive matching.
*/
function stripAccents(str) {
  return str.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

/* Affirmative phrases that signal the tutor is confirming a student's statement (multi-language). */
const confirmPhrases = getAllPatterns(confirmDict);

/*
   IN -> ____|________________________
        | checkFalseConfirmation() | -> Obj
         --------------------------
      When the student's answer is wrong, detects a confirmation phrase in the
      opening of the response. Returns { confirmed, details }.
*/
function checkFalseConfirmation(response, classification) {
  const wrongTypes = ["wrong_answer", "wrong_concept"];
  var isWrong = false;
  for (let i = 0; i < wrongTypes.length; i++) {
    if (classification === wrongTypes[i]) {
      isWrong = true;
      break;
    }
  }
  if (!isWrong) {
    return { confirmed: false, details: "" };
  }

  const lower = stripAccents(response.toLowerCase().trim());

  const firstPart = lower.substring(0, 60);
  for (let i = 0; i < confirmPhrases.length; i++) {
    if (firstPart.includes(stripAccents(confirmPhrases[i]))) {
      return {
        confirmed: true,
        details: "Response confirms wrong answer with: '" + confirmPhrases[i] + "'",
      };
    }
  }

  return { confirmed: false, details: "" };
}

/*
   IN -> ____|___________________________________
        | getFalseConfirmationInstruction() | -> Txt
         -----------------------------------
      Returns the language-specific instruction to append when a false
      confirmation is detected.
*/
function getFalseConfirmationInstruction(lang) {
  return getLangFalseConfirmationInstruction(lang);
}

/*
   IN -> ____|_____________________________
        | checkPrematureConfirmation() | -> Obj
         -----------------------------
      Detects a premature confirmation of a partially correct answer (correct
      resistances but missing or wrong reasoning). Returns { premature,
      classificationType, details }.
*/
function checkPrematureConfirmation(response, classification) {
  var partialTypes = ["correct_no_reasoning", "correct_wrong_reasoning", "partial_correct"];
  var isPartial = false;
  for (var i = 0; i < partialTypes.length; i++) {
    if (classification === partialTypes[i]) {
      isPartial = true;
      break;
    }
  }
  if (!isPartial) {
    return { premature: false, details: "" };
  }

  var lower = stripAccents(response.toLowerCase().trim());
  var firstPart = lower.substring(0, 60);

  for (var i = 0; i < confirmPhrases.length; i++) {
    if (firstPart.includes(stripAccents(confirmPhrases[i]))) {
      return {
        premature: true,
        classificationType: classification,
        details: "Response prematurely confirms with: '" + confirmPhrases[i] + "' (classification: " + classification + ")",
      };
    }
  }

  return { premature: false, details: "" };
}

/*
   IN -> ____|_____________________________________
        | getPartialConfirmationInstruction() | -> Txt
         -------------------------------------
      Returns the language-specific instruction to append when a premature
      confirmation is detected.
*/
function getPartialConfirmationInstruction(lang, classificationType) {
  return getLangPartialConfirmationInstruction(lang, classificationType);
}

/* Phrases that reveal the internal topological state of a specific element (multi-language). */
const stateRevealPatterns = getAllPatterns(stateRevealDict);

/*
   IN -> ____|_______________________
        | extractElementMentions() | -> [Txt]
         -------------------------
      Returns the evaluable elements (R1, C2, L3, D1, V1, ...) mentioned in the
      text, using word-boundary matching against the supplied element list.
*/
function extractElementMentions(text, evaluableElements) {
  if (!Array.isArray(evaluableElements) || evaluableElements.length === 0) {
    return [];
  }
  const found = [];
  const seen = {};
  const lower = text.toLowerCase();
  for (let i = 0; i < evaluableElements.length; i++) {
    const elem = evaluableElements[i];
    const lowerElem = String(elem).toLowerCase();
    const re = new RegExp(
      "(^|[^a-z0-9_])" + lowerElem.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "([^a-z0-9_]|$)",
      "i"
    );
    if (re.test(lower) && !seen[lowerElem]) {
      seen[lowerElem] = true;
      found.push(elem);
    }
  }
  return found;
}

/*
   IN -> ____|___________________
        | checkStateReveal() | -> Obj
         -------------------
      Detects whether the response reveals the internal/topological state of a
      mentioned evaluable element (rhetorical questions still count as leaks).
      Works with any element type. Returns { revealed, element, pattern,
      details }.
*/
function checkStateReveal(response, evaluableElements, extraPatterns) {
  const elems = Array.isArray(evaluableElements) && evaluableElements.length > 0
    ? evaluableElements
    : null;

  const mentioned = elems
    ? extractElementMentions(response, elems)
    : extractResistances(response);

  if (mentioned.length === 0) {
    return { revealed: false, details: "" };
  }

  const allPatterns = Array.isArray(extraPatterns) && extraPatterns.length > 0
    ? stateRevealPatterns.concat(extraPatterns)
    : stateRevealPatterns;

  const sentences = response.split(/[.!?\n]/);
  for (let i = 0; i < sentences.length; i++) {
    const sent = sentences[i];
    const sentLower = sent.toLowerCase();
    const sentMentioned = elems
      ? extractElementMentions(sent, elems)
      : extractResistances(sent);
    if (sentMentioned.length === 0) continue;

    for (let j = 0; j < allPatterns.length; j++) {
      if (sentLower.includes(allPatterns[j])) {
        return {
          revealed: true,
          element: sentMentioned[0],
          pattern: allPatterns[j],
          details: "Response reveals state of " + sentMentioned.join(", ") + " with: '" + allPatterns[j] + "'",
        };
      }
    }
  }

  return { revealed: false, details: "" };
}

/*
   IN -> ____|_________________________
        | loadConceptPatternsFromKG() | -> [Txt]
         ----------------------------
      Derives extra lowercase reveal phrases from a parsed knowledge graph
      (Node1/Node2/"AC name" fields) so the state-reveal check stays aligned
      with new concepts without editing hardcoded lists.
*/
function loadConceptPatternsFromKG(kg) {
  if (!Array.isArray(kg)) return [];
  const set = {};
  const push = function (s) {
    if (typeof s !== "string") return;
    const t = s.trim().toLowerCase();
    if (t && t.length >= 4 && t.length <= 60) set[t] = true;
  };
  for (let i = 0; i < kg.length; i++) {
    const entry = kg[i] || {};
    push(entry.Node1);
    push(entry.Node2);
    push(entry["AC name"]);
    push(entry["AC name.1"]);
  }
  return Object.keys(set);
}

/*
   IN -> ____|____________________________
        | getStateRevealInstruction() | -> Txt
         ----------------------------
      Returns the language-specific instruction to append when the tutor
      reveals the state of an element.
*/
function getStateRevealInstruction(lang) {
  return getLangStateRevealInstruction(lang);
}

/*
   IN -> ____|________________________
        | getStrongerInstruction() | -> Txt
         -------------------------
      Returns the language-specific instruction to append when a solution leak
      is detected, so the LLM regenerates without revealing.
*/
function getStrongerInstruction(lang) {
  return getLangStrongerInstruction(lang);
}

/* Directive verbs/phrases that point the student to a specific element, including soft "let's focus on" framings (multi-language). */
var directivePatterns = [
  /\b(analiza|observa|mira|fíjate en|considera|piensa en|revisa|examina|estudia)\b/i,
  /\b(look at|consider|analyze|think about|observe|examine|study|check)\b/i,
  /\b(analitza|observa|fixa't en|considera|pensa en|revisa|examina)\b/i,
  /\b(vamos a|centrémonos|hablemos|concentrémonos|pensemos|veamos|enfoqu[eé]monos|enfoc[ae]rnos)\b/i,
  /\b(let'?s focus|let'?s talk|let'?s analyze|let'?s consider|let'?s look|now think)\b/i,
  /\b(centrem-nos|parlem|pensem|vegem|enfoquem-nos)\b/i,
];

/*
   IN -> ____|____________________
        | checkElementNaming() | -> Obj
         --------------------
      Detects whether the tutor names a specific evaluable element inside a
      question or directive sentence (anti-Socratic). Returns { named, element,
      details }.
*/
function checkElementNaming(response, evaluableElements) {
  var regexElements = (response.match(/R\d+/gi) || []).map(function (s) { return s.toUpperCase(); });
  var seen = {};
  var elements = [];
  if (Array.isArray(evaluableElements)) {
    for (var i = 0; i < evaluableElements.length; i++) {
      var e = String(evaluableElements[i]).toUpperCase();
      if (!seen[e]) { seen[e] = true; elements.push(evaluableElements[i]); }
    }
  }
  for (var k = 0; k < regexElements.length; k++) {
    if (!seen[regexElements[k]]) { seen[regexElements[k]] = true; elements.push(regexElements[k]); }
  }
  if (elements.length === 0) {
    return { named: false, details: "" };
  }
  evaluableElements = elements;

  var sentences = response.split(/(?<=[.!?\n])\s*/);
  for (var i = 0; i < sentences.length; i++) {
    var sent = sentences[i];
    var sentLower = sent.toLowerCase();

    var isQuestion = sent.includes("?") || sent.includes("¿");
    var isDirective = false;
    for (var d = 0; d < directivePatterns.length; d++) {
      if (directivePatterns[d].test(sent)) {
        isDirective = true;
        break;
      }
    }

    if (!isQuestion && !isDirective) {
      continue;
    }

    for (var j = 0; j < evaluableElements.length; j++) {
      var elem = evaluableElements[j];
      var elemLower = elem.toLowerCase();
      var idx = sentLower.indexOf(elemLower);
      if (idx >= 0) {
        var charBefore = idx > 0 ? sentLower[idx - 1] : " ";
        var charAfter = idx + elemLower.length < sentLower.length ? sentLower[idx + elemLower.length] : " ";
        var validBefore = /[\s,;:(¿¡"'\-]/.test(charBefore) || idx === 0;
        var validAfter = /[\s,;:).?!"'\-]/.test(charAfter) || idx + elemLower.length === sentLower.length;

        if (validBefore && validAfter) {
          return {
            named: true,
            element: elem,
            details: "Response names '" + elem + "' in a " + (isQuestion ? "question" : "directive"),
          };
        }
      }
    }
  }

  return { named: false, details: "" };
}

/* Single-word confirmations that also open non-confirming idioms ("claro está que...", "justo por eso..."), guarded inside removeOpeningConfirmation. */
var AMBIGUOUS_SOLO_CONFIRM = ["claro", "clar", "justo"];

/*
   IN -> ____|___________________________
        | removeOpeningConfirmation() | -> Txt
         ----------------------------
      Iteratively strips confirmation phrases from the start of the response
      and re-capitalises the remaining text, preserving legitimate idioms and
      Spanish opening marks.
*/
function removeOpeningConfirmation(response, lang) {
  var result = response.trim();
  var changed = true;

  while (changed) {
    changed = false;
    var stripped = result.replace(/^[¡¿!\s]+/, "");
    var lowerResult = stripAccents(stripped.toLowerCase());

    for (var i = 0; i < confirmPhrases.length; i++) {
      var phraseLower = stripAccents(confirmPhrases[i]);
      if (lowerResult.startsWith(phraseLower)) {
        var nextChar = lowerResult.charAt(phraseLower.length);
        if (nextChar && /[a-zA-Z0-9ñü]/.test(nextChar)) {
          continue;
        }
        if (AMBIGUOUS_SOLO_CONFIRM.indexOf(phraseLower) >= 0) {
          var restAfterPhrase = lowerResult.slice(phraseLower.length).replace(/^\s+/, "");
          if (restAfterPhrase.length > 0 && /[a-z0-9ñü¿¡]/i.test(restAfterPhrase.charAt(0))) {
            continue;
          }
          if (lowerResult.charAt(phraseLower.length) === "?") {
            continue;
          }
        }
        var afterPhrase = stripped.substring(confirmPhrases[i].length).replace(/^[,;:!.\s]+/, "");
        result = afterPhrase;
        changed = true;
        break;
      }
    }
  }

  if (result !== response.trim() && result.length > 0) {
    var lead = result.match(/^[¿¡]+/);
    var at = lead ? lead[0].length : 0;
    if (at < result.length) {
      result = result.slice(0, at) + result.charAt(at).toUpperCase() + result.substring(at + 1);
    }
  }

  return result || response;
}

/*
   IN -> ____|____________________________
        | ensureResponseHasQuestion() | -> Txt
         ----------------------------
      Appends a generic Socratic question when the text contains none, so the
      turn always ends with a prompt for the student.
*/
function ensureResponseHasQuestion(text, lang) {
  if (typeof text !== "string" || text.length === 0) return text;
  if (text.includes("?")) return text;
  var fallback = {
    es: "¿Qué propiedad de ese elemento podrías analizar para decidirlo?",
    val: "Quina propietat d'eixe element podries analitzar per a decidir-ho?",
    en: "What property of that element could you analyse to decide?",
  };
  var q = fallback[lang] || fallback.es;
  var trimmed = text.replace(/\s+$/, "");
  if (trimmed.length === 0) return q;
  if (!/[.!?…]$/.test(trimmed)) trimmed = trimmed + ".";
  return trimmed + " " + q;
}

/* State-reveal placeholders per language; three variants each so repeated redactions rotate wording. */
var STATE_REVEAL_PLACEHOLDERS = {
  es: [
    "ese elemento tiene una propiedad relevante que debes identificar.",
    "hay una característica clave de ese elemento que aún no has nombrado.",
    "falta una pieza concreta del análisis para llegar a la conclusión.",
  ],
  val: [
    "eixe element té una propietat rellevant que has d'identificar.",
    "hi ha una característica clau d'eixe element que encara no has anomenat.",
    "falta una peça concreta de l'anàlisi per arribar a la conclusió.",
  ],
  en: [
    "that element has a relevant property you should identify.",
    "there is a key characteristic of that element you haven't named yet.",
    "a specific piece of the analysis is missing to reach the conclusion.",
  ],
};

/* Matches any state-reveal placeholder in any language; used by callers to count prior redaction hits. */
var STATE_REVEAL_PLACEHOLDER_REGEX = (function () {
  var all = [];
  Object.keys(STATE_REVEAL_PLACEHOLDERS).forEach(function (k) {
    STATE_REVEAL_PLACEHOLDERS[k].forEach(function (p) {
      all.push(p.replace(/\.$/, "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
    });
  });
  return new RegExp("(" + all.join("|") + ")", "i");
})();

/* Internal-state keywords that must not appear next to an evaluable element; shared across es/val/en. */
var STATE_LEAK_KEYWORDS = [
  "cortocircuitada", "cortocircuitado", "en cortocircuito", "está corto",
  "abierta", "abierto", "en abierto", "no contribuye", "no aporta",
  "no influye", "no afecta", "no funciona", "fuera del circuito",
  "sin función", "no juega ningún papel", "no participa",
  "curtcircuitada", "curtcircuitat", "en curtcircuit", "oberta", "obert",
  "no contribueix", "no aporta", "no influeix", "no afecta",
  "shorted", "short-circuited", "open-circuited", "is shorted",
  "doesn't contribute", "does not contribute", "doesn't affect",
  "out of circuit", "plays no role",
];

/*
   IN -> ____|______________________________
        | _sentenceLeaksElementState() | -> T/F
         -----------------------------
      True when the sentence pairs a state-leak keyword with a mentioned
      evaluable element.
*/
function _sentenceLeaksElementState(sentence, evaluableElements) {
  if (typeof sentence !== "string" || sentence.length === 0) return false;
  if (!Array.isArray(evaluableElements) || evaluableElements.length === 0) {
    return false;
  }
  var lower = sentence.toLowerCase();
  var hasStateKw = false;
  for (var i = 0; i < STATE_LEAK_KEYWORDS.length; i++) {
    if (lower.indexOf(STATE_LEAK_KEYWORDS[i]) !== -1) { hasStateKw = true; break; }
  }
  if (!hasStateKw) return false;
  var mentions = extractElementMentions(sentence, evaluableElements);
  return mentions.length > 0;
}

/*
   IN -> ____|_______________________
        | _pickStatePlaceholder() | -> Txt
         ------------------------
      Returns the placeholder variant for the given language and prior-hit
      count; an empty string once the bank is exhausted (suppress the sentence).
*/
function _pickStatePlaceholder(lang, priorHits) {
  var bank = STATE_REVEAL_PLACEHOLDERS[lang] || STATE_REVEAL_PLACEHOLDERS.es;
  var hits = typeof priorHits === "number" && priorHits >= 0 ? priorHits : 0;
  if (hits >= bank.length) return "";
  return bank[hits];
}

/*
   IN -> ____|___________________________
        | redactStateRevealSentence() | -> Obj
         ----------------------------
      Locates the first sentence that reveals element state, replaces it with a
      placeholder (or suppresses it after repeated hits), removes secondary
      leaks, and ensures the result still asks a question. Returns { text,
      redacted }.
*/
function redactStateRevealSentence(response, evaluableElements, pattern, lang, priorHits) {
  if (!pattern || !Array.isArray(evaluableElements) || evaluableElements.length === 0) {
    return { text: response, redacted: false };
  }
  var placeholder = _pickStatePlaceholder(lang || "es", priorHits || 0);
  var suppress = placeholder === "";

  var sentences = response.split(/(?<=[.!?\n])/);
  var redacted = false;
  var patternFolded = stripAccents(pattern.toLowerCase());
  for (var i = 0; i < sentences.length; i++) {
    var sent = sentences[i];
    var lowerSent = sent.toLowerCase();
    if (!stripAccents(lowerSent).includes(patternFolded)) continue;

    var mentions = extractElementMentions(sent, evaluableElements);
    if (mentions.length === 0) continue;

    if (suppress) {
      sentences[i] = "";
      redacted = true;
      break;
    }
    var p = placeholder;
    if (i === 0) {
      p = p.charAt(0).toUpperCase() + p.slice(1);
    } else {
      var prev = sentences[i - 1].trimEnd();
      if (/[.!?…]$/.test(prev)) {
        p = " " + p.charAt(0).toUpperCase() + p.slice(1);
      } else if (!prev.endsWith(" ")) {
        p = " " + p;
      }
    }
    sentences[i] = p + " ";
    redacted = true;
    for (var j = i + 1; j < sentences.length; j++) {
      if (_sentenceLeaksElementState(sentences[j], evaluableElements)) {
        sentences[j] = "";
      }
    }
    break;
  }
  var out = sentences.join("");
  out = out.replace(/([.!?…])(?=[A-ZÁÉÍÓÚÑ¿¡])/g, "$1 ").replace(/ {2,}/g, " ");
  if (redacted) {
    out = ensureResponseHasQuestion(out, lang);
  }
  return { text: out, redacted: redacted };
}

/*
   IN -> ____|_______________________
        | redactElementMentions() | -> Obj
         ------------------------
      Last-resort redaction: rewrites correct-element mentions inside
      questions/directives to a grammatical generic placeholder, then fixes
      agreement/gender and ensures a question remains. Returns { text,
      redacted }.
*/
function redactElementMentions(response, correctAnswer, lang) {
  if (!Array.isArray(correctAnswer) || correctAnswer.length === 0) {
    return { text: response, redacted: false };
  }

  var placeholders = {
    es: "ese conjunto de elementos",
    val: "eixe conjunt d'elements",
    en: "that set of elements",
  };
  var placeholder = placeholders[lang] || placeholders.es;

  var text = response;
  var changed = false;

  var inflected = {
    es: { sing: "esa resistencia", plural: "esas resistencias" },
    val: { sing: "eixa resistència", plural: "eixes resistències" },
    en: { sing: "that resistor", plural: "those resistors" },
  };
  var infl = inflected[lang] || inflected.es;

  var nounElementPattern = new RegExp(
    "\\b(?:la|el|las|los)\\s+(?:resistencias?|resist[èe]nc(?:ia|ies)|componentes?|elementos?|dispositivos?|resistors?)\\s+R\\d+(?:\\s*(?:,|;|y|i|and|or)\\s*R\\d+)*\\b",
    "gi"
  );
  if (nounElementPattern.test(text)) {
    text = text.replace(nounElementPattern, function (match) {
      var isList = /,|;|\by\b|\bi\b|\band\b|\bor\b/.test(match);
      return isList ? infl.plural : infl.sing;
    });
    changed = true;
  }

  var joined = correctAnswer.slice().map(function (r) {
    return r.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  });
  var listPattern = new RegExp(
    "\\(?\\s*" + joined.join("\\s*[,;y]\\s*|\\s*(?:y|i|and)\\s*") + "\\s*\\)?",
    "gi"
  );
  var tolerantPattern = new RegExp(
    "\\(?" + joined[0] +
      joined.slice(1).map(function (r) {
        return "\\s*(?:,|;|y|i|and)\\s*" + r;
      }).join("") +
      "\\)?",
    "gi"
  );
  if (tolerantPattern.test(text)) {
    text = text.replace(tolerantPattern, placeholder);
    changed = true;
  }

  var sentences = text.match(/[^.!?\n]+[.!?\n]+\s*|[^.!?\n]+$/g) || [text];
  for (var i = 0; i < sentences.length; i++) {
    var sent = sentences[i];
    var isQuestion = sent.includes("?") || sent.includes("¿");
    var isDirective = false;
    for (var d = 0; d < directivePatterns.length; d++) {
      if (directivePatterns[d].test(sent)) { isDirective = true; break; }
    }
    if (!isQuestion && !isDirective) continue;

    var newSent = sent;

    var runPattern = new RegExp(
      "\\(?\\bR\\d+\\b(?:\\s*(?:,|;|y|i|and|or)\\s*\\bR\\d+\\b)+\\)?",
      "gi"
    );
    if (runPattern.test(newSent)) {
      newSent = newSent.replace(runPattern, placeholder);
      changed = true;
    }

    for (var j = 0; j < correctAnswer.length; j++) {
      var elem = correctAnswer[j];
      var safe = elem.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      var re = new RegExp("\\b" + safe + "\\b", "gi");
      if (re.test(newSent)) {
        newSent = newSent.replace(re, placeholder);
        changed = true;
      }
    }

    var safePlaceholder = placeholder.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    var dupePattern = new RegExp(
      "(?:" + safePlaceholder + ")(?:\\s*(?:,|;|y|i|and|or)\\s*" + safePlaceholder + ")+",
      "gi"
    );
    if (dupePattern.test(newSent)) {
      newSent = newSent.replace(dupePattern, placeholder);
      changed = true;
    }

    sentences[i] = newSent;
  }
  text = sentences.join("");

  if (changed) {
    text = ensureResponseHasQuestion(text, lang);
    text = fixPlaceholderAgreement(text, lang);
    text = fixPlaceholderGender(text, lang);
  }
  return { text: text, redacted: changed };
}

/*
   IN -> ____|_____________________
        | fixPlaceholderGender() | -> Txt
         ----------------------
      Reconciles a feminine predicate inherited from "resistencias" with the
      masculine placeholder "esos elementos" within the same sentence (Spanish
      only).
*/
function fixPlaceholderGender(text, lang) {
  if (typeof text !== "string" || text.length === 0) return text;
  if (lang && lang !== "es") return text;
  if (!/esos\s+elementos/i.test(text)) return text;
  var femToMasc = [
    [/\blas\s+correctas\b/gi, "los correctos"],
    [/\blas\s+incorrectas\b/gi, "los incorrectos"],
    [/\blas\s+adecuadas\b/gi, "los adecuados"],
    [/\blas\s+necesarias\b/gi, "los necesarios"],
    [/\blas\s+relevantes\b/gi, "los relevantes"],
    [/\blas\s+importantes\b/gi, "los importantes"],
    [/\blas\s+que\b/gi, "los que"],
  ];
  for (var r = 0; r < femToMasc.length; r++) {
    text = text.replace(femToMasc[r][0], femToMasc[r][1]);
  }
  return text;
}

/*
   IN -> ____|_______________________
        | fixOpeningAntecedent() | -> Txt
         ----------------------
      When prior passes leave the bubble opening with an orphan plural
      demonstrative, rewrites it to a form with an explicit antecedent
      ("Algunos de los elementos que has propuesto..."). Operates only at the
      start of the text.
*/
function fixOpeningAntecedent(text, lang) {
  if (typeof text !== "string" || text.length === 0) return text;
  var rules = {
    es: [
      [/^(\s*)esos\s+elementos\b(?=[^.?!]{0,80}\b(?:contribuyen|aportan|afectan|influyen|cuentan|importan|forman|determinan|son|están)\b)/i,
        "$1Algunos de los elementos que has propuesto"],
      [/^(\s*)ese\s+conjunto\s+de\s+elementos\b/i,
        "$1Alguno de los elementos que has propuesto"],
    ],
    val: [
      [/^(\s*)eixos\s+elements\b(?=[^.?!]{0,80}\b(?:contribueixen|afecten|aporten|determinen|importen|tenen|inclouen|estan|són)\b)/i,
        "$1Alguns dels elements que has proposat"],
      [/^(\s*)eixe\s+conjunt\s+d['e]\s*elements\b/i,
        "$1Algun dels elements que has proposat"],
    ],
    en: [
      [/^(\s*)those\s+elements\b(?=[^.?!]{0,80}\b(?:contribute|affect|matter|count|determine|include|have|are)\b)/i,
        "$1Some of the elements you proposed"],
      [/^(\s*)that\s+set\s+of\s+elements\b/i,
        "$1Some of the elements you proposed"],
    ],
  };
  var langRules = rules[lang] || rules.es;
  for (var i = 0; i < langRules.length; i++) {
    var rule = langRules[i];
    if (rule[0].test(text)) {
      text = text.replace(rule[0], rule[1]);
      break;
    }
  }
  return text;
}

/*
   IN -> ____|________________________
        | fixPlaceholderAgreement() | -> Txt
         -------------------------
      Promotes the singular placeholder to its plural form when it combines
      with a clearly plural verb in the same sentence.
*/
function fixPlaceholderAgreement(text, lang) {
  if (typeof text !== "string" || text.length === 0) return text;
  var rules = {
    es: [
      [/\bese\s+conjunto\s+de\s+elementos\b(?=[^.?!]{0,80}\b(?:contribuyen|afectan|aportan|son|cuentan|determinan|importan|forman|tienen|incluyen|están)\b)/gi,
        "esos elementos"],
      [/\b(?:son|eran|están|estaban)\s+ese\s+conjunto\s+de\s+elementos\b/gi,
        function (m) {
          return m.replace(/ese\s+conjunto\s+de\s+elementos/i, "esos elementos");
        }],
    ],
    val: [
      [/\beixe\s+conjunt\s+d['e]\s*elements\b(?=[^.?!]{0,80}\b(?:contribueixen|afecten|aporten|són|determinen|importen|tenen|inclouen|estan)\b)/gi,
        "eixos elements"],
    ],
    en: [
      [/\bthat\s+set\s+of\s+elements\b(?=[^.?!]{0,80}\b(?:contribute|affect|matter|are|count|determine|include|have)\b)/gi,
        "those elements"],
    ],
  };
  var langRules = rules[lang] || rules.es;
  for (var i = 0; i < langRules.length; i++) {
    var rule = langRules[i];
    text = text.replace(rule[0], rule[1]);
  }
  return text;
}

/* Didactic "tells" that signal the tutor is explaining a concept rather than scaffolding with questions (multi-language). */
const didacticExplanationPatterns = [
  "esto significa que",
  "esto quiere decir que",
  "eso significa",
  "lo que significa es",
  "cuando una resistencia está",
  "cuando un componente está",
  "si una resistencia está",
  "si dos puntos están al mismo potencial",
  "entonces no fluye",
  "entonces no circula",
  "entonces no pasa corriente",
  "impide que la corriente fluya",
  "impide que circule corriente",
  "no permite que pase corriente",
  "se puede eliminar del circuito",
  "se comporta como",
  "equivale a",
  "es equivalente a",
  "exacto, cuando",
  "correcto, cuando",
  "això significa que",
  "això vol dir que",
  "quan una resistència està",
  "quan un component està",
  "si dos punts estan al mateix potencial",
  "impedeix que el corrent passe",
  "no permet que passe corrent",
  "this means that",
  "that means",
  "what this means is",
  "when a resistor is",
  "when a component is",
  "if two points are at the same potential",
  "prevents current from flowing",
  "does not allow current to flow",
  "it can be removed from the circuit",
  "acts as",
  "is equivalent to",
  "exactly, when",
];

/*
   IN -> ____|___________________________
        | checkDidacticExplanation() | -> Obj
         ---------------------------
      Detects whether the response explains a concept instead of asking, by
      matching didactic-tell patterns. Returns { explaining, pattern, details }.
*/
function checkDidacticExplanation(response) {
  if (typeof response !== "string" || response.length === 0) {
    return { explaining: false, details: "" };
  }
  const lower = response.toLowerCase();
  for (let i = 0; i < didacticExplanationPatterns.length; i++) {
    const p = didacticExplanationPatterns[i];
    if (lower.includes(p)) {
      return {
        explaining: true,
        pattern: p,
        details: "Response contains didactic explanation pattern: '" + p + "'",
      };
    }
  }
  return { explaining: false, details: "" };
}

/*
   IN -> ____|________________________
        | getScaffoldInstruction() | -> Txt
         -------------------------
      Returns the language-specific instruction asking the LLM to rewrite a
      didactic explanation as a single scaffolding question.
*/
function getScaffoldInstruction(lang) {
  if (lang === "en") {
    return "\n\nIMPORTANT: Your previous answer explained a concept instead of asking. Rewrite your response as ONE single scaffolding question about a visible feature of the circuit. Do not define, do not explain, do not reveal states. Only ask.";
  }
  if (lang === "val") {
    return "\n\nIMPORTANT: La teua resposta anterior explicava un concepte en compte de preguntar. Reescriu la resposta com UNA sola pregunta d'andamiatge sobre una característica visible del circuit. No definisques, no expliques, no reveles estats. Només pregunta.";
  }
  return "\n\nIMPORTANTE: Tu respuesta anterior explicaba un concepto en lugar de preguntar. Reescribe la respuesta como UNA sola pregunta de andamiaje sobre una característica visible del circuito. No definas, no expliques, no reveles estados. Solo pregunta.";
}

/*
   IN -> ____|_____________________
        | enforceDatasetStyle() | -> Obj
         ----------------------
      Last-mile formatter: deterministically strips markdown headings, bold,
      emphasis, bullet and numbered-list markers so the response matches the
      dataset's concise-prose style. Returns { text, changed }.
*/
function enforceDatasetStyle(response) {
  if (typeof response !== "string") return response;
  var text = response;
  var changed = false;

  text = text.replace(/^\s{0,3}#{1,6}\s+/gm, function () { changed = true; return ""; });

  text = text.replace(/\*\*(.+?)\*\*/g, function (_, inner) { changed = true; return inner; });
  text = text.replace(/__(.+?)__/g, function (_, inner) { changed = true; return inner; });

  text = text.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, function (_, pre, inner) { changed = true; return pre + inner; });

  text = text.replace(/^\s*[-*•]\s+/gm, function () { changed = true; return ""; });

  text = text.replace(/^\s*\d+[.)]\s+/gm, function () { changed = true; return ""; });

  text = text.replace(/\n{3,}/g, "\n\n");

  text = text.trim();

  return { text: text, changed: changed };
}

module.exports = {
  checkSolutionLeak, getStrongerInstruction,
  checkFalseConfirmation, getFalseConfirmationInstruction,
  checkPrematureConfirmation, getPartialConfirmationInstruction,
  checkStateReveal, getStateRevealInstruction,
  checkElementNaming, removeOpeningConfirmation,
  redactElementMentions,
  fixPlaceholderAgreement,
  fixOpeningAntecedent,
  redactStateRevealSentence,
  STATE_REVEAL_PLACEHOLDER_REGEX,
  ensureResponseHasQuestion,
  extractElementMentions,
  loadConceptPatternsFromKG,
  enforceDatasetStyle,
  checkDidacticExplanation,
  getScaffoldInstruction,
};
