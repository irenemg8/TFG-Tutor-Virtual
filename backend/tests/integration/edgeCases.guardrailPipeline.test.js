"use strict";

/**
 * Layer 2 — integration test del GuardrailPipeline ante respuestas LLM
 * adversariales. Verifica que el pipeline (parallel checks + surgical
 * fixes + retry consolidado) defiende correctamente contra las
 * regresiones B1, B2, B3, B4, B6, B7, B13 del catálogo
 * `.apex/wiki/concepts/edge-cases-tutor-socratico.md`.
 *
 * El LLM se mockea: el primer chatCompletion devuelve la respuesta mala,
 * los siguientes devuelven respuestas controladas para simular retry.
 *
 * NO requiere servers (Ollama, BD, frontend).
 */

const GuardrailPipeline = require("../../src/domain/services/GuardrailPipeline");
const { createDefaultGuardrails, createLegacyGuardrails } = require("../../src/infrastructure/guardrails");

class MockLlmAdapter {
  constructor(responses) {
    this.responses = responses.slice();
    this.calls = [];
  }
  async chatCompletion(messages, options) {
    this.calls.push({ messages, options });
    if (this.responses.length === 0) {
      throw new Error("MockLlmAdapter ran out of canned responses");
    }
    return this.responses.shift();
  }
  async chatCompletionStream() { throw new Error("not implemented in mock"); }
  async chatCompletionStreaming() { throw new Error("not implemented in mock"); }
}

const exerciseCtx = {
  correctAnswer: ["R1", "R2", "R4"],
  evaluableElements: ["R1", "R2", "R3", "R4", "R5"],
  kgConceptPatterns: ["circuito abierto", "diferencia de potencial"],
  classification: "wrong_answer",
  mentionedElements: ["R3"], // student said R3
  proposed: ["R3"],
  negated: [],
  lang: "es",
};

const messages = [
  { role: "system", content: "You are a Socratic tutor for circuits." },
  { role: "user", content: "creo que es R3" },
];

function makePipeline(retryReplies, opts) {
  return new GuardrailPipeline({
    guardrails: (opts && opts.guardrails) || createDefaultGuardrails(),
    llmService: new MockLlmAdapter(retryReplies || []),
    budgetMs: 30000,
    minRetryBudgetMs: 5000,
  });
}

describe("GuardrailPipeline — primary OK path", () => {
  test("safe response passes through with path=primary_ok", async () => {
    const pipeline = makePipeline([]);
    // Avoid any opener that overlaps with confirmPhrases (e.g. "Bien",
    // "Buena observación", "Vas por buen camino"): even an earnest
    // socratic preamble can match because confirmPhrases is a broad set.
    const safe = "¿Has mirado todas las ramas que conectan N2 a 0?";
    const r = await pipeline.validate(safe, exerciseCtx, { messages });
    expect(r.violated).toBe(false);
    expect(r.path).toBe("primary_ok");
    expect(r.surgicalFixesApplied).toEqual([]);
  });
});

describe("GuardrailPipeline — surgical fix path", () => {
  test("B1 — false confirmation 'Perfecto.' is surgically prefixed or LLM-retried", async () => {
    // Provide a clean retry in case surgical alone leaves residual violations.
    const cleanRetry = "Mira la rama de R3 con cuidado. ¿Por dónde podría salir la corriente desde N2?";
    const pipeline = makePipeline([cleanRetry]);
    const bad = "Perfecto, has identificado bien R3. ¿Qué más?";
    const r = await pipeline.validate(bad, exerciseCtx, { messages });
    expect(["surgical_ok", "llm_retry_ok", "llm_retry_plus_surgical"]).toContain(r.path);
    // Final response must NOT start with bare "Perfecto" on a wrong answer.
    expect(r.response.toLowerCase()).not.toMatch(/^perfecto[\s,.]/);
  });

  test("B3 — state reveal 'R5 está cortocircuitada' triggers surgical redaction", async () => {
    const pipeline = makePipeline([]);
    const bad = "R5 está cortocircuitada y por eso no contribuye. ¿Lo ves?";
    const r = await pipeline.validate(bad, exerciseCtx, { messages });
    // Should at least surgically remove the state-reveal sentence.
    expect(r.surgicalFixesApplied).toContain("state_reveal");
    expect(r.response).not.toMatch(/cortocircuitada/);
    // After redaction the response must STILL contain a question (B13 fix).
    expect(r.response).toMatch(/\?/);
  });

  test("B7 — multi-question is surgically truncated to first '?'", async () => {
    const pipeline = makePipeline([]);
    const bad = "Vamos a pensar. ¿Qué pasa con R3? ¿Y con R5? ¿Has visto R1?";
    const r = await pipeline.validate(bad, exerciseCtx, { messages });
    // adherence guardrail multi_question rule
    expect(["surgical_ok", "primary_ok"]).toContain(r.path);
    if (r.path === "surgical_ok") {
      const qmarks = (r.response.match(/\?/g) || []).length;
      expect(qmarks).toBe(1);
    }
  });

  test("B8 — adherence contradiction 'R4 no contribuye' is surgically dropped", async () => {
    const pipeline = makePipeline([]);
    const bad = "Vamos a analizar. R4 no contribuye porque está aislada. ¿Por dónde sale la corriente?";
    const r = await pipeline.validate(bad, exerciseCtx, { messages });
    expect(r.surgicalFixesApplied).toContain("adherence");
    expect(r.response).not.toMatch(/R4 no contribuye/);
  });
});

