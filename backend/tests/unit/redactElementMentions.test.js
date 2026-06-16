"use strict";

const { redactElementMentions } = require("../../src/domain/services/rag/guardrails");

/*------------------------------------------------------------------------------
            _________________________________________________________
            |                REDACT ELEMENT MENTIONS               |
            |  Regression suite for the 2026-04-27 bug where the    |
            |  surgical fix produced "ese conjunto, ese conjunto,   |
            |  ese conjunto" instead of a single placeholder (see   |
            |  guardrails.js step 2a run-collapse and 2c dedup).    |
            |  Also covers spacing, multilingual placeholders and   |
            |  the removeOpeningConfirmation word-boundary fix.     |
            |_______________________________________________________|
------------------------------------------------------------------------------*/

describe("redactElementMentions — run collapse + spacing", () => {
  const correctAnswer = ["R1", "R2", "R4"];

  test("colapsa runs separados por comas + 'y' en una sola pregunta", () => {
    const input = "¿Por qué R3, R5 y R1 contribuyen al voltaje?";
    const { text, redacted } = redactElementMentions(input, correctAnswer, "es");
    expect(redacted).toBe(true);
    const placeholderCount =
      (text.match(/ese conjunto de elementos/g) || []).length +
      (text.match(/esos elementos/g) || []).length +
      (text.match(/esas resistencias/g) || []).length;
    expect(placeholderCount).toBe(1);
    expect(text).not.toMatch(/\bR\d+\b/);
  });

  test("preserva los espacios alrededor del placeholder", () => {
    const input = "¿Por qué crees que R1, R2 y R4 afectan al voltaje?";
    const { text } = redactElementMentions(input, correctAnswer, "es");
    expect(text).toMatch(/\s(ese conjunto de elementos|esos elementos|esas resistencias)\s/);
    expect(text).not.toMatch(/[a-z](ese conjunto de elementos|esos elementos|esas resistencias)/);
    expect(text).not.toMatch(/(ese conjunto de elementos|esos elementos|esas resistencias)[a-z]/);
  });

  test("colapsa con paréntesis envolventes", () => {
    const input = "¿Cuál es el papel de (R1, R2, R4) en el divisor?";
    const { text } = redactElementMentions(input, correctAnswer, "es");
    expect(text).toMatch(/¿Cuál es el papel de.*ese conjunto de elementos.*\?/);
    expect(text).not.toMatch(/\bR\d+\b/);
  });

  test("una sola mención (Rn aislado) sigue redactándose", () => {
    const input = "¿Qué pasa con R1 en este circuito?";
    const { text, redacted } = redactElementMentions(input, correctAnswer, "es");
    expect(redacted).toBe(true);
    expect(text).toContain("ese conjunto de elementos");
  });

  test("no toca afirmaciones que NO mencionen la respuesta correcta", () => {
    const input = "El tutor evalúa internamente R3 antes de responder.";
    const { text, redacted } = redactElementMentions(input, correctAnswer, "es");
    expect(redacted).toBe(false);
    expect(text).toBe(input);
  });

  test("placeholder en valencià cuando lang=val", () => {
    const input = "¿Què passa amb R1, R2 i R4?";
    const { text } = redactElementMentions(input, correctAnswer, "val");
    expect(text).toContain("eixe conjunt d'elements");
  });

  test("placeholder inglés cuando lang=en", () => {
    const input = "Why do R1, R2 and R4 contribute to the voltage?";
    const { text } = redactElementMentions(input, correctAnswer, "en");
    expect(text).toMatch(/that set of elements|those elements/);
  });

  test("preserva espacios entre sentences cuando se redacta una pregunta", () => {
    const input = "Cuidado, hay un error en ese razonamiento. Está bien dicho. ¿Cuáles de estas condiciones se cumplen para R1, R2 y R4?";
    const { text } = redactElementMentions(input, correctAnswer, "es");
    expect(text).toMatch(/razonamiento\. Está/);
    expect(text).toMatch(/dicho\. ¿Cuáles/);
    expect(text).toContain("ese conjunto de elementos");
  });
});

const { removeOpeningConfirmation } = require("../../src/domain/services/rag/guardrails");

describe("removeOpeningConfirmation — word boundary", () => {
  test('"Eso está muy bien dicho" NO se trunca a "Tá muy bien dicho"', () => {
    const out = removeOpeningConfirmation(
      "Eso está muy bien dicho. Ahora piensa en el circuito.",
      "es"
    );
    expect(out).not.toMatch(/^Tá/);
    expect(out).toMatch(/^Eso está muy bien/);
  });

  test('"Perfecto, estás en el right track" sigue limpiando "Perfecto"', () => {
    const out = removeOpeningConfirmation(
      "Perfecto, estás en el right track. Ahora.",
      "es"
    );
    expect(out).not.toMatch(/^Perfecto/i);
    expect(out).toMatch(/^Estás en el right track/);
  });

  test('"Estás en el camino correcto" se elimina entera', () => {
    const out = removeOpeningConfirmation(
      "Estás en el camino correcto. Foo bar.",
      "es"
    );
    expect(out).toMatch(/^Foo bar/);
  });
});
