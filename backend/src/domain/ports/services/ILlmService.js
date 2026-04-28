"use strict";

/**
 * Port for LLM (Large Language Model) interactions.
 *
 * Options (all optional):
 *   - temperature: number      — sampling temperature
 *   - numPredict:  number      — max output tokens
 *   - numCtx:      number      — context window size
 *   - budgetMs:    number      — max ms for this call (NEW in Phase 4)
 *   - abort:       AbortSignal — external abort signal (NEW in Phase 4)
 *
 * budgetMs enables time-budget-aware clients (e.g. GuardrailPipeline): the
 * adapter will set its HTTP timeout to min(defaultTimeout, budgetMs), and
 * reject with a BudgetExhaustedError if the call exceeds budgetMs.
 *
 * Implementations:
 *   - OllamaLlmAdapter (active)
 *   - Future: OpenAILlmAdapter, AnthropicLlmAdapter, MockLlmAdapter (for tests)
 */
class ILlmService {
  /**
   * Non-streaming chat completion.
   * @param {Array<{role: string, content: string}>} messages
   * @param {object} [options]
   * @returns {Promise<string>} assistant response content
   */
  async chatCompletion(messages, options) {
    throw new Error("Not implemented");
  }

  /**
   * Streaming chat completion. Returns an async iterable / readable stream
   * of NDJSON chunks from the LLM provider.
   * @param {Array<{role: string, content: string}>} messages
   * @param {object} [options]
   * @returns {Promise<ReadableStream|AsyncIterable>}
   */
  async chatCompletionStream(messages, options) {
    throw new Error("Not implemented");
  }

  /** @returns {Promise<boolean>} */
  async isHealthy() {
    throw new Error("Not implemented");
  }
}

// Sentinel error thrown when a call exceeds its budgetMs.
class BudgetExhaustedError extends Error {
  constructor(message, context) {
    super(message || "LLM call exceeded budget");
    this.name = "BudgetExhaustedError";
    this.context = context || {};
  }
}

module.exports = ILlmService;
module.exports.BudgetExhaustedError = BudgetExhaustedError;
