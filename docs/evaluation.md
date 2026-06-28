# Evaluation System

The evaluation system measures the **pedagogical quality** of the tutor by driving the *real* backend pipeline with realistic multi-turn conversations and scoring every tutor turn. It is the empirical backbone of the TFG: it lets several LLMs (and architecture variants) be compared on the same exercises with the same metrics.

All evaluation code is Python, under `evaluation/`.

> The chat model is referred to as **qwen2.5**.

---

## Table of Contents

1. [What It Measures](#what-it-measures)
2. [Layout](#layout)
3. [How the Benchmark Works](#how-the-benchmark-works)
4. [Ground Truth](#ground-truth)
5. [Per-Turn Metrics](#per-turn-metrics)
6. [Efficiency Thresholds](#efficiency-thresholds)
7. [Outputs](#outputs)
8. [Comparing Models](#comparing-models)
9. [PCA — Architecture Comparison](#pca--architecture-comparison)
10. [How to Run](#how-to-run)
11. [Interpreting Results](#interpreting-results)

---

## What It Measures

Unlike a classic RAG evaluation that parses offline logs for Precision@K / Recall@K, this benchmark is **end-to-end and live**: it talks to the running backend over HTTP/SSE, so what it scores is the *whole* system — orchestrator, classification, retrieval, guardrails and the LLM together — exactly as a student would experience it. The focus is pedagogy: is the tutor Socratic, conceptually precise, consistent with the student, and free of hallucinations, while addressing the right alternative conceptions?

---

## Layout

```
evaluation/
├── rag_benchmark/
│   ├── script/
│   │   ├── benchmark_rag.py        # main benchmark (drives the backend, scores turns)
│   │   └── prepare_pca_data.py     # flattens benchmark output into PCA-ready tables
│   ├── env_templates/              # per-model backend/.env presets
│   │   ├── qwen25.env
│   │   ├── llama.env
│   │   ├── llama31_8b.env
│   │   ├── phi4.env
│   │   └── tutor_eda.env
│   ├── results/                    # rag_benchmark_<timestamp>.json / .xlsx
│   ├── Datos_spider.xlsx           # benchmark conversation dataset
│   └── data2.xlsx
└── pca/
    ├── pca_1_resultados_buenos_550.ipynb   # PCA analysis notebook
    └── data/                                # combined per-architecture datasets
```

(There is also a generated `evaluation/architecture_report.html`.)

---

## How the Benchmark Works

**File:** `evaluation/rag_benchmark/script/benchmark_rag.py`

It exercises the real backend rather than mocking anything:

```
benchmark_rag.py
   │
   ├─ BackendClient.login()              → POST /api/auth/dev-login  (needs DEV_BYPASS_AUTH=true)
   ├─ BackendClient.load_exercises()     → GET /api/ejercicios; map each benchmark
   │                                        exercise number to its DB id by statement prefix
   │                                        (or pass --exercise-map manually)
   │
   └─ for each exercise in [1,3,4,5,6,7]:
        for each sample conversation:
          for each turn:
            stream_chat() → POST /api/ollama/chat/stream (SSE), continued via interaccionId
            └─ parse the streamed tutor response (+ latency, token estimate)
            └─ score the turn (see Per-Turn Metrics) → EvalResult
```

- `BACKEND_URL` defaults to `http://localhost:3030` (override via env). TLS verification is disabled for the UPV self-signed endpoints.
- The conversation is multi-turn: each turn passes the previous `interaccionId` so the backend treats it as one continuing session — which is what exercises the loop-prevention, cumulative-answer and guardrail logic realistically.
- `<think>…</think>` blocks (when a model emits chain-of-thought) are split out from the clean tutor response before scoring.

The key classes are `RagKnowledgeBase` (ground truth), `BackendClient` (HTTP/SSE), `RagBenchmark` (the run loop), and `EvalResult` (the per-turn record).

---

## Ground Truth

**Class:** `RagKnowledgeBase`

Loads two files from `backend/src/data/`:

- `contextos-ejercicios/tutorContext_por_ejercicio.json` — per-exercise statement, expert mode, and `acPatterns` (each with `id`, `name`, `misconception`, `strategy`, and `match` rules).
- `alternative_conceptions.json` — the global AC catalogue (descriptions).

From these it provides:
- `retrieve(exercise_id)` — a structured context string (statement + expert mode + possible ACs).
- `expected_acs_for(exercise_id, student_answer)` — the ACs a given student answer *should* exhibit, computed from the `match` rules (`includes` → mentions a wrong component; `missesAny` → omits a correct one). This is the ground-truth label for AC-detection scoring.

---

## Per-Turn Metrics

Every metric is **deterministic and heuristic** (regex + keyword scoring in Python) — no external judge LLM — so runs are reproducible and cheap. Each tutor turn produces an `EvalResult` with:

### Efficiency
- **Latency** (seconds) of the SSE response.
- **Token estimate / throughput** (≈ `words × 1.3`), compared against the thresholds below.

### AC detection — `detect_acs_in_response(response, ac_patterns)`
An AC is counted as *addressed* when at least **2** of its keywords appear in the response. Keywords are a fixed per-AC list (`AC_KEYWORDS`) plus dynamic keywords mined from the AC's `strategy`/`misconception` text. Detected ACs are compared against `expected_acs_for(...)` to measure coverage.

### Socraticity — `evaluate_socraticidad(response)` → 1–5
Rewards questioning over telling:
- **1** — instructive (doesn't end with a question) or gives the answer/confirmation directly.
- **2** — closed question (answer implicit in the question).
- **3** — clarification question ("¿por qué crees…?").
- **4** — scaffolding that pinpoints the error area with circuit terms.
- **5** — induction to contradiction (counterexample / reductio ad absurdum).

### Conceptual precision — `evaluate_precision_conceptual(response, expected_acs, ac_patterns, student_answer)` → 1–5
- **1** — validates a wrong answer or commits a physics error (e.g. "current flows through an open circuit").
- **2** — generic, little/no technical vocabulary.
- **3** — sufficient: correct concepts but a vague diagnosis.
- **4** — good: clearly names the AC with precise language.
- **5** — excellent: names the specific AC **and** ties it to the circuit topology (nodes, resistors).

### Consistency — `evaluate_consistencia(response, student_answer)` → 1–5
How well the response is calibrated to what the student actually said, from the tutor/student length ratio and shared resistor mentions. **5** = references exactly the student's elements with a proportionate length; **2** = disproportionate (way too long/short).

### Hallucination rate — `evaluate_tasa_alucinacion(...)`
Flags statements unsupported by the exercise context / topology.

### Chain-of-thought (when a model emits `<think>`)
- `compute_cot_faithfulness()` — how well the visible answer follows the model's own reasoning.
- `compute_cot_relevance()` — how relevant that reasoning is to the turn.

---

## Efficiency Thresholds

Defined in `benchmark_rag.py` (`THRESHOLDS`):

| Threshold | Value |
|---|---|
| Optimal latency | ≤ 3.0 s |
| Acceptable latency | ≤ 5.0 s |
| Minimum throughput | ≥ 20 tokens/s |
| Minimum Socratic score | ≥ 0.8 (normalized) |

---

## Outputs

`save_json()` and `save_xlsx()` write, per run, to `evaluation/rag_benchmark/results/`:

- `rag_benchmark_<timestamp>.json` — every `EvalResult` (identification, test data, retrieved context, model output, efficiency, AC detection, pedagogy, CoT).
- `rag_benchmark_<timestamp>.xlsx` — a **7-sheet** comparison workbook: an overview, per-model statistics (`compute_model_stats`), per-turn detail, and the formulas/aggregations used.

---

## Comparing Models

The same benchmark is run against several generators to compare them on identical exercises and metrics. Each model has a ready-made backend preset in `env_templates/` (e.g. `qwen25.env`, `llama.env`, `llama31_8b.env`, `phi4.env`). The constants that must stay fixed across runs (`USE_ORCHESTRATOR=1`, `PORT=3030`, `CHROMA_URL`, `PG_CONNECTION_STRING`, `DEV_BYPASS_AUTH=true`) are documented in each template; only the **generator** variables change:

```env
LLM_PROVIDER=ollama
LLM_MODE=upv
OLLAMA_API_URL_UPV=https://ollama.gti-ia.upv.es:443
OLLAMA_MODEL=qwen2.5
OLLAMA_CLASSIFIER_MODEL=qwen2.5
# embeddings stay constant (nomic-embed-text via PoliGPT) so retrieval is comparable
EMBEDDING_PROVIDER=openai
POLIGPT_EMBED_MODEL=nomic-embed-text
```

Procedure per model: copy the template's generator block into `backend/.env`, restart the backend, run `benchmark_rag.py`, and keep the timestamped results.

---

## PCA — Architecture Comparison

**Folder:** `evaluation/pca/`

The benchmark results across models/architectures are flattened by `prepare_pca_data.py` and analyzed with **Principal Component Analysis** in `pca_1_resultados_buenos_550.ipynb`. This projects the multi-metric scores (Socraticity, conceptual precision, consistency, hallucination, CoT, efficiency) into 2D to visualize how the architectures separate — including the rule-based variant versus the qwen2.5-driven variants (the combined datasets under `pca/data/`, e.g. `Datos_spider_rulebase.xlsx`, `Datos_spider_qwen25_combined.xlsx`). The output feeds the architecture comparison report.

---

## How to Run

### Prerequisites
- The backend must be running and reachable at `BACKEND_URL` (default `http://localhost:3030`), with `DEV_BYPASS_AUTH=true`, PostgreSQL, ChromaDB ingested, and the chosen generator configured.
- Python deps: `pip install numpy pandas requests openpyxl urllib3`.

### Run the benchmark
```bash
cd evaluation/rag_benchmark/script
# optional: BACKEND_URL=http://localhost:3030
python benchmark_rag.py
# if exercise auto-mapping fails, pass DB ids explicitly:
python benchmark_rag.py --exercise-map '{"1":"<db_id>","3":"<db_id>", ...}'
```

### Prepare PCA data + analyze
```bash
python prepare_pca_data.py            # build PCA-ready tables from results/
# then open evaluation/pca/pca_1_resultados_buenos_550.ipynb
```

---

## Interpreting Results

| Metric | Good | Concern |
|---|---|---|
| Socraticity (1–5) | ≥ 4 average | ≤ 2 means the tutor tells instead of asks |
| Conceptual precision (1–5) | ≥ 4 average | ≤ 2 means vague or physically wrong diagnoses |
| Consistency (1–5) | ≥ 4 average | ≤ 2 means responses ignore what the student said |
| AC coverage | high (detected ≈ expected) | low means the tutor misses the student's misconception |
| Hallucination rate | near 0 | any non-trivial rate is a safety concern |
| Latency | ≤ 3 s optimal, ≤ 5 s acceptable | above 5 s hurts the interactive experience |

When scores are low, likely causes and fixes:

1. **Low Socraticity** — the LLM is confirming or explaining. Strengthen the `[RESPONSE MODE]` hint, lower temperature, or rely more on the pedagogical reviewer/guardrails.
2. **Low conceptual precision** — retrieval isn't surfacing the right AC; check the knowledge graph and per-exercise `acPatterns`, or the CRAG threshold.
3. **AC coverage gaps** — the AC keyword lists or patterns may need to match how the model actually phrases the concept.
4. **High latency** — the LLM call dominates; reduce `OLLAMA_NUM_PREDICT`, increase `OLLAMA_KEEP_ALIVE`, or check the provider.

For the pipeline internals that produce these responses, see [rag-system.md](rag-system.md).
