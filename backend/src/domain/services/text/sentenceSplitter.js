"use strict";

// Shared sentence splitter. Previously duplicated as ad-hoc `split(/[.!?\n]/)`
// calls across guardrails.js (5+ places).
//
// Two variants:
//   splitSentences        — pure content, trimmed, no punctuation
//   splitSentencesKeepEnd — preserves trailing punctuation (needed when a check
//                           cares whether a sentence ends in "?" — e.g. to
//                           distinguish questions from affirmations)

/**
 * Split on . ! ? or newlines, trim each, drop empties.
 * Returns plain content (no trailing punctuation).
 */
function splitSentences(text) {
  if (typeof text !== "string") return [];
  return text
    .split(/[.!?\n]+/)
    .map(function (s) { return s.trim(); })
    .filter(Boolean);
}

/**
 * Split keeping trailing punctuation on each sentence.
 * Useful when downstream logic checks for "?" to identify questions.
 */
function splitSentencesKeepEnd(text) {
  if (typeof text !== "string") return [];
  const out = [];
  const re = /[^.!?\n]+[.!?]?/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const s = m[0].trim();
    if (s) out.push(s);
  }
  return out;
}

module.exports = {
  splitSentences: splitSentences,
  splitSentencesKeepEnd: splitSentencesKeepEnd,
};
