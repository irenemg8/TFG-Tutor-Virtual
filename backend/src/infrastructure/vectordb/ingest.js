// One-time ingestion script: loads datasets + knowledge graph into ChromaDB and BM25

const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", "..", ".env") });

const fs = require("fs");
const config = require("../llm/config");
const { generateEmbeddings } = require("./embeddings");
const { addDocuments } = require("./chromaClient");
const { loadIndex } = require("../search/bm25");
const { loadKG, getAllEntries } = require("../search/knowledgeGraph");

// Ingest one exercise dataset into ChromaDB + BM25
async function ingestExercise(exerciseNum, fileName) {
  const filePath = path.join(config.DATASETS_DIR, fileName);
  const raw = fs.readFileSync(filePath, "utf-8");
  const pairs = JSON.parse(raw);

  console.log("Exercise " + exerciseNum + ": " + pairs.length + " pairs");

  // Build arrays for ChromaDB
  const ids = [];
  const documents = [];
  const metadatas = [];
  for (let i = 0; i < pairs.length; i++) {
    ids.push("ex" + exerciseNum + "_" + i);
    documents.push(pairs[i].student);
    metadatas.push({ tutor_response: pairs[i].tutor, 
                     exercise_id: exerciseNum 
                  });
  }

  // Generate embeddings for all student messages in one batch
  const embeddings = await generateEmbeddings(documents);

  // Add to ChromaDB
  const collectionName = "exercise_" + exerciseNum;
  await addDocuments(collectionName, { ids: ids, documents: documents, embeddings: embeddings, metadatas: metadatas });

  // Load into BM25 in-memory index
  loadIndex(exerciseNum, pairs);

  console.log("Exercise " + exerciseNum + ": ingested into ChromaDB + BM25");
}

// Ingest the knowledge graph into ChromaDB
async function ingestKnowledgeGraph() {
  loadKG();
  const entries = getAllEntries();

  const ids = [];
  const documents = [];
  const metadatas = [];
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const doc = entry.Node1 + " " + entry.Relation + " " + entry.Node2 + ". " + (entry["Expert reasoning"] || "");

    ids.push(entry.Enlace || "kg_" + i);
    documents.push(doc);
    metadatas.push({
      node1: entry.Node1,
      node2: entry.Node2,
      relation: entry.Relation,
      ac: entry.AC || "",
      socratic: entry["Socratic Tutoring "] || "",
    });
  }

  // Generate embeddings for all KG documents in one batch
  const embeddings = await generateEmbeddings(documents);

  // Add to ChromaDB
  await addDocuments("knowledge_graph", { ids: ids, documents: documents, embeddings: embeddings, metadatas: metadatas });

  console.log("Knowledge graph: " + entries.length + " entries ingested into ChromaDB");
}

// Main ingestion flow
async function main() {
  console.log("Starting ingestion...");
  console.log("Ollama URL: " + config.OLLAMA_EMBED_URL);
  console.log("ChromaDB URL: " + config.CHROMA_URL);

  // 1. Ingest datasets 
  const exerciseNums = Object.keys(config.EXERCISE_DATASET_MAP);
  const ingested = {}; // track which files we already ingested

  for (let i = 0; i < exerciseNums.length; i++) {
    const num = Number(exerciseNums[i]);  
    const fileName = config.EXERCISE_DATASET_MAP[num];

    // Skip if we already ingested this file 
    if (ingested[fileName] != null) {
      console.log("Exercise " + num + ": skipped (same dataset as exercise " + ingested[fileName] + ")");
      continue;
    }

    await ingestExercise(num, fileName);
    ingested[fileName] = num;
  }

  // 2. Ingest knowledge graph
  await ingestKnowledgeGraph();

  console.log("Ingestion complete!");
}

main().catch(function (err) {
  console.error("Ingestion failed:", err);
  process.exit(1);
});
