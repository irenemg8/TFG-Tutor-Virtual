/*------------------------------------------------------------------------------
            _________________________________________________________
            |                        GUARDRAILS                     |
            |  Post-generation safety checks for the tutor LLM. Each |
            |  checker inspects a response and reports whether it    |
            |  leaks the solution, falsely confirms, reveals element |
            |  states, directs the student, introduces new elements  |
            |  or mixes languages; paired getters return the         |
            |  corrective instruction to append on a retry.          |
            |  LEGACY duplicate kept under src/rag/ for A/B testing   |
            |  against the hexagonal guardrail pipeline.             |
        ____|_____________________                                   |
   Txt -> | extractResistances() | -> [Txt]                          |
          ------------------------                                   |
        ____|___________                                             |
 [Txt],[Txt] -> | sameSet() | -> T/F                                 |
          -------------                                              |
        ____|_______________                                         |
 [Txt],[Txt] -> | containsAll() | -> T/F                             |
          -----------------                                          |
        ____|___________________                                     |
 Txt,[Txt] -> | checkSolutionLeak() | -> Obj                         |
          ----------------------                                     |
        ____|_________________________                               |
 Txt,Txt -> | checkFalseConfirmation() | -> Obj                      |
          ---------------------------                                |
        ____|________________________________                        |
        | getFalseConfirmationInstruction() | -> Txt                 |
          ------------------------------------                       |
        ____|_______________________                                 |
   Txt -> | checkStateReveal() | -> Obj                              |
          --------------------                                       |
        ____|_____________________________                           |
        | getStateRevealInstruction() | -> Txt                       |
          ------------------------------                             |
        ____|_________________________                               |
        | getStrongerInstruction() | -> Txt                          |
          ---------------------------                                |
        ____|_______________________                                 |
   Txt -> | getForbiddenScripts() | -> [Txt]                         |
          ------------------------                                   |
        ____|____________________                                    |
 Txt,Txt -> | checkLanguageMix() | -> Obj                            |
          --------------------                                       |
        ____|______________________________                          |
        | getLanguageMixInstruction() | -> Txt                       |
          ------------------------------                             |
        ____|_________________________                               |
 Txt,[Txt] -> | checkAnswerDirective() | -> Obj                      |
          ------------------------                                   |
        ____|_________________________________                       |
        | getAnswerDirectiveInstruction() | -> Txt                   |
          ----------------------------------                         |
        ____|______________________________                          |
 Txt,[Txt],[Txt] -> | checkNewElementIntroduction() | -> Obj         |
          --------------------------------                           |
        ____|______________________________________                  |
        | getNewElementIntroductionInstruction() | -> Txt            |
          -----------------------------------------                  |
            |                                                       |
            |_______________________________________________________|
------------------------------------------------------------------------------*/

const revealPhrases = [
  "la respuesta es", "la respuesta correcta es", "las resistencias son", "las resistencias correctas son", "la solución es",
  "deberías responder", "la respuesta sería", "las resistencias por las que circula corriente son",
  "las resistencias por las que no circula corriente son", "la respuesta final es", "la solución correcta es",
  "son precisamente", "son exactamente", "las que contribuyen son", "las que influyen son",
  "depende de", "dependen de", "las resistencias que contribuyen", "las resistencias relevantes son",
  "las resistencias que afectan", "las resistencias correctas son", "la respuesta correcta sería",
];

