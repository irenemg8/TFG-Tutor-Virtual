"use strict";

/*------------------------------------------------------------------------------
            _________________________________________________________
            |                    ACCENT NORMALIZER                  |
            |  Module of accent-insensitive string utilities. Single  |
            |  source of truth used by the classifier (student input) |
            |  and the guardrails (LLM output).                      |
        ____|________________                                       |
   Txt -> | stripAccents()    | -> Txt                              |
          ----------------------                                    |
   Txt, Txt -> | includesAsWord() | -> T/F                          |
               ----------------------                               |
            |_______________________________________________________|
------------------------------------------------------------------------------*/

/*
   Txt -> ____|________________
         | stripAccents() | -> Txt
          ------------------
      Strips diacritical marks via NFD normalization ("tension" with accent
      becomes "tension"). Returns "" on non-string input.
*/
function stripAccents(str) {
  if (typeof str !== "string") return "";
  return str.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

/*
   Txt, Txt -> ____|___________________
              | includesAsWord() | -> T/F
               --------------------
      Substring match with a word boundary on both ends, so "correct" does
      not match inside "correctas". Both inputs should arrive lowercased and
      accent-stripped by the caller.
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
