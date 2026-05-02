// ChromaDB client for semantic search over datasets and knowledge graph

const { ChromaClient } = require("chromadb");
const config = require("../llm/config");

let client = null;

// Initialize and return the ChromaDB client
function getClient() {
  if (client == null) {
    client = new ChromaClient({ path: config.CHROMA_URL });
  }
  return client;
}

// Per-name cache of resolved collection handles. Without this every
// hybridSearch round-trips Chroma with getOrCreateCollection BEFORE issuing
// the query — production logs showed 2-3 redundant collection lookups per
// search and 20s retrievals when those compounded across 7 collections.
// Collections are immutable by name once created, so caching the handle is
// safe; we only invalidate on explicit reset (tests / re-ingest scripts).
const collectionCache = new Map();

// Get or create a collection with cosine similarity (cached).
async function getCollection(name) {
  const cached = collectionCache.get(name);
  if (cached) return cached;
  const chroma = getClient();
  const col = await chroma.getOrCreateCollection({
    name,
    metadata: { "hnsw:space": "cosine" },
  });
  collectionCache.set(name, col);
  return col;
}

function resetCollectionCache() {
  collectionCache.clear();
}

// Add documents with embeddings to a collection
async function addDocuments(collectionName, {ids, documents, embeddings, metadatas}) {
  const collection = await getCollection(collectionName);
  await collection.add({ids, documents, embeddings, metadatas});
}

// Semantic search using query embedding -> Returns results sorted by similarity (highest first)
async function searchSemantic(queryEmbedding, collectionName, topK = config.TOP_K_RETRIEVAL) {
  const collection = await getCollection(collectionName);
  const results = await collection.query({
    queryEmbeddings: [queryEmbedding],
    nResults: topK,
  });

  // Convert ChromaDB arrays to results with similarity scores
  // ChromaDB cosine distance = 1 - cosine_similarity
  const items = [];
  for (let i = 0; i < results.ids[0].length; i++) {
    items.push({
      id: results.ids[0][i],
      document: results.documents[0][i],
      metadata: results.metadatas[0][i],
      score: 1 - results.distances[0][i],
    });
  }
  return items;
}

module.exports = { getClient, getCollection, addDocuments, searchSemantic, resetCollectionCache };
