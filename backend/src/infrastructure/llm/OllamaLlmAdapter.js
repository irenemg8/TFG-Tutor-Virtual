"use strict";

const axios = require("axios");
const https = require("https");
const ILlmService = require("../../domain/ports/services/ILlmService");
const { BudgetExhaustedError } = require("../../domain/ports/services/ILlmService");
const config = require("./config");

/*------------------------------------------------------------------------------
            _________________________________________________________
            |                   OLLAMA LLM ADAPTER                  |
            |  Concrete ILlmService backed by an Ollama server.     |
            |  Budget-aware (timeout = min(cfg, budget)), abort and |
            |  baseUrl overridable, TLS honors OLLAMA_INSECURE_TLS. |
            |  Does NOT retry — retry is a GuardrailPipeline job.   |
        ____|________________                                       |
   Obj -> | constructor() | -> OllamaLlmAdapter      (writes attrs) |
          -----------------                                         |
            |                                                       |
            |   baseUrl: Txt           model: Txt                   |
            |   defaultTemperature: R  defaultNumPredict: Z         |
            |   defaultNumCtx: Z       keepAlive: Txt               |
            |   defaultTimeoutMs: Z    insecureTls: T/F             |
            |   httpsAgent: Obj | null                              |
        ____|________________________________________              |
        | _axiosOpts() | -> Obj                  (reads attrs)      |
        ---------------                                             |
        ____|____________________                                   |
        | _resolveTimeout() | -> Z               (reads attrs)      |
        --------------------                                        |
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
class OllamaLlmAdapter extends ILlmService {
  /*
   Obj -> ____|________________
         | constructor() | -> OllamaLlmAdapter    (writes attributes baseUrl (Txt),
          -----------------                        model (Txt), defaultTemperature (R),
                                                   defaultNumPredict (Z), defaultNumCtx (Z),
                                                   keepAlive (Txt), defaultTimeoutMs (Z),
                                                   insecureTls (T/F), httpsAgent (Obj|null))
      Builds the adapter from an options object, defaulting to config.
      Constructs one reusable keep-alive HTTPS agent so each turn skips
      a fresh TLS handshake to the Ollama server.
  */
  constructor(opts) {
    super();
    opts = opts || {};
    this.baseUrl = opts.baseUrl || config.OLLAMA_CHAT_URL;
    this.model = opts.model || config.OLLAMA_MODEL;
    this.defaultTemperature = opts.temperature != null ? opts.temperature : config.OLLAMA_TEMPERATURE;
    this.defaultNumPredict = opts.numPredict != null ? opts.numPredict : config.OLLAMA_NUM_PREDICT;
    this.defaultNumCtx = opts.numCtx != null ? opts.numCtx : config.OLLAMA_NUM_CTX;
    this.keepAlive = opts.keepAlive || config.OLLAMA_KEEP_ALIVE;
    this.defaultTimeoutMs = opts.timeoutMs != null
      ? opts.timeoutMs
      : Number(process.env.OLLAMA_TIMEOUT_MS || 60000);
    this.insecureTls = process.env.OLLAMA_INSECURE_TLS === "1";

    this.httpsAgent = String(this.baseUrl).startsWith("https://")
      ? new https.Agent({
          rejectUnauthorized: !this.insecureTls,
          keepAlive: true,
          keepAliveMsecs: 30000,
          maxSockets: 10,
        })
      : null;
  }

  /*
   Txt, Z, Obj -> ____|____________
                 | _axiosOpts() | -> Obj    (reads attributes baseUrl (Txt),
                  ---------------            httpsAgent (Obj|null), insecureTls (T/F))
      Builds the axios request options. Reuses the cached HTTPS agent
      when the call targets the URL it was built for, attaches the
      abort signal when present.
  */
  _axiosOpts(baseUrl, timeoutMs, abortSignal) {
    const base = { timeout: timeoutMs };
    const targetUrl = String(baseUrl || this.baseUrl);
    if (targetUrl.startsWith("https://")) {
      base.httpsAgent =
        targetUrl === this.baseUrl && this.httpsAgent
          ? this.httpsAgent
          : new https.Agent({ rejectUnauthorized: !this.insecureTls, keepAlive: true });
    }
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
   [Obj], Obj -> ____|___________________
                | chatCompletion() | -> Promise<Txt>    (reads attributes baseUrl (Txt),
                 -------------------                      model (Txt), keepAlive (Txt),
                                                          defaultNumPredict (Z), defaultNumCtx (Z),
                                                          defaultTemperature (R))
      Posts a non-streaming chat request and resolves the assistant
      content. Normalizes timeout/abort into BudgetExhaustedError when
      a budget was set.
  */
  async chatCompletion(messages, options) {
    options = options || {};
    const baseUrl = options.baseUrl || this.baseUrl;
    const model = options.model || this.model;
    const timeoutMs = this._resolveTimeout(options.budgetMs);
    const startMs = Date.now();

    const payload = {
      model: model,
      stream: false,
      keep_alive: options.keepAlive || this.keepAlive,
      messages: messages,
      options: {
        num_predict: options.numPredict != null ? options.numPredict : this.defaultNumPredict,
        num_ctx: options.numCtx != null ? options.numCtx : this.defaultNumCtx,
        temperature: options.temperature != null ? options.temperature : this.defaultTemperature,
      },
    };

    try {
      const resp = await axios.post(
        baseUrl + "/api/chat",
        payload,
        this._axiosOpts(baseUrl, timeoutMs, options.abort)
      );
      const content = (resp.data && resp.data.message && resp.data.message.content) || "";
      return content;
    } catch (err) {
      if (options.budgetMs != null && (err.code === "ECONNABORTED" || err.message === "canceled" || err.name === "CanceledError")) {
        throw new BudgetExhaustedError(
          "Ollama call exceeded budget (" + options.budgetMs + "ms, elapsed " + (Date.now() - startMs) + "ms)",
          { baseUrl: baseUrl, model: model, budgetMs: options.budgetMs }
        );
      }
      throw err;
    }
  }

  /*
   [Obj], Obj -> ____|_________________________
                | chatCompletionStream() | -> Promise<Obj>    (reads attributes baseUrl (Txt),
                 -------------------------                      model (Txt), keepAlive (Txt),
                                                                defaultNumPredict (Z), defaultNumCtx (Z),
                                                                defaultTemperature (R))
      Posts a streaming chat request and resolves the raw NDJSON
      response stream. No timeout unless a budget is given.
  */
  async chatCompletionStream(messages, options) {
    options = options || {};
    const baseUrl = options.baseUrl || this.baseUrl;
    const model = options.model || this.model;
    const timeoutMs = options.budgetMs != null ? this._resolveTimeout(options.budgetMs) : 0;

    const payload = {
      model: model,
      stream: true,
      keep_alive: options.keepAlive || this.keepAlive,
      messages: messages,
      options: {
        num_predict: options.numPredict != null ? options.numPredict : this.defaultNumPredict,
        num_ctx: options.numCtx != null ? options.numCtx : this.defaultNumCtx,
        temperature: options.temperature != null ? options.temperature : this.defaultTemperature,
      },
    };

    const opts = Object.assign(
      this._axiosOpts(baseUrl, timeoutMs, options.abort),
      { responseType: "stream" }
    );
    const resp = await axios.post(baseUrl + "/api/chat", payload, opts);
    return resp.data;
  }

  /*
   [Obj], Obj, Fn -> ____|_____________________________________
                    | chatCompletionStreamWithCallback() | -> Promise<Txt>    (reads attributes
                     -------------------------------------                      baseUrl (Txt), model (Txt))
      Wraps chatCompletionStream, parses Ollama's NDJSON stream, calls
      onChunk(token) per content piece and resolves the accumulated full
      text. Buffers across TCP segments and maps abort to
      BudgetExhaustedError when a budget was set.
  */
  async chatCompletionStreamWithCallback(messages, options, onChunk) {
    options = options || {};
    const callback = typeof onChunk === "function" ? onChunk : null;
    const startMs = Date.now();
    let stream;
    try {
      stream = await this.chatCompletionStream(messages, options);
    } catch (err) {
      if (
        options.budgetMs != null &&
        (err.code === "ECONNABORTED" || err.message === "canceled" || err.name === "CanceledError")
      ) {
        throw new BudgetExhaustedError(
          "Ollama stream call exceeded budget (" + options.budgetMs + "ms, elapsed " + (Date.now() - startMs) + "ms)",
          { baseUrl: options.baseUrl || this.baseUrl, model: options.model || this.model, budgetMs: options.budgetMs }
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

      stream.on("data", (raw) => {
        if (settled) return;
        buffer += raw.toString("utf8");
        let nl;
        while ((nl = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, nl).trim();
          buffer = buffer.slice(nl + 1);
          if (!line) continue;
          let parsed;
          try { parsed = JSON.parse(line); } catch (_) { continue; }
          const piece =
            (parsed && parsed.message && typeof parsed.message.content === "string")
              ? parsed.message.content
              : "";
          if (piece) {
            fullText += piece;
            if (callback) {
              try { callback(piece); } catch (_) {}
            }
          }
          if (parsed && parsed.done === true) {
            return finish(null);
          }
        }
      });

      stream.on("end", () => {
        if (buffer.trim()) {
          try {
            const parsed = JSON.parse(buffer.trim());
            const piece =
              (parsed && parsed.message && typeof parsed.message.content === "string")
                ? parsed.message.content
                : "";
            if (piece) {
              fullText += piece;
              if (callback) { try { callback(piece); } catch (_) {} }
            }
          } catch (_) {}
        }
        finish(null);
      });

      stream.on("error", (err) => {
        if (
          options.budgetMs != null &&
          (err.code === "ECONNABORTED" || err.message === "canceled" || err.name === "CanceledError")
        ) {
          return finish(
            new BudgetExhaustedError(
              "Ollama stream call exceeded budget (" + options.budgetMs + "ms, elapsed " + (Date.now() - startMs) + "ms)",
              { baseUrl: options.baseUrl || this.baseUrl, model: options.model || this.model, budgetMs: options.budgetMs }
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
      True when GET /api/version returns HTTP 200, false on any error.
  */
  async isHealthy() {
    try {
      const r = await axios.get(this.baseUrl + "/api/version", this._axiosOpts(this.baseUrl, 3000));
      return r.status === 200;
    } catch (err) {
      return false;
    }
  }
}

module.exports = OllamaLlmAdapter;
