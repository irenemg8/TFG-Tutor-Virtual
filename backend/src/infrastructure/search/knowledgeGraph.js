const fs = require("fs");
const config = require("../llm/config");

let kgEntries = []; // In-memory knowledge graph (loaded once at startup)

// Load the knowledge graph JSON file into memory
function loadKG() {
  var raw = fs.readFileSync(config.KG_PATH, "utf-8").trim();

  // Handle files that contain comma-separated objects without enclosing []
  if (raw.charAt(0) !== "[") {
    raw = "[" + raw + "]";
  }

  // Remove trailing comma before closing bracket if present
  raw = raw.replace(/,\s*\]$/, "]");

  kgEntries = JSON.parse(raw);
  console.log("Knowledge graph loaded: " + kgEntries.length + " entries");
}

// Map a raw KG entry to a normalized object with ALL useful fields.
// AC ids are trimmed because the source JSON has trailing whitespace on at least
// one entry ("AC13 ") which would otherwise break exact-id lookups.
function mapEntry(entry) {
  const primary = (entry.AC || "").trim();
  const secondary = (entry["AC.1"] || "").trim();
  const altAcs = [];
  if (primary) altAcs.push({ ac: primary, acName: entry["AC name"] || "", acDescription: entry.Description || "" });
  if (secondary) altAcs.push({ ac: secondary, acName: entry["AC name.1"] || "", acDescription: entry["Description1"] || "" });
  return {
    enlace: entry.Enlace || "",
    node1: entry.Node1 || "",
    relation: entry.Relation || "",
    node2: entry.Node2 || "",
    expertReasoning: entry["Expert reasoning"] || "",
    socraticQuestions: entry["Socratic Tutoring "] || "",
    ac: primary,
    acName: entry["AC name"] || "",
    acDescription: entry.Description || "",
    acErrors: entry["Example common errors "] || "",
    ac2: secondary,
    ac2Name: entry["AC name.1"] || "",
    ac2Description: entry["Description1"] || "",
    ac2Errors: entry["Example common errors 1"] || "",
    alternativeConceptions: altAcs,
  };
}

// Search KG entries by concept keywords -> Returns entries where Node1, Node2 or Relation match
function searchKG(concepts) {
  if (concepts.length === 0) {
    return [];
  }

  var results = [];
  for (var i = 0; i < kgEntries.length; i++) {
    var text = (kgEntries[i].Node1 + " " + kgEntries[i].Relation + " " + kgEntries[i].Node2).toLowerCase();

    for (var j = 0; j < concepts.length; j++) {
      if (text.includes(concepts[j].toLowerCase())) {
        results.push(mapEntry(kgEntries[i]));
        break; // avoids duplicates if entry matches multiple concepts
      }
    }
  }
  return results;
}

// Search KG entries by AC (alternative conception) IDs
// Returns entries where AC or AC.1 fields match any of the given IDs
function searchKGByAC(acIds) {
  if (!Array.isArray(acIds) || acIds.length === 0) {
    return [];
  }

  var acSet = {};
  for (var i = 0; i < acIds.length; i++) {
    acSet[String(acIds[i]).toUpperCase().trim()] = true;
  }

  var results = [];
  var seen = {};
  for (var j = 0; j < kgEntries.length; j++) {
    var entry = kgEntries[j];
    var ac1 = String(entry.AC || "").toUpperCase().trim();
    var ac2 = String(entry["AC.1"] || "").toUpperCase().trim();

    if ((ac1 && acSet[ac1]) || (ac2 && acSet[ac2])) {
      var key = (entry.Node1 || "") + "|" + (entry.Relation || "") + "|" + (entry.Node2 || "");
      if (seen[key]) continue;
      seen[key] = true;
      results.push(mapEntry(entry));
    }
  }
  return results;
}

// Get all KG entries (for ingestion into ChromaDB)
function getAllEntries() {
  return kgEntries;
}

module.exports = { loadKG, searchKG, searchKGByAC, getAllEntries };
