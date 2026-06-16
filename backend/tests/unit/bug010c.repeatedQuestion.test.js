"use strict";

const RepeatedQuestionGuardrail = require("../../src/infrastructure/guardrails/RepeatedQuestionGuardrail");
const ContextAgent = require("../../src/domain/agents/contextAgent");

/*------------------------------------------------------------------------------
            _________________________________________________________
            |   REPEATED QUESTION — UNIT TESTS (BUG-010-C)          |
            |  Regresses BUG-010-C (2026-05-03): the model repeated  |
            |  the previous turn's Socratic question verbatim.       |
            |  Covers contextAgent._extractLastQuestion (exposes the |
            |  literal prior question) and RepeatedQuestionGuardrail |
            |  (post-LLM safety net detecting near-duplicates).     |
        ____|_____                                                  |
        | ctx() | -> Obj                                            |
        --------                                                    |
            |_______________________________________________________|
------------------------------------------------------------------------------*/

describe("contextAgent._extractLastQuestion (BUG-010-C)", () => {
  const a = Object.create(ContextAgent.prototype);

  test("devuelve la última pregunta del último mensaje assistant", () => {
    const msgs = [
      { content: "Hola. ¿Qué tal estás hoy?" },
      { content: "Vamos al circuito. ¿Qué crees que pasa con R1?" },
    ];
    expect(a._extractLastQuestion(msgs)).toMatch(/R1/);
  });

  test("salta mensajes sin '?' y busca el más reciente con pregunta", () => {
    const msgs = [
      { content: "¿Qué piensas de R1?" },
      { content: "Bien. Sigamos con el circuito." },
      { content: "Considera R2 ahora." },
    ];
    expect(a._extractLastQuestion(msgs)).toMatch(/R1/);
  });

  test("array vacío devuelve cadena vacía", () => {
    expect(a._extractLastQuestion([])).toBe("");
  });

  test("array no-array devuelve cadena vacía", () => {
    expect(a._extractLastQuestion(null)).toBe("");
    expect(a._extractLastQuestion(undefined)).toBe("");
  });

  test("mensajes sin pregunta alguna devuelven cadena vacía", () => {
    const msgs = [{ content: "Vamos a continuar." }];
    expect(a._extractLastQuestion(msgs)).toBe("");
  });
});

describe("RepeatedQuestionGuardrail (BUG-010-C)", () => {
  const g = new RepeatedQuestionGuardrail();

  /*
       IN -> ____|____
            | ctx() | -> Obj
             --------
      Builds a guardrail context from a message history and optional lang.
  */
  function ctx(messages, lang = "es") {
    return { lang, messages };
  }

  test("flagea pregunta IDÉNTICA a la del turno previo", () => {
    const prev = "¿Podrías decirme a qué nodo está conectada la otra terminal de R1?";
    const next = "Sí, R1 conecta N1 con N2. ¿Podrías decirme a qué nodo está conectada la otra terminal de R1?";
    const r = g.check(next, ctx([
      { role: "user", content: "N1 y N2" },
      { role: "assistant", content: prev },
    ]));
    expect(r.violated).toBe(true);
    expect(r.evidence).toMatch(/similarity=/);
  });

  test("flagea pregunta casi idéntica con palabras reordenadas", () => {
    const prev = "¿Cómo afecta R2 al voltaje entre N2 y tierra?";
    const next = "Bien. ¿Cómo afecta R2 al voltaje entre tierra y N2?";
    const r = g.check(next, ctx([
      { role: "assistant", content: prev },
    ]));
    expect(r.violated).toBe(true);
  });

  test("NO flagea pregunta sobre elemento distinto", () => {
    const prev = "¿Cómo afecta R2 al voltaje entre N2 y tierra?";
    const next = "¿Crees que R4 está en paralelo con R2?";
    const r = g.check(next, ctx([
      { role: "assistant", content: prev },
    ]));
    expect(r.violated).toBe(false);
  });

  test("NO flagea cuando la respuesta nueva no contiene '?'", () => {
    const prev = "¿Qué crees de R1?";
    const next = "R1 está en serie con R2.";
    const r = g.check(next, ctx([
      { role: "assistant", content: prev },
    ]));
    expect(r.violated).toBe(false);
  });

  test("NO flagea cuando no hay mensaje assistant previo con pregunta", () => {
    const next = "¿Qué crees de R1?";
    const r = g.check(next, ctx([
      { role: "user", content: "Hola" },
    ]));
    expect(r.violated).toBe(false);
  });

  test("surgicalFix devuelve null para forzar retry", () => {
    const prev = "¿Por qué crees que R5 está cortocircuitada?";
    const next = "Vamos a revisar. ¿Por qué crees que R5 está cortocircuitada?";
    const fix = g.surgicalFix(next, ctx([
      { role: "assistant", content: prev },
    ]));
    expect(fix).toBeNull();
  });

  test("surgicalFix devuelve applied=false en respuestas limpias", () => {
    const next = "¿Cómo afecta R4 al voltaje?";
    const fix = g.surgicalFix(next, ctx([
      { role: "assistant", content: "¿Y R1, qué crees?" },
    ]));
    expect(fix.applied).toBe(false);
    expect(fix.text).toBe(next);
  });

  test("buildRetryHint cubre los tres idiomas", () => {
    expect(g.buildRetryHint("es")).toMatch(/diferente|ÁNGULO/i);
    expect(g.buildRetryHint("val")).toMatch(/angle/i);
    expect(g.buildRetryHint("en")).toMatch(/different/i);
  });
});
