"use strict";

/**
 * cumulativeAnswer (BUG-LOOP, 2026-06-11)
 *
 * The per-turn verdict (AcDetectorAgent) is computed ONLY from the current
 * message's proposed/negated, so it has no memory: once the student names the
 * full correct set in one turn, the NEXT turn (a partial proposal or a bare
 * negation) recomputes `missing=[the whole answer]` — the system "forgets" what
 * was already established and keeps re-interrogating R1/R2/R4 one by one. This
 * is the root cause of the looping Irene observed in the 2026-06-11 transcript
 * (req11 named R1,R2,R4 → req16-18 re-asked each of them again).
 *
 * This module reconstructs the CUMULATIVE answer state across the whole
 * conversation by replaying the classifier over each user turn (with its
 * preceding tutor question as context, so context-resolved negations like
 * "No porque está en corto" → R5 are recovered). It is PURE: no I/O, no LLM,
 * just the deterministic classifier. Cost is N tiny sync classifier calls.
 *
 * Design notes / honest limits:
 *   - namedCorrect / excluded accumulate RELIABLY (token-level union).
 *   - "exclusions WITH reasoning" is HEURISTIC: the justification for excluding
 *     R3 ("el interruptor está abierto") frequently arrives in a different turn
 *     than the R3 negation, and the classifier does not bind concept→element.
 *     We therefore expose `reasoningConcepts` (the concepts seen in any
 *     reasoned turn) and let the caller decide; `closureReady` requires both
 *     the full set named AND every non-answer element excluded AND at least one
 *     exclusion-justifying concept present — a deliberately conservative gate.
 */

const { classifyQuery } = require("./queryClassifier");

function _norm(x) {
  return typeof x === "string" ? x.toUpperCase().replace(/\s+/g, "") : "";
}

// Concepts that justify EXCLUDING an element from the V(N2,0) path:
//   - "corto"/"cortocircuit…" → a shorted element (R5)
//   - "abierto"/"interruptor abierto" → an open switch isolates an element (R3)
// Used only to gate closureReady; kept tiny and language-folded by the
// classifier upstream (concepts already normalised there).
const EXCLUSION_CONCEPT_RE = /(corto|cortocircuit|abiert|interruptor)/i;

/**
 * @param {Array<{role:string,content:string}>} messages — chronological.
 * @param {Array<string>} correctAnswer    — e.g. ["R1","R2","R4"].
 * @param {Array<string>} evaluableElements — e.g. ["R1".."R5"].
 * @returns {{
 *   namedCorrect: string[], stillMissing: string[], excluded: string[],
 *   wronglyExcluded: string[], wronglyNamed: string[],
 *   reasoningConcepts: string[], complete: boolean, closureReady: boolean,
 *   perTurn: Array<{proposed:string[],negated:string[]}>
 * }}
 */
function computeCumulativeAnswer(messages, correctAnswer, evaluableElements) {
  const correct = (correctAnswer || []).map(_norm).filter(Boolean);
  const evalEls = (evaluableElements || []).map(_norm).filter(Boolean);
  const correctSet = new Set(correct);
  // Non-answer evaluable elements that SHOULD be excluded (R3, R5 here).
  const shouldExclude = evalEls.filter(function (e) { return !correctSet.has(e); });

  const namedCorrect = new Set();
  const wronglyNamed = new Set();
  const excluded = new Set();        // correctly-excluded non-answer elements
  const wronglyExcluded = new Set(); // negated elements that ARE in the answer
  const reasoningConcepts = new Set();
  const perTurn = [];

  const list = Array.isArray(messages) ? messages : [];
  for (let i = 0; i < list.length; i++) {
    const m = list[i];
    if (!m || m.role !== "user" || typeof m.content !== "string") continue;
    // Preceding assistant message gives the classifier the context it needs to
    // resolve closed answers ("No" / "sí") and context-only negations.
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
    // Self-correction is symmetric: naming an element later clears a prior wrong
    // exclusion, and excluding an element later clears a prior wrong proposal
    // (e.g. "todas" → R3 proposed, then "R3 no influye" → corrected). The most
    // recent intent for an element wins.
    for (const p of proposed) wronglyExcluded.delete(p);
    for (const n of negated) wronglyNamed.delete(n);

    if (c.hasReasoning) {
      for (const concept of (c.concepts || [])) {
        if (EXCLUSION_CONCEPT_RE.test(concept)) reasoningConcepts.add(concept);
      }
    }
  }

  const stillMissing = correct.filter(function (e) { return !namedCorrect.has(e); });
  const complete = stillMissing.length === 0 && namedCorrect.size > 0;
  // Conservative closure gate (criterion chosen 2026-06-11: full set named AND
  // exclusions reasoned): every non-answer element excluded AND at least one
  // exclusion-justifying concept seen in a reasoned turn.
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
