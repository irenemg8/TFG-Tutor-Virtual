"use strict";

// NS-34 — fixes para los tres defectos reportados en el smoke test del
// 2026-05-03:
//   2. T11 quedó sin pregunta porque StateRevealGuardrail redactó la única
//      frase que la llevaba.
//   3. T10/T13 redactaron una afirmación con todos los elementos correctos y
//      la respuesta acabó sin pregunta socrática.
//   4. T7 acumuló prefijos ("No es exactamente así. ... Hay conceptos que
//      debemos revisar.") porque dos guardrails distintos prependían cada uno
//      su propia frase corredora.

const {
  redactStateRevealSentence,
  redactElementMentions,
  ensureResponseHasQuestion,
} = require("../../src/domain/services/rag/guardrails");

const FalseConfirmationGuardrail = require("../../src/infrastructure/guardrails/FalseConfirmationGuardrail");
const CompleteSolutionGuardrail = require("../../src/infrastructure/guardrails/CompleteSolutionGuardrail");
const PrematureConfirmationGuardrail = require("../../src/infrastructure/guardrails/PrematureConfirmationGuardrail");

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
    // Hardcoded state pattern dentro de una pregunta: el sentence-replace
    // borra la pregunta entera al sustituirla por el placeholder, dejando el
    // turno sin ningún signo de interrogación.
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
    // Debe mantener la pregunta original sin duplicar
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
    // En este caso la redacción ocurre por step 1 (tolerantPattern), que NO
    // requiere que la frase sea pregunta — ergo la respuesta acaba sin "?"
    // y debe completarse con una pregunta genérica.
    expect(text).toMatch(/\?$/);
  });

  test("si la respuesta original tenía una pregunta, no añade duplicados", () => {
    const input = "¿Por qué R1, R2 y R4 contribuyen al voltaje?";
    const { text, redacted } = redactElementMentions(input, correctAnswer, "es");
    expect(redacted).toBe(true);
    expect((text.match(/\?/g) || [])).toHaveLength(1);
  });
});

// ---------- bug 4 ----------

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

    // Simulamos la salida tras un fix previo (prefix + cleaned response).
    // Empieza por "No es exactamente así..." → la negación bloquea cualquier
    // confirm phrase, así que NO debe aplicarse otra capa.
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
    // El prefijo viene de getRandomIntermediatePhrase('wrong', 'es'), pero
    // sea cual sea, la respuesta YA NO debe contener "Correcto" al inicio.
    expect(fix.text).not.toMatch(/^Correcto/i);
  });
});
