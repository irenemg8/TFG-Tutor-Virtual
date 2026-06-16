"use strict";

/*------------------------------------------------------------------------------
            _________________________________________________________
            |                     SET COMPARISON                    |
            |  Module of set equality and subset utilities for       |
            |  element arrays (e.g. ["R1","R2","R4"]).               |
        ____|________________                                       |
   [Txt], [Txt] -> | sameSet()     | -> T/F                         |
                   ------------------                               |
   [Txt], [Txt] -> | containsAll() | -> T/F                         |
                   ------------------                               |
   Txt -> | _norm() | -> Txt                                        |
          -----------                                               |
            |_______________________________________________________|
------------------------------------------------------------------------------*/

/*
   [Txt], [Txt] -> ____|___________
                  | sameSet() | -> T/F
                   ------------
      True when both arrays hold the same elements regardless of order
      (compared as sets; duplicates ignored).
*/
function sameSet(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b)) return false;
  const A = new Set(a.map(_norm));
  const B = new Set(b.map(_norm));
  if (A.size !== B.size) return false;
  for (const x of A) if (!B.has(x)) return false;
  return true;
}

/*
   [Txt], [Txt] -> ____|_______________
                  | containsAll() | -> T/F
                   ----------------
      True when every element in subset also appears in superset.
*/
function containsAll(superset, subset) {
  if (!Array.isArray(superset) || !Array.isArray(subset)) return false;
  const S = new Set(superset.map(_norm));
  for (const x of subset) if (!S.has(_norm(x))) return false;
  return true;
}

function _norm(x) {
  return typeof x === "string" ? x.toUpperCase().trim() : x;
}

module.exports = { sameSet, containsAll };
