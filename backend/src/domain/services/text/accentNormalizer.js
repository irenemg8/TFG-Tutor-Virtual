"use strict";

// Accent-insensitive string normalization.
// Used by classifier (match student input without accents) AND by guardrails
// (match LLM output without accents). Single source of truth.

/**
 * Strip diacritical marks from a string using NFD normalization.
 * "tensión" → "tension", "perfécto" → "perfecto"
 *
 * Safe on non-string inputs (returns empty string).
 */
function stripAccents(str) {
  if (typeof str !== "string") return "";
  return str.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

/**
 * Substring match with word boundary on both ends. Prevents false positives
 * like English "correct" matching inside Spanish "correctas". Word chars are
 * [a-z0-9_]; anything else (space, punctuation, start/end) counts as boundary.
 *
 * Both inputs should already be lowercased and accent-stripped by the caller.
 */
function includesAsWord(text, phrase) {
  if (typeof text !== "string" || typeof phrase !== "string" || phrase.length === 0) {
    return false;
  }
  let from = 0;
  while (from <= text.length - phrase.length) {
    const idx = text.indexOf(phrase, from);
    if (idx < 0) return false;
    const before = idx === 0 ? "" : text[idx - 1];
    const after = idx + phrase.length >= text.length ? "" : text[idx + phrase.length];
    const isWord = (c) => /[a-z0-9_]/.test(c);
    if (!isWord(before) && !isWord(after)) return true;
    from = idx + 1;
  }
  return false;
}

module.exports = { stripAccents, includesAsWord };
