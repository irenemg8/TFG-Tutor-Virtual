// Generates text embeddings against either Ollama (/api/embed) or any
// OpenAI-compatible endpoint (/v1/embeddings — e.g. PoliGPT/LiteLLM).
//
// The provider is selected by config.EMBEDDING_PROVIDER:
//   - "ollama"  → POST <OLLAMA_EMBED_URL>/api/embed     body: {model, input}
//                 response: {embeddings: [[...]]}
//   - "openai"  → POST <POLIGPT_BASE_URL>/v1/embeddings body: {model, input}
//                 response: {data: [{embedding: [...]}]}
//
// Same exported API in both cases (generateEmbedding/generateEmbeddings),
// so the rest of the RAG pipeline is provider-agnostic.

const axios = require("axios");
const https = require("https");
const config = require("../llm/config");

const provider = config.EMBEDDING_PROVIDER || "ollama";

function isOpenAI() {
  return provider === "openai" || provider === "poligpt";
}

function endpointUrl() {
  if (isOpenAI()) {
    return config.POLIGPT_BASE_URL + "/v1/embeddings";
  }
  return config.OLLAMA_EMBED_URL + "/api/embed";
}

function modelName() {
  if (isOpenAI()) return config.POLIGPT_EMBED_MODEL;
  return config.EMBEDDING_MODEL;
}

// Reuse one HTTPS agent. Insecure TLS only honored for Ollama (PoliGPT
// is a managed UPV endpoint with a valid cert and we want strict checks).
const httpsAgentInsecure = new https.Agent({ rejectUnauthorized: false });
const httpsAgentSecure = new https.Agent({
  rejectUnauthorized: true,
  keepAlive: true,
  keepAliveMsecs: 30000,
  maxSockets: 10,
});

function axiosOpts(extra) {
  const url = endpointUrl();
  const o = Object.assign({}, extra || {});
  if (url.startsWith("https://")) {
    o.httpsAgent = isOpenAI() ? httpsAgentSecure : httpsAgentInsecure;
  }
  if (isOpenAI() && config.POLIGPT_API_KEY) {
    o.headers = Object.assign({}, o.headers || {}, {
      "Authorization": "Bearer " + config.POLIGPT_API_KEY,
    });
  }
  return o;
}

function extractSingleVector(data) {
  if (isOpenAI()) {
    return data && data.data && data.data[0] && data.data[0].embedding;
  }
  return data && data.embeddings && data.embeddings[0];
}

function extractBatchVectors(data) {
  if (isOpenAI()) {
    return (data && data.data || []).map((d) => d.embedding);
  }
  return (data && data.embeddings) || [];
}

// Generate a single embedding vector for the given text.
// `options.signal` lets the retrieval pipeline abort the embedding call when
// the per-stage budget runs out, freeing up time for the tutor LLM.
async function generateEmbedding(text, options) {
  options = options || {};
  const reqConfig = axiosOpts({ timeout: 30000 });
  if (options.signal) reqConfig.signal = options.signal;
  const response = await axios.post(
    endpointUrl(),
    { model: modelName(), input: text },
    reqConfig
  );
  return extractSingleVector(response.data);
}

// Generate embeddings for multiple texts in a single call.
async function generateEmbeddings(texts) {
  const response = await axios.post(
    endpointUrl(),
    { model: modelName(), input: texts },
    axiosOpts({ timeout: 120000 })
  );
  return extractBatchVectors(response.data);
}

module.exports = { generateEmbedding, generateEmbeddings };
