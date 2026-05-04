"use strict";

/**
 * Tests dedicados a los fixes de la batería adversarial 2026-05-03:
 *   - BUG-002 (LanguageDriftGuardrail) — detecta scripts no-latinos.
 *   - BUG-003 (detectLanguageHeuristic + resolveLanguage) — sostiene EN.
 *   - BUG-004 (fixPlaceholderAgreement) — corrige concordancia placeholder/verbo.
 *   - BUG-005 (SolutionLeakGuardrail semantic leak) — afirmación tras redacción.
 *
 * NO requiere LLM/BD/servers. Sólo lógica determinista.
 */

const SolutionLeakGuardrail = require("../../src/infrastructure/guardrails/SolutionLeakGuardrail");
const LanguageDriftGuardrail = require("../../src/infrastructure/guardrails/LanguageDriftGuardrail");
const {
  detectLanguageHeuristic,
  resolveLanguage,
} = require("../../src/domain/services/languageManager");
const {
  redactElementMentions,
  fixPlaceholderAgreement,
} = require("../../src/domain/services/rag/guardrails");

// ─── BUG-002 — LanguageDriftGuardrail ────────────────────────────────────────

describe("LanguageDriftGuardrail (BUG-002 — drift a chino/cirílico)", () => {
  const g = new LanguageDriftGuardrail();

  test("detecta caracteres CJK en mid-respuesta", () => {
    const r = g.check("Vamos a pensar en R5. 短路的电阻 R5. ¿Por qué?");
    expect(r.violated).toBe(true);
    expect(r.evidence).toMatch(/non_latin_chars_count/);
  });

  test("detecta cirílico", () => {
    const r = g.check("Хорошо. Sigue pensando en el circuito.");
    expect(r.violated).toBe(true);
  });

  test("detecta hangul (coreano)", () => {
    const r = g.check("저항 R5는. ¿Qué crees?");
    expect(r.violated).toBe(true);
  });

  test("NO falsos positivos en español puro", () => {
    const r = g.check("Vamos a pensar en R5. ¿Por qué crees que está en cortocircuito?");
    expect(r.violated).toBe(false);
  });

  test("NO falsos positivos con tildes/eñes", () => {
    const r = g.check("¿Qué pasaría si añades una resistencia más entre N1 y N2?");
    expect(r.violated).toBe(false);
  });

  test("NO falsos positivos en valencià", () => {
    const r = g.check("Què passa amb la resistència en curtcircuit? Pensa-hi.");
    expect(r.violated).toBe(false);
  });

  test("surgicalFix elimina la frase con drift y deja el resto", () => {
    const bad = "Bien encaminado. 短路的电阻 R5. ¿Qué pasa con esa rama?";
    const fix = g.surgicalFix(bad);
    expect(fix).toBeTruthy();
    expect(fix.applied).toBe(true);
    expect(/[一-鿿]/u.test(fix.text)).toBe(false);
    // El "?" final debe sobrevivir (la frase interrogativa no tenía CJK).
    expect(fix.text).toMatch(/\?/);
  });

  test("surgicalFix devuelve null si tras filtrar queda muy poca cosa", () => {
    const bad = "短路的电阻 R5 是.";
    const fix = g.surgicalFix(bad);
    expect(fix).toBeNull();
  });

  test("buildRetryHint devuelve mensaje en el idioma esperado", () => {
    expect(g.buildRetryHint("es")).toMatch(/no-latino|alfabeto/i);
    expect(g.buildRetryHint("en")).toMatch(/non-Latin|Latin alphabet/i);
    expect(g.buildRetryHint("val")).toMatch(/no-llatí|llatí/i);
  });
});

// ─── BUG-003 — detectLanguageHeuristic + resolveLanguage ─────────────────────

