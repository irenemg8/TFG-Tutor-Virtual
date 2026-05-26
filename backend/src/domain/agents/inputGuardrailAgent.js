"use strict";

const AgentInterface = require("./base/AgentInterface");

/**
 * InputGuardrailAgent: First-line defense on the INPUT side of the pipeline.
 *
 * Runs after ContextAgent (so language/exercise are known) and BEFORE the
 * classifier. If the student's message is a prompt-injection attempt or a
 * clear off-topic request, the agent short-circuits the pipeline with a
 * localized redirect message.
 *
 * Complements the existing (output-side) GuardrailAgent, which validates the
 * LLM response against pedagogical rules (solution leak, false confirmation…).
 */
class InputGuardrailAgent extends AgentInterface {
  /**
   * @param {object} deps
   * @param {import('../ports/services/ISecurityService')} deps.securityService
   */
  constructor(deps) {
    super("inputGuardrailAgent");
    this.securityService = deps.securityService;
  }

  async execute(context) {
    const result = await Promise.resolve(this.securityService.analyzeInput(context.userMessage, {
      lang: context.lang,
      exercise: context.exercise,
      evaluableElements: context.evaluableElements,
    }));

    context.inputSecurity = {
      safe: result.safe,
      category: result.category,
      matchedPattern: result.matchedPattern || null,
    };

    if (!result.safe) {
      context.inputBlocked = true;
      context.finalResponse = result.redirectMessage;
      context.fallthrough = true;
    }
  }

  canSkip(context) {
    // Always evaluate the student input, even on greetings — injection can
    // be hidden inside an innocent-looking message.
    return false;
  }
}

module.exports = InputGuardrailAgent;
