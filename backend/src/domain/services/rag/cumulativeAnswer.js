"use strict";

/*------------------------------------------------------------------------------
            _________________________________________________________
            |                   CUMULATIVE ANSWER                   |
            |  Module that reconstructs the cumulative answer state   |
            |  across the whole conversation by replaying the         |
            |  deterministic classifier over each user turn. Pure: no |
            |  I/O, no LLM. Gives the verdict memory across turns.   |
        ____|________________                                       |
   [Obj], [Txt], [Txt] -> | computeCumulativeAnswer() | -> Obj      |
                          -----------------------------             |
            |_______________________________________________________|
------------------------------------------------------------------------------*/

const { classifyQuery } = require("./queryClassifier");
const { stripAccents } = require("../text/accentNormalizer");

/*
   Txt -> ____|________
         | _norm() | -> Txt
          ---------
      Uppercases and removes whitespace from a token; "" on non-string.
*/
function _norm(x) {
  return typeof x === "string" ? x.toUpperCase().replace(/\s+/g, "") : "";
}

/* Concepts that justify EXCLUDING an element from the path (a short or an open
   switch). Used only to gate closureReady. */
const EXCLUSION_CONCEPT_RE = /(corto|cortocircuit|abiert|interruptor)/i;

/*
   [Obj], [Txt], [Txt] -> ____|________________________
                         | computeCumulativeAnswer() | -> Obj
                          ----------------------------
      Replays the classifier over the chronological messages (each user turn
      with its preceding tutor question as context) to accumulate the answer
      state. Returns { namedCorrect, stillMissing, excluded, wronglyExcluded,
      wronglyNamed, reasoningConcepts, complete, closureReady, perTurn }.
      namedCorrect/excluded accumulate reliably; closureReady is a conservative
      gate (full set named AND every non-answer element excluded AND at least
      one exclusion-justifying concept seen in a reasoned turn).
*/
function computeCumulativeAnswer(messages, correctAnswer, evaluableElements) {
  const correct = (correctAnswer || []).map(_norm).filter(Boolean);
  const evalEls = (evaluableElements || []).map(_norm).filter(Boolean);
  const correctSet = new Set(correct);
  const shouldExclude = evalEls.filter(function (e) { return !correctSet.has(e); });

  const namedCorrect = new Set();
  const wronglyNamed = new Set();
  const excluded = new Set();
  const wronglyExcluded = new Set();
  const reasoningConcepts = new Set();
  const perTurn = [];

  const list = Array.isArray(messages) ? messages : [];
  for (let i = 0; i < list.length; i++) {
    const m = list[i];
    if (!m || m.role !== "user" || typeof m.content !== "string") continue;
    let prevAssistant;
    for (let j = i - 1; j >= 0; j--) {
      if (list[j] && list[j].role === "assistant" && typeof list[j].content === "string") {
        prevAssistant = list[j].content;
        break;
      }
    }
    const c = classifyQuery(m.content, correct, evalEls, prevAssistant);
    const proposed = (c.proposed || []).map(_norm).filter(Boolean);
    const negated = (c.negated || []).map(_norm).filter(Boolean);
    perTurn.push({ proposed: proposed, negated: negated });

    for (const p of proposed) {
      if (correctSet.has(p)) namedCorrect.add(p);
      else wronglyNamed.add(p);
    }
    for (const n of negated) {
      if (correctSet.has(n)) wronglyExcluded.add(n);
      else if (evalEls.indexOf(n) >= 0) excluded.add(n);
    }
    for (const p of proposed) { wronglyExcluded.delete(p); excluded.delete(p); }
    for (const n of negated) { wronglyNamed.delete(n); namedCorrect.delete(n); }

    const assertive = c.type !== "dont_know" && !/[?¿]\s*$/.test(String(m.content).trim());
    const reasoned = c.hasReasoning || negated.length > 0;
    if (assertive && reasoned) {
      for (const concept of (c.concepts || [])) {
        if (EXCLUSION_CONCEPT_RE.test(concept)) reasoningConcepts.add(concept);
      }
      const raw = stripAccents(String(m.content).toLowerCase());
      const stateHit = raw.match(
        /(cortocircuit\w*|curtcircuit\w*|\bcorto\b|abiert\w*|obert\w*|interruptor|desconect\w*|desconnect\w*|puentead\w*|aislad\w*|aillad\w*|anulad\w*|queda fuera|fuera del circuito|no atraviesa|impide|bypass\w*|shorted|open switch|disconnected|isolated)/
      );
      if (stateHit && negated.length > 0) reasoningConcepts.add(stateHit[1]);
    }
  }

  const stillMissing = correct.filter(function (e) { return !namedCorrect.has(e); });
  const complete = stillMissing.length === 0 && namedCorrect.size > 0;
  const allExcluded = shouldExclude.length > 0 &&
    shouldExclude.every(function (e) { return excluded.has(e); });
  const closureReady = complete && allExcluded &&
    wronglyExcluded.size === 0 && reasoningConcepts.size > 0;

  return {
    namedCorrect: Array.from(namedCorrect),
    stillMissing: stillMissing,
    excluded: Array.from(excluded),
    wronglyExcluded: Array.from(wronglyExcluded),
    wronglyNamed: Array.from(wronglyNamed),
    reasoningConcepts: Array.from(reasoningConcepts),
    complete: complete,
    closureReady: closureReady,
    perTurn: perTurn,
  };
}

module.exports = { computeCumulativeAnswer };
