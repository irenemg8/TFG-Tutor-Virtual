"use strict";

const { BudgetExhaustedError } = require("../ports/services/ILlmService");

/*------------------------------------------------------------------------------
            _________________________________________________________
            |                   GUARDRAILPIPELINE                   |
            |  Runs output guardrails over an LLM response: parallel|
            |  checks, surgical-first deterministic fixes, at most  |
            |  ONE consolidated LLM retry, all under a time budget. |
            |  Worst case 2 LLM calls per request (primary + retry).|
        ____|________________                                       |
   Obj -> | constructor() | -> GuardrailPipeline    (writes attrs)  |
          -----------------                                         |
            |                                                       |
            |   guardrails: [IGuardrail]    llm: ILlmService        |
            |   logger: Obj                 budgetMs: N             |
            |   minRetryBudgetMs: N         emitEvent: Fn           |
        ____|___________                                            |
        | validate() | -> Promise<Obj>               (reads attrs)  |
        --------------                                              |
        ____|_______________________                                |
        | _runChecksInParallel() | -> Promise<[Obj]> (reads attrs)  |
        --------------------------                                  |
        ____|_________________                                      |
        | _findGuardrail() | -> IGuardrail | null    (reads attrs)  |
        --------------------                                        |
        ____|_________                                              |
        | _safe() | -> void                                         |
        -----------                                                 |
            |                                                       |
            |_______________________________________________________|
------------------------------------------------------------------------------*/
class GuardrailPipeline {
  /*
   Obj -> ____|________________
         | constructor() | -> GuardrailPipeline    (writes attributes guardrails ([IGuardrail]),
          -----------------                         llm (ILlmService), logger (Obj), budgetMs (N),
                                                    minRetryBudgetMs (N), emitEvent (Fn))
      Builds the pipeline from an options object. Requires a non-empty
      guardrails array and an llmService. The optional emitEvent fires
      out-of-band notices so the SSE layer can swap a leaked draft for a
      neutral placeholder while a rewrite is in flight.
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
    this.emitEvent = typeof opts.emitEvent === "function" ? opts.emitEvent : function () {};
  }

  /*
   Txt, Obj, Obj -> ____|__________
                   | validate() | -> Promise<Obj>    (reads attributes guardrails ([IGuardrail]),
                    --------------                     llm (ILlmService), logger (Obj), budgetMs (N),
                                                       minRetryBudgetMs (N), emitEvent (Fn))
      Validates a response and repairs it if needed. Runs parallel checks,
      then surgical fixes, then a single consolidated LLM retry for critical
      residuals, then a final surgical pass. Resolves to the result object
      describing the safe response and the path taken.
  */
  async validate(response, ctx, opts) {
    opts = opts || {};
    const reqId = opts.reqId || "";
    const startMs = opts.startMs || Date.now();
    const remainingBudget = () => this.budgetMs - (Date.now() - startMs);

    const surgicalFixesApplied = [];
    const surgicalFixDetails = [];

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

    const CRITICAL_GUARDRAILS = new Set([
      "solution_leak",
      "false_confirmation",
      "premature_confirmation",
      "state_reveal",
      "complete_solution",
      "repeated_question",
      "adherence",
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
      this._safe(() => this.logger.traceError && this.logger.traceError(reqId, "consolidated_retry", err));
      return _result({
        response: currentResponse, violated: true,
        path: err instanceof BudgetExhaustedError ? "budget_exhausted" : "retry_error",
        residualViolations: violations, llmRetryCount: 0,
        surgicalFixesApplied: surgicalFixesApplied,
        surgicalFixDetails: surgicalFixDetails,
      });
    }

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

  /*
   Txt, Obj, Txt -> ____|_______________________
                   | _runChecksInParallel() | -> Promise<[Obj]>    (reads attributes guardrails ([IGuardrail]),
                    --------------------------                      logger (Obj))
      Runs every guardrail's check() concurrently via Promise.all and
      returns one result object per guardrail with its violated flag,
      evidence, metadata and elapsed check time.
  */
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

  /*
   Txt -> ____|_________________
         | _findGuardrail() | -> IGuardrail | null    (reads attribute guardrails ([IGuardrail]))
          --------------------
      Returns the guardrail whose id matches, or null when none does.
  */
  _findGuardrail(id) {
    for (var i = 0; i < this.guardrails.length; i++) {
      if (this.guardrails[i].id === id) return this.guardrails[i];
    }
    return null;
  }

  /*
   Fn -> ____|_________
        | _safe() | -> void
         -----------
      Invokes the given function and swallows any error so a logging
      failure never breaks the pipeline.
  */
  _safe(fn) {
    try { fn(); } catch (_) { }
  }
}

/*
   Obj -> ____|__________
         | _result() | -> Obj
          ------------
      Identity helper that returns the pipeline result object as-is.
*/
function _result(r) { return r; }

/*
   [Obj], Txt -> ____|______________________
                | _appendToSystemPrompt() | -> [Obj]
                 --------------------------
      Returns a copy of the messages with the suffix appended to the
      first system message; returns the input unchanged when empty.
*/
function _appendToSystemPrompt(messages, suffix) {
  if (!Array.isArray(messages) || messages.length === 0) return messages;
  return messages.map((m, i) => {
    if (i === 0 && m && m.role === "system") {
      return Object.assign({}, m, { content: (m.content || "") + suffix });
    }
    return m;
  });
}

/*
        ____|______________
       | _noopLogger() | -> Obj
        -----------------
      Builds a logger object whose trace methods are all no-ops, used
      when no logger is injected.
*/
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
