// Generates text embeddings using Ollama with the nomic-embed-text model

const axios = require("axios"); // make HTTP requests to the Ollama API
const https = require("https"); // handle HTTPS requests
const config = require("../llm/config"); // RAG config

// Reuse the same HTTPS handling pattern as the existing ollamaChatRoutes
const httpsAgent = new https.Agent({ rejectUnauthorized: false });

function axiosOpts() {
  if (config.OLLAMA_EMBED_URL.startsWith("https://")) {
    return { httpsAgent };
  }
  return {};
}

// Generate a single embedding vector for the given text -> Returns an array of 768 dimensions for nomic-embed-text
// `options.signal` lets the retrieval pipeline abort the embedding call when
// the per-stage budget runs out, freeing up time for the tutor LLM.
async function generateEmbedding(text, options) {
  options = options || {};
  const reqConfig = { timeout: 30000, ...axiosOpts() };
  if (options.signal) reqConfig.signal = options.signal;
  const response = await axios.post(
    `${config.OLLAMA_EMBED_URL}/api/embed`,
    {
      model: config.EMBEDDING_MODEL,
      input: text,
    },
    reqConfig
  );
  return response.data.embeddings[0];
}

// Generate embeddings for multiple texts in a single call -> Returns an array of embedding vectors
async function generateEmbeddings(texts) {
  const response = await axios.post(
    `${config.OLLAMA_EMBED_URL}/api/embed`,
    {
      model: config.EMBEDDING_MODEL,
      input: texts,
    },
    { timeout: 120000, ...axiosOpts() }
  );
  return response.data.embeddings;
}

module.exports = { generateEmbedding, generateEmbeddings };

