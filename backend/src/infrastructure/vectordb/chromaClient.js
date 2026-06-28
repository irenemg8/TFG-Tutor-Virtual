const { ChromaClient } = require("chromadb");
const config = require("../llm/config");

/*------------------------------------------------------------------------------
            _________________________________________________________
            |                     CHROMA CLIENT                     |
            |  ChromaDB client for semantic search over datasets    |
            |  and the knowledge graph. Lazily creates the client   |
            |  and caches collection handles by name.               |
            |                                                       |
            |          -> | getClient()       | -> ChromaClient     |
            |        Txt -> | getCollection()  | -> Promise<Obj>     |
            |   Txt, Obj -> | addDocuments()   | -> Promise<void>    |
            |   [R], Txt, Z, Obj -> | searchSemantic() | -> Promise<[Obj]> |
            |          -> | resetCollectionCache() | -> void         |
            |_______________________________________________________|
------------------------------------------------------------------------------*/

let client = null;

/*
       ____|____________
      | getClient() | -> ChromaClient
       -------------
      Lazily creates and returns the singleton ChromaDB client pointed
      at config.CHROMA_URL.
*/
function getClient() {
  if (client == null) {
    client = new ChromaClient({ path: config.CHROMA_URL });
  }
  return client;
}

const collectionCache = new Map();

/*
   Txt -> ____|________________
         | getCollection() | -> Promise<Obj>
          -----------------
      Returns the cosine-similarity collection handle for the given
      name, caching it so repeated searches skip the getOrCreate
      round-trip. Collections are immutable by name once created.
*/
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

/*
       ____|_______________________
      | resetCollectionCache() | -> void
       -------------------------
      Clears the cached collection handles (used by tests and re-ingest
      scripts).
*/
function resetCollectionCache() {
  collectionCache.clear();
}

/*
   Txt, Obj -> ____|________________
              | addDocuments() | -> Promise<void>
               ----------------
      Adds documents with their ids, embeddings and metadatas to the
      named collection.
*/
async function addDocuments(collectionName, {ids, documents, embeddings, metadatas}) {
  const collection = await getCollection(collectionName);
  await collection.add({ids, documents, embeddings, metadatas});
}

/*
   [R], Txt, Z, Obj -> ____|__________________
                      | searchSemantic() | -> Promise<[Obj]>
                       ------------------
      Queries the collection with the query embedding and resolves
      results sorted by similarity (highest first). options.signal lets
      the pipeline abort a slow query: the query is raced against the
      abort and surfaces an AbortError.
*/
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
