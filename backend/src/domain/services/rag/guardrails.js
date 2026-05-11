// Checks if the LLM response reveals the correct answer

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

// Phrases that indicate the tutor is revealing the solution directly (multi-language)
const revealPhrases = getAllPatterns(revealDict);

// Extract all resistance mentions (R1, R2, ...) 
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

// Check if two arrays contain the same elements (order doesn't matter)
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

// Check if all elements of subset exist in superset
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

// Check if the response reveals the correct answer
function checkSolutionLeak(response, correctAnswer) {
  const lower = response.toLowerCase();
  const mentioned = extractResistances(response);

  // If the response doesn't mention all correct resistances, no leak possible
  if (!containsAll(mentioned, correctAnswer)) {
    return {
      leaked: false,
      details: ""
    };
  }

  // Check 1: explicit reveal phrase + all correct resistances mentioned
  for (let i = 0; i < revealPhrases.length; i++) {
    if (lower.includes(revealPhrases[i])) {
      return {
        leaked: true,
        details: "Response contains reveal phrase: '" + revealPhrases[i] + "' with all correct resistances",
      };
    }
  }

  // Check 2: all correct resistances listed together in one sentence (e.g. "R1, R2 y R4")
  // Build pattern like "R1,?\s*(R2)?\s*y\s*R4" to catch "R1, R2 y R4" style listings
  if (correctAnswer.length >= 2) {
    const sorted = correctAnswer.slice().sort();
    // Build a regex: R1[,\s]+R2[,\s]+...[\sy]+Rn
    let pattern = sorted[0];
    for (let i = 1; i < sorted.length; i++) {
      pattern += "[,\\s]+(y\\s+)?" + sorted[i];
    }
    const regex = new RegExp(pattern, "i");
    if (regex.test(response)) {
      // Only flag if the sentence is affirmative (not a question)
      // Find the sentence containing the match
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

// Normalize accented characters for accent-insensitive matching
function stripAccents(str) {
  return str.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

// Affirmative phrases that indicate the tutor is confirming a student's statement (multi-language)
const confirmPhrases = getAllPatterns(confirmDict);

// Check if the tutor is incorrectly confirming a wrong answer
// classification must be wrong_answer, wrong_concept, or similar
function checkFalseConfirmation(response, classification) {
  // Only check when the student's answer is wrong
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

  // Check if response starts with or contains a confirmation phrase in the first 60 chars
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

// Instruction to append when a false confirmation is detected
function getFalseConfirmationInstruction(lang) {
  return getLangFalseConfirmationInstruction(lang);
}

// Check if the tutor prematurely confirms a partially correct answer
// (correct resistances but missing or wrong reasoning)
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

// Instruction to append when a premature confirmation is detected
function getPartialConfirmationInstruction(lang, classificationType) {
  return getLangPartialConfirmationInstruction(lang, classificationType);
}

// Phrases that reveal the state of a specific resistance (internal topology info, multi-language)
const stateRevealPatterns = getAllPatterns(stateRevealDict);

// Extract mentions of any evaluable element in a text.
// Works for any element identifier (R1, C2, L3, D1, V1, I2, etc.) as long as
// it's passed in `evaluableElements`. Uses word-boundary matching.
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

// Check if the response reveals the internal state / topological property of
// a specific evaluable element (cortocircuitada, en abierto, en serie, en
// paralelo, misma potencial, etc.). Generic: works with any element type
// (resistencias, condensadores, inductores, diodos...). Does NOT allow
// rhetorical questions: "¿recuerdas que R5 está cortocircuitada?" is still a
// leak because it tells the student the state.
//
// @param {string} response
// @param {string[]} [evaluableElements] - list of element ids from the exercise
// @param {string[]} [extraPatterns] - additional reveal patterns (e.g. loaded from KG)
function checkStateReveal(response, evaluableElements, extraPatterns) {
  // Backward compatible: if no evaluableElements passed, fall back to Rn regex
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

// Extract additional concept patterns from the knowledge graph so the state
// reveal check stays aligned with new concepts without editing hardcoded lists.
// Reads Node1/Node2/"AC name" fields and derives simple lowercase forms.
//
// @param {object[]} kg - parsed knowledge graph JSON
// @returns {string[]} additional phrases that, if asserted alongside an
//                     evaluable element, imply state reveal.
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

// Instruction to append when the tutor reveals the state of a resistance
function getStateRevealInstruction(lang) {
  return getLangStateRevealInstruction(lang);
}

// Instruction to append to the prompt when a leak is detected, so the LLM regenerates without revealing
function getStrongerInstruction(lang) {
  return getLangStrongerInstruction(lang);
}

// =====================
// Guardrail 5: Element Naming in Questions (generic)
// =====================

// Directive verbs/phrases that indicate the tutor is pointing the student to
// a specific element. Includes the obvious imperatives plus the "let's focus
// on", "let's discuss", "now think about" framings the LLM often uses to
// sneak in element naming as a soft directive.
var directivePatterns = [
  /\b(analiza|observa|mira|fíjate en|considera|piensa en|revisa|examina|estudia)\b/i,
  /\b(look at|consider|analyze|think about|observe|examine|study|check)\b/i,
  /\b(analitza|observa|fixa't en|considera|pensa en|revisa|examina)\b/i,
  // "Vamos a / centrémonos / hablemos / concentrémonos / pensemos / veamos"
  /\b(vamos a|centrémonos|hablemos|concentrémonos|pensemos|veamos|enfoqu[eé]monos|enfoc[ae]rnos)\b/i,
  // English variants: "let's focus", "let's talk", "now think", "let's analyze"
  /\b(let'?s focus|let'?s talk|let'?s analyze|let'?s consider|let'?s look|now think)\b/i,
  // Valencian variants
  /\b(centrem-nos|parlem|pensem|vegem|enfoquem-nos)\b/i,
];

// Check if the tutor names a specific evaluable element in a question or directive
function checkElementNaming(response, evaluableElements) {
  // Fallback: if the exercise's elementosEvaluables is empty or missing some
  // elements, also check any R\d+ tokens in the response. Naming a specific
  // element in a question/directive is anti-Socratic regardless of whether
  // the domain registered it as "evaluable".
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

  // Split into sentences
  var sentences = response.split(/(?<=[.!?\n])\s*/);
  for (var i = 0; i < sentences.length; i++) {
    var sent = sentences[i];
    var sentLower = sent.toLowerCase();

    // Check if this sentence is a question or a directive
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

    // Check if any evaluable element is named in this sentence
    for (var j = 0; j < evaluableElements.length; j++) {
      var elem = evaluableElements[j];
      var elemLower = elem.toLowerCase();
      var idx = sentLower.indexOf(elemLower);
      if (idx >= 0) {
        // Word boundary check
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

// Utility: remove opening confirmation phrases from a response
// Used when the guardrail retry still produces a confirmation — we strip it and prepend a deterministic prefix
// Iteratively strips all confirmation phrases from the start to avoid contradictions like:
// "Hmm, no estoy seguro. Exacto, en un cortocircuito..." → "Hmm, no estoy seguro. En un cortocircuito..."
function removeOpeningConfirmation(response, lang) {
  var result = response.trim();
  var changed = true;

  // Iteratively strip confirmation phrases from the beginning
  while (changed) {
    changed = false;
    // Strip leading punctuation (¡, ¿, !, spaces) before matching
    var stripped = result.replace(/^[¡¿!\s]+/, "");
    var lowerResult = stripAccents(stripped.toLowerCase());

    for (var i = 0; i < confirmPhrases.length; i++) {
      var phraseLower = stripAccents(confirmPhrases[i]);
      if (lowerResult.startsWith(phraseLower)) {
        // BUG FIX (2026-04-27): word-boundary check tras la phrase.
        // confirmPhrases incluye prefijos como "eso es" (length 6) y un
        // input como "Eso está muy bien" hacía .startsWith("eso es") = true
        // — el séptimo char "t" no se comparaba — y el strip de 6 chars
        // dejaba "ta muy bien dicho..." → capitalizado "Tá muy bien dicho".
        // Si el char inmediatamente después de la phrase es una letra,
        // estamos dentro de una palabra: NO match.
        var nextChar = lowerResult.charAt(phraseLower.length);
        if (nextChar && /[a-zA-Z0-9ñü]/.test(nextChar)) {
          continue; // dentro de palabra, no es la phrase real
        }
        // Strip the phrase and any following punctuation/whitespace
        var afterPhrase = stripped.substring(confirmPhrases[i].length).replace(/^[,;:!.\s¡¿]+/, "");
        result = afterPhrase;
        changed = true;
        break;
      }
    }
  }

  // If we stripped something, capitalize the first letter of remaining text
  if (result !== response.trim() && result.length > 0) {
    result = result.charAt(0).toUpperCase() + result.substring(1);
  }

  return result || response;
}

// If the redaction stripped the only sentence that carried a question (or
// the LLM never produced one), append a generic Socratic question so the
// student still has something to react to. Without this, hardcoded patterns
// firing inside questions ("circula corriente por R5?") get redacted into a
// pure affirmation and the turn ends without a prompt for the student.
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
  // Make sure we end the previous sentence cleanly before appending the
  // question. The sentence may end in punctuation already; if not, add a
  // period so the two sentences don't pegote.
  if (!/[.!?…]$/.test(trimmed)) trimmed = trimmed + ".";
  return trimmed + " " + q;
}

// Surgical redaction: locate the sentence that reveals element state and
// replace the element mention + the state/concept pattern with a generic
// placeholder, keeping the rest of the response intact. Used as the last
// resort when the LLM retries couldn't clean a state-reveal.
//
// NS-31 (2026-05-03): only the FIRST matching sentence is redacted. Before
// this, when the LLM emitted the same state-reveal twice in one response
// (a common echo pattern with qwen2.5 7B), the placeholder was injected
// twice, producing visible duplicates like:
//   "Bien encaminado. Ese elemento tiene una propiedad relevante. Ahora
//    piensa en R1. Ese elemento tiene una propiedad relevante."
// If the LLM still has additional reveals after the first redaction, the
// outer pipeline can either retry once more or the surrounding tutor
// banner (NS-30) will catch the structural violation on the next turn.
// BUG-009-B (2026-05-03): tres variantes de placeholder por idioma + supresión
// tras 3 disparos. Antes el alumno leía la misma frase
// "Ese elemento tiene una propiedad relevante…" 3 turnos seguidos. Ahora
// rotamos el wording según priorHits (cuántos turnos previos dispararon ya
// el redactor en esta conversación). Con priorHits >= 3 devolvemos cadena
// vacía: la frase con state-reveal se elimina sin sustituto y
// ensureResponseHasQuestion garantiza que sigue habiendo pregunta socrática.
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

// Cualquiera de las variantes anteriores en cualquier idioma — usado por
// callers para contar disparos previos en la historia de la conversación.
var STATE_REVEAL_PLACEHOLDER_REGEX = (function () {
  var all = [];
  Object.keys(STATE_REVEAL_PLACEHOLDERS).forEach(function (k) {
    STATE_REVEAL_PLACEHOLDERS[k].forEach(function (p) {
      // sin el "." final para tolerar variantes con/sin punto
      all.push(p.replace(/\.$/, "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
    });
  });
  return new RegExp("(" + all.join("|") + ")", "i");
})();

// BUG-012 (2026-05-03): keywords de estado interno que NO deben aparecer
// junto a un Rn evaluable. Lista compartida por es/val/en porque el matching
// es lowercase y la mayoría de términos son cognados o muy similares. Si en
// el futuro hay falsos positivos por idioma se puede separar por lang.
var STATE_LEAK_KEYWORDS = [
  // ES
  "cortocircuitada", "cortocircuitado", "en cortocircuito", "está corto",
  "abierta", "abierto", "en abierto", "no contribuye", "no aporta",
  "no influye", "no afecta", "no funciona", "fuera del circuito",
  "sin función", "no juega ningún papel", "no participa",
  // VAL
  "curtcircuitada", "curtcircuitat", "en curtcircuit", "oberta", "obert",
  "no contribueix", "no aporta", "no influeix", "no afecta",
  // EN
  "shorted", "short-circuited", "open-circuited", "is shorted",
  "doesn't contribute", "does not contribute", "doesn't affect",
  "out of circuit", "plays no role",
];

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

function _pickStatePlaceholder(lang, priorHits) {
  var bank = STATE_REVEAL_PLACEHOLDERS[lang] || STATE_REVEAL_PLACEHOLDERS.es;
  var hits = typeof priorHits === "number" && priorHits >= 0 ? priorHits : 0;
  if (hits >= bank.length) return ""; // suprimir tras 3 disparos
  return bank[hits];
}

function redactStateRevealSentence(response, evaluableElements, pattern, lang, priorHits) {
  if (!pattern || !Array.isArray(evaluableElements) || evaluableElements.length === 0) {
    return { text: response, redacted: false };
  }
  // BUG-009 (2026-05-03): el placeholder DEBE terminar en "." porque la
  // continuación que añade el LLM (o la pregunta socrática que añade
  // ensureResponseHasQuestion) suele empezar por mayúscula sin signo de
  // apertura. Antes confiábamos en _normaliseWhitespace para insertar el
  // espacio entre placeholder y siguiente frase, pero el normaliser no
  // añade puntuación, sólo espacios — el alumno acababa leyendo
  // "identificar Podrías decirme..." sin separación frástica ni "¿".
  var placeholder = _pickStatePlaceholder(lang || "es", priorHits || 0);
  var suppress = placeholder === "";

  var sentences = response.split(/(?<=[.!?\n])\s*/);
  var redacted = false;
  for (var i = 0; i < sentences.length; i++) {
    var sent = sentences[i];
    var lowerSent = sent.toLowerCase();
    if (!lowerSent.includes(pattern.toLowerCase())) continue;

    var mentions = extractElementMentions(sent, evaluableElements);
    if (mentions.length === 0) continue;

    // BUG-009-B: con priorHits >= 3 suprimimos la frase entera (sin
    // placeholder) — el alumno ha visto el banner ya 3 veces, mejor
    // dejar sólo la pregunta socrática que el LLM continúa. La función
    // ensureResponseHasQuestion garantiza que sigue habiendo "?".
    if (suppress) {
      sentences[i] = "";
      redacted = true;
      break;
    }
    // Capitalise the first letter of the placeholder. When it is the
    // first sentence of the response (i === 0) we still need to start
    // with a capital — otherwise the rendered text reads "ese elemento
    // tiene…" which was flagged as broken. When it follows another
    // sentence we additionally need a leading space so we don't pegote
    // ("…avances!Ese elemento…").
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
    // Trailing space garantizado: la siguiente frase puede empezar por
    // "¿"/letra y no queremos pegoteo "identificar.¿Podrías…". El
    // normaliser colapsa cualquier doble espacio resultante.
    sentences[i] = p + " ";
    redacted = true;
    // BUG-012 (2026-05-03): NS-31 paraba tras la primera redacción para no
    // duplicar el placeholder. Pero qwen2.5 a veces emite DOS frases con
    // state-reveal y elementos DISTINTOS en la misma respuesta (ej.
    // "A R1 contribuye [estado]. R5 no lo hace debido a estar cortocircuitada").
    // El primer redactado convierte la frase de R1 en placeholder y NS-31 paraba
    // ahí, dejando la frase de R5 intacta — leak de R5 al alumno. Solución:
    // tras el primer placeholder NO paramos; recorremos las restantes y
    // ELIMINAMOS (sin reinyectar placeholder) cualquier frase que mencione
    // un Rn evaluable + un keyword de estado conocido. Conservamos la regla
    // de no duplicar placeholders y a la vez eliminamos los leaks secundarios.
    for (var j = i + 1; j < sentences.length; j++) {
      if (_sentenceLeaksElementState(sentences[j], evaluableElements)) {
        sentences[j] = "";
      }
    }
    break;
  }
  var out = sentences.join("");
  if (redacted) {
    // NS-34: hardcoded state patterns can fire inside questions (e.g. "¿No es
    // raro que pase corriente por R5?"). When the redacted sentence WAS the
    // only one carrying a "?" the student is left without any prompt — append
    // a generic Socratic continuation so the turn still asks something.
    out = ensureResponseHasQuestion(out, lang);
  }
  return { text: out, redacted: redacted };
}

// Deterministic last-resort redaction: if after retries the response still
// names correct elements in questions/directives, rewrite those mentions to a
// generic placeholder. Prefers a clunky-but-safe message over a leak.
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

  // Per-language inflected placeholders for "noun + Rn" rewrites.
  // Without these the redaction left clunky ungrammatical fragments such as
  // "la resistencia ese conjunto de elementos no contribuye" (the LLM had
  // written "la resistencia R5", we only rewrote R5, and "la resistencia"
  // became dangling). We now consume the noun + Rn(+more Rn) as a unit
  // and substitute "esa resistencia" / "esas resistencias" (singular /
  // plural) so the surrounding sentence still parses naturally.
  var inflected = {
    es: { sing: "esa resistencia", plural: "esas resistencias" },
    val: { sing: "eixa resistència", plural: "eixes resistències" },
    en: { sing: "that resistor", plural: "those resistors" },
  };
  var infl = inflected[lang] || inflected.es;

  // 0) Pre-pase: consume "(la|el|las|los) (resistencia|componente|elemento|
  //    dispositivo|resistor[s]) Rn[, Rn, …]" entera. Esto resuelve el bug
  //    "la resistencia <placeholder> no contribuye" sin tocar el resto del
  //    flujo (los pasos 1 y 2 siguen aplicando para los Rn que aparezcan
  //    sin sustantivo delante).
  var nounElementPattern = new RegExp(
    "\\b(?:la|el|las|los)\\s+(?:resistencias?|resist[èe]nc(?:ia|ies)|componentes?|elementos?|dispositivos?|resistors?)\\s+R\\d+(?:\\s*(?:,|;|y|i|and|or)\\s*R\\d+)*\\b",
    "gi"
  );
  if (nounElementPattern.test(text)) {
    text = text.replace(nounElementPattern, function (match) {
      // Plural si el match incluye lista (",", "y", "i", "and", "or").
      var isList = /,|;|\by\b|\bi\b|\band\b|\bor\b/.test(match);
      return isList ? infl.plural : infl.sing;
    });
    changed = true;
  }

  // 1) Replace comma-separated lists like "(R1, R2, R4)" / "R1, R2 y R4" / "R1, R2 and R4"
  var joined = correctAnswer.slice().map(function (r) {
    return r.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  });
  var listPattern = new RegExp(
    "\\(?\\s*" + joined.join("\\s*[,;y]\\s*|\\s*(?:y|i|and)\\s*") + "\\s*\\)?",
    "gi"
  );
  // simpler & more tolerant pattern: "R1, R2 y R4" (es) / "i" (val) / "and" (en) / commas.
  // No consume \s* exterior — sin esto, "que R1, R2 y R4 contribuyen" perdía
  // los espacios alrededor y el resultado quedaba "queese conjunto de
  // elementoscontribuyen" (mismo bug de espacios que afectaba a step 2a).
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

  // 2) Replace any remaining individual mention of a correct element inside
  //    a question or directive sentence.
  //
  // BUG FIX (2026-04-27): el split anterior `text.split(/(?<=[.!?\n])\s*/)`
  // consumía los whitespace separadores y luego `sentences.join("")` los
  // perdía, dando salidas como "...revisar.Tá muy bien dicho.Ahora,...".
  // Usamos `.match` con un patrón que CAPTURA cada sentence + su trailing
  // whitespace, así el join final preserva la separación natural.
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

    // 2a. Collapse RUNS of element mentions in the same sentence into ONE
    //     placeholder. Without this, "¿Por qué R3, R5 y R1?" was redacted as
    //     "ese conjunto, ese conjunto y ese conjunto" — gibberish that
    //     surfaced in the chat. The pattern matches Rn (+ inner separators
    //     + Rn)+ but does NOT consume the surrounding whitespace — otherwise
    //     "que R1, R2 y R4 afectan" would lose its boundary spaces and
    //     produce "queese conjunto de elementosafectan". Optional parens are
    //     consumed so "(R1, R2 y R4)" collapses cleanly.
    var runPattern = new RegExp(
      "\\(?\\bR\\d+\\b(?:\\s*(?:,|;|y|i|and|or)\\s*\\bR\\d+\\b)+\\)?",
      "gi"
    );
    if (runPattern.test(newSent)) {
      newSent = newSent.replace(runPattern, placeholder);
      changed = true;
    }

    // 2b. Replace any remaining LONE element mention (a single Rn left after
    //     collapsing runs).
    for (var j = 0; j < correctAnswer.length; j++) {
      var elem = correctAnswer[j];
      var safe = elem.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      var re = new RegExp("\\b" + safe + "\\b", "gi");
      if (re.test(newSent)) {
        newSent = newSent.replace(re, placeholder);
        changed = true;
      }
    }

    // 2c. After redacting, collapse repeated identical placeholders that may
    //     remain when redaction collided with surrounding connectors (e.g.
    //     "ese conjunto, ese conjunto y ese conjunto").
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
    // NS-34: when the LLM listed the correct elements as a pure affirmation
    // ("La respuesta es R1, R2 y R4."), the redacted sentence loses any
    // pedagogical scaffold and the response ends without a question. Append
    // a generic Socratic continuation in that case.
    text = ensureResponseHasQuestion(text, lang);
    // BUG-004: post-pass de concordancia. "ese conjunto de elementos" es
    // singular pero el verbo cercano suele estar en plural ("contribuyen",
    // "afectan", "son"). Detectamos la combinación y promovemos a "esos
    // elementos" (genérico, plural, gramatical). No tocamos los casos en
    // singular que sí concuerdan ("ese conjunto de elementos contribuye").
    text = fixPlaceholderAgreement(text, lang);
  }
  return { text: text, redacted: changed };
}

// Cuando los pases previos (redactElementMentions + removeOpeningConfirmation)
// dejan el bubble empezando con un demostrativo plural huérfano — p.ej.
// "esos elementos sí contribuyen a la tensión…" — el lector entra sin
// antecedente: ¿qué elementos? El demostrativo apuntaba a la lista que
// acabamos de redactar. Esta función promueve la apertura a una forma con
// antecedente explícito ("Algunos de los elementos que has propuesto…") que
// se lee como primera frase del bubble sin perder neutralidad pedagógica
// (sigue sin nombrar elementos concretos). Sólo opera al INICIO del texto;
// las ocurrencias intermedias mantienen "esos elementos" porque ahí sí hay
// antecedente en la oración anterior.
function fixOpeningAntecedent(text, lang) {
  if (typeof text !== "string" || text.length === 0) return text;
  var rules = {
    es: [
      // "esos elementos {sí}? <verbo plural> …" al inicio.
      [/^(\s*)esos\s+elementos\b(?=[^.?!]{0,80}\b(?:contribuyen|aportan|afectan|influyen|cuentan|importan|forman|determinan|son|están)\b)/i,
        "$1Algunos de los elementos que has propuesto"],
      // "ese conjunto de elementos" residual (si fixPlaceholderAgreement no
      // aplicó por ausencia de verbo plural cercano).
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

// Concordancia placeholder ↔ verbo. Sólo actúa cuando el placeholder
// singular se combina con un verbo claramente plural en la misma frase.
function fixPlaceholderAgreement(text, lang) {
  if (typeof text !== "string" || text.length === 0) return text;
  // Pares (regex sing → plural)
  var rules = {
    es: [
      // "ese conjunto de elementos contribuyen|afectan|aportan|son|cuentan|determinan"
      [/\bese\s+conjunto\s+de\s+elementos\b(?=[^.?!]{0,80}\b(?:contribuyen|afectan|aportan|son|cuentan|determinan|importan|forman|tienen|incluyen|están)\b)/gi,
        "esos elementos"],
      // pegado entre Es y verbo cercano: "...son ese conjunto de elementos..."
      [/\b(?:son|eran|están|estaban)\s+ese\s+conjunto\s+de\s+elementos\b/gi,
        function (m) {
          // Mantén el verbo, sólo cambia el sintagma nominal.
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

// Detect when the tutor is EXPLAINING a concept instead of asking. Pedagogically,
// the student must derive the concept; the tutor must only scaffold with questions.
// This check is triggered when the assistant response contains didactic "tells"
// such as "this means that...", "when X is Y, then Z", "exactly, when...", etc.
// Multi-language (es/val/en). Returns { explaining: bool, pattern, details }.
const didacticExplanationPatterns = [
  // es
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
  // val
  "això significa que",
  "això vol dir que",
  "quan una resistència està",
  "quan un component està",
  "si dos punts estan al mateix potencial",
  "impedeix que el corrent passe",
  "no permet que passe corrent",
  // en
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

// Instruction returned to the LLM when a didactic explanation is detected,
// asking it to rewrite as a single scaffolding question.
function getScaffoldInstruction(lang) {
  if (lang === "en") {
    return "\n\nIMPORTANT: Your previous answer explained a concept instead of asking. Rewrite your response as ONE single scaffolding question about a visible feature of the circuit. Do not define, do not explain, do not reveal states. Only ask.";
  }
  if (lang === "val") {
    return "\n\nIMPORTANT: La teua resposta anterior explicava un concepte en compte de preguntar. Reescriu la resposta com UNA sola pregunta d'andamiatge sobre una característica visible del circuit. No definisques, no expliques, no reveles estats. Només pregunta.";
  }
  return "\n\nIMPORTANTE: Tu respuesta anterior explicaba un concepto en lugar de preguntar. Reescribe la respuesta como UNA sola pregunta de andamiaje sobre una característica visible del circuito. No definas, no expliques, no reveles estados. Solo pregunta.";
}

// Last-mile formatter: the dataset style is concise prose with a single final
// question. When the LLM ignores the prompt and returns bullets / bold /
// headings / numbered lists, we strip them deterministically. Non-destructive:
// keeps the original if it already looks clean.
function enforceDatasetStyle(response) {
  if (typeof response !== "string") return response;
  var text = response;
  var changed = false;

  // Strip markdown headings "# ...", "## ...", "### ..."
  text = text.replace(/^\s{0,3}#{1,6}\s+/gm, function () { changed = true; return ""; });

  // Strip **bold** and __bold__ markers (keep the inner text)
  text = text.replace(/\*\*(.+?)\*\*/g, function (_, inner) { changed = true; return inner; });
  text = text.replace(/__(.+?)__/g, function (_, inner) { changed = true; return inner; });

  // Strip single-asterisk emphasis *word* but NOT wildcards (keep inner)
  text = text.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, function (_, pre, inner) { changed = true; return pre + inner; });

  // Remove bullet markers at the start of lines ("- ", "* ", "• ")
  text = text.replace(/^\s*[-*•]\s+/gm, function () { changed = true; return ""; });

  // Remove numbered-list markers at the start of lines ("1. ", "2) ", ...)
  text = text.replace(/^\s*\d+[.)]\s+/gm, function () { changed = true; return ""; });

  // Collapse multiple blank lines
  text = text.replace(/\n{3,}/g, "\n\n");

  // Trim edges
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
