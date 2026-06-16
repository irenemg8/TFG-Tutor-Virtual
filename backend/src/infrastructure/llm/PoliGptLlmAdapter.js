"use strict";

const axios = require("axios");
const https = require("https");
const ILlmService = require("../../domain/ports/services/ILlmService");
const { BudgetExhaustedError } = require("../../domain/ports/services/ILlmService");
const config = require("./config");

/*------------------------------------------------------------------------------
            _________________________________________________________
            |                  POLIGPT LLM ADAPTER                  |
            |  ILlmService backed by the OpenAI-compatible PoliGPT  |
            |  API (LiteLLM proxy). Uses axios over POST            |
            |  /v1/chat/completions + SSE, Bearer auth, top-level   |
            |  sampling params, and keep_alive to fight cold-start. |
        ____|________________                                       |
   Obj -> | constructor() | -> PoliGptLlmAdapter     (writes attrs) |
          -----------------                                         |
            |                                                       |
            |   baseUrl: Txt           apiKey: Txt                  |
            |   model: Txt             defaultTemperature: R        |
            |   defaultMaxTokens: Z    keepAlive: Txt               |
            |   defaultTimeoutMs: Z    httpsAgent: Obj | null       |
        ____|_____________                                          |
        | _headers() | -> Obj                    (reads attrs)      |
        -------------                                               |
        ____|________________                                       |
        | _axiosOpts() | -> Obj                  (reads attrs)      |
        ---------------                                             |
        ____|____________________                                   |
        | _resolveTimeout() | -> Z               (reads attrs)      |
        --------------------                                        |
        ____|__________________                                     |
        | _buildPayload() | -> Obj               (reads attrs)      |
        ------------------                                          |
        ____|___________________                                    |
        | chatCompletion() | -> Promise<Txt>     (reads attrs)      |
        -------------------                                         |
        ____|_________________________                              |
        | chatCompletionStream() | -> Promise<Obj>  (reads attrs)   |
        -------------------------                                   |
        ____|_____________________________________                  |
        | chatCompletionStreamWithCallback() | -> Promise<Txt>      |
        -------------------------------------                       |
        ____|______________                                         |
        | isHealthy() | -> Promise<T/F>          (reads attrs)      |
        --------------                                              |
            |                                                       |
            |_______________________________________________________|
------------------------------------------------------------------------------*/
class PoliGptLlmAdapter extends ILlmService {
  /*
   Obj -> ____|________________
         | constructor() | -> PoliGptLlmAdapter    (writes attributes baseUrl (Txt),
          -----------------                         apiKey (Txt), model (Txt),
                                                    defaultTemperature (R), defaultMaxTokens (Z),
                                                    keepAlive (Txt), defaultTimeoutMs (Z),
                                                    httpsAgent (Obj|null))
      Builds the adapter from an options object, defaulting to config,
      warning on missing key/url and stripping a trailing slash. keepAlive
      keeps the model resident to avoid the 30-150s cold reload. Builds one
      reusable keep-alive HTTPS agent for the hot chat path.
  */
  constructor(opts) {
    super();
    opts = opts || {};
    this.baseUrl = opts.baseUrl || config.POLIGPT_BASE_URL;
    this.apiKey = opts.apiKey || config.POLIGPT_API_KEY;
    this.model = opts.model || config.POLIGPT_MODEL;
    this.defaultTemperature = opts.temperature != null ? opts.temperature : config.OLLAMA_TEMPERATURE;
    this.defaultMaxTokens = opts.maxTokens != null ? opts.maxTokens : config.OLLAMA_NUM_PREDICT;
    this.keepAlive = opts.keepAlive != null ? opts.keepAlive : config.OLLAMA_KEEP_ALIVE;
    this.defaultTimeoutMs = opts.timeoutMs != null
      ? opts.timeoutMs
      : Number(process.env.OLLAMA_TIMEOUT_MS || 60000);

    if (!this.apiKey) {
      console.warn("[PoliGptLlmAdapter] POLIGPT_API_KEY is not set — chat calls will return 401.");
    }
    if (!this.baseUrl) {
      console.warn("[PoliGptLlmAdapter] POLIGPT_BASE_URL is not set — defaulting to https://api.poligpt.upv.es");
      this.baseUrl = "https://api.poligpt.upv.es";
    }
    this.baseUrl = String(this.baseUrl).replace(/\/+$/, "");

    this.httpsAgent = this.baseUrl.startsWith("https://")
      ? new https.Agent({
          rejectUnauthorized: true,
          keepAlive: true,
          keepAliveMsecs: 30000,
          maxSockets: 10,
        })
      : null;
  }

