"use strict";

/*------------------------------------------------------------------------------
            _________________________________________________________
            |                   ELEMENT EXTRACTOR                   |
            |  Module that extracts element mentions from free-text   |
            |  messages. Consolidates three former implementations    |
            |  (classifier, guardrails and chat routes).             |
        ____|________________                                       |
   Txt -> | extractResistances()        | -> [Txt]                  |
          --------------------------------                          |
   Txt, [Txt] -> | extractMentionedElements() | -> [Obj]            |
                 -------------------------------                    |
            |_______________________________________________________|
------------------------------------------------------------------------------*/

const BOUNDARY_BEFORE = /[\s,;:(¿¡"'\-]/;
const BOUNDARY_AFTER = /[\s,;:).?!"'\-]/;

/*
   Txt -> ____|______________________
         | extractResistances() | -> [Txt]
          ------------------------
      Extracts resistance names via R\d+ regex, uppercased and deduplicated.
      Kept for backward compatibility where evaluableElements is unavailable.
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

/*
   Txt, [Txt] -> ____|___________________________
                | extractMentionedElements() | -> [Obj]
                 -----------------------------
      Extracts mentions of specific evaluable elements (any type: R*, C*, L*,
      V*, concept names) as { element, position }, with word-boundary checks so
      "R1" inside "CR10" does not match. Falls back to the regex path when
      evaluableElements is empty.
*/
function extractMentionedElements(text, evaluableElements) {
  if (typeof text !== "string") return [];
  if (!Array.isArray(evaluableElements) || evaluableElements.length === 0) {
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
