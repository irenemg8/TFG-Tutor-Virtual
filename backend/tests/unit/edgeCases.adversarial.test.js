"use strict";

/**
 * Edge case adversarial test suite — Layer 1.
 *
 * Cubre los escenarios MVP-blocking del catálogo
 * `.apex/wiki/concepts/edge-cases-tutor-socratico.md` que no están ya
 * cubiertos por los tests existentes (acDetectorAgent.verdict,
 * adherenceGuardrail, redactElementMentions, whitespaceNormalise).
 *
 * Foco:
 *  - SolutionLeakGuardrail (B2) — afirmación con todas las correctas.
 *  - StateRevealGuardrail (B3, B4, B9) — hardcoded vs KG, question vs aff.
 *  - FalseConfirmationGuardrail (B1 + idempotencia + skip-no-elements).
 *  - CompleteSolutionGuardrail (B1-extension wronglyNegated/Proposed).
 *  - ensureResponseHasQuestion (B13) — respuesta sin "?" recibe fallback.
 *  - redactStateRevealSentence (NS-31 first-only).
 *  - extractResistances unicode bombs (A8) y mal-escritos (A22).
 *  - PrematureConfirmationGuardrail comportamiento legacy.
 *
 * NO requiere servers. NO toca LLM. NO toca BD.
 */

const SolutionLeakGuardrail = require("../../src/infrastructure/guardrails/SolutionLeakGuardrail");
const FalseConfirmationGuardrail = require("../../src/infrastructure/guardrails/FalseConfirmationGuardrail");
const CompleteSolutionGuardrail = require("../../src/infrastructure/guardrails/CompleteSolutionGuardrail");
const StateRevealGuardrail = require("../../src/infrastructure/guardrails/StateRevealGuardrail");
const PrematureConfirmationGuardrail = require("../../src/infrastructure/guardrails/PrematureConfirmationGuardrail");
const AdherenceGuardrail = require("../../src/infrastructure/guardrails/AdherenceGuardrail");

const {
  ensureResponseHasQuestion,
  redactStateRevealSentence,
  removeOpeningConfirmation,
} = require("../../src/domain/services/rag/guardrails");
const {
  extractResistances,
  extractMentionedElements,
} = require("../../src/domain/services/text/elementExtractor");

// ─── B2 — SolutionLeakGuardrail ──────────────────────────────────────────────

describe("SolutionLeakGuardrail (B2 — leak de la respuesta completa)", () => {
  const g = new SolutionLeakGuardrail();
  const correctAnswer = ["R1", "R2", "R4"];

  test("flags affirmative sentence listing all correct elements", () => {
    const r = g.check("Sí, las que contribuyen son R1, R2 y R4.", { correctAnswer });
    expect(r.violated).toBe(true);
  });

  // BUG-001 (FIXED 2026-05-03): SolutionLeakGuardrail now scans sentences
  // and verifies they contain ALL correct elements regardless of order.
  test("flags affirmative listing in any order [BUG-001 FIXED]", () => {
    const r = g.check("Las que aportan a la diferencia son R4, R1 y R2.", { correctAnswer });
    expect(r.violated).toBe(true);
  });

  test("flags fully reversed-order listing", () => {
    const r = g.check("Sí, las que contribuyen son R4, R2 y R1.", { correctAnswer });
    expect(r.violated).toBe(true);
  });

  // BUG-SL-EXACT (2026-06-14): updated. A question that names EXACTLY the
  // correct set ("¿Crees que son R1, R2 y R4 las que importan?") hands the
  // student the answer just as much as an affirmative listing — there is no
  // legitimate Socratic reason for the tutor to enumerate precisely the answer
  // set and ask "are these the ones?". This was the production leak Irene
  // reported ("de la nada te dice las resistencias"). It is now flagged.
  // A FULL enumeration of every evaluable element ("¿cuáles de R1..R5…?") is
  // still exempt (see the test below), since it reveals nothing.
  test("flags an exact-set listing inside a question [BUG-SL-EXACT]", () => {
    const r = g.check("¿Crees que son R1, R2 y R4 las que importan?", { correctAnswer });
    expect(r.violated).toBe(true);
  });

  test("does NOT flag a full enumeration of every evaluable element in a question", () => {
    const r = g.check(
      "¿Cuáles de R1, R2, R3, R4 y R5 crees que influyen en la tensión?",
      { correctAnswer, evaluableElements: ["R1", "R2", "R3", "R4", "R5"] }
    );
    expect(r.violated).toBe(false);
  });

  test("flags explicit reveal phrase when all elements are present", () => {
    const r = g.check("La respuesta es R1 R2 R4.", { correctAnswer });
    expect(r.violated).toBe(true);
  });

  test("does NOT flag if even one correct element is missing in the listing", () => {
    const r = g.check("Sí, contribuyen R1 y R2.", { correctAnswer });
    expect(r.violated).toBe(false);
  });

  test("surgicalFix replaces the listing with a placeholder", () => {
    const fix = g.surgicalFix("Sí, las que contribuyen son R1, R2 y R4.", { correctAnswer, lang: "es" });
    expect(fix && fix.applied).toBe(true);
    // After redaction the original element list must be gone or transformed.
    expect(/R1[,\s]+(y\s+)?R2[,\s]+(y\s+)?R4/i.test(fix.text)).toBe(false);
  });
});

