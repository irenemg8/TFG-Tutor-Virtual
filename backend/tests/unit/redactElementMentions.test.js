"use strict";

const { redactElementMentions } = require("../../src/domain/services/rag/guardrails");

// Regression suite for the 2026-04-27 bug where the surgical fix produced
// "ese conjunto, ese conjunto, ese conjunto" instead of a single placeholder.
// See guardrails.js step 2a (run-collapse) and 2c (dedup).

describe("redactElementMentions — run collapse + spacing", () => {
  const correctAnswer = ["R1", "R2", "R4"];

  test("colapsa runs separados por comas + 'y' en una sola pregunta", () => {
    const input = "¿Por qué R3, R5 y R1 contribuyen al voltaje?";
    const { text, redacted } = redactElementMentions(input, correctAnswer, "es");
    expect(redacted).toBe(true);
    // No debe contener placeholders repetidos
    expect(text.match(/ese conjunto de elementos/g) || []).toHaveLength(1);
    // No debe quedar ningún Rn suelto
    expect(text).not.toMatch(/\bR\d+\b/);
  });

  test("preserva los espacios alrededor del placeholder", () => {
    const input = "¿Por qué crees que R1, R2 y R4 afectan al voltaje?";
    const { text } = redactElementMentions(input, correctAnswer, "es");
    expect(text).toContain(" ese conjunto de elementos ");
    // No debe haber "queese conjunto" pegado sin espacios
    expect(text).not.toMatch(/[a-z]ese conjunto de elementos/);
    expect(text).not.toMatch(/ese conjunto de elementos[a-z]/);
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
    // Step 1 (listPattern/tolerantPattern) protege contra leak de la respuesta
    // correcta literal y se aplica siempre, no sólo en preguntas. Por eso el
    // caso de "afirmación intacta" sólo aplica cuando la frase NO contiene la
    // lista exacta de la respuesta correcta — aquí mencionamos R3 (no está en
    // correctAnswer) en una afirmación y debe quedarse igual.
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
    expect(text).toContain("that set of elements");
  });

  // Regression: el split por sentence consumía el whitespace separador y el
  // join("") dejaba "...revisar.Tá muy bien dicho.Ahora,..." sin espacios.
  // Ahora `text.match(...)` captura el trailing whitespace y se preserva.
  test("preserva espacios entre sentences cuando se redacta una pregunta", () => {
    const input = "Cuidado, hay un error en ese razonamiento. Está bien dicho. ¿Cuáles de estas condiciones se cumplen para R1, R2 y R4?";
    const { text } = redactElementMentions(input, correctAnswer, "es");
    // Debe seguir habiendo espacios después de los puntos
    expect(text).toMatch(/razonamiento\. Está/);
    expect(text).toMatch(/dicho\. ¿Cuáles/);
    // Y el placeholder se aplicó
    expect(text).toContain("ese conjunto de elementos");
  });
});

// =============================================================================
// removeOpeningConfirmation — regression "Tá muy bien dicho"
// =============================================================================
const { removeOpeningConfirmation } = require("../../src/domain/services/rag/guardrails");

describe("removeOpeningConfirmation — word boundary", () => {
  test('"Eso está muy bien dicho" NO se trunca a "Tá muy bien dicho"', () => {
    // Bug histórico: la phrase "eso es" (length 6) hacía startsWith match con
    // "eso esta..." (chars 0-5 idénticos) y el strip de 6 chars dejaba "ta..."
    // → capitalize → "Tá muy bien dicho". El fix añade word-boundary check.
    const out = removeOpeningConfirmation(
      "Eso está muy bien dicho. Ahora piensa en el circuito.",
      "es"
    );
    expect(out).not.toMatch(/^Tá/);
    expect(out).toMatch(/^Eso está muy bien/);
  });

  test('"Perfecto, estás en el right track" sigue limpiando "Perfecto"', () => {
    // El fix NO debe romper los casos legítimos: cuando la phrase ES la
    // confirmación completa (separada por puntuación o espacio) se sigue
    // eliminando.
    const out = removeOpeningConfirmation(
      "Perfecto, estás en el right track. Ahora.",
      "es"
    );
    expect(out).not.toMatch(/^Perfecto/i);
    expect(out).toMatch(/^Estás en el right track/);
  });

  test('"Estás en el camino correcto" se elimina entera', () => {
    // Phrase exacta presente en confirmPhrases — debe seguirse eliminando.
    const out = removeOpeningConfirmation(
      "Estás en el camino correcto. Foo bar.",
      "es"
    );
    expect(out).toMatch(/^Foo bar/);
  });
});
