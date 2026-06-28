# Backend Architecture

The backend is a Node.js / Express 5 server built with a **hexagonal architecture** (ports & adapters). It exposes the API for the virtual tutor: exercise management, authenticated conversations, the Socratic chat pipeline (agent orchestrator + RAG + guardrails), progress analytics, result analysis and data export.

> The chat model is referred to as **qwen2.5**. The real-time pipeline monitor is out of scope for this documentation.

---

## Table of Contents

1. [Hexagonal Layout](#hexagonal-layout)
2. [Entry Point](#entry-point)
3. [Dependency-Injection Container](#dependency-injection-container)
4. [Domain Entities](#domain-entities)
5. [Repository Ports](#repository-ports)
6. [PostgreSQL Schema](#postgresql-schema)
7. [API Routes](#api-routes)
8. [Authentication & Authorization](#authentication--authorization)
9. [The Chat Middleware Chain](#the-chat-middleware-chain)
10. [SSE Streaming](#sse-streaming)
11. [Static Files & SPA](#static-files--spa)
12. [Environment Variables](#environment-variables)

---

## Hexagonal Layout

```
backend/src/
├── index.js                      # Server bootstrap (middleware, routes, listen, migrations)
├── container.js                  # Dependency-injection composition root
│
├── config/
│   ├── environment.js            # All env vars, validated, single source of truth
│   └── database.js               # PostgreSQL connection helper
│
├── domain/                       # ── CORE: no framework imports ──
│   ├── entities/                 # Usuario, Ejercicio, TutorContext, Interaccion,
│   │                             #   Message, MessageMetadata, Resultado, ErrorEntry
│   ├── ports/
│   │   ├── repositories/         # IUsuarioRepository, IEjercicioRepository,
│   │   │                         #   IInteraccionRepository, IMessageRepository,
│   │   │                         #   IResultadoRepository
│   │   └── services/             # ILlmService, IEmbeddingService, IVectorSearchService,
│   │                             #   IGuardrail, ISecurityService
│   ├── agents/                   # orchestrator.js + 10 agents + base/
│   └── services/                 # rag/ (classifier, pipeline, guardrails, cumulativeAnswer,
│                                 #   elementStates), text/ utilities, GuardrailPipeline,
│                                 #   promptBuilder, languageManager, historySummarizer,
│                                 #   acRegistry, kgRegistry
│
├── infrastructure/               # ── ADAPTERS: implement domain ports ──
│   ├── persistence/postgresql/   # PgConnection + 5 Pg*Repository + migrations/*.sql
│   ├── llm/                      # OllamaLlmAdapter, PoliGptLlmAdapter, config.js, logger.js
│   ├── guardrails/               # 11 guardrail adapters + index.js (profiles)
│   ├── search/                   # bm25.js, hybridSearch.js, knowledgeGraph.js
│   ├── vectordb/                 # chromaClient.js, embeddings.js, ingest.js
│   ├── security/                 # HeuristicSecurityAdapter.js
│   ├── events/                   # ragEventBus.js, jsonAuditLogger.js, pipelineDebugLogger.js
│   └── auth/                     # roles.js
│
├── interfaces/
│   ├── http/
│   │   ├── middleware/           # orchestratorMiddleware, ragMiddleware, authMiddleware,
│   │   │                         #   publicRoutes
│   │   └── routes/               # auth, ejercicios, interacciones, resultados, progreso,
│   │                             #   export, usuarios, ollamaChatRoutes
│   └── sse/                      # event-streaming helpers
│
├── data/                         # datasets, knowledge-graph, exercise contexts, ACs
├── prompts/                      # prompt_base.md
└── static/                       # exercise circuit images
```

> **Legacy code, kept on purpose.** `backend/src/rag/` and `backend/src/utils/promptBuilder.js` are the pre-refactor implementations. They are disconnected from the default flow but retained for A/B comparison.

---

## Entry Point

**File:** `backend/src/index.js`

Startup order:

1. **Guard** — if `DEV_BYPASS_AUTH=true` while `NODE_ENV=production`, abort (refuse to start insecurely).
2. **Express app + `trust proxy`** (the server runs behind nginx in production).
3. **CORS** — allow `FRONTEND_BASE_URL` (default `http://localhost:5173`) with credentials.
4. **JSON body parser.**
5. **Static files** at `/static/` (exercise images).
6. **Session middleware** — `express-session` backed by `connect-pg-simple` (PostgreSQL `sessions` table); cookie `httpOnly`, `sameSite=lax`, 24 h `maxAge`, `secure` in production.
7. **Health check** at `/api/health`.
8. **Auth router** mounted, then **`globalAuth`** applied to `/api/*` (public routes and the export token bypass it).
9. **API routes mounted** (see [API Routes](#api-routes)). The chat endpoint is wired as `orchestratorMiddleware → ragMiddleware → ollamaChatRoutes`.
10. **SPA serving** — the built frontend from `frontend/dist` with an SPA fallback for non-API paths.
11. **`server.listen()`** on `PORT` (`0.0.0.0`).
12. **`container.initialize()`** — async, non-blocking; logs whether `USE_ORCHESTRATOR` is on. Runs DB migrations and wires all adapters.
13. **LLM warmup** — async, non-blocking; pings the provider to pre-load the model (skipped unless the provider is Ollama).
14. **WebSocket setup** for internal pipeline observability.

---

## Dependency-Injection Container

**File:** `backend/src/container.js`

The container is the only place where concrete adapters are constructed and bound to domain ports. `initialize()`:

1. Validates `DATABASE_TYPE === "postgresql"` (throws otherwise).
2. Creates the PostgreSQL pool, runs migrations, and builds the five `Pg*Repository` adapters.
3. Selects the LLM adapter from `LLM_PROVIDER` (`poligpt` → `PoliGptLlmAdapter`, else `OllamaLlmAdapter`).
4. Builds `securityService = HeuristicSecurityAdapter`.
5. Loads the knowledge graph and per-exercise BM25 indices into memory; checks ChromaDB health (`CHROMA_REQUIRED`).
6. Builds `guardrailPipeline = new GuardrailPipeline({ guardrails: createGuardrailsForProfile(GUARDRAIL_PROFILE), llmService, budgetMs, minRetryBudgetMs, emitEvent })`.
7. Builds `historySummarizer` (or a `NullHistorySummarizer`).
8. Builds the agent registry and the `TutoringOrchestrator`.
9. Sets `_initialized = true` — which is what `orchestratorMiddleware` checks before handling a request.

Exposed members include: `usuarioRepo`, `ejercicioRepo`, `interaccionRepo`, `messageRepo`, `resultadoRepo`, `llmService`, `securityService`, `guardrailPipeline`, `historySummarizer`, `agents`, `orchestrator`, `kgConceptPatterns`, `_initialized`.

---

## Domain Entities

Plain classes under `domain/entities/` — no ORM, no decorators. The `Pg*Repository` adapters map database rows (Spanish columns) into these (English fields).

### Usuario
`id`, `upvLogin`, `email`, `firstName`, `lastName`, `nationalId`, `groups[]`, `role` (`alumno`|`profesor`|`admin`), `lastLoginAt`, `createdAt`, `updatedAt`.

### Ejercicio
`id`, `title`, `statement`, `image`, `subject`, `concept`, `level`, `ac`, `tutorContext` (`TutorContext`|null), `createdAt`, `updatedAt`.

### TutorContext
`objective`, `netlist`, `expertMode`, `acRefs[]`, `correctAnswer[]`, `evaluableElements[]`, `version`.

- `correctAnswer` — the set of correct elements (e.g. `["R1","R2","R4"]`); drives classification and guardrails.
- `evaluableElements` — all elements that count as a valid answer for the exercise.
- `netlist` — circuit topology; the prompt builder parses it into an internal topology summary.

### Interaccion
`id`, `userId`, `exerciseId`, `startTime`, `endTime`, `createdAt`. One conversation session for a (user, exercise) pair. Messages live in their own table.

### Message
`id`, `interactionId`, `sequenceNum`, `role` (`user`|`assistant`), `content`, `timestamp`, `metadata` (`MessageMetadata`|null).

### MessageMetadata
Attached to assistant messages produced by the pipeline:
`classification`, `decision`, `isCorrectAnswer`, `sourcesCount`, `studentResponseMs`, `concepts[]`, `guardrails` (per-guardrail booleans), `timing` (`pipelineMs`, `ollamaMs`, `totalMs`, `firstTokenMs`), `detectedACs[]`, `guardrailPath`, `guardrailLlmRetries`, `guardrailSurgicalFixes[]`, `guardrailSurgicalFixDetails[]`, `llmResponseOriginal`, `fallbackUsed`, `deterministicFinish`.

### Resultado
`id`, `userId`, `exerciseId`, `interactionId`, `messageCount`, `solvedOnFirstAttempt`, `aiAnalysis`, `aiAdvice`, `date`, `errors[]` (`ErrorEntry`).

### ErrorEntry
`id`, `label` (the AC tag), `text`.

---

## Repository Ports

Interfaces under `domain/ports/repositories/`. The PostgreSQL adapters implement them; the domain depends only on the interface.

| Port | Key methods |
|---|---|
| **IUsuarioRepository** | `findById`, `findByUpvLogin`, `upsertByUpvLogin`, `create`, `updateById`, `findAll`, `findByIds` |
| **IEjercicioRepository** | `findById`, `findAll`, `create`, `updateById`, `deleteById`, `findOneByConcept`, `findByIds` |
| **IInteraccionRepository** | `findById`, `create`, `deleteById`, `exists`, `existsForUser`, `updateEndTime`, `findByUserId`, `findLatestByExerciseAndUser`, `findRecent`, `findByFilter` |
| **IMessageRepository** | `appendMessage`, `getLastMessages`, `getAllMessages`, `countConsecutiveFromEnd`, `countAssistantMessages`, `getLastAssistantMessages`, `getLastMessage`, `getAcEvidenceByUserId` |
| **IResultadoRepository** | `create`, `findByUserId`, `findByUserIdWithExercise`, `findCompletedExerciseIds`, `findByFilter`, `getErrorTagsByUserId` |

There are also **service ports** under `domain/ports/services/`: `ILlmService` (with a `BudgetExhaustedError` sentinel), `IEmbeddingService`, `IVectorSearchService`, `IGuardrail`, `ISecurityService`.

---

## PostgreSQL Schema

Eight idempotent migrations in `infrastructure/persistence/postgresql/migrations/`, executed in filename order by `runMigrations()` on boot.

| # | File | Creates / changes |
|---|---|---|
| 001 | `create_usuarios` | `usuarios` (+ indexes on `upv_login`, `rol`) |
| 002 | `create_ejercicios` | `ejercicios` + `tutor_contexts` (1:1) |
| 003 | `create_interacciones` | `interacciones` |
| 004 | `create_messages` | `messages` (replaces the old embedded conversation array) |
| 005 | `create_resultados` | `resultados` + `error_entries` |
| 006 | `create_sessions` | `sessions` (for `connect-pg-simple`) |
| 007 | `add_concepts_to_messages` | `messages.concepts JSONB` (+ GIN index) |
| 008 | `add_extra_metadata_to_messages` | `messages.extra_metadata JSONB` (+ GIN index) |

Selected columns:

```sql
usuarios(id PK, upv_login UNIQUE, loguin_usuario, email, nombre, apellidos, dni,
         grupos TEXT[], rol DEFAULT 'alumno', last_login_at, created_at, updated_at)

ejercicios(id PK, titulo, enunciado, imagen, asignatura, concepto, nivel, ca,
           created_at, updated_at)

tutor_contexts(id PK, ejercicio_id FK UNIQUE → ejercicios ON DELETE CASCADE,
               objetivo, netlist, modo_experto, ac_refs TEXT[],
               respuesta_correcta TEXT[], elementos_evaluables TEXT[], version)

interacciones(id PK, usuario_id FK → usuarios, ejercicio_id FK → ejercicios,
              inicio, fin, created_at)

messages(id PK, interaccion_id FK → interacciones, sequence_num,
         role CHECK ('user'|'assistant'), content, timestamp,
         classification, decision, is_correct_answer, sources_count, student_response_ms,
         guardrail_solution_leak, guardrail_false_confirmation,
         guardrail_premature_confirmation, guardrail_state_reveal,
         timing_pipeline_ms, timing_ollama_ms, timing_total_ms,
         concepts JSONB, extra_metadata JSONB,
         UNIQUE(interaccion_id, sequence_num))

resultados(id PK, usuario_id FK, ejercicio_id FK, interaccion_id FK,
           num_mensajes, resuelto_a_la_primera, analisis_ia, consejo_ia, fecha)

error_entries(id PK, resultado_id FK → resultados ON DELETE CASCADE, etiqueta, texto)

sessions(sid PK, sess JSONB, expire)
```

The four `guardrail_*` boolean columns are legacy (the first four guardrails); the full guardrail map and newer signals (`firstTokenMs`, `detectedACs`, `guardrailPath`, surgical fixes, `fallbackUsed`, `deterministicFinish`) are stored in `extra_metadata`.

---

## API Routes

All `/api/*` routes require an authenticated session except the public whitelist and the export token (see [Authentication](#authentication--authorization)).

### Auth — `/api/auth`
`GET /cas/login` · `GET /cas/callback` · `GET /me` · `GET /logout` · `POST /dev-login` · `POST /dev-logout`.

### Exercises — `/api/ejercicios`
`GET /` (list) · `GET /:id` · `POST /` · `PUT /:id` · `DELETE /:id`. Create/update/delete require `profesor`/`admin`. `GET` is on the public whitelist.

### Interactions — `/api/interacciones`
`GET /mine` · `GET /user/:userId` (ownership-gated) · `GET /byExercise/:exerciseId` · `GET /byExerciseAndUser/:exerciseId/:userId` (gated) · `GET /:id` (full conversation) · `DELETE /:id` (owner).

### Chat — `/api/ollama/chat/stream`
The Socratic chat endpoint. Served by the middleware chain (`orchestratorMiddleware → ragMiddleware → ollamaChatRoutes`). Request body:

```json
{ "userId": "…", "exerciseId": "…", "userMessage": "…", "interaccionId": "… (optional)" }
```

Response: an SSE stream. `ollamaChatRoutes` also exposes `POST /warmup`, `GET /health`, and `POST /chat/start-exercise`.

### Results — `/api/resultados`
`GET /completed` · `GET /completed/:userId` (gated) · `POST /finalizar`. `/finalizar` sends the conversation to the LLM (`temperature 0`, JSON output) to classify the student's errors into a **closed list of AC ids** (from `data/alternative_conceptions.json`, max 3), then stores the analysis and advice.

### Progress — `/api/progreso`
`GET /` (current user) · `GET /:userId` (gated). Returns average messages per interaction, efficiency per concept, a weekly summary, the last session's analysis/advice, the top recurring AC errors, and a next-exercise recommendation.

### Export — `/api/export`
Router-level `requireRole("profesor","admin")`. `GET /interacciones` and `GET /resultados`, both JSON or `?format=csv`, with optional `userId`, `exerciseId`, `from`, `to` filters. The interactions CSV flattens one row per message, including classification, decision, guardrail flags, detected ACs and timing.

### Users — `/api/usuarios`
Admin-only: `POST /` · `GET /` · `GET /:id` · `PUT /:id`.

---

## Authentication & Authorization

**Files:** `interfaces/http/routes/auth.js`, `interfaces/http/middleware/authMiddleware.js`, `publicRoutes.js`, `infrastructure/auth/roles.js`.

Two sign-in modes:

1. **CAS OAuth2** (`simple-oauth2`) — the university SSO. Flow: `/cas/login` redirects to CAS → `/cas/callback` exchanges the code, fetches the profile, `upsertByUpvLogin`, and sets the session.
2. **Dev bypass** (`DEV_BYPASS_AUTH=true`) — `POST /dev-login` creates/finds a known user and sets the session. The server refuses to start if this is on in production.

**`globalAuth`** protects `/api/*`:
- **Public routes** (`publicRoutes.js`) bypass it: health, auth endpoints, and the exercise reads (`GET /api/ejercicios`, `GET /api/ejercicios/:id`).
- **Export token** bypass: a request to `/api/export/*` with `?token=` matching `EXPORT_TOKEN` is treated as `profesor`.
- Otherwise a valid session is required (`401` if missing). The user id and role are attached to the request.

**`requireRole(...roles)`** guards privileged routes (`403` if the role is insufficient). **`canAccessUserData(resourceUserId, req)`** allows access when the requester owns the resource or is `profesor`/`admin`.

Sessions are stored in PostgreSQL, so they survive restarts.

---

## The Chat Middleware Chain

`POST /api/ollama/chat/stream` is offered to three handlers in order; the first that accepts it serves the whole response, the rest are skipped via `next()`:

```javascript
app.use("/api/ollama/chat/stream", orchestratorMiddleware); // USE_ORCHESTRATOR=1 + container ready
app.use("/api/ollama/chat/stream", ragMiddleware);          // legacy linear pipeline (A/B)
app.use("/api/ollama", ollamaChatRoutes);                   // plain LLM fallback
```

- **orchestratorMiddleware** handles the request only if `USE_ORCHESTRATOR=1`, the container is initialized, and inputs validate. Greetings/off-topic take a deterministic fast path; everything else goes through `container.orchestrator.process()`.
- **ragMiddleware** is the legacy linear pipeline (classify → security → retrieve → LLM → guardrails → persist), kept connected as a fallback and for comparison. It handles the request unless `RAG_ENABLED=false`, it isn't ready, or the turn classifies as a greeting (`no_rag`).
- **ollamaChatRoutes** is a plain LLM call with no RAG and no guardrails — the last resort.

See [rag-system.md](rag-system.md) for what each path does internally.

---

## SSE Streaming

The chat endpoint streams via **Server-Sent Events**.

1. Headers: `Content-Type: text/event-stream; charset=utf-8`, `Cache-Control: no-cache, no-transform`, `Connection: keep-alive`, `X-Accel-Buffering: no`.
2. Open with a comment frame `: ok`.
3. A heartbeat `: ping` every ~15 s keeps the connection alive through proxies.
4. Data frames are JSON: `{ interaccionId?, chunk?, phase?, status?, done?, fullText?, timing?, error? }`.
5. Close with `data: [DONE]`.

The `<END_EXERCISE>` token within a response tells the frontend the exercise is complete.

**Why non-streaming LLM calls for guardrails?** The pipeline calls the LLM in non-streaming mode so the full draft can be inspected before sending — a streamed token can't be retracted once it leaks the solution. The orchestrator can optionally stream tokens for latency (`ORCHESTRATOR_STREAM_TOKENS`) and then emit a correction frame if a guardrail rewrites the text.

**Why SSE over WebSocket for chat?** Chat is one-way (server → client) request/response, SSE is HTTP-native (passes through nginx without special config), and the browser's `EventSource` reconnects automatically.

---

## Static Files & SPA

- Exercise circuit images are served from `backend/src/static/` at `/static/`.
- The built frontend (`frontend/dist`) is served with immutable caching for hashed assets, no-cache for `index.html`, and an SPA fallback so any non-`/api/`, non-`/static/` path returns `index.html`.

---

## Environment Variables

All configuration is read through `config/environment.js` and `infrastructure/llm/config.js`. Copy `backend/.env.example` to `backend/.env`.

### Database & server

| Variable | Default | Description |
|---|---|---|
| `DATABASE_TYPE` | `postgresql` | Only `postgresql` is supported |
| `PG_CONNECTION_STRING` | — | PostgreSQL DSN (required) |
| `PORT` | `3001` | HTTP port |
| `NODE_ENV` | `development` | `production` enables secure cookies |
| `SESSION_SECRET` | — | Session signing secret |
| `SERVER_BASE_URL` / `FRONTEND_BASE_URL` | `""` | Base URLs (CORS, redirects) |

### LLM provider

| Variable | Default | Description |
|---|---|---|
| `LLM_PROVIDER` | `ollama` | `ollama` or `poligpt` |
| `LLM_MODE` | `local` | `upv` selects the UPV Ollama URL, else local |
| `OLLAMA_API_URL_UPV` / `OLLAMA_API_URL_LOCAL` | — / `http://127.0.0.1:11434` | Ollama endpoints |
| `OLLAMA_MODEL` | qwen2.5 | Chat model |
| `OLLAMA_TEMPERATURE` | `0.4` | Sampling temperature |
| `OLLAMA_NUM_CTX` | `8192` | Context window (LLM config) |
| `OLLAMA_NUM_PREDICT` | `220` | Max tokens (LLM config) |
| `OLLAMA_KEEP_ALIVE` | `60m` | Keep the model resident |
| `OLLAMA_TIMEOUT_MS` / `OLLAMA_STREAM_MAX_MS` | `60000` / `1800000` | Request / stream timeouts |
| `OLLAMA_CLASSIFIER_MODEL` | qwen2.5 | Model for the result-finalization classifier |
| `POLIGPT_BASE_URL` / `POLIGPT_API_KEY` / `POLIGPT_MODEL` | `https://api.poligpt.upv.es` / — / qwen2.5 | PoliGPT settings |
| `EMBEDDING_PROVIDER` / `POLIGPT_EMBED_MODEL` | — / `nomic-embed-text` | Embedding provider/model |

### RAG, search & orchestrator

| Variable | Default | Description |
|---|---|---|
| `RAG_ENABLED` | `true` | Disable the legacy RAG middleware with `false` |
| `CHROMA_URL` | `http://localhost:8000` | ChromaDB endpoint |
| `CHROMA_REQUIRED` | `true` | Fail startup if collections are empty |
| `HISTORY_MAX_MESSAGES` | `20` | Conversation window sent to the LLM |
| `USE_ORCHESTRATOR` | `0` | `1` enables the 10-agent orchestrator path |
| `ORCHESTRATOR_BUDGET_MS` | `30000` | Total per-request budget (split per stage) |
| `ORCHESTRATOR_STREAM_TOKENS` | `1` | `0` = single chunk after guardrails |
| `GUARDRAIL_PROFILE` | `default` | `default` (8) or `legacy` (11) |
| `GUARDRAIL_BUDGET_MS` / `GUARDRAIL_MIN_RETRY_BUDGET_MS` | — / — | Guardrail pipeline budgets |

### Auth & observability

| Variable | Default | Description |
|---|---|---|
| `CAS_BASE_URL`, `OAUTH_CLIENT_ID`, `OAUTH_CLIENT_SECRET`, `OAUTH_REDIRECT_URI`, `OAUTH_SCOPES` | — | CAS OAuth2 |
| `DEV_BYPASS_AUTH` | `false` | Dev sign-in bypass (forbidden in production) |
| `EXPORT_TOKEN` | — | Token for `/api/export/*?token=` |
| `AUDIT_LOG` / `AUDIT_LOG_DIR` | `0` / `logs/audit` | JSONL audit logging |
| `DEBUG_PIPELINE`, `DEBUG_OLLAMA`, `DEBUG_DUMP_CONTEXT`, `DEBUG_DUMP_PATH` | `0` / `0` / `0` / `""` | Tracing & prompt dumps |

For the deep dive into the agent orchestrator and every domain service, see [rag-system.md](rag-system.md). For diagrams, see [architecture-diagrams.md](architecture-diagrams.md).