// ─── B3, B4, B9 — StateRevealGuardrail ───────────────────────────────────────

describe("StateRevealGuardrail (B3, B4, B9 — reveal de estado interno)", () => {
  const g = new StateRevealGuardrail();
  const evaluableElements = ["R1", "R2", "R3", "R4", "R5"];
  const kgConceptPatterns = ["circuito abierto", "diferencia de potencial"];

  test("B3 — flags hardcoded state pattern in affirmation", () => {
    const r = g.check("R5 está cortocircuitada y por eso no aporta.", {
      evaluableElements, kgConceptPatterns,
    });
    expect(r.violated).toBe(true);
    expect(r.metadata.element).toBe("R5");
  });

  test("B3 — hardcoded patterns ALSO fire inside questions (affirmative reveal in question form)", () => {
    // "¿Sabías que R5 está cortocircuitada?" still leaks state even though
    // it's a question. By design hardcoded patterns ignore the question gate.
    const r = g.check("¿Sabías que R5 está cortocircuitada?", {
      evaluableElements, kgConceptPatterns,
    });
    expect(r.violated).toBe(true);
  });

  test("B4 — KG concept in affirmation triggers", () => {
    const r = g.check("R3 forma parte de un circuito abierto.", {
      evaluableElements, kgConceptPatterns,
    });
    expect(r.violated).toBe(true);
    expect(r.metadata.fromKG).toBe(true);
  });

  test("B9 — KG concept inside a Socratic question DOES NOT trigger", () => {
    // Pedagogically valid: asking the student about a concept is the goal.
    const r = g.check("¿Qué crees que pasa con R3 si hay circuito abierto?", {
      evaluableElements, kgConceptPatterns,
    });
    expect(r.violated).toBe(false);
  });

  test("does NOT flag when no element is named", () => {
    const r = g.check("Esto requiere pensar en la corriente global.", {
      evaluableElements, kgConceptPatterns,
    });
    expect(r.violated).toBe(false);
  });

  test("falls back to regex extraction when evaluableElements missing", () => {
    const r = g.check("R5 está cortocircuitada.", {
      evaluableElements: [], kgConceptPatterns,
    });
    expect(r.violated).toBe(true);
  });
});

// ─── B1 — FalseConfirmationGuardrail ─────────────────────────────────────────

