"use strict";

/**
 * Smoke test suite for the hexagonal refactor.
 *
 * Run with: node tests/smoke/runAll.js
 *
 * Covers:
 *   - Unit tests for each IGuardrail adapter (with real production FP inputs)
 *   - Integration tests for GuardrailPipeline (parallel, surgical-first, budget)
 *   - Contract test for ILlmService (mock adapter)
 *   - End-to-end smoke through the orchestrator with stub repos
 *
 * No network. No real database. No real LLM. Everything mocked.
 * Exit code: 0 if all pass, 1 if any fail.
 */

const path = require("path");
const ROOT = path.join(__dirname, "..", "..");

// Make imports relative to backend root
process.chdir(ROOT);

const results = [];
function record(name, pass, detail) {
  results.push({ name, pass, detail });
  console.log((pass ? "  ✓ " : "  ✗ ") + name + (detail ? " — " + detail : ""));
}

async function runSection(title, fn) {
  console.log("\n━━━ " + title + " ━━━");
  try {
    await fn();
  } catch (err) {
    record(title + " (uncaught)", false, err.message);
  }
}

// ─── Section 1: text services ────────────────────────────────────────────────

async function textServices() {
  const { stripAccents } = require(path.join(ROOT, "src/domain/services/text/accentNormalizer"));
  const { sameSet, containsAll } = require(path.join(ROOT, "src/domain/services/text/setComparison"));
  const { splitSentences, splitSentencesKeepEnd } = require(path.join(ROOT, "src/domain/services/text/sentenceSplitter"));
  const { extractResistances, extractMentionedElements } = require(path.join(ROOT, "src/domain/services/text/elementExtractor"));
  const { isNegatedInContext, detectNegationAround } = require(path.join(ROOT, "src/domain/services/text/negationDetector"));

  record("stripAccents('tensión') == 'tension'", stripAccents("tensión") === "tension");
  record("sameSet equal sets", sameSet(["R1","R2","R4"], ["R4","R1","R2"]) === true);
  record("containsAll subset", containsAll(["R1","R2","R4"], ["R1","R4"]) === true);
  record("splitSentences basic", JSON.stringify(splitSentences("Hola. ¿Qué? Bien.")) === '["Hola","¿Qué","Bien"]');
  record("extractResistances r1 r2 r4", JSON.stringify(extractResistances("r1 r2 r4")) === '["R1","R2","R4"]');
  record("extractMentionedElements generic", extractMentionedElements("R1 y R4", ["R1","R2","R3","R4","R5"]).length === 2);
  // Critical FP fix:
  record("isNegatedInContext('No es exactamente', 'exactamente') == true", isNegatedInContext("No es exactamente así", "exactamente") === true);
  record("isNegatedInContext('Perfecto', 'perfecto') == false", isNegatedInContext("Perfecto, correcto", "perfecto") === false);
}

// ─── Section 2: guardrail adapters ───────────────────────────────────────────