describe("detectLanguageHeuristic (BUG-003 — idioma sostenido sin switch explícito)", () => {
  test("input EN claro detecta 'en'", () => {
    const lang = detectLanguageHeuristic("I think it's R3, what do you think?");
    expect(lang).toBe("en");
  });

  test("input ES claro detecta 'es'", () => {
    const lang = detectLanguageHeuristic("Creo que la corriente pasa por R3 porque está conectada");
    expect(lang).toBe("es");
  });

  test("input val claro detecta 'val'", () => {
    const lang = detectLanguageHeuristic("Crec que la resistència té el corrent que passa per ací");
    expect(lang).toBe("val");
  });

  test("input demasiado corto → null (mantiene default)", () => {
    expect(detectLanguageHeuristic("R3")).toBeNull();
    expect(detectLanguageHeuristic("no sé")).toBeNull();
  });

  test("input ambiguo → null", () => {
    // Sólo Rn + signos: ninguna stopword.
    expect(detectLanguageHeuristic("R1 R2 R3 R4 R5 R6")).toBeNull();
  });
});

describe("resolveLanguage usa heurística cuando no hay switch explícito", () => {
  test("último mensaje claramente EN → resolveLanguage devuelve 'en'", () => {
    const lang = resolveLanguage([
      { role: "user", content: "I think the answer involves R3 and R5, what do you think?" },
    ]);
    expect(lang).toBe("en");
  });

  test("switch explícito a EN gana sobre mensaje posterior en ES", () => {
    const lang = resolveLanguage([
      { role: "user", content: "switch to english please" },
      { role: "assistant", content: "Sure, what do you think?" },
      { role: "user", content: "ok dame una pista" },
    ]);
    expect(lang).toBe("en");
  });

  test("historial vacío → 'es'", () => {
    expect(resolveLanguage([])).toBe("es");
  });

  test("historial con mensajes ambiguos → 'es' (default)", () => {
    const lang = resolveLanguage([
      { role: "user", content: "R3" },
    ]);
    expect(lang).toBe("es");
  });
});

// ─── BUG-004 — fixPlaceholderAgreement ────────────────────────────────────────

describe("fixPlaceholderAgreement (BUG-004 — concordancia placeholder/verbo)", () => {
  test("'ese conjunto de elementos contribuyen' → 'esos elementos contribuyen'", () => {
    const out = fixPlaceholderAgreement(
      "Sí, ese conjunto de elementos contribuyen al voltaje.",
      "es"
    );
    expect(out).toMatch(/esos elementos contribuyen/);
    expect(out).not.toMatch(/ese conjunto de elementos contribuyen/);
  });

  test("'ese conjunto de elementos contribuye' (singular OK) NO se modifica", () => {
    const out = fixPlaceholderAgreement(
      "Ese conjunto de elementos contribuye al voltaje.",
      "es"
    );
    expect(out).toMatch(/[Ee]se conjunto de elementos contribuye/);
  });

  test("'son ese conjunto de elementos' → 'son esos elementos'", () => {
    const out = fixPlaceholderAgreement(
      "Las que importan son ese conjunto de elementos.",
      "es"
    );
    expect(out).toMatch(/son esos elementos/);
  });

  test("EN: 'that set of elements contribute' → 'those elements contribute'", () => {
    const out = fixPlaceholderAgreement(
      "Yes, that set of elements contribute to the voltage.",
      "en"
    );
    expect(out).toMatch(/those elements contribute/);
  });

  test("integración con redactElementMentions → respuesta gramatical", () => {
    const input = "Sí, R1, R2 y R4 contribuyen al voltaje.";
    const { text } = redactElementMentions(input, ["R1", "R2", "R4"], "es");
    // No debe haber concordancia rota: 'ese conjunto de elementos contribuyen'.
    expect(text).not.toMatch(/ese conjunto de elementos\s+contribuyen/);
    // Y el placeholder coherente debe estar.
    expect(text).toMatch(/(esos elementos|esas resistencias|ese conjunto de elementos)/);
  });
});

// ─── BUG-007 — tutor stuck on same Rn ───────────────────────────────────────

