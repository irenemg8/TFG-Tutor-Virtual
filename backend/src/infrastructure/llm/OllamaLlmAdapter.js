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
    this.defaultTimeoutMs = opts.timeoutMs != null
      ? opts.timeoutMs
      : Number(process.env.OLLAMA_TIMEOUT_MS || 60000);
    this.insecureTls = process.env.OLLAMA_INSECURE_TLS === "1";

    // Reusable HTTPS agent with TCP/TLS keep-alive. Without this, every
    // chatCompletion opened a fresh TLS handshake to ollama.gti-ia.upv.es,
    // adding 2-4s of overhead per turn in production. The agent is
    // constructed once and shared across calls.
    this.httpsAgent = String(this.baseUrl).startsWith("https://")
      ? new https.Agent({
          rejectUnauthorized: !this.insecureTls,
          keepAlive: true,
          keepAliveMsecs: 30000,
          maxSockets: 10,
        })
      : null;
  }

  _axiosOpts(baseUrl, timeoutMs, abortSignal) {
    const base = { timeout: timeoutMs };
    const targetUrl = String(baseUrl || this.baseUrl);
    if (targetUrl.startsWith("https://")) {
      // Reuse the cached agent when the call goes to the URL it was built
      // for; otherwise fall back to a one-off agent (dev / test override).
      base.httpsAgent =
        targetUrl === this.baseUrl && this.httpsAgent
          ? this.httpsAgent
          : new https.Agent({ rejectUnauthorized: !this.insecureTls, keepAlive: true });
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

  /**
   * Streaming completion with a per-token callback.
   *
   * Wraps `chatCompletionStream` to parse Ollama's NDJSON stream and call
   * `onChunk(token)` for each piece of content as it arrives. Returns the
   * accumulated full text, so the caller can keep the existing semantics
   * of `chatCompletion` (await one string) AND simultaneously push tokens
   * to the user.
   *
   * Notes:
   *   - Each NDJSON line has shape:
   *       { "model": "...", "message": { "role": "assistant", "content": "tok" }, "done": false }
   *     The terminal line has done:true and possibly empty content.
   *   - Chunks may arrive split across TCP segments — we buffer until the
   *     newline separator before parsing.
   *   - Errors and budget exhaustion mirror chatCompletion: BudgetExhaustedError
   *     when options.budgetMs is set and the call gets aborted.
   *   - If onChunk is omitted, behaves like chatCompletion (full text only).
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
              try { callback(piece); } catch (_) { /* never let user code crash the stream */ }
            }
          }
          if (parsed && parsed.done === true) {
            return finish(null);
          }
        }
      });

      stream.on("end", () => {
        // Flush any trailing buffered line in case the provider didn't end with \n.
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
          } catch (_) { /* ignore malformed tail */ }
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
