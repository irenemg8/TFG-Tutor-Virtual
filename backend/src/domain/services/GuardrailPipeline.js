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
    // Optional out-of-band event emitter (ragBus.emitEvent). Used to notify the
    // SSE layer that the pipeline is about to call the LLM for a rewrite, so
    // the frontend can swap the streamed (possibly leaked) draft for a neutral
    // placeholder while the rewrite is in flight, instead of letting the user
    // read the leaked draft for the 2-5s the rewrite takes.
    this.emitEvent = typeof opts.emitEvent === "function" ? opts.emitEvent : function () {};
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
    // Chronological detail of every surgical rewrite applied this turn.
    // Each entry: {guardrailId, before, after, durationMs, phase}.
    // The pipeline already had the before/after in hand for the logger but
    // dropped them — now we keep them so the export endpoint can surface
    // what the LLM was about to say before the redaction kicked in.
    const surgicalFixDetails = [];

    // === Phase A: initial parallel check ===
    let currentResponse = response;
    let checks = await this._runChecksInParallel(currentResponse, ctx, reqId);
    let violations = checks.filter(function (c) { return c.violated; });

    if (violations.length === 0) {
      return _result({
        response: currentResponse, violated: false, path: "primary_ok",
        residualViolations: [], llmRetryCount: 0,
        surgicalFixesApplied: surgicalFixesApplied,
        surgicalFixDetails: surgicalFixDetails,
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
        surgicalFixDetails.push({
          guardrailId: g.id,
          before: fix.before != null ? fix.before : currentResponse,
          after: fix.after != null ? fix.after : fix.text,
          durationMs: dur,
          phase: "B",
        });
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
        residualViolations: [], llmRetryCount: 0,
        surgicalFixesApplied: surgicalFixesApplied,
        surgicalFixDetails: surgicalFixDetails,
      });
    }

    // === Phase C: consolidated LLM retry (if budget permits) ===
    //
    // Quality-vs-latency gate: a consolidated retry costs another 5-15s
    // against PoliGPT. Reserve it for pedagogically-critical violations
    // where the surgical fix cannot reliably recover the meaning:
    //   - solution_leak: tutor revealed the answer
    //   - false_confirmation: confirmed a wrong answer as right
    //   - premature_confirmation: confirmed without justification
    //   - state_reveal: revealed element state (short/open)
    //   - complete_solution: emitted a step-by-step worked solution
    //   - repeated_question: literal repetition of previous Socratic question
    //     (BUG-A 2026-05-11: added here because RepeatedQuestionGuardrail's
    //     surgicalFix returns null on purpose — it cannot rewrite the question
    //     without LLM knowledge of the AC; without retry, the repeated
    //     question reached the student and they wrote "ya me lo has
    //     preguntado antes" in production logs).
    //   - adherence: BUG-CRIT (2026-06-11). The adherence guardrail has TWO
    //     surgically-fixable rules (contradiction, multi_question — repaired in
    //     Phase B and gone before this point) AND ONE retry-only rule:
    //     false_premise ("¿por qué R4 no influye?" about a CORRECT element).
    //     false_premise has NO surgicalFix on purpose (there is no safe rewrite
    //     of a question built on a false presupposition), so its only repair
    //     path is the consolidated retry. Before this fix, adherence was absent
    //     from this set, so a residual false_premise hit `non_critical_only`
    //     and the false-premise question reached the student VERBATIM — exactly
    //     the "¿Por qué crees que R4 no influye?" leak observed in production.
    //     The detection was dead. Adding adherence here wires its retry hint in.
    //     (contradiction/multi_question never reach here unless their surgical
    //     fix failed, in which case a retry is the correct fallback anyway.)
    // For the rest (language_drift, didactic_explanation, dataset_style,
    // element_naming), the surgical fix already rewrote the offending sentence
    // in place; an LLM retry wastes a round-trip without measurable quality gain.
    const CRITICAL_GUARDRAILS = new Set([
      "solution_leak",
      "false_confirmation",
      "premature_confirmation",
      "state_reveal",
      "complete_solution",
      "repeated_question",
      "adherence",
      // BUG-LOOP (2026-06-11): retry-only (no safe rewrite of the question),
      // so it MUST be here or its detection is dead — same class of bug as
      // BUG-CRIT above. Forces a pivot when the tutor re-asks a settled element.
      "settled_element_question",
    ]);
    const criticalViolations = violations.filter(function (v) {
      return CRITICAL_GUARDRAILS.has(v.id);
    });
    if (criticalViolations.length === 0) {
      return _result({
        response: currentResponse, violated: true, path: "non_critical_only",
        residualViolations: violations, llmRetryCount: 0,
        surgicalFixesApplied: surgicalFixesApplied,
        surgicalFixDetails: surgicalFixDetails,
      });
    }
    // Only the critical residuals justify the retry cost.
    violations = criticalViolations;
    const budget = remainingBudget();
    if (budget < this.minRetryBudgetMs) {
      return _result({
        response: currentResponse, violated: true, path: "budget_exhausted",
        residualViolations: violations, llmRetryCount: 0,
        surgicalFixesApplied: surgicalFixesApplied,
        surgicalFixDetails: surgicalFixDetails,
      });
    }

    const hints = violations
      .map(v => this._findGuardrail(v.id))
      .filter(Boolean)
      .map(g => g.buildRetryHint(ctx && ctx.lang, ctx))
      .filter(Boolean);

    if (hints.length === 0) {
      return _result({
        response: currentResponse, violated: true, path: "no_retry_hints",
        residualViolations: violations, llmRetryCount: 0,
        surgicalFixesApplied: surgicalFixesApplied,
        surgicalFixDetails: surgicalFixDetails,
      });
    }

    const consolidatedHint = "\n\n" + hints.join("\n\n");
    const retryMessages = _appendToSystemPrompt(opts.messages || [], consolidatedHint);

    this._safe(() => this.logger.traceLlmRetry && this.logger.traceLlmRetry(
      reqId, "consolidated", 1, { guardrails: violations.map(v => v.id) }
    ));

    // Fire an out-of-band event so the SSE bridge can tell the frontend to
    // swap the leaked draft for a placeholder NOW, before we spend 2-5s
    // generating the rewrite. The frontend that doesn't know about this
    // event simply ignores it (additive change).
    this._safe(() => this.emitEvent("guardrail_rewriting", "start", {
      violations: violations.map(v => v.id),
    }));

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
        residualViolations: violations, llmRetryCount: 0,
        surgicalFixesApplied: surgicalFixesApplied,
        surgicalFixDetails: surgicalFixDetails,
      });
    }

    // === Phase D: re-check retry response + final surgical fallback ===
    checks = await this._runChecksInParallel(retryResponse, ctx, reqId);
    violations = checks.filter(function (c) { return c.violated; });
    if (violations.length === 0) {
      return _result({
        response: retryResponse, violated: false, path: "llm_retry_ok",
        residualViolations: [], llmRetryCount: 1,
        surgicalFixesApplied: surgicalFixesApplied,
        surgicalFixDetails: surgicalFixDetails,
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
        surgicalFixDetails.push({
          guardrailId: g2.id,
          before: fix2.before != null ? fix2.before : finalResponse,
          after: fix2.after != null ? fix2.after : fix2.text,
          durationMs: dur2,
          phase: "D",
        });
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
      surgicalFixDetails: surgicalFixDetails,
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
