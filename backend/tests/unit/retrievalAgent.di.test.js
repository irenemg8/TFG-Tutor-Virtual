"use strict";

const RetrievalAgent = require("../../src/domain/agents/retrievalAgent");

describe("RetrievalAgent NS-5 DI inversion", () => {
  test("forwards injected resultadoRepo to runFullPipeline.options", async () => {
    const calls = [];
    const stubRunFullPipeline = async function () {
      calls.push(Array.from(arguments));
      return { augmentation: "X", decision: "rag_examples", sources: [] };
    };
    const fakeRepo = { findByUserId: async () => [] };
    const agent = new RetrievalAgent({
      runFullPipeline: stubRunFullPipeline,
      resultadoRepo: fakeRepo,
    });
    const context = {
      classification: { type: "wrong_answer" },
      userMessage: "explicación detallada de por qué",
      canonicalExerciseNum: 1,
      exerciseNum: 1,
      correctAnswer: ["R1"],
      userId: "u",
      evaluableElements: ["R1"],
      lang: "es",
    };
    await agent.execute(context);
    expect(calls).toHaveLength(1);
    expect(calls[0][6]).toEqual({ resultadoRepo: fakeRepo });
  });

  test("omits options entirely when no resultadoRepo is injected", async () => {
    const calls = [];
    const stubRunFullPipeline = async function () {
      calls.push(Array.from(arguments));
      return { augmentation: "X", decision: "rag_examples", sources: [] };
    };
    const agent = new RetrievalAgent({ runFullPipeline: stubRunFullPipeline });
    const context = {
      classification: { type: "wrong_answer" },
      userMessage: "explicación detallada de por qué",
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
