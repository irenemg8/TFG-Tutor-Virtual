# Deployment Guide

This guide walks you through deploying the virtual tutor from scratch: the backend (Node.js / Express, hexagonal), the React frontend, PostgreSQL, ChromaDB, and an LLM provider. By the end you will have the system running locally (or on the UPV server via the deployment script).

> The chat model is referred to as **qwen2.5**. The real-time pipeline monitor is out of scope.

---

## Table of Contents

1. [Prerequisites](#prerequisites)
2. [Step 1 — Clone & Install](#step-1--clone--install)
3. [Step 2 — PostgreSQL](#step-2--postgresql)
4. [Step 3 — ChromaDB](#step-3--chromadb)
5. [Step 4 — LLM Provider](#step-4--llm-provider)
6. [Step 5 — Environment Configuration](#step-5--environment-configuration)
7. [Step 6 — Start the Backend (migrations + warmup)](#step-6--start-the-backend-migrations--warmup)
8. [Step 7 — Ingest Data into ChromaDB](#step-7--ingest-data-into-chromadb)
9. [Step 8 — Frontend](#step-8--frontend)
10. [One-Shot Windows Deployment](#one-shot-windows-deployment)
11. [Verification](#verification)
12. [Using the Application](#using-the-application)
13. [Troubleshooting](#troubleshooting)

---

## Prerequisites

| Software / service | Min version | Notes |
|---|---|---|
| **Node.js** | 18+ | Backend & frontend |
| **npm** | 9+ | Ships with Node |
| **PostgreSQL** | 14+ (server runs 18) | Primary database |
| **ChromaDB** | recent | `pip install chromadb` |
| **Python** | 3.10+ | ChromaDB + evaluation |
| **An LLM provider** | — | Local/remote **Ollama** (with `qwen2.5` + `nomic-embed-text`) **or** **PoliGPT** (API key) |

The default services and ports:

| Service | Port |
|---|---|
| Backend (HTTP) | 3001 (behind nginx at `/v2/` in production) |
| ChromaDB | 8000 |
| PostgreSQL | 5432 |
| Frontend (dev) | 5173 |

---

## Step 1 — Clone & Install

```bash
git clone <repo-url> TFG-Tutor-Virtual
cd TFG-Tutor-Virtual

cd backend  && npm install
cd ../frontend && npm install
cd ..
```

Backend dependencies of note: `express` 5, `pg` + `connect-pg-simple` (PostgreSQL & sessions), `chromadb`, `ws`, `simple-oauth2` (CAS), `axios`/`node-fetch`. There is **no** Mongoose.

---

## Step 2 — PostgreSQL

1. Install PostgreSQL and start the service.
2. Create a database (e.g. `tutorvirtual`) and a user:

```sql
CREATE DATABASE tutorvirtual;
CREATE USER tutor WITH PASSWORD 'your-password';
GRANT ALL PRIVILEGES ON DATABASE tutorvirtual TO tutor;
```

3. Put the connection string in `backend/.env` as `PG_CONNECTION_STRING`, e.g.
   `postgresql://tutor:your-password@127.0.0.1:5432/tutorvirtual`.

You do **not** create tables by hand — the backend runs all SQL migrations automatically on boot (see [Step 6](#step-6--start-the-backend-migrations--warmup)).

### Seed exercises

Exercises live in the `ejercicios` / `tutor_contexts` tables. A seed script is provided:

```bash
cd backend && node src/scripts/seed_ejercicios_local.js
```

Each exercise's `tutor_contexts.respuesta_correcta` (the correct element set) and `elementos_evaluables` are critical — they drive classification, guardrails and the deterministic finish.

---

## Step 3 — ChromaDB

Install and run the vector store:

```bash
pip install chromadb
chroma run --host localhost --port 8000
```

Keep this running. Collections are created later by the ingestion script and persist on disk across restarts. (Set `CHROMA_REQUIRED=false` to let the backend start in BM25-only mode if Chroma is empty.)

---

## Step 4 — LLM Provider

Pick one provider; both satisfy the same interface and the docs call the model **qwen2.5**.

**Option A — Ollama (local or UPV).** Pull the models on a local Ollama:

```bash
ollama pull qwen2.5
ollama pull nomic-embed-text
```

Set `LLM_PROVIDER=ollama`. Use `LLM_MODE=local` for `http://127.0.0.1:11434`, or `LLM_MODE=upv` with `OLLAMA_API_URL_UPV` for the university server.

**Option B — PoliGPT (UPV gateway).** Set `LLM_PROVIDER=poligpt`, `POLIGPT_BASE_URL=https://api.poligpt.upv.es`, `POLIGPT_API_KEY=…`, and `EMBEDDING_PROVIDER=openai` (embeddings via PoliGPT's OpenAI-compatible endpoint).

---

## Step 5 — Environment Configuration

Copy `backend/.env.example` to `backend/.env` and fill it in. Minimum to run locally:

```env
# Database
DATABASE_TYPE=postgresql
PG_CONNECTION_STRING=postgresql://tutor:your-password@127.0.0.1:5432/tutorvirtual

# Server
PORT=3001
NODE_ENV=development
SESSION_SECRET=<random-long-string>
FRONTEND_BASE_URL=http://localhost:5173

# LLM (Ollama local example)
LLM_PROVIDER=ollama
LLM_MODE=local
OLLAMA_API_URL_LOCAL=http://127.0.0.1:11434
OLLAMA_MODEL=qwen2.5
OLLAMA_CLASSIFIER_MODEL=qwen2.5

# Vector store
CHROMA_URL=http://localhost:8000

# Pipeline
USE_ORCHESTRATOR=1
RAG_ENABLED=true

# Auth (development): skip CAS
DEV_BYPASS_AUTH=true
```

Notes:
- `USE_ORCHESTRATOR=1` enables the 10-agent pipeline; with `0` the legacy linear pipeline handles chat.
- `DEV_BYPASS_AUTH=true` skips CAS — the server **refuses to start** if this is on while `NODE_ENV=production`.
- For production CAS, set `CAS_BASE_URL`, `OAUTH_CLIENT_ID/SECRET`, `OAUTH_REDIRECT_URI`, `OAUTH_SCOPES`, and a strong `SESSION_SECRET`.
- See [backend.md](backend.md) for the full environment-variable reference.

The frontend reads `VITE_BACKEND_URL` / `VITE_BASE_PATH` from `frontend/.env` (defaults target the dev proxy).

---

## Step 6 — Start the Backend (migrations + warmup)

```bash
cd backend && npm start          # nodemon src/index.js  (use start:prod in production)
```

On boot the backend:
1. mounts middleware and routes, then listens on `PORT`;
2. initializes the DI container — **runs all SQL migrations**, wires the repositories, the LLM adapter, the guardrail pipeline and the orchestrator;
3. loads the knowledge graph and per-exercise BM25 indices, and checks ChromaDB;
4. warms up the LLM (Ollama) in the background.

Look for log lines confirming the container initialized, `USE_ORCHESTRATOR` state, KG loaded, and the server listening.

---

## Step 7 — Ingest Data into ChromaDB

First time only (and whenever datasets change), embed the datasets and knowledge graph into ChromaDB:

```bash
cd backend && node src/infrastructure/vectordb/ingest.js
```

This creates the `exercise_{n}` collections (from `backend/src/data/datasets/`) and the `knowledge_graph` collection (from `backend/src/data/knowledge-graph/…json`). Requires the embedding model/endpoint to be reachable. Data persists on disk, so this is a one-time step per environment.

---

## Step 8 — Frontend

```bash
cd frontend && npm run dev       # → http://localhost:5173
```

For production, `npm run build` produces `frontend/dist`, which the backend serves with an SPA fallback (and nginx exposes under `/v2/`).

---

## One-Shot Windows Deployment

`deploy-hexagonal.ps1` (project root) orchestrates the whole server-side deployment: it validates the PostgreSQL service, Node and nginx; auto-detects a ChromaDB launcher; patches `backend/.env` with the connection string if missing; optionally builds the frontend; and starts everything.

```powershell
.\deploy-hexagonal.ps1                 # full deploy
.\deploy-hexagonal.ps1 -BuildFrontend  # also build frontend/dist
.\deploy-hexagonal.ps1 -DebugPipeline  # enable [DEBUG_PIPELINE] logs
.\deploy-hexagonal.ps1 -SkipEnvPatch   # don't touch .env
.\deploy-hexagonal.ps1 -StopAll        # stop all services
```

Key parameters (override at the top of the script or via `-Param`): `ProjectRoot`, `NginxDir`, `PgServiceName`, `BackendPort` (3001), `ChromaPort` (8000), `PgPort` (5432), `ChromaCmd` (auto-detected if empty), `PgConnectionString`. The backend runs on `127.0.0.1:3001` and nginx exposes it at `/v2/`.

To benchmark different LLMs, see the per-model `.env` presets in [evaluation.md](evaluation.md).

---

## Verification

`verify.ps1` runs a prerequisites/health checklist (Node, npm dependencies incl. `pg`, Python, the LLM endpoint with `qwen2.5` + `nomic-embed-text`, ChromaDB heartbeat, dataset/KG files, server and backend health). Run it before/after starting services:

```powershell
.\verify.ps1
# or, if execution policy blocks it:
powershell -ExecutionPolicy Bypass -File verify.ps1
```

Each check prints `[PASS]`, `[FAIL]` or `[SKIP]`, with a final summary. Some checks require the backend to be up.

A quick manual health check: `GET http://localhost:3001/api/health`.

---

## Using the Application

1. Open `http://localhost:5173`.
2. Sign in. In development (`DEV_BYPASS_AUTH=true`) the dev login is used; in production you authenticate through CAS.
3. Pick an exercise, read the circuit, and type your answer in the chat.
4. The tutor replies with Socratic questions — it never reveals the answer.
5. The exercise ends when you identify the correct elements with sound reasoning (the response carries an `<END_EXERCISE>` token). The result (analysis, advice, detected alternative conceptions) is then computed and stored.
6. View your progress on the dashboard.

---

## Troubleshooting

### PostgreSQL connection
- Verify `PG_CONNECTION_STRING` (user, password, host, port, database).
- Confirm the PostgreSQL service is running and the database exists.
- The backend runs migrations on boot — check the startup logs for migration errors.

### LLM not responding
- **Ollama (local):** ensure `ollama serve` is running and `ollama list` shows `qwen2.5` and `nomic-embed-text`. Check `LLM_MODE`/`OLLAMA_API_URL_*`.
- **Ollama (UPV) / PoliGPT:** verify the URL/API key and network/VPN. Watch for `BudgetExhaustedError` (timeouts) — the tutor returns a localized "taking too long" fallback.

### ChromaDB
- "ChromaDB not available": start `chroma run --host localhost --port 8000`; confirm `CHROMA_URL`.
- Empty collections: run the ingestion script (Step 7); the embedding endpoint must be reachable. To start anyway in BM25-only mode, set `CHROMA_REQUIRED=false`.

### Auth
- `401` on `/api/*`: no session — sign in, or set `DEV_BYPASS_AUTH=true` for local dev.
- Server refuses to start: `DEV_BYPASS_AUTH=true` with `NODE_ENV=production` is forbidden.

### CORS
- Browser CORS errors: set `FRONTEND_BASE_URL` to the actual frontend origin and restart the backend.

### Slow responses
- The LLM call is the bottleneck. Reduce `OLLAMA_NUM_PREDICT`, raise `OLLAMA_KEEP_ALIVE`, or check provider latency. The orchestrator's per-stage budget (`ORCHESTRATOR_BUDGET_MS`) bounds total time.

### Logs
| Log | Location | Content |
|---|---|---|
| Backend console | terminal running `npm start` | startup, container init, pipeline traces |
| Audit log | `backend/logs/audit/YYYY-MM-DD.jsonl` (when `AUDIT_LOG=1`) | per-event pipeline audit |
| Pipeline trace | console `[TRACE]` (when `DEBUG_PIPELINE=1`) | per-request budget, LLM calls, guardrails |
| Browser console | F12 | frontend / SSE errors |

For architecture and internals, see [architecture-diagrams.md](architecture-diagrams.md), [backend.md](backend.md) and [rag-system.md](rag-system.md).
```