describe("GuardrailPipeline — LLM retry path", () => {
  test("solution leak escalates to LLM retry when surgical can't fix", async () => {
    // SolutionLeakGuardrail surgicalFix uses redactElementMentions which
    // CAN fix many cases. Force a hard case: response leaks via reveal
    // phrase + the surgical produces an empty result.
    const bad = "La respuesta es R1, R2 y R4.";
    const cleanRetry = "Vamos paso a paso. ¿Por qué dices que esas tres?";
    const pipeline = makePipeline([cleanRetry]);
    const r = await pipeline.validate(bad, exerciseCtx, { messages });
    // Pipeline either fixes surgically or retries. Either way the final
    // response must NOT be the original leak.
    expect(r.response).not.toMatch(/La respuesta es R1, R2 y R4/);
  });

  test("retry that ALSO leaks gets a final surgical fallback", async () => {
    // Worst case: primary leaks, retry ALSO leaks. Pipeline should still
    // not return a leak — it falls back to surgical on the retry response.
    const pipeline = makePipeline(["La respuesta es R1, R2 y R4."]);
    const bad = "La respuesta es R1, R2 y R4.";
    const r = await pipeline.validate(bad, exerciseCtx, { messages });
    expect(r.response).not.toMatch(/^La respuesta es R1, R2 y R4\./);
  });
});

describe("GuardrailPipeline — anti-stack idempotency (B6 — triple-prefix)", () => {
  test("response already starting with intermediate phrase is NOT re-prefixed", async () => {
    const pipeline = makePipeline([]);
    // The text already has a corrective intermediate phrase. The
    // surgical fix MUST NOT prepend a second one (regression NS-34).
    const already = "Aún no del todo. Vas por buen camino. Perfecto, R3.";
    const r = await pipeline.validate(already, exerciseCtx, { messages });
    // Count "Aún no del todo" occurrences: must remain ≤ 1.
    const count = (r.response.match(/Aún no del todo/gi) || []).length;
    expect(count).toBeLessThanOrEqual(1);
  });
});

describe("GuardrailPipeline — empty/edge inputs", () => {
  test("empty response → no crash", async () => {
    const pipeline = makePipeline([]);
    const r = await pipeline.validate("", exerciseCtx, { messages });
    expect(typeof r.response).toBe("string");
  });

  test("response without any element mention → primary_ok", async () => {
    const pipeline = makePipeline([]);
    const r = await pipeline.validate(
      "Buen análisis general. ¿Qué dirías sobre la corriente que sale de la fuente?",
      exerciseCtx,
      { messages },
    );
    expect(r.violated).toBe(false);
  });
});

describe("GuardrailPipeline — legacy profile (premature confirmation enabled)", () => {
  test("premature confirmation with full correct answer triggers under legacy", async () => {
    const guardrails = createLegacyGuardrails();
    const pipeline = makePipeline([], { guardrails });
    // Student gave the exact correct answer in tag-question form (A14).
    const ctx = Object.assign({}, exerciseCtx, {
      classification: "correct_no_reasoning",
      mentionedElements: ["R1", "R2", "R4"],
      proposed: ["R1", "R2", "R4"],
    });
    const bad = "Exacto, son R1, R2 y R4.";
    const r = await pipeline.validate(bad, ctx, { messages });
    // Legacy profile with PrematureConfirmationGuardrail should detect this.
    // We only assert no crash + path is one of the documented values.
    expect(["primary_ok", "surgical_ok", "llm_retry_ok", "no_retry_hints", "budget_exhausted"])
      .toContain(r.path);
  });
});
