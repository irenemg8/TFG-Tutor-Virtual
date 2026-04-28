"use strict";

const { classifyQuery } = require("../../src/domain/services/rag/queryClassifier");

// Smoke tests for the rule-based classifier. Cubren los caminos críticos del
// orchestrator (greeting → handleGreeting inline; correct/wrong → LLM path)
// y la propagación de concepts que después usa el conceptsBanner del tutor.

describe("classifyQuery", () => {
  const correctAnswer = ["R1", "R2", "R4"];
  const evaluable = ["R1", "R2", "R3", "R4", "R5"];

  test('greeting con "hola" sin elementos', () => {
    const r = classifyQuery("hola", correctAnswer, evaluable);
    expect(r.type).toBe("greeting");
    expect(r.proposed).toEqual([]);
  });

  test('"no lo sé" → dont_know', () => {
    const r = classifyQuery("no lo sé", correctAnswer, evaluable);
    expect(r.type).toBe("dont_know");
  });

  test("respuesta correcta sin razonamiento", () => {
    const r = classifyQuery("R1, R2, R4", correctAnswer, evaluable);
    expect(r.type).toBe("correct_no_reasoning");
    expect(r.proposed.sort()).toEqual(["R1", "R2", "R4"]);
  });

  test("respuesta correcta con concepto wrong (divisor de tensión)", () => {
    const r = classifyQuery(
      "R1, R2 y R4 por el divisor de tensión",
      correctAnswer,
      evaluable
    );
    // Sin negaciones explícitas + concepto -> correct_wrong_reasoning
    expect(r.type).toBe("correct_wrong_reasoning");
    expect(r.concepts.length).toBeGreaterThan(0);
  });

  test("propone elementos equivocados → wrong_answer", () => {
    const r = classifyQuery("R5", correctAnswer, evaluable);
    expect(r.type).toBe("wrong_answer");
    expect(r.proposed).toContain("R5");
  });

  test("classification.concepts se propaga (entrada para conceptsBanner)", () => {
    const r = classifyQuery(
      "R1 y R2 por el divisor de tensión",
      correctAnswer,
      evaluable
    );
    expect(r.concepts.some((c) => c.toLowerCase().includes("divisor"))).toBe(true);
  });

  test("negación con 'no contribuye' clasifica el elemento como negated", () => {
    const r = classifyQuery(
      "R3 no contribuye, R5 está cortocircuitada",
      correctAnswer,
      evaluable
    );
    expect(r.negated).toContain("R3");
  });
});
