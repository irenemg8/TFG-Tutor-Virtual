"use strict";

const { Readable } = require("stream");
const RetrievalAgent = require("../../src/domain/agents/retrievalAgent");

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
  // Real ragPipeline pulls from ChromaDB / Ollama embeddings — way too heavy
  // for a unit test. Instead we exercise the AbortController glue by mocking
  // the inner hybridSearch to simulate a slow Chroma call. The pipeline must:
  //   1. arm a timer at budgetMs * 0.95
  //   2. abort the in-flight request when the timer fires
  //   3. swallow the AbortError and return retrievalTimedOut:true
  //
  // We monkey-patch require so ragPipeline picks up our fake hybridSearch
  // without touching its source.
  beforeEach(() => {
    jest.resetModules();
  });

  test("arms an AbortController and returns retrievalTimedOut on slow retrieval", async () => {
    jest.doMock("../../src/infrastructure/search/hybridSearch", () => ({
      hybridSearch: async function (q, exerciseNum, topK, options) {
        // Simulate a slow Chroma call that respects the abort signal.
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

    const { runFullPipeline } = require("../../src/domain/services/rag/ragPipeline");

    const start = Date.now();
    // R3 y R5 are NOT in the correct answer (R1, R2, R4) — classifier returns
    // wrong_answer, which is one of the branches that hits hybridSearch.
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
    expect(elapsed).toBeLessThan(1500); // never wait the full 5s
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

    const { runFullPipeline } = require("../../src/domain/services/rag/ragPipeline");

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