async function guardrailAdapters() {
  const { createDefaultGuardrails } = require(path.join(ROOT, "src/infrastructure/guardrails"));
  const guardrails = createDefaultGuardrails();
  const byId = {};
  for (const g of guardrails) byId[g.id] = g;

  record("8 guardrails registered", guardrails.length === 8);
  record("all have unique ids", Object.keys(byId).length === 8);

  // Regression: the 4 critical FPs from production logs
  const fc = byId.false_confirmation;
  record(
    "FP: \"No es exactamente así\" does NOT trigger false_confirmation",
    fc.check("No es exactamente así. Vamos a repasar.", { classification: "wrong_answer" }).violated === false
  );
  record(
    "TP: \"Perfecto\" DOES trigger false_confirmation on wrong_answer",
    fc.check("Perfecto. Muy bien.", { classification: "wrong_answer" }).violated === true
  );

  const sr = byId.state_reveal;
  record(
    "FP: Socratic question about KG concept does NOT trigger state_reveal",
    sr.check("¿Por qué R1 contribuye a la diferencia de potencial?", {
      evaluableElements: ["R1","R2","R3","R4","R5"],
      kgConceptPatterns: ["diferencia de potencial"],
    }).violated === false
  );
  record(
    "TP: \"R5 está cortocircuitada\" DOES trigger state_reveal",
    sr.check("R5 está cortocircuitada en este circuito.", {
      evaluableElements: ["R1","R2","R3","R4","R5"],
      kgConceptPatterns: [],
    }).violated === true
  );

  const sl = byId.solution_leak;
  record(
    "TP: 'Son R1, R2 y R4' affirmative DOES trigger solution_leak",
    sl.check("Son R1, R2 y R4 las correctas.", { correctAnswer: ["R1","R2","R4"] }).violated === true
  );
  record(
    "FP: '¿Serán R1, R2 y R4?' question does NOT trigger solution_leak",
    sl.check("¿Serán R1, R2 y R4 las correctas?", { correctAnswer: ["R1","R2","R4"] }).violated === false
  );

  const pc = byId.premature_confirmation;
  record(
    "FP: 'No es correcto todavía' does NOT trigger premature (negation aware)",
    pc.check("No es correcto todavía, falta justificar.", { classification: "correct_no_reasoning" }).violated === false
  );

  // Surgical fix sanity: SolutionLeakGuardrail should repair a leak
  const fix = sl.surgicalFix("Son R1, R2 y R4 las correctas.", { correctAnswer: ["R1","R2","R4"], lang: "es" });
  record("Surgical fix removes element list", fix && fix.applied === true);

  // CompleteSolutionGuardrail regression: catches confirmation of wrong PARTS.
  const cs = byId.complete_solution;
  record(
    "TP: 'Genial, has tenido en cuenta R4' on negated-correct R4 violates complete_solution",
    cs.check("Genial, has tenido en cuenta R4. Sigue así.", {
      correctAnswer: ["R1","R2","R4"], proposed: [], negated: ["R4"], lang: "es",
    }).violated === true
  );
  record(
    "TP: 'Muy bien, R4 contribuye también' when student gave R3+R4 violates complete_solution",
    cs.check("Muy bien, R4 contribuye también. ¿Y R3?", {
      correctAnswer: ["R1","R2","R4"], proposed: ["R3","R4"], negated: [], lang: "es",
    }).violated === true
  );
  record(
    "FP: clean Socratic question does NOT trigger complete_solution",
    cs.check("¿Por qué piensas que ese elemento no contribuye?", {
      correctAnswer: ["R1","R2","R4"], proposed: ["R3"], negated: [], lang: "es",
    }).violated === false
  );
  record(
    "FP: when student is fully correct, complete_solution does not fire",
    cs.check("Genial, lo has razonado bien.", {
      correctAnswer: ["R1","R2","R4"], proposed: ["R1","R2","R4"], negated: [], lang: "es",
    }).violated === false
  );
}

// ─── Section 3: GuardrailPipeline integration ────────────────────────────────

