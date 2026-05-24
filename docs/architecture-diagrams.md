# Architecture Diagrams

Comprehensive visual documentation of the system architecture, component interactions, data flows, and all possible execution paths through the RAG pipeline.

---

## Table of Contents

1. [System Architecture — Full Connection Map](#1-system-architecture--full-connection-map)
2. [UML Component Diagram](#2-uml-component-diagram)
3. [UML Sequence Diagram — Complete Chat Request](#3-uml-sequence-diagram--complete-chat-request)
4. [RAG Module Interconnection Map](#4-rag-module-interconnection-map)
5. [Query Classification Decision Tree](#5-query-classification-decision-tree)
6. [Pipeline Routing — All 9 Paths](#6-pipeline-routing--all-8-paths)
7. [Hybrid Search Engine Flow](#7-hybrid-search-engine-flow)
8. [Guardrail Safety Chain](#8-guardrail-safety-chain)
9. [Middleware Request Lifecycle](#9-middleware-request-lifecycle)
10. [Evaluation System Flow](#10-evaluation-system-flow)
11. [Workflow Monitor Event Flow](#11-workflow-monitor-event-flow)

---

## 1. System Architecture — Full Connection Map

Complete view of every component and connection in the system.

```
┌──────────────────────────────────────────────────────────────────────────────────────────────┐
│                                     EXTERNAL CLIENTS                                         │
│                                                                                              │
│   ┌───────────────────────┐                          ┌───────────────────────┐               │
│   │   Student Frontend    │                          │   Workflow Monitor    │               │
│   │   (React 19 + Vite)   │                          │   (React 19 + Vite)   │               │
│   │   port 5173           │                          │   @xyflow/react v12   │               │
│   │                       │                          │   port 5174           │               │
│   │  ┌─────────────────┐  │                          │  ┌────────────────┐   │               │
│   │  │ Chat Interface  │  │                          │  │ Pipeline Graph │   │               │
│   │  │ Exercise List   │  │                          │  │ Event Log      │   │               │
│   │  │ Progress View   │  │                          │  │ Node Detail    │   │               │
│   │  │ Results Panel   │  │                          │  │ Timing Bar     │   │               │
│   │  └─────────────────┘  │                          │  └────────────────┘   │               │
│   └───────────┬───────────┘                          └───────────┬───────────┘               │
│               │                                                  │                           │
│          HTTP/SSE                                           WebSocket                        │
│    POST /api/ollama/chat/stream                         ws://localhost:3000                  │
│    GET  /api/ejercicios                                   /ws/workflow                       │
│    GET  /api/interacciones                                                                   │
│    POST /api/resultados/finalizar                                                            │
│    GET  /api/progreso/:userId                                                                │
│    GET  /auth/demo                                                                           │
│               │                                                  │                           │
└───────────────┼──────────────────────────────────────────────────┼───────────────────────────┘
                │                                                  │
                ▼                                                  ▼
┌──────────────────────────────────────────────────────────────────────────────────────────────┐
│                              BACKEND SERVER (Node.js + Express)                              │
│                                       port 3000                                              │
│                                                                                              │
│  ┌────────────────────────────────────────────────────────────────────────────────────────┐  │
│  │                              EXPRESS MIDDLEWARE CHAIN                                  │  │
│  │                                                                                        │  │
│  │   Request ──► CORS ──► JSON Parser ──► Session (connect-mongo) ──► Route Matching      │  │
│  │                                                                                        │  │
│  │   Route Matching:                                                                      │  │
│  │   ┌──────────────────────┬─────────────────────────────────────────────────────────┐   │  │
│  │   │  /api/ollama/*       │  ragMiddleware.js ──► ollamaChatRoutes.js (fallback)    │   │  │
│  │   │  /api/ejercicios/*   │  ejercicios.js                                          │   │  │
│  │   │  /api/interacciones/*│  interacciones.js (requireAuth)                         │   │  │
│  │   │  /api/resultados/*   │  resultados.js                                          │   │  │
│  │   │  /api/progreso/*     │  progresoRoutes.js                                      │   │  │
│  │   │  /api/export/*       │  exportRoutes.js (JSON/CSV data export)                 │   │  │
│  │   │  /api/usuarios/*     │  usuarios.js                                            │   │  │
│  │   │  /auth/*             │  authRoutes.js (CAS OAuth2 + demo)                      │   │  │
│  │   │  /static/*           │  Express static (exercise images)                       │   │  │
│  │   │  /*                  │  SPA fallback (frontend/dist/index.html)                │   │  │
│  │   └──────────────────────┴─────────────────────────────────────────────────────────┘   │  │
│  └────────────────────────────────────────────────────────────────────────────────────────┘  │
│                                                                                              │
│  ┌────────────────────────────────────────────────────────────────────────────────────────┐  │
│  │                                RAG SYSTEM (14 modules)                                 │  │
│  │                                                                                        │  │
│  │   ┌──────────────┐   ┌──────────────┐   ┌──────────────┐   ┌──────────────────────┐    │  │
│  │   │    config    │   │  ragMiddle-  │   │ ragPipeline  │   │  queryClassifier     │    │  │
│  │   │    .js       │◄──│  ware.js     │──►│    .js       │──►│     .js              │    │  │
│  │   └──────┬───────┘   └──────┬───────┘   └──────┬───────┘   └──────────────────────┘    │  │
│  │          │                  │                  │                                       │  │
│  │          │                  │                  ├──────────────────────────────┐        │  │
│  │          ▼                  ▼                  ▼                              ▼        │  │
│  │   ┌──────────────┐   ┌──────────────┐   ┌──────────────┐   ┌──────────────────────┐    │  │
│  │   │  guardrails  │   │   logger     │   │ hybridSearch │   │  knowledgeGraph      │    │  │
│  │   │    .js       │   │    .js       │   │    .js       │   │     .js              │    │  │
│  │   └──────────────┘   └──────────────┘   └──────┬───────┘   └──────────────────────┘    │  │
│  │                                                │                                       │  │
│  │                                     ┌──────────┼──────────┐                            │  │
│  │                                     ▼          ▼          ▼                            │  │
│  │                              ┌──────────┐ ┌──────────┐ ┌────────────┐                  │  │
│  │                              │   bm25   │ │embeddings│ │chromaClient│                  │  │
│  │                              │    .js   │ │   .js    │ │   .js      │                  │  │
│  │                              └──────────┘ └──────────┘ └────────────┘                  │  │
│  │                                                                                        │  │
│  │   ┌──────────────┐   ┌────────────────┐   ┌──────────────┐                             │  │
│  │   │  ragEventBus │   │ workflowSocket │   │   ingest     │                             │  │
│  │   │    .js       │──►│    .js         │   │    .js       │                             │  │
│  │   └──────────────┘   └────────────────┘   └──────────────┘                             │  │
│  └────────────────────────────────────────────────────────────────────────────────────────┘  │
│                                                                                              │
│  ┌──────────────────┐   ┌──────────────────┐   ┌──────────────────┐                          │
│  │  models/         │   │ utils/              │   │  authRoutes.js   │                       │
│  │  ejercicio.js    │   │ promptBuilder.js    │   │  (CAS + demo)    │                       │
│  │  interaccion.js  │   │ languageManager.js  │   └──────────────────┘                       │
│  │  resultado.js    │   │ (es, val, en)       │                                              │
│  │  usuario.js      │   └─────────────────────┘                                              │
│  └──────────────────┘                                                                        │
└──────────┬─────────────────────────┬───────────────────────────────┬─────────────────────────┘
           │                         │                               │
           ▼                         ▼                               ▼
┌───────────────────────┐  ┌───────────────────────┐  ┌───────────────────────────────────┐
│    MongoDB Atlas      │  │      ChromaDB         │  │       PoliGPT (Ollama)            │
│                       │  │      port 8000        │  │                                   │
│  Collections:         │  │                       │  │  Models:                          │
│  ├── ejercicios       │  │  Collections:         │  │  ├── qwen2.5:latest (chat)        │
│  ├── interacciones    │  │  ├── exercise_1       │  │  │   temperature: 0.4             │
│  ├── resultados       │  │  ├── exercise_3       │  │  │   num_ctx: 8192                │
│  ├── usuarios         │  │  ├── exercise_4       │  │  │   num_predict: 120             │
│  └── sessions         │  │  ├── exercise_5       │  │  │                                │
│                       │  │  ├── exercise_6       │  │  └── nomic-embed-text (embeddings)│
│  Used by:             │  │  ├── exercise_7       │  │      768 dimensions               │
│  - Mongoose models    │  │  └── knowledge_graph  │  │                                   │
│  - express-session    │  │                       │  │  Endpoints:                       │
│  - connect-mongo      │  │  768d vectors         │  │  POST /api/chat (generation)      │
│                       │  │  cosine distance      │  │  POST /api/embeddings (vectors)   │
└───────────────────────┘  └───────────────────────┘  └───────────────────────────────────┘
```

### Connection Summary

| From | To | Protocol | Purpose |
|---|---|---|---|
| Frontend | Backend | HTTP POST + SSE | Chat messages, exercise CRUD, results, progress |
| Frontend | Backend | HTTP GET | Exercise list, images, user data |
| Workflow Monitor | Backend | WebSocket | Real-time pipeline event stream |
| Backend (ragMiddleware) | MongoDB | TCP (Mongoose) | Load exercise, save conversation, load history |
| Backend (hybridSearch) | ChromaDB | HTTP REST | Semantic vector search |
| Backend (ragMiddleware) | Ollama | HTTP POST | LLM chat completion (non-streaming) |
| Backend (embeddings) | Ollama | HTTP POST | Text-to-vector embedding generation |
| Backend (bm25) | In-memory | Direct | Keyword search (loaded at startup) |
| Backend (knowledgeGraph) | In-memory | Direct | Concept graph search (loaded at startup) |
| Backend (ragEventBus) | workflowSocket | EventEmitter | Internal event routing |
| Backend (workflowSocket) | Workflow Monitor | WebSocket | Event broadcast to client |
| Backend (logger) | File system | JSONL write | Interaction logs for evaluation |
| Evaluation scripts | Log files | File read | Offline metric computation |
| Evaluation benchmark | Backend | HTTP POST + SSE | Live test query execution |

---

## 2. UML Component Diagram

```
┌─────────────────────────────────────────────────────────────────────────────────────┐
│                                    <<system>>                                       │
│                                 Virtual Tutor                                       │
│                                                                                     │
│  ┌───────────────────┐          ┌─────────────────────────────────────────────────┐ │
│  │   <<component>>   │          │                <<component>>                    │ │
│  │    Frontend       │          │                  Backend                        │ │
│  │                   │          │                                                 │ │
│  │  [Chat UI]        │─────────►│  [Express Server]                               │ │
│  │  [Exercise List]  │  HTTP/   │       │                                         │ │
│  │  [Progress View]  │  SSE     │       ├──── [Auth Module]                       │ │
│  │  [Results Panel]  │          │       │        ├── CAS OAuth2                   │ │
│  │                   │          │       │        └── Demo Bypass                  │ │
│  └───────────────────┘          │       │                                         │ │
│                                 │       ├──── [Route Handlers]                    │ │
│  ┌───────────────────┐          │       │        ├── ejercicios.js                │ │
│  │   <<component>>   │          │       │        ├── interacciones.js             │ │
│  │  Workflow Monitor │          │       │        ├── resultados.js                │ │
│  │                   │          │       │        ├── progresoRoutes.js            │ │
│  │  [Pipeline Graph] │─────────►│       │        ├── exportRoutes.js              │ │
│  │  [Event Log]      │  WS      │       │        ├── usuarios.js                  │ │
│  │  [Node Detail]    │          │       │        └── ollamaChatRoutes.js          │ │
│  │  [Timing Bar]     │          │       │                                         │ │
│  └───────────────────┘          │       └──── [RAG System] ◄────────────────┐     │ │
│                                 │                │                          │     │ │
│                                 │                ▼                          │     │ │
│                                 │  ┌──────────────────────────────┐         │     │ │
│                                 │  │      <<component>>           │         │     │ │
│                                 │  │     RAG Middleware           │         │     │ │
│                                 │  │                              │         │     │ │
│                                 │  │  [Request Validator]         │         │     │ │
│                                 │  │  [Pipeline Orchestrator]─────┤         │     │ │
│                                 │  │  [LLM Caller]                │         │     │ │
│                                 │  │  [Guardrail Chain]           │         │     │ │
│                                 │  │  [SSE Responder]             │         │     │ │
│                                 │  │  [Interaction Logger]        │         │     │ │
│                                 │  └──────────────────────────────┘         │     │ │
│                                 │                │                          │     │ │
│                                 │                ▼                          │     │ │
│                                 │  ┌──────────────────────────────┐         │     │ │
│                                 │  │      <<component>>           │         │     │ │
│                                 │  │    RAG Pipeline              │         │     │ │
│                                 │  │                              │         │     │ │
│                                 │  │  [Query Classifier]          │         │     │ │
│                                 │  │  [Routing Engine]            │         │     │ │
│                                 │  │  [Augmentation Builder]      │         │     │ │
│                                 │  │  [Student History Loader]    │         │     │ │
│                                 │  │  [CRAG Reformulator]         │         │     │ │
│                                 │  └──────────┬───────────────────┘         │     │ │
│                                 │             │                             │     │ │
│                                 │      ┌──────┴──────┐                      │     │ │
│                                 │      ▼             ▼                      │     │ │
│                                 │  ┌─────────────┐ ┌───────────────┐        │     │ │
│                                 │  │<<component>>│ │ <<component>> │        │     │ │
│                                 │  │Hybrid Search│ │Knowledge Graph│        │     │ │
│                                 │  │             │ │               │        │     │ │
│                                 │  │ [BM25]      │ │ [27 concept   │        │     │ │
│                                 │  │ [Semantic]  │ │  relations]   │        │     │ │
│                                 │  │ [RRF Fusion]│ │ [AC entries]  │        │     │ │
│                                 │  └──────┬──────┘ └───────────────┘        │     │ │
│                                 │         │                                 │     │ │
│                                 │  ┌──────┴───────────────┐                 │     │ │
│                                 │  │   <<component>>      │                 │     │ │
│                                 │  │  Event & Monitoring  │─────────────────┘     │ │
│                                 │  │                      │                       │ │
│                                 │  │ [ragEventBus.js]     │                       │ │
│                                 │  │ [workflowSocket.js]  │                       │ │
│                                 │  │ [logger.js]          │                       │ │
│                                 │  └──────────────────────┘                       │ │
│                                 └─────────────────────────────────────────────────┘ │
│                                                                                     │
│  ┌─────────────────┐   ┌──────────────────┐   ┌──────────────────────────────────┐  │
│  │  <<external>>   │   │   <<external>>   │   │          <<external>>            │  │
│  │  MongoDB Atlas  │   │    ChromaDB      │   │        PoliGPT (Ollama)          │  │
│  │                 │   │    port 8000     │   │                                  │  │
│  │  - ejercicios   │   │  - 7 collections │   │  - qwen2.5 (chat, T=0.4)         │  │
│  │  - interacciones│   │  - 768d vectors  │   │  - nomic-embed-text (768d)       │  │
│  │  - resultados   │   │  - cosine dist.  │   │  - non-streaming for guardrails  │  │
│  │  - usuarios     │   │                  │   │                                  │  │
│  │  - sessions     │   │                  │   │                                  │  │
│  └─────────────────┘   └──────────────────┘   └──────────────────────────────────┘  │
│                                                                                     │
│  ┌──────────────────────────────────────────────────────────────────────────────┐   │
│  │                          <<component>> Evaluation                            │   │
│  │                                                                              │   │
│  │  [evaluateRetrieval.py] ── P@K, R@K, MAP@K, MRR                              │   │
│  │  [evaluateGeneration.py] ── Socratic rate, guardrail safety, RAGAS           │   │
│  │  [runBenchmark.py] ── Live end-to-end testing                                │   │
│  └──────────────────────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────────────────────┘
```

---

## 3. UML Sequence Diagram — Complete Chat Request

This diagram traces a single student message through the entire system, covering every component touched.

```
Student        Frontend       ragMiddleware      ragPipeline      queryClassifier   hybridSearch     KnowledgeGraph
  │               │               │                  │                 │                │                │
  │  Type message │               │                  │                 │                │                │
  │──────────────►│               │                  │                 │                │                │
  │               │ POST /api/    │                  │                 │                │                │
  │               │ ollama/chat/  │                  │                 │                │                │
  │               │ stream        │                  │                 │                │                │
  │               │──────────────►│                  │                 │                │                │
  │               │               │                  │                 │                │                │
  │               │               │ Validate inputs  │                 │                │                │
  │               │               │ (userId, exerciseId, message)      │                │                │
  │               │               │                  │                 │                │                │
  │               │               │ Load exercise    │                 │                │                │
  │               │               │ from MongoDB ────────────────────────────────────────────────► MongoDB
  │               │               │ ◄────────────────────────────────────────────────────────────── ejercicio
  │               │               │                  │                 │                │                │
  │               │               │ runFullPipeline()│                 │                │                │
  │               │               │─────────────────►│                 │                │                │
  │               │               │                  │ classifyQuery() │                │                │
  │               │               │                  │────────────────►│                │                │
  │               │               │                  │ {type, R[], ...}│                │                │
  │               │               │                  │◄────────────────│                │                │
  │               │               │                  │                 │                │                │
  │               │               │                  │ [Route based on classification type]              │
  │               │               │                  │                 │                │                │
  │               │               │                  │ hybridSearch()  │                │                │
  │               │               │                  │ (if needed)     │                │                │
  │               │               │                  │─────────────────────────────────►│                │
  │               │               │                  │                 │     ┌──────────┤                │
  │               │               │                  │                 │     │ BM25     │                │
  │               │               │                  │                 │     │ Embed ──────────► Ollama (embed)
  │               │               │                  │                 │     │ Semantic ───────► ChromaDB
  │               │               │                  │                 │     │ RRF Fuse │                │
  │               │               │                  │                 │     └──────────┤                │
  │               │               │                  │                 │  top K results │                │
  │               │               │                  │◄─────────────────────────────────│                │
  │               │               │                  │                 │                │                │
  │               │               │                  │ searchKG()      │                │                │
  │               │               │                  │ (if needed)     │                │                │
  │               │               │                  │──────────────────────────────────────────────────►│
  │               │               │                  │                 │                │  KG entries    │
  │               │               │                  │◄──────────────────────────────────────────────────│
  │               │               │                  │                 │                │                │
  │               │               │                  │ loadStudentHistory() ─────────────────────► MongoDB
  │               │               │                  │ ◄────────────────────────────────────────── resultados
  │               │               │                  │                 │                │                │
  │               │               │                  │ Build augmentation (hint + examples + KG + history + guardrail)
  │               │               │  {augmentation,  │                 │                │                │
  │               │               │   decision,      │                 │                │                │
  │               │               │   sources}       │                 │                │                │
  │               │               │◄─────────────────│                 │                │                │
  │               │               │                  │                 │                │                │
  │               │               │ Set up SSE headers                 │                │                │
  │               │               │──────────────────────────────────────────────────────────────► Client
  │               │               │                  │                 │                │                │
  │               │               │ Save user msg ───────────────────────────────────────────────► MongoDB
  │               │               │                  │                 │                │                │
  │               │               │ Check deterministic finish         │                │                │
  │               │               │ (correct_good_reasoning?)          │                │                │
  │               │               │                  │                 │                │                │
  │               │               │ Build augmented prompt             │                │                │
  │               │               │ = systemPrompt + augmentation      │                │                │
  │               │               │                  │                 │                │                │
  │               │               │ Load history ────────────────────────────────────────────────► MongoDB
  │               │               │ ◄────────────────────────────────────────────────────────────  messages
  │               │               │                  │                 │                │                │
  │               │               │ callOllama() ────────────────────────────────────────────────► Ollama
  │               │               │ (non-streaming)  │                 │                │          (qwen2.5)
  │               │               │ ◄────────────────────────────────────────────────────────────  response
  │               │               │                  │                 │                │                │
  │               │               │ ┌─── GUARDRAIL CHAIN ──────────────────────────────┐    │            │
  │               │               │ │ 1. checkSolutionLeak()                           │    │            │
  │               │               │ │    └─ if leaked → retry with stronger prompt     │    │            │
  │               │               │ │ 2. checkFalseConfirmation()                      │    │            │
  │               │               │ │    └─ if confirmed → retry with instruction      │    │            │
  │               │               │ │ 3. checkPrematureConfirmation()                  │    │            │
  │               │               │ │    └─ if premature → retry with instruction      │    │            │
  │               │               │ │ 4. checkStateReveal()                            │    │            │
  │               │               │ │    └─ if revealed → retry with instruction       │    │            │
  │               │               │ │ 5. checkElementNaming()                          │    │            │
  │               │               │ │    └─ if named → retry with instruction          │    │            │
  │               │               │ │ 6. Deterministic prefix fallback (if still wrong)│    │            │
  │               │               │ └──────────────────────────────────────────────────┘    │            │
  │               │               │                  │                 │                │                │
  │               │               │ SSE: {chunk: response}             │                │                │
  │               │◄──────────────│                  │                 │                │                │
  │               │               │ SSE: [DONE]      │                 │                │                │
  │               │◄──────────────│                  │                 │                │                │
  │               │               │                  │                 │                │                │
  │               │               │ Save assistant msg ──────────────────────────────────────────► MongoDB
  │               │               │ logInteraction() ──────────────────────────────────────────► JSONL file
  │               │               │ emitEvent("request_end") ──────────────────────────────────► Workflow
  │  Display      │               │                  │                 │                │                │
  │◄──────────────│               │                  │                 │                │                │
  │  response     │               │                  │                 │                │                │
```

---

## 4. RAG Module Interconnection Map

How all 14 RAG modules depend on and call each other.

```
                                      ┌─────────────────┐
                                      │   config.js     │
                                      │ (all constants) │
                                      └────────┬────────┘
                                               │ imported by all modules
                       ┌───────────────────────┼───────────────────────────────────┐
                       │                       │                                   │
                       ▼                       ▼                                   ▼
              ┌─────────────────┐    ┌──────────────────┐              ┌──────────────────┐
              │ ragMiddleware.js│    │  ragPipeline.js  │              │    ingest.js     │
              │                 │    │                  │              │  (startup only)  │
              │  ENTRY POINT    │───►│  ORCHESTRATOR    │              │                  │
              │  for all chat   │    │                  │              │  Loads datasets  │
              │  requests       │    │Routes to correct │              │  into ChromaDB   │
              └────┬──┬──┬──┬───┘    │ retrieval path   │              │  and BM25        │
                   │  │  │  │        └──┬──────┬──────┬─┘              └───┬──────┬───────┘
                   │  │  │  │           │      │      │                    │      │
                   │  │  │  │           │      │      │                    │      │
        ┌──────────┘  │  │  └────┐      │      │      │                    │      │
        ▼             │  │       ▼      ▼      │      ▼                    ▼      ▼
┌──────────────┐      │  │  ┌──────────────┐   │  ┌──────────────┐  ┌─────────┐ ┌───────────────┐
│ guardrails.js│      │  │  │  logger.js   │   │  │knowledgeGraph│  │ bm25.js │ │chromaClient.js│
│              │      │  │  │              │   │  │    .js       │  │         │ │               │
│ 3 sequential │      │  │  │ Writes JSONL │   │  │              │  │ In-mem  │ │  ChromaDB     │
│ safety checks│      │  │  │ to logs/rag/ │   │  │ 27 concept   │  │ keyword │ │  HTTP client  │
└──────────────┘      │  │  └──────────────┘   │  │ relationships│  │ index   │ │               │
                      │  │                     │  └──────────────┘  └─────────┘ └───────┬───────┘
                      │  │                     │                                        │
                      │  │                     ▼                                        │
                      │  │            ┌────────────────────┐                            │
                      │  │            │  hybridSearch.js   │                            │
                      │  │            │                    │                            │
                      │  │            │  BM25 + Semantic   │────────────────────────────┘
                      │  │            │  + RRF Fusion      │
                      │  │            └──────┬─────────────┘
                      │  │                   │
                      │  │                   ▼
                      │  │            ┌──────────────┐        ┌──────────────┐
                      │  │            │ embeddings.js│───────►│  Ollama API  │
                      │  │            │              │        │ /api/embed   │
                      │  │            │ Text → 768d  │        └──────────────┘
                      │  │            │ vector       │
                      │  │            └──────────────┘
                      │  │
                      │  └────────────────────────────────┐
                      ▼                                   ▼
              ┌──────────────────┐              ┌──────────────────┐
              │ ragEventBus.js   │              │workflowSocket.js │
              │                  │─────────────►│                  │
              │ Singleton        │  subscribes  │ WebSocket server │──────► Workflow Monitor
              │ EventEmitter     │              │ broadcasts all   │        (port 5174)
              │                  │              │ events           │
              │ emitEvent() used │              └──────────────────┘
              │ by ALL modules   │
              └──────────────────┘

              ┌──────────────────┐
              │queryClassifier.js│
              │                  │
              │ 8 classification │  ◄──── called by ragPipeline.js
              │ types, rule-based│
              │ regex + patterns │
              └──────────────────┘
```

### Module Dependency Table

| Module | Depends On | Called By |
|---|---|---|
| `config.js` | — | All modules |
| `ragMiddleware.js` | config, ragPipeline, guardrails, knowledgeGraph, bm25, logger, ragEventBus, promptBuilder, Ejercicio, Interaccion | Express router (entry point) |
| `ragPipeline.js` | config, queryClassifier, hybridSearch, knowledgeGraph, ragEventBus, Resultado | ragMiddleware |
| `queryClassifier.js` | utils/languageManager | ragPipeline |
| `hybridSearch.js` | config, embeddings, chromaClient, bm25, ragEventBus | ragPipeline |
| `knowledgeGraph.js` | config | ragPipeline, ragMiddleware (init) |
| `bm25.js` | — | hybridSearch, ragMiddleware (init) |
| `chromaClient.js` | config | hybridSearch, ingest |
| `embeddings.js` | config | hybridSearch, ingest |
| `guardrails.js` | utils/languageManager | ragMiddleware |
| `logger.js` | config | ragMiddleware |
| `ragEventBus.js` | — | All RAG modules |
| `workflowSocket.js` | ragEventBus | index.js (server setup) |
| `ingest.js` | config, embeddings, chromaClient, bm25 | Manual execution (startup) |

---

## 5. Query Classification Decision Tree

The `queryClassifier.js` module applies these checks **in order**. The first match wins.

```
                              Student Message
                                    │
                                    ▼
                        ┌───────────────────────┐
                        │  Starts with greeting │
                        │  pattern? (multi-lang)│
                        └───────────┬───────────┘
                               yes/ \no
                              /       \
                             ▼         ▼
                     ┌──────────┐  ┌───────────────────────┐
                     │ GREETING │  │ Contains "don't know" │
                     │          │  │ pattern? (multi-lang) │
                     └──────────┘  └───────────┬───────────┘
                                          yes/ \no
                                         /       \
                                        ▼         ▼
                               ┌────────────┐  ┌──────────────────────┐
                               │ DONT_KNOW  │  │ Length < 15 chars    │
                               │            │  │ AND no elements?     │
                               └────────────┘  └───────────┬──────────┘
                                                      yes/ \no
                                                     /       \
                                                    ▼         ▼
                                          ┌─────────────┐  ┌──────────────────────────┐
                                          │ SINGLE_WORD │  │ Extract evaluable        │
                                          │             │  │ elements from message    │
                                          └─────────────┘  │ (generic or R\d+ regex) │
                                                           │                          │
                                                           │ Separate: proposed vs    │
                                                           │ negated (detectNegation) │
                                                           │                          │
                                                           │ Compare PROPOSED with    │
                                                           │ correct answer set       │
                                                           └─────────────┬────────────┘
                                                                         │
                                                              ┌──────────┴──────────┐
                                                              │                     │
                                                         PROPOSED              PROPOSED
                                                         MATCH correct         DON'T match
                                                              │                     │
                                                              ▼                     ▼
                                                   ┌──────────────────┐   ┌────────────────────────┐
                                                   │ Has concept      │   │ All negations correct  │
                                                   │ keywords?        │   │ AND all proposals      │
                                                   └───────┬──────────┘   │ correct (incomplete)?  │
                                                      yes/ \no            └────────────┬───────────┘
                                                     /       \                    yes/ \no
                                                    ▼         ▼                  /       \
                                          ┌────────────┐  ┌──────────┐         ▼         ▼
                                          │ Correct    │  │ Has      │  ┌──────────┐ ┌──────────────┐
                                          │ negations? │  │reasoning?│  │ PARTIAL  │ │ Has concept  │
                                          │ OR state-  │  └───┬──────┘  │ CORRECT  │ │ keywords?    │
                                          │ only conc? │  yes/ \no      └──────────┘ └──────┬───────┘
                                          └──────┬─────┘ /       \                     yes/ \no
                                            yes/ \no    ▼         ▼                   /       \
                                           /       \  ┌──────────┐ ┌──────────┐      ▼         ▼
                                          ▼         ▼ │ CORRECT  │ │ CORRECT  │┌──────────┐┌────────┐
                                 ┌────────────┐┌────────────┐│  _GOOD_  │ │   _NO_   ││  WRONG   ││ WRONG  │
                                 │  CORRECT   ││  CORRECT   ││REASONING │ │REASONING ││ CONCEPT  ││ANSWER  │
                                 │   _GOOD_   ││   _WRONG_  │└──────────┘ └──────────┘└──────────┘└────────┘
                                 │ REASONING  ││ REASONING  │
                                 └────────────┘└────────────┘
```

### Classification Output

Every classification returns the same structure:

```
{
  type:          "greeting" | "dont_know" | "single_word" | "wrong_answer" |
                 "correct_no_reasoning" | "correct_wrong_reasoning" |
                 "correct_good_reasoning" | "wrong_concept" | "partial_correct"

  resistances:   ["R1", "R2", "R3"]   // All elements found in the message
  proposed:      ["R1", "R2"]          // Elements the student affirms/proposes
  negated:       ["R3"]               // Elements the student explicitly rejects
  hasReasoning:  true | false          // Contains reasoning keywords (multi-lang)
  concepts:      ["serie", "paralelo"] // Domain keywords found (multi-lang)
}
```

---

## 6. Pipeline Routing — All 9 Paths

Each classification type triggers a different retrieval strategy. Below is every possible path through `ragPipeline.js`.

### Overview Map

```
                                           Classification Type
                                                  │
       ┌──────────┬───────────┬───┴────┬──────────┬──────────────┬──────────────┬─────────────┬─────────────┐
       ▼          ▼           ▼        ▼          ▼              ▼              ▼             ▼             ▼
   greeting   dont_know  single_word  wrong    correct_no    correct_wrong   correct_good  wrong       partial
                                     answer    reasoning     reasoning       reasoning    concept      correct
       │          │           │        │          │              │              │             │             │
       ▼          ▼           ▼        ▼          ▼              ▼              ▼             ▼             ▼
    no_rag    scaffold    demand    rag        demand        correct        rag          concept        rag
                         reasoning examples   reasoning      concept       examples     correction    examples
       │          │           │        │          │              │              │             │             │
       ▼          ▼           ▼        ▼          ▼              ▼              ▼             ▼             ▼
    next()       KG       Hint      Hybrid    Hybrid         Hybrid +        Hybrid        KG +         Hybrid
    (fallback)  search    only      Search    Search          KG search      Search       Hybrid       Search
                (3 basic            + CRAG    + Hint          + Hint         + Hint       Search        + Hint
                concepts)                                                                + Hint
```

---

### Path 1: `greeting` → `no_rag`

```
Student: "Hola, ¿qué tal?"
         │
         ▼
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│ classifyQuery() │────►│ type: greeting  │────►│ return no_rag   │
└─────────────────┘     └─────────────────┘     └────────┬────────┘
                                                         │
                                                         ▼
                                                ┌─────────────────┐
                                                │ ragMiddleware   │
                                                │ calls next()    │──────► ollamaChatRoutes.js
                                                │                 │        (standard LLM call,
                                                │ RAG is SKIPPED  │         streaming, no guardrails)
                                                └─────────────────┘

Resources used: None (RAG bypassed entirely)
Augmentation:   None
```

### Path 2: `dont_know` → `scaffold`

```
Student: "No lo sé, no tengo ni idea"
         │
         ▼
┌─────────────────┐     ┌─────────────────┐     ┌───────────────────────────────────┐
│ classifyQuery() │────►│ type: dont_know │────►│ Search Knowledge Graph            │
└─────────────────┘     └─────────────────┘     │ for basic concepts:               │
                                                │ ["serie", "paralelo",             │
                                                │  "cortocircuito"]                 │
                                                │                                   │
                                                │ Limit to 3 results                │
                                                └───────────────┬───────────────────┘
                                                                │
                                                                ▼
                                                ┌───────────────────────────────────┐
                                                │ Build augmentation:               │
                                                │                                   │
                                                │ [RESPONSE MODE]                   │
                                                │ classification: dont_know         │
                                                │ "Ask ONE question about a         │
                                                │  fundamental concept"             │
                                                │                                   │
                                                │ [DOMAIN KNOWLEDGE]                │
                                                │ Concept: "serie..."               │
                                                │ Expert reasoning: "..."           │
                                                │ Socratic questions: "..."         │
                                                │                                   │
                                                │ [STUDENT HISTORY] (if exists)     │
                                                │ [GUARDRAIL reminder]              │
                                                └───────────────────────────────────┘

Resources used: Knowledge Graph (in-memory), MongoDB (student history)
Augmentation:   Hint + KG context + Student history + Guardrail reminder
```

### Path 3: `single_word` → `demand_reasoning`

```
Student: "Todas" (or any short answer < 15 chars with no resistances)
         │
         ▼
┌─────────────────┐     ┌────────────────────┐     ┌───────────────────────────────┐
│ classifyQuery() │────►│ type: single_word  │────►│ No retrieval needed           │
└─────────────────┘     └────────────────────┘     │                               │
                                                   │ Build augmentation:           │
                                                   │                               │
                                                   │ [RESPONSE MODE]               │
                                                   │ classification: single_word   │
                                                   │ "Ask WHY they think that.     │
                                                   │  Do not advance until they    │
                                                   │  reason."                     │
                                                   │                               │
                                                   │ [STUDENT HISTORY] (if exists) │
                                                   │ [GUARDRAIL reminder]          │
                                                   └───────────────────────────────┘

Resources used: MongoDB (student history only)
Augmentation:   Hint + Student history + Guardrail reminder
```

### Path 4: `wrong_answer` → `rag_examples` (+ possible CRAG)

```
Student: "R5 porque está conectada directamente"
         │
         ▼
┌─────────────────┐     ┌──────────────────────┐     ┌───────────────────────────────┐
│ classifyQuery() │────►│ type: wrong_answer   │────►│ Hybrid Search                 │
└─────────────────┘     └──────────────────────┘     │ (BM25 + Semantic + RRF)       │
                                                     └───────────────┬───────────────┘
                                                                     │
                                                                     ▼
                                                          ┌──────────────────────┐
                                                          │ Top score < 0.4?     │
                                                          │ (MED_THRESHOLD)      │
                                                          └───────────┬──────────┘
                                                                 yes/ \no
                                                                /       \
                                                               ▼         ▼
                                                    ┌─────────────────┐  │
                                                    │ CRAG:           │  │
                                                    │ Extract key     │  │
                                                    │ entities →      │  │
                                                    │ reformulate →   │  │
                                                    │ retry Hybrid    │  │
                                                    │ Search          │  │
                                                    └────────┬────────┘  │
                                                             │           │
                                                             ▼           ▼
                                                    ┌───────────────────────────────────┐
                                                    │ Build augmentation:               │
                                                    │                                   │
                                                    │ [RESPONSE MODE]                   │
                                                    │ classification: wrong_answer      │
                                                    │ "Ask for reasoning. Focus on AC." │
                                                    │                                   │
                                                    │ [PER-RESISTANCE ANALYSIS]         │
                                                    │ CORRECT: (list)                   │
                                                    │ WRONG: (list)                     │
                                                    │ MISSING: (list)                   │
                                                    │                                   │
                                                    │ [REFERENCE EXAMPLES]              │
                                                    │ Example 1: Student/Tutor pair     │
                                                    │ Example 2: ...                    │
                                                    │                                   │
                                                    │ [STUDENT HISTORY] (if exists)     │
                                                    │ [GUARDRAIL reminder]              │
                                                    └───────────────────────────────────┘

Resources used: ChromaDB, Ollama (embeddings), BM25 (in-memory), MongoDB (student history)
                Possibly CRAG retry (2x hybrid search)
Augmentation:   Hint + Per-resistance analysis + Examples + Student history + Guardrail reminder
```

### Path 5: `correct_no_reasoning` → `demand_reasoning`

```
Student: "R1, R2 y R4"
         │
         ▼
┌─────────────────┐     ┌───────────────────────────┐     ┌──────────────────────────────┐
│ classifyQuery() │────►│ type: correct_no_reasoning│────►│ Hybrid Search                │
└─────────────────┘     └───────────────────────────┘     │ (find similar correct answers│
                                                          │  to guide tone)              │
                                                          └───────────────┬──────────────┘
                                                                          │
                                                                          ▼
                                                          ┌──────────────────────────────────┐
                                                          │ [RESPONSE MODE]                  │
                                                          │ "Student got it right but gave   │
                                                          │  no reasoning. Ask WHY."         │
                                                          │                                  │
                                                          │ [REFERENCE EXAMPLES]             │
                                                          │ [STUDENT HISTORY]                │
                                                          │ [GUARDRAIL reminder]             │
                                                          └──────────────────────────────────┘
                                                                          │
                                                                          ▼
                                                          ┌──────────────────────────────────┐
                                                          │ DETERMINISTIC FINISH CHECK       │
                                                          │ in ragMiddleware:                │
                                                          │                                  │
                                                          │ If student has prior exchanges   │
                                                          │ (history >= 2 messages):         │
                                                          │ → FINISH directly with           │
                                                          │   "¡Correcto!" + <FIN_EJERCICIO> │
                                                          │                                  │
                                                          │ If no prior conversation:        │
                                                          │ → Ask for reasoning via LLM      │
                                                          └──────────────────────────────────┘

Resources used: ChromaDB, Ollama (embeddings), BM25 (in-memory), MongoDB (history + student history)
Augmentation:   Hint + Examples + Student history + Guardrail reminder
Special:        May trigger deterministic finish (bypass LLM)
```

### Path 6: `correct_wrong_reasoning` → `correct_concept`

```
Student: "R1, R2 y R4 porque forman un divisor de tensión"
         │
         ▼
┌─────────────────┐     ┌─────────────────────────────────┐
│ classifyQuery() │────►│ type: correct_wrong_reasoning   │
└─────────────────┘     │                                 │
                        │ Correct resistances BUT uses a  │
                        │ concept keyword → may be wrong  │
                        │ reasoning that happens to give  │
                        │ the right answer                │
                        └────────────────┬────────────────┘
                                         │
                              ┌──────────┴──────────┐
                              ▼                     ▼
                   ┌──────────────────┐  ┌───────────────────┐
                   │ Hybrid Search    │  │ Knowledge Graph   │
                   │ (dataset examples│  │ search by concept │
                   │  for tone)       │  │ keywords found    │
                   └────────┬─────────┘  │ in the message    │
                            │            └────────┬──────────┘
                            │                     │
                            ▼                     ▼
                   ┌───────────────────────────────────────────┐
                   │ [RESPONSE MODE]                           │
                   │ "Student got right answer but uses wrong  │
                   │  concept. Focus on correcting the AC."    │
                   │                                           │
                   │ [DOMAIN KNOWLEDGE]                        │
                   │ Concept: "divisor de tensión..."          │
                   │ Expert reasoning: "..."                   │
                   │ AC: "AC_LOCAL_ATTENUATION"                │
                   │ Socratic questions: "..."                 │
                   │                                           │
                   │ [REFERENCE EXAMPLES]                      │
                   │ [STUDENT HISTORY]                         │
                   │ [GUARDRAIL reminder]                      │
                   └───────────────────────────────────────────┘

Resources used: ChromaDB, Ollama (embeddings), BM25, Knowledge Graph, MongoDB (history + student history)
Augmentation:   Hint + KG context + Examples + Student history + Guardrail reminder
Special:        May trigger deterministic finish check in middleware
                (but typically falls through to LLM to correct the concept)
```

### Path 7: `correct_good_reasoning` → `rag_examples`

```
Student: "R1, R2 y R4 porque R3 está en abierto y R5 cortocircuitada"
         │
         ▼
┌─────────────────┐     ┌─────────────────────────────────┐
│ classifyQuery() │────►│ type: correct_good_reasoning    │
└─────────────────┘     │                                 │
                        │ Correct resistances + reasoning │
                        │ WITHOUT concept keywords        │
                        │ (reasoning uses circuit-specific│
                        │  observations, not theory terms)│
                        └────────────────┬────────────────┘
                                         │
                                         ▼
                              ┌──────────────────┐
                              │ Hybrid Search    │
                              │ (find similar    │
                              │  successful      │
                              │  interactions)   │
                              └────────┬─────────┘
                                       │
                                       ▼
                              ┌───────────────────────────────────┐
                              │ [RESPONSE MODE]                   │
                              │ "Student is correct with good     │
                              │  reasoning. Confirm and finalize."│
                              │                                   │
                              │ [REFERENCE EXAMPLES]              │
                              │ [STUDENT HISTORY]                 │
                              │ [GUARDRAIL reminder]              │
                              └───────────────────────────────────┘
                                       │
                                       ▼
                              ┌───────────────────────────────────┐
                              │ DETERMINISTIC FINISH              │
                              │ in ragMiddleware:                 │
                              │                                   │
                              │ ALWAYS finishes directly:         │
                              │ "¡Correcto! Has identificado      │
                              │  bien las resistencias."          │
                              │  + <FIN_EJERCICIO> token          │
                              │                                   │
                              │ LLM is NOT called.                │
                              │ Guardrails are NOT needed.        │
                              └───────────────────────────────────┘

Resources used: ChromaDB, Ollama (embeddings), BM25 (in-memory)
Augmentation:   Built but NOT used (deterministic finish bypasses LLM)
Special:        ALWAYS triggers deterministic finish — exercise ends here
```

### Path 8: `wrong_concept` → `concept_correction`

```
Student: "R1 y R2 dado que forman un divisor de tensión"
         │
         ▼
┌─────────────────┐     ┌─────────────────────────────────┐
│ classifyQuery() │────►│ type: wrong_concept             │
└─────────────────┘     │                                 │
                        │ Wrong resistances + concept     │
                        │ keywords → student has a        │
                        │ misconception (AC)              │
                        └────────────────┬────────────────┘
                                         │
                              ┌──────────┴──────────┐
                              ▼                     ▼
                   ┌──────────────────┐  ┌──────────────────┐
                   │ Knowledge Graph  │  │ Hybrid Search    │
                   │ search by concept│  │ (dataset examples│
                   │ keywords:        │  │  for tone)       │
                   │ "divisor de      │  │                  │
                   │  tensión"        │  │                  │
                   └────────┬─────────┘  └────────┬─────────┘
                            │                     │
                            ▼                     ▼
                   ┌───────────────────────────────────────────┐
                   │ [RESPONSE MODE]                           │
                   │ "Student shows an alternative conception. │
                   │  Focus ONLY on questioning the wrong      │
                   │  concept with Socratic questions.         │
                   │  Do NOT guide toward specific Rs."        │
                   │                                           │
                   │ [DOMAIN KNOWLEDGE]                        │
                   │ Concept: "divisor de tensión..."          │
                   │ AC: "AC_LOCAL_ATTENUATION"                │
                   │ Socratic questions: "..."                 │
                   │                                           │
                   │ [REFERENCE EXAMPLES]                      │
                   │ [STUDENT HISTORY]                         │
                   │ [GUARDRAIL reminder]                      │
                   └───────────────────────────────────────────┘

Resources used: Knowledge Graph, ChromaDB, Ollama (embeddings), BM25, MongoDB (student history)
Augmentation:   Hint + KG context + Examples + Student history + Guardrail reminder
```

### Path 9: `partial_correct` → `rag_examples`

```
Student: "no pasa por R3" (when R3 is NOT in the correct answer — correct exclusion, incomplete answer)
         │
         ▼
┌─────────────────┐     ┌──────────────────────┐     ┌────────────────────────┐
│ classifyQuery() │────►│ type: partial_correct │────►│ decision: rag_examples │
│                 │     │ proposed: []           │     └────────────┬───────────┘
│                 │     │ negated: ["R3"]        │                  │
└─────────────────┘     └──────────────────────┘                   │
                                                                   ▼
                                                    ┌───────────────────────────┐
                                                    │    Hybrid Search          │
                                                    │    (BM25 + Semantic + RRF)│
                                                    └──────────────┬────────────┘
                                                                   │
                                                                   ▼
                                                    ┌───────────────────────────────────────────┐
                                                    │ Build augmentation:                       │
                                                    │                                           │
                                                    │ [RESPONSE MODE]                           │
                                                    │ Classification: partial_correct            │
                                                    │ Hint: "Acknowledge their correct           │
                                                    │ reasoning, guide to complete answer"       │
                                                    │ + intermediate feedback phrases (partial)  │
                                                    │                                           │
                                                    │ [PER-ELEMENT ANALYSIS]                    │
                                                    │ CORRECT REJECTION: R3 not in answer       │
                                                    │ MISSING: R1, R2, R4 (in correct answer)   │
                                                    │                                           │
                                                    │ [REFERENCE EXAMPLES]                      │
                                                    │ [STUDENT HISTORY]                         │
                                                    │ [GUARDRAIL reminder]                      │
                                                    └───────────────────────────────────────────┘

Resources used: ChromaDB, Ollama (embeddings), BM25, MongoDB (student history)
Augmentation:   Hint + feedback phrases + Per-element analysis + Examples + Student history + Guardrail reminder
```

---

### Pipeline Path Summary Table

| # | Classification | Decision | Hybrid Search | CRAG | Knowledge Graph | Student History | Deterministic Finish |
|---|---|---|---|---|---|---|---|
| 1 | `greeting` | `no_rag` | — | — | — | — | — |
| 2 | `dont_know` | `scaffold` | — | — | 3 basic concepts | Yes | — |
| 3 | `single_word` | `demand_reasoning` | — | — | — | Yes | — |
| 4 | `wrong_answer` | `rag_examples` | Yes | If score < 0.4 | — | Yes | — |
| 5 | `correct_no_reasoning` | `demand_reasoning` | Yes | — | — | Yes | If history >= 2 msgs |
| 6 | `correct_wrong_reasoning` | `correct_concept` | Yes | — | By concepts | Yes | Checked (usually no) |
| 7 | `correct_good_reasoning` | `rag_examples` | Yes | — | — | Yes | Always (bypass LLM) |
| 8 | `wrong_concept` | `concept_correction` | Yes | — | By concepts | Yes | — |
| 9 | `partial_correct` | `rag_examples` | Yes | — | — | Yes | — |

---

## 7. Hybrid Search Engine Flow

Detailed flow of the `hybridSearch.js` module showing both search paths and RRF fusion.

```
                              Query: "R5 porque está conectada"
                                          │
                                          ▼
                              ┌──────────────────────┐
                              │  Generate Embedding  │
                              │  via Ollama API      │
                              │  (nomic-embed-text)  │
                              │  → 768d float vector │
                              └──────────┬───────────┘
                                         │
                          ┌──────────────┴──────────────┐
                          │                             │
                          ▼                             ▼
               ┌─────────────────────┐       ┌─────────────────────┐
               │     BM25 Search     │       │   Semantic Search   │
               │                     │       │                     │
               │  In-memory index    │       │  ChromaDB query     │
               │  per exercise       │       │  collection:        │
               │                     │       │  exercise_{num}     │
               │  Algorithm:         │       │                     │
               │  IDF(t) ×           │       │  Distance metric:   │
               │  tf×(k1+1) /        │       │  cosine             │
               │  (tf + k1×          │       │                     │
               │  (1-b+b×dl/avgDl))  │       │  Score:             │
               │                     │       │  1 - cosine_distance│
               │  k1 = 1.5           │       │                     │
               │  b  = 0.75          │       │  Returns top K      │
               │                     │       │  with scores        │
               │  Returns top K      │       │                     │
               │  with scores        │       │                     │
               └─────────┬───────────┘       └──────────┬──────────┘
                         │                              │
                         │  Ranked list 1               │  Ranked list 2
                         │  [{index, score}, ...]       │  [{id, score, doc}, ...]
                         │                              │
                         ▼                              ▼
               ┌─────────────────────────────────────────────────────┐
               │              Reciprocal Rank Fusion (RRF)           │
               │                                                     │
               │  For each document d:                               │
               │                                                     │
               │    score(d) = 1/(K + rank_bm25(d))                  │
               │             + 1/(K + rank_semantic(d))              │
               │                                                     │
               │    K = 60 (smoothing constant)                      │
               │                                                     │
               │  Example:                                           │
               │    Doc at BM25 rank 1, Semantic rank 3:             │
               │    score = 1/(60+1) + 1/(60+3) = 0.0164 + 0.0159    │
               │         = 0.0323                                    │
               │                                                     │
               │    Doc at BM25 rank 2, Semantic rank 1:             │
               │    score = 1/(60+2) + 1/(60+1) = 0.0161 + 0.0164    │
               │         = 0.0325                                    │
               │                                                     │
               │  Documents appearing in BOTH lists get higher       │
               │  scores than those in only one.                     │
               └───────────────────────┬─────────────────────────────┘
                                       │
                                       ▼
                              ┌──────────────────┐
                              │ Sort by combined │
                              │ score (desc)     │
                              │                  │
                              │ Return top 3     │
                              │ (TOP_K_FINAL)    │
                              └────────┬─────────┘
                                       │
                                       ▼
                              ┌──────────────────────────────────────────┐
                              │  CRAG Check (only for wrong_answer):     │
                              │                                          │
                              │  If top score < 0.4 (MED_THRESHOLD):     │
                              │                                          │
                              │  1. Extract key entities:                │
                              │     "R5 porque está conectada"           │
                              │     → ["R5", "corriente", "tensión"]     │
                              │                                          │
                              │  2. Reformulate query:                   │
                              │     "R5 corriente tensión"               │
                              │                                          │
                              │  3. Retry entire Hybrid Search           │
                              │     with reformulated query              │
                              │                                          │
                              │  4. Use better results                   │
                              └──────────────────────────────────────────┘
```

---

## 8. Guardrail Safety Chain

Five sequential checks in `ragMiddleware.js`, each with a retry mechanism. All detection patterns are multi-language (Spanish, Valencian, English), loaded from `languageManager.js`.

```
                    LLM Response (from Ollama, non-streaming)
                                    │
                                    ▼
                    ┌───────────────────────────────────┐
                    │  GUARDRAIL 1: Solution Leak Check │
                    │  (checkSolutionLeak)              │
                    │                                   │
                    │  Checks:                          │
                    │  1. Response contains ALL correct │
                    │     elements?                     │
                    │     If no → PASS (no leak)        │
                    │                                   │
                    │  2. Contains reveal phrases?      │
                    │     "la respuesta es",            │
                    │     "the answer is", etc.         │
                    │     (multi-language)              │
                    │     If yes → FAIL                 │
                    │                                   │
                    │  3. Lists all correct elements    │
                    │     together in affirmative sent? │
                    │     (excludes questions with ?)   │
                    │     If yes → FAIL                 │
                    └───────────────┬───────────────────┘
                               pass/ \fail → RETRY with stronger instruction
                                    │
                                    ▼
                    ┌───────────────────────────────────┐
                    │  GUARDRAIL 2: False Confirmation  │
                    │  (checkFalseConfirmation)         │
                    │                                   │
                    │  Active for: wrong_answer,        │
                    │  wrong_concept, single_word       │
                    │                                   │
                    │  Checks first 60 chars for:       │
                    │  "perfecto", "correct", "exacto", │
                    │  "very good", etc. (multi-lang,   │
                    │  accent-insensitive)              │
                    └───────────────┬───────────────────┘
                               pass/ \fail → RETRY with false-confirm instruction
                                    │
                                    ▼
                    ┌───────────────────────────────────┐
                    │  GUARDRAIL 3: Premature Confirm   │
                    │  (checkPrematureConfirmation)     │
                    │                                   │
                    │  Active for: correct_no_reasoning,│
                    │  correct_wrong_reasoning,         │
                    │  partial_correct                  │
                    │                                   │
                    │  Same 60-char check as G2 but     │
                    │  different trigger types —         │
                    │  prevents confirming correct       │
                    │  answer before reasoning validated│
                    └───────────────┬───────────────────┘
                               pass/ \fail → RETRY with partial-confirm instruction
                                    │
                                    ▼
                    ┌───────────────────────────────────┐
                    │  GUARDRAIL 4: State Reveal Check  │
                    │  (checkStateReveal)               │
                    │                                   │
                    │  Checks each sentence for:        │
                    │  element name + state phrase       │
                    │  (multi-language)                 │
                    │                                   │
                    │  Exception: questions (contains ?)│
                    │  are allowed (Socratic asking)    │
                    │                                   │
                    │  "R5 está cortocircuitada" → FAIL │
                    │  "¿Está R5 cortocircuitada?" → OK │
                    └───────────────┬───────────────────┘
                               pass/ \fail → RETRY with state-reveal instruction
                                    │
                                    ▼
                    ┌───────────────────────────────────┐
                    │  GUARDRAIL 5: Element Naming      │
                    │  (checkElementNaming)             │
                    │                                   │
                    │  Checks if tutor names a specific │
                    │  evaluable element in a question  │
                    │  or directive sentence:           │
                    │                                   │
                    │  "¿Qué pasa con R5?" → FAIL      │
                    │  "Fíjate en R3" → FAIL           │
                    │  "¿Qué pasa cuando hay un        │
                    │   cortocircuito?" → OK (concept)  │
                    └───────────────┬───────────────────┘
                               pass/ \fail → RETRY with element-naming instruction
                                    │
                                    ▼
                    ┌───────────────────────────────────┐
                    │  FALLBACK: Deterministic Prefix   │
                    │                                   │
                    │  If response STILL starts with    │
                    │  confirmation for wrong/partial:  │
                    │                                   │
                    │  1. removeOpeningConfirmation()   │
                    │     strips leading confirmations  │
                    │  2. Prepend deterministic phrase  │
                    │     ("Hmm, no del todo..." etc.)  │
                    └───────────────┬───────────────────┘
                                    │
                                    ▼
                    ┌───────────────────────────────────┐
                    │  Send response to student via SSE │
                    └───────────────────────────────────┘
```

### Guardrail Worst Case

In the worst case, all 5 guardrails fail, requiring **6 total LLM calls** (1 original + 5 retries). If the response still starts with a confirmation after all retries, the deterministic prefix fallback provides a last-resort fix without an additional LLM call. This is why non-streaming mode is essential — the system must inspect the full response before deciding whether to send it or retry.

---

## 9. Middleware Request Lifecycle

Complete lifecycle of a request through `ragMiddleware.js` with all decision points.

```
                    POST /api/ollama/chat/stream
                    { userId, exerciseId, userMessage, interaccionId }
                                    │
                                    ▼
                    ┌───────────────────────────────────┐
                    │  RAG_ENABLED = true?              │──── no ──► next() → ollamaChatRoutes
                    │  ragReady = true?                 │
                    └───────────────┬───────────────────┘
                                   │ yes
                                   ▼
                    ┌───────────────────────────────────┐
                    │  Valid userId (ObjectId)?         │──── no ──► next()
                    │  Valid exerciseId (ObjectId)?     │
                    │  Non-empty userMessage?           │
                    └───────────────┬───────────────────┘
                                   │ yes
                                   ▼
                    ┌───────────────────────────────────┐
                    │  Load exercise from MongoDB       │
                    │  exerciseNum extractable?         │──── no ──► next()
                    │  correctAnswer non-empty?         │
                    └───────────────┬───────────────────┘
                                   │ yes
                                   ▼
                    ┌───────────────────────────────────┐
                    │  Resolve language from history     │
                    │  Get evaluable elements            │
                    │  Run RAG Pipeline                  │
                    │  (classifyQuery + retrieval)       │
                    └───────────────┬───────────────────┘
                                   │
                                   ▼
                    ┌───────────────────────────────────┐
                    │  decision === "no_rag"?           │──── yes ──► next() → ollamaChatRoutes
                    │  (greeting classification)        │
                    └───────────────┬───────────────────┘
                                   │ no (RAG handles from here)
                                   ▼
                    ┌───────────────────────────────────┐
                    │  Set SSE headers                  │
                    │  Start heartbeat (15s interval)   │
                    └───────────────┬───────────────────┘
                                   │
                                   ▼
                    ┌───────────────────────────────────┐
                    │  Load or create Interaccion       │
                    │  Save user message to MongoDB     │
                    └───────────────┬───────────────────┘
                                   │
                                   ▼
                    ┌───────────────────────────────────┐
                    │  LOOP DETECTION                   │
                    │                                   │
                    │  detectTutorRepetition()          │
                    │  countPreviousCorrectTurns()      │
                    │  countConsecutiveWrongTurns()     │
                    │  countTotalAssistantTurns()       │
                    │  detectFrustration()              │
                    │                                   │
                    │  Loop override: if correct answer │
                    │  + repetition → correct_good_reas │
                    └───────────────┬───────────────────┘
                                   │
                                   ▼
                    ┌───────────────────────────────────┐
                    │  DETERMINISTIC FINISH CHECK       │
                    │                                   │
                    │  correct_good_reasoning?          │──── yes ──► Send finish msg (lang-aware)
                    │  (incl. loop override)            │             + FIN token. Log + End SSE
                    └───────────────┬───────────────────┘
                                   │ no (needs LLM)
                                   ▼
                    ┌───────────────────────────────────┐
                    │  Build augmented system prompt    │
                    │  = base prompt                    │
                    │  + conversation progress hint     │
                    │  + anti-loop / frustration /      │
                    │    stuck hints (if applicable)    │
                    │  + RAG augmentation               │
                    │                                   │
                    │  Load conversation history        │
                    │  (last 8 messages from MongoDB)   │
                    └───────────────┬───────────────────┘
                                   │
                                   ▼
                    ┌───────────────────────────────────┐
                    │  Call Ollama (non-streaming)      │
                    │  model: qwen2.5, T=0.4            │
                    │  num_ctx: 8192, num_predict: 120  │
                    └───────────────┬───────────────────┘
                                   │
                                   ▼
                    ┌───────────────────────────────────┐
                    │  Run 5 Guardrails sequentially    │
                    │  (see Guardrail Safety Chain)     │
                    │  Each may trigger an LLM retry    │
                    │  + deterministic prefix fallback  │
                    └───────────────┬───────────────────┘
                                   │
                                   ▼
                    ┌───────────────────────────────────┐
                    │  SSE: {chunk: response}           │
                    │  Save assistant msg to MongoDB    │
                    │  SSE: [DONE]                      │
                    │  Log interaction to JSONL         │
                    │  Emit request_end event           │
                    └───────────────────────────────────┘
```

---


## 10. Evaluation System Flow

```
                          ┌──────────────────────────────────────────┐
                          │         OFFLINE EVALUATION               │
                          │         (no server needed)               │
                          └──────────────────┬───────────────────────┘
                                             │
                     ┌───────────────────────┼───────────────────────┐
                     │                       │                       │
                     ▼                       ▼                       ▼
          ┌──────────────────┐   ┌───────────────────┐   ┌──────────────────────┐
          │ JSONL Log Files  │   │ Exercise Datasets │   │ Ground Truth         │
          │ backend/logs/    │   │ material-comple-  │   │ (dataset student-    │
          │ rag/YYYY-MM-DD   │   │ mentario/llm/     │   │  tutor pairs)        │
          │ .jsonl           │   │ datasets/*.json   │   │                      │
          └────────┬─────────┘   └────────┬──────────┘   └──────────┬───────────┘
                   │                      │                         │
                   ▼                      ▼                         ▼
          ┌───────────────────────────────────────────────────────────────────┐
          │                    evaluateRetrieval.py                           │
          │                                                                   │
          │  For each logged query:                                           │
          │  1. Find relevant docs in ground truth (text matching)            │
          │  2. Compare retrieved docs (from log) against relevant set        │
          │  3. Compute: Precision@K, Recall@K, AP@K, RR                      │
          │  4. Average across all queries → MAP@K, MRR                       │
          │                                                                   │
          │  Output: results/retrievalMetrics.json                            │
          └───────────────────────────────────────────────────────────────────┘
                                             │
                                             ▼
          ┌───────────────────────────────────────────────────────────────────┐
          │                    evaluateGeneration.py                          │
          │                                                                   │
          │  Basic mode (heuristic):                                          │
          │  1. Socratic Rate: % of responses with "?"                        │
          │  2. Avg Question Words: count of "por qué", "cómo", etc.          │
          │  3. Guardrail Safe Rate: % without reveal phrases                 │
          │  4. Avg Response Length                                           │
          │                                                                   │
          │  RAGAS mode (if installed):                                       │
          │  1. Faithfulness (grounding in context)                           │
          │  2. Answer Relevancy                                              │
          │  3. Context Precision                                             │
          │  4. Context Recall                                                │
          │                                                                   │
          │  Output: results/generationMetricsBasic.json                      │
          └───────────────────────────────────────────────────────────────────┘


                          ┌──────────────────────────────────────────┐
                          │         LIVE BENCHMARK                   │
                          │         (server must be running)         │
                          └──────────────────┬───────────────────────┘
                                             │
                                             ▼
          ┌───────────────────────────────────────────────────────────────────┐
          │                      runBenchmark.py                              │
          │                                                                   │
          │  1. Check server is running                                       │
          │  2. For each exercise:                                            │
          │     a. Pick 5 evenly-spaced test samples from dataset             │
          │     b. POST each to /api/ollama/chat/stream                       │
          │     c. Parse SSE response                                         │
          │     d. Record: query, expected, actual, timing                    │
          │  3. Run evaluateRetrieval.py on new logs                          │
          │  4. Run evaluateGeneration.py on new logs                         │
          │                                                                   │
          │  Output: results/benchmarkResults.json                            │
          │          results/retrievalMetrics.json                            │
          │          results/generationMetricsBasic.json                      │
          └───────────────────────────────────────────────────────────────────┘
```

---

## 10. Workflow Monitor Event Flow

How events flow from the RAG pipeline to the browser visualization.

```
┌─────────────────────────────────────────────────────────────────────────────────────┐
│                               BACKEND                                               │
│                                                                                     │
│  ragMiddleware.js ─┐                                                                │
│  ragPipeline.js ───┤                                                                │
│  hybridSearch.js ──┤    emitEvent(name, status, data)                               │
│  All RAG modules ──┤                                                                │
│                    ▼                                                                │
│           ┌──────────────────┐        ┌──────────────────┐                          │
│           │  ragEventBus.js  │───────►│workflowSocket.js │                          │
│           │                  │        │                  │                          │
│           │  Singleton       │  on    │  WebSocket Server│                          │
│           │  EventEmitter    │ "event"│  /ws/workflow    │                          │
│           │                  │        │                  │                          │
│           │  Events emitted: │        │  Broadcasts to   │                          │
│           │  request_start   │        │  all connected   │                          │
│           │  exercise_loaded │        │  clients as JSON │                          │
│           │  pipeline_start  │        │                  │                          │
│           │  classify_start  │        └────────┬─────────┘                          │
│           │  classify_end    │                 │                                    │
│           │  routing_decision│                 │ WebSocket                          │
│           │  hybrid_search_* │                 │                                    │
│           │  embedding_*     │                 │                                    │
│           │  bm25_search_*   │                 │                                    │
│           │  semantic_search_*│                │                                    │
│           │  rrf_fusion_*    │                 │                                    │
│           │  crag_reformulate│                 │                                    │
│           │  kg_search_*     │                 │                                    │
│           │  student_history_*│                │                                    │
│           │  augmentation_*  │                 │                                    │
│           │  prompt_built    │                 │                                    │
│           │  history_loaded  │                 │                                    │
│           │  ollama_call_*   │                 │                                    │
│           │  guardrail_*     │                 │                                    │
│           │  ollama_retry    │                 │                                    │
│           │  deterministic_* │                 │                                    │
│           │  response_sent   │                 │                                    │
│           │  mongodb_save    │                 │                                    │
│           │  log_written     │                 │                                    │
│           │  request_end     │                 │                                    │
│           │  request_error   │                 │                                    │
│           └──────────────────┘                 │                                    │
└────────────────────────────────────────────────┼────────────────────────────────────┘
                                                 │
                                                 ▼
┌─────────────────────────────────────────────────────────────────────────────────────┐
│                          WORKFLOW MONITOR (React)                                   │
│                                                                                     │
│  ┌──────────────────────────┐                                                       │
│  │  useWorkflowSocket.js    │  Manages WebSocket connection with auto-reconnect     │
│  │                          │  and exponential backoff                              │
│  │  Event → Node mapping:   │                                                       │
│  │  "classify_start"  → classifier node                                             │
│  │  "bm25_search_end" → bm25 node                                                   │
│  │  "ollama_call_end" → ollama node                                                 │
│  │  "guardrail_leak"  → leak guardrail node                                         │
│  │  etc.                    │                                                       │
│  └──────────┬───────────────┘                                                       │
│             │                                                                       │
│      ┌──────┴──────┬──────────────┬──────────────┬─────────────┐                    │
│      ▼             ▼              ▼              ▼             ▼                    │
│  ┌────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐                 │
│  │Pipeline│  │ Event    │  │  Node    │  │ Request  │  │  Timing  │                 │
│  │ Graph  │  │  Log     │  │ Detail   │  │  Info    │  │   Bar    │                 │
│  │        │  │          │  │          │  │          │  │          │                 │
│  │6 node  │  │Chrono-   │  │Full data │  │Current   │  │Per-stage │                 │
│  │types:  │  │logical   │  │for       │  │request   │  │horizontal│                 │
│  │Pipeline│  │event     │  │selected  │  │metadata, │  │stacked   │                 │
│  │External│  │stream    │  │node      │  │elapsed   │  │bar       │                 │
│  │Algorith│  │with      │  │          │  │timer,    │  │          │                 │
│  │Guardrail│ │status    │  │          │  │connection│  │          │                 │
│  │Document│  │badges    │  │          │  │status    │  │          │                 │
│  │Section │  │          │  │          │  │          │  │          │                 │
│  └────────┘  └──────────┘  └──────────┘  └──────────┘  └──────────┘                 │
│                                                                                     │
│  Node Visual States:                                                                │
│  ○ idle (gray)  ● active (blue pulse)  ● completed (green)  ● error (red)           │
│  ○ skipped (dashed border)                                                          │
└─────────────────────────────────────────────────────────────────────────────────────┘
```

---

## 11. Complete Student Interaction Lifecycle

End-to-end flow from the student opening the application to completing an exercise.

```
┌─ STUDENT OPENS APP ──────────────────────────────────────────────────────────────────┐
│                                                                                      │
│  1. Browser → GET http://localhost:5173                                              │
│  2. React app loads → GET /auth/demo (dev mode) → session created in MongoDB         │
│  3. GET /api/ejercicios → exercise list rendered                                     │
│  4. Student selects an exercise → GET /api/ejercicios/:id                            │
│  5. GET /api/interacciones/usuario/:userId/ejercicio/:ejercicioId                    │
│     (check for existing conversation)                                                │
│                                                                                      │
└──────────────────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─ CONVERSATION LOOP ──────────────────────────────────────────────────────────────────┐
│                                                                                      │
│  Student types message ──► POST /api/ollama/chat/stream                              │
│                                                                                      │
│  ┌── RAG MIDDLEWARE INTERCEPTS ──────────────────────────────────────────────────┐   │
│  │                                                                               │   │
│  │  Classify → Route → Retrieve → Augment → LLM → Guardrails → Respond           │   │
│  │                                                                               │   │
│  │  The tutor NEVER reveals the answer.                                          │   │
│  │  The tutor ALWAYS asks Socratic questions.                                    │   │
│  │  The tutor guides the student to discover the solution.                       │   │
│  │                                                                               │   │
│  └───────────────────────────────────────────────────────────────────────────────┘   │
│                                                                                      │
│  SSE response displayed in chat ◄── student reads and thinks                         │
│                                                                                      │
│  Repeat until:                                                                       │
│  - Student gives correct resistances + good reasoning → deterministic finish         │
│  - Student gives correct resistances (after prior reasoning) → deterministic finish  │
│  - Response contains <FIN_EJERCICIO> token → frontend detects exercise complete      │
│                                                                                      │
└──────────────────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─ EXERCISE COMPLETION ────────────────────────────────────────────────────────────────┐
│                                                                                      │
│  1. Frontend detects <FIN_EJERCICIO> in response                                     │
│  2. POST /api/resultados/finalizar                                                   │
│     { userId, ejercicioId, interaccionId, respuestaFinal, tiempoTotal }              │
│  3. Backend loads full conversation from MongoDB                                     │
│  4. Sends conversation to Ollama for analysis:                                       │
│     "Analyze this conversation, identify errors and alternative conceptions,         │
│      score 0-10, provide personalized advice"                                        │
│  5. LLM returns structured JSON: { errores, puntuacion, analisis, consejo }          │
│  6. Resultado document saved to MongoDB                                              │
│  7. Results displayed to student: score, errors found, advice                        │
│                                                                                      │
│  Student can then:                                                                   │
│  - View progress: GET /api/progreso/:userId                                          │
│  - Start another exercise                                                            │
│  - Review past results                                                               │
│                                                                                      │
└──────────────────────────────────────────────────────────────────────────────────────┘
```
