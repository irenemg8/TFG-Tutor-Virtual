"use strict";

const StateRevealGuardrail = require("../../src/infrastructure/guardrails/StateRevealGuardrail");

/*------------------------------------------------------------------------------
            _________________________________________________________
            |   STATEREVEALGUARDRAIL ROTATION — UNIT TESTS (009-B)  |
            |  Regresses BUG-009-B (2026-05-03): the state-reveal   |
            |  placeholder rotates across 3 variants by prior-hit   |
            |  count read from ctx.messages, and is suppressed after |
            |  3 firings so the student is not spammed with the same |
            |  generic phrase turn after turn.                      |
        ____|_____                                                  |
        | ctx() | -> Obj                                            |
        --------                                                    |
            |_______________________________________________________|
------------------------------------------------------------------------------*/

describe("StateRevealGuardrail.surgicalFix — placeholder rotation (BUG-009-B)", () => {
  const g = new StateRevealGuardrail();

  /*
       IN -> ____|____
            | ctx() | -> Obj
             --------
      Builds an es context with the standard evaluableElements and the
      given message history.
  */
  function ctx(history) {
    return {
      lang: "es",
      evaluableElements: ["R1", "R2", "R3", "R4", "R5"],
      messages: history,
    };
  }

  const stateRevealResponse =
    "R1 está cortocircuitada en este circuito. ¿Por qué crees que pasa eso?";

  test("sin disparos previos → variante #1 (propiedad relevante)", () => {
    const r = g.surgicalFix(stateRevealResponse, ctx([]));
    expect(r.applied).toBe(true);
    expect(r.text).toMatch(/propiedad relevante que debes identificar/i);
  });

  test("1 disparo previo en historia → variante #2 (característica clave)", () => {
    const history = [
      { role: "user", content: "Creo que R1 contribuye" },
      { role: "assistant", content: "Vamos a revisar. Ese elemento tiene una propiedad relevante que debes identificar. ¿Por qué crees?" },
    ];
    const r = g.surgicalFix(stateRevealResponse, ctx(history));
    expect(r.applied).toBe(true);
    expect(r.text).toMatch(/característica clave/i);
  });

  test("2 disparos previos → variante #3 (pieza del análisis)", () => {
    const history = [
      { role: "assistant", content: "Ese elemento tiene una propiedad relevante que debes identificar. Sigue." },
      { role: "user", content: "no sé" },
      { role: "assistant", content: "Hay una característica clave de ese elemento que aún no has nombrado. ¿Cuál?" },
    ];
    const r = g.surgicalFix(stateRevealResponse, ctx(history));
    expect(r.applied).toBe(true);
    expect(r.text).toMatch(/pieza concreta del análisis/i);
  });

  test("3 disparos previos → suprime el placeholder, conserva la pregunta", () => {
    const history = [
      { role: "assistant", content: "Ese elemento tiene una propiedad relevante que debes identificar. ¿Cuál?" },
      { role: "assistant", content: "Hay una característica clave de ese elemento que aún no has nombrado." },
      { role: "assistant", content: "Falta una pieza concreta del análisis para llegar a la conclusión." },
    ];
    const r = g.surgicalFix(stateRevealResponse, ctx(history));
    expect(r.applied).toBe(true);
    expect(r.text).not.toMatch(/propiedad relevante|característica clave|pieza concreta/i);
    expect(r.text).toMatch(/\?/);
  });

  test("ignora mensajes user al contar disparos previos", () => {
    const history = [
      { role: "user", content: "Ese elemento tiene una propiedad relevante que debes identificar." },
      { role: "user", content: "Hay una característica clave de ese elemento que aún no has nombrado." },
    ];
    const r = g.surgicalFix(stateRevealResponse, ctx(history));
    expect(r.applied).toBe(true);
    expect(r.text).toMatch(/propiedad relevante que debes identificar/i);
  });

  test("messages ausente → trata como 0 disparos", () => {
    const r = g.surgicalFix(stateRevealResponse, {
      lang: "es",
      evaluableElements: ["R1", "R2", "R3", "R4", "R5"],
    });
    expect(r.applied).toBe(true);
    expect(r.text).toMatch(/propiedad relevante que debes identificar/i);
  });
});