async function pipelineIntegration() {
  const GuardrailPipeline = require(path.join(ROOT, "src/domain/services/GuardrailPipeline"));
  const { createDefaultGuardrails } = require(path.join(ROOT, "src/infrastructure/guardrails"));

  class MockLlm {
    constructor(responses) { this.responses = responses || []; this.calls = 0; }
    async chatCompletion() { const r = this.responses[this.calls] || "OK"; this.calls++; return r; }
  }

  async function runCase(primary, ctx, mockResponses, budgetMs) {
    const pipeline = new GuardrailPipeline({
      guardrails: createDefaultGuardrails(),
      llmService: new MockLlm(mockResponses),
      budgetMs: budgetMs != null ? budgetMs : 45000,
      minRetryBudgetMs: 10000,
    });
    return pipeline.validate(primary, ctx, {
      messages: [{ role: "system", content: "sys" }, { role: "user", content: "msg" }],
      reqId: "test",
    });
  }

  const ctxBase = {
    correctAnswer: ["R1","R2","R4"],
    evaluableElements: ["R1","R2","R3","R4","R5"],
    kgConceptPatterns: [],
    classification: "wrong_answer",
    lang: "es",
  };

  const r1 = await runCase("Piensa en el circuito. ¿Qué observas?", ctxBase, []);
  record("Clean response → primary_ok, 0 LLM retries", r1.path === "primary_ok" && r1.llmRetryCount === 0);

  const r2 = await runCase("No es exactamente así. Piensa mejor.", ctxBase, []);
  record("FP response → primary_ok (not false_confirm)", r2.path === "primary_ok");

  const r3 = await runCase("Son R1, R2 y R4 las correctas.", { ...ctxBase, classification: "correct_no_reasoning" }, []);
  record("Leak → surgical_ok, 0 LLM retries", r3.path === "surgical_ok" && r3.llmRetryCount === 0);

  // After C4 (DidacticExplanationGuardrail.surgicalFix), didactic responses
  // are repaired surgically without an LLM retry — the response is reduced
  // to its existing question(s) or replaced with a rotating fallback.
  const r4 = await runCase(
    "Esto significa que cuando una resistencia está en corto, no pasa. ¿Qué crees que pasa con la corriente?",
    ctxBase,
    [] // no LLM retry expected
  );
  record("Didactic with embedded question → surgical_ok, 0 LLM retries (C4)",
    r4.path === "surgical_ok" && r4.llmRetryCount === 0);

  // Pure didactic with no embedded question → still surgical_ok (fallback question).
  const r5 = await runCase(
    "Esto significa que cuando una resistencia está en corto, no pasa la corriente por ella.",
    ctxBase,
    [] // surgical fallback fires; no LLM retry
  );
  record("Didactic without question → surgical_ok via fallback (C4)",
    r5.path === "surgical_ok" && r5.llmRetryCount === 0);
}

// ─── Section 4: ILlmService contract ─────────────────────────────────────────

async function llmServiceContract() {
  const ILlmService = require(path.join(ROOT, "src/domain/ports/services/ILlmService"));
  const { BudgetExhaustedError } = require(path.join(ROOT, "src/domain/ports/services/ILlmService"));
  const OllamaLlmAdapter = require(path.join(ROOT, "src/infrastructure/llm/OllamaLlmAdapter"));

  record("BudgetExhaustedError is exported", typeof BudgetExhaustedError === "function");
  record("OllamaLlmAdapter extends ILlmService", (new OllamaLlmAdapter()) instanceof ILlmService);
  record("OllamaLlmAdapter exposes chatCompletion", typeof new OllamaLlmAdapter().chatCompletion === "function");
  record("OllamaLlmAdapter exposes chatCompletionStream", typeof new OllamaLlmAdapter().chatCompletionStream === "function");
  record("OllamaLlmAdapter exposes isHealthy", typeof new OllamaLlmAdapter().isHealthy === "function");
}

// ─── Section 5: end-to-end via orchestrator (stubbed) ────────────────────────

