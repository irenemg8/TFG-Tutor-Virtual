"use strict";

const {
  redactStateRevealSentence,
  redactElementMentions,
  ensureResponseHasQuestion,
} = require("../../src/domain/services/rag/guardrails");

const FalseConfirmationGuardrail = require("../../src/infrastructure/guardrails/FalseConfirmationGuardrail");
const CompleteSolutionGuardrail = require("../../src/infrastructure/guardrails/CompleteSolutionGuardrail");
const PrematureConfirmationGuardrail = require("../../src/infrastructure/guardrails/PrematureConfirmationGuardrail");

/*------------------------------------------------------------------------------
            _________________________________________________________
            |                  GUARDRAILS NS-34                     |
            |  Test suite for the NS-34 fixes from the 2026-05-03   |
            |  smoke test: bug 2 (StateRevealGuardrail redacted the |
            |  only sentence carrying the question), bug 3 (an      |
            |  all-correct assertion was redacted leaving no        |
            |  Socratic question), and bug 4 (two guardrails        |
            |  stacked their own running prefixes). Verifies        |
            |  ensureResponseHasQuestion, the two redactors and     |
            |  surgical-fix idempotence.                            |
        ____|________________                                       |
   Obj -> | buildGuardrailCtx() | -> Obj                            |
          ---------------------                                     |
            |_______________________________________________________|
------------------------------------------------------------------------------*/

describe("NS-34 ensureResponseHasQuestion", () => {
  test("preserva el texto si ya hay una interrogación", () => {
    const out = ensureResponseHasQuestion("Algo. ¿Y tú?", "es");
    expect(out).toBe("Algo. ¿Y tú?");
  });

  test("añade pregunta socrática genérica cuando no hay '?'", () => {
    const out = ensureResponseHasQuestion("Ese elemento tiene una propiedad relevante", "es");
    expect(out).toMatch(/\?$/);
    expect(out).toContain("Ese elemento tiene una propiedad relevante");
  });

  test("respeta el idioma valencià", () => {
    const out = ensureResponseHasQuestion("Frase sense pregunta", "val");
    expect(out).toMatch(/\?$/);
    expect(out.toLowerCase()).toContain("podries");
  });

  test("respeta el idioma inglés", () => {
    const out = ensureResponseHasQuestion("A statement", "en");
    expect(out).toMatch(/\?$/);
    expect(out.toLowerCase()).toContain("property");
  });
});

describe("NS-34 — bug 2: redactStateRevealSentence garantiza pregunta", () => {
  test("cuando la única frase con '?' es la redactada, añade Socratic genérica", () => {
    const input = "¿Sabías que circula corriente por R5?";
    const { text, redacted } = redactStateRevealSentence(
      input,
      ["R1", "R2", "R3", "R4", "R5"],
      "circula corriente por",
      "es"
    );
    expect(redacted).toBe(true);
    expect(text).toMatch(/\?$/);
  });

  test("si ya existe otra pregunta, no añade nada extra", () => {
    const input = "Circula corriente por R5. ¿Qué notas?";
    const { text, redacted } = redactStateRevealSentence(
      input,
      ["R5"],
      "circula corriente por",
      "es"
    );
    expect(redacted).toBe(true);
    expect((text.match(/\?/g) || [])).toHaveLength(1);
    expect(text).toContain("¿Qué notas?");
  });
});

describe("NS-34 — bug 3: redactElementMentions garantiza pregunta", () => {
  const correctAnswer = ["R1", "R2", "R4"];

  test("afirmación pura con todos los correctos termina con pregunta", () => {
    const input = "La respuesta es R1, R2 y R4.";
    const { text, redacted } = redactElementMentions(input, correctAnswer, "es");
    expect(redacted).toBe(true);
    expect(text).toMatch(/\?$/);
  });

  test("si la respuesta original tenía una pregunta, no añade duplicados", () => {
    const input = "¿Por qué R1, R2 y R4 contribuyen al voltaje?";
    const { text, redacted } = redactElementMentions(input, correctAnswer, "es");
    expect(redacted).toBe(true);
    expect((text.match(/\?/g) || [])).toHaveLength(1);
  });
});

/*
     Obj -> ____|________________
           | buildGuardrailCtx() | -> Obj
            ---------------------
        Builds a guardrail context with wrong-answer defaults, merging any
        overrides passed in.
*/
function buildGuardrailCtx(overrides) {
  return Object.assign(
    {
      classification: "wrong_answer",
      mentionedElements: ["R3"],
      proposed: ["R3"],
      negated: [],
      correctAnswer: ["R1", "R2", "R4"],
      lang: "es",
    },
    overrides || {}
  );
}

describe("NS-34 — bug 4: surgical fixes son idempotentes", () => {
  test("FalseConfirmationGuardrail no re-prepende si ya hay corrección", () => {
    const g = new FalseConfirmationGuardrail();
    const ctx = buildGuardrailCtx();

    const alreadyFixed =
      "No es exactamente así. Vamos a repasar algo importante. Piensa en el camino que sigue la corriente.";
    const fix = g.surgicalFix(alreadyFixed, ctx);
    expect(fix).toEqual({ applied: false, text: alreadyFixed });
  });

  test("CompleteSolutionGuardrail no re-prepende si la cabecera ya no confirma", () => {
    const g = new CompleteSolutionGuardrail();
    const ctx = buildGuardrailCtx();
    const alreadyFixed =
      "Hay conceptos que debemos revisar. Mira los nodos donde está conectada esa parte del circuito.";
    const fix = g.surgicalFix(alreadyFixed, ctx);
    expect(fix).toEqual({ applied: false, text: alreadyFixed });
  });

  test("PrematureConfirmationGuardrail no re-prepende sobre cabecera limpia", () => {
    const g = new PrematureConfirmationGuardrail();
    const ctx = buildGuardrailCtx({ classification: "correct_no_reasoning" });
    const alreadyFixed =
      "Vas por buen camino, pero hay que pulir algunos conceptos. Justifica por qué.";
    const fix = g.surgicalFix(alreadyFixed, ctx);
    expect(fix).toEqual({ applied: false, text: alreadyFixed });
  });

  test("el primer fix sí se aplica sobre una respuesta cruda con confirmación", () => {
    const g = new FalseConfirmationGuardrail();
    const ctx = buildGuardrailCtx();
    const raw = "Correcto, R3 no contribuye al voltaje.";
    const fix = g.surgicalFix(raw, ctx);
    expect(fix.applied).toBe(true);
    expect(fix.text).not.toMatch(/^Correcto/i);
  });
});
