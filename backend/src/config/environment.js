"use strict";

require("dotenv").config();

/**
 * Centralized, validated environment configuration.
 * All environment variables are accessed through this module.
 */
const config = {
  // --- Database ---
  // Tras la migración Mongo→PG (abril 2026) el único valor soportado es
  // "postgresql". Cambiar el default evita que un .env sin esta variable
  // arranque en modo Mongo (que ya no existe) y lance un error confuso en
  // container.initialize().
  DATABASE_TYPE: process.env.DATABASE_TYPE || "postgresql",
  PG_CONNECTION_STRING: process.env.PG_CONNECTION_STRING || null,

  // --- Server ---
  PORT: parseInt(process.env.PORT, 10) || 3001,
  NODE_ENV: process.env.NODE_ENV || "development",
  SESSION_SECRET: process.env.SESSION_SECRET,
  SERVER_BASE_URL: process.env.SERVER_BASE_URL || "",
  FRONTEND_BASE_URL: process.env.FRONTEND_BASE_URL || "",

  // --- Ollama / LLM ---
  LLM_MODE: process.env.LLM_MODE || "local",
  OLLAMA_API_URL_UPV: process.env.OLLAMA_API_URL_UPV || "",
  OLLAMA_API_URL_LOCAL:
    process.env.OLLAMA_API_URL_LOCAL || "http://127.0.0.1:11434",
  OLLAMA_MODEL: process.env.OLLAMA_MODEL || "qwen2.5:latest",
  OLLAMA_NUM_CTX: parseInt(process.env.OLLAMA_NUM_CTX, 10) || 4096,
  OLLAMA_NUM_PREDICT: parseInt(process.env.OLLAMA_NUM_PREDICT, 10) || 256,
  OLLAMA_TEMPERATURE: parseFloat(process.env.OLLAMA_TEMPERATURE) || 0.4,
  HISTORY_MAX_MESSAGES: parseInt(process.env.HISTORY_MAX_MESSAGES, 10) || 6,
  OLLAMA_KEEP_ALIVE: process.env.OLLAMA_KEEP_ALIVE || "60m",
  OLLAMA_STREAM_MAX_MS:
    parseInt(process.env.OLLAMA_STREAM_MAX_MS, 10) || 1800000,
  OLLAMA_TIMEOUT_MS: parseInt(process.env.OLLAMA_TIMEOUT_MS, 10) || 180000,
  OLLAMA_CLASSIFIER_MODEL:
    process.env.OLLAMA_CLASSIFIER_MODEL || "qwen2.5:latest",
  OLLAMA_CLASSIFIER_TIMEOUT_MS:
    parseInt(process.env.OLLAMA_CLASSIFIER_TIMEOUT_MS, 10) || 120000,
  OLLAMA_INSECURE_TLS: process.env.OLLAMA_INSECURE_TLS === "1",
  DEBUG_OLLAMA: process.env.DEBUG_OLLAMA === "1",
  DEBUG_DUMP_CONTEXT: process.env.DEBUG_DUMP_CONTEXT === "1",
  DEBUG_DUMP_PATH: process.env.DEBUG_DUMP_PATH || "",

  // --- CAS OAuth2 ---
  CAS_BASE_URL: process.env.CAS_BASE_URL || "",
  OAUTH_CLIENT_ID: process.env.OAUTH_CLIENT_ID || "",
  OAUTH_CLIENT_SECRET: process.env.OAUTH_CLIENT_SECRET || "",
  OAUTH_REDIRECT_URI: process.env.OAUTH_REDIRECT_URI || "",
  OAUTH_SCOPES: process.env.OAUTH_SCOPES || "profile email",
  DEV_BYPASS_AUTH: process.env.DEV_BYPASS_AUTH === "true",

  // --- ChromaDB ---
  CHROMA_URL: process.env.CHROMA_URL || "http://localhost:8000",

  // --- Computed ---
  get OLLAMA_API_URL() {
    return this.LLM_MODE === "upv"
      ? this.OLLAMA_API_URL_UPV
      : this.OLLAMA_API_URL_LOCAL;
  },

  get isProduction() {
    return this.NODE_ENV === "production";
  },
};

module.exports = config;