/*
   IN -> ____|________________
        | extractResistances() | -> [Txt]
         ------------------------
      Returns the unique, upper-cased resistance tokens (R1, R2, ...)
      found in the text, preserving first-seen order.
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
   IN -> ____|________
        | sameSet() | -> T/F
         -------------
      True when both arrays hold the same elements regardless of order.
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
   IN -> ____|____________
        | containsAll() | -> T/F
         ----------------
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
   IN -> ____|_________________
        | checkSolutionLeak() | -> Obj
         ----------------------
      Reports { leaked, details }: flags a leak when the response names
      all correct resistances together with a reveal phrase, or lists
      them all in one affirmative (non-question) sentence.
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

const confirmPhrases = [
  "perfecto", "correcto", "exacto", "exactamente", "muy bien",
  "eso es", "así es", "bien hecho", "en efecto", "efectivamente",
  "has identificado correctamente", "estás en lo correcto",
  "buena observación", "buen trabajo",
];

/*
   IN -> ____|_____________________
        | checkFalseConfirmation() | -> Obj
         --------------------------
      Reports { confirmed, details }: when the classification is a wrong
      answer/concept/single word, flags a confirmation phrase appearing
      in the first 60 characters of the response.
*/
function checkFalseConfirmation(response, classification) {
  const checkTypes = ["wrong_answer", "wrong_concept", "single_word"];
  var shouldCheck = false;
  for (let i = 0; i < checkTypes.length; i++) {
    if (classification === checkTypes[i]) {
      shouldCheck = true;
      break;
    }
  }
  if (!shouldCheck) {
    return { confirmed: false, details: "" };
  }

  const lower = response.toLowerCase().trim();

  const firstPart = lower.substring(0, 60);
  for (let i = 0; i < confirmPhrases.length; i++) {
    if (firstPart.includes(confirmPhrases[i])) {
      return {
        confirmed: true,
        details: "Response confirms wrong answer with: '" + confirmPhrases[i] + "'",
      };
    }
  }

  return { confirmed: false, details: "" };
}

/*
       ____|____________________________
      | getFalseConfirmationInstruction() | -> Txt
       ------------------------------------
      Corrective instruction appended on a false-confirmation retry.
*/
function getFalseConfirmationInstruction() {
  return (
    "\n\nCRÍTICO: Tu respuesta anterior CONFIRMÓ como correcto algo que el alumno dijo MAL. " +
    "El alumno se ha equivocado. NO debes decir 'Perfecto', 'Correcto', 'Exactamente', 'Muy bien' ni nada similar. " +
    "Debes hacerle una pregunta socrática que le haga reconsiderar su error. " +
    "NO le digas directamente cuál es el error, pero tampoco le confirmes algo incorrecto."
  );
}

const stateRevealPatterns = [
  "está cortocircuitad",
  "está en cortocircuito",
  "está en circuito abierto",
  "está en abierto",
  "está en serie",
  "está en paralelo",
  "no circula corriente por",
  "no pasa corriente por",
  "circula corriente por",
  "pasa corriente por",
  "tiene corriente cero",
  "tiene tensión cero",
  "tiene diferencia de potencial cero",
  "no tiene caída de tensión",
  "ambos terminales",
  "mismo nudo",
  "mismo punto",
];

/*
   IN -> ____|_______________
        | checkStateReveal() | -> Obj
         --------------------
      Reports { revealed, details }: flags an affirmative sentence that
      names a resistance together with a state-reveal phrase. Questions
      are allowed.
*/
function checkStateReveal(response) {
  const lower = response.toLowerCase();
  const resistances = extractResistances(response);

  if (resistances.length === 0) {
    return { revealed: false, details: "" };
  }

  const sentences = response.split(/[.!?\n]/);
  for (let i = 0; i < sentences.length; i++) {
    const sentLower = sentences[i].toLowerCase();
    const sentResistances = extractResistances(sentences[i]);
    if (sentResistances.length === 0) {
      continue;
    }

    for (let j = 0; j < stateRevealPatterns.length; j++) {
      if (sentLower.includes(stateRevealPatterns[j])) {
        if (sentences[i].trim().endsWith("?") || sentLower.includes("¿")) {
          continue;
        }
        return {
          revealed: true,
          details: "Response reveals state of " + sentResistances.join(", ") + " with: '" + stateRevealPatterns[j] + "'",
        };
      }
    }
  }

  return { revealed: false, details: "" };
}

