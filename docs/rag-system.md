# RAG System — Deep Dive

The Retrieval-Augmented Generation (RAG) system is the core intelligence behind the virtual tutor. It analyzes each student message, retrieves relevant pedagogical context, and guides the LLM to produce Socratic responses, all without revealing solutions.

This document covers every module in `backend/src/rag/`, how they connect, and the reasoning behind each design decision.

---

## Table of Contents

1. [Architecture Overview](#architecture-overview)
2. [Configuration](#configuration)
3. [Data Ingestion](#data-ingestion)
4. [Query Classification](#query-classification)
5. [Pipeline Orchestrator](#pipeline-orchestrator)
6. [Knowledge Graph](#knowledge-graph)
7. [Hybrid Search](#hybrid-search)
8. [CRAG — Corrective RAG](#crag--corrective-rag)
9. [Guardrails](#guardrails)
10. [LLM Integration](#llm-integration)
11. [Logging](#logging)
12. [Event Bus and WebSocket](#event-bus-and-websocket)
13. [Module Interconnection Map](#module-interconnection-map)

---

## Architecture Overview

Standard RAG systems retrieve documents and feed them to an LLM. This system goes further — it is an **agentic conditional RAG** that makes routing decisions based on what the student says, selects different retrieval strategies, applies corrective mechanisms when retrieval quality is low, and enforces safety guardrails before any response reaches the student.

The high-level flow for every student message:

```
Student message
    │
    ▼
RAG Middleware (ragMiddleware.js)
    │── validates inputs, loads exercise from MongoDB
    │── calls Pipeline Orchestrator
    │
    ▼
Pipeline Orchestrator (ragPipeline.js)
    │── Query Classifier → determines message type (9 categories)
    │── Routes to appropriate retrieval strategy (8 paths)
    │── Retrieves from: Knowledge Graph, Hybrid Search, Student History
    │── Applies CRAG if retrieval quality is low
    │── Builds augmentation context
    │
    ▼
Back to Middleware
    │── Checks for deterministic finish (correct answer → end exercise)
    │── Builds augmented system prompt (base + RAG context)
    │── Loads conversation history from MongoDB
    │── Calls Ollama LLM (non-streaming)
    │── Runs 5 sequential guardrails on the response
    │── Retries LLM if any guardrail fails
    │── Applies deterministic prefix fallback if confirmation persists
    │── Sends response to student via SSE
    │── Saves to MongoDB + JSONL log
```

**Why non-streaming LLM calls?** The system calls Ollama in non-streaming mode so it can inspect the full response before sending it to the student. This allows the guardrails to catch and block problematic responses. A streaming approach would send tokens directly to the client, making it impossible to retract a response that reveals the solution.

---

## Configuration

**File:** `backend/src/rag/config.js`

All tuneable parameters are centralized in a single configuration module. This makes it easy to adjust the system's behavior without modifying multiple files.

### LLM Settings

| Parameter | Default | Description |
|---|---|---|
| `OLLAMA_MODEL` | `qwen2.5:latest` | The language model used for generation |
| `OLLAMA_TEMPERATURE` | `0.4` | Controls response randomness. Low value keeps responses focused and consistent |
| `OLLAMA_NUM_CTX` | `8192` | Context window size in tokens |
| `OLLAMA_NUM_PREDICT` | `120` | Maximum tokens to generate per response. Kept short to enforce concise Socratic responses |
| `OLLAMA_KEEP_ALIVE` | `60m` | How long Ollama keeps the model loaded in memory |
| `EMBEDDING_MODEL` | `nomic-embed-text:latest` | Model used for generating text embeddings (768 dimensions) |

### Retrieval Parameters

| Parameter | Default | Description |
|---|---|---|
| `TOP_K_RETRIEVAL` | `10` | Number of results fetched from each search engine (BM25 and semantic) |
| `TOP_K_FINAL` | `3` | Number of results kept after RRF fusion. Only the top 3 most relevant examples are included in the prompt |
| `RRF_K` | `60` | Smoothing constant for Reciprocal Rank Fusion. Higher values give more weight to lower-ranked results |
| `BM25_K1` | `1.5` | BM25 term frequency saturation. Controls how much repeated terms boost a document's score |
| `BM25_B` | `0.75` | BM25 document length normalization. Penalizes long documents to prevent them from dominating |
| `HIGH_THRESHOLD` | `0.7` | Score above which retrieved results are considered high quality |
| `MED_THRESHOLD` | `0.4` | Score below which CRAG reformulation is triggered |

### History and Paths

| Parameter | Default | Description |
|---|---|---|
| `HISTORY_MAX_MESSAGES` | `8` | Maximum conversation messages loaded as context for the LLM |
| `DATASETS_DIR` | `material-complementario/llm/datasets` | Path to exercise CSV datasets |
| `KG_PATH` | `material-complementario/llm/knowledge-graph/...json` | Path to the knowledge graph JSON file |
| `LOG_DIR` | `backend/logs/rag` | Path where JSONL interaction logs are stored |
| `EXERCISE_DATASET_MAP` | `{1: "dataset_exercise_1.json", ...}` | Maps exercise numbers to dataset files. Exercise 2 shares the same dataset as exercise 1 |
| `MAX_WRONG_STREAK` | `4` | Max consecutive wrong classifications before injecting a `[STUDENT IS STUCK]` hint that forces the LLM to change strategy |
| `MAX_TOTAL_TURNS` | `16` | Max total assistant turns before injecting the same `[STUDENT IS STUCK]` hint |
| `RAG_ENABLED` | `true` | Feature flag to disable the entire RAG system |

**Why these defaults?** The values were tuned empirically. Temperature 0.4 prevents the LLM from being too creative (important for a tutor that must not hallucinate facts). `TOP_K_FINAL=3` limits prompt size while still providing enough examples. `RRF_K=60` is a standard value from the original RRF paper (Cormack et al., 2009) that gives a balanced fusion. `MED_THRESHOLD=0.4` triggers CRAG when retrieval quality is genuinely poor without being too aggressive.

---

## Data Ingestion

**File:** `backend/src/rag/ingest.js`

Before the system can retrieve anything, the data must be ingested into the search engines. The ingestion script loads all datasets and the knowledge graph, generates embeddings, and stores everything in ChromaDB and in-memory BM25 indices.

### What Gets Ingested

1. **Exercise Datasets** — JSON files containing student-tutor conversation pairs. Each pair has a `student` field (what the student said) and a `tutor` field (how an expert tutor responded). There are 6 unique dataset files covering 7 exercises (exercises 1 and 2 share the same dataset because they are variations of the same circuit problem).

2. **Knowledge Graph** — A single JSON file containing 27 concept relationships about electrical circuits, including alternative conceptions (misconceptions), expert reasoning, and Socratic questions.

### Ingestion Flow

```
For each exercise dataset:
    1. Read JSON file → array of {student, tutor} pairs
    2. Generate embeddings for all student messages (batch call to Ollama/nomic-embed-text)
    3. Store in ChromaDB collection "exercise_N" (documents + embeddings + metadata)
    4. Build BM25 in-memory index for the same pairs

For the knowledge graph:
    1. Read JSON file → array of concept entries
    2. Combine Node1 + Relation + Node2 + Expert reasoning into a single text per entry
    3. Generate embeddings for all entries (batch)
    4. Store in ChromaDB collection "knowledge_graph"
```

### When Ingestion Runs

The ingestion script (`ingest.js`) is a standalone script that must be run once to populate ChromaDB. However, **BM25 indices and the knowledge graph are also loaded at server startup** by the RAG middleware (`initRAG()` in `ragMiddleware.js`). This means:

- **ChromaDB collections** persist across restarts (stored on disk by ChromaDB)
- **BM25 indices** are rebuilt from the JSON files every time the server starts (kept in memory for speed)
- **Knowledge graph** is reloaded from JSON every time the server starts

**Why in-memory BM25?** BM25 is a simple scoring function that works best with direct in-memory access. Using an external service for BM25 would add latency and complexity for no benefit — the datasets are small enough (hundreds of pairs per exercise) to fit easily in memory.

---

## Query Classification

**File:** `backend/src/rag/queryClassifier.js`

Every student message is classified into one of 9 categories before any retrieval or generation happens. The classification determines which retrieval strategy the pipeline uses and what instructions the LLM receives.

### Classification Types

| Type | Example | Description |
|---|---|---|
| `greeting` | "Hola, ¿qué tal?" | Social greeting, no exercise content |
| `dont_know` | "No lo sé" | Student does not know how to proceed |
| `single_word` | "Todas" | Very short answer without any reasoning |
| `wrong_answer` | "R5" | Incorrect element selection |
| `correct_no_reasoning` | "R1, R2 y R4" | Correct answer but no explanation given |
| `correct_wrong_reasoning` | "R1, R2 y R4 porque forman un divisor de tensión" | Correct answer but using a misconception to justify it |
| `correct_good_reasoning` | "R1, R2 y R4 porque R3 está en abierto..." | Correct answer with sound reasoning |
| `wrong_concept` | "R1 y R2 dado que forman un divisor de tensión" | Wrong answer using a specific misconception |
| `partial_correct` | "no pasa por R3" | Student correctly excludes elements or proposes only correct ones, but the answer is incomplete |

### How Classification Works

The classifier is **entirely rule-based** — it uses regex patterns and keyword matching, no LLM calls. All patterns (greetings, "don't know" expressions, reasoning indicators, concept keywords) are loaded from `languageManager.js` via `getAllPatterns()`, covering Spanish, Valencian, and English.

The decision tree:

1. **Check for greetings**: Does the message start with "hola", "buenos días", "bon dia", "hello", etc.?
2. **Check for "don't know"**: Does the message contain "no lo sé", "ni idea", "no ho sé", "I don't know", etc.?
3. **Check for short answers**: Is the message less than 15 characters with no element mentions?
4. **Extract evaluable elements**: The classifier accepts an optional `evaluableElements` parameter — an array of all possible answer elements for the exercise (e.g., `["R1","R2","R3","R4","R5"]`). `extractMentionedElements(message, evaluableElements)` searches the message for any of these elements with word-boundary checks. If no `evaluableElements` are provided, it falls back to the generic `/R\d+/gi` regex for backward compatibility with circuit exercises.
5. **Separate proposed vs negated elements**: For each found element, `detectNegation()` checks whether the student is affirming or rejecting it. It uses a tight window (15 characters before, 25 characters after the element) to look for:
   - **Pre-negation words**: "no", "sin", "ni", "sense", "without", "except", etc.
   - **Pre-negation phrases** (30-char window): "no pasa corriente por", "no circula corrent per", "no current flows through", etc.
   - **Post-negation phrases**: "no contribuye", "se elimina", "está en abierto", "is open", "doesn't contribute", etc. Post-negation is truncated at the next sentence boundary to prevent cross-sentence false positives.
   Elements found with negation go into the `negated` array; all others go into `proposed`.
6. **Compare PROPOSED elements with correct answer**: If the proposed elements exactly match the correct answer set:
   - **Has concept keywords AND correct negations** (student negates elements not in the answer) → `correct_good_reasoning` (the student is correctly reasoning about excluded elements)
   - **Has reasoning AND all concepts are state descriptions** (e.g., "cortocircuito", "abierto", "open circuit" — factual circuit states, not alternative conceptions) → `correct_good_reasoning`
   - **Has concept keywords but no correct negations** → `correct_wrong_reasoning` (assumes the concept may be misapplied)
   - **No reasoning, no concepts** → `correct_no_reasoning`
   - **Has reasoning, no concepts** → `correct_good_reasoning`
7. **Partial correct**: If the proposed and negated sets don't fully match the answer, but all negations are correct (rejecting elements not in the answer) AND all proposals are correct (proposing elements in the answer) → `partial_correct`. The answer is partially right but incomplete.
8. **Wrong elements with concept keywords** → `wrong_concept`
9. **Everything else** → `wrong_answer`

The output structure:

```javascript
{
  type: "wrong_answer",            // one of the 9 classification types
  resistances: ["R1", "R3", "R5"], // all elements found in the message
  proposed: ["R1", "R5"],          // elements the student affirms/proposes
  negated: ["R3"],                 // elements the student explicitly rejects
  hasReasoning: false,             // whether reasoning keywords were found
  concepts: ["divisor de tensión"] // domain concepts mentioned
}
```

**Why rule-based instead of LLM-based classification?** Three reasons:

1. **Determinism** — The same input always produces the same classification. An LLM might classify the same message differently on different calls, leading to inconsistent tutoring behavior.
2. **Speed** — Rule-based classification is instant (< 1ms). An LLM call would add 1-5 seconds per message.
3. **No hallucination** — The classifier cannot invent categories or misinterpret messages in unexpected ways. It either matches a pattern or it doesn't.

**Design note on `correct_wrong_reasoning`:** If a student gives the correct elements AND uses a concept keyword (like "divisor de tensión"), the system classifies it as potentially wrong reasoning. This is intentional — the system routes this to both the knowledge graph (to check if the concept is misapplied) and hybrid search (to find relevant examples). It is better to double-check a correct answer with suspicious reasoning than to confirm it blindly.

**Design note on state description concepts:** The classifier distinguishes between factual circuit states (cortocircuito, abierto, open circuit, etc.) and alternative conceptions (divisor de tensión, atenuación local, etc.). When a student uses ONLY state description terms with reasoning connectors (e.g., "R1, R2 y R4 porque R3 está en cortocircuito y R5 en abierto"), they are correctly describing circuit behavior, not applying a misconception — so this is classified as `correct_good_reasoning` rather than `correct_wrong_reasoning`.

**Design note on negation detection:** The tight window approach (15/25 characters) prevents false positives from distant negations. For example, in "R2 y R4. No pasa por R3", the "No pasa" applies only to R3 (post-sentence-boundary truncation prevents it from affecting R2/R4). Multi-word pre-negation phrases like "no pasa corriente por" use a wider 30-char window because they are less prone to false positives than single words.

---

## Pipeline Orchestrator

**File:** `backend/src/rag/ragPipeline.js`

The pipeline orchestrator is the decision-making brain of the RAG system. It takes the classification from the query classifier and routes the request to the appropriate retrieval strategy.

### Routing Strategies

| Classification | Decision | Retrieval Actions |
|---|---|---|
| `greeting` | `no_rag` | No retrieval. Falls through to the standard chat handler |
| `dont_know` | `scaffold` | Knowledge Graph search for basic concepts (serie, paralelo, cortocircuito) |
| `single_word` | `demand_reasoning` | No retrieval. Only classification hint is added to prompt |
| `wrong_answer` | `rag_examples` | Hybrid Search for similar student-tutor pairs + CRAG if needed |
| `correct_no_reasoning` | `demand_reasoning` | Hybrid Search for examples of how tutors ask for reasoning |
| `correct_wrong_reasoning` | `correct_concept` | Hybrid Search + Knowledge Graph search for the mentioned concepts |
| `correct_good_reasoning` | `rag_examples` | Hybrid Search for confirmation-style tutor responses |
| `wrong_concept` | `concept_correction` | Knowledge Graph search for the misconception + Hybrid Search for examples |
| `partial_correct` | `rag_examples` | Hybrid Search for similar student-tutor pairs |

### Augmentation Building

For each routing path, the pipeline builds an **augmentation string** that gets appended to the LLM's system prompt. The augmentation can contain up to 4 sections:

1. **Classification Hint** (`[RESPONSE MODE]`): Tells the LLM what type of student message it is dealing with and provides specific pedagogical instructions. For example, for `wrong_answer`: "The student gave incorrect elements. Ask them to explain their reasoning. If you detect an alternative conception, focus on questioning THAT concept with a Socratic question." The hint also injects **intermediate feedback phrases** (hybrid approach) — for `wrong_answer` and `wrong_concept`, the LLM is instructed to START its response with one of several deterministic phrases (e.g., "Hmm, no del todo..." / "Not quite...") to prevent positive-sounding openings. For `partial_correct`, `correct_no_reasoning`, and `correct_wrong_reasoning`, analogous partial-feedback phrases are injected. These phrases are language-aware (Spanish, Valencian, English), loaded via `getIntermediateFeedback()` from `languageManager.js`.

   **Softened hints**: When the student responds without mentioning specific evaluable elements (i.e., they are answering a Socratic sub-question about concepts), aggressive classification hints for `wrong_answer`, `wrong_concept`, and `single_word` are replaced with a softer instruction: "Evaluate their response IN CONTEXT of your last question and the conversation history. If their response correctly addresses your question, acknowledge it briefly and advance." This prevents the LLM from treating conceptual answers as wrong just because no element names appear.

2. **Per-Element Analysis** (`[PER-ELEMENT ANALYSIS]`): When the student mentions specific elements, the system analyzes each one individually with negation awareness — which are correctly proposed, which are wrongly proposed, which are correctly rejected (negated elements not in the answer), which are wrongly rejected (negated elements that ARE in the answer), and which correct elements are missing. This is marked as "internal, NEVER reveal to student" so the LLM knows the ground truth but is instructed not to share it. A critical instruction is appended: "When the student says an element 'does not contribute' but it IS in the correct answer, you MUST NOT agree."

3. **Reference Examples** (`[REFERENCE EXAMPLES]`): Student-tutor pairs retrieved from the hybrid search engine, formatted as "Example 1: Student said X, Tutor responded Y". These show the LLM the correct pedagogical approach for similar situations.

4. **Domain Knowledge** (`[DOMAIN KNOWLEDGE]`): Entries from the knowledge graph containing concept definitions, expert reasoning, alternative conceptions, and Socratic questions. A header reminds the LLM to use this as internal reference only and NOT copy Socratic questions verbatim.

5. **Student History** (`[STUDENT HISTORY]`): Past misconceptions the student has shown across all exercises, loaded from the `Resultado` model. This allows the tutor to pay special attention to recurring errors.

6. **Guardrail Reminder** (`[GUARDRAIL]`): Ten critical rules appended at the end of every augmentation, including: do not reveal answers, do not confirm incorrect answers, do not name specific elements for the student to analyze, do not reveal element states, ask one Socratic question about a concept, challenge ACs, do not confirm correct answers without reasoning, do not agree when a student wrongly rejects an element in the answer, never repeat a question already answered correctly, and evaluate the student considering the full conversation history.

### Full Pipeline Flow

The `runFullPipeline` function orchestrates the complete flow:

```
classifyQuery(userMessage, correctAnswer, evaluableElements)
    │
    ├── routing decision based on classification type
    │
    ├── retrieval (varies by route):
    │   ├── hybridSearch(query, exerciseNum) → dataset examples
    │   ├── searchKG(concepts) → domain knowledge
    │   └── CRAG reformulation if needed (normalizeToSpanish for retrieval)
    │
    ├── loadStudentHistory(userId) → past errors
    │
    └── build augmentation string (hint + feedback phrases + analysis + examples + knowledge + history + guardrail)
```

The pipeline accepts two additional parameters: `evaluableElements` (all possible answer elements for the exercise, used by the classifier for generic extraction) and `lang` (the active conversation language, used for intermediate feedback phrase selection).

---

## Knowledge Graph

**File:** `backend/src/rag/knowledgeGraph.js`

The knowledge graph is a structured collection of 27 concept relationships about electrical circuits. It is the system's domain expertise, containing not just facts but also common student misconceptions and how to address them.

### Data Structure

Each entry in the knowledge graph has the following fields:

| Field | Example | Description |
|---|---|---|
| `Node1` | "Dispositivos" | First concept in the relationship |
| `Relation` | "pueden conectarse en" | The relationship between concepts |
| `Node2` | "serie y paralelo" | Second concept in the relationship |
| `Expert reasoning` | "En una conexión en serie, los dispositivos se conectan uno tras otro..." | Detailed explanation of the concept |
| `AC name` | "Atenuación local" | Name of a common misconception (Alternative Conception) |
| `Description` | "El estudiante cree que la corriente se gasta..." | Description of the misconception |
| `Socratic Tutoring` | "¿Qué ocurre con la corriente cuando un componente está cortocircuitado?" | Suggested Socratic question to address the misconception |

### Alternative Conceptions (ACs)

Alternative Conceptions are deeply held misconceptions that students carry about how electrical circuits work. For example:

- **"Current gets consumed"** — Students believe current decreases as it flows through components, like water being absorbed by a sponge.
- **"Voltage divider applies everywhere"** — Students apply the voltage divider formula to circuits where components are not actually in series.
- **"Short circuit means no current"** — Students confuse open circuits (no current) with short circuits (maximum current, zero resistance).

The knowledge graph links these ACs to specific concept relationships, so when the classifier detects a concept keyword in the student's message, the system can retrieve the relevant AC and its corresponding Socratic question.

### Search Mechanism

The `searchKG(concepts)` function takes an array of concept keywords and searches all entries by matching against the concatenated `Node1 + Relation + Node2` text. This is a simple case-insensitive substring match — sufficient because the knowledge graph is small (27 entries) and the concept keywords are well-defined.

**Why not use ChromaDB for KG search?** Although the knowledge graph is also ingested into ChromaDB (for potential future use), the runtime search uses direct keyword matching. This is because the concepts extracted by the classifier are exact terms (e.g., "divisor de tensión", "cortocircuito") that match best with substring search rather than semantic similarity. A semantic search might return conceptually related but not exactly matching entries, which could mislead the augmentation.

---

## Hybrid Search

**File:** `backend/src/rag/hybridSearch.js`

The hybrid search engine combines two complementary search methods to find the most relevant student-tutor examples for a given query. This is the main retrieval mechanism for the RAG system.

### Why Hybrid?

Neither keyword search nor semantic search alone is sufficient:

- **BM25 (keyword search)** excels at finding exact term matches. If a student says "R5", BM25 will find all examples where "R5" is mentioned. But it fails on paraphrases — "la resistencia del medio" would not match "R3" even though they refer to the same component.

- **Semantic search** excels at finding conceptually similar texts even with different wording. But it can miss important exact terms — it might return a semantically similar example about a different exercise that happens to discuss the same concept.

By combining both, the system gets the best of both worlds.

### BM25 Component

**File:** `backend/src/rag/bm25.js`

BM25 (Best Matching 25) is a probabilistic ranking function based on TF-IDF. It scores each document based on how many query terms it contains, adjusted for term frequency and document length.

**Scoring formula:**

```
score(doc, query) = Σ IDF(t) × (tf × (k1 + 1)) / (tf + k1 × (1 - b + b × dl/avgDl))
```

Where:
- `IDF(t)` = inverse document frequency of term t (how rare it is across all documents)
- `tf` = term frequency in the document
- `k1 = 1.5` = term frequency saturation parameter
- `b = 0.75` = document length normalization parameter
- `dl` = document length, `avgDl` = average document length

The BM25 index is built per exercise from the student-tutor pairs. Tokenization simply lowercases and splits on whitespace, removing single-character words.

### Semantic Component

**Files:** `backend/src/rag/embeddings.js`, `backend/src/rag/chromaClient.js`

The semantic component converts the query into a 768-dimensional vector using the `nomic-embed-text` model (via Ollama), then searches ChromaDB for the most similar document vectors.

**Embedding generation** (`embeddings.js`): Sends text to Ollama's `/api/embed` endpoint with the `nomic-embed-text` model. Returns a 768-dimensional float array. Supports both single text and batch embedding.

**ChromaDB search** (`chromaClient.js`): ChromaDB stores documents with their embeddings in collections (one per exercise). Search uses cosine similarity — the similarity score is computed as `1 - cosine_distance`. ChromaDB uses HNSW (Hierarchical Navigable Small World) graphs for efficient approximate nearest-neighbor search.

### Reciprocal Rank Fusion (RRF)

After both BM25 and semantic search return their top 10 results each, RRF combines them into a single ranked list:

```
score(doc) = 1/(K + rank_bm25) + 1/(K + rank_semantic)
```

Where `K = 60` is a smoothing constant. This formula:

- Rewards documents that appear in both lists (they get two rank contributions)
- Gives more weight to documents ranked higher in either list
- Does not require normalizing scores between the two methods (which would be unreliable since BM25 and cosine similarity use completely different scales)

**Why RRF over weighted sum?** A weighted sum (e.g., `0.5 × BM25_score + 0.5 × semantic_score`) requires that both scores be on comparable scales. BM25 scores can range from 0 to 20+, while cosine similarity ranges from 0 to 1. Normalizing them is error-prone and dataset-dependent. RRF only uses ranks, which are always on the same scale (1, 2, 3, ...) regardless of the underlying scoring function.

After fusion, the top `TOP_K_FINAL = 3` results are returned.

---

## CRAG — Corrective RAG

CRAG (Corrective Retrieval-Augmented Generation) is a fallback mechanism that activates when the initial hybrid search returns poor results. It reformulates the query and retries the search.

### When It Triggers

CRAG activates when the top result from hybrid search has a score below `MED_THRESHOLD (0.4)`. This typically happens when:

- The student uses unusual phrasing that does not match any examples well
- The student discusses a concept without mentioning specific resistances
- The query is too short or vague for effective matching

### How It Works

1. **Extract key entities** from the original query:
   - Resistance mentions (R1, R2, etc.)
   - Concept keywords from a predefined list (divisor de tensión, cortocircuito, serie, paralelo, etc.)
2. **Build a reformulated query** by joining all extracted entities with spaces
3. **Retry the hybrid search** with the reformulated query

**Example:**
- Original query: "creo que esas dos de arriba no porque el interruptor está abierto"
- Extracted entities: ["circuito abierto", "abierto"]
- Reformulated query: "circuito abierto abierto"
- The reformulated query matches better against examples that discuss open circuits

**Why this approach?** More sophisticated query reformulation (e.g., using an LLM to rephrase) would add latency and complexity. The key insight is that student messages about circuits always revolve around specific components and concepts. Extracting these entities and using them as the query focuses the search on what matters, discarding filler words and sentence structure that confuse the search engines.

---

## Guardrails

**File:** `backend/src/rag/guardrails.js`

The guardrail system is a sequential five-check chain that runs on every LLM response before it reaches the student. Each check looks for a specific type of pedagogically harmful content. All detection patterns are multi-language (Spanish, Valencian, English), loaded from `languageManager.js`.

### Guardrail 1: Solution Leak Check

**Function:** `checkSolutionLeak(response, correctAnswer)`

Detects if the LLM response reveals the correct answer. Two detection methods:

1. **Reveal phrase detection**: Searches for phrases like "la respuesta es", "las resistencias correctas son", "the answer is", etc. (multi-language). If such a phrase appears AND all correct elements are mentioned in the response, it is flagged.

2. **Grouped listing detection**: If all correct elements appear together in a single affirmative sentence (e.g., "R1, R2 y R4"), it is flagged. Questions are excluded — the tutor is allowed to ask about elements.

**Why this matters:** An LLM tutor that gives away the answer defeats the entire purpose of Socratic tutoring. Even with strong system prompts, LLMs sometimes "slip" and directly state the solution, especially when the augmentation contains the correct answer for internal reference.

### Guardrail 2: False Confirmation Check

**Function:** `checkFalseConfirmation(response, classification)`

Detects if the LLM incorrectly confirms a wrong answer as correct. Only active when the classification indicates the student is wrong (`wrong_answer`, `wrong_concept`, `single_word`).

Checks the first 60 characters of the response for affirmative phrases: "perfecto", "correcto", "exacto", "muy bien", "eso es", "perfect", "exactly", etc. (multi-language, accent-insensitive via `stripAccents()`).

**Why check only the first 60 characters?** Because false confirmations almost always appear at the start of a response. The tutor says "¡Perfecto!" and then continues. Checking only the beginning avoids false positives from phrases like "eso no es correcto" (negation of the confirmation phrase).

### Guardrail 3: Premature Confirmation Check

**Function:** `checkPrematureConfirmation(response, classification)`

Detects if the LLM prematurely confirms a partially correct or unjustified answer. Only active when the classification is `correct_no_reasoning`, `correct_wrong_reasoning`, or `partial_correct` — cases where the student has the right elements but has not yet provided adequate reasoning or has wrong reasoning.

Uses the same 60-character window and confirmation phrase set as the false confirmation check. The distinction is the trigger context: false confirmation catches confirming a *wrong* answer, while premature confirmation catches confirming a *correct but unjustified* answer. The pedagogical harm is different — premature confirmation short-circuits the reasoning process by accepting "R1, R2, R4" without asking the student to explain *why*.

### Guardrail 4: State Reveal Check

**Function:** `checkStateReveal(response)`

Detects if the LLM reveals the internal state of a specific element (e.g., "R5 está cortocircuitada", "R3 is open circuit", "per R3 no circula corrent"). This is information the student must discover through analysis, not be told directly.

The check splits the response into sentences and looks for sentences that contain BOTH an element mention (R1, R2, etc.) AND a state reveal phrase ("está cortocircuitad", "circuito abierto", "is open", "is shorted", "curtcircuitada", etc., multi-language). Questions are excluded — asking "¿qué crees que ocurre con R5?" is pedagogically sound.

### Guardrail 5: Element Naming Check

**Function:** `checkElementNaming(response, evaluableElements)`

Detects if the LLM names a specific evaluable element in a question or directive sentence. For example, "What about R5?" or "Fíjate en R3" tells the student exactly which element to analyze, undermining the Socratic approach.

The check splits the response into sentences, identifies questions (contains `?` or `¿`) and directives (contains verbs like "analiza", "observa", "look at", "consider", "fixa't en", etc., multi-language), and then checks whether any evaluable element appears in that sentence with word-boundary validation.

**Why this matters:** If the tutor says "What happens to R5?", the student knows to focus on R5. A proper Socratic question asks about concepts: "What happens when a component's two terminals are connected to the same node?" This forces the student to identify which component that applies to.

### Retry Mechanism

When any guardrail detects a violation:

1. A specific corrective instruction is appended to the system prompt (e.g., "Your previous response revealed the solution directly. Do NOT list the correct elements together..."). Each corrective instruction is language-aware, loaded from `languageManager.js`.
2. The LLM is called again with the stronger prompt
3. The retry response replaces the original

Each guardrail check runs sequentially (leak → false confirm → premature confirm → state reveal → element naming), and each can trigger one retry. In the worst case, the LLM is called 6 times for a single student message (1 original + 5 retries).

### Deterministic Prefix Fallback

After all 5 guardrail retries, if the response *still* starts with a confirmation phrase for a wrong or partially correct answer (and the student mentioned specific elements), the system applies a deterministic fix:

1. `removeOpeningConfirmation(response)` iteratively strips all leading confirmation phrases (e.g., "¡Perfecto! Exacto, en un cortocircuito..." → "En un cortocircuito...")
2. A random intermediate feedback phrase (e.g., "Hmm, no del tot..." / "Not quite...") is prepended
3. A second pass of `removeOpeningConfirmation()` catches any confirmation phrases that survived after the first cleanup

This ensures the student never receives a response that starts with "Correct!" when their answer is wrong or unjustified, even if the LLM persists across multiple retries. The fallback only activates when the student mentioned specific elements — when no elements are mentioned (student is answering a conceptual sub-question), the LLM confirming a correct concept is appropriate.

**Why not loop until all guardrails pass?** To avoid infinite retry loops. If the LLM keeps producing problematic responses despite stronger instructions, the deterministic prefix fallback provides a reliable last resort. In practice, one retry per guardrail is sufficient — the corrective instructions are specific enough that the LLM almost always corrects the issue on the first retry.

---

## LLM Integration

The LLM is called through Ollama's REST API. The middleware builds the complete message array and sends it as a non-streaming request.

### Multi-Language Support

The system supports three languages — Spanish (es), Valencian (val), and English (en) — via a centralized module `backend/src/utils/languageManager.js`.

**Language detection**: `resolveLanguage(conversationHistory)` scans the conversation history (most recent first) for explicit language switch requests (e.g., "parla en valencià", "speak in english"). If no switch is found, it defaults to Spanish.

**What is language-aware**:
- **System prompt**: Language-specific tutoring rules (e.g., Valencian grammar conventions, technical terminology)
- **Detection patterns**: All greetings, "don't know" expressions, reasoning indicators, concept keywords, confirmation phrases, reveal phrases, state reveal patterns, and frustration patterns are defined per-language in `languageManager.js` and fetched via `getAllPatterns()`
- **Intermediate feedback phrases**: Deterministic starter phrases for wrong/partial classifications, per language
- **Finish messages**: Congratulatory messages when the student completes the exercise, per language
- **Guardrail corrective instructions**: Retry instructions appended when a guardrail triggers, per language
- **Term normalization**: `normalizeToSpanish()` converts Valencian/English terms to Spanish equivalents for CRAG query reformulation (since the datasets are in Spanish)

### System Prompt Construction

The system prompt is built in layers:

1. **Base prompt** (`buildTutorSystemPrompt` in `utils/promptBuilder.js`): Contains the exercise description, circuit topology, and general tutoring instructions. This is exercise-specific and language-aware — the builder receives the active language and includes appropriate language rules.

2. **Conversation progress hint** (`[CONVERSATION CONTEXT]`): Extracts the last question from the most recent assistant message and tells the LLM: "Your last question to the student was: '...'. Evaluate the student's current response as an answer to THIS question. If they answered it correctly, acknowledge and advance. Do NOT re-ask." This prevents the tutor from ignoring the student's response to a sub-question and re-asking the same thing.

3. **Loop prevention hints** (when applicable): Up to three contextual hints may be injected depending on the conversation state:
   - `[ANTI-LOOP]`: Injected when tutor repetition is detected (see Loop Prevention below). Forces the LLM to ask a NEW, DIFFERENT question.
   - `[STUDENT FRUSTRATED]`: Injected when frustration is detected in the student's message. Forces empathy and forward progress.
   - `[STUDENT IS STUCK]`: Injected when the conversation exceeds loop thresholds. Forces a complete strategy change with a concrete hint.

4. **RAG augmentation**: The output from the pipeline orchestrator — classification hints with intermediate feedback phrases, per-element analysis, reference examples, domain knowledge, student history, and guardrail reminders.

The final prompt sent to the LLM is: `basePrompt + "\n\n" + progressHint + repetitionHint + frustrationHint + stuckHint + ragAugmentation`

### Conversation History

The last `HISTORY_MAX_MESSAGES = 8` messages from the current conversation are loaded from MongoDB and included in the message array. This gives the LLM context about what has already been discussed.

The history is loaded from the `Interaccion` model using MongoDB's `$slice` operator to efficiently fetch only the last N messages without loading the entire conversation.

### Ollama API Call

```javascript
POST {OLLAMA_CHAT_URL}/api/chat
{
  model: "qwen2.5:latest",
  stream: false,
  keep_alive: "60m",
  messages: [
    { role: "system", content: augmentedPrompt },
    { role: "user", content: "message from history" },
    { role: "assistant", content: "response from history" },
    ...
    { role: "user", content: currentMessage }
  ],
  options: {
    num_predict: 120,
    num_ctx: 8192,
    temperature: 0.4
  }
}
```

**Why qwen2.5?** Qwen 2.5 provides a good balance of reasoning quality, response speed, and model size for this tutoring use case. It follows instructions well (important for Socratic tutoring constraints) and supports Spanish effectively.

### Deterministic Finish

Before calling the LLM, the middleware checks if the exercise can be finished deterministically:

- If classification is `correct_good_reasoning` → finish immediately with a language-aware congratulatory message from `getFinishMessages(lang)`
- If classification is `correct_no_reasoning` or `correct_wrong_reasoning` → check the loop override logic (see Loop Prevention below). If overridden to `correct_good_reasoning`, finish.
- Otherwise → fall through to LLM (ask them to explain their reasoning or correct the misconception)

This avoids unnecessary LLM calls when the answer is clear-cut.

### Loop Prevention

The middleware implements multiple mechanisms to prevent the conversation from getting stuck in repetitive loops:

**Tutor Repetition Detection** (`detectTutorRepetition()`): Loads the last 4 assistant messages from the conversation and extracts the last question from each. Computes pairwise word overlap (words > 3 characters) between all question pairs. If any pair exceeds 50% overlap, repetition is detected. This catches not just consecutive repetitions but also alternating patterns (A-B-A-B) that a simple 2-message comparison would miss.

**Student Frustration Detection** (`detectFrustration()`): Checks the student's current message for multi-language frustration patterns: "ya te lo he dicho", "ja t'ho he dit", "I already told you", "te lo acabo de decir", etc. These indicate the student feels they have already answered the tutor's question.

**Loop Override**: If the student has given a correct or partially correct answer in previous turns, and tutor repetition is detected, the classification is overridden to `correct_good_reasoning` — ending the exercise immediately. The threshold for this override is lowered from 2 previous correct turns to 1 when tutor repetition is active.

**Global Loop-Breaking** (`[STUDENT IS STUCK]` hint): If the count of consecutive wrong classifications exceeds `MAX_WRONG_STREAK` (default 4) or the total assistant turn count exceeds `MAX_TOTAL_TURNS` (default 16), a strong contextual hint is injected into the prompt. This hint tells the LLM to change strategy completely: summarize what the student got right, give a concrete hint about the circuit, and ask a very specific new question.

**Anti-Loop Hint** (`[ANTI-LOOP]`): When tutor repetition is detected (but the loop override does not apply), this instruction forces the LLM to acknowledge what the student said correctly, give a concrete hint, and ask a question it has NOT asked before.

**Frustration Hint** (`[STUDENT FRUSTRATED]`): When student frustration is detected, this instruction forces empathy: acknowledge effort, validate correct reasoning, and either accept the answer or give a more concrete hint before asking again.

---

## Logging

**File:** `backend/src/rag/logger.js`

Every RAG interaction is logged as a single JSON line in a JSONL (JSON Lines) file. One file per day, stored in `backend/logs/rag/`.

### Logged Fields

| Field | Description |
|---|---|
| `timestamp` | ISO 8601 timestamp of the interaction |
| `exerciseNum` | Exercise number (1-7) |
| `userId` | MongoDB ObjectId of the student |
| `classification` | Query classification type |
| `decision` | Pipeline routing decision |
| `query` | The student's message |
| `retrievedDocs` | Array of retrieved documents (student-tutor pairs and/or KG entries) |
| `augmentation` | The full augmentation string sent to the LLM |
| `response` | The LLM's final response |
| `guardrailTriggered` | Whether any guardrail triggered a retry |
| `correctAnswer` | The correct resistance set for this exercise |
| `timing` | Timing breakdown (pipeline duration, total duration) |

### Purpose

The JSONL logs serve as the data source for the evaluation system. The retrieval evaluation script reads these logs to compute Precision@K, Recall@K, MAP@K, and MRR against ground truth. The generation evaluation script reads them to compute Socratic rate and guardrail safety rate.

**Why JSONL?** JSONL (one JSON object per line) is append-friendly — new entries are simply appended without needing to parse the entire file. This makes it safe for concurrent writes and efficient for streaming reads. Each line is independently parseable, so a corrupt line does not invalidate the rest of the file.

---

## Event Bus and WebSocket

**Files:** `backend/src/rag/ragEventBus.js`, `backend/src/rag/workflowSocket.js`

The event bus provides real-time observability into the RAG pipeline for the workflow monitoring tool.

### Event Bus (`ragEventBus.js`)

A singleton Node.js `EventEmitter` that all RAG modules use to broadcast events. Every significant step in the pipeline emits an event with a standard envelope:

```javascript
{
  requestId: "req_42_1710000000000",  // unique per request
  timestamp: 1710000000000,            // milliseconds
  event: "bm25_search_end",           // event name
  status: "end",                       // "start", "end", "skip"
  data: {                              // event-specific data
    resultCount: 10,
    topScore: 0.4231,
    // ...
  }
}
```

The `emitEvent` helper function is used throughout `ragMiddleware.js`, `ragPipeline.js`, and `hybridSearch.js` — approximately 46 different event types cover every step from request start to response delivery.

**Thread safety note:** Node.js is single-threaded and each request's pipeline is fully awaited, so the module-level `currentRequestId` is safe to use without locks.

### WebSocket Server (`workflowSocket.js`)

A lightweight WebSocket server using the `ws` library, mounted on the existing HTTP server at path `/ws/workflow`. It listens to the event bus and broadcasts every event to all connected workflow monitor clients.

The WebSocket server has no request/response protocol — it is purely a broadcast channel. Clients connect, receive all events, and can disconnect at any time without affecting the pipeline.

---

## Module Interconnection Map

The following shows how all 14 RAG modules connect to each other:

```
                    ragMiddleware.js
                    ├── config.js
                    ├── ragPipeline.js
                    │   ├── config.js
                    │   ├── queryClassifier.js
                    │   │   └── utils/languageManager.js (patterns)
                    │   ├── hybridSearch.js
                    │   │   ├── config.js
                    │   │   ├── embeddings.js ──► Ollama (nomic-embed-text)
                    │   │   ├── chromaClient.js ──► ChromaDB
                    │   │   ├── bm25.js (in-memory index)
                    │   │   └── ragEventBus.js
                    │   ├── knowledgeGraph.js (in-memory KG)
                    │   ├── utils/languageManager.js (feedback phrases, normalization)
                    │   └── ragEventBus.js
                    ├── guardrails.js
                    │   └── utils/languageManager.js (reveal/confirm/state patterns, instructions)
                    ├── utils/languageManager.js (language resolution, finish messages, frustration)
                    ├── utils/promptBuilder.js (language-aware system prompt)
                    ├── knowledgeGraph.js (init only)
                    ├── bm25.js (init only)
                    ├── logger.js
                    ├── ragEventBus.js
                    └── workflowSocket.js ──► WebSocket clients

External dependencies:
    ├── Ollama (qwen2.5 for chat, nomic-embed-text for embeddings)
    ├── ChromaDB (vector storage)
    └── MongoDB Atlas (exercises, interactions, user history)
```

Every module depends on `config.js` for its parameters. The event bus (`ragEventBus.js`) is used by the three instrumented modules (middleware, pipeline, hybrid search) and broadcast by the WebSocket server. The `languageManager.js` module (in `utils/`, not `rag/`) is a cross-cutting dependency used by the middleware, pipeline, classifier, and guardrails for multi-language pattern matching, intermediate feedback phrases, and corrective instructions. All other modules (knowledge graph, BM25, embeddings, ChromaDB client, logger) are pure functions called by the three main orchestration modules.
