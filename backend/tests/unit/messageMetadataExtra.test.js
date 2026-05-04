"use strict";

const MessageMetadata = require("../../src/domain/entities/MessageMetadata");

describe("MessageMetadata — extra fields persisted in extra_metadata JSONB", () => {
  test("default-constructs all extra fields with safe defaults", () => {
    const m = new MessageMetadata({});
    expect(m.detectedACs).toEqual([]);
    expect(m.guardrailPath).toBeNull();
    expect(m.guardrailLlmRetries).toBe(0);
    expect(m.guardrailSurgicalFixes).toEqual([]);
    expect(m.fallbackUsed).toBe(false);
    expect(m.deterministicFinish).toBe(false);
    expect(m.timing.firstTokenMs).toBeNull();
    // New guardrails default to false:
    expect(m.guardrails.languageDrift).toBe(false);
    expect(m.guardrails.completeSolution).toBe(false);
    expect(m.guardrails.adherence).toBe(false);
    expect(m.guardrails.repeatedQuestion).toBe(false);
  });

  test("captures detectedACs verdict from acDetectorAgent", () => {
    const detected = [
      { id: "AC-V1", name: "Confunde voltaje con corriente", confidence: 0.82 },
      { id: "AC-R3", name: "Resistencias en paralelo", confidence: 0.61 },
    ];
    const m = new MessageMetadata({ detectedACs: detected });
    expect(m.detectedACs).toEqual(detected);
  });

  test("captures firstTokenMs in timing", () => {
    const m = new MessageMetadata({
      timing: { pipelineMs: 100, ollamaMs: 800, totalMs: 950, firstTokenMs: 230 },
    });
    expect(m.timing.firstTokenMs).toBe(230);
    expect(m.timing.totalMs).toBe(950);
  });

  test("captures the new guardrails added on feat/ac-detection", () => {
    const m = new MessageMetadata({
      guardrails: {
        languageDrift: true,
        completeSolution: true,
        adherence: true,
        repeatedQuestion: true,
      },
    });
    expect(m.guardrails.languageDrift).toBe(true);
    expect(m.guardrails.completeSolution).toBe(true);
    expect(m.guardrails.adherence).toBe(true);
    expect(m.guardrails.repeatedQuestion).toBe(true);
    // Legacy four still default to false:
    expect(m.guardrails.solutionLeak).toBe(false);
    expect(m.guardrails.falseConfirmation).toBe(false);
  });

  test("captures pipeline diagnostics", () => {
    const m = new MessageMetadata({
      guardrailPath: "llm_retry_ok",
      guardrailLlmRetries: 1,
      guardrailSurgicalFixes: ["solution_leak", "adherence"],
      fallbackUsed: false,
      deterministicFinish: false,
    });
    expect(m.guardrailPath).toBe("llm_retry_ok");
    expect(m.guardrailLlmRetries).toBe(1);
    expect(m.guardrailSurgicalFixes).toEqual(["solution_leak", "adherence"]);
  });

  test("non-array detectedACs/surgicalFixes are coerced to []", () => {
    const m = new MessageMetadata({
      detectedACs: "not-an-array",
      guardrailSurgicalFixes: { foo: "bar" },
    });
    expect(m.detectedACs).toEqual([]);
    expect(m.guardrailSurgicalFixes).toEqual([]);
  });
});
