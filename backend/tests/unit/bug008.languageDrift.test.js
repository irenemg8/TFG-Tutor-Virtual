"use strict";

const LanguageDriftGuardrail = require("../../src/infrastructure/guardrails/LanguageDriftGuardrail");

/*------------------------------------------------------------------------------
            _________________________________________________________
            |     LANGUAGEDRIFTGUARDRAIL — UNIT TESTS (BUG-008)     |
            |  Regresses BUG-008 (2026-05-03): the model mixed      |
            |  English phrases into es/val replies. Verifies check() |
            |  flags ES<->EN drift, surgicalFix excises the English  |
            |  phrase while keeping the trailing question, non-Latin |
            |  precedence, and buildRetryHint per language.         |
            |_______________________________________________________|
------------------------------------------------------------------------------*/

describe("LanguageDriftGuardrail (BUG-008 — drift ES↔EN intra-respuesta)", () => {
  const g = new LanguageDriftGuardrail();

  describe("check() — detección", () => {
    test("caso BUG-008 exacto: ES + EN mezclados con ctx.lang=es", () => {
      const text = "Bien encaminado. R1 is indeed part of the answer. ¿Cómo afecta R2 al circuito?";
      const r = g.check(text, { lang: "es" });
      expect(r.violated).toBe(true);
      expect(r.reason).toBe("es_en_drift");
      expect(r.evidence).toMatch(/expected=es/);
    });

    test("frase EN larga dentro de respuesta VAL", () => {
      const text = "Pensa-hi. The current flows from N1 to ground through R2. Què passa amb R4?";
      const r = g.check(text, { lang: "val" });
      expect(r.violated).toBe(true);
      expect(r.reason).toBe("es_en_drift");
    });

    test("ES limpio sin drift", () => {
      const text = "Vamos a pensar en el circuito. ¿Por qué crees que R5 está en cortocircuito?";
      const r = g.check(text, { lang: "es" });
      expect(r.violated).toBe(false);
    });

    test("VAL limpio sin drift", () => {
      const text = "Pensa-hi un moment. Què passa amb la resistència en curtcircuit?";
      const r = g.check(text, { lang: "val" });
      expect(r.violated).toBe(false);
    });

    test("EN puro con ctx.lang=en NO se considera drift", () => {
      const text = "Let's think about it. The current flows from N1 to ground. What happens to R2?";
      const r = g.check(text, { lang: "en" });
      expect(r.violated).toBe(false);
    });

    test("frase corta ambigua tipo 'Yes.' no dispara drift", () => {
      const text = "Yes. ¿Por qué crees que R5 está cortocircuitada en este caso concreto?";
      const r = g.check(text, { lang: "es" });
      expect(r.violated).toBe(false);
    });

    test("ES con préstamo técnico aislado ('current') NO falsea drift", () => {
      const text = "El current eléctrico fluye de N1 a tierra. ¿Lo recuerdas?";
      const r = g.check(text, { lang: "es" });
      expect(r.violated).toBe(false);
    });

    test("ctx.lang ausente → no aplica detección ES↔EN", () => {
      const text = "R1 is indeed part of the answer. How does R2 affect it?";
      const r = g.check(text, {});
      expect(r.violated).toBe(false);
    });

    test("non-Latin sigue ganando precedencia sobre el chequeo ES↔EN", () => {
      const text = "Pensa: 短路 R5. The current flows. ¿Qué pasa?";
      const r = g.check(text, { lang: "es" });
      expect(r.violated).toBe(true);
      expect(r.reason).toBe("non_latin");
    });
  });

  describe("surgicalFix() — eliminación quirúrgica", () => {
    test("elimina la frase EN y conserva la pregunta ES final", () => {
      const text = "Bien encaminado. R1 is indeed part of the answer. ¿Cómo afecta R2 al circuito ahora?";
      const fix = g.surgicalFix(text, { lang: "es" });
      expect(fix).toBeTruthy();
      expect(fix.applied).toBe(true);
      expect(fix.text).not.toMatch(/is indeed part of the answer/);
      expect(fix.text).toMatch(/¿Cómo afecta R2/);
    });

    test("devuelve null si el filtrado se lleva la pregunta interrogativa", () => {
      const text = "Bien encaminado. How does R2 affect the circuit when R5 is shorted?";
      const fix = g.surgicalFix(text, { lang: "es" });
      expect(fix).toBeNull();
    });

    test("devuelve null si tras filtrar queda <20 chars", () => {
      const text = "Hi. The current flows from N1 through R2 down to ground always.";
      const fix = g.surgicalFix(text, { lang: "es" });
      expect(fix).toBeNull();
    });

    test("no aplica fix sobre respuesta ES limpia", () => {
      const text = "Vamos a pensar. ¿Por qué crees que R5 está en cortocircuito?";
      const fix = g.surgicalFix(text, { lang: "es" });
      expect(fix.applied).toBe(false);
      expect(fix.text).toBe(text);
    });

    test("no aplica fix sobre respuesta EN cuando ctx.lang=en", () => {
      const text = "Let's think. The current flows through R2. What happens?";
      const fix = g.surgicalFix(text, { lang: "en" });
      expect(fix.applied).toBe(false);
      expect(fix.text).toBe(text);
    });

    test("VAL: elimina frase EN y conserva pregunta valenciana", () => {
      const text = "Pensa-hi. The current flows from N1 to ground through R2. Què passa amb R4 ara?";
      const fix = g.surgicalFix(text, { lang: "val" });
      expect(fix).toBeTruthy();
      expect(fix.applied).toBe(true);
      expect(fix.text).not.toMatch(/The current flows/);
      expect(fix.text).toMatch(/Què passa amb R4/);
    });
  });

  describe("buildRetryHint() — refuerzo del idioma", () => {
    test("ES menciona inglés explícitamente", () => {
      expect(g.buildRetryHint("es")).toMatch(/inglés/i);
    });
    test("VAL menciona anglés", () => {
      expect(g.buildRetryHint("val")).toMatch(/anglés/i);
    });
  });
});