  /*
       ____|_____________
      | _headers() | -> Obj    (reads attribute apiKey (Txt))
       -------------
      Builds the request headers, adding a Bearer Authorization header
      when an API key is set.
  */
  _headers() {
    const h = { "Content-Type": "application/json" };
    if (this.apiKey) h["Authorization"] = "Bearer " + this.apiKey;
    return h;
  }

  /*
   Z, Obj -> ____|________________
            | _axiosOpts() | -> Obj    (reads attributes httpsAgent (Obj|null), apiKey (Txt))
             ---------------
      Builds the axios request options with headers, the cached HTTPS
      agent and the abort signal when present.
  */
  _axiosOpts(timeoutMs, abortSignal) {
    const base = { timeout: timeoutMs, headers: this._headers() };
    if (this.httpsAgent) base.httpsAgent = this.httpsAgent;
    if (abortSignal) base.signal = abortSignal;
    return base;
  }

  /*
   Z -> ____|____________________
       | _resolveTimeout() | -> Z    (reads attribute defaultTimeoutMs (Z))
        --------------------
      Returns the default timeout, or the smaller of it and the budget
      when a positive budget is given.
  */
  _resolveTimeout(budgetMs) {
    if (budgetMs == null || budgetMs <= 0) return this.defaultTimeoutMs;
    return Math.min(this.defaultTimeoutMs, budgetMs);
  }

  /*
   [Obj], Obj, T/F -> ____|__________________
                     | _buildPayload() | -> Obj    (reads attributes model (Txt),
                      ------------------            defaultTemperature (R), defaultMaxTokens (Z),
                                                    keepAlive (Txt))
      Builds the OpenAI-style request body, sending keep_alive on every
      call so the idle timer resets each turn.
  */
  _buildPayload(messages, options, stream) {
    options = options || {};
    return {
      model: options.model || this.model,
      messages: messages,
      stream: !!stream,
      temperature: options.temperature != null ? options.temperature : this.defaultTemperature,
      max_tokens: options.numPredict != null
        ? options.numPredict
        : (options.maxTokens != null ? options.maxTokens : this.defaultMaxTokens),
      keep_alive: options.keepAlive != null ? options.keepAlive : this.keepAlive,
    };
  }

  /*
   [Obj], Obj -> ____|___________________
                | chatCompletion() | -> Promise<Txt>    (reads attribute baseUrl (Txt))
                 -------------------
      Posts a non-streaming chat request and resolves the assistant
      content. Maps timeout/abort to BudgetExhaustedError when a budget
      was set.
  */
  async chatCompletion(messages, options) {
    options = options || {};
    const timeoutMs = this._resolveTimeout(options.budgetMs);
    const startMs = Date.now();
    const payload = this._buildPayload(messages, options, false);

    try {
      const resp = await axios.post(
        this.baseUrl + "/v1/chat/completions",
        payload,
        this._axiosOpts(timeoutMs, options.abort)
      );
      const choice = resp.data && resp.data.choices && resp.data.choices[0];
      const content = (choice && choice.message && choice.message.content) || "";
      return content;
    } catch (err) {
      if (
        options.budgetMs != null &&
        (err.code === "ECONNABORTED" || err.message === "canceled" || err.name === "CanceledError")
      ) {
        throw new BudgetExhaustedError(
          "PoliGPT call exceeded budget (" + options.budgetMs + "ms, elapsed " + (Date.now() - startMs) + "ms)",
          { baseUrl: this.baseUrl, model: payload.model, budgetMs: options.budgetMs }
        );
      }
      throw err;
    }
  }

