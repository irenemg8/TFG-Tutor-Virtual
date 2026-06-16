"use strict";

/*------------------------------------------------------------------------------
            _________________________________________________________
            |                    ELEMENT STATES                     |
            |  Module that derives each element's true physical state |
            |  ("short" | "open") from the exercise's netlist and     |
            |  expert reasoning, and flags student turns that         |
            |  attribute the OPPOSITE state to an element. Pure,      |
            |  deterministic, no I/O.                                |
        ____|________________                                       |
   Txt, Txt -> | deriveElementStates() | -> Obj                     |
               --------------------------                           |
   Txt, Obj -> | detectStateMismatch() | -> [Obj]                   |
               --------------------------                           |
            |_______________________________________________________|
------------------------------------------------------------------------------*/

const { stripAccents } = require("../text/accentNormalizer");

const SHORT_RE = /(cortocircuit|curtcircuit|\bcorto\b|\bcurt\b|short)/;
const OPEN_RE = /(circuito abierto|circuit obert|interruptor abiert|\babiert|\bobert|open circuit|open switch)/;

/*
   Txt, Txt -> ____|_______________________
              | deriveElementStates() | -> Obj
               ------------------------
      Builds { R3: "open", R5: "short", ... } from two independent sources,
      netlist first (most reliable for shorts): a netlist line "Rn A A" (both
      terminals on the same node) is a short; expert-reasoning sentences naming
      an element plus a state word give the rest.
*/
function deriveElementStates(netlist, expertReasoning) {
  const states = {};

  const nl = String(netlist || "");
  const lineRe = /\b(R\d+)\s+(\S+)\s+(\S+)/gi;
  let m;
  while ((m = lineRe.exec(nl)) !== null) {
    if (m[2] === m[3]) states[m[1].toUpperCase()] = "short";
  }

  const expert = stripAccents(String(expertReasoning || "").toLowerCase());
  const clauses = expert.split(/[.;\n]/);
  for (const c of clauses) {
    const els = c.match(/r\d+/gi);
    if (!els) continue;
    const isShort = SHORT_RE.test(c);
    const isOpen = OPEN_RE.test(c);
    if (isShort === isOpen) continue;
    for (const e of els) {
      const u = e.toUpperCase();
      if (!states[u]) states[u] = isShort ? "short" : "open";
    }
  }

  return states;
}

/*
   Txt, Obj -> ____|_______________________
              | detectStateMismatch() | -> [Obj]
               ------------------------
      Detects element+state pairs in a student message that contradict the
      true states. Conservative: flags an element only when a state word sits
      in its own window (after the element, before the next element / sentence
      end) and is not negated. Returns [{ element, said, actual }].
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
