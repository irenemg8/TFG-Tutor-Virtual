"use strict";

const IGuardrail = require("../../domain/ports/services/IGuardrail");
const {
  HEURISTIC_STOPWORDS,
  getAllPatterns,
  getRepeatedQuestionRetryHint,
  QUESTION_FRAME_STOPWORDS,
} = require("../../domain/services/languageManager");

/*------------------------------------------------------------------------------
            _________________________________________________________
            |               REPEATEDQUESTIONGUARDRAIL             |
            |  Guardrail adapter (IGuardrail). Catches the tutor     |
            |  repeating the previous turn's Socratic question       |
            |  near-verbatim (token-overlap >= 0.7), which the LLM   |
            |  does despite the do-not-repeat banner. Retry-only:    |
            |  the question cannot be safely rewritten in place.     |
        ____|_____________________                                   |
        | check() | -> Obj            (reads response, ctx.messages) |
        -----------                                                  |
        ____|_______________________                                 |
        | surgicalFix() | -> Obj | null          (reads response)    |
        -----------------                                            |
        ____|___________________                                     |
        | buildRetryHint() | -> Txt              (reads ctx.messages)|
        --------------------                                         |
            |                                                       |
            |_______________________________________________________|
------------------------------------------------------------------------------*/

/*
   Txt -> ____|_________________
         | _tokenizeContent() | -> [Txt]
          -------------------
      Lowercases, strips punctuation, and returns the non-stopword content
      tokens (length >= 3) used to measure question similarity.
*/
const STOPWORDS = new Set([
  ...getAllPatterns(HEURISTIC_STOPWORDS),
  ...QUESTION_FRAME_STOPWORDS,
]);

function _tokenizeContent(text) {
  if (typeof text !== "string") return [];
  return text
    .toLowerCase()
    .replace(/[¿¡?!.,;:()"'`´‘’“”]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length >= 3 && !STOPWORDS.has(t));
}

/*
   Txt -> ____|____________________
         | _extractLastQuestion() | -> Txt
          ----------------------
      Returns the last interrogative fragment of the text, or "" if none.
*/
function _extractLastQuestion(text) {
  if (typeof text !== "string" || text.length === 0) return "";
  const matches = text.match(/[¿]?[^.!?]*\?/g);
  if (!matches || matches.length === 0) return "";
  return matches[matches.length - 1].trim();
}

/*
   Txt, Txt -> ____|______________
              | _similarity() | -> R
               ---------------
      Content-token overlap of two questions divided by max(len) (symmetric),
      yielding the 0..1 repetition score compared against the 0.7 threshold.
*/
function _similarity(qa, qb) {
  const a = _tokenizeContent(qa);
  const b = _tokenizeContent(qb);
  if (a.length === 0 || b.length === 0) return 0;
  const setB = new Set(b);
  let overlap = 0;
  for (let i = 0; i < a.length; i++) {
    if (setB.has(a[i])) overlap++;
  }
  return overlap / Math.max(a.length, b.length);
}

/*
   [Obj] -> ____|___________________________
           | _findLastAssistantQuestion() | -> Txt
            ----------------------------
      Walks the messages backward and returns the last question asked by the
      most recent assistant message, or "".
*/
function _findLastAssistantQuestion(messages) {
  if (!Array.isArray(messages)) return "";
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m && m.role === "assistant" && typeof m.content === "string") {
      const q = _extractLastQuestion(m.content);
      if (q.length > 0) return q;
    }
  }
  return "";
}

class RepeatedQuestionGuardrail extends IGuardrail {
  get id() { return "repeated_question"; }
  get severity() { return "med"; }

  /*
   Txt, Obj -> ____|_________
              | check() | -> Obj
               -----------
      True (violated) when the new question and the previous assistant
      question score >= 0.7 similarity. No question / no prior question -> ok.
  */
  check(response, ctx) {
    if (typeof response !== "string" || response.length === 0) {
      return { violated: false };
    }
    const newQ = _extractLastQuestion(response);
    if (newQ.length === 0) return { violated: false };
    const prevQ = _findLastAssistantQuestion((ctx && ctx.messages) || []);
    if (prevQ.length === 0) return { violated: false };
    const sim = _similarity(newQ, prevQ);
    if (sim < 0.7) return { violated: false };
    return {
      violated: true,
      evidence:
        "similarity=" + sim.toFixed(2) +
        " newQ='" + newQ.slice(0, 60) + "'" +
        " prevQ='" + prevQ.slice(0, 60) + "'",
    };
  }

  /*
   Txt, Obj -> ____|_______________
              | surgicalFix() | -> Obj | null
               -----------------
      Retry-only: returns null when violated (the question needs the LLM to
      be rewritten), else applied:false.
  */
  surgicalFix(response, ctx) {
    if (typeof response !== "string") return null;
    const r = this.check(response, ctx);
    if (!r.violated) return { applied: false, text: response };
    return null;
  }

  /*
   Txt, Obj -> ____|___________________
              | buildRetryHint() | -> Txt
               --------------------
      Returns the repeated-question retry hint, quoting the previous question.
  */
  buildRetryHint(lang, ctx) {
    const prevQ = ctx && Array.isArray(ctx.messages)
      ? _findLastAssistantQuestion(ctx.messages)
      : "";
    return getRepeatedQuestionRetryHint(lang, prevQ);
  }
}

module.exports = RepeatedQuestionGuardrail;
module.exports._tokenizeContent = _tokenizeContent;
module.exports._extractLastQuestion = _extractLastQuestion;
module.exports._similarity = _similarity;