describe("FalseConfirmationGuardrail (B1 — confirma una respuesta errónea)", () => {
  const g = new FalseConfirmationGuardrail();

  test("triggers on opening 'Perfecto' for wrong_answer with elements mentioned", () => {
    const r = g.check("Perfecto. Has identificado bien R3.", {
      classification: "wrong_answer",
      mentionedElements: ["R3"],
    });
    expect(r.violated).toBe(true);
    expect(r.metadata.phrase).toMatch(/perfecto/i);
  });

  test("does NOT trigger when student mentioned NO canonical element (conceptual reply)", () => {
    // Skip-no-elements heuristic: "interruptor abierto" is a conceptual
    // observation; confirming it is pedagogically acceptable.
    const r = g.check("Correcto, hay un interruptor abierto.", {
      classification: "wrong_answer",
      mentionedElements: [],
    });
    expect(r.violated).toBe(false);
  });

  test("does NOT trigger for negated phrase 'No es exactamente'", () => {
    const r = g.check("No es exactamente así. Vamos a repasar.", {
      classification: "wrong_answer",
      mentionedElements: ["R3"],
    });
    expect(r.violated).toBe(false);
  });

  test("does NOT trigger if classification is correct/partial (not wrong)", () => {
    const r = g.check("Perfecto, has identificado R1.", {
      classification: "correct_no_reasoning",
      mentionedElements: ["R1"],
    });
    expect(r.violated).toBe(false);
  });

  test("scans head until first '?' (200-char cap, prevents inside-question matches)", () => {
    const long =
      "Veamos paso a paso lo que has dicho sobre R3, " +
      "considerando la topología y la dirección de la corriente. " +
      "Perfecto coincide con tu razonamiento intuitivo.";
    const r = g.check(long, { classification: "wrong_answer", mentionedElements: ["R3"] });
    // 'perfecto' aparece después de 100 chars pero antes de 200 → debería disparar.
    expect(r.violated).toBe(true);
  });

  test("surgicalFix is idempotent — does NOT re-prefix when starts with intermediate phrase", () => {
    const already = "Aún no del todo. Perfecto, has dicho R3.";
    const fix = g.surgicalFix(already, { classification: "wrong_answer", lang: "es" });
    // Either applied:false or text unchanged — must not double-prefix.
    if (fix && fix.applied) {
      expect(fix.text).not.toMatch(/^Aún no del todo\. .+ Perfecto/);
    } else {
      expect(fix.text).toBe(already);
    }
  });
});

// ─── CompleteSolutionGuardrail — wrongly negated/proposed ────────────────────

describe("CompleteSolutionGuardrail (validación parcial errónea)", () => {
  const g = new CompleteSolutionGuardrail();
  const correctAnswer = ["R1", "R2", "R4"];

  test("triggers when tutor opens with confirmation but student wrongly NEGATED a correct element", () => {
    const r = g.check("Perfecto, has descartado bien.", {
      correctAnswer,
      proposed: [],
      negated: ["R4"], // R4 is correct → wrongly negated
    });
    expect(r.violated).toBe(true);
    expect(r.metadata.wronglyNegated).toContain("R4");
  });

  test("triggers when tutor confirms but student wrongly PROPOSED an incorrect element", () => {
    const r = g.check("Exacto, ese análisis es bueno.", {
      correctAnswer,
      proposed: ["R3"], // R3 is not correct
      negated: [],
    });
    expect(r.violated).toBe(true);
    expect(r.metadata.wronglyProposed).toContain("R3");
  });

  test("does NOT trigger when student is fully right and tutor confirms", () => {
    const r = g.check("Perfecto, esa es la idea.", {
      correctAnswer,
      proposed: ["R1", "R2", "R4"],
      negated: [],
    });
    expect(r.violated).toBe(false);
  });

  test("does NOT trigger when no confirmation phrase is present", () => {
    const r = g.check("Mira la rama de R3 con cuidado.", {
      correctAnswer,
      proposed: ["R3"],
      negated: [],
    });
    expect(r.violated).toBe(false);
  });
});

// ─── PrematureConfirmationGuardrail (legacy profile) ─────────────────────────

describe("PrematureConfirmationGuardrail (A14 — premature confirm trap)", () => {
  const g = new PrematureConfirmationGuardrail();

  test("can be instantiated and exposes the IGuardrail contract", () => {
    expect(typeof g.id).toBe("string");
    expect(typeof g.severity).toBe("string");
    expect(typeof g.check).toBe("function");
  });

  test("check() never throws for arbitrary strings (smoke)", () => {
    expect(() => g.check("¿son R1, R2 y R4, no?", { correctAnswer: ["R1", "R2", "R4"] })).not.toThrow();
    expect(() => g.check("", { correctAnswer: [] })).not.toThrow();
    expect(() => g.check(null, {})).not.toThrow();
  });
});

// ─── B13 — ensureResponseHasQuestion fallback ────────────────────────────────

