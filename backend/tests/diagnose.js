"use strict";

/**
 * Real (no-mock) diagnostic test. Run from backend/:
 *   node tests/diagnose.js
 *
 * Loads the actual guardrail and classifier code, hits real strings observed
 * in production, and reports which "focos de error" reproduce.
 *
 * No mocks. No fake LLM here (Ollama is exercised by the live-LLM step at the
 * bottom only if --live is passed).
 */

const path = require("path");
const ROOT = path.join(__dirname, "..");
process.chdir(ROOT);
require("dotenv").config({ path: path.join(ROOT, ".env") });

const results = [];
function assert(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log((ok ? "  PASS " : "  FAIL ") + name + (detail ? "  ::  " + detail : ""));
}
function section(t) { console.log("\n=== " + t + " ==="); }

// ─── Load real modules ──────────────────────────────────────────────────────
const { createDefaultGuardrails } = require(path.join(ROOT, "src/infrastructure/guardrails"));
const { classifyQuery } = require(path.join(ROOT, "src/domain/services/rag/queryClassifier"));
const {
  isNegatedInContext,
} = require(path.join(ROOT, "src/domain/services/text/negationDetector"));
const guardrails = createDefaultGuardrails();
const byId = {}; for (const g of guardrails) byId[g.id] = g;

// ─── 1. STATE REVEAL pattern coverage ───────────────────────────────────────
section("1. StateReveal: pattern coverage on real production strings");
const sr = byId.state_reveal;
const ctxSR = { evaluableElements: ["R1","R2","R3","R4","R5"], kgConceptPatterns: [], lang: "es" };
const stateCases = [
  { msg: "R5 está cortocircuitada en este circuito.",         expect: true,  why: "feminine -ada (canonical)" },
  { msg: "Correcto, R5 no contribuye porque está cortocircuitado.", expect: true, why: "masculine -ado" },
  { msg: "Exacto, R3 también no contribuye debido al interruptor abierto entre N2 y N3.", expect: true, why: "switch-open phrase" },
  { msg: "R5 se cortocircuita cuando el switch cierra.",       expect: true,  why: "reflexive verb form" },
  { msg: "R3 queda en corto en esa rama.",                     expect: true,  why: "queda en corto" },
  { msg: "R1 está en corto y por eso no afecta.",              expect: true,  why: "está en corto (no -circuitado)" },
  { msg: "R5 tiene los terminales unidos, no opone resistencia.", expect: true, why: "topology-described state" },
  { msg: "El switch entre N2 y N3 está abierto, así que R3 no influye.", expect: true, why: "switch open + element" },
  { msg: "¿Por qué R1 contribuye a la diferencia de potencial?", expect: false, why: "Socratic question about KG concept (FP guard)" },
];
for (const c of stateCases) {
  const r = sr.check(c.msg, ctxSR);
  assert(`SR ${c.expect ? "TP" : "FP"}: ${c.why}`, r.violated === c.expect, c.msg);
}

// ─── 2. FALSE CONFIRMATION 60-char window ───────────────────────────────────
section("2. FalseConfirmation: 60-char window misses late confirmations");
const fc = byId.false_confirmation;
const fcCtx = { classification: "wrong_answer", lang: "es" };
const fcCases = [
  { msg: "Perfecto. Muy bien.",                                                     expect: true,  why: "opener" },
  { msg: "No es exactamente así. Vamos a repasar.",                                 expect: false, why: "negated FP" },
  { msg: "Eh, vamos a pensarlo. Has hecho un análisis interesante. Perfecto, ahora R1...", expect: true, why: "confirmation at char ~75 — likely MISSED" },
  { msg: "Vamos a pensar paso a paso, considerando la Ley de Ohm. Exactamente, así es como se calcula.", expect: true, why: "confirmation at char ~67 — likely MISSED" },
  { msg: "Sí, la corriente preferirá pasar por ese camino de baja resistencia.",    expect: true,  why: "opens with affirmative 'Sí'" },
];
for (const c of fcCases) {
  const r = fc.check(c.msg, fcCtx);
  assert(`FC ${c.expect ? "TP" : "FP"}: ${c.why}`, r.violated === c.expect, c.msg.slice(0, 80) + "...");
}