async function orchestratorE2E() {
  const GuardrailPipeline = require(path.join(ROOT, "src/domain/services/GuardrailPipeline"));
  const { createDefaultGuardrails } = require(path.join(ROOT, "src/infrastructure/guardrails"));
  const { createAgentRegistry } = require(path.join(ROOT, "src/domain/agents/agentRegistry"));
  const TutoringOrchestrator = require(path.join(ROOT, "src/domain/agents/orchestrator"));
  const { classifyQuery } = require(path.join(ROOT, "src/domain/services/rag/queryClassifier"));
  const ragConfig = require(path.join(ROOT, "src/infrastructure/llm/config"));

  const mockLlm = {
    async chatCompletion() {
      // A response that violates BOTH solution_leak and state_reveal
      return "Eso es correcto. Son R1, R2 y R4 porque R5 está cortocircuitada.";
    },
  };

  const fakeExercise = {
    titulo: "Ejercicio 1",
    tutorContext: {
      respuestaCorrecta: ["R1", "R2", "R4"],
      elementosEvaluables: ["R1", "R2", "R3", "R4", "R5"],
      netlist: "R1 N1 N2\nR2 N2 0\nR3 N2 N3\nR4 N2 0\nR5 N1 0",
    },
    hasValidTutorContext() { return true; },
    getExerciseNumber() { return 1; },
    getCorrectAnswer() { return this.tutorContext.respuestaCorrecta; },
    getEvaluableElements() { return this.tutorContext.elementosEvaluables; },
  };

  const agents = createAgentRegistry({
    ejercicioRepo: { async findById() { return fakeExercise; } },
    interaccionRepo: { async existsForUser() { return false; }, async create() { return { id: "stub_iid" }; } },
    messageRepo: {
      async getLastMessages() { return []; },
      async getAllMessages() { return []; },
      async countConsecutiveFromEnd() { return 0; },
      async countAssistantMessages() { return 0; },
      async getLastAssistantMessages() { return []; },
      async appendMessage() { /* noop */ },
    },
    securityService: { analyzeInput: () => ({ safe: true, category: "safe" }) },
    llmService: mockLlm,
    guardrailPipeline: new GuardrailPipeline({
      guardrails: createDefaultGuardrails(),
      llmService: mockLlm,
      budgetMs: 45000,
    }),
    kgConceptPatterns: [],
    classifyQuery: classifyQuery,
    runFullPipeline: async () => ({
      augmentation: "",
      decision: "rag_examples",
      sources: [],
      classification: "correct_no_reasoning",
    }),
    buildSystemPrompt: () => "Eres tutor.",
    config: ragConfig,
  });

  const orchestrator = new TutoringOrchestrator(agents, { emitEvent: () => {} });
  const ctx = await orchestrator.process({
    userId: "69a4a7f39164d37979e0a740",
    exerciseId: "6832f72534ce3d55267f86cd",
    userMessage: "r1 r2 r4",
    interaccionId: null,
    budgetMs: 45000,
  });

  const hasNoElementList = !/R1[,\s]+R2[,\s]+(y\s+)?R4/.test(ctx.finalResponse || "");
  const hasNoStateReveal = !(ctx.finalResponse || "").toLowerCase().includes("está cortocircuitad");
  record("E2E: final response has no element list", hasNoElementList);
  record("E2E: final response has no state reveal", hasNoStateReveal);
  record("E2E: surgical path used (guardrailLlmRetries = 0)", ctx.guardrailLlmRetries === 0);
  record("E2E: surgical fixes applied", (ctx.guardrailSurgicalFixes || []).length >= 2);
  record("E2E: pipeline completed in <100ms", ctx.timing.pipelineMs != null && ctx.timing.pipelineMs < 100);
}

// ─── Run all ─────────────────────────────────────────────────────────────────

(async function main() {
  await runSection("Section 1: Shared domain text services", textServices);
  await runSection("Section 2: IGuardrail adapters (regression)", guardrailAdapters);
  await runSection("Section 3: GuardrailPipeline integration", pipelineIntegration);
  await runSection("Section 4: ILlmService contract", llmServiceContract);
  await runSection("Section 5: Orchestrator end-to-end", orchestratorE2E);

  const passed = results.filter(r => r.pass).length;
  const failed = results.length - passed;
  console.log("\n━━━ SUMMARY ━━━");
  console.log(passed + " passed, " + failed + " failed, " + results.length + " total");
  if (failed > 0) {
    console.log("\nFailed tests:");
    for (const r of results) {
      if (!r.pass) console.log("  ✗ " + r.name + (r.detail ? " — " + r.detail : ""));
    }
  }
  process.exit(failed > 0 ? 1 : 0);
})().catch(err => {
  console.error("SMOKE TEST CRASH:", err.stack);
  process.exit(2);
});