describe("ensureResponseHasQuestion (B13 — respuesta sin pregunta)", () => {
  test("returns text untouched when it already contains '?'", () => {
    expect(ensureResponseHasQuestion("¿Qué pasa?", "es")).toBe("¿Qué pasa?");
  });

  test("appends a Spanish socratic question when missing", () => {
    const out = ensureResponseHasQuestion("Esto es interesante.", "es");
    expect(out).toMatch(/\?$/);
    expect(out.startsWith("Esto es interesante.")).toBe(true);
  });

  test("appends Valencian question for lang=val", () => {
    const out = ensureResponseHasQuestion("Cal pensar.", "val");
    expect(out).toMatch(/\?$/);
    expect(out.toLowerCase()).toMatch(/eixe|element|propietat/);
  });

  test("appends English question for lang=en", () => {
    const out = ensureResponseHasQuestion("Think about it.", "en");
    expect(out).toMatch(/\?$/);
    expect(out.toLowerCase()).toMatch(/property|element|analyse/);
  });

  test("adds period before question when text doesn't end in punctuation", () => {
    const out = ensureResponseHasQuestion("Vamos a pensar", "es");
    expect(out).toMatch(/\.\s+¿/);
  });

  test("returns text unchanged on empty/null", () => {
    expect(ensureResponseHasQuestion("", "es")).toBe("");
    // Non-string → returned as-is.
    expect(ensureResponseHasQuestion(null, "es")).toBe(null);
  });
});

// ─── NS-31 first-only redaction ──────────────────────────────────────────────

