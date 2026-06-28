const axios = require("axios");
const https = require("https");
const config = require("../llm/config");

/*------------------------------------------------------------------------------
            _________________________________________________________
            |                       EMBEDDINGS                      |
            |  Generates text embeddings against either Ollama      |
            |  (/api/embed) or any OpenAI-compatible endpoint       |
            |  (/v1/embeddings, e.g. PoliGPT/LiteLLM). The provider |
            |  is chosen by config.EMBEDDING_PROVIDER; the exported |
            |  API is identical so the RAG pipeline stays agnostic. |
            |                                                       |
            |          -> | isOpenAI()      | -> T/F                |
            |          -> | endpointUrl()   | -> Txt                |
            |          -> | modelName()     | -> Txt                |
            |        Obj -> | axiosOpts()    | -> Obj                |
            |        Obj -> | extractSingleVector() | -> [R]         |
            |        Obj -> | extractBatchVectors() | -> [[R]]       |
            |   Txt, Obj -> | generateEmbedding()   | -> Promise<[R]>   |
            |      [Txt] -> | generateEmbeddings()  | -> Promise<[[R]]> |
            |_______________________________________________________|
------------------------------------------------------------------------------*/

const provider = config.EMBEDDING_PROVIDER || "ollama";

/*
       ____|___________
      | isOpenAI() | -> T/F
       -------------
      True when the configured provider speaks the OpenAI embeddings
      format ("openai" or "poligpt").
*/
function isOpenAI() {
  return provider === "openai" || provider === "poligpt";
}

/*
       ____|______________
      | endpointUrl() | -> Txt
       ----------------
      Returns the embeddings endpoint URL for the active provider.
*/
function endpointUrl() {
  if (isOpenAI()) {
    return config.POLIGPT_BASE_URL + "/v1/embeddings";
  }
  return config.OLLAMA_EMBED_URL + "/api/embed";
}

/*
       ____|____________
      | modelName() | -> Txt
       -------------
      Returns the embedding model name for the active provider.
*/
function modelName() {
  if (isOpenAI()) return config.POLIGPT_EMBED_MODEL;
  return config.EMBEDDING_MODEL;
}

const httpsAgentInsecure = new https.Agent({ rejectUnauthorized: false });
const httpsAgentSecure = new https.Agent({
  rejectUnauthorized: true,
  keepAlive: true,
  keepAliveMsecs: 30000,
  maxSockets: 10,
});

/*
   Obj -> ____|_____________
         | axiosOpts() | -> Obj
          --------------
      Builds axios options for the active provider: selects the secure
      or insecure HTTPS agent and adds the Bearer header for OpenAI.
*/
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

/*
   Obj -> ____|_______________________
         | extractSingleVector() | -> [R]
          ------------------------
      Pulls the single embedding vector out of the provider response.
*/
function extractSingleVector(data) {
  if (isOpenAI()) {
    return data && data.data && data.data[0] && data.data[0].embedding;
  }
  return data && data.embeddings && data.embeddings[0];
}

/*
   Obj -> ____|_______________________
         | extractBatchVectors() | -> [[R]]
          ------------------------
      Pulls the list of embedding vectors out of the provider response.
*/
function extractBatchVectors(data) {
  if (isOpenAI()) {
    return (data && data.data || []).map((d) => d.embedding);
  }
  return (data && data.embeddings) || [];
}

/*
   Txt, Obj -> ____|____________________
              | generateEmbedding() | -> Promise<[R]>
               ---------------------
      Posts the text to the embeddings endpoint and resolves its single
      vector. options.signal lets the pipeline abort the call when the
      per-stage budget runs out.
*/
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

/*
   [Txt] -> ____|_____________________
           | generateEmbeddings() | -> Promise<[[R]]>
            ----------------------
      Posts all texts in a single call and resolves their embedding
      vectors.
*/
async function generateEmbeddings(texts) {
  const response = await axios.post(
    endpointUrl(),
    { model: modelName(), input: texts },
    axiosOpts({ timeout: 120000 })
  );
  return extractBatchVectors(response.data);
}

module.exports = { generateEmbedding, generateEmbeddings };
