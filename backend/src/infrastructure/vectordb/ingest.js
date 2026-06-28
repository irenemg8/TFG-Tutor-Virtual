const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", "..", ".env") });

const fs = require("fs");
const config = require("../llm/config");
const { generateEmbeddings } = require("./embeddings");
const { addDocuments } = require("./chromaClient");
const { loadIndex } = require("../search/bm25");
const { loadKG, getAllEntries } = require("../search/knowledgeGraph");

/*------------------------------------------------------------------------------
            _________________________________________________________
            |                         INGEST                        |
            |  One-time ingestion script: loads the exercise        |
            |  datasets and the knowledge graph into ChromaDB and   |
            |  the in-memory BM25 index, then runs to completion.   |
            |                                                       |
            |   Z, Txt -> | ingestExercise()       | -> Promise<void> |
            |          -> | ingestKnowledgeGraph() | -> Promise<void> |
            |          -> | main()                 | -> Promise<void> |
            |_______________________________________________________|
------------------------------------------------------------------------------*/

/*
   Z, Txt -> ____|___________________
            | ingestExercise() | -> Promise<void>
             -------------------
      Reads one exercise dataset, embeds the student messages, adds them
      to its ChromaDB collection and loads the BM25 index.
*/
async function ingestExercise(exerciseNum, fileName) {
  const filePath = path.join(config.DATASETS_DIR, fileName);
  const raw = fs.readFileSync(filePath, "utf-8");
  const pairs = JSON.parse(raw);

  console.log("Exercise " + exerciseNum + ": " + pairs.length + " pairs");

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

  const embeddings = await generateEmbeddings(documents);

  const collectionName = "exercise_" + exerciseNum;
  await addDocuments(collectionName, { ids: ids, documents: documents, embeddings: embeddings, metadatas: metadatas });

  loadIndex(exerciseNum, pairs);

  console.log("Exercise " + exerciseNum + ": ingested into ChromaDB + BM25");
}

/*
       ____|_________________________
      | ingestKnowledgeGraph() | -> Promise<void>
       -------------------------
      Loads the knowledge graph, builds one document per entry, embeds
      them in a batch and adds them to the knowledge_graph collection.
*/
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

  const embeddings = await generateEmbeddings(documents);

  await addDocuments("knowledge_graph", { ids: ids, documents: documents, embeddings: embeddings, metadatas: metadatas });

  console.log("Knowledge graph: " + entries.length + " entries ingested into ChromaDB");
}

/*
       ____|________
      | main() | -> Promise<void>
       ---------
      Ingests every distinct exercise dataset (skipping shared files)
      and then the knowledge graph.
*/
async function main() {
  console.log("Starting ingestion...");
  console.log("Ollama URL: " + config.OLLAMA_EMBED_URL);
  console.log("ChromaDB URL: " + config.CHROMA_URL);

  const exerciseNums = Object.keys(config.EXERCISE_DATASET_MAP);
  const ingested = {};

  for (let i = 0; i < exerciseNums.length; i++) {
    const num = Number(exerciseNums[i]);
    const fileName = config.EXERCISE_DATASET_MAP[num];

    if (ingested[fileName] != null) {
      console.log("Exercise " + num + ": skipped (same dataset as exercise " + ingested[fileName] + ")");
      continue;
    }

    await ingestExercise(num, fileName);
    ingested[fileName] = num;
  }

  await ingestKnowledgeGraph();

  console.log("Ingestion complete!");
}

main().catch(function (err) {
  console.error("Ingestion failed:", err);
  process.exit(1);
});
