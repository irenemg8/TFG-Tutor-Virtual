# RAG ingest (ChromaDB + BM25)

The retrieval pipeline relies on two complementary indices:

- **BM25** — built in memory at server boot from the dataset JSONs in
  `backend/src/data/datasets/`. No setup required.
- **ChromaDB** — vector store with semantic embeddings of the same dataset
  pairs and the knowledge graph. **Must be populated explicitly** before
  the system can serve traffic with full retrieval quality.

If ChromaDB is empty, the container logs a warning at boot:

```
[Container] WARNING: ChromaDB collections look empty.
Run 'node src/infrastructure/vectordb/ingest.js' to populate them.
```

The hybrid search will silently degrade to BM25-only and the tutor will
miss the semantic-similarity component of retrieval.

## Prerequisites

1. ChromaDB server running (default `http://localhost:8000`, configurable
   via `CHROMA_URL`).
2. Ollama running with the embedding model pulled
   (`nomic-embed-text:latest` by default; configurable via
   `RAG_EMBEDDING_MODEL`).
3. `.env` is loaded from `backend/.env`.

## Run the ingest

```bash
cd backend
node src/infrastructure/vectordb/ingest.js
```

The script:

1. Iterates every entry in `EXERCISE_DATASET_MAP` (`backend/src/infrastructure/llm/config.js`).
2. For each dataset, creates a Chroma collection `exercise_<n>`, generates
   embeddings via Ollama, and uploads the (id, document, metadata, embedding)
   tuples in batches.
3. Ingests the knowledge graph into the `knowledge_graph` collection.

Datasets and KG live under `backend/src/data/` (after the
`material-complementario/llm/` move, April 2026).

## Verify

When the backend starts, the container's health check logs the populated
collections:

```
[Container] Chroma collections: {"exercise_1":42,"exercise_3":31,...}
```

If any collection is `0` or `ERR(...)`, re-run the ingest. The script is
idempotent — it overwrites existing documents with the same ids.

## When to re-ingest

- After editing any file in `backend/src/data/datasets/`.
- After editing the knowledge graph at
  `backend/src/data/knowledge-graph/knowledge-graph-with-interactions-and-rewards.json`.
- After changing `RAG_EMBEDDING_MODEL` (different model = incompatible vectors).
