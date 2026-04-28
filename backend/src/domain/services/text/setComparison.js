"use strict";

// Set equality and subset utilities for element arrays (e.g., ["R1","R2","R4"]).
// Previously duplicated in queryClassifier.js, guardrails.js, and ollamaChatRoutes.js.

/**
 * Return true if both arrays contain the same elements, regardless of order.
 * Arrays are compared as sets (duplicates are not counted).
 */
function sameSet(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b)) return false;
  const A = new Set(a.map(_norm));
  const B = new Set(b.map(_norm));
  if (A.size !== B.size) return false;
  for (const x of A) if (!B.has(x)) return false;
  return true;
}

/**
 * Return true if every element in `subset` also appears in `superset`.
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
