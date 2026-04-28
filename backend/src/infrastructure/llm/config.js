// This is the central configuration for the Agentic RAG system 

const path = require("path");

// Ollama base URL — respeta LLM_MODE para no llamar a la UPV en local.
// (Antes la lista de fallback empezaba por OLLAMA_API_URL_UPV: si la variable
// estaba seteada — como en cualquier .env heredado de producción — el
// adapter intentaba llamar a la UPV en local y devolvía 404.)
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

module.exports = {
  // ChromaDB URL
  CHROMA_URL: process.env.CHROMA_URL || "http://localhost:8000",

  // Embedding model
  EMBEDDING_MODEL: process.env.RAG_EMBEDDING_MODEL || "nomic-embed-text:latest",
  OLLAMA_EMBED_URL: ollamaBaseUrl,

  // LLM URL and model config 
  OLLAMA_CHAT_URL: ollamaBaseUrl,
  OLLAMA_MODEL: process.env.OLLAMA_MODEL || "qwen2.5:latest",
  OLLAMA_TEMPERATURE: Number(process.env.OLLAMA_TEMPERATURE || 0.4),
  OLLAMA_NUM_CTX: Number(process.env.OLLAMA_NUM_CTX || 8192),
  OLLAMA_NUM_PREDICT: Number(process.env.OLLAMA_NUM_PREDICT || 120),
  OLLAMA_KEEP_ALIVE: process.env.OLLAMA_KEEP_ALIVE || "60m",

  // RAG thresholds for the similarity score for the retrieval process
  HIGH_THRESHOLD: Number(process.env.RAG_HIGH_THRESHOLD || 0.7),
  MED_THRESHOLD: Number(process.env.RAG_MED_THRESHOLD || 0.4),

  // Retrieval parameters for the RAG system
  TOP_K_RETRIEVAL: 10,
  TOP_K_FINAL: 3,
  RRF_K: 60,
  BM25_K1: 1.5,
  BM25_B: 0.75,

  // History messages max length for the conversation
  HISTORY_MAX_MESSAGES: Number(process.env.HISTORY_MAX_MESSAGES || 8),

  // File paths for the datasets and the knowledge graph
  // __dirname = backend/src/infrastructure/llm/ → need 4 levels up to reach project root
  DATASETS_DIR: path.join(
    __dirname, "..", "..", "..", "..",
    "material-complementario", "llm", "datasets"
  ),
  KG_PATH: path.join(
    __dirname, "..", "..", "..", "..",
    "material-complementario", "llm", "knowledge-graph",
    "knowledge-graph-with-interactions-and-rewards.json"
  ),
  LOG_DIR: path.join(__dirname, "..", "..", "logs", "rag"),

  // Dataset file mapping (exercise number → file name)
  // Exercise 2 uses the same dataset as exercise 1
  EXERCISE_DATASET_MAP: {
    1: "dataset_exercise_1.json",
    2: "dataset_exercise_1.json",
    3: "dataset_exercise_3.json",
    4: "dataset_exercise_4.json",
    5: "dataset_exercise_5.json",
    6: "dataset_exercise_6.json",
    7: "dataset_exercise_7.json",
  },

  // Loop-breaking: max consecutive wrong classifications before forcing scaffold
  MAX_WRONG_STREAK: Number(process.env.RAG_MAX_WRONG_STREAK || 4),
  // Loop-breaking: max total assistant turns before forcing stronger hints
  MAX_TOTAL_TURNS: Number(process.env.RAG_MAX_TOTAL_TURNS || 16),

  // Feature flag to enable/disable RAG
  RAG_ENABLED: process.env.RAG_ENABLED !== "false",
};
