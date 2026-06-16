"use strict";

const { Readable } = require("stream");
const RetrievalAgent = require("../../src/domain/agents/retrievalAgent");

/*------------------------------------------------------------------------------
            _________________________________________________________
            |                   RETRIEVAL BUDGET                    |
            |  Test suite for the retrieval time-budget mechanism.  |
            |  Verifies RetrievalAgent forwards retrievalBudgetMs   |
            |  as the 7th argument, propagates the retrievalTimedOut|
            |  flag, and that ragPipeline arms an AbortController at |
            |  budgetMs*0.95, aborts a slow Chroma call, swallows   |
            |  the AbortError and returns retrievalTimedOut:true.   |
            |_______________________________________________________|
------------------------------------------------------------------------------*/

describe("RetrievalAgent forwards budgetMs to runFullPipeline", () => {
  test("passes context.retrievalBudgetMs as the 7th argument", async () => {
    const calls = [];
    const stubRunFullPipeline = async function () {
      calls.push(Array.from(arguments));
      return { augmentation: "X", decision: "rag_examples", sources: [] };
    };
    const agent = new RetrievalAgent({ runFullPipeline: stubRunFullPipeline });
    const context = {
      classification: { type: "wrong_answer" },
      userMessage: "necesito una pista más concreta sobre el circuito",
      canonicalExerciseNum: 1,
      exerciseNum: 1,
      correctAnswer: ["R1"],
      userId: "u",
      evaluableElements: ["R1"],
      lang: "es",
      retrievalBudgetMs: 7500,
    };
    await agent.execute(context);
    expect(calls).toHaveLength(1);
    expect(calls[0][6]).toEqual({ budgetMs: 7500 });
  });

  test("propagates retrievalTimedOut flag from ragResult to context", async () => {
    const stubRunFullPipeline = async function () {
      return {
        augmentation: "",
        decision: "no_rag",
        sources: [],
        retrievalTimedOut: true,
      };
    };
    const agent = new RetrievalAgent({ runFullPipeline: stubRunFullPipeline });
    const context = {
      classification: { type: "wrong_answer" },
      userMessage: "una respuesta detallada que requiere búsqueda",
      canonicalExerciseNum: 1,
      exerciseNum: 1,
      correctAnswer: ["R1"],
      userId: "u",
      evaluableElements: ["R1"],
      lang: "es",
      retrievalBudgetMs: 1000,
    };
    await agent.execute(context);
    expect(context.retrievalTimedOut).toBe(true);
    expect(context.ragResult.augmentation).toBe("");
    expect(context.ragResult.decision).toBe("no_rag");
  });

  test("does NOT pass budget when retrievalBudgetMs is missing (legacy ragMiddleware path)", async () => {
    const calls = [];
    const stubRunFullPipeline = async function () {
      calls.push(Array.from(arguments));
      return { augmentation: "X", decision: "rag_examples", sources: [] };
    };
    const agent = new RetrievalAgent({ runFullPipeline: stubRunFullPipeline });
    const context = {
      classification: { type: "wrong_answer" },
      userMessage: "necesito una pista más concreta sobre el circuito",
      canonicalExerciseNum: 1,
      exerciseNum: 1,
      correctAnswer: ["R1"],
      userId: "u",
      evaluableElements: ["R1"],
      lang: "es",
    };
    await agent.execute(context);
    expect(calls[0][6]).toBeUndefined();
  });
});

describe("ragPipeline budget enforcement", () => {
  beforeEach(() => {
    jest.resetModules();
  });

  test("arms an AbortController and returns retrievalTimedOut on slow retrieval", async () => {
    jest.doMock("../../src/infrastructure/search/hybridSearch", () => ({
      hybridSearch: async function (q, exerciseNum, topK, options) {
        return await new Promise((resolve, reject) => {
          const t = setTimeout(() => resolve([]), 5000);
          if (options && options.signal) {
            options.signal.addEventListener("abort", () => {
              clearTimeout(t);
              const err = new Error("aborted");
              err.name = "AbortError";
              reject(err);
            });
          }
        });
      },
    }));
    jest.doMock("../../src/infrastructure/search/knowledgeGraph", () => ({
      searchKG: () => [],
    }));
    jest.doMock("../../src/container", () => ({ _initialized: false }), { virtual: false });

    const { createRagPipeline } = require("../../src/domain/services/rag/ragPipeline");
    const { hybridSearch } = require("../../src/infrastructure/search/hybridSearch");
    const { searchKG } = require("../../src/infrastructure/search/knowledgeGraph");
    const ragCfg = require("../../src/infrastructure/llm/config");
    const { runFullPipeline } = createRagPipeline({ hybridSearch, searchKG, emitEvent: () => {}, config: ragCfg });

    const start = Date.now();
    const result = await runFullPipeline(
      "R3 y R5 porque están conectadas en paralelo",
      1,
      ["R1", "R2", "R4"],
      "user1",
      ["R1", "R2", "R3", "R4", "R5"],
      "es",
      { budgetMs: 300 }
    );
    const elapsed = Date.now() - start;
    expect(result.retrievalTimedOut).toBe(true);
    expect(result.decision).toBe("no_rag");
    expect(elapsed).toBeLessThan(1500);
  });

  test("returns normally when retrieval finishes within budget", async () => {
    jest.doMock("../../src/infrastructure/search/hybridSearch", () => ({
      hybridSearch: async () => [
        { student: "R1, R2 y R4", tutor: "Genial", index: 0 },
      ],
    }));
    jest.doMock("../../src/infrastructure/search/knowledgeGraph", () => ({
      searchKG: () => [],
    }));
    jest.doMock("../../src/container", () => ({ _initialized: false }), { virtual: false });

    const { createRagPipeline } = require("../../src/domain/services/rag/ragPipeline");
    const { hybridSearch } = require("../../src/infrastructure/search/hybridSearch");
    const { searchKG } = require("../../src/infrastructure/search/knowledgeGraph");
    const ragCfg = require("../../src/infrastructure/llm/config");
    const { runFullPipeline } = createRagPipeline({ hybridSearch, searchKG, emitEvent: () => {}, config: ragCfg });

    const result = await runFullPipeline(
      "R3 y R5 porque están en paralelo",
      1,
      ["R1", "R2", "R4"],
      "user1",
      ["R1", "R2", "R3", "R4", "R5"],
      "es",
      { budgetMs: 5000 }
    );
    expect(result.retrievalTimedOut).toBeFalsy();
    expect(result.decision).not.toBe("no_rag");
  });
});
