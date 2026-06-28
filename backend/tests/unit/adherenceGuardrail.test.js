"use strict";

const AdherenceGuardrail = require("../../src/infrastructure/guardrails/AdherenceGuardrail");

/*------------------------------------------------------------------------------
            _________________________________________________________
            |        ADHERENCEGUARDRAIL — UNIT TESTS (NS-33)        |
            |  Verifies the three adherence rules: contradiction    |
            |  about Rn (flagging false claims while sparing        |
            |  Socratic questions), multi-question truncation, and  |
            |  missed_affirmation log-only metadata, plus the       |
            |  surgicalFix integration of rules 1+2.                |
            |_______________________________________________________|
------------------------------------------------------------------------------*/

describe("AdherenceGuardrail (NS-33)", () => {
  const g = new AdherenceGuardrail();
  const correctAnswer = ["R1", "R2", "R4"];

  describe("rule 1 — contradicción Rn", () => {
    test("flags negative claim about a CORRECT element", () => {
      const r = g.check("Bien encaminado, R1 no contribuye a la diferencia.", { correctAnswer });
      expect(r.violated).toBe(true);
      expect(r.evidence).toMatch(/contradiction/);
    });

    test("flags positive claim about a WRONG element", () => {
      const r = g.check("R5 contribuye a la diferencia de potencial.", { correctAnswer });
      expect(r.violated).toBe(true);
      expect(r.evidence).toMatch(/contradiction/);
    });

    test("does NOT flag negative claim about a WRONG element", () => {
      const r = g.check("R5 no contribuye a la diferencia.", { correctAnswer });
      expect(r.violated).toBe(false);
    });

    test("does NOT flag positive claim about a CORRECT element", () => {
      const r = g.check("R1 contribuye a la diferencia.", { correctAnswer });
      expect(r.violated).toBe(false);
    });

    test("does NOT flag a Socratic QUESTION even if Rn-no-influye appears inside", () => {
      const r = g.check(
        "Bien, A R1. ¿Puedes explicar por qué R2 no influye en la diferencia de potencial?",
        { correctAnswer }
      );
      expect(r.violated).toBe(false);
    });

    test("does NOT flag a Socratic question with the ¿ opening mark only", () => {
      const r = g.check("¿por qué R4 no aporta nada?", { correctAnswer });
      expect(r.violated).toBe(false);
    });

    test("surgicalFix drops the contradicted sentence and keeps the rest", () => {
      const text = "Bien encaminado. R1 no contribuye porque está aislada. ¿Qué pasa con R5?";
      const fix = g.surgicalFix(text, { correctAnswer });
      expect(fix.applied).toBe(true);
      expect(fix.text).not.toMatch(/R1 no contribuye/);
      expect(fix.text).toMatch(/Bien encaminado/);
      expect(fix.text).toMatch(/R5/);
    });
  });

  describe("rule 2 — multi-pregunta", () => {
    test("flags response with two question marks", () => {
      const r = g.check("¿Qué tienen en común R1 y R2? ¿Por qué pensaste eso?", { correctAnswer });
      expect(r.violated).toBe(true);
      expect(r.evidence).toMatch(/multi_question/);
    });

    test("does NOT flag a single question", () => {
      const r = g.check("¿Por qué incluiste R5?", { correctAnswer });
      expect(r.violated).toBe(false);
    });

    test("surgicalFix truncates at the first '?'", () => {
      const text = "¿Por qué R5? ¿Y R3 también?";
      const fix = g.surgicalFix(text, { correctAnswer });
      expect(fix.applied).toBe(true);
      expect(fix.text).toBe("¿Por qué R5?");
    });
  });

  describe("rule 3 — missed_affirmation (log only)", () => {
    test("does NOT mutate text when the LLM ignores hits, but exposes metadata", () => {
      const r = g.check("Vamos a ver lo que tenemos.", {
        correctAnswer,
        turnVerdict: { hits: ["R1"], errors: [], missing: ["R2", "R4"], proposed: ["R1"] },
      });
      expect(r.violated).toBe(false);
      expect(r.metadata).toBeDefined();
      expect(r.metadata.logOnly[0].rule).toBe("missed_affirmation");
    });

    test("does NOT log when the LLM mentions a hit by name", () => {
      const r = g.check("Bien, R1 sí cumple.", {
        correctAnswer,
        turnVerdict: { hits: ["R1"], errors: [], missing: [], proposed: ["R1"] },
      });
      expect(r.violated).toBe(false);
      expect(r.metadata).toBeUndefined();
    });
  });

  describe("integration of rules 1+2", () => {
    test("surgicalFix applies contradiction redaction first then question truncation", () => {
      const text = "¿Por qué crees X? R1 no es correcta. ¿Qué pasa con R5?";
      const fix = g.surgicalFix(text, { correctAnswer });
      expect(fix.applied).toBe(true);
      expect(fix.text).not.toMatch(/R1 no es correcta/);
      expect((fix.text.match(/\?/g) || []).length).toBe(1);
    });
  });
});
