"use strict";

const AgentInterface = require("./base/AgentInterface");

/**
 * GuardrailAgent (refactored): delegates to the new GuardrailPipeline.
 *
 * Old behavior (replaced): sequential checks with up to 11 LLM retries.
 * New behavior: parallel checks → surgical-first → at most ONE consolidated
 * LLM retry → final surgical fallback. Enforces time budget.
 *
 * Worst case LLM calls: 2 (primary from tutorAgent + 1 consolidated retry here).
 */
class GuardrailAgent extends AgentInterface {
  /**
   * @param {object} deps
   * @param {import('../services/GuardrailPipeline')} deps.guardrailPipeline
   */
  constructor(deps) {
    super("guardrailAgent");
    if (!deps || !deps.guardrailPipeline) {
      throw new Error("GuardrailAgent requires a guardrailPipeline dependency");
    }
    if (!deps.debugLogger) throw new Error("GuardrailAgent requires deps.debugLogger");
    this.pipeline = deps.guardrailPipeline;
    this.debugLogger = deps.debugLogger;
    this.kgConceptPatterns = deps.kgConceptPatterns || [];
  }

  canSkip(context) {
    return context.deterministicFinish;
  }

  async execute(context) {
    if (!context.llmResponse) {
      context.finalResponse = "";
      return;
    }

    const guardrailCtx = {
      classification: context.classification && context.classification.type,
      correctAnswer: context.correctAnswer,
      evaluableElements: context.evaluableElements,
      kgConceptPatterns: this.kgConceptPatterns,
      lang: context.lang,
      mentionedElements: context.classification && context.classification.resistances,
      // CompleteSolutionGuardrail needs proposed/negated separately to detect
      // partial-wrong answers (e.g. "R4 no contribuye" when R4 IS correct).
      proposed: (context.classification && context.classification.proposed) || [],
      negated: (context.classification && context.classification.negated) || [],
      // NS-33: AdherenceGuardrail uses turnVerdict.hits to detect
      // missed_affirmation (LLM ignored the hits the banner declared).
      turnVerdict: context.turnVerdict || null,
      // BUG-LOOP (2026-06-11): session-level answer state, consumed by
      // SettledElementQuestionGuardrail to detect a topology re-ask about an
      // element the student already settled (named or excluded) in prior turns.
      cumulativeAnswer: context.cumulativeAnswer || null,
      // BUG-009-B (2026-05-03): StateRevealGuardrail rotates the redaction
      // placeholder based on how many times it has already fired in this
      // conversation, so the student doesn't see the same generic phrase 3
      // turns in a row. Needs the prior assistant messages to count hits.
      messages: context.llmMessages || [],
    };

    // BUG-D (2026-05-11): use Date.now() as guardrail startMs so the budget
    // is relative to THIS phase, not to the whole pipeline. Previously we
    // passed pipelineStartMs, which meant: when the tutor LLM took 14s, the
    // pipeline thought the guardrail had already burned 14s of its 20s
    // budget, leaving <10s — below minRetryBudgetMs — so the consolidated
    // LLM retry never fired even on critical violations (complete_solution,
    // state_reveal). The guardrail has its own slice (ctx.guardrailBudgetMs)
    // and shouldn't inherit the tutor's latency.
    const result = await this.pipeline.validate(context.llmResponse, guardrailCtx, {
      messages: context.llmMessages,
      reqId: context.reqId || "",
      startMs: Date.now(),
    });

    context.finalResponse = result.response;
    context.guardrailPath = result.path;
    context.guardrailLlmRetries = result.llmRetryCount;
    context.guardrailSurgicalFixes = result.surgicalFixesApplied || [];
    // Chronological list of {guardrailId, before, after, durationMs, phase}
    // for every surgical rewrite the pipeline applied. Persisted to
    // messages.extra_metadata so the export endpoint can show the analyst
    // exactly what the LLM was about to say before the redaction.
    context.guardrailSurgicalFixDetails = result.surgicalFixDetails || [];

    // Map pipeline violations/fixes to the legacy triggered-flags object so that
    // PersistenceAgent keeps writing the SAME Interaccion metadata shape. This
    // preserves the contract that other parts of the codebase read.
    const fixed = new Set(result.surgicalFixesApplied || []);
    const residual = (result.residualViolations || []).map(v => v.id);
    const anyFor = (id) => fixed.has(id) || residual.indexOf(id) >= 0;

    context.guardrailsTriggered = {
      solutionLeak: anyFor("solution_leak"),
      falseConfirmation: anyFor("false_confirmation"),
      prematureConfirmation: anyFor("premature_confirmation"),
      completeSolution: anyFor("complete_solution"),
      stateReveal: anyFor("state_reveal"),
      // elementNaming retired (NS-32) — kept as false in the metadata
      // shape so historical Interaccion docs still parse with the same
      // schema; PersistenceAgent and downstream consumers are unaffected.
      elementNaming: false,
      adherence: anyFor("adherence"),
      didacticExplanation: anyFor("didactic_explanation"),
      datasetStyle: anyFor("dataset_style"),
      // Added on feat/ac-detection — persisted in messages.extra_metadata
      // (migration 008) so the export reflects when these fired.
      languageDrift: anyFor("language_drift"),
      repeatedQuestion: anyFor("repeated_question"),
      settledElementQuestion: anyFor("settled_element_question"),
    };

    this.debugLogger.logGuardrail && this.debugLogger.logGuardrail(context.guardrailsTriggered, context.finalResponse);
  }
}

module.exports = GuardrailAgent;
