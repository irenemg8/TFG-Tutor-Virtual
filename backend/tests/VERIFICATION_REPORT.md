# Virtual Tutor — Deployment Manual & Verification Report

## Table of Contents

1. [System Architecture](#1-system-architecture)
2. [Prerequisites](#2-prerequisites)
3. [Environment Configuration](#3-environment-configuration)
4. [Deployment Steps](#4-deployment-steps)
5. [Verification Phases](#5-verification-phases)
6. [Evaluation Framework](#6-evaluation-framework)
7. [Results Summary](#7-results-summary)

---

## 1. System Architecture

The Virtual Tutor is a web application that teaches Ohm's Law using the Socratic method, enhanced by an Agentic RAG (Retrieval-Augmented Generation) system.

### Components

| Component | Technology | Port | Purpose |
|-----------|-----------|------|---------|
| Frontend | React 19 + Vite + Tailwind CSS | 5173 (dev) | Single-page application |
| Backend | Express 5 (Node.js) | 3000 | REST API + SSE streaming |
| Database | MongoDB Atlas | Cloud | Users, exercises, interactions |
| Vector DB | ChromaDB v2 | 8000 | Semantic search (embeddings) |
| LLM | Ollama (qwen2.5) | Remote/11434 | Chat generation |
| Embeddings | Ollama (nomic-embed-text) | Remote/11434 | 768-dim vector embeddings |
| Evaluation | Python 3 (RAGAS + Phoenix) | — | RAG quality metrics |

### RAG Pipeline Flow

```
User message
    |
    v
QueryClassifier (8 types: greeting, dont_know, single_word, wrong_answer,
                  correct_no_reasoning, correct_wrong_reasoning,
                  correct_good_reasoning, wrong_concept)
    |
    v
Router (decides: no_rag / rag_retrieve / scaffold)
    |
    v
Hybrid Search (BM25 + Semantic via ChromaDB, fused with RRF)
    |
    v
CRAG (Corrective RAG: score-based filtering HIGH/MED/LOW)
    |
    v
Knowledge Graph augmentation (concept relationships)
    |
    v
Guardrails (solution leak detection)
    |
    v
Augmented prompt -> Ollama LLM -> SSE stream to client
```

### Project Structure

```
TFG-Tutor-Virtual/
├── backend/
│   ├── src/
│   │   ├── index.js                 # Express server entry point
│   │   ├── rag/                     # Agentic RAG system (12 modules)
│   │   │   ├── config.js            # Central RAG configuration
│   │   │   ├── embeddings.js        # Ollama embedding generation
│   │   │   ├── chromaClient.js      # ChromaDB client wrapper
│   │   │   ├── bm25.js              # BM25 lexical search
│   │   │   ├── hybridSearch.js      # RRF fusion of BM25 + semantic
│   │   │   ├── queryClassifier.js   # 8-type message classification
│   │   │   ├── knowledgeGraph.js    # KG loading and search
│   │   │   ├── ingest.js            # Dataset + KG ingestion into ChromaDB
│   │   │   ├── guardrails.js        # Solution leak prevention
│   │   │   ├── ragPipeline.js       # Full pipeline orchestrator
│   │   │   ├── logger.js            # JSONL interaction logging
│   │   │   └── ragMiddleware.js     # Express middleware (SSE integration)
│   │   └── routes/                  # API routes
│   ├── tests/
│   │   └── verifyRag.js             # Verification script
│   ├── logs/rag/                    # RAG interaction logs (JSONL)
│   ├── package.json
│   └── .env
├── frontend/
│   ├── src/
│   ├── public/
│   ├── vite.config.js
│   ├── package.json
│   └── .env
├── evaluation/
│   ├── config.py                    # Evaluation parameters
│   ├── evaluateRetrieval.py         # Precision@K, Recall@K, MAP@K, MRR
│   ├── evaluateGeneration.py        # RAGAS metrics + basic fallback
│   ├── runBenchmark.py              # End-to-end benchmark runner
│   ├── requirements.txt
│   └── results/
└── material-complementario/
    └── llm/
        ├── datasets/                # 6 exercise dataset JSON files
        └── knowledge-graph/         # KG with 27 concept relationships
```

---

## 2. Prerequisites

### 2.1 Software Requirements

| Software | Version | Installation |
|----------|---------|-------------|
| Node.js | >= 18.x | https://nodejs.org |
| npm | >= 9.x | Included with Node.js |
| Python | >= 3.9 | https://python.org |
| pip | >= 23.x | Included with Python |
| ChromaDB | >= 0.5.x | `pip install chromadb` |
| Git | >= 2.x | https://git-scm.com |

### 2.2 External Services

| Service | Purpose | Access |
|---------|---------|--------|
| MongoDB Atlas | Application database | Cloud — requires connection URI |
| Ollama (PoliGPT) | LLM + embeddings | `https://ollama.gti-ia.upv.es:443` or local `ollama serve` |
| UPV CAS | OAuth2 authentication | `https://poliformat.upv.es` (production only) |

### 2.3 Required Models (Ollama)

| Model | Purpose | Pull command |
|-------|---------|-------------|
| qwen2.5:latest | Chat generation | `ollama pull qwen2.5` |
| nomic-embed-text:latest | 768-dim embeddings | `ollama pull nomic-embed-text` |

> When using the PoliGPT server, models are already available. No need to pull.

---

## 3. Environment Configuration

### 3.1 Backend (.env)

Create `backend/.env` with the following variables:

```env
# MongoDB
MONGODB_URI=mongodb+srv://<user>:<password>@<cluster>.mongodb.net/<dbname>

# Server
PORT=3000
SESSION_SECRET=<random-secret-string>
SERVER_BASE_URL=https://tutor-virtual.dsic.upv.es
FRONTEND_BASE_URL=https://tutor-virtual.dsic.upv.es

# Ollama (choose one: PoliGPT remote OR local)
OLLAMA_API_URL_UPV=https://ollama.gti-ia.upv.es:443
# OLLAMA_BASE_URL=http://127.0.0.1:11434   # Uncomment for local Ollama

# LLM parameters
OLLAMA_MODEL=qwen2.5:latest
OLLAMA_TEMPERATURE=0.4
OLLAMA_NUM_CTX=8192
OLLAMA_NUM_PREDICT=120
OLLAMA_KEEP_ALIVE=60m

# RAG configuration
RAG_ENABLED=true
RAG_EMBEDDING_MODEL=nomic-embed-text:latest
RAG_HIGH_THRESHOLD=0.7
RAG_MED_THRESHOLD=0.4
CHROMA_URL=http://localhost:8000
HISTORY_MAX_MESSAGES=8

# OAuth2 (production only)
CAS_CLIENT_ID=<client-id>
CAS_CLIENT_SECRET=<client-secret>

# Debug
DEBUG=true
```

### 3.2 Frontend (.env)

Create `frontend/.env`:

```env
VITE_BACKEND_URL=https://tutor-virtual.dsic.upv.es
```

For local development, the Vite dev server proxies `/api` requests to `http://localhost` (port 80). If the backend runs on port 3000, update `vite.config.js` accordingly or use a reverse proxy.

### 3.3 Evaluation (.env — optional)

```env
TEST_USER_ID=<mongodb-objectid-of-test-user>
TEST_EXERCISE_IDS={"1":"<objectid>","3":"<objectid>","4":"<objectid>"}
TUTOR_API_URL=http://localhost:3000
```

---

## 4. Deployment Steps

### Step 1 — Clone the Repository

```bash
git clone <repository-url>
cd TFG-Tutor-Virtual
```

### Step 2 — Install Backend Dependencies

```bash
cd backend
npm install
```

This installs: express, mongoose, chromadb, axios, cors, dotenv, express-session, connect-mongo, multer, simple-oauth2, nodemon.

### Step 3 — Install Frontend Dependencies

```bash
cd frontend
npm install
```

This installs: react, react-dom, react-router-dom, vite, tailwindcss, recharts, material-tailwind, headlessui, heroicons.

### Step 4 — Install Python Evaluation Dependencies (optional)

```bash
cd evaluation
pip install -r requirements.txt
```

This installs: ragas, arize-phoenix, pandas, numpy, requests.

### Step 5 — Configure Environment Variables

Create `.env` files as described in [Section 3](#3-environment-configuration).

### Step 6 — Start ChromaDB

```bash
chroma run --host localhost --port 8000
```

ChromaDB stores vector data in the `chroma/` directory. Keep this process running.

### Step 7 — Ingest Data into ChromaDB

```bash
cd backend
node src/rag/ingest.js
```

This ingests:
- 6 exercise datasets into collections `exercise_1` through `exercise_7`
- Knowledge graph (27 entries) into collection `knowledge_graph`
- Builds BM25 in-memory indices for each exercise

> Ingestion requires both Ollama and ChromaDB to be running. It generates embeddings for each document, so it may take several minutes depending on the Ollama server response time.

### Step 8 — Start the Backend Server

```bash
cd backend
npm start
```

The server starts with nodemon on port 3000 (or the port set in `.env`). It connects to MongoDB Atlas and registers all API routes including the RAG middleware.

### Step 9 — Build and Serve the Frontend

**Development:**
```bash
cd frontend
npm run dev
```

**Production:**
```bash
cd frontend
npm run build
```

The build output goes to `frontend/dist/`. Serve it with Nginx or any static file server.

### Step 10 — Production Reverse Proxy (Nginx)

The backend is configured with `trust proxy = 1` for Nginx. A typical Nginx configuration:

```nginx
server {
    listen 443 ssl;
    server_name tutor-virtual.dsic.upv.es;

    # SSL certificates
    ssl_certificate     /path/to/cert.pem;
    ssl_certificate_key /path/to/key.pem;

    # Frontend (static files)
    location / {
        root /path/to/frontend/dist;
        try_files $uri $uri/ /index.html;
    }

    # Backend API
    location /api {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # SSE support (disable buffering)
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 300s;
    }
}
```

> Important: `proxy_buffering off` is required for SSE streaming to work correctly.

---

## 5. Verification Phases

Run the verification script after deployment to confirm everything works:

```bash
cd backend && node tests/verifyRag.js
```

---

### PHASE 0: Prerequisites

#### Step 0.1 — npm Dependencies
- **What it tests**: Loads `chromadb`, `axios`, and `mongoose` via `require()`.
- **Expected**: PASS if all 3 libraries load.
- **If FAIL**:
  - Run `cd backend && npm install`.
  - If a specific package fails: `npm install <package-name>`.
  - Verify `package.json` lists all 3 in `dependencies`.

#### Step 0.2 — Ollama Available
- **What it tests**: GET request to the Ollama API at `/api/tags`, checks that `qwen2.5` and `nomic-embed-text` models are present.
- **Expected**: PASS if server responds and both models are listed.
- **If FAIL**:
  - Verify `.env` has the correct Ollama URL (`OLLAMA_API_URL_UPV=https://ollama.gti-ia.upv.es:443` for PoliGPT, or `OLLAMA_BASE_URL=http://127.0.0.1:11434` for local).
  - Test connectivity: `curl https://ollama.gti-ia.upv.es:443/api/tags` (or `curl http://localhost:11434/api/tags`).
  - If using local Ollama: ensure `ollama serve` is running and both models are pulled (`ollama pull qwen2.5`, `ollama pull nomic-embed-text`).
  - If behind a VPN or firewall, check network access.

#### Step 0.3 — ChromaDB Available
- **What it tests**: GET request to `http://localhost:8000/api/v2/heartbeat`.
- **Expected**: PASS if ChromaDB responds with HTTP 200.
- **If FAIL**:
  - Start ChromaDB: `chroma run --host localhost --port 8000`.
  - Verify port 8000 is free: `netstat -an | grep 8000`.
  - Install ChromaDB if missing: `pip install chromadb`.
  - Note: ChromaDB v2 uses `/api/v2/heartbeat`. If you get HTTP 410, your ChromaDB version may be outdated.

#### Step 0.4 — Data Files Exist
- **What it tests**: Checks that all 6 dataset JSON files and the knowledge graph JSON file exist.
- **Expected**: PASS if all 7 files are found.
- **If FAIL**:
  - Verify `material-complementario/llm/datasets/` contains:
    - `dataset_exercise_1.json`
    - `dataset_exercise_3.json`
    - `dataset_exercise_4.json`
    - `dataset_exercise_5.json`
    - `dataset_exercise_6.json`
    - `dataset_exercise_7.json`
  - Verify `material-complementario/llm/knowledge-graph/` contains:
    - `knowledge-graph-with-interactions-and-rewards.json`
  - These are project data files. If missing, restore from the repository.

---

### PHASE 1: Individual Modules (bottom-up)

#### Step 1.1 — config.js
- **What it tests**: Loads `src/rag/config.js` and checks that all 17 required keys are exported.
- **Expected**: PASS if all keys exist and are non-null.
- **If FAIL**:
  - Open `src/rag/config.js` and check `module.exports` for missing keys.
  - Ensure `.env` exists with required environment variables.
  - Keys checked: `CHROMA_URL`, `EMBEDDING_MODEL`, `OLLAMA_EMBED_URL`, `OLLAMA_CHAT_URL`, `OLLAMA_MODEL`, `HIGH_THRESHOLD`, `MED_THRESHOLD`, `TOP_K_RETRIEVAL`, `TOP_K_FINAL`, `RRF_K`, `BM25_K1`, `BM25_B`, `DATASETS_DIR`, `KG_PATH`, `LOG_DIR`, `EXERCISE_DATASET_MAP`, `RAG_ENABLED`.

#### Step 1.2 — embeddings.js
- **What it tests**: Calls `generateEmbedding("circuito en serie")` and checks the result is an array of 768 numbers.
- **Expected**: PASS if result is `number[]` with length 768.
- **If FAIL**:
  - Requires Step 0.2 (Ollama must be available).
  - Verify `nomic-embed-text:latest` is available on the Ollama server.
  - Check `src/rag/embeddings.js` — ensure it calls `/api/embed` with the correct model name.
  - If array length differs from 768, the model may produce different dimensions. Update the check accordingly.

#### Step 1.3 — chromaClient.js
- **What it tests**: Creates a temporary collection in ChromaDB, adds a document with its embedding, queries it, and cleans up.
- **Expected**: PASS if add + query returns the inserted document.
- **If FAIL**:
  - Requires Steps 0.2 and 0.3 (Ollama + ChromaDB).
  - Check `src/rag/chromaClient.js` for ChromaDB client configuration (URL, tenant, database).
  - Warnings about `DefaultEmbeddingFunction` are expected — we provide embeddings directly.
  - Restart ChromaDB if the connection is stale.

#### Step 1.4 — bm25.js
- **What it tests**: Loads a BM25 index with 3 test document pairs, searches for "resistencia serie", and checks results have positive scores.
- **Expected**: PASS if results have `score > 0`.
- **If FAIL**:
  - Pure in-memory module — no external dependencies.
  - Check `src/rag/bm25.js` for syntax errors.
  - Verify `loadIndex(exerciseNum, pairs)` and `searchBM25(query, exerciseNum, topK)` signatures.

#### Step 1.5 — knowledgeGraph.js
- **What it tests**: Calls `loadKG()` to parse the KG JSON file, then `searchKG(["cortocircuito"])` to search by concept.
- **Expected**: PASS if `loadKG()` loads > 0 entries. Note: `searchKG` may return 0 results depending on the term used — the module is still working correctly.
- **If FAIL**:
  - Requires Step 0.4 (KG file must exist).
  - The KG file contains comma-separated JSON objects without enclosing `[]` brackets. `loadKG()` handles this automatically by wrapping the content.
  - If parsing fails, check the file for malformed JSON (missing commas, unclosed quotes). Wrap the file content manually in `[]` and use `JSON.parse()` to locate the exact error position.

#### Step 1.6 — queryClassifier.js
- **What it tests**: Tests `classifyQuery()` with 3 message types and `extractResistances()`.
- **Expected**: PASS if:
  - `"hola"` → type `"greeting"`
  - `"no sé"` → type `"dont_know"`
  - `"todas"` → type `"single_word"`
  - `extractResistances("R1, R2 y R4")` → `["R1", "R2", "R4"]`
- **If FAIL**:
  - Check `src/rag/queryClassifier.js` for the classification logic.
  - Type values use snake_case strings: `"greeting"`, `"dont_know"`, `"single_word"`, `"wrong_answer"`, etc.
  - `single_word` requires `message.trim().length < 15` AND no resistance names detected.
  - Messages containing resistance names like `"R1"` are classified as `"wrong_answer"`, not `"single_word"`.

#### Step 1.7 — guardrails.js
- **What it tests**: Tests `checkSolutionLeak()` with a safe response and a leaking response, and `getStrongerInstruction()`.
- **Expected**: PASS if safe → `leaked: false`, leak → `leaked: true`, stronger instruction is non-empty.
- **If FAIL**:
  - Check `src/rag/guardrails.js` — leak detection requires the response to mention ALL correct resistances AND contain a reveal phrase.
  - A partial mention should NOT trigger a leak.

#### Step 1.8 — logger.js
- **What it tests**: Calls `logInteraction()` with test data and verifies JSONL file creation in `logs/rag/`.
- **Expected**: PASS if log file exists with valid JSON content.
- **If FAIL**:
  - Check write permissions on `backend/logs/rag/`.
  - Check `src/rag/logger.js` — it creates the directory with `fs.mkdirSync(dir, { recursive: true })`.
  - Log files use the format `YYYY-MM-DD.jsonl`.

---

### PHASE 2: Ingestion

#### Step 2.1 — Run ingest.js

```bash
cd backend && node src/rag/ingest.js
```

- **What it does**: Ingests all 6 datasets + knowledge graph into ChromaDB. Generates embeddings for each document and builds BM25 indices.
- **Expected**: Completes without errors, reports document counts per collection.
- **If FAIL**:
  - All Phase 0 prerequisites must pass first.
  - If ChromaDB connection fails, restart ChromaDB.
  - If embedding generation fails, check Ollama connectivity.
  - If file reading fails, check dataset paths in `config.js`.
  - Ingestion may take several minutes depending on dataset size and Ollama server load.

#### Step 2.2 — Verify ChromaDB Collections
- **What it tests**: Lists ChromaDB collections and checks that `exercise_1`, `exercise_3`, `exercise_4`, `exercise_5`, `exercise_6`, `exercise_7`, and `knowledge_graph` exist with documents.
- **Expected**: PASS if all 7 collections exist with document count > 0.
- **If FAIL**:
  - Re-run ingestion: `node src/rag/ingest.js`.
  - Manually inspect: `curl http://localhost:8000/api/v2/collections`.

#### Step 2.3 — Verify BM25 Index
- **What it tests**: Loads a dataset, builds a BM25 index, and runs a test search.
- **Expected**: PASS if search returns results with positive scores.
- **If FAIL**:
  - BM25 is in-memory — if datasets are valid JSON with `"student"` and `"tutor"` fields, this should work.

---

### PHASE 3: Hybrid Search

#### Step 3.1 — hybridSearch.js
- **What it tests**: After ingestion, calls `hybridSearch("resistencia en serie", 1, 3)` and verifies results.
- **Expected**: PASS if it returns up to 3 results with `student`, `tutor`, `score` fields, sorted by score descending.
- **If FAIL**:
  - Requires Phase 2 (data must be ingested first).
  - Check `src/rag/hybridSearch.js` — it fuses BM25 + semantic search using RRF.
  - If semantic search fails, check ChromaDB collections.
  - If BM25 fails, check that the index was loaded for the exercise number.

---

### PHASE 4: Full Pipeline

#### Step 4.1 — ragPipeline.js
- **What it tests**: Calls `runFullPipeline()` with a test message, exerciseNum=1, correctAnswer=["R1","R2","R4"], userId=null.
- **Expected**: PASS if it returns an object with `decision`, `classification`, and `augmentation` fields.
- **If FAIL**:
  - Requires Phases 1-3.
  - Check `src/rag/ragPipeline.js` — orchestrates: classify → route → retrieve → CRAG → augment.
  - Debug by checking each sub-module individually.

#### Step 4.2 — Classification Type Routing
- **What it tests**: Runs the pipeline with different message types:
  - `"hola"` → `decision: "no_rag"` (greeting, no retrieval)
  - `"no sé"` → decision with scaffolding augmentation
  - `"R1, R2 y R4 porque están en serie"` → decision with retrieved docs
- **Expected**: PASS if each type routes correctly.
- **If FAIL**:
  - Check routing logic in `ragPipeline.js`.
  - Greetings and "don't know" messages bypass RAG retrieval.
  - Technical answers trigger hybrid search and context augmentation.

---

### PHASE 5: HTTP Middleware (end-to-end)

#### Step 5.1 — Start the Server

```bash
cd backend && npm start
```

- **Expected**: Server listening on port 3000, `GET /api/health` returns HTTP 200.
- **If FAIL**:
  - Check `.env` for correct MongoDB URI and port.
  - Check for port conflicts: `netstat -an | grep 3000`.
  - Verify MongoDB Atlas is accessible (check IP whitelist).

#### Step 5.2 — POST /api/ollama/chat/stream
- **What it tests**: Sends a POST request with valid exerciseId, userId, and userMessage. Parses the SSE stream.
- **Expected**: PASS if SSE events are received with text chunks, ending with `[DONE]`.
- **If FAIL**:
  - Requires valid MongoDB ObjectIds for user and exercise (must exist in the database).
  - Set environment variables:
    ```bash
    export TEST_USER_ID=<mongodb-objectid>
    export TEST_EXERCISE_IDS='{"1":"<objectid>","3":"<objectid>"}'
    ```
  - Check `src/index.js` — RAG middleware (`app.use("/api/ollama", ragMiddleware)`) must be registered BEFORE `ollamaChatRoutes`.
  - Check `src/rag/ragMiddleware.js` — it intercepts `POST /chat/stream`.
  - Check server console for errors.

#### Step 5.3 — Fallthrough to Original Handler
- **What it tests**: Sends a greeting message (produces `no_rag` decision) and verifies the original Ollama handler responds.
- **Expected**: PASS if SSE response comes from the original handler.
- **If FAIL**:
  - Check that `ragMiddleware.js` calls `next()` correctly for `no_rag` decisions.
  - Check `RAG_ENABLED` in `.env` — set to `true` unless testing disabled mode.

#### Step 5.4 — Verify Logging
- **What it tests**: After Step 5.2, checks that a new JSONL entry was written to `logs/rag/`.
- **Expected**: PASS if the log file contains the interaction entry.
- **If FAIL**:
  - Check `src/rag/logger.js` and `src/rag/ragMiddleware.js`.
  - Check write permissions on `backend/logs/rag/`.

---

### PHASE 6: Evaluation Scripts (Python)

#### Step 6.1 — Verify config.py

```bash
cd evaluation && python -c "import config; print(config.DATASET_MAP)"
```

- **Expected**: Prints the dataset map dictionary.
- **If FAIL**:
  - Check `evaluation/config.py` exists and has no syntax errors.
  - Ensure Python 3 is installed: `python --version`.

#### Step 6.2 — evaluateRetrieval.py (dry run)

```bash
cd evaluation && python evaluateRetrieval.py
```

- **Expected**: Prints "No log entries found" without crashing (no logs available yet).
- **If FAIL**:
  - Check for import errors in `evaluateRetrieval.py`.
  - Install dependencies: `pip install -r requirements.txt`.
  - Verify `config.py` path constants resolve correctly.

#### Step 6.3 — evaluateGeneration.py (dry run)

```bash
cd evaluation && python evaluateGeneration.py
```

- **Expected**: Handles empty case without errors.
- **If FAIL**:
  - Same troubleshooting as Step 6.2.
  - If RAGAS is not installed, the script falls back to basic metrics — this fallback should also handle the empty case.

#### Step 6.4 — Full Benchmark (after interactions exist)

```bash
cd evaluation && python runBenchmark.py
```

- **Requires**: Server running, `TEST_USER_ID` and `TEST_EXERCISE_IDS` environment variables set.
- **What it does**: Sends test queries to the RAG endpoint, collects responses, then runs both retrieval and generation evaluation metrics.
- **Output**: JSON files in `evaluation/results/`:
  - `benchmarkResults.json` — raw query/response pairs
  - `retrievalMetrics.json` — Precision@K, Recall@K, MAP@K, MRR
  - `ragasMetrics.json` (or `generationMetricsBasic.json`) — generation quality

---

## 6. Evaluation Framework

### Retrieval Metrics

| Metric | Description | Good value |
|--------|-------------|------------|
| Precision@K | Fraction of retrieved docs that are relevant | > 0.6 |
| Recall@K | Fraction of relevant docs that were retrieved | > 0.5 |
| MAP@K | Mean Average Precision across queries | > 0.5 |
| MRR | Mean Reciprocal Rank of first relevant result | > 0.7 |

### Generation Metrics (RAGAS)

| Metric | Description | Good value |
|--------|-------------|------------|
| Faithfulness | Response is grounded in retrieved context | > 0.7 |
| Answer Relevancy | Response addresses the question asked | > 0.7 |
| Context Precision | Retrieved context is relevant to the question | > 0.6 |
| Context Recall | Retrieved context covers the ground truth | > 0.6 |

### Basic Generation Metrics (fallback if RAGAS not installed)

| Metric | Description | Good value |
|--------|-------------|------------|
| Socratic Rate | Fraction of responses containing `?` | > 0.7 |
| Avg Question Words | Average count of question words per response | > 1.0 |
| Guardrail Safe Rate | Fraction of responses without solution leaks | > 0.95 |
| Avg Response Length | Average response length in characters | 50-300 |

---

## 7. Results Summary

### Verification Script Results

| Phase | Step | Description | Status |
|-------|------|-------------|--------|
| 0 | 0.1 | npm dependencies | PASS |
| 0 | 0.2 | Ollama (PoliGPT server) | PASS |
| 0 | 0.3 | ChromaDB v2 | PASS |
| 0 | 0.4 | Data files (6 datasets + KG) | PASS |
| 1 | 1.1 | config.js (17 keys) | PASS |
| 1 | 1.2 | embeddings.js (768-dim vectors) | PASS |
| 1 | 1.3 | chromaClient.js (CRUD) | PASS |
| 1 | 1.4 | bm25.js (index + search) | PASS |
| 1 | 1.5 | knowledgeGraph.js (27 entries) | PASS |
| 1 | 1.6 | queryClassifier.js (3 types) | PASS |
| 1 | 1.7 | guardrails.js (leak detection) | PASS |
| 1 | 1.8 | logger.js (JSONL logging) | PASS |
| 2 | 2.1 | Ingestion (ingest.js) | PASS — 198 pairs + 27 KG entries |
| 2 | 2.2 | ChromaDB collections | PASS — 7 collections with documents |
| 2 | 2.3 | BM25 index verification | PASS |
| 3 | 3.1 | Hybrid search (RRF fusion) | PASS — 3 results, sorted descending |
| 4 | 4.1 | Full pipeline | PASS — correct_wrong_reasoning, 3475 chars |
| 4 | 4.2 | Classification routing | PASS — greeting/dont_know/wrong_answer |
| 5 | 5.1 | Server start | PASS — /api/health returns 200 |
| 5 | 5.2 | HTTP SSE streaming | PASS — Socratic response via SSE |
| 5 | 5.3 | Middleware fallthrough | PASS — greeting calls next() |
| 5 | 5.4 | Interaction logging | PASS — JSONL entry with full data |
| 6 | 6.1 | config.py imports | PASS |
| 6 | 6.2 | evaluateRetrieval.py | PASS — handles empty case |
| 6 | 6.3 | evaluateGeneration.py | PASS — handles empty case |

### Deployment Checklist

- [ ] Repository cloned
- [ ] Backend dependencies installed (`npm install`)
- [ ] Frontend dependencies installed (`npm install`)
- [ ] Environment variables configured (`.env` files)
- [ ] ChromaDB running on port 8000
- [ ] Ollama accessible (PoliGPT or local)
- [ ] Data ingested into ChromaDB (`node src/rag/ingest.js`)
- [ ] Backend server running (`npm start`)
- [ ] Frontend built (`npm run build`)
- [ ] Nginx reverse proxy configured (production)
- [ ] SSL certificates installed (production)
- [ ] Verification script passes all steps
- [ ] Evaluation scripts run without errors
