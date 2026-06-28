const path = require("path");

/*------------------------------------------------------------------------------
            _________________________________________________________
            |                         CONFIG                        |
            |  Central configuration for the Agentic RAG system.    |
            |  Reads environment variables, applies defaults and    |
            |  exports a single frozen settings object.             |
            |                                                       |
            |  Resolves the Ollama chat/embed URLs from LLM_MODE,   |
            |  picks the LLM and embedding providers, RAG           |
            |  thresholds and retrieval parameters, dataset and     |
            |  knowledge-graph paths, the exercise->dataset map and |
            |  its canonical-number derivation, loop-breaking       |
            |  limits and the RAG feature flag.                     |
            |                                                       |
            |          -> | module.exports | -> Obj                 |
            |_______________________________________________________|
------------------------------------------------------------------------------*/
const llmMode = (process.env.LLM_MODE || "local").toLowerCase();
const ollamaBaseUrl = llmMode === "upv"
  ? (process.env.OLLAMA_API_URL_UPV ||
     process.env.OLLAMA_BASE_URL_UPV ||
     process.env.OLLAMA_API_URL ||
     process.env.OLLAMA_BASE_URL ||
     "http://127.0.0.1:11434")
  : (process.env.OLLAMA_API_URL_LOCAL ||
     process.env.OLLAMA_API_URL ||
     process.env.OLLAMA_BASE_URL ||
     "http://127.0.0.1:11434");

const ollamaEmbedUrl = process.env.OLLAMA_EMBED_URL || ollamaBaseUrl;

module.exports = {
  CHROMA_URL: process.env.CHROMA_URL || "http://localhost:8000",

  LLM_PROVIDER: (process.env.LLM_PROVIDER || "ollama").toLowerCase(),
  EMBEDDING_PROVIDER: (
    process.env.EMBEDDING_PROVIDER ||
    (process.env.LLM_PROVIDER === "poligpt" ? "openai" : "ollama")
  ).toLowerCase(),

  EMBEDDING_MODEL: process.env.RAG_EMBEDDING_MODEL || "nomic-embed-text:latest",
  OLLAMA_EMBED_URL: ollamaEmbedUrl,

  OLLAMA_CHAT_URL: ollamaBaseUrl,
  OLLAMA_MODEL: process.env.OLLAMA_MODEL || "qwen2.5:latest",
  OLLAMA_TEMPERATURE: Number(process.env.OLLAMA_TEMPERATURE || 0.4),
  OLLAMA_NUM_CTX: Number(process.env.OLLAMA_NUM_CTX || 8192),
  OLLAMA_NUM_PREDICT: Number(process.env.OLLAMA_NUM_PREDICT || 220),
  OLLAMA_KEEP_ALIVE: process.env.OLLAMA_KEEP_ALIVE || "60m",

  POLIGPT_BASE_URL: (process.env.POLIGPT_BASE_URL || "https://api.poligpt.upv.es").replace(/\/+$/, ""),
  POLIGPT_API_KEY: process.env.POLIGPT_API_KEY || "",
  POLIGPT_MODEL: process.env.POLIGPT_MODEL || "qwen3:32b",
  POLIGPT_EMBED_MODEL: process.env.POLIGPT_EMBED_MODEL || "nomic-embed-text",

  HIGH_THRESHOLD: Number(process.env.RAG_HIGH_THRESHOLD || 0.7),
  MED_THRESHOLD: Number(process.env.RAG_MED_THRESHOLD || 0.4),

  TOP_K_RETRIEVAL: 10,
  TOP_K_FINAL: 2,
  RRF_K: 60,
  BM25_K1: 1.5,
  BM25_B: 0.75,

  HISTORY_MAX_MESSAGES: Number(process.env.HISTORY_MAX_MESSAGES || 20),

  DATASETS_DIR: path.join(__dirname, "..", "..", "data", "datasets"),
  KG_PATH: path.join(
    __dirname, "..", "..", "data", "knowledge-graph",
    "knowledge-graph-with-interactions-and-rewards.json"
  ),
  LOG_DIR: path.join(__dirname, "..", "..", "logs", "rag"),

  EXERCISE_DATASET_MAP: {
    1: "dataset_exercise_1.json",
    2: "dataset_exercise_1.json",
    3: "dataset_exercise_3.json",
    4: "dataset_exercise_4.json",
    5: "dataset_exercise_5.json",
    6: "dataset_exercise_6.json",
    7: "dataset_exercise_7.json",
  },

  CANONICAL_EXERCISE_MAP: (() => {
    const datasetMap = {
      1: "dataset_exercise_1.json",
      2: "dataset_exercise_1.json",
      3: "dataset_exercise_3.json",
      4: "dataset_exercise_4.json",
      5: "dataset_exercise_5.json",
      6: "dataset_exercise_6.json",
      7: "dataset_exercise_7.json",
    };
    const fileToFirst = {};
    const canonical = {};
    for (const [num, file] of Object.entries(datasetMap)) {
      const n = Number(num);
      if (fileToFirst[file] == null) fileToFirst[file] = n;
      canonical[n] = fileToFirst[file];
    }
    return canonical;
  })(),

  MAX_WRONG_STREAK: Number(process.env.RAG_MAX_WRONG_STREAK || 4),
  MAX_TOTAL_TURNS: Number(process.env.RAG_MAX_TOTAL_TURNS || 16),

  RAG_ENABLED: process.env.RAG_ENABLED !== "false",
};
