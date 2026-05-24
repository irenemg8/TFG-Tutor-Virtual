# Virtual Tutor — Project Documentation

An intelligent tutoring system for electrical circuit analysis. Students solve exercises by identifying which resistances contribute to a circuit property (e.g., a voltage divider). Instead of giving answers, the system uses Socratic questioning — guiding students to discover the solution through targeted questions about circuit concepts.

The core innovation is an **agentic conditional RAG (Retrieval-Augmented Generation) system** that classifies each student message, retrieves pedagogically relevant context from multiple sources (example conversations, a domain knowledge graph, and student error history), and enforces safety guardrails to prevent the tutor from accidentally revealing solutions.

---

## Architecture

```
┌─────────────┐     HTTP/SSE      ┌─────────────────────────────────────────────┐
│   Frontend  │◄────────────────► │                  Backend                    │
│  (React 19) │                   │  ┌─────────────────────────────────────┐    │
│  port 5173  │                   │  │         RAG Middleware              │    │
└─────────────┘                   │  │  ┌──────────┐  ┌─────────────────┐  │    │
                                  │  │  │   Query  │  │ Hybrid Search   │  │    │
┌─────────────┐     WebSocket     │  │  │Classifier│  │ BM25 + Semantic │  │    │
│  Workflow   │◄────────────────► │  │  └──────────┘  │ + RRF Fusion    │  │    │
│  Monitor    │                   │  │  ┌──────────┐  └─────────────────┘  │    │
│  port 5174  │                   │  │  │Knowledge │  ┌─────────────────┐  │    │
└─────────────┘                   │  │  │  Graph   │  │   5 Guardrails  │  │    │
                                  │  │  └──────────┘  └─────────────────┘  │    │
                                  │  └─────────────────────────────────────┘    │
                                  │                    port 3000                │
                                  └──────────┬─────────────┬──────────────┬─────┘
                                             │             │              │
                                        ┌────▼────┐   ┌────▼────┐   ┌─────▼──────────────┐
                                        │ MongoDB │   │ChromaDB │   │   PoliGPT (Ollama) │
                                        │  Atlas  │   │  :8000  │   │  qwen2.5:latest +  │
                                        └─────────┘   └─────────┘   │  nomic-embed-text  │
                                                                    └────────────────────┘
```

---

## Technology Stack

| Component | Technology | Purpose |
|---|---|---|
| Frontend | React 19, Vite 6 | Student-facing interface |
| Backend | Node.js, Express | API server, RAG middleware, SSE streaming |
| Database | MongoDB Atlas, Mongoose | Exercises, conversations, user data, results |
| Vector Store | ChromaDB | Semantic search over student-tutor examples |
| LLM | Ollama (qwen2.5) | Tutor response generation |
| Embeddings | nomic-embed-text (768d) | Text-to-vector conversion for semantic search |
| Workflow Monitor | React 19, @xyflow/react v12 | Real-time RAG pipeline visualization |
| Evaluation | Python (RAGAS, custom metrics) | Retrieval and generation quality assessment |

---

## Documentation

| Document | Description |
|---|---|
| **[Architecture Diagrams](architecture-diagrams.md)** | Full connection maps, UML component and sequence diagrams, classification decision tree, all 9 pipeline paths, guardrail chain, data model relationships |
| **[Backend Architecture](backend.md)** | Server structure, API routes, data models, authentication, SSE streaming, environment variables |
| **[RAG System](rag-system.md)** | Deep dive into all 14 RAG modules: classification, hybrid search, knowledge graph, CRAG, guardrails, LLM integration |
| **[Evaluation System](evaluation.md)** | Automated quality metrics: Precision@K, Recall@K, MAP@K, MRR, Socratic rate, guardrail safety |
| **[Workflow Monitor](workflow.md)** | Real-time pipeline visualization tool: node graph, event log, timing, parameter inspection |
| **[Deployment Guide](deployment-guide.md)** | Step-by-step setup from scratch: prerequisites, installation, configuration, verification, starting services |

---

## Quick Start

For a complete setup guide, see the [Deployment Guide](deployment-guide.md). In brief:

```bash
# 1. Install dependencies
cd backend && npm install
cd ../frontend && npm install
cd ../workflow && npm install      # optional

# 2. Configure environment
# Edit backend/.env (see deployment guide for all variables)

# 3. Start ChromaDB (Terminal 1)
chroma run --host localhost --port 8000

# 4. Start Backend (Terminal 2)
cd backend && npm start

# 5. Ingest data (first time only, Terminal 2 after server is up)
node src/rag/ingest.js

# 6. Start Frontend (Terminal 3)
cd frontend && npm run dev         # → http://localhost:5173

# 7. Start Workflow Monitor (Terminal 4, optional)
cd workflow && npm run dev         # → http://localhost:5174
```

---

## Project Structure

```
TFG-Tutor-Virtual/
├── backend/                    # Node.js/Express API server
│   ├── src/
│   │   ├── index.js           # Entry point
│   │   ├── models/            # Mongoose schemas (4 models)
│   │   ├── routes/            # API endpoints (7 route files)
│   │   ├── rag/               # RAG system (14 modules)
│   │   ├── utils/             # Prompt builder + language manager
│   │   └── static/            # Exercise images
│   ├── logs/rag/              # JSONL interaction logs
│   └── tests/                 # Verification scripts
│
├── frontend/                   # React student interface
│   └── src/                   # Components, pages, hooks
│
├── workflow/                   # React workflow monitor
│   └── src/
│       ├── hooks/             # WebSocket hook
│       └── components/        # Nodes, edges, panels, layout
│
├── evaluation/                 # Python evaluation scripts
│   ├── config.py              # Shared configuration
│   ├── evaluateRetrieval.py   # Retrieval metrics
│   ├── evaluateGeneration.py  # Generation metrics
│   ├── runBenchmark.py        # End-to-end benchmark
│   └── results/               # Metric output files
│
├── material-complementario/    # Data files
│   └── llm/
│       ├── datasets/          # Exercise datasets (JSON)
│       └── knowledge-graph/   # Knowledge graph (JSON)
│
├── docs/                       # This documentation
└── verify.ps1                  # System verification script
```

---

## Key Design Decisions

### Why Socratic Tutoring?

Direct feedback ("Wrong, the answer is R1, R2, R4") does not help students understand *why*. Socratic tutoring guides students to discover the answer themselves through questions like "What happens to the current when a component is short-circuited?". This develops deeper conceptual understanding.

### Why Rule-Based Classification?

An LLM-based classifier would be slower and non-deterministic. The same student message could be classified differently on different calls, leading to inconsistent tutoring behavior. Rule-based classification is instant, deterministic, and transparent.

### Why Hybrid Search (BM25 + Semantic)?

BM25 catches exact term matches (e.g., specific resistance names). Semantic search catches conceptual similarity even with different wording. RRF fusion combines both without needing to normalize their incompatible score scales.

### Why Five Guardrails?

Each guardrail catches a different type of pedagogically harmful response: (1) revealing answers, (2) confirming wrong answers, (3) prematurely confirming correct answers before the student has justified them, (4) exposing internal circuit state, and (5) naming specific evaluable elements in questions (which tells the student where to look). Running all five sequentially ensures comprehensive safety coverage.

### Why Non-Streaming LLM Calls?

The RAG middleware calls Ollama in non-streaming mode so it can inspect the complete response before sending it to the student. This is essential for the guardrails — a streaming response would be sent to the client token by token, making it impossible to retract a response that reveals the solution.
