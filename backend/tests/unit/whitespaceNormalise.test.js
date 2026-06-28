"use strict";

const TutoringOrchestrator = require("../../src/domain/agents/orchestrator");

/*------------------------------------------------------------------------------
            _________________________________________________________
            |                WHITESPACE NORMALISE                  |
            |  Test suite for orchestrator._normaliseWhitespace.    |
            |  Verifies it inserts a space after . ! ? before the   |
            |  next letter, preserves opening marks ¿ ¡, collapses  |
            |  double spaces while keeping newlines, splits glued   |
            |  lowercase->Uppercase (qwen2.5 hallucination), and    |
            |  leaves short identifiers like R5/V1 untouched.       |
        ____|_________                                              |
   void -> | build() | -> Obj                                       |
           ---------                                                |
            |_______________________________________________________|
------------------------------------------------------------------------------*/

/*
     void -> ____|_________
            | build() | -> Obj
             ---------
        Builds a TutoringOrchestrator wired with no-op stub agents.
*/
function build() {
  return new TutoringOrchestrator({
    context: { execute: async () => {} },
    inputGuardrail: { execute: async () => {} },
    classifier: { execute: async () => {} },
    retrieval: { execute: async () => {}, canSkip: () => true },
    tutor: { execute: async () => {} },
    guardrail: { execute: async () => {}, canSkip: () => true },
    persistence: { execute: async () => {} },
  });
}

describe("orchestrator._normaliseWhitespace", () => {
  test("inserts space after . ! ? when missing before next letter", () => {
    const o = build();
    const ctx = { finalResponse: "¡Buenos avances!ese elemento.Y luego.Considera esto?Mira otra vez" };
    o._normaliseWhitespace(ctx);
    expect(ctx.finalResponse).toBe("¡Buenos avances! ese elemento. Y luego. Considera esto? Mira otra vez");
    expect(ctx.whitespaceNormalised).toBe(true);
  });

  test("does not duplicate spaces when already correct", () => {
    const o = build();
    const ctx = { finalResponse: "Hola. ¿Cómo estás? Bien." };
    o._normaliseWhitespace(ctx);
    expect(ctx.finalResponse).toBe("Hola. ¿Cómo estás? Bien.");
    expect(ctx.whitespaceNormalised).toBeFalsy();
  });

  test("preserves opening punctuation marks like ¿ and ¡", () => {
    const o = build();
    const ctx = { finalResponse: "No es así.¿Por qué crees eso?" };
    o._normaliseWhitespace(ctx);
    expect(ctx.finalResponse).toBe("No es así. ¿Por qué crees eso?");
  });

  test("collapses double spaces but keeps newlines", () => {
    const o = build();
    const ctx = { finalResponse: "Línea uno.\nLínea dos.  Tres   espacios." };
    o._normaliseWhitespace(ctx);
    expect(ctx.finalResponse).toBe("Línea uno.\nLínea dos. Tres espacios.");
  });

  test("ignores when finalResponse is missing", () => {
    const o = build();
    const ctx = {};
    expect(() => o._normaliseWhitespace(ctx)).not.toThrow();
  });

  test("real case from production logs — splits placeholder + LLM continuation", () => {
    const o = build();
    const ctx = { finalResponse: "Cuidado, hay un error en ese razonamiento.¡Buenos avances!ese elemento tiene una propiedad relevante que debes identificarAhora, ¿puedes observar los terminales?" };
    o._normaliseWhitespace(ctx);
    expect(ctx.finalResponse).toBe("Cuidado, hay un error en ese razonamiento. ¡Buenos avances! ese elemento tiene una propiedad relevante que debes identificar Ahora, ¿puedes observar los terminales?");
  });

  test("splits glued lowercase->Uppercase pattern (qwen2.5 hallucination)", () => {
    const o = build();
    const ctx = { finalResponse: "El alumno escribióAhora pensemosTotalmente cierto" };
    o._normaliseWhitespace(ctx);
    expect(ctx.finalResponse).toBe("El alumno escribió Ahora pensemos Totalmente cierto");
  });

  test("does NOT split short tokens (CamelCase identifiers like R5, V1)", () => {
    const o = build();
    const ctx = { finalResponse: "Mira R5 y V1 con atención." };
    o._normaliseWhitespace(ctx);
    expect(ctx.finalResponse).toBe("Mira R5 y V1 con atención.");
  });
});
