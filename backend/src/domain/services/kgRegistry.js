"use strict";

const fs = require("fs");
const path = require("path");

/**
 * kgRegistry — lazy loader of pedagogical datasets keyed by AC id, used
 * to enrich the [VEREDICTO DEL TURNO] banner (NS-30) with content the
 * LLM otherwise has to invent:
 *
 *   - alternative_conceptions.json → per-AC educational_strategy and
 *     socratic_questions (canonical catalogue, exercise-agnostic).
 *
 *   - knowledge-graph-with-interactions-and-rewards.json → per-link
 *     "Expert reasoning" prose. The KG records two AC slots per link
 *     (AC + AC.1), both pointing to the same concept; we index the first
 *     non-empty Expert reasoning we see for each AC id.
 *
 * Both files are loaded once on first call and cached in memory. Failures
 * to read are swallowed: the agent degrades gracefully (returns empty
 * strings) so a missing dataset never blocks a tutor turn.
 */

let _catalogue = null;        // Map<acId, {strategy, questions[]}>
let _kgExpertById = null;     // Map<acId, expertReasoning>

const CATALOGUE_PATH = path.resolve(
  __dirname, "..", "..", "data", "alternative_conceptions.json"
);
const KG_PATH = path.resolve(
  __dirname, "..", "..", "data", "knowledge-graph",
  "knowledge-graph-with-interactions-and-rewards.json"
);

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
  } catch (_e) { /* dataset missing or malformed — fall through */ }
  return map;
}

function _loadKgExpert() {
  const map = new Map();
  try {
    const raw = fs.readFileSync(KG_PATH, "utf8");
    let arr;
    try {
      arr = JSON.parse(raw);
    } catch (_e1) {
      // Defensive: the source dataset is a concatenation of {…},{…} without
      // the surrounding [ ]. Wrap it before parsing so we don't lose the
      // entire KG signal because of a malformed envelope.
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
      // KG entries can carry up to two AC ids per link.
      const ids = [item.AC, item["AC.1"]].filter(Boolean).map(_norm);
      for (const id of ids) {
        if (!map.has(id)) map.set(id, reasoning);
      }
    }
  } catch (_e) { /* dataset missing or malformed */ }
  return map;
}

function _norm(x) {
  return typeof x === "string" ? x.toUpperCase().trim() : "";
}

function getStrategyForAC(acId) {
  if (_catalogue == null) _catalogue = _loadCatalogue();
  const entry = _catalogue.get(_norm(acId));
  return entry ? entry.strategy : "";
}

function getExpertReasoningForAC(acId) {
  if (_kgExpertById == null) _kgExpertById = _loadKgExpert();
  return _kgExpertById.get(_norm(acId)) || "";
}

function getCatalogueEntry(acId) {
  if (_catalogue == null) _catalogue = _loadCatalogue();
  return _catalogue.get(_norm(acId)) || null;
}

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
