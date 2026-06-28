"use strict";

/*------------------------------------------------------------------------------
            _________________________________________________________
            |                   SENTENCE SPLITTER                   |
            |  Module of shared sentence splitters, replacing the    |
            |  ad-hoc split(/[.!?\n]/) calls scattered across the    |
            |  guardrails.                                           |
        ____|________________                                       |
   Txt -> | splitSentences()        | -> [Txt]                      |
          ----------------------------                              |
   Txt -> | splitSentencesKeepEnd() | -> [Txt]                      |
          ----------------------------                              |
            |_______________________________________________________|
------------------------------------------------------------------------------*/

/*
   Txt -> ____|__________________
         | splitSentences() | -> [Txt]
          --------------------
      Splits on . ! ? or newlines, trims each piece and drops empties.
      Returns plain content with no trailing punctuation.
*/
function splitSentences(text) {
  if (typeof text !== "string") return [];
  return text
    .split(/[.!?\n]+/)
    .map(function (s) { return s.trim(); })
    .filter(Boolean);
}

/*
   Txt -> ____|_________________________
         | splitSentencesKeepEnd() | -> [Txt]
          ---------------------------
      Like splitSentences but keeps trailing punctuation, so downstream logic
      can check for "?" to tell questions from affirmations.
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
