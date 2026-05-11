"use strict";

// Verifies that flattenInteraccion surfaces the new fields:
//   llmResponseOriginal — raw LLM output before any guardrail rewrite
//   guardrailRewrites   — JSON-encoded list of {guardrailId,before,after,...}
// Without these, the export only shows boolean flags per guardrail and an
// analyst can't see what the model was about to say before redaction.

const { _test } = require("../../src/interfaces/http/routes/exportRoutes");
const { flattenInteraccion } = _test;

describe("exportRoutes.flattenInteraccion — pre-fix capture", () => {
  const inter = {
    id: "i-1",
    userId: "u-1",
    exerciseId: "e-1",
    startTime: new Date(),
    endTime: new Date(),
  };
  const usuario = { upvLogin: "ana", firstName: "Ana", lastName: "P" };
  const ejercicio = { title: "Ej1" };

  function makeAssistant(extraMeta) {
    return {
      role: "assistant",
      content: "post-fix content",
      timestamp: new Date(),
      metadata: Object.assign(
        {
          classification: "correct_no_reasoning",
          decision: "demand_reasoning",
          isCorrectAnswer: false,
          sourcesCount: 0,
          guardrails: {
            solutionLeak: true,
            falseConfirmation: false,
            prematureConfirmation: false,
            stateReveal: false,
            languageDrift: false,
            completeSolution: false,
            adherence: false,
            repeatedQuestion: false,
            didacticExplanation: false,
            datasetStyle: false,
          },
          timing: { pipelineMs: 100, ollamaMs: 500, totalMs: 600 },
          guardrailSurgicalFixes: ["solution_leak"],
        },
        extraMeta
      ),
    };
  }

  test("surfaces llmResponseOriginal and guardrailRewrites when a fix ran", () => {
    const fixDetails = [
      {
        guardrailId: "solution_leak",
        before: "Has acertado con R1, R2 y R4.",
        after: "Has acertado con ese conjunto de elementos.",
        durationMs: 4,
        phase: "B",
      },
    ];
    const messages = [
      makeAssistant({
        llmResponseOriginal: "Has acertado con R1, R2 y R4.",
        guardrailSurgicalFixDetails: fixDetails,
      }),
    ];
    const [row] = flattenInteraccion(inter, messages, usuario, ejercicio);
    expect(row.llmResponseOriginal).toBe("Has acertado con R1, R2 y R4.");
    // Stored as JSON string so a CSV cell can hold the structured list.
    const parsed = JSON.parse(row.guardrailRewrites);
    expect(parsed).toEqual(fixDetails);
  });

  test("absent fields are emitted as empty strings (no undefined leak)", () => {
    const messages = [makeAssistant({})];
    const [row] = flattenInteraccion(inter, messages, usuario, ejercicio);
    expect(row.llmResponseOriginal).toBe("");
    expect(row.guardrailRewrites).toBe("");
  });
});