describe("contextAgent _detectStuckOnElement (BUG-007)", () => {
  // Carga directa para no construir un container completo.
  const ContextAgent = require("../../src/domain/agents/contextAgent");
  const ca = Object.create(ContextAgent.prototype);

  test("detecta R1 cuando aparece en 3 preguntas consecutivas", () => {
    const messages = [
      { content: "Vale, ¿podrías explicar cómo R1 contribuye al voltaje?" },
      { content: "¿Podrías describir cómo R1 afecta la corriente en N2?" },
      { content: "¿Cómo está conectado R1 entre N2 y tierra?" },
    ];
    expect(ca._detectStuckOnElement(messages)).toBe("R1");
  });

  test("detecta R1 cuando aparece en 2 de 3 preguntas (umbral)", () => {
    const messages = [
      { content: "¿Cómo R1 contribuye al voltaje?" },
      { content: "¿Y qué pasa si retiramos algo del circuito?" },
      { content: "¿Cómo R1 afecta la corriente?" },
    ];
    expect(ca._detectStuckOnElement(messages)).toBe("R1");
  });

  test("NO detecta cuando cada pregunta usa Rn distinto", () => {
    const messages = [
      { content: "¿Cómo R1 contribuye?" },
      { content: "¿Y R5?" },
      { content: "¿Qué pasa con R3?" },
    ];
    expect(ca._detectStuckOnElement(messages)).toBeNull();
  });

  test("NO detecta cuando hay 1 sola pregunta", () => {
    const messages = [{ content: "¿Cómo R1 afecta?" }];
    expect(ca._detectStuckOnElement(messages)).toBeNull();
  });

  test("ignora menciones FUERA de la pregunta interrogativa", () => {
    // En la frase introductoria menciona R1, pero la pregunta es sobre R3.
    const messages = [
      { content: "R1 está bien. ¿Cómo R3 afecta el voltaje?" },
      { content: "Vale R1 controlado. ¿Y R3 cómo participa?" },
    ];
    expect(ca._detectStuckOnElement(messages)).toBe("R3");
  });

  test("devuelve null si no hay Rn en preguntas", () => {
    const messages = [
      { content: "¿Cómo está conectado el circuito?" },
      { content: "¿Has identificado todos los nodos?" },
    ];
    expect(ca._detectStuckOnElement(messages)).toBeNull();
  });
});

// ─── BUG-006 — yes/no implícito sobre Rn equivocado ─────────────────────────

const { classifyQuery } = require("../../src/domain/services/rag/queryClassifier");

describe("classifyQuery yes/no implícito (BUG-006 — false_confirmation)", () => {
  const correctAnswer = ["R1", "R2", "R4"];
  const evaluableElements = ["R1", "R2", "R3", "R4", "R5"];

  test("'Sí' a '¿Influye R5?' → wrong_concept (R5 NO está en correct)", () => {
    const res = classifyQuery(
      "Sí",
      correctAnswer,
      evaluableElements,
      "¿Crees que la resistencia R5 influya en la diferencia de potencial entre el nudo N2 y la tierra?"
    );
    expect(res.type).toBe("wrong_concept");
    expect(res.proposed).toContain("R5");
    expect(res.resistances).toContain("R5");
  });

  test("'Sí' a '¿Influye R1?' → correct_no_reasoning (R1 SÍ está en correct)", () => {
    const res = classifyQuery(
      "Sí",
      correctAnswer,
      evaluableElements,
      "¿Crees que la resistencia R1 influya en la diferencia de potencial?"
    );
    expect(res.type).toBe("correct_no_reasoning");
    expect(res.proposed).toContain("R1");
  });

  test("'No' a '¿Influye R1?' → wrong_concept (rechaza correcta)", () => {
    const res = classifyQuery(
      "No",
      correctAnswer,
      evaluableElements,
      "¿Crees que R1 influya en el voltaje?"
    );
    expect(res.type).toBe("wrong_concept");
    expect(res.negated).toContain("R1");
  });

  test("'No' a '¿Influye R5?' → correct_no_reasoning (rechaza incorrecta)", () => {
    const res = classifyQuery(
      "No",
      correctAnswer,
      evaluableElements,
      "¿Crees que R5 influya en el voltaje?"
    );
    expect(res.type).toBe("correct_no_reasoning");
    expect(res.negated).toContain("R5");
  });

  test("'Sí' a pregunta conceptual sin Rn → correct_no_reasoning (no afecta)", () => {
    const res = classifyQuery(
      "Sí",
      correctAnswer,
      evaluableElements,
      "¿Crees que todas las resistencias influyen en la diferencia de potencial?"
    );
    // Sin Rn explícita en la pregunta de cierre, conserva flujo socrático.
    expect(res.type).toBe("correct_no_reasoning");
  });

  test("'Sí' a pregunta diagnóstica '¿tienes dudas?' → closed_answer", () => {
    const res = classifyQuery(
      "Sí",
      correctAnswer,
      evaluableElements,
      "¿Te queda alguna duda?"
    );
    expect(res.type).toBe("closed_answer");
  });
});