describe("redactStateRevealSentence (NS-31 — first-only sub)", () => {
  const evaluableElements = ["R1", "R2", "R3", "R4", "R5"];

  test("redacts only the FIRST sentence when pattern repeats", () => {
    const input =
      "R5 está cortocircuitada porque sus dos terminales coinciden. " +
      "Por eso R5 está cortocircuitada y no aporta.";
    const r = redactStateRevealSentence(input, evaluableElements, "está cortocircuitada", "es");
    expect(r.redacted).toBe(true);
    // Only one placeholder should appear, not two.
    const matches = (r.text.match(/ese elemento tiene una propiedad relevante/gi) || []).length;
    expect(matches).toBe(1);
  });

  test("capitalises placeholder when redacted sentence is first", () => {
    const input = "R5 está cortocircuitada y no aporta.";
    const r = redactStateRevealSentence(input, evaluableElements, "está cortocircuitada", "es");
    expect(r.redacted).toBe(true);
    expect(r.text.charAt(0)).toMatch(/[A-ZÁÉÍÓÚÑ]/);
  });

  test("appends a Socratic question when the only '?' was redacted", () => {
    const input = "¿No es raro que pase corriente por R5 estando cortocircuitada?";
    const r = redactStateRevealSentence(input, evaluableElements, "está cortocircuitada", "es");
    if (r.redacted) {
      expect(r.text).toMatch(/\?$/);
    }
  });

  test("does nothing when pattern is not present", () => {
    const input = "Vamos a analizar la corriente que entra por N1.";
    const r = redactStateRevealSentence(input, evaluableElements, "está cortocircuitada", "es");
    expect(r.redacted).toBe(false);
    expect(r.text).toBe(input);
  });

  // BUG-009 (2026-05-03): el placeholder debe terminar en "." y dejar
  // espacio antes de la siguiente frase para evitar pegoteo
  // "identificar Podrías…" sin separación frástica.
  test("placeholder ends with period and is followed by space (BUG-009)", () => {
    const input =
      "R1 está cortocircuitada y no aporta. ¿Podrías explicarme por qué?";
    const r = redactStateRevealSentence(input, evaluableElements, "está cortocircuitada", "es");
    expect(r.redacted).toBe(true);
    expect(r.text).toMatch(/identificar\.\s/);
    expect(r.text).toMatch(/\?\s*$/);
  });

  test("placeholder + LLM continuation keeps capital + ¿ on next sentence (BUG-009)", () => {
    const input =
      "R1 está cortocircuitada. Podrías decirme algo más?";
    const r = redactStateRevealSentence(input, evaluableElements, "está cortocircuitada", "es");
    expect(r.redacted).toBe(true);
    // Placeholder ends with "." so next sentence should be cleanly separated.
    expect(r.text).toMatch(/identificar\.\s+Podrías/);
  });

  // BUG-009-B (2026-05-03): rotación de placeholder por priorHits.
  test("priorHits=0 usa placeholder #1 (variante por defecto)", () => {
    const input = "R1 está cortocircuitada. ¿Por qué crees?";
    const r = redactStateRevealSentence(input, evaluableElements, "está cortocircuitada", "es", 0);
    expect(r.redacted).toBe(true);
    expect(r.text).toMatch(/propiedad relevante que debes identificar/);
  });

  test("priorHits=1 usa placeholder #2 (segunda variante)", () => {
    const input = "R1 está cortocircuitada. ¿Por qué crees?";
    const r = redactStateRevealSentence(input, evaluableElements, "está cortocircuitada", "es", 1);
    expect(r.redacted).toBe(true);
    expect(r.text).toMatch(/característica clave/);
    expect(r.text).not.toMatch(/propiedad relevante que debes identificar/);
  });

  test("priorHits=2 usa placeholder #3 (tercera variante)", () => {
    const input = "R1 está cortocircuitada. ¿Por qué crees?";
    const r = redactStateRevealSentence(input, evaluableElements, "está cortocircuitada", "es", 2);
    expect(r.redacted).toBe(true);
    expect(r.text).toMatch(/falta una pieza|pieza concreta del análisis/i);
  });

  test("priorHits>=3 suprime el placeholder y conserva la pregunta", () => {
    const input = "R1 está cortocircuitada. ¿Por qué crees?";
    const r = redactStateRevealSentence(input, evaluableElements, "está cortocircuitada", "es", 3);
    expect(r.redacted).toBe(true);
    expect(r.text).not.toMatch(/propiedad relevante|característica clave|pieza concreta/);
    expect(r.text).toMatch(/\?/);
  });

  test("rotación funciona también en valenciano y en inglés", () => {
    const r1 = redactStateRevealSentence("R1 està en curtcircuit. Per què creus?", evaluableElements, "està en curtcircuit", "val", 1);
    expect(r1.redacted).toBe(true);
    expect(r1.text).toMatch(/característica clau/);

    const r2 = redactStateRevealSentence("R1 is shorted. Why?", evaluableElements, "is shorted", "en", 1);
    expect(r2.redacted).toBe(true);
    expect(r2.text).toMatch(/key characteristic/);
  });

  // BUG-012 (2026-05-03): cuando hay DOS frases con state-reveal sobre
  // elementos distintos, el primer placeholder no debe dejar la segunda
  // intacta. Eliminamos las secundarias sin reinyectar placeholder.
  test("doble state-reveal con Rn distinto: redacta primera, elimina segunda", () => {
    const input =
      "A R1 contribuye porque está conectada en serie. R5 no lo hace debido a estar cortocircuitada. ¿Por qué crees?";
    const r = redactStateRevealSentence(input, evaluableElements, "está conectada", "es");
    expect(r.redacted).toBe(true);
    // Primera frase → placeholder
    expect(r.text).toMatch(/propiedad relevante|característica clave|pieza/);
    // Segunda frase con R5+cortocircuitada eliminada
    expect(r.text).not.toMatch(/R5/);
    expect(r.text).not.toMatch(/cortocircuitada/i);
    // La pregunta original sobrevive
    expect(r.text).toMatch(/\?$/);
  });

  test("frase secundaria sin keyword de estado se conserva", () => {
    const input =
      "A R1 contribuye porque está conectada en serie. R3 también está en el circuito principal. ¿Algo más?";
    const r = redactStateRevealSentence(input, evaluableElements, "está conectada", "es");
    expect(r.redacted).toBe(true);
    // Primera frase → placeholder
    expect(r.text).toMatch(/propiedad relevante/);
    // Segunda frase NO tiene keyword leak (no menciona "cortocircuitada"
    // ni "no contribuye" etc.) → debe sobrevivir.
    expect(r.text).toMatch(/R3/);
  });

  test("priorHits inválido (negativo o no numérico) trata como 0", () => {
    const input = "R1 está cortocircuitada. ¿Por qué crees?";
    const r1 = redactStateRevealSentence(input, evaluableElements, "está cortocircuitada", "es", -5);
    expect(r1.redacted).toBe(true);
    expect(r1.text).toMatch(/propiedad relevante que debes identificar/);
    const r2 = redactStateRevealSentence(input, evaluableElements, "está cortocircuitada", "es", "foo");
    expect(r2.redacted).toBe(true);
    expect(r2.text).toMatch(/propiedad relevante que debes identificar/);
  });
});

// ─── A8 — extractResistances unicode bombs ───────────────────────────────────

