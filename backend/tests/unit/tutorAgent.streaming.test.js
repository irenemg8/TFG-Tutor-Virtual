"use strict";

const TutorAgent = require("../../src/domain/agents/tutorAgent");

function buildContext(overrides) {
  const base = {
    userMessage: "no sé",
    history: [],
    lang: "es",
    ejercicio: { tutorContext: { ac_refs: ["AC1"] } },
    classification: { type: "dont_know", concepts: [] },
    loopState: {
      prevCorrectTurns: 0,
      consecutiveWrongTurns: 0,
      totalAssistantTurns: 0,
      tutorRepeating: false,
      studentFrustrated: false,
      sameClassificationStreak: 0,
      lastClassification: null,
    },
    ragResult: { augmentation: "" },
    timing: { pipelineStartMs: Date.now() },
    budgetMs: 30000,
    tutorBudgetMs: 18000,
    streamedText: "",
    tokenStreamHandler: null,
  };
  return Object.assign(base, overrides);
}

function fakeLlmService(scriptedTokens) {
  const calls = { chat: 0, stream: 0 };
  return {
    calls,
    async chatCompletion(messages, options) {
      calls.chat++;
      return scriptedTokens.join("");
    },
    async chatCompletionStreamWithCallback(messages, options, onChunk) {
      calls.stream++;
      let full = "";
      for (const t of scriptedTokens) {
        full += t;
        if (onChunk) onChunk(t);
      }
      return full;
    },
  };
}

const noopLogger = {
  logPrompt() {},
  logLlmOut() {},
  traceLlmCall() {},
};

describe("TutorAgent streaming integration", () => {
  test("uses chatCompletionStreamWithCallback when context.tokenStreamHandler is set", async () => {
    const tokens = ["Hola", " ", "estudiante", "."];
    const llm = fakeLlmService(tokens);
    const agent = new TutorAgent({
      llmService: llm,
      buildSystemPrompt: () => "SYSTEM",
      config: { OLLAMA_TEMPERATURE: 0.4, OLLAMA_NUM_PREDICT: 256, OLLAMA_NUM_CTX: 4096, OLLAMA_MODEL: "qwen2.5" },
      debugLogger: noopLogger,
    });

    const emitted = [];
    const ctx = buildContext({
      tokenStreamHandler: (token) => emitted.push(token),
    });

    await agent.execute(ctx);

    expect(llm.calls.stream).toBe(1);
    expect(llm.calls.chat).toBe(0);
    expect(emitted).toEqual(tokens);
    expect(ctx.streamedText).toBe("Hola estudiante.");
    expect(ctx.llmResponse).toBe("Hola estudiante.");
    expect(ctx.timing.firstTokenMs).toBeGreaterThanOrEqual(0);
  });

  test("falls back to chatCompletion when no tokenStreamHandler is provided", async () => {
    const tokens = ["solo", " ", "uno"];
    const llm = fakeLlmService(tokens);
    const agent = new TutorAgent({
      llmService: llm,
      buildSystemPrompt: () => "SYSTEM",
      config: { OLLAMA_TEMPERATURE: 0.4, OLLAMA_NUM_PREDICT: 256, OLLAMA_NUM_CTX: 4096, OLLAMA_MODEL: "qwen2.5" },
      debugLogger: noopLogger,
    });

    const ctx = buildContext({ tokenStreamHandler: null });
    await agent.execute(ctx);

    expect(llm.calls.chat).toBe(1);
    expect(llm.calls.stream).toBe(0);
    expect(ctx.streamedText).toBe("");
    expect(ctx.llmResponse).toBe("solo uno");
  });

  test("a tokenStreamHandler that throws does not abort the LLM call", async () => {
    const llm = fakeLlmService(["ok"]);
    const agent = new TutorAgent({
      llmService: llm,
      buildSystemPrompt: () => "SYSTEM",
      config: { OLLAMA_TEMPERATURE: 0.4, OLLAMA_NUM_PREDICT: 256, OLLAMA_NUM_CTX: 4096, OLLAMA_MODEL: "qwen2.5" },
      debugLogger: noopLogger,
    });

    const ctx = buildContext({
      tokenStreamHandler: () => {
        throw new Error("client disconnected");
      },
    });

    await expect(agent.execute(ctx)).resolves.not.toThrow();
    expect(ctx.llmResponse).toBe("ok");
  });

  test("falls back to chatCompletion when adapter does not implement streaming callback", async () => {
    const llmNoStream = {
      called: 0,
      async chatCompletion() {
        this.called++;
        return "fallback text";
      },
      // chatCompletionStreamWithCallback intentionally absent
    };
    const agent = new TutorAgent({
      llmService: llmNoStream,
      buildSystemPrompt: () => "SYSTEM",
      config: { OLLAMA_TEMPERATURE: 0.4, OLLAMA_NUM_PREDICT: 256, OLLAMA_NUM_CTX: 4096, OLLAMA_MODEL: "qwen2.5" },
      debugLogger: noopLogger,
    });

    const ctx = buildContext({ tokenStreamHandler: () => {} });
    await agent.execute(ctx);

    expect(llmNoStream.called).toBe(1);
    expect(ctx.llmResponse).toBe("fallback text");
    expect(ctx.streamedText).toBe("");
  });
});
