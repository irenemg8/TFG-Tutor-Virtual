"use strict";

class MessageMetadata {
  /**
   * Value object for assistant message metadata.
   * Replaces the embedded metadata sub-schema in MongoDB's conversacion[].
   *
   * @param {object} props
   * @param {string}  [props.classification]
   * @param {string}  [props.decision]
   * @param {boolean} [props.isCorrectAnswer]
   * @param {number}  [props.sourcesCount]
   * @param {number}  [props.studentResponseMs]
   * @param {object}  [props.guardrails]
   * @param {object}  [props.timing]
   * @param {string[]} [props.concepts] - rule-based concepts detected by the
   *   classifier this turn (e.g. ["divisor de tensión", "cortocircuito"]).
   *   Persisted so AcTrackerAgent can rebuild long-term AC evidence even
   *   for interactions that were abandoned without a final Resultado.
   */
  constructor(props) {
    this.classification = props.classification || null;
    this.decision = props.decision || null;
    this.isCorrectAnswer = props.isCorrectAnswer ?? null;
    this.sourcesCount = props.sourcesCount || 0;
    this.studentResponseMs = props.studentResponseMs || null;
    this.concepts = Array.isArray(props.concepts) ? props.concepts : [];

    this.guardrails = {
      solutionLeak: props.guardrails?.solutionLeak || false,
      falseConfirmation: props.guardrails?.falseConfirmation || false,
      prematureConfirmation: props.guardrails?.prematureConfirmation || false,
      stateReveal: props.guardrails?.stateReveal || false,
    };

    this.timing = {
      pipelineMs: props.timing?.pipelineMs || null,
      ollamaMs: props.timing?.ollamaMs || null,
      totalMs: props.timing?.totalMs || null,
    };
  }
}

module.exports = MessageMetadata;
