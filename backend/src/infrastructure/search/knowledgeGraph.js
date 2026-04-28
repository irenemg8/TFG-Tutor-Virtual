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

// Search KG entries by concept keywords -> Returns entries where Node1, Node2 or Relation match.
// AC ids are trimmed because the source JSON has trailing whitespace on at least
// one entry ("AC13 ") which would otherwise break exact-id lookups.
function searchKG(concepts) {
  if (concepts.length === 0) {
    return [];
  }

  const results = [];
  for (let i = 0; i < kgEntries.length; i++) {
    const entry = kgEntries[i];
    const text = (entry.Node1 + " " + entry.Relation + " " + entry.Node2).toLowerCase();

    for (let j = 0; j < concepts.length; j++) {
      if (text.includes(concepts[j].toLowerCase())) {
        // Some KG entries carry TWO alternative conceptions per node-pair
        // (fields "AC.1", "AC name.1", "Description1"). The legacy loader only
        // exposed the primary one — we now surface both so the augmentation
        // can present alternative misconceptions on the same concept.
        const altAcs = [];
        const primary = (entry.AC || "").trim();
        if (primary) altAcs.push({
          ac: primary,
          acName: entry["AC name"] || "",
          acDescription: entry.Description || "",
        });
        const secondary = (entry["AC.1"] || "").trim();
        if (secondary) altAcs.push({
          ac: secondary,
          acName: entry["AC name.1"] || "",
          acDescription: entry["Description1"] || "",
        });

        results.push({
          enlace: entry.Enlace,
          node1: entry.Node1,
          relation: entry.Relation,
          node2: entry.Node2,
          expertReasoning: entry["Expert reasoning"],
          // Backward-compatible primary fields (unchanged).
          ac: primary,
          acName: entry["AC name"] || "",
          acDescription: entry.Description || "",
          // New: full list of ACs (1 or 2 entries).
          alternativeConceptions: altAcs,
          socraticQuestions: entry["Socratic Tutoring "] || "",
        });
        break; // avoids duplicates if entry matches multiple concepts
      }
    }
  }
  return results;
}

// Get all KG entries (for ingestion into ChromaDB)
function getAllEntries() {
  return kgEntries;
}

module.exports = { loadKG, searchKG, getAllEntries };
