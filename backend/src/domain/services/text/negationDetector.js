"use strict";

// Shared negation detection service. This is the KEY extraction — previously
// only queryClassifier used it (for student input). Guardrails did NOT check
// for negation, so "No es exactamente así" triggered false_confirmation on the
// word "exactamente". With isNegatedInContext(), guardrails can now suppress
// false positives when the confirmation phrase is actually negated.
//
// Multi-language: Spanish, Valencian, English.

// ─── Negation dictionaries ───────────────────────────────────────────────────

/**
 * Single-word negation markers BEFORE an element/phrase.
 * 15-char pre-window by default — tight to avoid false positives.
 */
const PRE_NEGATION_WORDS = [
  // es
  "no", "sin", "ni", "tampoco", "excepto", "salvo", "menos", "quitando", "descartando",
  // val
  "sense", "tampoc", "excepte", "llevat de", "menys",
  // en
  "not", "without", "nor", "neither", "except", "excluding",
];

/**
 * Multi-word negation PHRASES before an element. 30-char pre-window.
 * Multi-word phrases are less prone to false positives.
 */
const PRE_NEGATION_PHRASES = [
  // es — flow negation before element
  "no pasa corriente por", "no circula corriente por", "no pasa por",
  "no circula por", "no fluye por", "no hay corriente en", "no hay corriente por",
  "no es", "no son", "no están", "no está",
  // val
  "no passa corrent per", "no circula corrent per", "no passa per",
  "no és", "no són",
  // en
  "no current flows through", "current doesn't flow through",
  "no current through", "doesn't flow through",
  "is not", "are not", "isn't", "aren't",
];

/**
 * Phrases AFTER an element that indicate negation of that element.
 * 25-char post-window, truncated at sentence boundary.
 */
const POST_NEGATION_PHRASES = [
  // es — direct rejection
  "no contribuye", "no participa", "no afecta", "no influye", "no cuenta",
  "no interviene", "se elimina", "se descarta", "sobra", "no importa",
  "no tiene que ver", "es incorrecto", "es incorrecta", "está mal",
  "no es", "no forma parte", "no es relevante",
  // es — flow/current negation
  "no circula", "no pasa corriente", "no fluye", "no hay corriente",
  "no tiene corriente", "no pasa", "no llega",
  // val — direct rejection
  "no contribueix", "no participa", "no afecta", "no influeix", "no compta",
  "s'elimina", "es descarta", "no té a veure", "és incorrecte",
  "no és", "no forma part", "no és rellevant",
  // val — flow negation
  "no circula", "no passa corrent", "no flueix", "no hi ha corrent",
  // en — direct rejection
  "doesn't contribute", "does not contribute", "doesn't affect", "does not affect",
  "is not relevant", "isn't part", "doesn't matter", "is wrong", "is incorrect",
  "should not", "shouldn't be", "is not", "isn't",
  // en — flow negation
  "no current flows", "current doesn't flow", "no current", "doesn't flow",
  // es — state description (implies element is excluded)
  "está en abierto", "en abierto", "en circuito abierto",
  "está cortocircuitada", "está cortocircuitado", "cortocircuitada", "cortocircuitado",
  "en cortocircuito", "en corto",
  // val — state description
  "està en obert", "en circuit obert", "curtcircuitada", "curtcircuitat", "en curtcircuit",
  // en — state description
  "is open", "is shorted", "is short-circuited", "in open circuit", "in short circuit",
];

// ─── Core detection primitives ───────────────────────────────────────────────

const DEFAULT_PRE_WINDOW = 15;
const DEFAULT_PRE_PHRASE_WINDOW = 30;
const DEFAULT_POST_WINDOW = 25;

/**
 * Check whether a single-word negation marker appears immediately before
 * `position` in `lowerText`, within `window` characters and as a word
 * boundary match.
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

/**
 * Check whether a multi-word negation phrase appears before `position`
 * within `window` characters.
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

/**
 * Check whether a negation phrase appears AFTER `position + elementLength`,
 * within `window` characters, not crossing sentence boundaries.
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

// ─── High-level APIs ─────────────────────────────────────────────────────────

/**
 * Used by classifier: is the element at `position` (length `elementLength`)
 * negated within its local context?
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

/**
 * Used by guardrails: does the given `phrase` appear in `message` with a
 * negation context just before it? e.g. "No es exactamente así" → true
 * for phrase="exactamente". Accent-insensitive is the caller's responsibility
 * (pass a normalized message + phrase if needed).
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
