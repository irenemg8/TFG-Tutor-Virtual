# Deployment Guide

This guide walks you through deploying the entire application from scratch, assuming no prior knowledge of the project. By the end, you will have the backend server, frontend application, and workflow monitor all running locally.

---

## Table of Contents

1. [Prerequisites](#prerequisites)
2. [Step 1: Clone and Install](#step-1-clone-and-install)
3. [Step 2: Environment Configuration](#step-2-environment-configuration)
4. [Step 3: Database Setup](#step-3-database-setup)
5. [Step 4: Verification](#step-4-verification)
6. [Step 5: Start Services](#step-5-start-services)
7. [Step 6: Using the Application](#step-6-using-the-application)
8. [Troubleshooting](#troubleshooting)

---

## Prerequisites

Before starting, make sure you have the following installed:

### Required Software

| Software | Minimum Version | How to Check | Install From |
|---|---|---|---|
| **Node.js** | v18+ | `node --version` | [nodejs.org](https://nodejs.org) |
| **npm** | v9+ | `npm --version` | Included with Node.js |
| **Python** | 3.10+ | `python --version` | [python.org](https://python.org) |
| **Git** | Any | `git --version` | [git-scm.com](https://git-scm.com) |

### Required Services

| Service | Description | Default URL |
|---|---|---|
| **MongoDB Atlas** | Cloud database for storing exercises, interactions, and users | Connection string in `.env` |
| **Ollama** | Local or remote LLM inference server | `http://127.0.0.1:11434` or university server |
| **ChromaDB** | Vector database for semantic search | `http://localhost:8000` |

### Ollama Models

The system requires two models loaded in Ollama:

1. **qwen2.5:latest** — The chat model used for generating tutor responses
2. **nomic-embed-text:latest** — The embedding model used for semantic search

If using a local Ollama, pull the models:

```bash
ollama pull qwen2.5:latest
ollama pull nomic-embed-text:latest
```

### ChromaDB Installation

ChromaDB can be installed via pip:

```bash
pip install chromadb
```

---

## Step 1: Clone and Install

### Clone the Repository

```bash
git clone https://github.com/irenemg8/TFG-Tutor-Virtual.git
cd TFG-Tutor-Virtual
```

### Install Dependencies

Install npm packages for each component:

```bash
# Backend
cd backend
npm install

# Frontend
cd ../frontend
npm install

# Workflow Monitor (optional, for debugging)
cd ../workflow
npm install

# Return to project root
cd ..
```

### Install Python Dependencies (for evaluation)

```bash
cd evaluation
pip install -r requirements.txt
cd ..
```

---

## Step 2: Environment Configuration

### Backend Environment

Create (or edit) the file `backend/.env` with the following variables:

```env
# ==========================================
# Database
# ==========================================
MONGODB_URI=mongodb+srv://<username>:<password>@<cluster>.mongodb.net/<database>?retryWrites=true&w=majority

# ==========================================
# Ollama (LLM)
# ==========================================
# If using a remote Ollama server (e.g., university):
OLLAMA_API_URL_UPV=https://your-ollama-server.example.com:443

# If using a local Ollama:
# OLLAMA_BASE_URL=http://127.0.0.1:11434

# Model configuration
OLLAMA_MODEL=qwen2.5:latest
OLLAMA_TEMPERATURE=0.4
OLLAMA_NUM_CTX=8192
OLLAMA_NUM_PREDICT=120
OLLAMA_KEEP_ALIVE=60m

# ==========================================
# RAG System
# ==========================================
RAG_ENABLED=true
RAG_EMBEDDING_MODEL=nomic-embed-text:latest
CHROMA_URL=http://localhost:8000
RAG_HIGH_THRESHOLD=0.7
RAG_MED_THRESHOLD=0.4
HISTORY_MAX_MESSAGES=8
RAG_MAX_WRONG_STREAK=4
RAG_MAX_TOTAL_TURNS=16

# ==========================================
# Authentication
# ==========================================
SESSION_SECRET=your-random-secret-key-here

# For development (skip CAS authentication):
DEV_BYPASS_AUTH=true

# For production (CAS OAuth2):
# CAS_CLIENT_ID=your-cas-client-id
# CAS_CLIENT_SECRET=your-cas-client-secret
# CAS_REDIRECT_URI=http://localhost:3000/auth/callback

# ==========================================
# Application
# ==========================================
PORT=3000
FRONTEND_BASE_URL=http://localhost:5173
WORKFLOW_BASE_URL=http://localhost:5174
```

**Important notes:**

- Replace `<username>`, `<password>`, `<cluster>`, and `<database>` with your MongoDB Atlas credentials
- If using a university Ollama server, set `OLLAMA_API_URL_UPV` to its URL. If running Ollama locally, uncomment `OLLAMA_BASE_URL`
- For development, keep `DEV_BYPASS_AUTH=true` to skip university CAS authentication
- Generate a random string for `SESSION_SECRET` (e.g., `openssl rand -hex 32`)

### Frontend Environment

Create the file `frontend/.env`:

```env
VITE_API_BASE_URL=http://localhost:3000
```

---

## Step 3: Database Setup

### MongoDB Atlas

1. Create a free MongoDB Atlas account at [mongodb.com/atlas](https://www.mongodb.com/atlas)
2. Create a new cluster
3. Create a database user with read/write permissions
4. Add your IP address to the network access whitelist (or use `0.0.0.0/0` for development)
5. Copy the connection string and paste it as `MONGODB_URI` in `backend/.env`

### Seed Exercise Data

The MongoDB database needs exercise documents in the `ejercicios` collection. Each exercise should follow this structure:

```json
{
  "titulo": "Ejercicio 1",
  "enunciado": "Determine qué resistencias contribuyen al divisor de tensión...",
  "imagen": "ejercicio1.png",
  "asignatura": "Tecnología Electrónica",
  "concepto": "Divisor de tensión",
  "nivel": 1,
  "tutorContext": {
    "objetivo": "Identificar resistencias en el divisor de tensión",
    "netlist": "R1(nodo1,nodo2) R2(nodo2,nodo3)...",
    "modoExperto": "Socratic tutoring mode",
    "ac_refs": ["AC_LOCAL_ATTENUATION"],
    "respuestaCorrecta": ["R1", "R2", "R4"],
    "version": 1
  }
}
```

The `tutorContext.respuestaCorrecta` field is critical — it tells the RAG system which resistances are correct for guardrail checking and classification.

### Data Files

Ensure the following data files exist in the project:

```
material-complementario/
└── llm/
    ├── datasets/
    │   ├── dataset_exercise_1.json
    │   ├── dataset_exercise_3.json
    │   ├── dataset_exercise_4.json
    │   ├── dataset_exercise_5.json
    │   ├── dataset_exercise_6.json
    │   └── dataset_exercise_7.json
    └── knowledge-graph/
        └── knowledge-graph-with-interactions-and-rewards.json
```

These files contain the student-tutor conversation pairs and knowledge graph entries used by the RAG system.

---

## Step 4: Verification

Before starting the services, run the verification script to check that everything is properly configured.

### Terminal 1 — Verification Script

```powershell
.\verify.ps1
```

Or if PowerShell execution policy blocks it:

```powershell
powershell -ExecutionPolicy Bypass -File verify.ps1
```

### What the Verification Script Checks

The script runs through 5 phases:

#### Phase 0: Prerequisites

| Check | What It Verifies |
|---|---|
| 0.1 | Node.js is installed |
| 0.2 | npm dependencies are installed (chromadb, axios, mongoose packages exist in node_modules) |
| 0.3 | Python 3 is installed |
| 0.4 | Ollama is reachable and has both required models (qwen2.5 + nomic-embed-text) |
| 0.5 | ChromaDB is running at `http://localhost:8000` |
| 0.6 | All 6 dataset files + knowledge graph file exist |
| 0.7 | Environment files exist (backend/.env, frontend/.env) |

#### Phase 1: RAG Modules

| Check | What It Verifies |
|---|---|
| 1.1 | All 12 RAG modules exist in `backend/src/rag/` |
| 1.2 | `verifyRag.js` passes all internal checks (module loading, ingestion, pipeline execution) |

#### Phase 2: Server

| Check | What It Verifies |
|---|---|
| 2.1 | Backend server responds to health check at `http://localhost:3000/api/health` |
| 2.2 | RAG SSE endpoint works (sends a test query, receives response chunks + [DONE]) |
| 2.3 | RAG logging is active (today's JSONL log file exists and contains valid entries) |

#### Phase 3: Evaluation Scripts

| Check | What It Verifies |
|---|---|
| 3.1 | `evaluation/config.py` loads correctly (7 datasets configured) |
| 3.2 | `evaluateRetrieval.py` runs without errors |
| 3.3 | `evaluateGeneration.py` runs without errors |
| 3.4 | `runBenchmark.py` exists |

#### Phase 4: Integration Check

| Check | What It Verifies |
|---|---|
| 4.1 | RAG middleware is properly registered in `index.js` (require + app.use) |
| 4.2 | ChromaDB has at least 7 collections (one per exercise + knowledge graph) |

### Interpreting Results

Each check shows `[PASS]`, `[FAIL]`, or `[SKIP]`:

- **PASS** — Check succeeded
- **FAIL** — Check failed. The error message explains what is wrong and how to fix it
- **SKIP** — Check was skipped because a prerequisite check failed (e.g., server checks are skipped if the server is not running)

The final summary shows total PASS/FAIL/SKIP counts. If all checks pass, the system is ready.

**Note:** Some checks (Phase 2) require the backend server to be running. You may want to run the verification script in two passes — first to check prerequisites (Phase 0-1, 3-4), then again after starting the server to check Phase 2.

---

## Step 5: Start Services

The application requires multiple services running simultaneously. Open a separate terminal for each.

### Terminal 2 — ChromaDB

```bash
chroma run --host localhost --port 8000
```

Expected output:
```
                chroma 0.x.x
Running Chroma
Saving data to: ./chroma_data
Anonymized telemetry enabled
Running on http://localhost:8000
```

ChromaDB stores its data in the current directory by default. Keep this terminal open.

### Terminal 3 — Backend

```bash
cd backend
npm start
```

Expected output:
```
✅ BACKEND INDEX CARGADO: .../backend/src/index.js
Conectado a MongoDB Atlas
Knowledge graph loaded: 27 entries
[RAG] Ready
[Workflow] WebSocket server ready on /ws/workflow
✅ Backend (HTTP interno) escuchando en puerto 3000
[OLLAMA] Warmup OK (UPV)
```

Key things to verify:
- "Conectado a MongoDB Atlas" — database connection successful
- "[RAG] Ready" — RAG system initialized (KG + BM25 loaded)
- "escuchando en puerto 3000" — server is accepting requests

### Ingest Data into ChromaDB (first time only)

If this is the first time running the application, you need to ingest the datasets into ChromaDB:

```bash
cd backend
node src/rag/ingest.js
```

Expected output:
```
Starting ingestion...
Ollama URL: http://...
ChromaDB URL: http://localhost:8000
Exercise 1: 150 pairs
Exercise 1: ingested into ChromaDB + BM25
Exercise 3: 120 pairs
...
Knowledge graph: 27 entries ingested into ChromaDB
Ingestion complete!
```

This only needs to be done once. The ChromaDB data persists across restarts.

### Terminal 4 — Frontend

```bash
cd frontend
npm install    # first time only
npm run dev
```

Expected output:
```
  VITE v6.x.x  ready in xxx ms

  ➜  Local:   http://localhost:5173/
  ➜  Network: ...
```

The frontend is now available at **http://localhost:5173**.

### Terminal 5 — Workflow Monitor (optional)

```bash
cd workflow
npm install    # first time only
npm run dev
```

Expected output:
```
  VITE v6.x.x  ready in xxx ms

  ➜  Local:   http://localhost:5174/
  ➜  Network: ...
```

The workflow monitor is now available at **http://localhost:5174**. This is optional and only needed for debugging/observing the RAG pipeline in real time.

---

## Step 6: Using the Application

### Student Interface (Frontend)

1. Open **http://localhost:5173** in your browser
2. Log in (in development mode with `DEV_BYPASS_AUTH=true`, authentication is bypassed)
3. Select an exercise from the exercise list
4. Read the circuit description and analyze the circuit diagram
5. Type your answer in the chat box (e.g., "R1 y R2 porque forman un divisor de tensión")
6. The tutor will respond with Socratic questions guiding you toward the correct answer
7. The exercise ends when you identify the correct resistances with valid reasoning

### Workflow Monitor (Developer Tool)

1. Open **http://localhost:5174** in a separate browser tab
2. Verify the connection indicator shows green (connected to backend WebSocket)
3. Send a message in the student interface
4. Watch the graph nodes light up in sequence as the RAG pipeline processes the message
5. Click any node to see its full parameter detail in the bottom panel
6. Check the event log (right sidebar) for the complete event stream
7. Switch to the "Flow Diagram" tab for a sequential view of the pipeline

---

## Troubleshooting

### MongoDB Connection Issues

**Error:** "Error al conectar a MongoDB"

- Verify `MONGODB_URI` in `backend/.env` is correct
- Check that your IP is whitelisted in MongoDB Atlas Network Access
- Ensure the database user has read/write permissions
- Test the connection string with MongoDB Compass

### Ollama Not Responding

**Error:** "Ollama not available" or timeout errors

- If using local Ollama: make sure it is running (`ollama serve`)
- Check the URL in `.env` matches your Ollama instance
- Verify models are pulled: `ollama list` should show `qwen2.5:latest` and `nomic-embed-text:latest`
- For remote Ollama: check firewall/VPN settings

### ChromaDB Connection Issues

**Error:** "ChromaDB not available at http://localhost:8000"

- Make sure ChromaDB is running in a terminal: `chroma run --host localhost --port 8000`
- Check if port 8000 is available: `netstat -ano | findstr :8000` (Windows) or `lsof -i :8000` (Linux/Mac)
- If port is in use, stop the conflicting process or change the ChromaDB port and update `CHROMA_URL` in `.env`

### ChromaDB Has No Collections

**Error:** Verification check 4.2 fails with "0 collections"

- Run the ingestion script: `cd backend && node src/rag/ingest.js`
- Make sure Ollama is running (ingestion needs the embedding model)
- Check that dataset files exist in `material-complementario/llm/datasets/`

### CORS Errors

**Error:** "Access-Control-Allow-Origin" errors in browser console

- Verify `FRONTEND_BASE_URL` and `WORKFLOW_BASE_URL` in `backend/.env` match the actual URLs
- Default: frontend at `http://localhost:5173`, workflow at `http://localhost:5174`
- Restart the backend after changing `.env`

### Port Conflicts

**Error:** "EADDRINUSE: address already in use"

- Backend (3000): `netstat -ano | findstr :3000` → kill the process using that port
- Frontend (5173): Vite will automatically try the next available port
- ChromaDB (8000): Stop other services on port 8000
- Workflow (5174): Vite will automatically try the next available port

### RAG Not Working

**Symptom:** Chat responses are generic and do not seem to use RAG

- Check that `RAG_ENABLED=true` in `backend/.env`
- Check backend logs for "[RAG] Ready" at startup
- Verify the exercise has `tutorContext.respuestaCorrecta` set in MongoDB
- Check backend logs for "[RAG] Error:" messages

### Slow Responses

**Symptom:** Chat takes more than 30 seconds to respond

- Check Ollama response times: the LLM call is typically the bottleneck
- Reduce `OLLAMA_NUM_PREDICT` (e.g., from 120 to 80) for shorter responses
- Increase `OLLAMA_KEEP_ALIVE` to keep the model loaded in memory
- If using a remote Ollama, network latency may be a factor

### Log Files

For debugging, check these log locations:

| Log | Location | Content |
|---|---|---|
| Backend console | Terminal running `npm start` | Server startup, RAG events, errors |
| RAG interaction logs | `backend/logs/rag/YYYY-MM-DD.jsonl` | Full RAG pipeline data for each interaction |
| Browser console | F12 → Console | Frontend errors, WebSocket connection status |
| Workflow monitor | Browser console at localhost:5174 | WebSocket events, rendering errors |
