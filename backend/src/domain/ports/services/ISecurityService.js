"use strict";

/**
 * Port: ISecurityService
 *
 * Analyzes the student's raw input to decide whether it is safe to let
 * the tutoring pipeline process it. Two main threats:
 *   - prompt injection (attempts to rewrite/override the tutor's role)
 *   - off-topic (requests unrelated to electric circuits)
 *
 * Adapters:
 *   - HeuristicSecurityAdapter (regex + keyword based, deterministic)
 *   - (future) LlmSecurityAdapter (LLM-as-a-judge, for ambiguous cases)
 */
class ISecurityService {
  /**
   * @param {string} userMessage - Raw student input
   * @param {object} ctx
   * @param {string} ctx.lang    - "es" | "en" | "val"
   * @param {object} [ctx.exercise]
   * @param {string[]} [ctx.evaluableElements]
   * @returns {SecurityAnalysis}
   */
  analyzeInput(userMessage, ctx) {
    throw new Error("ISecurityService.analyzeInput not implemented");
  }
}

/**
 * @typedef {object} SecurityAnalysis
 * @property {boolean} safe
 * @property {"safe"|"injection"|"off_topic"} category
 * @property {string}  [matchedPattern] - The pattern id that triggered (debug/logging)
 * @property {string}  [redirectMessage] - Localized message to show to the student
 */

module.exports = ISecurityService;