// ─── 3. ELEMENT NAMING surgicalFix bug ──────────────────────────────────────
section("3. ElementNaming.surgicalFix: redacts only correctAnswer elements");
const en = byId.element_naming;
const enCtx = { evaluableElements: ["R1","R2","R3","R4","R5"], correctAnswer: ["R1","R2","R4"], lang: "es" };
const tutorAsksAboutR3 = "¿Qué pasa con R3 en este circuito?";
const enCheck = en.check(tutorAsksAboutR3, enCtx);
assert("EN check fires on '¿Qué pasa con R3?'", enCheck.violated === true);
const enFix = en.surgicalFix(tutorAsksAboutR3, enCtx);
assert("EN.surgicalFix NOW redacts non-correctAnswer elements (C3 fix)",
  enFix && enFix.applied === true,
  "after: " + (enFix && enFix.text));

const tutorAsksAboutR1 = "¿Qué pasa con R1 en este circuito?";
const enFix2 = en.surgicalFix(tutorAsksAboutR1, enCtx);
assert("EN.surgicalFix DOES work when element IS in correctAnswer (R1)",
  enFix2 && enFix2.applied === true,
  "after: " + (enFix2 && enFix2.text));

// ─── 4. NEGATION DETECTOR window ─────────────────────────────────────────────
section("4. NegationDetector: pre-window length");
assert("'No es exactamente'   detected", isNegatedInContext("No es exactamente así", "exactamente") === true);
assert("'No es para nada exactamente' detected (long pre-negation)",
  isNegatedInContext("No es para nada exactamente correcto", "exactamente") === true,
  "if false: pre-window is too short to span 'no...para nada...exactamente'");
assert("'Tampoco es exactamente' detected",
  isNegatedInContext("Tampoco es exactamente así", "exactamente") === true);
assert("'Ni siquiera exactamente' detected",
  isNegatedInContext("Ni siquiera es exactamente así", "exactamente") === true);

// ─── 5. CLASSIFIER edge cases ────────────────────────────────────────────────
section("5. Classifier: edge cases that affect routing");
const correct = ["R1","R2","R4"];
const evalEl  = ["R1","R2","R3","R4","R5"];
const c1 = classifyQuery("hola", correct, evalEl);
assert("'hola' → greeting", c1.type === "greeting", "got: " + c1.type);
const c2 = classifyQuery("hola, ahora voy a pensar en R1 y R2", correct, evalEl);
assert("'hola, ahora voy a pensar en R1 y R2' is NOT swallowed as greeting (D1 fix)",
  c2.type !== "greeting", "got: " + c2.type);
const c3 = classifyQuery("r1 r2 r4 because they're in series", correct, evalEl);
assert("'r1 r2 r4 because they're in series' → correct_good_reasoning (BUG: 'series' triggers wrong-concept path)",
  c3.type === "correct_good_reasoning",
  "got: " + c3.type);
const c4 = classifyQuery("r1 r2 r4", correct, evalEl);
assert("'r1 r2 r4' → correct_no_reasoning", c4.type === "correct_no_reasoning", "got: " + c4.type);
const c5 = classifyQuery("ni idea", correct, evalEl);
assert("'ni idea' → dont_know", c5.type === "dont_know", "got: " + c5.type);
const c6 = classifyQuery("sí", correct, evalEl);
assert("'sí' → single_word (NOT confirmation)", c6.type === "single_word", "got: " + c6.type);

// ─── 6. ELEMENT_NAMING retry hint plagiarism ────────────────────────────────
section("6. ElementNaming retry hint contains a quotable example");
// C5: the retry hint must NOT always contain the same example phrase the LLM
// would otherwise plagiarize. We sample 6 invocations and confirm the example
// rotates (i.e. at least 2 distinct rendered hints across 6 samples).
const hintSamples = new Set();
for (let i = 0; i < 6; i++) hintSamples.add(en.buildRetryHint("es"));
assert("retry hint rotates examples across calls (C5 fix)",
  hintSamples.size >= 2,
  "got " + hintSamples.size + " distinct samples in 6 calls");