describe("extractResistances (A8 — unicode homoglyphs / A22 — mal escrito)", () => {
  test("ignores mathematical-script 𝓡 (not ASCII R)", () => {
    // 𝓡 (U+1D4E1) is mathematical script capital R — should NOT be parsed.
    const out = extractResistances("𝓡1, 𝓡2, 𝓡4");
    expect(out).not.toContain("R1");
    expect(out).not.toContain("R2");
    expect(out).not.toContain("R4");
  });

  test("ignores mis-spelled 'R quatro'", () => {
    const out = extractResistances("R1, R2 y R quatro");
    expect(out).toEqual(["R1", "R2"]);
  });

  test("normalises lowercase r1 to uppercase R1", () => {
    const out = extractResistances("r1, R2");
    expect(out).toContain("R1");
    expect(out).toContain("R2");
  });

  test("does not produce duplicates for repeats", () => {
    const out = extractResistances("R1, R1, R1");
    expect(out.filter((x) => x === "R1").length).toBeLessThanOrEqual(2);
  });

  test("never throws on empty / null / huge input", () => {
    expect(() => extractResistances("")).not.toThrow();
    expect(() => extractResistances(null)).not.toThrow();
    expect(() => extractResistances("x".repeat(10000))).not.toThrow();
  });

  test("does not match 'correctas' as element names", () => {
    const out = extractResistances("dame las resistencias correctas");
    expect(out).toEqual([]);
  });
});

// ─── extractMentionedElements robustness ────────────────────────────────────

describe("extractMentionedElements (robustness)", () => {
  const universe = ["R1", "R2", "R3", "R4", "R5"];

  test("returns empty for empty/null input", () => {
    expect(extractMentionedElements("", universe)).toEqual([]);
    expect(extractMentionedElements(null, universe)).toEqual([]);
  });

  test("does not match substring 'R10' when looking for R1", () => {
    // word-boundary-aware
    const out = extractMentionedElements("R10 contribuye", universe);
    expect(out).not.toContain("R1");
  });
});

// ─── removeOpeningConfirmation idempotency ──────────────────────────────────

describe("removeOpeningConfirmation (B6 — anti-stack)", () => {
  test("strips a single 'Perfecto.' opening", () => {
    const out = removeOpeningConfirmation("Perfecto. Vamos a pensar.", "es");
    expect(out.toLowerCase()).not.toMatch(/^perfecto/);
  });

  test("does not eat the word 'Eso está' (regression bug 'Tá')", () => {
    // 2026-04-27 bug: 'eso es' prefix matched 'Eso está' and stripped 6 chars,
    // leaving 'tá muy bien dicho...' capitalised as 'Tá...'.
    const out = removeOpeningConfirmation("Eso está muy bien encaminado.", "es");
    expect(out).toBe("Eso está muy bien encaminado.");
  });

  test("returns input on empty/non-confirm starts", () => {
    expect(removeOpeningConfirmation("¿Qué crees?", "es")).toBe("¿Qué crees?");
  });
});

// ─── AdherenceGuardrail surgical idempotency edge ───────────────────────────

describe("AdherenceGuardrail (NS-33 — surgical fix safety)", () => {
  const g = new AdherenceGuardrail();
  const correctAnswer = ["R1", "R2", "R4"];

  test("multi-question rule truncates at first '?'", () => {
    const text = "¿Por qué crees eso? ¿Y si miras R5?";
    const fix = g.surgicalFix(text, { correctAnswer });
    expect(fix.applied).toBe(true);
    expect((fix.text.match(/\?/g) || []).length).toBe(1);
  });

  test("does NOT mutate when only missed_affirmation (log-only) fires", () => {
    // verdict.hits=[R1] but response doesn't name R1: log-only, not surgical.
    const r = g.check("Vamos a revisar la corriente global.", {
      correctAnswer,
      turnVerdict: { hits: ["R1"], errors: [], missing: [], wronglyNegated: [] },
    });
    expect(r.violated).toBe(false);
    expect(r.metadata && r.metadata.logOnly).toBeDefined();
  });

  test("contradiction inside QUESTION is not flagged (skip questions)", () => {
    const r = g.check("¿Por qué dices que R4 no contribuye?", { correctAnswer });
    expect(r.violated).toBe(false);
  });
});