/*
       ____|_______________________
      | getStateRevealInstruction() | -> Txt
       ------------------------------
      Corrective instruction appended on a state-reveal retry.
*/
function getStateRevealInstruction() {
  return (
    "\n\nCRÍTICO: Tu respuesta anterior REVELÓ el estado de una resistencia directamente (cortocircuitada, abierto, etc.). " +
    "Esa información es INTERNA y el alumno debe descubrirla por sí mismo. " +
    "NO digas el estado de ninguna resistencia. En su lugar, haz una pregunta socrática que guíe al alumno " +
    "a analizar el circuito y descubrir el estado por sí mismo. " +
    "Por ejemplo: '¿Qué observas en los nudos donde está conectada esa resistencia?'"
  );
}

/*
       ____|____________________
      | getStrongerInstruction() | -> Txt
       --------------------------
      Corrective instruction appended on a solution-leak retry.
*/
function getStrongerInstruction() {
  return (
    "\n\nCRÍTICO: Tu respuesta anterior reveló la solución directamente. " +
    "NO debes listar las resistencias correctas juntas. NO debes decir cuáles son las resistencias correctas. " +
    "NO debes confirmar respuestas incorrectas del alumno como correctas. " +
    "En su lugar, haz UNA sola pregunta socrática corta que guíe al estudiante."
  );
}

var SCRIPT_PATTERNS = {
  cjk: /[\u4E00-\u9FFF\u3400-\u4DBF]/g,
  cyrillic: /[\u0400-\u04FF]/g,
  arabic: /[\u0600-\u06FF\u0750-\u077F]/g,
  thai: /[\u0E00-\u0E7F]/g,
  devanagari: /[\u0900-\u097F]/g,
  hangul: /[\uAC00-\uD7AF\u1100-\u11FF]/g,
  kana: /[\u3040-\u309F\u30A0-\u30FF]/g,
};

var LATIN_LANGS = {
  af:1, ca:1, cs:1, cy:1, da:1, de:1, en:1, es:1, et:1, eu:1, fi:1, fr:1,
  ga:1, gl:1, hr:1, hu:1, id:1, is:1, it:1, lt:1, lv:1, ms:1, nl:1, no:1,
  pl:1, pt:1, ro:1, sk:1, sl:1, sq:1, sv:1, tl:1, tr:1, vi:1,
};

/*
   IN -> ____|___________________
        | getForbiddenScripts() | -> [Txt]
         ------------------------
      Returns the Unicode-script names that must not appear in a
      response written in the given language code.
*/
function getForbiddenScripts(langCode) {
  if (LATIN_LANGS[langCode]) {
    return ["cjk", "cyrillic", "arabic", "thai", "devanagari", "hangul", "kana"];
  }
  if (langCode === "zh" || langCode === "ja") return ["cyrillic", "arabic", "thai", "devanagari", "hangul"];
  if (langCode === "ko") return ["cyrillic", "arabic", "thai", "devanagari"];
  if (langCode === "ru" || langCode === "uk" || langCode === "bg") return ["cjk", "arabic", "thai", "devanagari", "hangul", "kana"];
  if (langCode === "ar" || langCode === "fa") return ["cjk", "cyrillic", "thai", "devanagari", "hangul", "kana"];
  if (langCode === "th") return ["cjk", "cyrillic", "arabic", "devanagari", "hangul", "kana"];
  if (langCode === "hi" || langCode === "mr") return ["cjk", "cyrillic", "arabic", "thai", "hangul", "kana"];
  return [];
}

/*
   IN -> ____|________________
        | checkLanguageMix() | -> Obj
         --------------------
      Reports { mixed, details, detectedScript }: flags a response that
      contains 2+ characters from a script forbidden for the user's
      language.
*/
function checkLanguageMix(response, userLangCode) {
  if (!userLangCode || typeof response !== "string") {
    return { mixed: false, details: "" };
  }

  var forbidden = getForbiddenScripts(userLangCode);
  for (var i = 0; i < forbidden.length; i++) {
    var scriptName = forbidden[i];
    var regex = SCRIPT_PATTERNS[scriptName];
    if (!regex) continue;
    var matches = response.match(regex);
    if (matches && matches.length >= 2) {
      return {
        mixed: true,
        details: "Response contains " + matches.length + " " + scriptName + " characters but user language is " + userLangCode,
        detectedScript: scriptName,
      };
    }
  }

  return { mixed: false, details: "" };
}