// ─── 7. STREAK/REPETITION DETECTION (CONTEXT AGENT) ──────────────────────────
section("7. ContextAgent question-similarity threshold");
const ContextAgent = require(path.join(ROOT, "src/domain/agents/contextAgent"));
const ca = new (class extends ContextAgent { constructor() {
  super({ ejercicioRepo: {}, interaccionRepo: {}, messageRepo: {}, config: {} });
}})();
const q1 = "¿qué condiciones se necesitan para que circule corriente por una rama del circuito?";
const q2 = "¿qué condiciones necesitas para que la corriente circule por una rama?";
const sim = ca._questionSimilarity(q1, q2);
assert("Two near-identical questions return high similarity (>0.5)", sim > 0.5, "sim=" + sim.toFixed(2));
const repeated = ca._detectRepetition([
  { content: q1 }, { content: q2 }, { content: q1 },
]);
assert("_detectRepetition fires on 3 same-ish questions", repeated === true);

// ─── 8. SAME-CLASSIFICATION STREAK (LOOP BREAKER, A) ─────────────────────────
async function section8() {
  section("8. ContextAgent._lastClassificationStreak + TutorAgent strategy hint");
  function fakeMsg(role, classification) {
    return {
      role, isAssistant: () => role === "assistant",
      metadata: classification ? { classification } : null,
    };
  }
  class StubRepo {
    constructor(msgs) { this.msgs = msgs; }
    async getAllMessages() { return this.msgs; }
  }
  async function streakCase(seq) {
    const stub = new StubRepo(seq);
    const agent = new (class extends ContextAgent { constructor() {
      super({ ejercicioRepo: {}, interaccionRepo: {}, messageRepo: stub, config: {} });
    }})();
    return agent._lastClassificationStreak("any");
  }

  const r1 = await streakCase([
    fakeMsg("user"), fakeMsg("assistant", "wrong_answer"),
    fakeMsg("user"), fakeMsg("assistant", "correct_no_reasoning"),
    fakeMsg("user"), fakeMsg("assistant", "correct_no_reasoning"),
    fakeMsg("user"), fakeMsg("assistant", "correct_no_reasoning"),
  ]);
  assert("streak: 3 consecutive correct_no_reasoning",
    r1.type === "correct_no_reasoning" && r1.streak === 3, JSON.stringify(r1));
  const r2 = await streakCase([
    fakeMsg("assistant", "wrong_answer"),
    fakeMsg("assistant", "correct_no_reasoning"),
  ]);
  assert("streak: classification change resets to 1",
    r2.type === "correct_no_reasoning" && r2.streak === 1, JSON.stringify(r2));
  const r3 = await streakCase([fakeMsg("user")]);
  assert("streak: empty assistant history returns 0",
    r3.type === null && r3.streak === 0, JSON.stringify(r3));

  // TutorAgent strategy hint logic
  const TutorAgent = require(path.join(ROOT, "src/domain/agents/tutorAgent"));
  const tStub = new (class extends TutorAgent { constructor() {
    super({ llmService: {}, buildSystemPrompt: () => "", config: {} });
  }})();
  assert("strategyHint fires for correct_no_reasoning streak>=2",
    tStub._buildStrategyHint("correct_no_reasoning", 2, "correct_no_reasoning").includes("ESCALATE"));
  assert("strategyHint silent for streak=1",
    tStub._buildStrategyHint("correct_no_reasoning", 1, "correct_no_reasoning") === "");
  assert("strategyHint silent if classification changed across turns",
    tStub._buildStrategyHint("correct_no_reasoning", 2, "wrong_answer") === "");
  assert("strategyHint fires for wrong_answer streak>=2",
    tStub._buildStrategyHint("wrong_answer", 3, "wrong_answer").includes("ESCALATE"));
  assert("strategyHint fires for dont_know streak>=2",
    tStub._buildStrategyHint("dont_know", 2, "dont_know").includes("ESCALATE"));
}

// ─── Summary ────────────────────────────────────────────────────────────────
(async function main() {
  await section8();

  const passed = results.filter(r => r.ok).length;
  const failed = results.length - passed;
  console.log("\n=== SUMMARY ===");
  console.log(passed + " passed / " + failed + " failed / " + results.length + " total");
  if (failed > 0) {
    console.log("\nFAILED (these are confirmed foci of error):");
    for (const r of results) if (!r.ok) console.log("  - " + r.name + (r.detail ? " :: " + r.detail : ""));
  }
  process.exit(failed > 0 ? 1 : 0);
})();
