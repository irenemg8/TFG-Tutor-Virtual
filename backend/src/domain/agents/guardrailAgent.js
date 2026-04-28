"use strict";

const AgentInterface = require("./base/AgentInterface");
const trace = require("../../infrastructure/events/pipelineDebugLogger");

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
    this.pipeline = deps.guardrailPipeline;
    // Static, loaded once at boot. Passed to each guardrail ctx so StateReveal
    // adapter can flag KG-derived concept terms.
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
    };

    const result = await this.pipeline.validate(context.llmResponse, guardrailCtx, {
      messages: context.llmMessages,
      reqId: context.reqId || "",
      startMs: context.timing.pipelineStartMs,
    });

    context.finalResponse = result.response;
    context.guardrailPath = result.path;
    context.guardrailLlmRetries = result.llmRetryCount;
    context.guardrailSurgicalFixes = result.surgicalFixesApplied || [];

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
      elementNaming: anyFor("element_naming"),
      didacticExplanation: anyFor("didactic_explanation"),
      datasetStyle: anyFor("dataset_style"),
    };

    trace.logGuardrail && trace.logGuardrail(context.guardrailsTriggered, context.finalResponse);
  }
}

module.exports = GuardrailAgent;
