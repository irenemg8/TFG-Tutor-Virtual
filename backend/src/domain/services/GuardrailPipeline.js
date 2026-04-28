"use strict";

const { BudgetExhaustedError } = require("../ports/services/ILlmService");

/**
 * GuardrailPipeline: runs output guardrails over an LLM response with:
 *   1. PARALLEL checks     — all guardrails run via Promise.all (~1ms total)
 *   2. SURGICAL-FIRST      — try deterministic fixes before any LLM retry
 *   3. CONSOLIDATED RETRY  — at most ONE LLM retry with combined hints
 *   4. TIME BUDGET         — skips further work if budget is exceeded
 *
 * Worst case LLM calls per request: 2 (primary + 1 consolidated retry)
 * vs. the old middleware's worst-case of 11.
 *
 * Usage:
 *   const pipeline = new GuardrailPipeline({
 *     guardrails: createDefaultGuardrails(),
 *     llmService: ollamaAdapter,
 *     budgetMs: 45000,
 *     logger: trace,
 *   });
 *   const result = await pipeline.validate(primaryResponse, ctx, { messages: [...] });
 *   // result.response is the safe-to-send text
 *
 * Result shape: {
 *   response: string,           // final safe response
 *   violated: boolean,          // false if everything passed
 *   path: string,               // one of: primary_ok | surgical_ok | llm_retry_ok |
 *                               //         llm_retry_plus_surgical | budget_exhausted |
 *                               //         no_retry_hints | retry_failed_final_surgical
 *   residualViolations: array,  // violations that couldn't be fixed (may be empty)
 *   llmRetryCount: number,      // 0 or 1
 *   surgicalFixesApplied: array,// guardrail ids that surgically fixed things
 * }
 */
class GuardrailPipeline {
  /**
   * @param {object} opts
   * @param {Array<IGuardrail>} opts.guardrails
   * @param {ILlmService} opts.llmService
   * @param {object} [opts.logger]   — pipelineDebugLogger or compatible
   * @param {number} [opts.budgetMs] — default 45000
   * @param {number} [opts.minRetryBudgetMs] — min ms needed to attempt LLM retry, default 10000
   */
  constructor(opts) {
    if (!opts || !Array.isArray(opts.guardrails) || opts.guardrails.length === 0) {
      throw new Error("GuardrailPipeline requires a non-empty guardrails array");
    }
    if (!opts.llmService) {
      throw new Error("GuardrailPipeline requires an llmService");
    }
    this.guardrails = opts.guardrails;
    this.llm = opts.llmService;
    this.logger = opts.logger || _noopLogger();
    this.budgetMs = opts.budgetMs != null ? opts.budgetMs : 45000;
    this.minRetryBudgetMs = opts.minRetryBudgetMs != null ? opts.minRetryBudgetMs : 10000;
  }