/*
       ____|______________________
      | getLanguageMixInstruction() | -> Txt
       ------------------------------
      Corrective instruction appended on a language-mix retry.
*/
function getLanguageMixInstruction() {
  return (
    "\n\nCRITICAL: Your previous response MIXED LANGUAGES — you switched to a completely different language mid-response. " +
    "This is unacceptable. You MUST write your ENTIRE response in the SAME language as the student's last message. " +
    "Do NOT include any words, phrases, or characters from another language. " +
    "Every single word must be in the student's language."
  );
}

const directivePhrases = [
  "no olvides", "no te olvides", "recuerda que", "recuerda considerar",
  "considera ", "analiza ", "piensa en ", "ten en cuenta ",
  "fíjate en ", "también deberías", "deberías considerar", "deberías analizar",
  "no dejes de considerar", "hay que tener en cuenta",
  "por qué no consideraste", "por qué no has considerado", "por qué no incluyes",
  "por qué no mencionaste", "por qué no has mencionado", "por qué no incluiste",
  "qué pasa con ", "qué ocurre con ", "qué hay de ", "y qué hay de ",
  "has pensado en ", "has considerado ",
  "don't forget", "do not forget", "don\u2019t forget", "consider ",
  "analyze ", "analyse ", "think about ", "look at ",
  "take into account", "remember that ", "you should also",
  "you should consider", "also consider", "keep in mind",
  "why didn't you consider", "why didn't you include", "why didn't you mention",
  "what about ", "what happens with ", "have you considered ",
  "have you thought about ", "did you consider ",
  "n'oublie pas", "ne oublie pas", "n'oubliez pas", "ne oubliez pas",
  "consid\u00e8re ", "consid\u00e9rer ", "pense \u00e0 ", "pensez \u00e0 ",
  "regarde ", "regardez ", "analyse ", "analysez ",
  "tiens compte", "tenez compte", "tu devrais aussi", "vous devriez aussi",
  "rappele", "rappelle", "il faut aussi", "il faut consid\u00e9rer",
  "pourquoi tu n'as pas considéré", "pourquoi n'as-tu pas", "qu'en est-il de ",
  "et pour ", "as-tu pensé à ",
  "vergiss nicht", "denk an ", "denke an ", "betrachte ",
  "analysiere ", "ber\u00fccksichtige ", "du solltest auch",
  "was ist mit ", "hast du an ",
  "non dimenticare", "non dimenticarti", "considera ", "analizza ",
  "pensa a ", "ricorda ", "ricordati di", "tieni conto",
  "che ne dici di ", "hai considerato ",
  "no oblidis", "considera ", "analitza ", "pensa en ", "recorda ",
  "per què no has considerat", "què passa amb ",
];

/*
   IN -> ____|_____________________
        | checkAnswerDirective() | -> Obj
         ------------------------
      Reports { directed, details }: flags a sentence that names a
      correct-answer element together with a directive phrase, in any
      supported language and including question forms.
*/
function checkAnswerDirective(response, answerElements) {
  if (!Array.isArray(answerElements) || answerElements.length === 0) {
    return { directed: false, details: "" };
  }

  var lowerElements = [];
  for (var k = 0; k < answerElements.length; k++) {
    lowerElements.push(String(answerElements[k]).toLowerCase());
  }

  var sentences = response.split(/[.\n]/);
  for (var i = 0; i < sentences.length; i++) {
    var sentLower = sentences[i].toLowerCase();

    var foundElement = null;
    for (var m = 0; m < lowerElements.length; m++) {
      if (sentLower.includes(lowerElements[m])) {
        foundElement = answerElements[m];
        break;
      }
    }
    if (!foundElement) continue;

    for (var j = 0; j < directivePhrases.length; j++) {
      if (sentLower.includes(directivePhrases[j])) {
        return {
          directed: true,
          details: "Response directs student to '" + foundElement + "' with: '" + directivePhrases[j].trim() + "'",
        };
      }
    }
  }

  return { directed: false, details: "" };
}

