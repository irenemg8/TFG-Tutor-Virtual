"use strict";

/**
 * NullHistorySummarizer: explicit no-op implementation of the historySummarizer
 * interface. Inject this when history summarization is intentionally disabled
 * (e.g. development environments without a local LLM, or short-session tests).
 *
 * Always returns null, which causes ContextAgent to skip the summary system
 * message and fall back to the recent-window-only behaviour.
 */
class NullHistorySummarizer {
  async summarize() {
    return null;
  }
}

module.exports = NullHistorySummarizer;