// ─── BUG-005 — SolutionLeakGuardrail semantic leak ───────────────────────────

describe("SolutionLeakGuardrail (BUG-005 — leak semántico anafórico post-redaction)", () => {
  const g = new SolutionLeakGuardrail();

  test("detecta 'esos elementos son los que contribuyen' como leak semántico", () => {
    const r = g.check(
      "Sí, esos elementos son los que contribuyen al voltaje.",
      { correctAnswer: ["R1", "R2", "R4"] }
    );
    expect(r.violated).toBe(true);
    expect(r.evidence).toMatch(/semantic_leak/);
  });

  test("detecta 'ese conjunto de elementos son los que contribuyen' como leak semántico", () => {
    const r = g.check(
      "Sí, ese conjunto de elementos son los que contribuyen.",
      { correctAnswer: ["R1", "R2", "R4"] }
    );
    expect(r.violated).toBe(true);
  });

  test("detecta 'esas resistencias son las que contribuyen'", () => {
    const r = g.check(
      "Tienes razón, esas resistencias son las que contribuyen al voltaje.",
      { correctAnswer: ["R1", "R2", "R4"] }
    );
    expect(r.violated).toBe(true);
  });

  test("detecta 'tienes razón' + placeholder", () => {
    const r = g.check(
      "Tienes razón. Esas resistencias contribuyen.",
      { correctAnswer: ["R1", "R2", "R4"] }
    );
    expect(r.violated).toBe(true);
  });

  test("EN: 'those elements are the ones that contribute'", () => {
    const r = g.check(
      "Yes, those elements are the ones that contribute.",
      { correctAnswer: ["R1", "R2", "R4"] }
    );
    expect(r.violated).toBe(true);
  });

  test("NO falso positivo en pregunta con placeholder", () => {
    const r = g.check(
      "¿Crees que esas resistencias son las que contribuyen?",
      { correctAnswer: ["R1", "R2", "R4"] }
    );
    expect(r.violated).toBe(false);
  });

  test("NO falso positivo en frase neutral con placeholder", () => {
    const r = g.check(
      "Piensa qué tienen en común esas resistencias y revísalas.",
      { correctAnswer: ["R1", "R2", "R4"] }
    );
    expect(r.violated).toBe(false);
  });

  test("surgicalFix elimina la frase con leak semántico y deja una pregunta", () => {
    const bad = "Sí, esas resistencias son las que contribuyen. ¿Qué tienen en común sus terminales?";
    const fix = g.surgicalFix(bad, { correctAnswer: ["R1", "R2", "R4"], lang: "es" });
    expect(fix).toBeTruthy();
    if (fix && fix.applied) {
      expect(fix.text).not.toMatch(/son\s+las\s+que/);
      expect(fix.text).toMatch(/\?/);
    }
  });

  test("surgicalFix devuelve null cuando todo se eliminaría (forza retry)", () => {
    const bad = "Sí, esas resistencias son las que contribuyen.";
    const fix = g.surgicalFix(bad, { correctAnswer: ["R1", "R2", "R4"], lang: "es" });
    // Pipeline se encarga de retry cuando devolvemos null.
    expect(fix).toBeNull();
  });
});
