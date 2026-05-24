"use strict";

/**
 * BUG-013 (2026-05-03): el embedding remoto (Ollama UPV) tarda 10-18s
 * en cold-start. Para queries triviales (Rn corto, yes/no, "no sé") la
 * búsqueda semántica + BM25 no aporta info que el LLM no tenga ya. El
 * canSkip() del RetrievalAgent ahora bypassea el retrieval en esos casos.
 */

const RetrievalAgent = require("../../src/domain/agents/retrievalAgent");

describe("RetrievalAgent.canSkip (BUG-013)", () => {
  const a = new RetrievalAgent({ runFullPipeline: () => {} });

  test("greeting → skip", () => {
    expect(a.canSkip({ userMessage: "Hola", classification: { type: "greeting" } })).toBe(true);
  });

  test("off_topic → skip", () => {
    expect(a.canSkip({ userMessage: "Hola tengo otra duda", classification: { type: "off_topic" } })).toBe(true);
  });

  test("dont_know → NO skip (necesita scaffold del KG, sin embedding)", () => {
    expect(a.canSkip({ userMessage: "no sé por dónde empezar", classification: { type: "dont_know" } })).toBe(false);
  });

  test("dont_know corto 'no sé' → NO skip (scaffold imprescindible)", () => {
    expect(a.canSkip({ userMessage: "no sé", classification: { type: "dont_know" } })).toBe(false);
  });

  test("closed_answer (sí/no) → NO skip (necesita acknowledge hint)", () => {
    expect(a.canSkip({ userMessage: "Sí", classification: { type: "closed_answer" } })).toBe(false);
  });

  test("query 'R1' partial_correct → skip (≤5 chars + partial)", () => {
    expect(a.canSkip({ userMessage: "R1", classification: { type: "partial_correct" } })).toBe(true);
  });

  test("query 'R3' wrong_answer → skip (≤5 chars + wrong)", () => {
    expect(a.canSkip({ userMessage: "R3", classification: { type: "wrong_answer" } })).toBe(true);
  });

  test("query 'R1, R2 y R4' partial_correct → NO skip (>5 chars)", () => {
    expect(a.canSkip({ userMessage: "R1, R2 y R4", classification: { type: "partial_correct" } })).toBe(false);
  });

  test("query largo wrong_answer → NO skip", () => {
    expect(a.canSkip({
      userMessage: "Creo que la solución pasa por aplicar Kirchhoff en el nodo central",
      classification: { type: "wrong_answer" },
    })).toBe(false);
  });

  test("userMessage vacío → skip (defensivo)", () => {
    expect(a.canSkip({ userMessage: "", classification: { type: "wrong_answer" } })).toBe(true);
  });

  test("classification ausente y mensaje largo → NO skip", () => {
    expect(a.canSkip({ userMessage: "Una pregunta sobre el circuito" })).toBe(false);
  });
});
