"use strict";

/*------------------------------------------------------------------------------
            _________________________________________________________
            |                  NULLHISTORYSUMMARIZER                |
            |  No-op implementation of the historySummarizer        |
            |  interface. Inject it when history summarization is   |
            |  intentionally disabled (dev without a local LLM, or  |
            |  short-session tests). Always returns null so the     |
            |  ContextAgent falls back to recent-window-only.       |
        ____|________________                                       |
        | summarize() | -> Promise<null>                            |
        ---------------                                             |
            |                                                       |
            |_______________________________________________________|
------------------------------------------------------------------------------*/
class NullHistorySummarizer {
  /*
       ____|________________
      | summarize() | -> Promise<null>
       ---------------
      Always resolves to null, signalling no summary is available.
  */
  async summarize() {
    return null;
  }
}

module.exports = NullHistorySummarizer;
