"use strict";

/*------------------------------------------------------------------------------
            _________________________________________________________
            |                     ILLMSERVICE                       |
            |  Port/interface defining the contract for LLM (Large  |
            |  Language Model) interactions. Options are all        |
            |  optional: temperature (R), numPredict (Z),           |
            |  numCtx (Z), budgetMs (Z), abort (AbortSignal).       |
            |  budgetMs enables time-budget-aware clients: the      |
            |  adapter caps its HTTP timeout to min(default,        |
            |  budgetMs) and rejects with BudgetExhaustedError on   |
            |  overrun. Active adapter: OllamaLlmAdapter. The       |
            |  methods here just throw.                             |
            |                                                       |
        ____|_______________________                               |
   [Obj], Obj -> | chatCompletion() | -> Promise<Txt>             |
                 ------------------                                |
        ____|_____________________________                         |
   [Obj], Obj -> | chatCompletionStream() | -> Promise<Obj>       |
                 ------------------------                          |
        ____|_________________________________________             |
   [Obj], Obj, Fn -> | chatCompletionStreamWithCallback() |       |
                     ------------------------------------         |
                     -> Promise<Txt>                               |
        ____|____________                                          |
        | isHealthy() | -> Promise<T/F>                            |
        -------------                                               |
            |                                                       |
            |_______________________________________________________|
------------------------------------------------------------------------------*/
class ILlmService {
  /*
   [Obj], Obj -> ____|_______________________
                | chatCompletion() | -> Promise<Txt>
                 ------------------
      Contract: non-streaming chat completion over a messages array
      (each { role, content }) and optional options; resolves the
      assistant response content. Abstract here.
  */
  async chatCompletion(messages, options) {
    throw new Error("Not implemented");
  }

  /*
   [Obj], Obj -> ____|_____________________________
                | chatCompletionStream() | -> Promise<Obj>
                 ------------------------
      Contract: streaming chat completion; resolves an async iterable /
      readable stream of NDJSON chunks from the LLM provider. Abstract
      here.
  */
  async chatCompletionStream(messages, options) {
    throw new Error("Not implemented");
  }

  /*
   [Obj], Obj, Fn -> ____|_________________________________________
                    | chatCompletionStreamWithCallback() | -> Promise<Txt>
                     ------------------------------------
      Contract: streaming chat completion with a per-token callback.
      Calls onChunk(token) for each piece and resolves with the
      accumulated full text. Adapters may fall back to chatCompletion
      when streaming is unavailable, invoking onChunk once with the
      whole response. Abstract here.
  */
  async chatCompletionStreamWithCallback(messages, options, onChunk) {
    throw new Error("Not implemented");
  }

  /*
       ____|____________
      | isHealthy() | -> Promise<T/F>
       -------------
      Contract: resolve true when the LLM backend is reachable and
      healthy. Abstract here.
  */
  async isHealthy() {
    throw new Error("Not implemented");
  }
}

/*
       ____|_________________
      | BudgetExhaustedError | extends Error
       ----------------------
      Sentinel error thrown when an LLM call exceeds its budgetMs. Its
      constructor sets the name and attaches a context object.
*/
class BudgetExhaustedError extends Error {
  constructor(message, context) {
    super(message || "LLM call exceeded budget");
    this.name = "BudgetExhaustedError";
    this.context = context || {};
  }
}

module.exports = ILlmService;
module.exports.BudgetExhaustedError = BudgetExhaustedError;
