"use strict";

const { _test } = require("../../src/interfaces/http/routes/exportRoutes");
const { flattenInteraccion } = _test;

/*------------------------------------------------------------------------------
            _________________________________________________________
            |              EXPORT FLATTEN - FIX DETAILS             |
            |  Test suite for flattenInteraccion surfacing the pre- |
            |  fix capture fields: llmResponseOriginal (raw LLM     |
            |  output before any guardrail rewrite) and             |
            |  guardrailRewrites (JSON-encoded list of              |
            |  {guardrailId,before,after,...}). Without these the   |
            |  export shows only boolean flags per guardrail.       |
        ____|________________                                       |
   Obj -> | makeAssistant() | -> Obj                                |
          -------------------                                       |
            |_______________________________________________________|
------------------------------------------------------------------------------*/

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

  /*
     IN -> ____|________________
          | makeAssistant() | -> Obj
           -------------------
        Builds an assistant message with default per-turn metadata, merging
        any extra metadata fields passed in.
  */
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