/*
       ____|__________________________
      | getAnswerDirectiveInstruction() | -> Txt
       ----------------------------------
      Corrective instruction appended on an answer-directive retry.
*/
function getAnswerDirectiveInstruction() {
  return (
    "\n\nCR\u00cdTICO: Tu respuesta anterior LE DIJO al alumno qu\u00e9 elemento considerar o analizar. " +
    "Eso da parte de la respuesta. El alumno debe descubrir los elementos relevantes POR S\u00cd MISMO. " +
    "NUNCA digas 'no olvides X', 'considera Y', 'piensa en Z', 'ten en cuenta W', etc. " +
    "En su lugar, haz una pregunta CONCEPTUAL que le lleve a descubrir el elemento que le falta. " +
    "Por ejemplo: '\u00bfHay otros caminos por los que pueda circular corriente entre esos puntos?' o " +
    "'\u00bfQu\u00e9 otros componentes est\u00e1n conectados entre esos dos puntos del circuito?'"
  );
}

/*
   IN -> ____|____________________________
        | checkNewElementIntroduction() | -> Obj
         --------------------------------
      Reports { introduced, details }: flags the response when it names
      a correct-answer element, or any R-token, that the student has
      never mentioned.
*/
function checkNewElementIntroduction(response, studentMentioned, answerElements) {
  if (!Array.isArray(answerElements) || answerElements.length === 0) {
    return { introduced: false, details: "" };
  }

  var mentionedSet = {};
  if (Array.isArray(studentMentioned)) {
    for (var i = 0; i < studentMentioned.length; i++) {
      mentionedSet[String(studentMentioned[i]).toUpperCase().trim()] = true;
    }
  }

  var responseLower = response.toLowerCase();
  for (var j = 0; j < answerElements.length; j++) {
    var elem = String(answerElements[j]).toUpperCase().trim();
    if (!mentionedSet[elem] && responseLower.includes(elem.toLowerCase())) {
      return {
        introduced: true,
        details: "Response names '" + elem + "' which the student has never mentioned",
      };
    }
  }

  var responseResistances = extractResistances(response);
  for (var k = 0; k < responseResistances.length; k++) {
    if (!mentionedSet[responseResistances[k]]) {
      return {
        introduced: true,
        details: "Response names '" + responseResistances[k] + "' which the student has never mentioned",
      };
    }
  }

  return { introduced: false, details: "" };
}

/*
       ____|________________________________
      | getNewElementIntroductionInstruction() | -> Txt
       -----------------------------------------
      Corrective instruction appended on a new-element retry.
*/
function getNewElementIntroductionInstruction() {
  return (
    "\n\nCR\u00cdTICO: Tu respuesta anterior NOMBR\u00d3 una resistencia que el alumno NUNCA ha mencionado. " +
    "NO puedes introducir resistencias nuevas. Solo puedes referirte a resistencias que el alumno ya haya nombrado. " +
    "Si el alumno no ha descubierto todas las resistencias, haz una pregunta CONCEPTUAL que le lleve a descubrirlas: " +
    "'\u00bfHay otros caminos por los que pueda circular corriente?', '\u00bfCrees que todas las resistencias contribuyen?' " +
    "NUNCA nombres una resistencia que el alumno no haya mencionado antes."
  );
}

module.exports = { checkSolutionLeak, getStrongerInstruction, checkFalseConfirmation, getFalseConfirmationInstruction, checkStateReveal, getStateRevealInstruction, checkLanguageMix, getLanguageMixInstruction, checkAnswerDirective, getAnswerDirectiveInstruction, checkNewElementIntroduction, getNewElementIntroductionInstruction };
