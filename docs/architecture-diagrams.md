# Architecture Diagrams

Comprehensive visual documentation of the system: the hexagonal layering, how components connect, the dependency-injection wiring, the request lifecycle through the agent orchestrator, all classification and routing paths, the guardrail pipeline, and the PostgreSQL data model.

> **Scope note.** The model is referred to throughout as **qwen2.5**. The real-time pipeline monitor is intentionally **not** documented here.

---

## Table of Contents

1. [System Architecture — Full Connection Map](#1-system-architecture--full-connection-map)
2. [Hexagonal Layers (Ports & Adapters)](#2-hexagonal-layers-ports--adapters)
3. [Dependency-Injection Container](#3-dependency-injection-container)
4. [Request Lifecycle — The Two Execution Paths](#4-request-lifecycle--the-two-execution-paths)
5. [Orchestrator — 10-Agent Sequence](#5-orchestrator--10-agent-sequence)
6. [Query Classification Decision Tree](#6-query-classification-decision-tree)
7. [Pipeline Routing — Per Classification](#7-pipeline-routing--per-classification)
8. [Hybrid Search + RRF + CRAG](#8-hybrid-search--rrf--crag)
9. [Guardrail Pipeline](#9-guardrail-pipeline)
10. [Input Security Flow](#10-input-security-flow)
11. [PostgreSQL Data Model](#11-postgresql-data-model)

---

## 1. System Architecture — Full Connection Map

Every runtime component and the protocols that connect them.

```
┌────────────────────────────────────────────────────────────────────────────────────────────┐
│                                      EXTERNAL CLIENT                                          │
│   ┌──────────────────────────────────┐                                                       │
│   │      Student Frontend            │   React 19 + Vite 6 + Tailwind 4                       │
│   │      port 5173 (dev)             │                                                        │
│   │   [Login] [Exercises] [Chat]     │                                                        │
│   │   [Progress dashboard]           │                                                        │
│   └─────────────────┬────────────────┘                                                        │
│                     │  HTTP + SSE   (session cookie, credentials)                             │
│                     │  POST /api/ollama/chat/stream     GET /api/ejercicios                   │
│                     │  GET  /api/interacciones/*        GET /api/progreso/*                   │
│                     │  POST /api/resultados/finalizar   GET /api/auth/me                      │
└─────────────────────┼────────────────────────────────────────────────────────────────────────┘
                      ▼
┌────────────────────────────────────────────────────────────────────────────────────────────┐
│                          BACKEND — Node.js + Express 5  (port 3001)                           │
│                                                                                              │
│   INTERFACES                                                                                 │
│   Request ─► CORS ─► JSON parser ─► Session (connect-pg-simple) ─► globalAuth ─► route match  │
│        ┌───────────────────────────────────────────────────────────────────────────────┐    │
│        │ /api/ollama/chat/stream → orchestratorMiddleware → ragMiddleware → ollamaChat    │    │
│        │ /api/ejercicios   /api/interacciones   /api/resultados   /api/progreso           │    │
│        │ /api/export       /api/usuarios        /api/auth/*        /static/*  /* (SPA)     │    │
│        └───────────────────────────────────────────────────────────────────────────────┘    │
│                                       │                                                      │
│   DOMAIN (pure logic)                 ▼                                                       │
│   ┌────────────────────────────────────────────────────────────────────────────────────┐   │
│   │  TutoringOrchestrator ──► 10 agents over a shared AgentContext (blackboard)          │   │
│   │  queryClassifier · ragPipeline · GuardrailPipeline · promptBuilder · languageManager │   │
│   │  cumulativeAnswer · elementStates · acRegistry · kgRegistry · historySummarizer      │   │
│   │  Entities · Ports (interfaces)                                                       │   │
│   └────────────────────────────────────────────────────────────────────────────────────┘   │
│                                       │  (ports)                                             │
│   INFRASTRUCTURE (adapters)           ▼                                                       │
│   ┌────────────────────────────────────────────────────────────────────────────────────┐   │
│   │ Pg*Repository  │ OllamaLlmAdapter / PoliGptLlmAdapter │ 11 Guardrail adapters         │   │
│   │ hybridSearch + bm25 + knowledgeGraph │ chromaClient + embeddings │ HeuristicSecurity   │   │
│   │ ragEventBus · jsonAuditLogger · pipelineDebugLogger                                   │   │
│   └──┬───────────────────────────┬───────────────────────────────┬────────────────────────┘   │
└──────┼───────────────────────────┼───────────────────────────────┼────────────────────────────┘
       │ TCP (pg)                   │ HTTP REST                      │ HTTP
       ▼                            ▼                                ▼
┌──────────────────┐     ┌──────────────────────┐      ┌────────────────────────────────────┐
│   PostgreSQL     │     │      ChromaDB        │      │       LLM provider                  │
│   port 5432      │     │      port 8000       │      │   Ollama (local/UPV) or PoliGPT     │
│                  │     │                      │      │                                     │
│  usuarios        │     │  exercise_1          │      │  chat: qwen2.5                      │
│  ejercicios      │     │  exercise_3 … _7     │      │    temperature 0.4                  │
│  tutor_contexts  │     │  knowledge_graph     │      │    num_ctx 8192, num_predict 220    │
│  interacciones   │     │                      │      │    keep_alive 60m                   │
│  messages        │     │  768d vectors        │      │                                     │
│  resultados      │     │  cosine distance     │      │  embeddings: nomic-embed-text       │
│  error_entries   │     │  HNSW index          │      │    768 dimensions                   │
│  sessions        │     │                      │      │                                     │
└──────────────────┘     └──────────────────────┘      └────────────────────────────────────┘
```

### Connection summary

| From | To | Protocol | Purpose |
|---|---|---|---|
| Frontend | Backend | HTTP POST + SSE | Chat messages (streamed responses) |
| Frontend | Backend | HTTP GET/POST | Exercises, interactions, results, progress, auth |
| Backend (Pg\*Repository) | PostgreSQL | TCP (`pg` pool) | Load exercise, persist messages, results, sessions |
| Backend (hybridSearch) | ChromaDB | HTTP REST | Semantic vector search |
| Backend (embeddings) | LLM provider | HTTP POST | Text → 768d embedding |
| Backend (LLM adapter) | LLM provider | HTTP POST | Chat completion (non-streaming for guardrails; optional token stream) |
| Backend (bm25, knowledgeGraph) | In-memory | Direct | Keyword search + concept search (loaded at startup) |
| Backend (ragEventBus) | jsonAuditLogger / debug logger | EventEmitter | Internal observability (audit JSONL, trace logs) |

---

## 2. Hexagonal Layers (Ports & Adapters)

The dependency rule points **inward**: infrastructure depends on the domain (it implements domain ports), never the reverse. The domain has no imports of Express, `pg`, ChromaDB or the LLM SDK.

```
                        ┌───────────────────────────────────────────────┐
                        │                  INTERFACES                    │
                        │   HTTP routes · chat middleware · SSE          │
                        │   (Express — the delivery mechanism)           │
                        └───────────────────────┬───────────────────────┘
                                                │ calls
                                                ▼
        ┌───────────────────────────────────────────────────────────────────────┐
        │                              DOMAIN                                     │
        │                                                                        │
        │   Entities:  Usuario · Ejercicio · TutorContext · Interaccion ·         │
        │              Message · MessageMetadata · Resultado · ErrorEntry         │
        │                                                                        │
        │   Logic:     TutoringOrchestrator + 10 agents · queryClassifier ·       │
        │              ragPipeline · GuardrailPipeline · promptBuilder ·          │
        │              languageManager · cumulativeAnswer · elementStates · …     │
        │                                                                        │
        │   PORTS (interfaces the domain depends on):                            │
        │   ┌──────────────────────────────┐   ┌──────────────────────────────┐  │
        │   │ repositories/                │   │ services/                     │  │
        │   │  IUsuarioRepository          │   │  ILlmService                 │  │
        │   │  IEjercicioRepository        │   │  IEmbeddingService           │  │
        │   │  IInteraccionRepository      │   │  IVectorSearchService        │  │
        │   │  IMessageRepository          │   │  IGuardrail                  │  │
        │   │  IResultadoRepository        │   │  ISecurityService            │  │
        │   └──────────────▲───────────────┘   └──────────────▲───────────────┘  │
        └──────────────────┼──────────────────────────────────┼─────────────────┘
                          │ implements                        │ implements
        ┌──────────────────┼──────────────────────────────────┼─────────────────┐
        │                  │          INFRASTRUCTURE           │                 │
        │   ┌──────────────┴───────────────┐   ┌──────────────┴───────────────┐  │
        │   │ persistence/postgresql/      │   │ llm/  OllamaLlmAdapter        │  │
        │   │  PgUsuarioRepository         │   │       PoliGptLlmAdapter       │  │
        │   │  PgEjercicioRepository       │   │ vectordb/ chromaClient        │  │
        │   │  PgInteraccionRepository     │   │           embeddings          │  │
        │   │  PgMessageRepository         │   │ search/   hybridSearch · bm25 │  │
        │   │  PgResultadoRepository       │   │           knowledgeGraph      │  │
        │   └──────────────────────────────┘   │ guardrails/ 11 adapters       │  │
        │                                      │ security/ HeuristicSecurity   │  │
        │                                      └──────────────────────────────┘  │
        └────────────────────────────────────────────────────────────────────────┘
```

**Why this matters.** The pedagogical rules can be unit-tested with in-memory fakes for every port; the PostgreSQL migration replaced only the adapters under `persistence/`; switching the LLM provider is a one-line change of `LLM_PROVIDER` because both adapters satisfy the same `ILlmService` port.

---

## 3. Dependency-Injection Container

`backend/src/container.js` is the single composition root. At startup it constructs every adapter and injects them into the domain. `index.js` calls `container.initialize()` once after the HTTP server starts listening.

```
                           container.initialize()
                                    │
   ┌────────────────────────────────┼─────────────────────────────────────────────┐
   │                                │                                              │
   ▼                                ▼                                              ▼
PostgreSQL pool                 LLM service                                Knowledge / search
(_initPostgreSQL)               (LLM_PROVIDER)                             loading
   │                                │                                              │
   │ runMigrations()                ├─ "poligpt" → PoliGptLlmAdapter               ├─ load KG (in-memory)
   │ then build 5 repos:            └─ else      → OllamaLlmAdapter                ├─ concept patterns from KG
   ├─ PgUsuarioRepository                                                          ├─ BM25 index per exercise
   ├─ PgEjercicioRepository        securityService = HeuristicSecurityAdapter      └─ Chroma health check
   ├─ PgInteraccionRepository                                                         (CHROMA_REQUIRED)
   ├─ PgMessageRepository          guardrailPipeline = new GuardrailPipeline({
   └─ PgResultadoRepository            guardrails: createGuardrailsForProfile(GUARDRAIL_PROFILE),
                                       llmService, budgetMs, minRetryBudgetMs, emitEvent })
   │
   ▼
historySummarizer = new HistorySummarizer({ llmService })   (or NullHistorySummarizer)
   │
   ▼
agents = createAgentRegistry({ repos…, llmService, guardrailPipeline, historySummarizer,
                               classifyQuery, runFullPipeline, securityService,
                               buildSystemPrompt, kgConceptPatterns, loggers })
   │
   ▼
orchestrator = new TutoringOrchestrator(agents, { emitEvent })
   │
   ▼
container._initialized = true     ← gates whether orchestratorMiddleware handles requests
```

Only `DATABASE_TYPE = "postgresql"` is supported; the container throws on any other value. Mongoose has been removed.

---

## 4. Request Lifecycle — The Two Execution Paths

A chat request is offered to three handlers in order. The first one that accepts it serves the whole response; the rest are skipped via `next()`.

```
            POST /api/ollama/chat/stream
                       │
                       ▼
        ┌──────────────────────────────┐
        │     globalAuth middleware    │  401 if no session (unless public/export-token)
        └──────────────┬───────────────┘
                       ▼
        ┌──────────────────────────────────────────────────────────────────┐
        │  orchestratorMiddleware                                           │
        │  handles IFF  USE_ORCHESTRATOR=1  AND  container._initialized      │
        │  AND inputs valid (userId, exerciseId, userMessage)               │
        │     │                                                            │
        │     ├─ greeting/off_topic fast-path → deterministic greeting      │
        │     └─ else → container.orchestrator.process()  (10 agents)        │
        └──────────────┬───────────────────────────────────────────────────┘
                       │ not enabled / not ready / invalid → next()
                       ▼
        ┌──────────────────────────────────────────────────────────────────┐
        │  ragMiddleware  (legacy linear pipeline, kept for A/B)            │
        │  handles IFF  RAG_ENABLED ≠ "false"  AND ragReady AND inputs valid│
        │     classify → security → retrieve → LLM → guardrails → persist   │
        └──────────────┬───────────────────────────────────────────────────┘
                       │ disabled / not ready / no_rag (greeting) → next()
                       ▼
        ┌──────────────────────────────────────────────────────────────────┐
        │  ollamaChatRoutes  (plain LLM fallback — no RAG, no guardrails)    │
        └──────────────────────────────────────────────────────────────────┘
```

All three speak the same **SSE contract**: a comment `: ok` to open, periodic `: ping` heartbeats (≈15 s), `data: {…}` frames carrying chunks/metadata, and `data: [DONE]` to close. The `<END_EXERCISE>` token in a response signals the frontend that the exercise is complete.

---

## 5. Orchestrator — 10-Agent Sequence

`TutoringOrchestrator.process()` runs ten single-responsibility agents over one mutable `AgentContext`. Each agent reads inputs and writes its outputs back to the context. Some stages run in parallel; three points can exit early.

```
 Client          Orchestrator        ContextAgent  AcTracker  InputGuard  Classifier  AcDetector  Retrieval  Tutor  PedReviewer  Guardrail  Persistence
   │  request         │                   │            │          │          │           │           │       │         │           │            │
   │─────────────────►│                   │            │          │          │           │           │       │         │           │            │
   │            split time budget         │            │          │          │           │           │       │         │           │            │
   │            (retrieval 20% · guardrail 10% · tutor rest)       │          │           │           │       │         │           │            │
   │                  │  execute ────────►│ load exercise, history, lang,     │           │           │       │         │           │            │
   │                  │                   │ loopState, cumulativeAnswer       │           │           │       │         │           │            │
   │                  │◄── ctx.fallthrough? ── if invalid exercise → RETURN    │           │           │       │         │           │            │
   │                  │                                │          │          │           │           │       │         │           │            │
   │                  │  ┌── acTracker.execute() (PARALLEL: user AC history) ─┐│          │           │           │       │         │           │
   │                  │  │  inputGuardrail.execute() ──► security verdict      ││          │           │           │       │         │           │
   │                  │  └── await both ───────────────────────────────────── ┘│          │           │           │       │         │           │
   │                  │◄── ctx.inputBlocked? ── if unsafe → persist + RETURN    │          │           │           │       │         │           │
   │                  │                                            │          │           │           │       │         │           │
   │                  │  classifier.execute() ──────────────────────────────► {type, proposed, negated, concepts, …}     │           │            │
   │                  │  acDetector.execute() ──► detectedACs, turnVerdict, stateMismatches │           │       │         │           │            │
   │                  │◄── greeting/off_topic? ── set fallthrough → RETURN      │          │           │           │       │         │           │
   │                  │                                                        │           │           │       │         │           │            │
   │                  │  retrieval.execute() (unless canSkip) ──────────────────────────► ragResult {augmentation, decision, sources}  │            │
   │                  │     (respects retrievalBudgetMs; may CRAG-retry)        │          │           │           │       │         │           │
   │                  │◄── _shouldFinishDeterministically()? ── if yes → finalResponse = finish msg + persist + RETURN    │           │            │
   │                  │                                                                    │           │       │         │           │            │
   │                  │  tutor.execute() ──► build augmented prompt, call LLM (qwen2.5) ──► llmResponse (optional token stream) ──────►│            │
   │                  │  pedagogicalReviewer.execute() ──► deterministic repairs on llmResponse (no LLM)                  │           │            │
   │                  │  guardrail.execute() (unless deterministicFinish) ──► GuardrailPipeline.validate() ──► finalResponse           │            │
   │                  │  _stripUnauthorizedFinToken() + _normaliseWhitespace()                                            │           │            │
   │                  │  persistence.execute() ──► save user + assistant messages (rich metadata), audit log, emit event ───────────►│
   │◄─────────────────│  SSE: chunk(s) + {done, fullText, timing} + [DONE]                                                            │            │
```

### Agent responsibilities

| # | Agent | Responsibility | Notable behaviour |
|---|---|---|---|
| 1 | **ContextAgent** | Load exercise, conversation history (windowed to `HISTORY_MAX_MESSAGES`), language, `loopState`, `cumulativeAnswer`, older-history summary | Sets `fallthrough` if the exercise/tutor context is invalid |
| 2 | **AcTrackerAgent** | Aggregate the student's recurring alternative conceptions from past results + messages | Runs **in parallel** with input guardrail |
| 3 | **InputGuardrailAgent** | Input defense (prompt injection, off-topic) via `HeuristicSecurityAdapter` | Sets `inputBlocked` → orchestrator persists a redirect and exits |
| 4 | **ClassifierAgent** | Rule-based classification of the message (9 types) | Pure, no LLM; uses last assistant text for closed-question handling |
| 5 | **AcDetectorAgent** | Deterministic AC matching + per-element `turnVerdict` + `stateMismatches` | Pure computation |
| 6 | **RetrievalAgent** | Run the RAG pipeline (hybrid search + KG + CRAG), build augmentation | `canSkip` on greeting/empty; honours retrieval budget |
| 7 | **TutorAgent** | Build the augmented system prompt and call the LLM | Optional token streaming; injects loop-break/frustration/progress banners |
| 8 | **PedagogicalReviewerAgent** | Deterministic, no-LLM pedagogical repairs on the draft | Strips premature confirmation, reframes definition requests, fixes code-switching |
| 9 | **GuardrailAgent** | Output safety via `GuardrailPipeline.validate()` | Skipped on deterministic finish; maps violations to metadata flags |
| 10 | **PersistenceAgent** | Save user + assistant messages with full metadata; audit log; emit event | Always runs (even after input block / finish) |

### Early-exit points

1. **Invalid exercise** → `ContextAgent` sets `fallthrough`; orchestrator returns (request falls through to legacy handler).
2. **Unsafe input** → `InputGuardrailAgent` sets `inputBlocked`; a localized redirect is persisted and returned.
3. **Deterministic finish** → when the cumulative answer is complete and reasoned (or a reasoned-correct turn follows a prior one), the orchestrator builds the closure message (`<END_EXERCISE>`) and skips the LLM, pedagogical reviewer and guardrails.

### Time budget

`ORCHESTRATOR_BUDGET_MS` (default 30 s, configurable) is split per stage: **retrieval** = 20 % (clamped 2–8 s), **guardrails** = 10 % (clamped 1.5–5 s), **tutor** = the remainder (≥ 8 s).

---

## 6. Query Classification Decision Tree

`domain/services/rag/queryClassifier.js` applies these checks **in order**; the first match wins. It is fully rule-based and multi-language (es/val/en).

```
                              Student Message
                                    │
                                    ▼
                        ┌───────────────────────┐
                        │ greeting + short msg? │── yes ─► greeting
                        └───────────┬───────────┘
                                    │ no
                        ┌───────────▼───────────┐
                        │ "don't know" phrase?  │── yes ─► dont_know
                        └───────────┬───────────┘
                                    │ no
                        ┌───────────▼────────────────────┐
                        │ question mark, no elements?     │── yes ─► dont_know
                        └───────────┬─────────────────────┘
                                    │ no
                        ┌───────────▼─────────────────────────────────────┐
                        │ yes/no answer to a CLOSED question?              │
                        │   • diagnostic (meta) question → closedAnswer    │
                        │   • reasoning question → infer correct / wrong   │
                        └───────────┬─────────────────────────────────────┘
                                    │ no closed-question context
                        ┌───────────▼─────────────────────────────────────┐
                        │ extract elements → split proposed vs negated     │
                        │ (negationDetector: pre-word / pre-phrase / post) │
                        └───────────┬─────────────────────────────────────┘
                                    ▼
                   ┌────────────────────────────────┐
                   │ proposed set == correct answer? │
                   └───────┬────────────────┬────────┘
                       yes │                │ no
                           ▼                ▼
        ┌──────────────────────────────┐  ┌──────────────────────────────────────┐
        │ concepts + good negations  → │  │ some proposed/negated correct,        │
        │   correct_good_reasoning     │  │ but set incomplete  → partial_correct │
        │ reasoning + state-only conc →│  └───────────────┬──────────────────────┘
        │   correct_good_reasoning     │                  │ otherwise
        │ has concepts → correct_wrong_│                  ▼
        │   reasoning                  │       ┌──────────────────────────┐
        │ has reasoning → correct_good_│       │ concept keywords present? │
        │   reasoning                  │       └────────┬────────┬─────────┘
        │ else → correct_no_reasoning  │            yes │        │ no
        └──────────────────────────────┘                ▼        ▼
                                              wrong_concept    wrong_answer
```

### The 9 classification types

| Type | Example | Meaning |
|---|---|---|
| `greeting` | "Hola, ¿qué tal?" | Social greeting, no exercise content |
| `dont_know` | "No lo sé" | Student does not know how to proceed |
| `closedAnswer` | "Sí" / "No" | Yes/no reply to the tutor's closed question |
| `wrong_answer` | "R5" | Incorrect element selection |
| `correct_no_reasoning` | "R1, R2 y R4" | Right elements, no explanation |
| `correct_wrong_reasoning` | "R1, R2 y R4 porque forman un divisor de tensión" | Right elements justified with a misconception |
| `correct_good_reasoning` | "R1, R2 y R4 porque R3 está en abierto…" | Right elements with sound reasoning |
| `wrong_concept` | "R1 y R2 dado que forman un divisor de tensión" | Wrong elements driven by a specific misconception |
| `partial_correct` | "no pasa por R3" | Correct exclusions / partial proposals, but incomplete |

Output shape: `{ type, resistances[], proposed[], negated[], hasReasoning, concepts[] }`.

---

## 7. Pipeline Routing — Per Classification

Each classification routes to a retrieval strategy and a `decision` label in `ragPipeline.js`. The augmentation is assembled from up to five blocks.

| Classification | Decision | Hybrid search | Knowledge Graph | CRAG | Augmentation blocks |
|---|---|---|---|---|---|
| `greeting` | `no_rag` | — | — | — | none (falls through) |
| `dont_know` | `scaffold` | — | basic concepts (serie/paralelo/cortocircuito) | — | RESPONSE MODE + DOMAIN KNOWLEDGE |
| `closedAnswer` | `acknowledge_diagnostic` | — | — | — | RESPONSE MODE |
| `wrong_answer` | `rag_examples` | ✔ | — | if top score < `MED_THRESHOLD` | RESPONSE MODE + per-element analysis + tone reference |
| `correct_no_reasoning` | `demand_reasoning` | ✔ | — | — | RESPONSE MODE + tone reference |
| `correct_wrong_reasoning` | `correct_concept` | ✔ | by concept | — | RESPONSE MODE + DOMAIN KNOWLEDGE + tone reference |
| `correct_good_reasoning` | `rag_examples` | ✔ | — | — | RESPONSE MODE + tone reference |
| `wrong_concept` | `concept_correction` | ✔ | by concept | — | RESPONSE MODE + DOMAIN KNOWLEDGE + tone reference |
| `partial_correct` | `rag_examples` | ✔ | by concept | — | RESPONSE MODE + per-element analysis + tone reference |

Augmentation blocks:

1. **`[RESPONSE MODE]`** — classification-specific instruction + intermediate feedback phrases (so wrong/partial answers never open with a confirmation).
2. **`[PER-ELEMENT ANALYSIS]`** — internal ground truth per element (correct / wrong / correctly-excluded / wrongly-excluded / missing) — *never* shown to the student.
3. **`[DOMAIN KNOWLEDGE]`** — top knowledge-graph entries (concept, expert reasoning, AC, Socratic question) for reference.
4. **Tone reference** — a retrieved student–tutor example (student side) showing the right pedagogical register.
5. **`[STUDENT HISTORY]`** — the student's top recurring AC errors across exercises.

A `[GUARDRAIL]` reminder is appended at the end of every augmentation.

---

## 8. Hybrid Search + RRF + CRAG

`infrastructure/search/hybridSearch.js` combines keyword and semantic retrieval and fuses the rankings with Reciprocal Rank Fusion.

```
                       Query: "R5 porque está conectada"
                                   │
                     ┌─────────────┴──────────────┐
                     ▼                            ▼
         ┌──────────────────────┐     ┌──────────────────────────┐
         │     BM25 search      │     │     Semantic search       │
         │  in-memory index     │     │  embed query (768d) ──────┼──► LLM /embeddings
         │  per exercise        │     │  ChromaDB exercise_{n}    │     (nomic-embed-text)
         │  k1=1.5  b=0.75      │     │  cosine: 1 − distance     │
         │  top 10              │     │  top 10                   │
         └──────────┬───────────┘     └────────────┬─────────────┘
                    │ ranked list                  │ ranked list
                    └──────────────┬───────────────┘
                                   ▼
                  ┌────────────────────────────────────────────┐
                  │        Reciprocal Rank Fusion (RRF)        │
                  │  score(d) = 1/(K+rank_bm25) + 1/(K+rank_sem)│
                  │  K = 60                                     │
                  │  → docs in both lists rank higher;          │
                  │    no score normalization needed            │
                  └────────────────────┬───────────────────────┘
                                       ▼
                          ┌──────────────────────────┐
                          │  sort desc → top 2        │  (TOP_K_FINAL)
                          └────────────┬─────────────┘
                                       ▼
                  ┌─────────────────────────────────────────────────┐
                  │  CRAG (only when wrong_answer & top < MED_THRESH) │
                  │  1. extract key entities (R\d+ + concepts)        │
                  │  2. normalize to Spanish, join as query           │
                  │  3. re-run hybrid search with the focused query   │
                  └─────────────────────────────────────────────────┘
```

Key parameters (from `infrastructure/llm/config.js`): `TOP_K_RETRIEVAL = 10`, `TOP_K_FINAL = 2`, `RRF_K = 60`, `BM25_K1 = 1.5`, `BM25_B = 0.75`, `HIGH_THRESHOLD = 0.7`, `MED_THRESHOLD = 0.4`. Each stage emits start/end events on the `ragEventBus`.

---

## 9. Guardrail Pipeline

`GuardrailPipeline.validate()` checks the LLM response, repairs it deterministically where it can, and escalates to **at most one** consolidated LLM retry for surviving *critical* violations — all within a time budget (worst case: 2 LLM calls per turn).

```
                       LLM response (non-streaming draft)
                                   │
                                   ▼
        ┌──────────────────────────────────────────────────────────┐
        │ Phase A — run ALL guardrails' check() in parallel          │
        └───────────────────────────┬──────────────────────────────┘
                          violations?│
                     none ───────────┼──────────────► path: primary_ok ✔
                                     ▼ yes
        ┌──────────────────────────────────────────────────────────┐
        │ Phase B — apply each violated guardrail's surgicalFix()    │
        │           (deterministic, no LLM), then re-check           │
        └───────────────────────────┬──────────────────────────────┘
                          violations?│
                     none ───────────┼──────────────► path: surgical_ok ✔
                                     ▼ yes
        ┌──────────────────────────────────────────────────────────┐
        │ Critical gate — keep only CRITICAL_GUARDRAILS violations   │
        │   none critical ─────────────────► path: non_critical_only │
        │   budget < minRetryBudgetMs ─────► path: budget_exhausted  │
        │   no retry hints ────────────────► path: no_retry_hints    │
        └───────────────────────────┬──────────────────────────────┘
                                     ▼
        ┌──────────────────────────────────────────────────────────┐
        │ Phase C — ONE consolidated LLM retry                       │
        │   append all critical retry hints to the system prompt,    │
        │   call the LLM once, then re-check                         │
        └───────────────────────────┬──────────────────────────────┘
                          violations?│
                     none ───────────┼──────────────► path: llm_retry_ok ✔
                                     ▼ yes
        ┌──────────────────────────────────────────────────────────┐
        │ Phase D — surgical fixes on the retry, final re-check      │
        │   clean → path: llm_retry_plus_surgical                    │
        │   else  → path: retry_failed_final_surgical                │
        └──────────────────────────────────────────────────────────┘
```

### The "detected but not blocked" subtlety

A guardrail can **detect** a violation and still let the response through if its id is **not** in `CRITICAL_GUARDRAILS` and no surgical fix applies (it lands on `non_critical_only`). The critical set is:

```
solution_leak · false_confirmation · premature_confirmation · state_reveal
complete_solution · repeated_question · adherence · settled_element_question
```

So always test guardrail behaviour through `GuardrailPipeline.validate()`, not a single guardrail's `check()` in isolation.

### Guardrail catalogue

Each adapter implements the `IGuardrail` port: `id`, `severity`, `check()`, `surgicalFix()`, `buildRetryHint()`.

| Guardrail (`id`) | Detects | Severity | Critical | Default profile |
|---|---|---|---|---|
| `language_drift` | Non-Latin script or wrong-language sentences | high | — | ✔ |
| `solution_leak` | Reveals the correct answer (affirm/leak phrases) | med | ✔ | ✔ |
| `false_confirmation` | Opens by confirming a **wrong** answer | high | ✔ | ✔ |
| `premature_confirmation` | Confirms a correct-but-unjustified answer | high | ✔ | legacy only |
| `complete_solution` | Confirms while the student wrongly named/excluded elements | high | ✔ | ✔ |
| `state_reveal` | Reveals an element's internal state / topology | med | ✔ | ✔ |
| `adherence` | Self-contradiction, multi-question chains, false-premise/accusation | med | ✔ | ✔ |
| `repeated_question` | Repeats the previous Socratic question near-verbatim | med | ✔ | ✔ |
| `settled_element_question` | Re-asks about an element already settled | med | ✔ | ✔ |
| `didactic_explanation` | Lectures the concept instead of questioning | med | — | legacy only |
| `dataset_style` | Markdown / formatting absent from the dataset style | low | — | legacy only |

Profiles are selected by `GUARDRAIL_PROFILE`: **default** (8 hard-safety guardrails; pedagogical-style repairs handled by the `PedagogicalReviewerAgent`) or **legacy** (all 11, for A/B comparison).

---

## 10. Input Security Flow

`HeuristicSecurityAdapter` (the `InputGuardrailAgent`'s service) screens the student message **before** any retrieval or generation. It is deterministic (regex + keyword), no LLM.

```
                       Student message
                            │
                            ▼
              ┌──────────────────────────────┐
              │ prompt-injection patterns?    │  ignore-rules · change-role ·
              │ (8 categories)               │  reassign-role · fake-system ·
              └───────┬──────────────────────┘  reveal-prompt · jailbreak · delimiter
                  yes │                  │ no
                      ▼                  ▼
            block: injection      ┌──────────────────────────────┐
            (localized redirect)  │ domain keyword present?        │
                                  │ (circuit vocabulary whitelist) │
                                  └───────┬──────────────┬─────────┘
                                      yes │              │ no
                                          ▼              ▼
                                        safe     ┌──────────────────────────┐
                                                 │ off-topic patterns?       │
                                                 │ sports/politics/cooking/  │
                                                 │ media/coding              │
                                                 └───────┬──────────┬────────┘
                                                     yes │          │ no
                                                         ▼          ▼
                                             block: off_topic     safe
                                             (localized redirect)
```

Result: `{ safe, category: "safe"|"injection"|"off_topic", matchedPattern?, redirectMessage? }`. On a block the orchestrator persists the redirect and returns immediately.

---

## 11. PostgreSQL Data Model

Eight idempotent SQL migrations (`infrastructure/persistence/postgresql/migrations/`) are run automatically on boot by `runMigrations()`. Conversation turns live in their own `messages` table (replacing the old embedded array), which makes per-message metadata and analytics first-class.

```
   ┌──────────────────┐           ┌──────────────────────┐
   │     usuarios     │           │     ejercicios       │
   │──────────────────│           │──────────────────────│
   │ id (PK)          │           │ id (PK)              │
   │ upv_login UNIQUE │           │ titulo               │
   │ email            │           │ enunciado            │
   │ nombre           │           │ imagen               │
   │ apellidos        │           │ asignatura           │
   │ rol              │           │ concepto             │
   │ grupos[]         │           │ nivel                │
   │ last_login_at    │           │ ca                   │
   └───────┬──────────┘           └──────────┬───────────┘
           │                                 │ 1
           │                                 │
           │                      ┌──────────▼───────────┐
           │                      │   tutor_contexts     │  (1:1 with ejercicios)
           │                      │──────────────────────│
           │                      │ id (PK)              │
           │                      │ ejercicio_id (FK,UQ) │
           │                      │ objetivo · netlist   │
           │                      │ modo_experto         │
           │                      │ ac_refs[]            │
           │                      │ respuesta_correcta[] │
           │                      │ elementos_evaluables[]│
           │                      │ version              │
           │                      └──────────────────────┘
           │                                 │
           │ 1                            1  │
           ▼                                 ▼
   ┌──────────────────────────────────────────────────┐
   │                  interacciones                     │
   │───────────────────────────────────────────────────│
   │ id (PK)                                            │
   │ usuario_id (FK → usuarios)                         │
   │ ejercicio_id (FK → ejercicios)                     │
   │ inicio · fin                                       │
   └───────────────────────┬───────────────────────────┘
                           │ 1
                           ▼ N
   ┌───────────────────────────────────────────────────────────────┐
   │                          messages                              │
   │────────────────────────────────────────────────────────────────│
   │ id (PK) · interaccion_id (FK) · sequence_num                    │
   │ role ('user'|'assistant') · content · timestamp                 │
   │ classification · decision · is_correct_answer · sources_count   │
   │ student_response_ms                                             │
   │ guardrail_solution_leak / false_confirmation /                  │
   │   premature_confirmation / state_reveal  (legacy columns)       │
   │ timing_pipeline_ms · timing_ollama_ms · timing_total_ms         │
   │ concepts (JSONB)            ← migration 007                     │
   │ extra_metadata (JSONB)      ← migration 008 (full guardrail map,│
   │   firstTokenMs, detectedACs, guardrailPath, surgical fixes, …)  │
   │ UNIQUE (interaccion_id, sequence_num)                           │
   └───────────────────────────────────────────────────────────────┘

   ┌──────────────────────────────────┐        ┌──────────────────────┐
   │            resultados            │ 1    N │     error_entries     │
   │──────────────────────────────────│───────►│──────────────────────│
   │ id (PK)                          │        │ id (PK)              │
   │ usuario_id (FK) · ejercicio_id   │        │ resultado_id (FK)    │
   │ interaccion_id (FK)              │        │ etiqueta (AC tag)    │
   │ num_mensajes                     │        │ texto                │
   │ resuelto_a_la_primera            │        └──────────────────────┘
   │ analisis_ia · consejo_ia · fecha │
   └──────────────────────────────────┘

   ┌──────────────────────────────────┐
   │            sessions              │  (connect-pg-simple)
   │──────────────────────────────────│
   │ sid (PK) · sess (JSONB) · expire │
   └──────────────────────────────────┘
```

All foreign keys cascade on delete. Spanish column names (`usuario_id`, `titulo`, `respuesta_correcta`, …) are mapped to the English-named domain entities (`Usuario`, `Ejercicio`, `TutorContext.correctAnswer`, …) inside the `Pg*Repository` adapters, so the domain stays free of database naming.

See [backend.md](backend.md) for the full schema columns, entity fields, repository ports, and HTTP routes, and [rag-system.md](rag-system.md) for the domain services in depth.
