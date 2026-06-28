const fs = require("fs");
const config = require("../llm/config");

/*------------------------------------------------------------------------------
            _________________________________________________________
            |                    KNOWLEDGE GRAPH                    |
            |  In-memory knowledge graph (loaded once at startup).  |
            |  Loads, normalizes and searches KG entries by concept |
            |  keywords or alternative-conception (AC) ids.         |
            |                                                       |
            |          -> | loadKG()        | -> void               |
            |        Obj -> | mapEntry()     | -> Obj                |
            |      [Txt] -> | searchKG()     | -> [Obj]              |
            |      [Txt] -> | searchKGByAC() | -> [Obj]              |
            |          -> | getAllEntries() | -> [Obj]               |
            |_______________________________________________________|
------------------------------------------------------------------------------*/

let kgEntries = [];

/*
       ____|___________
      | loadKG() | -> void
       -----------
      Reads the KG JSON file into memory, tolerating files without an
      enclosing array and a trailing comma before the closing bracket.
*/
function loadKG() {
  var raw = fs.readFileSync(config.KG_PATH, "utf-8").trim();

  if (raw.charAt(0) !== "[") {
    raw = "[" + raw + "]";
  }

  raw = raw.replace(/,\s*\]$/, "]");

  kgEntries = JSON.parse(raw);
  console.log("Knowledge graph loaded: " + kgEntries.length + " entries");
}

/*
   Obj -> ____|____________
         | mapEntry() | -> Obj
          -------------
      Normalizes a raw KG entry into an object with all useful fields.
      Trims AC ids because the source JSON has trailing whitespace that
      would otherwise break exact-id lookups.
*/
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

/*
   [Txt] -> ____|____________
           | searchKG() | -> [Obj]
            -------------
      Returns the mapped entries whose Node1, Relation or Node2 contains
      any of the given concept keywords (one match per entry).
*/
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
        break;
      }
    }
  }
  return results;
}

/*
   [Txt] -> ____|________________
           | searchKGByAC() | -> [Obj]
            -----------------
      Returns the mapped entries whose AC or AC.1 field matches any of
      the given AC ids, de-duplicated by Node1|Relation|Node2.
*/
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

/*
       ____|_________________
      | getAllEntries() | -> [Obj]
       ------------------
      Returns the raw in-memory KG entries (used for ingestion into
      ChromaDB).
*/
function getAllEntries() {
  return kgEntries;
}

module.exports = { loadKG, searchKG, searchKGByAC, getAllEntries };
