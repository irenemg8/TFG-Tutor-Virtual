"use strict";

const AgentInterface = require("./base/AgentInterface");

/**
 * ClassifierAgent: Classifies the student's message to determine response strategy.
 * Thin wrapper around the existing rule-based queryClassifier.
 *
 * Hex compliance: debug logger injected via constructor (required).
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
    if (!deps.debugLogger) throw new Error("ClassifierAgent requires deps.debugLogger");
    this.debugLogger = deps.debugLogger;
  }

  async execute(context) {
    // The classifier now needs the tutor's last message to disambiguate
    // short yes/no answers from "single word" wrong answers. The
    // contextAgent already loaded history, so we extract it locally.
    const lastAssistantText = this._lastAssistantText(context.history);

    context.classification = this.classifyQuery(
      context.userMessage,
      context.correctAnswer,
      context.evaluableElements,
      lastAssistantText
    );
    this.debugLogger.logClassify(context.userMessage, context.classification);
  }

  _lastAssistantText(history) {
    if (!Array.isArray(history)) return "";
    for (let i = history.length - 1; i >= 0; i--) {
      if (history[i] && history[i].role === "assistant") {
        return history[i].content || "";
      }
    }
    return "";
  }

  canSkip() {
    return false; // Classification always runs
  }
}

module.exports = ClassifierAgent;
