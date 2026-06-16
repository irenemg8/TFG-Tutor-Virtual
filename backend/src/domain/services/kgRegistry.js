"use strict";

const fs = require("fs");
const path = require("path");

/*------------------------------------------------------------------------------
            _________________________________________________________
            |                       KGREGISTRY                      |
            |  Module. Lazy loader of pedagogical datasets keyed by |
            |  AC id, used to enrich the turn-verdict banner with   |
            |  per-AC strategies, Socratic questions and expert     |
            |  reasoning. Datasets are cached on first use and read |
            |  failures degrade gracefully to empty values.         |
            |                                                       |
            |  Txt -> | getStrategyForAC() | -> Txt                 |
            |  Txt -> | getExpertReasoningForAC() | -> Txt          |
            |  Txt -> | getCatalogueEntry() | -> Obj | null         |
            |  | _reloadForTests() | -> void                        |
            |_______________________________________________________|
------------------------------------------------------------------------------*/

let _catalogue = null;
let _kgExpertById = null;

const CATALOGUE_PATH = path.resolve(
  __dirname, "..", "..", "data", "alternative_conceptions.json"
);
const KG_PATH = path.resolve(
  __dirname, "..", "..", "data", "knowledge-graph",
  "knowledge-graph-with-interactions-and-rewards.json"
);

/*
        ____|________________
       | _loadCatalogue() | -> Map
        -------------------
      Reads alternative_conceptions.json into a Map from normalised AC id
      to {name, strategy, questions}; returns an empty Map on failure.
*/
function _loadCatalogue() {
  const map = new Map();
  try {
    const raw = fs.readFileSync(CATALOGUE_PATH, "utf8");
    const json = JSON.parse(raw);
    const entries = json.alternative_conceptions || {};
    for (const id of Object.keys(entries)) {
      const e = entries[id] || {};
      map.set(_norm(id), {
        name: e.name || "",
        strategy: e.educational_strategy || "",
        questions: Array.isArray(e.socratic_questions) ? e.socratic_questions.slice(0, 3) : [],
      });
    }
  } catch (_e) { }
  return map;
}

/*
        ____|_______________
       | _loadKgExpert() | -> Map
        ------------------
      Reads the knowledge-graph dataset into a Map from normalised AC id to
      its first non-empty expert-reasoning prose. Tolerates the unwrapped
      {…},{…} envelope and returns an empty Map on failure.
*/
function _loadKgExpert() {
  const map = new Map();
  try {
    const raw = fs.readFileSync(KG_PATH, "utf8");
    let arr;
    try {
      arr = JSON.parse(raw);
    } catch (_e1) {
      const trimmed = raw.trim();
      if (trimmed.startsWith("{") && !trimmed.startsWith("[")) {
        arr = JSON.parse("[" + trimmed + "]");
      } else {
        return map;
      }
    }
    if (!Array.isArray(arr)) return map;
    for (const item of arr) {
      const reasoning = String(item["Expert reasoning"] || "").trim();
      if (!reasoning) continue;
      const ids = [item.AC, item["AC.1"]].filter(Boolean).map(_norm);
      for (const id of ids) {
        if (!map.has(id)) map.set(id, reasoning);
      }
    }
  } catch (_e) { }
  return map;
}

/*
   Txt -> ____|_________
         | _norm() | -> Txt
          ----------
      Normalises an AC id to uppercase trimmed text; "" when not a string.
*/
function _norm(x) {
  return typeof x === "string" ? x.toUpperCase().trim() : "";
}

/*
   Txt -> ____|___________________
         | getStrategyForAC() | -> Txt
          --------------------
      Returns the educational strategy for an AC id, "" when unknown.
*/
function getStrategyForAC(acId) {
  if (_catalogue == null) _catalogue = _loadCatalogue();
  const entry = _catalogue.get(_norm(acId));
  return entry ? entry.strategy : "";
}

/*
   Txt -> ____|_________________________
         | getExpertReasoningForAC() | -> Txt
          ---------------------------
      Returns the expert-reasoning prose for an AC id, "" when unknown.
*/
function getExpertReasoningForAC(acId) {
  if (_kgExpertById == null) _kgExpertById = _loadKgExpert();
  return _kgExpertById.get(_norm(acId)) || "";
}

/*
   Txt -> ____|____________________
         | getCatalogueEntry() | -> Obj | null
          ---------------------
      Returns the full catalogue entry {name, strategy, questions} for an
      AC id, or null when unknown.
*/
function getCatalogueEntry(acId) {
  if (_catalogue == null) _catalogue = _loadCatalogue();
  return _catalogue.get(_norm(acId)) || null;
}

/*
        ____|________________
       | _reloadForTests() | -> void
        -------------------
      Clears both caches so the next call reloads from disk (test hook).
*/
function _reloadForTests() {
  _catalogue = null;
  _kgExpertById = null;
}

module.exports = {
  getStrategyForAC,
  getExpertReasoningForAC,
  getCatalogueEntry,
  _reloadForTests,
};
