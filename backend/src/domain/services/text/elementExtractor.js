"use strict";

// Element mention extraction from free-text messages.
// Consolidates 3 previous implementations: queryClassifier.extractResistances,
// guardrails.extractResistances, ollamaChatRoutes.extractResistencias.
//
// Two APIs:
//   extractResistances(text)                             — legacy regex (R\d+)
//   extractMentionedElements(text, evaluableElements)    — generic, word-boundary

// Word-boundary character classes — permit the element to be surrounded by
// common punctuation/spacing without being absorbed into a longer token.
const BOUNDARY_BEFORE = /[\s,;:(¿¡"'\-]/;
const BOUNDARY_AFTER = /[\s,;:).?!"'\-]/;

/**
 * Legacy: extract resistance names via R\d+ regex, uppercased and deduplicated.
 * Preserved for backward compatibility where evaluableElements isn't available.
 */
function extractResistances(text) {
  if (typeof text !== "string") return [];
  const matches = text.match(/R\d+/gi);
  if (!matches) return [];
  const seen = new Set();
  const out = [];
  for (let i = 0; i < matches.length; i++) {
    const n = matches[i].toUpperCase();
    if (!seen.has(n)) {
      seen.add(n);
      out.push(n);
    }
  }
  return out;
}

/**
 * Generic: extract mentions of specific evaluable elements (any type: R*, C*,
 * L*, V*, concept names, definitions). Returns array of { element, position }
 * with word-boundary checks so "R1" inside "CR10" doesn't match.
 *
 * Falls back to extractResistances behavior when evaluableElements is empty.
 */
function extractMentionedElements(text, evaluableElements) {
  if (typeof text !== "string") return [];
  if (!Array.isArray(evaluableElements) || evaluableElements.length === 0) {
    // Fallback: regex path, still returning { element, position }
    const out = [];
    const seen = new Set();
    const re = /R\d+/gi;
    let m;
    while ((m = re.exec(text)) !== null) {
      const n = m[0].toUpperCase();
      if (!seen.has(n)) {
        seen.add(n);
        out.push({ element: n, position: m.index });
      }
    }
    return out;
  }
  // Generic path: scan for each evaluable element substring with boundary check.
  const lower = text.toLowerCase();
  const mentions = [];
  const seen = new Set();
  for (let i = 0; i < evaluableElements.length; i++) {
    const elem = evaluableElements[i];
    const elemLower = String(elem).toLowerCase();
    let searchFrom = 0;
    while (searchFrom < lower.length) {
      const idx = lower.indexOf(elemLower, searchFrom);
      if (idx < 0) break;
      const charBefore = idx > 0 ? lower[idx - 1] : " ";
      const endPos = idx + elemLower.length;
      const charAfter = endPos < lower.length ? lower[endPos] : " ";
      const validBefore = BOUNDARY_BEFORE.test(charBefore) || idx === 0;
      const validAfter = BOUNDARY_AFTER.test(charAfter) || endPos === lower.length;
      if (validBefore && validAfter) {
        const n = String(elem).toUpperCase();
        if (!seen.has(n)) {
          seen.add(n);
          mentions.push({ element: n, position: idx });
        }
      }
      searchFrom = idx + 1;
    }
  }
  return mentions;
}

module.exports = {
  extractResistances: extractResistances,
  extractMentionedElements: extractMentionedElements,
};
