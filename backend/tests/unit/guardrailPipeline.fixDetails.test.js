"use strict";

// Verifies the pipeline now returns surgicalFixDetails — a chronological
// list of {guardrailId, before, after, durationMs, phase} entries.
// Without this list the export endpoint can only show a boolean flag per
// guardrail; with it analysts can see the LLM's pre-fix sentence.

const GuardrailPipeline = require("../../src/domain/services/GuardrailPipeline");

function mockLogger() {
  return {
    traceGuardrailCheck() {},
    traceSurgicalFix() {},
    traceLlmRetry() {},
    traceLlmCall() {},
    traceError() {},
  };
}

function mockLlm(responses) {
  let i = 0;
  return {
    chatCompletion: async () => responses[i++] || "",
  };
}

class StubGuardrail {
  constructor(opts) {
    this._id = opts.id;
    this._violates = opts.violates;
    this._fix = opts.fix; // (currentResponse, ctx) => FixResult | null
    this._retryHint = opts.retryHint || "";
  }
  get id() { return this._id; }
  check(response) {
    return typeof this._violates === "function"
      ? this._violates(response)
      : { violated: !!this._violates };
  }
  surgicalFix(response, ctx) {
    return typeof this._fix === "function" ? this._fix(response, ctx) : null;
  }
  buildRetryHint() { return this._retryHint; }
}

describe("GuardrailPipeline — surgicalFixDetails capture", () => {
  test("primary_ok: empty fix list when no violations", async () => {
    const pipeline = new GuardrailPipeline({
      guardrails: [new StubGuardrail({ id: "g1", violates: false })],
      llmService: mockLlm([]),
      logger: mockLogger(),
    });
    const result = await pipeline.validate("safe response", {}, { messages: [] });
    expect(result.path).toBe("primary_ok");
    expect(result.surgicalFixesApplied).toEqual([]);
    expect(result.surgicalFixDetails).toEqual([]);
  });

  test("Phase B fix: details capture before/after with phase=B", async () => {
    const guardrail = new StubGuardrail({
      id: "solution_leak",
      violates: true,
      fix: (response) => ({
        applied: true,
        text: "Has acertado con ese conjunto de elementos.",
        before: response,
        after: "Has acertado con ese conjunto de elementos.",
      }),
    });
    // After the fix, re-check returns no violation (we toggle the stub).
    let firstCallDone = false;
    guardrail.check = function (response) {
      const violated = !firstCallDone;
      firstCallDone = true;
      return { violated };
    };

    const pipeline = new GuardrailPipeline({
      guardrails: [guardrail],
      llmService: mockLlm([]),
      logger: mockLogger(),
    });
    const result = await pipeline.validate(
      "Has acertado con R1, R2 y R4.",
      {},
      { messages: [] }
    );
    expect(result.path).toBe("surgical_ok");
    expect(result.surgicalFixesApplied).toEqual(["solution_leak"]);
    expect(result.surgicalFixDetails).toHaveLength(1);
    const d = result.surgicalFixDetails[0];
    expect(d.guardrailId).toBe("solution_leak");
    expect(d.before).toBe("Has acertado con R1, R2 y R4.");
    expect(d.after).toBe("Has acertado con ese conjunto de elementos.");
    expect(d.phase).toBe("B");
    expect(typeof d.durationMs).toBe("number");
  });

  test("budget_exhausted still carries the fix details from Phase B", async () => {
    // Surgical fix in Phase B doesn't fully resolve (still violated after).
    // Pipeline tries to retry but budget is exhausted, so it returns
    // budget_exhausted — the partial Phase B details must still be present.
    const guardrail = new StubGuardrail({
      id: "false_confirmation",
      violates: true,
      fix: (response) => ({
        applied: true,
        text: response + " (patched)",
        before: response,
        after: response + " (patched)",
      }),
      retryHint: "do not confirm",
    });
    const pipeline = new GuardrailPipeline({
      guardrails: [guardrail],
      llmService: mockLlm([]),
      logger: mockLogger(),
      budgetMs: 0, // immediately under minRetryBudgetMs
      minRetryBudgetMs: 1,
    });
    const result = await pipeline.validate("praise wrong answer", {}, { messages: [] });
    expect(result.path).toBe("budget_exhausted");
    expect(result.surgicalFixDetails).toHaveLength(1);
    expect(result.surgicalFixDetails[0].guardrailId).toBe("false_confirmation");
    expect(result.surgicalFixDetails[0].phase).toBe("B");
    expect(result.surgicalFixDetails[0].before).toBe("praise wrong answer");
  });

  test("falls back to currentResponse / fix.text when adapter omits before/after", async () => {
    // Some legacy adapters return {applied,text} without before/after.
    // The pipeline should fill them from the surrounding state so analysts
    // never see undefined fields.
    const guardrail = new StubGuardrail({
      id: "legacy_fix",
      violates: true,
      fix: () => ({ applied: true, text: "patched" }), // no before/after
    });
    let calls = 0;
    guardrail.check = function () {
      const violated = calls === 0;
      calls++;
      return { violated };
    };
    const pipeline = new GuardrailPipeline({
      guardrails: [guardrail],
      llmService: mockLlm([]),
      logger: mockLogger(),
    });
    const result = await pipeline.validate("raw text", {}, { messages: [] });
    expect(result.path).toBe("surgical_ok");
    expect(result.surgicalFixDetails[0].before).toBe("raw text");
    expect(result.surgicalFixDetails[0].after).toBe("patched");
  });
});