  /*
   [Obj], Obj -> ____|_________________________
                | chatCompletionStream() | -> Promise<Obj>    (reads attribute baseUrl (Txt))
                 -------------------------
      Posts a streaming chat request and resolves the raw SSE response
      stream. No timeout unless a budget is given.
  */
  async chatCompletionStream(messages, options) {
    options = options || {};
    const timeoutMs = options.budgetMs != null ? this._resolveTimeout(options.budgetMs) : 0;
    const payload = this._buildPayload(messages, options, true);
    const opts = Object.assign(
      this._axiosOpts(timeoutMs, options.abort),
      { responseType: "stream" }
    );
    const resp = await axios.post(this.baseUrl + "/v1/chat/completions", payload, opts);
    return resp.data;
  }

  /*
   [Obj], Obj, Fn -> ____|_____________________________________
                    | chatCompletionStreamWithCallback() | -> Promise<Txt>    (reads attributes
                     -------------------------------------                      baseUrl (Txt), model (Txt))
      Parses OpenAI SSE deltas, calls onChunk(token) per content piece
      and resolves the accumulated full text. Buffers across TCP segments
      and maps abort to BudgetExhaustedError when a budget was set.
  */
  async chatCompletionStreamWithCallback(messages, options, onChunk) {
    options = options || {};
    const callback = typeof onChunk === "function" ? onChunk : null;
    const startMs = Date.now();
    const model = (options.model || this.model);

    let stream;
    try {
      stream = await this.chatCompletionStream(messages, options);
    } catch (err) {
      if (
        options.budgetMs != null &&
        (err.code === "ECONNABORTED" || err.message === "canceled" || err.name === "CanceledError")
      ) {
        throw new BudgetExhaustedError(
          "PoliGPT stream call exceeded budget (" + options.budgetMs + "ms, elapsed " + (Date.now() - startMs) + "ms)",
          { baseUrl: this.baseUrl, model: model, budgetMs: options.budgetMs }
        );
      }
      throw err;
    }

    return await new Promise((resolve, reject) => {
      let buffer = "";
      let fullText = "";
      let settled = false;

      const finish = (err) => {
        if (settled) return;
        settled = true;
        try { stream.removeAllListeners(); } catch (_) {}
        if (err) return reject(err);
        resolve(fullText);
      };

      const handleSseEvent = (raw) => {
        const lines = raw.split("\n");
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          if (!line.startsWith("data:")) continue;
          const payload = line.slice(5).trim();
          if (!payload) continue;
          if (payload === "[DONE]") {
            finish(null);
            return;
          }
          let parsed;
          try { parsed = JSON.parse(payload); } catch (_) { continue; }
          const choice = parsed && parsed.choices && parsed.choices[0];
          const delta = choice && choice.delta;
          const piece = (delta && typeof delta.content === "string") ? delta.content : "";
          if (piece) {
            fullText += piece;
            if (callback) {
              try { callback(piece); } catch (_) {}
            }
          }
        }
      };

      stream.on("data", (raw) => {
        if (settled) return;
        buffer += raw.toString("utf8");
        let sep;
        while ((sep = buffer.indexOf("\n\n")) >= 0) {
          const evt = buffer.slice(0, sep);
          buffer = buffer.slice(sep + 2);
          if (evt.trim()) handleSseEvent(evt);
        }
      });

      stream.on("end", () => {
        if (buffer.trim()) handleSseEvent(buffer);
        finish(null);
      });

      stream.on("error", (err) => {
        if (
          options.budgetMs != null &&
          (err.code === "ECONNABORTED" || err.message === "canceled" || err.name === "CanceledError")
        ) {
          return finish(
            new BudgetExhaustedError(
              "PoliGPT stream call exceeded budget (" + options.budgetMs + "ms, elapsed " + (Date.now() - startMs) + "ms)",
              { baseUrl: this.baseUrl, model: model, budgetMs: options.budgetMs }
            )
          );
        }
        finish(err);
      });
    });
  }

  /*
       ____|______________
      | isHealthy() | -> Promise<T/F>    (reads attribute baseUrl (Txt))
       --------------
      True when GET /v1/models returns HTTP 200, false on any error.
  */
  async isHealthy() {
    try {
      const r = await axios.get(
        this.baseUrl + "/v1/models",
        this._axiosOpts(3000)
      );
      return r.status === 200;
    } catch (_) {
      return false;
    }
  }
}

module.exports = PoliGptLlmAdapter;
