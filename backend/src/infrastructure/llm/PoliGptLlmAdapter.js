"use strict";

const axios = require("axios");
const https = require("https");
const ILlmService = require("../../domain/ports/services/ILlmService");
const { BudgetExhaustedError } = require("../../domain/ports/services/ILlmService");
const config = require("./config");

/**
 * PoliGptLlmAdapter: ILlmService backed by the OpenAI-compatible PoliGPT API
 * (LiteLLM proxy at https://api.poligpt.upv.es).
 *
 * Why not the openai SDK: we already use axios for Ollama, the API surface
 * is small (POST /v1/chat/completions + SSE), and avoiding the dependency
 * keeps the bundle thin and the failure modes transparent.
 *
 * Differences vs OllamaLlmAdapter:
 *   - Endpoint: POST /v1/chat/completions (OpenAI) instead of /api/chat
 *   - Auth: Authorization: Bearer sk-... header
 *   - Sampling params live at the top level of the body (max_tokens,
 *     temperature) instead of nested under `options`
 *   - Streaming wire format: SSE ("data: {...}\n\n", terminator "data: [DONE]")
 *     instead of newline-delimited JSON
 */
class PoliGptLlmAdapter extends ILlmService {
  constructor(opts) {
    super();
    opts = opts || {};
    this.baseUrl = opts.baseUrl || config.POLIGPT_BASE_URL;
    this.apiKey = opts.apiKey || config.POLIGPT_API_KEY;
    this.model = opts.model || config.POLIGPT_MODEL;
    this.defaultTemperature = opts.temperature != null ? opts.temperature : config.OLLAMA_TEMPERATURE;
    this.defaultMaxTokens = opts.maxTokens != null ? opts.maxTokens : config.OLLAMA_NUM_PREDICT;
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
    // Strip trailing slash so we can safely concatenate "/v1/chat/completions"
    this.baseUrl = String(this.baseUrl).replace(/\/+$/, "");

    // Reusable HTTPS agent with TCP/TLS keep-alive so we don't pay the
    // handshake on every turn (the chat path is hot).
    this.httpsAgent = this.baseUrl.startsWith("https://")
      ? new https.Agent({
          rejectUnauthorized: true,
          keepAlive: true,
          keepAliveMsecs: 30000,
          maxSockets: 10,
        })
      : null;
  }

  _headers() {
    const h = { "Content-Type": "application/json" };
    if (this.apiKey) h["Authorization"] = "Bearer " + this.apiKey;
    return h;
  }

  _axiosOpts(timeoutMs, abortSignal) {
    const base = { timeout: timeoutMs, headers: this._headers() };
    if (this.httpsAgent) base.httpsAgent = this.httpsAgent;
    if (abortSignal) base.signal = abortSignal;
    return base;
  }

  _resolveTimeout(budgetMs) {
    if (budgetMs == null || budgetMs <= 0) return this.defaultTimeoutMs;
    return Math.min(this.defaultTimeoutMs, budgetMs);
  }

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
    };
  }

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

  /**
   * Streaming with per-token callback. Parses OpenAI SSE format:
   *   data: {"choices":[{"delta":{"content":"tok"},"index":0,"finish_reason":null}],...}\n\n
   *   data: [DONE]\n\n
   *
   * Buffers across TCP segments because deltas can split arbitrarily.
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
        // Each SSE event is "field: value\n" lines, terminated by blank line.
        // We only care about the `data:` field.
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
          // OpenAI marks completion via finish_reason on the last delta;
          // [DONE] handled above is the canonical terminator.
        }
      };

      stream.on("data", (raw) => {
        if (settled) return;
        buffer += raw.toString("utf8");
        // Split on the SSE event terminator (blank line).
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
