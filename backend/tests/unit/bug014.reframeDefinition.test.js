"use strict";

const PedagogicalReviewerAgent = require("../../src/domain/agents/pedagogicalReviewerAgent");

/*------------------------------------------------------------------------------
            _________________________________________________________
            |   REFRAME DEFINITION — UNIT TESTS (BUG-014)           |
            |  Regresses BUG-014 (2026-05-03): the                  |
            |  _reframeDefinitionRequest regex swallowed sub-clauses |
            |  like "que es parte de un divisor" inside legitimate   |
            |  questions, producing corrupt output with nested ¿.    |
            |  Verifies the reframe only fires when the WHOLE phrase  |
            |  is a definition-request, across es/val/en.           |
            |_______________________________________________________|
------------------------------------------------------------------------------*/

describe("PedagogicalReviewerAgent._reframeDefinitionRequest (BUG-014)", () => {
  const a = Object.create(PedagogicalReviewerAgent.prototype);

  test("NO toca pregunta legítima con 'que es' en sub-cláusula (BUG-014)", () => {
    const input =
      "¿Cómo afecta R1 al flujo de corriente entre N2 y tierra si consideramos que es parte de un divisor de tensión?";
    const out = a._reframeDefinitionRequest(input, "es");
    expect(out).toBe(input);
    const aperturas = (out.match(/¿/g) || []).length;
    expect(aperturas).toBeLessThanOrEqual(1);
  });

  test("SÍ reemplaza pregunta-definición pura '¿Qué es un divisor de tensión?'", () => {
    const input = "¿Qué es un divisor de tensión?";
    const out = a._reframeDefinitionRequest(input, "es");
    expect(out).toMatch(/se aplica ese concepto a ESTE circuito/);
  });

  test("SÍ reemplaza '¿Qué entiendes por cortocircuito?'", () => {
    const input = "¿Qué entiendes por cortocircuito?";
    const out = a._reframeDefinitionRequest(input, "es");
    expect(out).toMatch(/se aplica ese concepto/);
  });

  test("SÍ reemplaza 'Define divisor de tensión.'", () => {
    const input = "Define divisor de tensión.";
    const out = a._reframeDefinitionRequest(input, "es");
    expect(out).toMatch(/se aplica ese concepto/);
  });

  test("SÍ reemplaza '¿Cómo definirías la ley de Ohm?'", () => {
    const input = "¿Cómo definirías la ley de Ohm?";
    const out = a._reframeDefinitionRequest(input, "es");
    expect(out).toMatch(/se aplica ese concepto/);
  });

  test("NO toca 'Recuerda que es importante el divisor de tensión' (afirmación)", () => {
    const input = "Recuerda que es importante el divisor de tensión.";
    const out = a._reframeDefinitionRequest(input, "es");
    expect(out).toBe(input);
  });

  test("respuesta multifrase: solo reemplaza la frase definición, conserva la otra", () => {
    const input = "Bien encaminado. ¿Qué es un divisor de tensión? Piénsalo.";
    const out = a._reframeDefinitionRequest(input, "es");
    expect(out).toMatch(/Bien encaminado\./);
    expect(out).toMatch(/se aplica ese concepto/);
    expect(out).toMatch(/Piénsalo\./);
    expect(out).not.toMatch(/¿Qué es un divisor/);
  });

  test("VAL: reframe se aplica a '¿Què és un divisor de tensió?'", () => {
    const input = "¿Què és un divisor de tensió?";
    const out = a._reframeDefinitionRequest(input, "val");
    expect(out).toMatch(/Com s'aplica eixe concepte a AQUEST circuit/);
  });

  test("EN: reframe se aplica a 'What is Ohm's law?'", () => {
    const input = "What is Ohm's law?";
    const out = a._reframeDefinitionRequest(input, "en");
    expect(out).toMatch(/How does that concept apply/);
  });

  test("input no-string devuelve sin cambios", () => {
    expect(a._reframeDefinitionRequest(null, "es")).toBe(null);
    expect(a._reframeDefinitionRequest(undefined, "es")).toBe(undefined);
  });

  test("respuesta sin pregunta-definición no se toca", () => {
    const input = "R1 contribuye al voltaje. ¿Cómo afecta a R2 en este circuito?";
    const out = a._reframeDefinitionRequest(input, "es");
    expect(out).toBe(input);
  });

  test("regression: pregunta con 'considerar que es' embebido NO se rompe", () => {
    const input =
      "Si consideramos que es una resistencia ideal, ¿cómo se comporta R5 en el modelo?";
    const out = a._reframeDefinitionRequest(input, "es");
    expect(out).toBe(input);
    expect(out).not.toMatch(/se aplica ese concepto/);
  });
});
