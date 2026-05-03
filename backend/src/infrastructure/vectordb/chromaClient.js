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
// `options.signal` lets the retrieval pipeline abort a slow Chroma query when
// the per-stage budget runs out. Chroma's JS client doesn't expose AbortSignal
// natively, so we race the query against signal abort and surface AbortError.
async function searchSemantic(queryEmbedding, collectionName, topK = config.TOP_K_RETRIEVAL, options) {
  options = options || {};
  const collection = await getCollection(collectionName);
  const queryPromise = collection.query({
    queryEmbeddings: [queryEmbedding],
    nResults: topK,
  });

  let results;
  if (options.signal) {
    if (options.signal.aborted) {
      const err = new Error("searchSemantic aborted");
      err.name = "AbortError";
      throw err;
    }
    let abortHandler;
    const abortPromise = new Promise((_, reject) => {
      abortHandler = () => {
        const err = new Error("searchSemantic aborted");
        err.name = "AbortError";
        reject(err);
      };
      options.signal.addEventListener("abort", abortHandler, { once: true });
    });
    try {
      results = await Promise.race([queryPromise, abortPromise]);
    } finally {
      if (abortHandler) options.signal.removeEventListener("abort", abortHandler);
    }
  } else {
    results = await queryPromise;
  }

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
