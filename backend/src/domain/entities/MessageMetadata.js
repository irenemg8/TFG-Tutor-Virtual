"use strict";

class MessageMetadata {
  /**
   * Value object for assistant message metadata.
   *
   * Two tiers of fields:
   *   - Core (dedicated DB columns on `messages`): classification,
   *     decision, isCorrectAnswer, sourcesCount, studentResponseMs,
   *     concepts, the four legacy guardrails, timing.{pipeline,ollama,total}.
   *   - Extra (JSONB messages.extra_metadata, migration 008):
   *     firstTokenMs, detectedACs, the new guardrails added on
   *     feat/ac-detection (languageDrift, completeSolution, adherence,
   *     repeatedQuestion, didacticExplanation, datasetStyle),
   *     guardrailPath, guardrailLlmRetries, guardrailSurgicalFixes,
   *     fallbackUsed, deterministicFinish.
   */
  constructor(props) {
    this.classification = props.classification || null;
    this.decision = props.decision || null;
    this.isCorrectAnswer = props.isCorrectAnswer ?? null;
    this.sourcesCount = props.sourcesCount || 0;
    this.studentResponseMs = props.studentResponseMs || null;
    this.concepts = Array.isArray(props.concepts) ? props.concepts : [];

    this.guardrails = {
      // Legacy four (own DB columns):
      solutionLeak: props.guardrails?.solutionLeak || false,
      falseConfirmation: props.guardrails?.falseConfirmation || false,
      prematureConfirmation: props.guardrails?.prematureConfirmation || false,
      stateReveal: props.guardrails?.stateReveal || false,
      // New on feat/ac-detection (extra_metadata):
      languageDrift: props.guardrails?.languageDrift || false,
      completeSolution: props.guardrails?.completeSolution || false,
      adherence: props.guardrails?.adherence || false,
      repeatedQuestion: props.guardrails?.repeatedQuestion || false,
      didacticExplanation: props.guardrails?.didacticExplanation || false,
      datasetStyle: props.guardrails?.datasetStyle || false,
      // Retired NS-32 — kept for schema compat:
      elementNaming: props.guardrails?.elementNaming || false,
    };

    this.timing = {
      pipelineMs: props.timing?.pipelineMs || null,
      ollamaMs: props.timing?.ollamaMs || null,
      totalMs: props.timing?.totalMs || null,
      firstTokenMs: props.timing?.firstTokenMs || null,
    };

    this.detectedACs = Array.isArray(props.detectedACs) ? props.detectedACs : [];
    this.guardrailPath = props.guardrailPath || null;
    this.guardrailLlmRetries = props.guardrailLlmRetries || 0;
    this.guardrailSurgicalFixes = Array.isArray(props.guardrailSurgicalFixes)
      ? props.guardrailSurgicalFixes
      : [];
    // Raw LLM output before any guardrail/surgical-fix rewrite. Lets the
    // export endpoint show analysts what the model was about to say,
    // alongside the chronological list of rewrites below.
    this.llmResponseOriginal = props.llmResponseOriginal || null;
    this.guardrailSurgicalFixDetails = Array.isArray(props.guardrailSurgicalFixDetails)
      ? props.guardrailSurgicalFixDetails
      : [];
    this.fallbackUsed = props.fallbackUsed || false;
    this.deterministicFinish = props.deterministicFinish || false;
  }
}

module.exports = MessageMetadata;
