"use strict";

/*------------------------------------------------------------------------------
            _________________________________________________________
            |                   NEGATION DETECTOR                   |
            |  Shared multi-language (es/val/en) negation detection   |
            |  service. Used by the classifier on student input and   |
            |  by the guardrails to suppress false confirmations when |
            |  a confirmation phrase is actually negated.            |
        ____|________________                                       |
   Txt, N, N -> | hasPreNegationWord()   | -> T/F                   |
                ---------------------------                         |
   Txt, N, N -> | hasPreNegationPhrase() | -> T/F                   |
                ---------------------------                         |
   Txt, N, N, N -> | hasPostNegation()   | -> T/F                   |
                   ------------------------                         |
   Txt, N, N -> | detectNegationAround() | -> T/F                   |
                ---------------------------                         |
   Txt, Txt -> | isNegatedInContext()    | -> T/F                   |
               ----------------------------                         |
            |_______________________________________________________|
------------------------------------------------------------------------------*/

/*
   Single-word negation markers BEFORE an element/phrase. 15-char pre-window
   by default, tight to avoid false positives.
*/
const PRE_NEGATION_WORDS = [
  "no", "sin", "ni", "tampoco", "excepto", "salvo", "menos", "quitando", "descartando",
  "sense", "tampoc", "excepte", "llevat de", "menys",
  "not", "without", "nor", "neither", "except", "excluding",
];

/*
   Multi-word negation PHRASES before an element. 30-char pre-window;
   multi-word phrases are less prone to false positives.
*/
const PRE_NEGATION_PHRASES = [
  "no pasa corriente por", "no circula corriente por", "no pasa por",
  "no circula por", "no fluye por", "no hay corriente en", "no hay corriente por",
  "no es", "no son", "no están", "no está",
  "no passa corrent per", "no circula corrent per", "no passa per",
  "no és", "no són",
  "no current flows through", "current doesn't flow through",
  "no current through", "doesn't flow through",
  "is not", "are not", "isn't", "aren't",
];

/*
   Phrases AFTER an element that negate it. 25-char post-window, truncated
   at the sentence boundary.
*/
const POST_NEGATION_PHRASES = [
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
  "está cortocircuitada", "está cortocircuitado", "cortocircuitada", "cortocircuitado",
  "en cortocircuito", "en corto",
  "està en obert", "en circuit obert", "curtcircuitada", "curtcircuitat", "en curtcircuit",
  "is open", "is shorted", "is short-circuited", "in open circuit", "in short circuit",
];

const DEFAULT_PRE_WINDOW = 15;
const DEFAULT_PRE_PHRASE_WINDOW = 30;
const DEFAULT_POST_WINDOW = 25;

/*
   Txt, N, N -> ____|_____________________
               | hasPreNegationWord() | -> T/F
                ------------------------
      True when a single-word negation marker sits immediately before
      position in lowerText, within window chars and as a word-boundary match.
*/
function hasPreNegationWord(lowerText, position, window) {
  const w = window != null ? window : DEFAULT_PRE_WINDOW;
  const preStart = Math.max(0, position - w);
  const prefix = lowerText.substring(preStart, position);
  for (let i = 0; i < PRE_NEGATION_WORDS.length; i++) {
    const word = PRE_NEGATION_WORDS[i];
    const idx = prefix.lastIndexOf(word);
    if (idx >= 0) {
      const charBefore = idx > 0 ? prefix[idx - 1] : " ";
      const endPos = idx + word.length;
      const charAfter = endPos < prefix.length ? prefix[endPos] : " ";
      const boundBefore = /[\s,;:(]/.test(charBefore) || idx === 0;
      const boundAfter = /[\s,;:)]/.test(charAfter) || endPos === prefix.length;
      if (boundBefore && boundAfter) return true;
    }
  }
  return false;
}

/*
   Txt, N, N -> ____|_______________________
               | hasPreNegationPhrase() | -> T/F
                --------------------------
      True when a multi-word negation phrase appears before position within
      window chars.
*/
function hasPreNegationPhrase(lowerText, position, window) {
  const w = window != null ? window : DEFAULT_PRE_PHRASE_WINDOW;
  const preStart = Math.max(0, position - w);
  const prefix = lowerText.substring(preStart, position);
  for (let i = 0; i < PRE_NEGATION_PHRASES.length; i++) {
    if (prefix.includes(PRE_NEGATION_PHRASES[i])) return true;
  }
  return false;
}

/*
   Txt, N, N, N -> ____|__________________
                  | hasPostNegation() | -> T/F
                   ---------------------
      True when a negation phrase appears after position + elementLength
      within window chars, without crossing a sentence boundary.
*/
function hasPostNegation(lowerText, position, elementLength, window) {
  const w = window != null ? window : DEFAULT_POST_WINDOW;
  const postStart = position + elementLength;
  const postEnd = Math.min(lowerText.length, postStart + w);
  let suffix = lowerText.substring(postStart, postEnd);
  const sentBoundary = suffix.search(/[.!?]/);
  if (sentBoundary >= 0) suffix = suffix.substring(0, sentBoundary);
  for (let i = 0; i < POST_NEGATION_PHRASES.length; i++) {
    if (suffix.includes(POST_NEGATION_PHRASES[i])) return true;
  }
  return false;
}

/*
   Txt, N, N -> ____|________________________
               | detectNegationAround() | -> T/F
                ---------------------------
      Classifier API: true when the element at position (length elementLength)
      is negated within its local context (pre-word, pre-phrase or post).
*/
function detectNegationAround(message, position, elementLength) {
  if (typeof message !== "string") return false;
  const lower = message.toLowerCase();
  return (
    hasPreNegationWord(lower, position) ||
    hasPreNegationPhrase(lower, position) ||
    hasPostNegation(lower, position, elementLength)
  );
}

/*
   Txt, Txt -> ____|_______________________
              | isNegatedInContext() | -> T/F
               ------------------------
      Guardrails API: true when phrase appears in message with a negation
      context just before it ("No es exactamente así" -> true for
      "exactamente"). Accent-insensitivity is the caller's responsibility.
*/
function isNegatedInContext(message, phrase) {
  if (typeof message !== "string" || typeof phrase !== "string") return false;
  const lower = message.toLowerCase();
  const needle = phrase.toLowerCase();
  const idx = lower.indexOf(needle);
  if (idx < 0) return false;
  return (
    hasPreNegationWord(lower, idx) ||
    hasPreNegationPhrase(lower, idx)
  );
}

module.exports = {
  PRE_NEGATION_WORDS: PRE_NEGATION_WORDS,
  PRE_NEGATION_PHRASES: PRE_NEGATION_PHRASES,
  POST_NEGATION_PHRASES: POST_NEGATION_PHRASES,
  hasPreNegationWord: hasPreNegationWord,
  hasPreNegationPhrase: hasPreNegationPhrase,
  hasPostNegation: hasPostNegation,
  detectNegationAround: detectNegationAround,
  isNegatedInContext: isNegatedInContext,
};
