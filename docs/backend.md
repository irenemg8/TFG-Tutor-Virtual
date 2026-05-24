# Backend Architecture

The backend is a Node.js/Express server that provides the API for the virtual tutor application. It handles exercise management, user interactions, chat with the LLM (augmented by the RAG system), progress tracking, and result analysis.

---

## Table of Contents

1. [Project Structure](#project-structure)
2. [Entry Point](#entry-point)
3. [Data Models](#data-models)
4. [API Routes](#api-routes)
5. [Authentication](#authentication)
6. [SSE Streaming](#sse-streaming)
7. [RAG Middleware Integration](#rag-middleware-integration)
8. [Static File Serving](#static-file-serving)
9. [Environment Variables](#environment-variables)

---

## Project Structure

```
backend/
├── src/
│   ├── index.js                  # Server entry point
│   ├── authRoutes.js             # CAS + demo authentication
│   ├── utils/
│   │   ├── promptBuilder.js      # System prompt construction
│   │   └── languageManager.js    # Multi-language support (es, val, en)
│   ├── models/
│   │   ├── ejercicio.js          # Exercise schema
│   │   ├── interaccion.js        # Conversation schema
│   │   ├── resultado.js          # Exercise results schema
│   │   └── usuario.js            # User schema
│   ├── routes/
│   │   ├── ejercicios.js         # Exercise CRUD
│   │   ├── interacciones.js      # Conversation management
│   │   ├── ollamaChatRoutes.js   # LLM chat (non-RAG fallback)
│   │   ├── resultados.js         # Exercise results + AC classification
│   │   ├── progresoRoutes.js     # Progress analytics
│   │   ├── exportRoutes.js       # Data export (JSON/CSV)
│   │   └── usuarios.js           # User CRUD
│   ├── rag/                      # RAG system (see rag-system.md)
│   │   ├── config.js
│   │   ├── ragMiddleware.js
│   │   ├── ragPipeline.js
│   │   ├── ... (12 modules total)
│   └── static/                   # Exercise images
├── logs/
│   └── rag/                      # JSONL interaction logs
├── tests/
│   ├── verifyRag.js              # RAG verification script
│   └── VERIFICATION_REPORT.md
├── .env                          # Environment configuration
└── package.json
```

---

## Entry Point

**File:** `backend/src/index.js`

The server initializes in this order:

1. **Load environment variables** from `.env` using `dotenv`
2. **Configure CORS** to accept requests from both the frontend (`localhost:5173`) and the workflow monitor (`localhost:5174`)
3. **Set up middleware**: JSON body parser, static file serving for exercise images
4. **Connect to MongoDB Atlas** via Mongoose
5. **Configure sessions** with `express-session` + `connect-mongo` (sessions stored in MongoDB)
6. **Mount routes** under `/api/` prefixes
7. **Mount RAG middleware** — intercepts chat requests before the standard handler
8. **Serve the frontend build** as static files with SPA fallback
9. **Start HTTP server** on port 3000
10. **Set up WebSocket server** for the workflow monitor
11. **Warm up Ollama** with a minimal request to pre-load the model into memory

### Route Mounting Order

The RAG middleware is mounted **before** the standard chat routes:

```javascript
app.use("/api/ollama", ragMiddleware);    // RAG intercepts first
app.use("/api/ollama", ollamaChatRoutes); // Fallback if RAG doesn't handle
```

This means every chat request goes through the RAG middleware first. If the RAG decides to handle it (non-greeting, valid exercise), it responds directly. If not (greetings, RAG disabled, invalid inputs), it calls `next()` and the standard `ollamaChatRoutes` handler takes over.

---

## Data Models

### Ejercicio (Exercise)

**File:** `backend/src/models/ejercicio.js`

Represents a circuit analysis exercise that students solve.

| Field | Type | Description |
|---|---|---|
| `titulo` | String (required) | Exercise title, e.g., "Ejercicio 1" |
| `enunciado` | String (required) | Problem statement describing the circuit |
| `imagen` | String | Filename of the circuit diagram image |
| `asignatura` | String (required) | Subject name |
| `concepto` | String (required) | Main concept being tested |
| `nivel` | Number (required) | Difficulty level |
| `tutorContext` | Object | Nested object with tutor-specific data |
| `tutorContext.objetivo` | String | Learning objective for this exercise |
| `tutorContext.netlist` | String | Circuit netlist description |
| `tutorContext.modoExperto` | String | Expert mode instructions |
| `tutorContext.ac_refs` | [String] | References to relevant alternative conceptions |
| `tutorContext.respuestaCorrecta` | [String] | Correct answer as array of resistance names, e.g., `["R1", "R2", "R4"]` |
| `tutorContext.version` | Number | Prompt version for tracking changes |

### Interaccion (Interaction)

**File:** `backend/src/models/interaccion.js`

Stores the complete conversation between a student and the tutor for one exercise session.

| Field | Type | Description |
|---|---|---|
| `usuario_id` | ObjectId (ref: Usuario) | The student |
| `ejercicio_id` | ObjectId (ref: Ejercicio) | The exercise being worked on |
| `inicio` | Date | Conversation start time |
| `fin` | Date | Last activity time (updated on each message) |
| `conversacion` | [Message] | Array of messages in chronological order |

Each message in the `conversacion` array has:

| Field | Type | Description |
|---|---|---|
| `role` | String (enum: user, assistant) | Who sent the message |
| `content` | String | The message text |
| `timestamp` | Date | When the message was sent |
| `metadata` | Object (default: null) | Per-message metadata (present on assistant messages from the RAG pipeline) |

The `metadata` object (when present) contains:

| Field | Type | Description |
|---|---|---|
| `classification` | String | Query classification type (e.g., "correct_no_reasoning") |
| `decision` | String | Pipeline routing decision (e.g., "rag_examples", "deterministic_finish") |
| `guardrails.solutionLeak` | Boolean | Whether the solution leak guardrail triggered |
| `guardrails.falseConfirmation` | Boolean | Whether the false confirmation guardrail triggered |
| `guardrails.prematureConfirmation` | Boolean | Whether the premature confirmation guardrail triggered |
| `guardrails.stateReveal` | Boolean | Whether the state reveal guardrail triggered |
| `timing.pipelineMs` | Number | RAG pipeline duration in milliseconds |
| `timing.ollamaMs` | Number | LLM call duration in milliseconds |
| `timing.totalMs` | Number | Total request duration in milliseconds |
| `sourcesCount` | Number | Number of retrieved documents used |
| `isCorrectAnswer` | Boolean | Whether the student's answer was correct |
| `studentResponseMs` | Number | Time since last assistant message (on user messages only) |

### Resultado (Result)

**File:** `backend/src/models/resultado.js`

Captures the final analysis when a student completes (or abandons) an exercise.

| Field | Type | Description |
|---|---|---|
| `usuario_id` | ObjectId (ref: Usuario) | The student |
| `ejercicio_id` | ObjectId (ref: Ejercicio) | The exercise |
| `interaccion_id` | ObjectId (ref: Interaccion) | The associated conversation |
| `respuestaFinal` | String | The student's final answer |
| `esCorrecta` | Boolean | Whether the final answer was correct |
| `analisis` | String | LLM-generated analysis of the student's performance |
| `consejo` | String | LLM-generated personalized advice |
| `errores` | [Object] | Array of identified errors, each with `etiqueta` (error tag/AC name), `descripcion` (description), and `consejo` (advice) |
| `puntuacion` | Number | Score (0-10) |
| `tiempoTotal` | Number | Total time spent in seconds |
| `numIntercambios` | Number | Number of message exchanges |
| `completado` | Boolean | Whether the exercise was fully completed |

### Usuario (User)

**File:** `backend/src/models/usuario.js`

User account information.

| Field | Type | Description |
|---|---|---|
| `upvLogin` | String (unique) | University login identifier |
| `email` | String (unique) | Email address |
| `nombre` | String | Display name |
| `rol` | String (enum: alumno, profesor, admin) | User role |

---

## API Routes

### Exercises — `/api/ejercicios`

**File:** `backend/src/routes/ejercicios.js`

Standard CRUD for exercises:

| Method | Path | Description |
|---|---|---|
| `GET /` | List all exercises (sorted by `_id`) |
| `POST /` | Create a new exercise |
| `GET /:id` | Get a single exercise by ID |
| `PUT /:id` | Update an exercise |
| `DELETE /:id` | Delete an exercise |

### Interactions — `/api/interacciones`

**File:** `backend/src/routes/interacciones.js`

Manages conversation sessions. All routes require authentication.

| Method | Path | Description |
|---|---|---|
| `GET /` | List all interactions (admin/profesor only) |
| `GET /usuario/:userId` | List all interactions for a specific user |
| `GET /usuario/:userId/ejercicio/:ejercicioId` | Get interaction for a specific user + exercise |
| `POST /` | Create a new interaction |
| `PUT /:id` | Update an interaction |
| `DELETE /:id` | Delete an interaction |

### Chat — `/api/ollama/chat/stream`

**File:** `backend/src/routes/ollamaChatRoutes.js`

The main chat endpoint. This is the **fallback handler** — the RAG middleware intercepts most requests before they reach this route.

**Request body:**
```json
{
  "userId": "MongoDB ObjectId",
  "exerciseId": "MongoDB ObjectId",
  "userMessage": "Student's message text",
  "interaccionId": "MongoDB ObjectId (optional, for continuing a conversation)"
}
```

**Response:** Server-Sent Events (SSE) stream.

This handler:
1. Loads or creates the interaction document
2. Saves the user message to MongoDB
3. Checks for deterministic correct answer (without RAG)
4. Builds the system prompt from exercise context
5. Loads conversation history
6. Calls Ollama with streaming enabled
7. Forwards chunks to the client via SSE
8. Saves the assistant response to MongoDB

### Results — `/api/resultados`

**File:** `backend/src/routes/resultados.js`

Handles exercise completion and result analysis.

| Method | Path | Description |
|---|---|---|
| `POST /finalizar` | Finalize an exercise — triggers LLM analysis of the conversation to identify errors and alternative conceptions |
| `GET /usuario/:userId` | Get all results for a user |
| `GET /usuario/:userId/ejercicio/:ejercicioId` | Get result for a specific exercise |

The `/finalizar` endpoint is notable because it uses the LLM (Ollama) to analyze the student's conversation and classify their errors into Alternative Conception categories. It sends the conversation history to the LLM with a structured JSON output prompt, asking it to identify misconceptions, provide scores, and generate personalized advice.

### Progress — `/api/progreso`

**File:** `backend/src/routes/progresoRoutes.js`

Analytics endpoint that computes student progress metrics.

| Method | Path | Description |
|---|---|---|
| `GET /:userId` | Get comprehensive progress data for a student |

Returns:
- **Per-exercise stats**: completion status, score, time spent, error count, efficiency rating
- **Streak data**: current consecutive day streak, longest streak ever
- **Aggregate metrics**: total exercises, average score, total time, overall efficiency
- **Personalized recommendations**: Generated based on identified weak areas

### Export — `/api/export`

**File:** `backend/src/routes/exportRoutes.js`

Data export endpoints for interactions and results. Supports JSON and CSV formats with filtering.

| Method | Path | Description |
|---|---|---|
| `GET /interacciones` | Export interactions. One row per message in CSV mode, with full metadata |
| `GET /resultados` | Export exercise results with error analysis and scores |

**Query parameters** (all optional):

| Parameter | Description | Example |
|---|---|---|
| `userId` | Filter by student (MongoDB ObjectId) | `64a1b2c3d4e5f6a7b8c9d0e1` |
| `exerciseId` | Filter by exercise (MongoDB ObjectId) | `64a1b2c3d4e5f6a7b8c9d0e2` |
| `from` | Start date (ISO 8601) | `2024-01-01` |
| `to` | End date (ISO 8601) | `2024-12-31` |
| `format` | Output format: `json` (default) or `csv` | `csv` |

The CSV format for interactions flattens one row per message, including: session start/end, user info, message index, role, content, classification, decision, guardrail violations, timing breakdown (pipelineMs, ollamaMs, totalMs), sources count, and student response timing.

### Users — `/api/usuarios`

**File:** `backend/src/routes/usuarios.js`

Standard CRUD for user accounts:

| Method | Path | Description |
|---|---|---|
| `GET /` | List all users |
| `POST /` | Create a new user |
| `GET /:id` | Get user by ID |
| `PUT /:id` | Update user |
| `DELETE /:id` | Delete user |

---

## Authentication

**File:** `backend/src/authRoutes.js`

The system supports two authentication modes:

1. **CAS (Central Authentication Service)** — OAuth2-based SSO used by the university. The flow: redirect to CAS login → receive authorization code → exchange for token → fetch user info → create or update local user → set session.

2. **Demo mode** (`DEV_BYPASS_AUTH=true`) — For development, authentication can be bypassed. A demo endpoint creates or finds a user with a known upvLogin and sets the session directly.

Sessions are stored in MongoDB via `connect-mongo`, so they persist across server restarts.

The `requireAuth` middleware checks for a valid session and can be applied to any route that needs protection.

---

## SSE Streaming

The chat endpoint uses **Server-Sent Events (SSE)** to stream the LLM response to the frontend in real time.

### How It Works

1. The server sets SSE headers:
   ```
   Content-Type: text/event-stream; charset=utf-8
   Cache-Control: no-cache, no-transform
   Connection: keep-alive
   X-Accel-Buffering: no
   ```

2. Each data event is sent as:
   ```
   data: {"chunk": "partial response text"}\n\n
   ```

3. The stream ends with:
   ```
   data: [DONE]\n\n
   ```

4. A heartbeat (`: ping\n\n`) is sent every 15 seconds to keep the connection alive through proxies and load balancers.

### Why SSE Over WebSocket for Chat?

- **Simpler**: SSE is a one-way channel (server → client), which is exactly what streaming a chat response needs. WebSocket's bidirectional capability is unnecessary for this use case.
- **HTTP-native**: SSE works over standard HTTP, so it passes through proxies, CDNs, and reverse proxies (Nginx) without special configuration.
- **Automatic reconnection**: The browser's `EventSource` API handles reconnection automatically if the connection drops.
- **Request/response model**: Each chat message is a separate HTTP POST request that returns an SSE stream. This fits naturally into REST semantics.

WebSocket is used separately for the workflow monitor, where bidirectional communication and persistent connections are more appropriate.

---

## RAG Middleware Integration

The RAG system integrates as an Express middleware that intercepts `POST /chat/stream` requests:

```javascript
app.use("/api/ollama", ragMiddleware);    // Intercepts chat/stream
app.use("/api/ollama", ollamaChatRoutes); // Fallback handler
```

The middleware decides whether to handle the request based on:
- Is `RAG_ENABLED` true?
- Is the RAG system initialized?
- Is the `userId` a valid MongoDB ObjectId?
- Is the `exerciseId` a valid MongoDB ObjectId?
- Does the exercise exist and have a correct answer configured?

If any check fails, the middleware calls `next()` and the standard chat handler processes the request without RAG augmentation.

When the RAG middleware handles the request, it takes full control of the response — setting up SSE, calling the LLM, running guardrails, and closing the connection. The standard chat handler is never reached.

For a complete description of the RAG system, see [rag-system.md](rag-system.md).

---

## Static File Serving

Exercise circuit diagram images are served from `backend/src/static/` at the `/static` endpoint. The server also serves the built frontend from `frontend/dist/` with:

- **Immutable caching** for static assets (JS, CSS, images) — cached for 365 days since filenames include content hashes
- **No caching** for `index.html` — ensures users always get the latest version
- **SPA fallback** — any path that doesn't match `/api/` or `/static/` returns `index.html`, allowing client-side routing to work

---

## Environment Variables

All configuration is done through `backend/.env`. The following variables are used:

### Database

| Variable | Description | Example |
|---|---|---|
| `MONGODB_URI` | MongoDB Atlas connection string | `mongodb+srv://user:pass@cluster.mongodb.net/dbname` |

### LLM (Ollama)

| Variable | Description | Example |
|---|---|---|
| `OLLAMA_API_URL_UPV` | Ollama URL (university server, takes priority) | `https://ollama.gti-ia.upv.es:443` |
| `OLLAMA_BASE_URL` | Ollama URL (local fallback) | `http://127.0.0.1:11434` |
| `OLLAMA_MODEL` | Chat model name | `qwen2.5:latest` |
| `OLLAMA_TEMPERATURE` | Generation temperature | `0.4` |
| `OLLAMA_NUM_CTX` | Context window size | `8192` |
| `OLLAMA_NUM_PREDICT` | Max tokens to generate | `120` |
| `OLLAMA_KEEP_ALIVE` | Model keep-alive duration | `60m` |

### RAG

| Variable | Description | Example |
|---|---|---|
| `RAG_ENABLED` | Enable/disable RAG system | `true` |
| `RAG_EMBEDDING_MODEL` | Embedding model name | `nomic-embed-text:latest` |
| `RAG_HIGH_THRESHOLD` | High quality score threshold | `0.7` |
| `RAG_MED_THRESHOLD` | Medium quality / CRAG trigger threshold | `0.4` |
| `CHROMA_URL` | ChromaDB server URL | `http://localhost:8000` |
| `HISTORY_MAX_MESSAGES` | Max conversation messages in LLM context | `8` |
| `RAG_MAX_WRONG_STREAK` | Max consecutive wrong classifications before injecting stuck hint | `4` |
| `RAG_MAX_TOTAL_TURNS` | Max total assistant turns before injecting stuck hint | `16` |

### Authentication

| Variable | Description | Example |
|---|---|---|
| `SESSION_SECRET` | Express session secret | `your-secret-key` |
| `DEV_BYPASS_AUTH` | Skip authentication in development | `true` |
| `CAS_CLIENT_ID` | CAS OAuth2 client ID | `your-client-id` |
| `CAS_CLIENT_SECRET` | CAS OAuth2 client secret | `your-client-secret` |
| `CAS_REDIRECT_URI` | OAuth2 callback URL | `http://localhost:3000/auth/callback` |

### Application

| Variable | Description | Example |
|---|---|---|
| `PORT` | Server port | `3000` |
| `FRONTEND_BASE_URL` | Frontend URL for CORS | `http://localhost:5173` |
| `WORKFLOW_BASE_URL` | Workflow monitor URL for CORS | `http://localhost:5174` |
