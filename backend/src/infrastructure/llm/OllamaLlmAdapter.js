"use strict";

const axios = require("axios");
const https = require("https");
const ILlmService = require("../../domain/ports/services/ILlmService");
const { BudgetExhaustedError } = require("../../domain/ports/services/ILlmService");
const config = require("./config");

/**
 * OllamaLlmAdapter: concrete ILlmService backed by an Ollama server.
 *
 * Key features:
 *   - Budget awareness: if options.budgetMs is set, axios timeout = min(cfg, budget)
 *   - Mode override: options.baseUrl (optional) overrides config default
 *   - Abort signal: options.abort is wired to axios signal
 *   - TLS: honors OLLAMA_INSECURE_TLS in dev
 *
 * Does NOT do retries — retry is a higher-level concern (GuardrailPipeline).
 */
class OllamaLlmAdapter extends ILlmService {
  constructor(opts) {
    super();
    opts = opts || {};
    this.baseUrl = opts.baseUrl || config.OLLAMA_CHAT_URL;
    this.model = opts.model || config.OLLAMA_MODEL;
    this.defaultTemperature = opts.temperature != null ? opts.temperature : config.OLLAMA_TEMPERATURE;
    this.defaultNumPredict = opts.numPredict != null ? opts.numPredict : config.OLLAMA_NUM_PREDICT;
    this.defaultNumCtx = opts.numCtx != null ? opts.numCtx : config.OLLAMA_NUM_CTX;
    this.keepAlive = opts.keepAlive || config.OLLAMA_KEEP_ALIVE;
    this.defaultTimeoutMs = opts.timeoutMs != null ? opts.timeoutMs : 180000;
    this.insecureTls = process.env.OLLAMA_INSECURE_TLS === "1";
  }

  _axiosOpts(baseUrl, timeoutMs, abortSignal) {
    const base = { timeout: timeoutMs };
    if (String(baseUrl || this.baseUrl).startsWith("https://")) {
      base.httpsAgent = new https.Agent({ rejectUnauthorized: !this.insecureTls });
    }
    if (abortSignal) base.signal = abortSignal;
    return base;
  }

  _resolveTimeout(budgetMs) {
    if (budgetMs == null || budgetMs <= 0) return this.defaultTimeoutMs;
    return Math.min(this.defaultTimeoutMs, budgetMs);
  }

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
      // Normalize timeout errors as BudgetExhaustedError when budget was set
      if (options.budgetMs != null && (err.code === "ECONNABORTED" || err.message === "canceled" || err.name === "CanceledError")) {
        throw new BudgetExhaustedError(
          "Ollama call exceeded budget (" + options.budgetMs + "ms, elapsed " + (Date.now() - startMs) + "ms)",
          { baseUrl: baseUrl, model: model, budgetMs: options.budgetMs }
        );
      }
      throw err;
    }
  }

  async chatCompletionStream(messages, options) {
    options = options || {};
    const baseUrl = options.baseUrl || this.baseUrl;
    const model = options.model || this.model;
    const timeoutMs = options.budgetMs != null ? this._resolveTimeout(options.budgetMs) : 0; // 0 = no timeout for stream

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
    return resp.data; // stream
  }

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
