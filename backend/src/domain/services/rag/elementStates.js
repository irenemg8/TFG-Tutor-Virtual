"use strict";

/**
 * elementStates (2026-06-15)
 *
 * The element-set classifier knows WHICH elements are in the answer, but not
 * the physical STATE of each (short-circuited vs open). So when a student
 * EXCLUDES the right element for the WRONG reason — "R3 está en cortocircuito"
 * (R3 is actually OPEN) or "R5 en circuito abierto" (R5 is actually SHORT) —
 * the classifier still records a correct exclusion and the tutor may praise a
 * confused justification. This module derives each element's true state from
 * the exercise's own netlist + expert reasoning, and flags student turns that
 * attribute the OPPOSITE state to an element.
 *
 * Pure, deterministic, no I/O. States: "short" | "open".
 */

const { stripAccents } = require("../text/accentNormalizer");

const SHORT_RE = /(cortocircuit|curtcircuit|\bcorto\b|\bcurt\b|short)/;
const OPEN_RE = /(circuito abierto|circuit obert|interruptor abiert|\babiert|\bobert|open circuit|open switch)/;

/**
 * Build { R3: "open", R5: "short", ... } from the netlist and expert reasoning.
 * Two independent sources, netlist first (most reliable for shorts):
 *   1. Netlist line "Rn A A" (both terminals on the SAME node) → short.
 *   2. Expert-reasoning sentences naming an element + a state word.
 * @param {string} netlist
 * @param {string} expertReasoning
 * @returns {Object<string,string>}
 */
function deriveElementStates(netlist, expertReasoning) {
  const states = {};

  // 1. Netlist: an element whose two terminal nodes are identical is shorted.
  const nl = String(netlist || "");
  const lineRe = /\b(R\d+)\s+(\S+)\s+(\S+)/gi;
  let m;
  while ((m = lineRe.exec(nl)) !== null) {
    if (m[2] === m[3]) states[m[1].toUpperCase()] = "short";
  }

  // 2. Expert reasoning prose: "R5 ... cortocircuitada", "R3 ... circuito
  //    abierto". Split on sentence boundaries so a state attaches only to the
  //    element(s) in ITS clause.
  const expert = stripAccents(String(expertReasoning || "").toLowerCase());
  const clauses = expert.split(/[.;\n]/);
  for (const c of clauses) {
    const els = c.match(/r\d+/gi);
    if (!els) continue;
    const isShort = SHORT_RE.test(c);
    const isOpen = OPEN_RE.test(c);
    if (isShort === isOpen) continue; // ambiguous or neither → skip
    for (const e of els) {
      const u = e.toUpperCase();
      if (!states[u]) states[u] = isShort ? "short" : "open";
    }
  }

  return states;
}

/**
 * Detect element+state pairs in a student message that CONTRADICT the true
 * states. Conservative: only flags an element when a state word sits in its
 * own window (after the element, before the next element / sentence end) and
 * is NOT negated. Returns [{ element, said, actual }].
 * @param {string} message
 * @param {Object<string,string>} states
 */
function detectStateMismatch(message, states) {
  if (!states || Object.keys(states).length === 0) return [];
  const folded = stripAccents(String(message || "").toLowerCase());
  const occ = [];
  const re = /r\d+/gi;
  let m;
  while ((m = re.exec(folded)) !== null) {
    occ.push({ el: m[0].toUpperCase(), end: m.index + m[0].length, start: m.index });
  }
  const out = [];
  for (let i = 0; i < occ.length; i++) {
    const actual = states[occ[i].el];
    if (!actual) continue;
    const nextStart = i + 1 < occ.length ? occ[i + 1].start : folded.length;
    let win = folded.slice(occ[i].end, Math.min(nextStart, occ[i].end + 32));
    const sb = win.search(/[.!?]/);
    if (sb >= 0) win = win.slice(0, sb);
    // A "no" in the window means the student is DENYING a state, not asserting
    // it ("R3 no está en corto") — don't flag.
    if (/\bno\b/.test(win)) continue;
    let said = null;
    if (SHORT_RE.test(win)) said = "short";
    else if (OPEN_RE.test(win)) said = "open";
    if (said && said !== actual) {
      out.push({ element: occ[i].el, said: said, actual: actual });
    }
  }
  return out;
}

module.exports = { deriveElementStates, detectStateMismatch };