  /**
   * Validate a response and repair it if needed.
   *
   * @param {string} response
   * @param {object} ctx — see IGuardrail ctx
   * @param {object} opts
   * @param {Array<{role,content}>} opts.messages — original LLM messages (for retry)
   * @param {string} [opts.reqId] — request id for tracing
   * @param {number} [opts.startMs] — override start time (if caller has budget offset)
   * @returns {Promise<PipelineResult>}
   */
  async validate(response, ctx, opts) {
    opts = opts || {};
    const reqId = opts.reqId || "";
    const startMs = opts.startMs || Date.now();
    const remainingBudget = () => this.budgetMs - (Date.now() - startMs);

    const surgicalFixesApplied = [];

    // === Phase A: initial parallel check ===
    let currentResponse = response;
    let checks = await this._runChecksInParallel(currentResponse, ctx, reqId);
    let violations = checks.filter(function (c) { return c.violated; });

    if (violations.length === 0) {
      return _result({
        response: currentResponse, violated: false, path: "primary_ok",
        residualViolations: [], llmRetryCount: 0, surgicalFixesApplied: surgicalFixesApplied,
      });
    }

    // === Phase B: surgical fixes on all violated guardrails ===
    for (var i = 0; i < violations.length; i++) {
      const v = violations[i];
      const g = this._findGuardrail(v.id);
      if (!g) continue;
      const t0 = Date.now();
      const fix = await Promise.resolve(g.surgicalFix(currentResponse, ctx));
      const dur = Date.now() - t0;
      if (fix && fix.applied) {
        this._safe(() => this.logger.traceSurgicalFix && this.logger.traceSurgicalFix(reqId, g.id, {
          applied: true, durationMs: dur, before: fix.before, after: fix.after,
        }));
        currentResponse = fix.text;
        surgicalFixesApplied.push(g.id);
      } else {
        this._safe(() => this.logger.traceSurgicalFix && this.logger.traceSurgicalFix(reqId, g.id, {
          applied: false, durationMs: dur,
        }));
      }
    }

    // Re-check after surgical
    checks = await this._runChecksInParallel(currentResponse, ctx, reqId);
    violations = checks.filter(function (c) { return c.violated; });
    if (violations.length === 0) {
      return _result({
        response: currentResponse, violated: false, path: "surgical_ok",
        residualViolations: [], llmRetryCount: 0, surgicalFixesApplied: surgicalFixesApplied,
      });
    }

    // === Phase C: consolidated LLM retry (if budget permits) ===
    const budget = remainingBudget();
    if (budget < this.minRetryBudgetMs) {
      return _result({
        response: currentResponse, violated: true, path: "budget_exhausted",
        residualViolations: violations, llmRetryCount: 0, surgicalFixesApplied: surgicalFixesApplied,
      });
    }

    const hints = violations
      .map(v => this._findGuardrail(v.id))
      .filter(Boolean)
      .map(g => g.buildRetryHint(ctx && ctx.lang))
      .filter(Boolean);

    if (hints.length === 0) {
      return _result({
        response: currentResponse, violated: true, path: "no_retry_hints",
        residualViolations: violations, llmRetryCount: 0, surgicalFixesApplied: surgicalFixesApplied,
      });
    }

    const consolidatedHint = "\n\n" + hints.join("\n\n");
    const retryMessages = _appendToSystemPrompt(opts.messages || [], consolidatedHint);

    this._safe(() => this.logger.traceLlmRetry && this.logger.traceLlmRetry(
      reqId, "consolidated", 1, { guardrails: violations.map(v => v.id) }
    ));

    let retryResponse;
    try {
      const t0 = Date.now();
      retryResponse = await this.llm.chatCompletion(retryMessages, { budgetMs: budget });
      this._safe(() => this.logger.traceLlmCall && this.logger.traceLlmCall(reqId, "end", {
        durationMs: Date.now() - t0, responseLen: retryResponse.length,
        reason: "consolidated_retry", response: retryResponse,
      }));
    } catch (err) {
      // Budget or network error → return surgical result as-is
      this._safe(() => this.logger.traceError && this.logger.traceError(reqId, "consolidated_retry", err));
      return _result({
        response: currentResponse, violated: true,
        path: err instanceof BudgetExhaustedError ? "budget_exhausted" : "retry_error",
        residualViolations: violations, llmRetryCount: 0, surgicalFixesApplied: surgicalFixesApplied,
      });
    }

    // === Phase D: re-check retry response + final surgical fallback ===
    checks = await this._runChecksInParallel(retryResponse, ctx, reqId);
    violations = checks.filter(function (c) { return c.violated; });
    if (violations.length === 0) {
      return _result({
        response: retryResponse, violated: false, path: "llm_retry_ok",
        residualViolations: [], llmRetryCount: 1, surgicalFixesApplied: surgicalFixesApplied,
      });
    }

    // Final surgical pass on retry response
    let finalResponse = retryResponse;
    for (var j = 0; j < violations.length; j++) {
      const v2 = violations[j];
      const g2 = this._findGuardrail(v2.id);
      if (!g2) continue;
      const t0 = Date.now();
      const fix2 = await Promise.resolve(g2.surgicalFix(finalResponse, ctx));
      const dur2 = Date.now() - t0;
      if (fix2 && fix2.applied) {
        this._safe(() => this.logger.traceSurgicalFix && this.logger.traceSurgicalFix(reqId, g2.id, {
          applied: true, durationMs: dur2, before: fix2.before, after: fix2.after,
        }));
        finalResponse = fix2.text;
        if (surgicalFixesApplied.indexOf(g2.id) < 0) surgicalFixesApplied.push(g2.id);
      }
    }

    // Final check
    checks = await this._runChecksInParallel(finalResponse, ctx, reqId);
    const finalViolations = checks.filter(function (c) { return c.violated; });
    return _result({
      response: finalResponse,
      violated: finalViolations.length > 0,
      path: finalViolations.length === 0 ? "llm_retry_plus_surgical" : "retry_failed_final_surgical",
      residualViolations: finalViolations,
      llmRetryCount: 1,
      surgicalFixesApplied: surgicalFixesApplied,
    });
  }

  // ─── Internals ─────────────────────────────────────────────────────────────

  async _runChecksInParallel(response, ctx, reqId) {
    const self = this;
    const tasks = this.guardrails.map(async function (g) {
      const t0 = Date.now();
      const r = await Promise.resolve(g.check(response, ctx));
      const checkMs = Date.now() - t0;
      self._safe(function () {
        if (self.logger.traceGuardrailCheck) {
          self.logger.traceGuardrailCheck(reqId, g.id, {
            violated: !!r.violated, checkMs: checkMs, evidence: r.evidence,
          });
        }
      });
      return {
        id: g.id,
        violated: !!r.violated,
        evidence: r.evidence,
        metadata: r.metadata,
        checkMs: checkMs,
      };
    });
    return Promise.all(tasks);
  }

  _findGuardrail(id) {
    for (var i = 0; i < this.guardrails.length; i++) {
      if (this.guardrails[i].id === id) return this.guardrails[i];
    }
    return null;
  }

  _safe(fn) {
    try { fn(); } catch (_) { /* ignore logging errors */ }
  }
}

function _result(r) { return r; }

function _appendToSystemPrompt(messages, suffix) {
  if (!Array.isArray(messages) || messages.length === 0) return messages;
  return messages.map((m, i) => {
    if (i === 0 && m && m.role === "system") {
      return Object.assign({}, m, { content: (m.content || "") + suffix });
    }
    return m;
  });
}

function _noopLogger() {
  return {
    traceGuardrailCheck: function () {},
    traceSurgicalFix: function () {},
    traceLlmRetry: function () {},
    traceLlmCall: function () {},
    traceError: function () {},
  };
}

module.exports = GuardrailPipeline;
