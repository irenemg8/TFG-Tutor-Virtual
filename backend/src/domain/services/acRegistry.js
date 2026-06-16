"use strict";

const fs = require("fs");
const path = require("path");

/*------------------------------------------------------------------------------
            _________________________________________________________
            |                       ACREGISTRY                      |
            |  Module. Matches the student's answer against the      |
            |  Alternative-Conception patterns defined per exercise |
            |  in tutorContext_por_ejercicio.json (acPatterns), and |
            |  serves those patterns from an in-memory cache.       |
            |                                                       |
            |  [Obj], [Txt], [Txt], [Txt] -> | matchACs() | -> [Obj]|
            |  Z -> | getPatternsForExercise() | -> [Obj]           |
            |  Txt -> | reloadPatternsForTests() | -> void          |
            |_______________________________________________________|
------------------------------------------------------------------------------*/

/*
   [Txt] -> ____|______________
           | toUpperSet() | -> Set
            ----------------
      Builds a Set of uppercased, whitespace-stripped string entries.
*/
function toUpperSet(arr) {
  const s = new Set();
  if (!Array.isArray(arr)) return s;
  for (const x of arr) {
    if (typeof x === "string") s.add(x.toUpperCase().replace(/\s+/g, ""));
  }
  return s;
}

/*
   Set, Set -> ____|_____________
              | intersect() | -> [Txt]
               ---------------
      Returns the elements of the first set that are present in the second.
*/
function intersect(a, b) {
  const out = [];
  for (const x of a) if (b.has(x)) out.push(x);
  return out;
}

const ELEMENT_TOKEN_RE = /^[A-Z]+\d+$/;

/*
   [Obj], [Txt], [Txt], [Txt] -> ____|____________
                                | matchACs() | -> [Obj]
                                 -------------
      Matches proposed / negated / correct element sets against the
      acPatterns rules (includes, excludes, misses, set-equality) and
      returns scored matches sorted by descending confidence. Bails out
      with [] when the correct answer is not an element set.
*/
function matchACs(acPatterns, proposedRaw, negatedRaw, correctAnswerRaw) {
  if (!Array.isArray(acPatterns) || acPatterns.length === 0) return [];
  const proposed = toUpperSet(proposedRaw);
  const negated = toUpperSet(negatedRaw);
  const correct = toUpperSet(correctAnswerRaw);

  const correctIsElementSet = [...correct].some((x) => ELEMENT_TOKEN_RE.test(x));
  if (!correctIsElementSet) return [];
  const missing = new Set();
  for (const c of correct) {
    if (!proposed.has(c) && !negated.has(c)) missing.add(c);
  }

  const matches = [];
  for (const ac of acPatterns) {
    if (!ac || !ac.match) continue;
    let confidence = 0;
    const reasons = [];
    const m = ac.match;

    if (Array.isArray(m.proposedSetEquals)) {
      const target = toUpperSet(m.proposedSetEquals);
      const equal =
        proposed.size === target.size && [...target].every((x) => proposed.has(x));
      if (equal) {
        confidence = Math.max(confidence, 0.95);
        reasons.push("proposed exactly matches " + [...target].join(","));
      }
    }

    if (Array.isArray(m.includesAll)) {
      const target = toUpperSet(m.includesAll);
      const all = [...target].every((x) => proposed.has(x));
      if (all && target.size > 0) {
        confidence = Math.max(confidence, 0.9);
        reasons.push("proposed includes all of " + [...target].join(","));
      }
    }

    if (Array.isArray(m.includes)) {
      const target = toUpperSet(m.includes);
      const hit = intersect(target, proposed);
      if (hit.length > 0) {
        const wronglyIncluded = hit.filter((x) => !correct.has(x));
        if (wronglyIncluded.length > 0) {
          confidence = Math.max(confidence, 0.85);
          reasons.push("wrongly includes " + wronglyIncluded.join(","));
        }
      }
    }

    if (Array.isArray(m.excludes)) {
      const target = toUpperSet(m.excludes);
      const hit = intersect(target, negated);
      if (hit.length > 0) {
        const wronglyRejected = hit.filter((x) => correct.has(x));
        if (wronglyRejected.length > 0) {
          confidence = Math.max(confidence, 0.8);
          reasons.push("wrongly excludes " + wronglyRejected.join(","));
        }
      }
    }

    if (Array.isArray(m.missesAll)) {
      const target = toUpperSet(m.missesAll);
      const all = [...target].every((x) => missing.has(x));
      if (all && target.size > 0) {
        confidence = Math.max(confidence, 0.8);
        reasons.push("misses all of " + [...target].join(","));
      }
    }

    if (Array.isArray(m.missesAny)) {
      const target = toUpperSet(m.missesAny);
      const hit = intersect(target, missing);
      if (hit.length > 0) {
        confidence = Math.max(confidence, 0.55);
        reasons.push("misses " + hit.join(","));
      }
    }

    if (confidence > 0) {
      matches.push({
        id: ac.id,
        name: ac.name || ac.id,
        misconception: ac.misconception || "",
        strategy: ac.strategy || "",
        confidence,
        reason: reasons.join("; "),
      });
    }
  }

  matches.sort((a, b) => b.confidence - a.confidence);
  return matches;
}

let _patternsByExercise = null;
const DEFAULT_JSON = path.resolve(
  __dirname,
  "..",
  "..",
  "data",
  "contextos-ejercicios",
  "tutorContext_por_ejercicio.json"
);

/*
   Txt -> ____|_________
         | _load() | -> Map
          ----------
      Reads the exercises JSON and builds a Map from exercise number to its
      acPatterns array.
*/
function _load(jsonPath) {
  const raw = fs.readFileSync(jsonPath || DEFAULT_JSON, "utf8");
  const arr = JSON.parse(raw);
  const map = new Map();
  for (const item of arr) {
    const tc = item.tutorContext || {};
    map.set(Number(item.ejercicio), Array.isArray(tc.acPatterns) ? tc.acPatterns : []);
  }
  return map;
}

/*
   Z -> ____|________________________
       | getPatternsForExercise() | -> [Obj]
        --------------------------
      Returns the cached acPatterns for an exercise, loading the JSON on
      first use; [] when the exercise is unknown.
*/
function getPatternsForExercise(exerciseNum) {
  if (_patternsByExercise == null) _patternsByExercise = _load();
  return _patternsByExercise.get(Number(exerciseNum)) || [];
}

/*
   Txt -> ____|________________________
         | reloadPatternsForTests() | -> void
          --------------------------
      Forces a reload of the cache from the given JSON path (test hook).
*/
function reloadPatternsForTests(jsonPath) {
  _patternsByExercise = _load(jsonPath);
}

module.exports = { matchACs, getPatternsForExercise, reloadPatternsForTests };
