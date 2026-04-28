"use strict";

const AgentInterface = require("./base/AgentInterface");

/**
 * ClassifierAgent: Classifies the student's message to determine response strategy.
 * Thin wrapper around the existing rule-based queryClassifier.
 *
 * Hex compliance: debug logger injected via constructor (preferred).
 * Fallback require kept so the agent is usable in tests without DI.
 */
class ClassifierAgent extends AgentInterface {
  /**
   * @param {object} deps
   * @param {Function} deps.classifyQuery - The classifyQuery function from queryClassifier.js
   * @param {object} [deps.debugLogger] - IPipelineLogger adapter (preferred)
   */
  constructor(deps) {
    super("classifierAgent");
    this.classifyQuery = deps.classifyQuery;
    this.debugLogger = deps.debugLogger ||
      require("../../infrastructure/events/pipelineDebugLogger");
  }

  async execute(context) {
    context.classification = this.classifyQuery(
      context.userMessage,
      context.correctAnswer,
      context.evaluableElements
    );
    this.debugLogger.logClassify(context.userMessage, context.classification);
  }

  canSkip() {
    return false; // Classification always runs
  }
}

module.exports = ClassifierAgent;
