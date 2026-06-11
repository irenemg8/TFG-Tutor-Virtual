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
  // BUG-G1 (2026-06-10): the LLM drops accents constantly. Accent-less state
  // reveals used to slip through (dictionary was accented, input only lowered).
  { msg: "R5 esta cortocircuitada en este circuito.",          expect: true,  why: "G1 accent-less -ada LEAK" },
  { msg: "R3 esta abierto, no influye.",                       expect: true,  why: "G1 accent-less abierto LEAK" },
];
for (const c of stateCases) {
  const r = sr.check(c.msg, ctxSR);
  assert(`SR ${c.expect ? "TP" : "FP"}: ${c.why}`, r.violated === c.expect, c.msg);
}

// ─── 2. FALSE CONFIRMATION: late-confirmation detection ──────────────────────
section("2. FalseConfirmation: detects confirmations in the response head");
const fc = byId.false_confirmation;
// The 60-char window is long fixed (the guardrail now scans up to the first
// "?" or 200 chars). Note: the guardrail only fires when the student actually
// named an element (ctx.mentionedElements non-empty) — otherwise a "sí" may be
// confirming a valid CONCEPTUAL observation, not a wrong final answer. These
// tutor strings are evaluated against a turn where the student named R5.
const fcCtx = { classification: "wrong_answer", lang: "es", mentionedElements: ["R5"] };
const fcCases = [
  { msg: "Perfecto. Muy bien.",                                                     expect: true,  why: "opener" },
  { msg: "No es exactamente así. Vamos a repasar.",                                 expect: false, why: "negated FP" },
  { msg: "Eh, vamos a pensarlo. Has hecho un análisis interesante. Perfecto, ahora R1...", expect: true, why: "confirmation at char ~75 — likely MISSED" },
  { msg: "Vamos a pensar paso a paso, considerando la Ley de Ohm. Exactamente, así es como se calcula.", expect: true, why: "confirmation at char ~67 — likely MISSED" },
  { msg: "Sí, la corriente preferirá pasar por ese camino de baja resistencia.",    expect: true,  why: "opens with affirmative 'Sí'" },
  // BUG-G2 (2026-06-10): a confirmation AFTER a leading rhetorical question used
  // to be missed (window was cut at the first "?"). Now we skip question
  // sentences instead of truncating at them.
  { msg: "¿Vamos a revisarlo? Exacto, R5 forma parte de la respuesta.",            expect: true,  why: "G2 confirmation after leading question" },
  // FP guard that MUST survive the G2 change: a confirmation word INSIDE a
  // Socratic question ("¿está claro?") is not a confirmation.
  { msg: "Vamos a revisar R5. ¿Está claro?",                                        expect: false, why: "G2 FP: 'claro' inside a question" },
];
for (const c of fcCases) {
  const r = fc.check(c.msg, fcCtx);
  assert(`FC ${c.expect ? "TP" : "FP"}: ${c.why}`, r.violated === c.expect, c.msg.slice(0, 80) + "...");
}

// ─── 2b. CompleteSolution + RepeatedQuestion guardrails ──────────────────────
section("2b. CompleteSolution case-norm (G3) + RepeatedQuestion symmetry (G4)");
const CompleteSolutionGuardrail = require(path.join(ROOT, "src/infrastructure/guardrails/CompleteSolutionGuardrail"));
const cs = new CompleteSolutionGuardrail();
// BUG-G3 (2026-06-10): membership was case-sensitive, so a lowercase proposed
// element ("r4") that IS in the correct answer was mis-read as wrongly-proposed.
const g3FP = cs.check("Perfecto, has acertado.", { correctAnswer: ["R1","R2","R4"], lang: "es", proposed: ["r4"], negated: [] });
assert("G3: lowercase proposed 'r4' (in answer) → NOT a violation", g3FP.violated === false, "got violated=" + g3FP.violated);
// Genuine wrong proposal must still fire (R3 is not in the answer).
const g3TP = cs.check("Perfecto, has acertado.", { correctAnswer: ["R1","R2","R4"], lang: "es", proposed: ["R3"], negated: [] });
assert("G3: genuinely wrong proposed 'R3' → still a violation", g3TP.violated === true, "got violated=" + g3TP.violated);

const RepeatedQuestionGuardrail = require(path.join(ROOT, "src/infrastructure/guardrails/RepeatedQuestionGuardrail"));
// BUG-G4 (2026-06-10): asymmetric min(len) denominator scored a short subset
// question as a perfect repeat of a long unrelated one.
const g4FP = RepeatedQuestionGuardrail._similarity(
  "¿Qué resistencias importan?",
  "¿Qué pasa con las resistencias que importan cuando el interruptor esta abierto y la corriente busca otro camino?");
assert("G4: short-subset vs long question → below 0.7 threshold", g4FP < 0.7, "got sim=" + g4FP.toFixed(2));
// A genuine near-identical repeat must still score high.
const g4TP = RepeatedQuestionGuardrail._similarity(
  "¿Por qué circula corriente por esa rama?",
  "¿Por qué circula corriente por esta rama?");
assert("G4: genuine repeat still scores >= 0.7", g4TP >= 0.7, "got sim=" + g4TP.toFixed(2));

// ─── 2c. Surgical-fix repairs (S1-S4) ───────────────────────────────────────
section("2c. Surgical fixes: accent-fold redact (S1), idioms (S2), gender (S3), spacing (S4)");
const gr = require(path.join(ROOT, "src/domain/services/rag/guardrails"));

// BUG-S1 (2026-06-10): the StateReveal surgical fix located the leaking
// sentence accent-sensitively, so an accent-less reveal was DETECTED by check()
// (after G1) but the redactor couldn't find it → leak passed through verbatim.
const s1 = byId.state_reveal.surgicalFix(
  "R5 esta cortocircuitada, asi que no influye. Piensa en el resto.",
  { evaluableElements: ["R1","R2","R3","R4","R5"], lang: "es", messages: [] });
assert("S1: accent-less state reveal IS redacted (not passed through)",
  s1.applied === true && !/cortocircuitada/i.test(s1.text),
  "applied=" + s1.applied + " text=" + JSON.stringify(s1.text).slice(0, 80));

// BUG-S2 (2026-06-10): "claro"/"justo" open idioms; stripping just the word
// decapitated the sentence ("Claro está que…" → "Está que…").
assert("S2: idiom 'Claro está que…' is NOT decapitated",
  gr.removeOpeningConfirmation("Claro está que R5 no va.", "es") === "Claro está que R5 no va.",
  "got: " + gr.removeOpeningConfirmation("Claro está que R5 no va.", "es"));
assert("S2: idiom 'Justo por eso…' is NOT decapitated",
  gr.removeOpeningConfirmation("Justo por eso R5 importa.", "es") === "Justo por eso R5 importa.",
  "got: " + gr.removeOpeningConfirmation("Justo por eso R5 importa.", "es"));
// Controls: real confirmations delimited by punctuation MUST still strip.
assert("S2 control: 'Claro, R5 no va.' still strips 'Claro'",
  gr.removeOpeningConfirmation("Claro, R5 no va.", "es") === "R5 no va.",
  "got: " + gr.removeOpeningConfirmation("Claro, R5 no va.", "es"));
assert("S2 control: 'Claro que sí, R5 va.' still strips the multiword confirm",
  gr.removeOpeningConfirmation("Claro que sí, R5 va.", "es") === "R5 va.",
  "got: " + gr.removeOpeningConfirmation("Claro que sí, R5 va.", "es"));

// BUG-S5 (2026-06-10): removeOpeningConfirmation ate the opening "¿"/"¡" of the
// FOLLOWING Spanish sentence ("Exacto. ¿Qué pasa?" → "Qué pasa?"), producing a
// malformed question. The opener must survive (and the word after it capitalised).
assert("S5: opening '¿' of the following question is preserved",
  gr.removeOpeningConfirmation("Exacto. ¿Qué pasa con R3?", "es") === "¿Qué pasa con R3?",
  "got: " + gr.removeOpeningConfirmation("Exacto. ¿Qué pasa con R3?", "es"));
assert("S5: opening '¡' is preserved too",
  gr.removeOpeningConfirmation("Perfecto. ¡Cuidado con R5!", "es") === "¡Cuidado con R5!",
  "got: " + gr.removeOpeningConfirmation("Perfecto. ¡Cuidado con R5!", "es"));

// BUG-S3 (2026-06-10): masculine placeholder + inherited feminine predicate.
const s3 = gr.redactElementMentions("¿Por qué R1, R2 y R4 son las correctas?", ["R1","R2","R4"], "es").text;
assert("S3: no gender clash ('esos elementos … son los correctos')",
  /esos\s+elementos/i.test(s3) && /los\s+correctos/i.test(s3) && !/las\s+correctas/i.test(s3),
  "got: " + JSON.stringify(s3));

// BUG-S4 (2026-06-10): the untouched tail lost its inter-sentence spaces.
const s4 = gr.redactStateRevealSentence(
  "Buen avance aqui. R5 está cortocircuitada. Ahora dime que ocurre en la otra rama. Sigue pensando bien.",
  ["R1","R5"], "está cortocircuitad", "es", 0).text;
assert("S4: no glued sentences in the untouched tail (no 'rama.Sigue')",
  !/[a-zñáéíóú][.!?][A-ZÁÉÍÓÚÑ]/.test(s4),
  "got: " + JSON.stringify(s4).slice(0, 120));

// ─── 2d. SolutionLeak accents (SL) + Adherence tag-questions (AD) + ORC ──────
section("2d. SolutionLeak accent-fold (SL), Adherence tag-questions (AD), orchestrator 1b (ORC)");
const SolutionLeakGuardrail = require(path.join(ROOT, "src/infrastructure/guardrails/SolutionLeakGuardrail"));
const sl = byId.solution_leak;
// BUG-SL (2026-06-10): the guardrail compared raw-lowercased text against
// accented dictionaries/regexes, so accent-less reveals (and the whole Valencian
// set) slipped through. Now folded on both sides.
assert("SL: accent-less semantic leak detected ('Asi es, esos elementos contribuyen.')",
  SolutionLeakGuardrail.looksLikeSemanticAffirmation("Asi es, esos elementos contribuyen.") === true);
assert("SL: accent-less reveal phrase detected ('La solucion es R1.')",
  sl.check("La solucion es R1.", { correctAnswer: ["R1"], lang: "es" }).violated === true);
assert("SL: Valencian accent-less reveal detected ('La resposta es R2.')",
  sl.check("La resposta es R2.", { correctAnswer: ["R2"], lang: "val" }).violated === true);
// Controls: a pure Socratic question must NOT be flagged.
assert("SL control: Socratic question is not a leak",
  sl.check("¿Qué pasa con la corriente en R1?", { correctAnswer: ["R1"], lang: "es" }).violated === false);

const adg = byId.adherence;
// BUG-AD (2026-06-10): a rhetorical tag-question ("¿verdad?") + the real
// Socratic question used to count as 2 and trip the multi-question rule, and
// surgicalFix truncated to the throwaway tag.
assert("AD: tag-question + 1 real question → NOT a multi-question violation",
  adg.check("Eso tiene lógica, ¿verdad? Ahora, ¿qué pasa cuando el interruptor se abre?", { lang: "es" }).violated === false);
// Two genuine questions still fire, and the fix keeps the first SUBSTANTIVE one.
const adFix = adg.surgicalFix("¿Qué nodo conecta R1? ¿Y qué pasa con R2 cuando el switch abre?", { lang: "es" });
assert("AD: two real questions → fix keeps the first substantive question",
  adFix.applied === true && /R1/.test(adFix.text) && !/R2/.test(adFix.text),
  "got: " + JSON.stringify(adFix.text));

// BUG-ORC (2026-06-10): _normaliseWhitespace 1b split before any uppercase;
// now only before openers / Title-case word starts (concat errors), not
// acronym runs.
const orch = Object.create(require(path.join(ROOT, "src/domain/agents/orchestrator")).prototype);
function _nw(s) { const c = { finalResponse: s }; orch._normaliseWhitespace(c); return c.finalResponse; }
assert("ORC: still splits real concat error 'identificarAhora'",
  _nw("Debes identificarAhora el nodo") === "Debes identificar Ahora el nodo",
  "got: " + _nw("Debes identificarAhora el nodo"));
assert("ORC: no longer splits acronym glue 'voltajeDC'",
  _nw("mide el voltajeDC ahora") === "mide el voltajeDC ahora",
  "got: " + _nw("mide el voltajeDC ahora"));
assert("ORC: leaves legitimate text untouched ('la Ley de Ohm')",
  _nw("Aplica la Ley de Ohm aqui") === "Aplica la Ley de Ohm aqui",
  "got: " + _nw("Aplica la Ley de Ohm aqui"));

// ─── 2e. languageManager + ragPipeline (LM1-LM4) ────────────────────────────
section("2e. normalizeToSpanish (LM1), polite switch (LM2), per-element case (LM3), stopwords (LM4)");
const lmgr = require(path.join(ROOT, "src/domain/services/languageManager"));
// BUG-LM1 (2026-06-10): "tensió" (Valencian) is a prefix of its Spanish value
// "tensión", so the substring replace corrupted already-Spanish text.
assert("LM1: normalizeToSpanish('divisor de tensión') is NOT corrupted",
  lmgr.normalizeToSpanish("divisor de tensión") === "divisor de tensión",
  "got: " + lmgr.normalizeToSpanish("divisor de tensión"));
assert("LM1: Valencian 'divisor de tensió' → 'divisor de tensión' (single n)",
  lmgr.normalizeToSpanish("divisor de tensió") === "divisor de tensión",
  "got: " + lmgr.normalizeToSpanish("divisor de tensió"));

// BUG-LM2 (2026-06-10): polite apologies blocked a genuine language switch.
assert("LM2: 'sorry, can we continue in english' → switch to 'en'",
  lmgr.detectLanguageSwitch("sorry, can we continue in english") === "en",
  "got: " + lmgr.detectLanguageSwitch("sorry, can we continue in english"));
assert("LM2 control: 'lo siento, no entiendo nada en english' → still null (real negation)",
  lmgr.detectLanguageSwitch("lo siento, no entiendo nada en english please") === null,
  "got: " + lmgr.detectLanguageSwitch("lo siento, no entiendo nada en english please"));

// BUG-LM3 (2026-06-10): per-element analysis was case-sensitive vs correctAnswer.
const { analyzeStudentElements } = require(path.join(ROOT, "src/domain/services/rag/ragPipeline"));
const lm3 = analyzeStudentElements({ proposed: ["R1","R3"], negated: ["R2"] }, ["r1","r2","r4"]);
assert("LM3: lowercase correctAnswer → R1 still CORRECT, R2 still WRONG REJECTION",
  /CORRECT PROPOSALS: R1\b/.test(lm3) && /WRONG REJECTION/.test(lm3) && /WRONG PROPOSALS: R3\b/.test(lm3),
  "banner: " + JSON.stringify(lm3.replace(/\n/g, " ")).slice(0, 160));

// BUG-LM4 (2026-06-10): multi-word Valencian stopwords were dead (tokenizer
// splits on whitespace).
assert("LM4: no multi-word Valencian stopwords remain",
  lmgr.HEURISTIC_STOPWORDS.val.filter((w) => w.includes(" ")).length === 0,
  "got: " + JSON.stringify(lmgr.HEURISTIC_STOPWORDS.val.filter((w) => w.includes(" "))));

// ─── 3. ELEMENT NAMING (retired) ─────────────────────────────────────────────
// ElementNamingGuardrail was retired in NS-32 (2026-05-03) and its file
// deleted — the tutor may now say "Resistencia R1" verbatim. The old section 3
// dereferenced byId.element_naming (now undefined) and crashed the whole suite
// before sections 4-7 could run. Removed. The still-live ElementNaming retry
// HINT (languageManager.getElementNamingInstruction) is a different thing and
// is covered by section 6 below.

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
// INTENTIONAL (decidido 2026-06-01): respuesta correcta + un keyword de
// concepto (serie/paralelo/divisor…) → correct_wrong_reasoning para que el
// RAG/KG verifique si el concepto está bien aplicado ANTES de confirmar. No es
// un bug: descripciones de ESTADO (abierto/cortocircuito) sí se aceptan como
// buen razonamiento, pero los conceptos topológicos pueden estar mal aplicados
// (p.ej. "en paralelo" siendo serie), así que se enrutan a verificación.
const c3 = classifyQuery("r1 r2 r4 because they're in series", correct, evalEl);
assert("correct answer + concept keyword 'series' → correct_wrong_reasoning (KG verification, intentional)",
  c3.type === "correct_wrong_reasoning",
  "got: " + c3.type);
const c4 = classifyQuery("r1 r2 r4", correct, evalEl);
assert("'r1 r2 r4' → correct_no_reasoning", c4.type === "correct_no_reasoning", "got: " + c4.type);
const c5 = classifyQuery("ni idea", correct, evalEl);
assert("'ni idea' → dont_know", c5.type === "dont_know", "got: " + c5.type);
// 'sí' without any tutor question context → wrong_answer (nothing concrete to evaluate).
// The legacy classifier mapped this to "single_word"; that bucket has been removed —
// short non-elements without context are treated as wrong_answer so the tutor demands
// the student rephrase or elaborate.
const c6 = classifyQuery("sí", correct, evalEl);
assert("'sí' (no tutor context) → wrong_answer", c6.type === "wrong_answer", "got: " + c6.type);
// 'sí' answering a CLOSED diagnostic question → closed_answer (don't escalate).
const c6b = classifyQuery("sí", correct, evalEl, "Vale, ¿tienes alguna duda sobre el circuito?");
assert("'sí' replying to '¿tienes dudas?' → closed_answer", c6b.type === "closed_answer", "got: " + c6b.type);
// 'sí' answering a CLOSED reasoning question about an element NOT in the
// correct answer. BUG-006 (2026-05-03): "¿Es R3 ... conduce corriente?" + "sí"
// affirms R3, but R3 is not in the correct answer → wrong_concept (so the LLM
// can't falsely confirm it). The pre-BUG-006 behaviour was correct_no_reasoning.
const c6c = classifyQuery("sí", correct, evalEl, "¿Es R3 una resistencia que conduce corriente?");
assert("'sí' affirming an element NOT in the answer → wrong_concept (BUG-006)",
  c6c.type === "wrong_concept", "got: " + c6c.type);

// Negation attached to a LATER restatement of the same element (req5 in prod).
// The element appears twice; the first mention is neutral, the second carries
// "no influye". Before the multi-occurrence fix this was misread as
// proposed=[R3] and the tutor contradicted a correct student → repeated loop.
const c7msg = "El interruptor abierto impide el paso de la corriente por R3, por lo que R3 no influye en el valor de tensión entre N2 y 0";
const c7 = classifyQuery(c7msg, correct, evalEl);
assert("restated-negation 'R3 ... R3 no influye' → R3 negated, not proposed",
  c7.negated.indexOf("R3") >= 0 && c7.proposed.indexOf("R3") < 0,
  "got proposed=[" + c7.proposed.join(",") + "] negated=[" + c7.negated.join(",") + "]");
assert("restated-negation 'R3 no influye' (R3 not in correct) → partial_correct",
  c7.type === "partial_correct", "got: " + c7.type);

// Block A — accent-insensitive negation. Students drop accents constantly.
// "esta abierto" (no tilde) must negate R3 just like "está abierto".
const cAccent = classifyQuery("R1 R2 R4 porque R3 esta abierto y R5 cortocircuitada", correct, evalEl);
assert("accent-less 'R3 esta abierto' → R3 & R5 negated",
  cAccent.negated.indexOf("R3") >= 0 && cAccent.negated.indexOf("R5") >= 0,
  "got negated=[" + cAccent.negated.join(",") + "]");

// Block B — set quantifiers.
const quAll = classifyQuery("todas las resistencias", correct, evalEl);
assert("'todas las resistencias' → proposes the full evaluable set",
  quAll.proposed.length === evalEl.length, "got P=[" + quAll.proposed.join(",") + "]");
const quExcept = classifyQuery("todas menos R3", correct, evalEl);
assert("'todas menos R3' → R3 negated, rest proposed",
  quExcept.negated.indexOf("R3") >= 0 && quExcept.proposed.indexOf("R3") < 0 && quExcept.proposed.length === 4,
  "got P=[" + quExcept.proposed.join(",") + "] N=[" + quExcept.negated.join(",") + "]");
const quCorrect = classifyQuery("todas menos R3 y R5", correct, evalEl);
assert("'todas menos R3 y R5' equals the correct answer → correct_no_reasoning",
  quCorrect.type === "correct_no_reasoning", "got: " + quCorrect.type + " P=[" + quCorrect.proposed.join(",") + "]");
const quRest = classifyQuery("R3 no influye, el resto si", correct, evalEl);
assert("'R3 no influye, el resto si' → R3 negated, rest proposed (post-only polarity)",
  quRest.negated.indexOf("R3") >= 0 && quRest.proposed.indexOf("R3") < 0 && quRest.proposed.length === 4,
  "got P=[" + quRest.proposed.join(",") + "] N=[" + quRest.negated.join(",") + "]");
// Idiom guard — "de todos modos" must NOT be read as the quantifier "todos".
const quIdiom = classifyQuery("de todos modos no lo se", correct, evalEl);
assert("'de todos modos no lo se' is NOT expanded (idiom guard) → dont_know",
  quIdiom.type === "dont_know" && quIdiom.proposed.length === 0,
  "got: " + quIdiom.type + " P=[" + quIdiom.proposed.join(",") + "]");

// Block C — H6 (2026-06-10): verbose yes/no answers to a CLOSED tutor question.
// The length<15 gate used to send these to wrong_answer; a yes/no reply to a
// closed question is valid however long it is.
const dudasQ = "Vale, ¿tienes alguna duda sobre el circuito?";
const h6a = classifyQuery("sí, lo tengo claro", correct, evalEl, dudasQ);
assert("H6: verbose 'sí, lo tengo claro' to '¿tienes dudas?' → closed_answer",
  h6a.type === "closed_answer", "got: " + h6a.type);
// The nasty one: "ninguna duda" used to trip the NONE quantifier and negate
// ALL five elements. The idiom guard must stop that, and the answer is a valid
// closed reply.
const h6b = classifyQuery("no, ninguna duda", correct, evalEl, dudasQ);
assert("H6: 'no, ninguna duda' → closed_answer, NOT all elements negated",
  h6b.type === "closed_answer" && h6b.negated.length === 0,
  "got: " + h6b.type + " N=[" + h6b.negated.join(",") + "]");
// Regression guard: the REAL set-quantifier "ninguna" must still negate the
// whole evaluable set when it genuinely refers to the resistances.
const h6c = classifyQuery("ninguna resistencia", correct, evalEl);
assert("H6 guard does NOT break real 'ninguna resistencia' → all negated",
  h6c.negated.length === evalEl.length, "got N=[" + h6c.negated.join(",") + "]");

// Block D — H5 (2026-06-10): postfix polarity markers "X no" / "X sí". A bare
// "no" after an element used to (a) NOT negate that element, and (b) bleed into
// the next element's pre-window. The comma is the disambiguator: "R1 no, R2"
// rejects R1; "R1, no R2" rejects R2.
const h5a = classifyQuery("R1 no, R2 sí", correct, evalEl);
assert("H5: 'R1 no, R2 sí' → R1 negated, R2 proposed (not inverted)",
  h5a.negated.indexOf("R1") >= 0 && h5a.proposed.indexOf("R2") >= 0 &&
  h5a.negated.indexOf("R2") < 0 && h5a.proposed.indexOf("R1") < 0,
  "got P=[" + h5a.proposed.join(",") + "] N=[" + h5a.negated.join(",") + "]");
const h5b = classifyQuery("R4 sí, R5 no", correct, evalEl);
assert("H5: 'R4 sí, R5 no' → R4 proposed, R5 negated",
  h5b.proposed.indexOf("R4") >= 0 && h5b.negated.indexOf("R5") >= 0 &&
  h5b.proposed.indexOf("R5") < 0,
  "got P=[" + h5b.proposed.join(",") + "] N=[" + h5b.negated.join(",") + "]");
// Disambiguation: comma BEFORE "no" → the "no" opens the next clause.
const h5c = classifyQuery("R1, no R2", correct, evalEl);
assert("H5: 'R1, no R2' → R1 proposed, R2 negated (comma before 'no')",
  h5c.proposed.indexOf("R1") >= 0 && h5c.negated.indexOf("R2") >= 0,
  "got P=[" + h5c.proposed.join(",") + "] N=[" + h5c.negated.join(",") + "]");
// Regression guard: pre-negation WITHOUT a comma must still negate.
const h5d = classifyQuery("R1 R2 pero no R3", correct, evalEl);
assert("H5 guard does NOT break comma-less pre-negation 'pero no R3'",
  h5d.negated.indexOf("R3") >= 0 && h5d.proposed.indexOf("R3") < 0,
  "got P=[" + h5d.proposed.join(",") + "] N=[" + h5d.negated.join(",") + "]");

// Block E — H1 (2026-06-10): STICKY NEGATION. If any occurrence of an element
// is negated, the element is negated (replaces the previous "last mention
// wins" rule). Fixes the common restate-to-explain pattern where the negated
// element is mentioned again, neutrally, to justify the rejection.
const h1a = classifyQuery("R3 no influye, pero R3 tiene resistencia alta", correct, evalEl);
assert("H1: 'R3 no influye, pero R3 …' → R3 NEGATED (not proposed by last-wins)",
  h1a.negated.indexOf("R3") >= 0 && h1a.proposed.indexOf("R3") < 0,
  "got P=[" + h1a.proposed.join(",") + "] N=[" + h1a.negated.join(",") + "]");
// The case last-wins was originally introduced for must still work under sticky.
const h1b = classifyQuery("pasa corriente por R3, por lo que R3 no influye", correct, evalEl);
assert("H1: restated-negation 'por R3 … R3 no influye' still → R3 negated",
  h1b.negated.indexOf("R3") >= 0 && h1b.proposed.indexOf("R3") < 0,
  "got P=[" + h1b.proposed.join(",") + "] N=[" + h1b.negated.join(",") + "]");

// Block F — adversarial re-sweep of our own fixes (2026-06-10).
// ADV1: bare quantifier tokens must NOT expand on element-free idioms.
const adv1a = classifyQuery("he probado todas las opciones", correct, evalEl);
assert("ADV1: 'todas las opciones' (idiom, no element) → no expansion",
  adv1a.proposed.length === 0 && adv1a.negated.length === 0,
  "got P=[" + adv1a.proposed.join(",") + "] N=[" + adv1a.negated.join(",") + "]");
const adv1b = classifyQuery("ninguno de estos R me convence", correct, evalEl);
assert("ADV1: 'ninguno de estos' (idiom) → does NOT negate the whole set",
  adv1b.negated.length === 0,
  "got N=[" + adv1b.negated.join(",") + "]");
const adv1c = classifyQuery("todos los caminos llevan a R1", correct, evalEl);
assert("ADV1: 'todos los caminos…R1' → only R1, not the full set",
  adv1c.proposed.length === 1 && adv1c.proposed[0] === "R1",
  "got P=[" + adv1c.proposed.join(",") + "]");
// ADV1 guard: legitimate quantifiers still expand.
const adv1d = classifyQuery("todas las resistencias", correct, evalEl);
assert("ADV1 guard: 'todas las resistencias' still expands to full set",
  adv1d.proposed.length === evalEl.length, "got P=[" + adv1d.proposed.join(",") + "]");
const adv1e = classifyQuery("todos los elementos contribuyen", correct, evalEl);
assert("ADV1 guard: 'todos los elementos' (circuit noun) still expands",
  adv1e.proposed.length === evalEl.length, "got P=[" + adv1e.proposed.join(",") + "]");

// ADV2: H1 sticky negation must not absorb a "no" from a PREVIOUS sentence.
const adv2 = classifyQuery("R3 no influye. R1 si va. Ademas R1 es fundamental para todo", correct, evalEl);
assert("ADV2: cross-sentence 'no' does NOT negate R1 (sentence-bounded pre-window)",
  adv2.negated.indexOf("R1") < 0 && adv2.negated.indexOf("R3") >= 0,
  "got P=[" + adv2.proposed.join(",") + "] N=[" + adv2.negated.join(",") + "]");

// ADV3: a standalone "¿Claro?" question must not be reduced to a headless "?".
assert("ADV3: '¿Claro? Piensa en R5.' keeps the question (not '? Piensa…')",
  gr.removeOpeningConfirmation("¿Claro? Piensa en R5.", "es") === "¿Claro? Piensa en R5.",
  "got: " + gr.removeOpeningConfirmation("¿Claro? Piensa en R5.", "es"));

// Block F2 — focused adversarial pass over the Block-F fixes themselves.
// ADV1b: an ADJECTIVE containing "resist"/"element" ("elemental", "resistente")
// must NOT anchor a bare quantifier (whole-noun anchor, not substring).
const f2a = classifyQuery("muy elemental todo, todas", correct, evalEl);
assert("ADV1b: adjective 'elemental' does NOT anchor 'todas' → no expansion",
  f2a.proposed.length === 0 && f2a.negated.length === 0,
  "got P=[" + f2a.proposed.join(",") + "] N=[" + f2a.negated.join(",") + "]");
const f2b = classifyQuery("todas las elementales, R1", correct, evalEl);
assert("ADV1b: 'todas las elementales' (adjective noun) → only R1, not full set",
  f2b.proposed.length === 1 && f2b.proposed[0] === "R1",
  "got P=[" + f2b.proposed.join(",") + "]");
// ADV2b: an ellipsis ("...") must not be read as a sentence break that drops a
// real negation phrase ("no es... R3" must still negate R3).
const f2c = classifyQuery("no es... R3", correct, evalEl);
assert("ADV2b: ellipsis does not break 'no es… R3' negation",
  f2c.negated.indexOf("R3") >= 0, "got N=[" + f2c.negated.join(",") + "]");
const f2d = classifyQuery("R1 si. no R3", correct, evalEl);
assert("ADV2b guard: a real sentence break still bounds the window ('R1 si. no R3' → R3 negated)",
  f2d.negated.indexOf("R3") >= 0 && f2d.negated.indexOf("R1") < 0,
  "got P=[" + f2d.proposed.join(",") + "] N=[" + f2d.negated.join(",") + "]");
// ADV3b: an OPENING "¡Claro!" before real content IS a confirmation → strip it
// (the "!" is consumed cleanly); a standalone "¡Claro!" survives.
assert("ADV3b: '¡Claro! R5 no influye' → strips the opening confirmation",
  gr.removeOpeningConfirmation("¡Claro! R5 no influye, piensa", "es") === "R5 no influye, piensa",
  "got: " + gr.removeOpeningConfirmation("¡Claro! R5 no influye, piensa", "es"));
assert("ADV3b guard: standalone '¡Claro!' survives",
  gr.removeOpeningConfirmation("¡Claro!", "es") === "¡Claro!",
  "got: " + gr.removeOpeningConfirmation("¡Claro!", "es"));

// Block G — real-server run (2026-06-10). Flow-negation over a LIST of elements.
// Production failure: "no deja pasar la corriente por r3 r4 ni r5" classified
// R3/R4 as proposed (only R5 negated), tangling the whole conversation.
const g1 = classifyQuery("Que no deja pasar la corriente por r3 r4 ni r5", correct, evalEl);
assert("G(run): 'no deja pasar la corriente por r3 r4 ni r5' → R3,R4,R5 ALL negated",
  ["R3","R4","R5"].every((x) => g1.negated.indexOf(x) >= 0) && g1.proposed.length === 0,
  "got P=[" + g1.proposed.join(",") + "] N=[" + g1.negated.join(",") + "]");
const g2 = classifyQuery("no pasa corriente por R3, R4 y R5", correct, evalEl);
assert("G(run): flow-negation over a comma list negates the WHOLE list",
  ["R3","R4","R5"].every((x) => g2.negated.indexOf(x) >= 0),
  "got N=[" + g2.negated.join(",") + "]");
// Contrastive connector bounds the flow span: "…por R3 pero R4 sí" → R4 positive.
const g3 = classifyQuery("no pasa corriente por R3 pero R4 si", correct, evalEl);
assert("G(run): contrast 'pero R4 sí' keeps R4 proposed, R3 negated",
  g3.negated.indexOf("R3") >= 0 && g3.proposed.indexOf("R4") >= 0 && g3.negated.indexOf("R4") < 0,
  "got P=[" + g3.proposed.join(",") + "] N=[" + g3.negated.join(",") + "]");
// "ningún momento" is a temporal idiom, not the NONE quantifier.
const g4 = classifyQuery("No he dicho en ningún momento que r4 influya", correct, evalEl);
assert("G(run): 'en ningún momento' does NOT negate the whole set",
  g4.negated.length === 0,
  "got N=[" + g4.negated.join(",") + "]");

// C (run req9): the student asking the tutor to EXPLAIN a concept is detected,
// so tutorAgent can answer the concept instead of restarting the scaffold.
const { isExplanationRequest } = require(path.join(ROOT, "src/domain/services/rag/queryClassifier"));
assert("C(run): 'puedes explicarme el concepto de divisor de tensión?' → explanation request",
  isExplanationRequest("puedes explicarme el concepto de divisor de tensión?") === true);
assert("C(run): 'No entiendo el concepto de divisor de tensión' → explanation request",
  isExplanationRequest("No entiendo el concepto de divisor de tensión") === true);
assert("C(run) guard: a plain element answer is NOT an explanation request",
  isExplanationRequest("Sí, de R1 y R2") === false &&
  isExplanationRequest("ni idea") === false);

// ─── Block H — 2nd real-server run (2026-06-10) ──────────────────────────────
section("H. Run-2: false-premise question guardrail (T1) + topology/flow leaks");
const adh = byId.adherence;
const tctx = { lang: "es", correctAnswer: ["R1","R2","R4"] };
// T1: a question presupposing a CORRECT element is irrelevant must be caught
// deterministically (the system-prompt rule alone did not stop qwen2.5).
assert("H/T1: '¿por qué R4 no influye?' (R4 correct) → adherence violation",
  adh.check("R1 y R2 son resistencias. ¿Por qué crees que R4 no influye en la tensión?", tctx).violated === true);
assert("H/T1: false premise survives an intervening relative clause (R2)",
  adh.check("¿Por qué R2, que está conectada entre N2 y tierra, no influye en la tensión?", tctx).violated === true);
assert("H/T1 guard: '¿por qué R3 no influye?' (R3 NOT correct) → no violation",
  adh.check("¿Por qué pensaste que R3 también influía en la tensión?", tctx).violated === false);
assert("H/T1 guard: 'R4 importa pero R3 no influye' does not false-fire on R4",
  adh.check("¿Por qué R4 importa pero R3 no influye?", tctx).violated === false);

const srg = byId.state_reveal;
const sctx = { evaluableElements: ["R1","R2","R3","R4","R5"], kgConceptPatterns: [], lang: "es", messages: [] };
// Topology assertion leaks (fire even inside a question).
assert("H/topo: 'R4 conectada en paralelo con R2' → state_reveal",
  srg.check("R4 está conectada en paralelo con R2 entre N2 y tierra.", sctx).violated === true);
assert("H/topo: topology assertion inside a question still leaks",
  srg.check("¿Te das cuenta de que R4 está conectada en paralelo con R2?", sctx).violated === true);
// Current-path reveal (affirmation), even with intervening text.
assert("H/flow: 'la corriente … pasa por R2 y R4' → state_reveal",
  srg.check("La corriente desde N2 hacia tierra pasa por R2 y R4.", sctx).violated === true);
// Guards: a probing flow QUESTION and a NEGATED flow are not leaks.
assert("H/flow guard: '¿pasa la corriente por R2?' is a legitimate question",
  srg.check("¿Pasa la corriente por R2 hacia tierra?", sctx).violated === false);
assert("H/flow guard: 'la corriente no pasa por R3' (correct exclusion) is not a leak",
  srg.check("La corriente no pasa por R3, está bien excluida.", sctx).violated === false);

// ─── 6. ELEMENT_NAMING retry hint plagiarism ────────────────────────────────
section("6. ElementNaming retry hint contains a quotable example");
// C5: the retry hint must NOT always contain the same example phrase the LLM
// would otherwise plagiarize. We sample 6 invocations and confirm the example
// rotates (i.e. at least 2 distinct rendered hints across 6 samples).
// NOTE: the ElementNamingGuardrail was retired (NS-32), but the retry HINT it
// used to build now lives in languageManager.getElementNamingInstruction, which
// rotates examples via _pickConceptExample. We test that live function.
const { getElementNamingInstruction } = require(path.join(ROOT, "src/domain/services/languageManager"));
const hintSamples = new Set();
for (let i = 0; i < 6; i++) hintSamples.add(getElementNamingInstruction("es"));
assert("retry hint rotates examples across calls (C5 fix)",
  hintSamples.size >= 2,
  "got " + hintSamples.size + " distinct samples in 6 calls");

// ─── 7. STREAK/REPETITION DETECTION (CONTEXT AGENT) ──────────────────────────
section("7. ContextAgent question-similarity threshold");
const ContextAgent = require(path.join(ROOT, "src/domain/agents/contextAgent"));
const ca = new (class extends ContextAgent { constructor() {
  // historySummarizer became a required dep after this test was written; the
  // methods exercised here (_questionSimilarity, _detectRepetition) don't use
  // it, so an empty stub satisfies the constructor guard.
  super({ ejercicioRepo: {}, interaccionRepo: {}, messageRepo: {}, config: {}, historySummarizer: {} });
}})();
const q1 = "¿qué condiciones se necesitan para que circule corriente por una rama del circuito?";
const q2 = "¿qué condiciones necesitas para que la corriente circule por una rama?";
const sim = ca._questionSimilarity(q1, q2);
assert("Two near-identical questions return high similarity (>0.5)", sim > 0.5, "sim=" + sim.toFixed(2));
const repeated = ca._detectRepetition([
  { content: q1 }, { content: q2 }, { content: q1 },
]);
assert("_detectRepetition fires on 3 same-ish questions", repeated === true);

// BUG-A2 (2026-06-10): same asymmetry as guardrail G4, but in contextAgent. A
// short question that is a lexical subset of a longer, unrelated one used to
// score high and raise a spurious [ANTI-LOOP] banner.
const a2short = "¿qué resistencias importan aquí?";
const a2long = "¿qué resistencias importan aquí cuando el interruptor esta abierto y la corriente busca otro camino?";
assert("A2: similarity is symmetric (subset vs superset)",
  ca._questionSimilarity(a2short, a2long) === ca._questionSimilarity(a2long, a2short),
  "sim(s,l)=" + ca._questionSimilarity(a2short, a2long).toFixed(2) + " sim(l,s)=" + ca._questionSimilarity(a2long, a2short).toFixed(2));
assert("A2: short-subset vs long unrelated → NOT flagged as repetition",
  ca._detectRepetition([{ content: a2short }, { content: a2long }]) === false,
  "got: " + ca._detectRepetition([{ content: a2short }, { content: a2long }]));

// BUG-A3 (2026-06-10): _detectStuckOnElement only scanned each message's LAST
// interrogative fragment, so an Rn obsessed over across turns was undercounted
// when a later sentence asked about a different element.
const a3msgs = [
  { content: "¿R1 no conduce corriente en esa rama?" },
  { content: "¿Qué nodo conecta R1 con el resto? ¿Y qué opinas de R2?" },
];
assert("A3: stuck-on-element counts Rn across ALL question fragments → R1",
  ca._detectStuckOnElement(a3msgs) === "R1", "got: " + ca._detectStuckOnElement(a3msgs));
assert("A3 control: different elements per turn → not stuck (null)",
  ca._detectStuckOnElement([{ content: "¿Y R1?" }, { content: "¿Y R2?" }]) === null,
  "got: " + ca._detectStuckOnElement([{ content: "¿Y R1?" }, { content: "¿Y R2?" }]));

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
      super({ ejercicioRepo: {}, interaccionRepo: {}, messageRepo: stub, config: {}, historySummarizer: {} });
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
    // debugLogger became a required dep after this test was written;
    // _buildStrategyHint (the only method exercised) doesn't use it.
    super({ llmService: {}, buildSystemPrompt: () => "", config: {}, debugLogger: {} });
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

  // BUG-A1 (2026-06-10): the verdict banner gate required proposed.length>0, so
  // an "only_negation" turn (student wrongly rejected a correct element) dropped
  // the whole banner — the LLM never learned of the wrong rejection. The gate
  // now also fires on wronglyNegated. We verify the extracted predicate against
  // the REAL verdict produced by AcDetectorAgent.
  const AcDetectorAgent = require(path.join(ROOT, "src/domain/agents/acDetectorAgent"));
  const acd = new AcDetectorAgent({});
  const onlyNegCtx = { classification: { proposed: [], negated: ["R1"] }, correctAnswer: ["R1","R2","R4"], exerciseNum: null };
  await acd.execute(onlyNegCtx);
  assert("A1: AcDetector yields only_negation with wronglyNegated=[R1]",
    onlyNegCtx.turnVerdict.verdict === "only_negation" &&
    onlyNegCtx.turnVerdict.wronglyNegated.indexOf("R1") >= 0,
    JSON.stringify(onlyNegCtx.turnVerdict.verdict) + " wn=" + JSON.stringify(onlyNegCtx.turnVerdict.wronglyNegated));
  assert("A1: verdict banner IS rendered for only_negation (wrong rejection reaches LLM)",
    tStub._shouldRenderVerdictBanner(onlyNegCtx.turnVerdict) === true);
  // Controls: proposed-only still renders; a null/empty verdict does not.
  assert("A1 control: proposed-only verdict still renders",
    tStub._shouldRenderVerdictBanner({ proposed: ["R1"], wronglyNegated: [] }) === true);
  assert("A1 control: empty verdict does NOT render",
    tStub._shouldRenderVerdictBanner({ proposed: [], wronglyNegated: [] }) === false &&
    tStub._shouldRenderVerdictBanner(null) === false);
}

// ─── 9. FULL GUARDRAIL PIPELINE (end-to-end, the layer that actually ships) ──
//
// BUG-CRIT (2026-06-11): every section above checks guardrails in ISOLATION
// (g.check / g.surgicalFix). But what reaches the student is whatever
// GuardrailPipeline.validate() RETURNS after composing check → surgical →
// retry. A guardrail can fire perfectly in isolation and STILL leak if the
// pipeline never acts on it. That is exactly what happened with adherence's
// false_premise rule: check() returned violated=true (section H/T1 passes),
// but the rule has no surgicalFix AND "adherence" was missing from the
// pipeline's CRITICAL_GUARDRAILS set, so the consolidated retry was skipped
// and the "¿Por qué crees que R4 no influye?" question was sent VERBATIM —
// the precise failure seen in the production transcript. These tests drive the
// REAL pipeline with a stub LLM and assert on the user-visible output, so a
// dead detection (fires-but-never-acts) FAILS here even when its unit test passes.
async function section9() {
  section("9. GuardrailPipeline end-to-end: detections must ACT, not just fire");
  const GuardrailPipeline = require(path.join(ROOT, "src/domain/services/GuardrailPipeline"));

  // Stub LLM whose retry returns a clean, false-premise-free Socratic question.
  // We count calls so we can distinguish "retried" from "passed through".
  function makePipeline(retryText) {
    let calls = 0;
    const llm = { chatCompletion: async function () { calls++; return retryText; } };
    const pipeline = new GuardrailPipeline({
      guardrails: createDefaultGuardrails(), llmService: llm, budgetMs: 45000,
    });
    return { pipeline, calls: () => calls };
  }
  const e2eCtx = {
    correctAnswer: ["R1", "R2", "R4"], evaluableElements: ["R1", "R2", "R3", "R4", "R5"],
    kgConceptPatterns: [], lang: "es", messages: [],
  };
  const sysMsgs = [{ role: "system", content: "tutor prompt" }, { role: "user", content: "r1 y r2" }];

  // (a) THE REGRESSION: a false-premise question about a CORRECT element must
  // NOT reach the student. Pre-fix this returned path=non_critical_only with the
  // false premise intact and llmRetryCount=0 (LLM never called).
  const cleanQ = "¿Has tenido en cuenta todas las resistencias conectadas a ese nodo?";
  const h1 = makePipeline(cleanQ);
  const r1 = await h1.pipeline.validate(
    "R1 y R2 son resistencias en el camino. ¿Por qué crees que R4 no influye en la tensión entre N2 y tierra?",
    e2eCtx, { messages: sysMsgs });
  assert("9/CRIT: false_premise (R4 correct) is REPAIRED, not sent verbatim",
    !/por qu[eé][^?]*r4[^?]*no influye/i.test(r1.response),
    "path=" + r1.path + " sent=" + JSON.stringify(r1.response).slice(0, 90));
  assert("9/CRIT: pipeline actually triggered the consolidated retry (LLM called once)",
    r1.llmRetryCount === 1 && h1.calls() === 1,
    "retries=" + r1.llmRetryCount + " llmCalls=" + h1.calls() + " path=" + r1.path);

  // (b) GUARD: a clean Socratic turn must pass through untouched with NO retry
  // (no spurious LLM round-trip / latency from the adherence-critical change).
  const h2 = makePipeline(cleanQ);
  const r2 = await h2.pipeline.validate(
    "R1 y R2 están en el camino de la corriente. ¿Qué otra resistencia conecta el nodo N2 con tierra?",
    e2eCtx, { messages: sysMsgs });
  assert("9/GUARD: a clean Socratic turn passes primary_ok with no retry",
    r2.path === "primary_ok" && r2.llmRetryCount === 0 && h2.calls() === 0,
    "path=" + r2.path + " retries=" + r2.llmRetryCount + " llmCalls=" + h2.calls());

  // (c) GUARD: a guard against the *opposite* regression — '¿por qué R3 no
  // influye?' (R3 genuinely irrelevant) is a legitimate Socratic move and must
  // NOT be rewritten away.
  const h3 = makePipeline(cleanQ);
  const r3 = await h3.pipeline.validate(
    "¿Por qué pensaste que R3 también influía en la tensión entre N2 y tierra?",
    e2eCtx, { messages: sysMsgs });
  assert("9/GUARD: legitimate '¿por qué R3 (irrelevant) influía?' is NOT rewritten",
    r3.path === "primary_ok" && /R3/.test(r3.response) && h3.calls() === 0,
    "path=" + r3.path + " sent=" + JSON.stringify(r3.response).slice(0, 80));

  // (d) THE OTHER PRODUCTION LEAK: a topology reveal inside a question
  // ("R4 está conectada en paralelo con R2") must be REDACTED before sending —
  // the user-visible text must not contain the "en paralelo con" connection.
  const h4 = makePipeline(cleanQ);
  const r4 = await h4.pipeline.validate(
    "¿Te das cuenta de que R4 está conectada en paralelo con R2 entre N2 y tierra?",
    e2eCtx, { messages: sysMsgs });
  assert("9/LEAK: topology reveal 'en paralelo con' never reaches the student",
    !/en paralelo con|en serie con/i.test(r4.response),
    "path=" + r4.path + " sent=" + JSON.stringify(r4.response).slice(0, 90));

  // (e) THE FLOW LEAK: current-path reveal ("la corriente pasa por R2 y R4")
  // must be redacted; the final text must still ask the student something.
  const h5 = makePipeline(cleanQ);
  const r5 = await h5.pipeline.validate(
    "La corriente desde N2 hacia tierra pasa por R2 y R4. ¿Hay algún interruptor en el circuito?",
    e2eCtx, { messages: sysMsgs });
  assert("9/LEAK: current-path 'pasa por R2 y R4' is redacted yet a question remains",
    !/pasa por r2 y r4/i.test(r5.response) && /\?/.test(r5.response),
    "path=" + r5.path + " sent=" + JSON.stringify(r5.response).slice(0, 90));

  // (f) BUG-ALGUNOS (2026-06-11, req11 of the real transcript): the student
  // ANSWERED the full correct set ("pasa por r1 r2 r4", verdict=correct). The
  // tutor's honest acknowledgment "R1, R2 y R4 están en el camino" must NOT be
  // rewritten into the FALSE "Algunos de los elementos que has propuesto están
  // en el camino" ("some" when it was ALL). Pre-fix this fired solution_leak
  // and the surgical fix produced exactly that misleading "Algunos…" string.
  const correctCtx = Object.assign({}, e2eCtx, {
    proposed: ["R1", "R2", "R4"],
    turnVerdict: { verdict: "correct", hits: ["R1", "R2", "R4"], missing: [], errors: [] },
    messages: [{ role: "user", content: "pasa por r1 r2 r4" }],
  });
  const h6 = makePipeline(cleanQ);
  const r6 = await h6.pipeline.validate(
    "R1, R2 y R4 están en el camino. ¿Está R5 conectada a tierra en ambos extremos?",
    correctCtx, { messages: sysMsgs });
  assert("9/ALGUNOS: complete-correct answer is NOT rewritten into the false 'Algunos…'",
    !/algunos de los elementos/i.test(r6.response) && r6.path === "primary_ok",
    "path=" + r6.path + " sent=" + JSON.stringify(r6.response).slice(0, 90));
  assert("9/ALGUNOS: the honest acknowledgment of the student's own answer survives",
    /r1[,\s].*r2.*r4/i.test(r6.response),
    "sent=" + JSON.stringify(r6.response).slice(0, 90));

  // (g) GUARD against re-opening a leak: a WRONG superset answer (student
  // proposed R1 R2 R3 R4, verdict != correct) must STILL have its correct
  // subset protected — the verdict-correct exception must not bleed into it.
  const supersetCtx = Object.assign({}, e2eCtx, {
    proposed: ["R1", "R2", "R3", "R4"],
    turnVerdict: { verdict: "wrong_concept", hits: ["R1", "R2", "R4"], errors: ["R3"], missing: [] },
    messages: [{ role: "user", content: "r1 r2 r3 r4" }],
  });
  const h7 = makePipeline(cleanQ);
  const r7 = await h7.pipeline.validate(
    "R1, R2 y R4 están en el camino. ¿Está R5 conectada a tierra en ambos extremos?",
    supersetCtx, { messages: sysMsgs });
  assert("9/ALGUNOS guard: wrong superset answer still has its correct subset redacted",
    !/r1[,\s]+r2\s*y\s*r4\s+est[aá]n en el camino/i.test(r7.response),
    "path=" + r7.path + " sent=" + JSON.stringify(r7.response).slice(0, 90));
}

// ─── 10. CUMULATIVE ANSWER STATE (BUG-LOOP root cause) ───────────────────────
//
// The per-turn verdict forgets what the student already established, so the
// tutor re-interrogates R1/R2/R4 turn after turn (the loop Irene flagged in the
// 2026-06-11 transcript). computeCumulativeAnswer replays the classifier over
// the whole conversation (each user turn with its preceding tutor question as
// context) to reconstruct the union of what's named/excluded. These tests
// replay the REAL transcript turns and assert the state the per-turn verdict
// loses.
function section10() {
  section("10. cumulativeAnswer: the conversation-level state the per-turn verdict forgets");
  const { computeCumulativeAnswer } = require(path.join(ROOT, "src/domain/services/rag/cumulativeAnswer"));
  const correctA = ["R1", "R2", "R4"];
  const evalA = ["R1", "R2", "R3", "R4", "R5"];
  function pairsToMessages(pairs) {
    const out = [];
    for (const [q, a] of pairs) { out.push({ role: "assistant", content: q }); out.push({ role: "user", content: a }); }
    return out;
  }

  // (a) THE ANTI-FORGETTING CORE: the student names the full set in ONE turn,
  // then a LATER turn only negates R5. Per-turn verdict would report
  // missing=[R1,R2,R4] again; the cumulative state must still know it's complete.
  const loopMsgs = pairsToMessages([
    ["¿cómo se distribuye la corriente?", "pasa por r1 r2 r4"],
    ["¿Está R5 conectada a tierra en ambos extremos?", "No porque está en corto"],
  ]);
  const cum = computeCumulativeAnswer(loopMsgs, correctA, evalA);
  assert("10/CORE: full set stays 'named' after a later bare-negation turn (no forgetting)",
    cum.complete === true && cum.stillMissing.length === 0 &&
    ["R1", "R2", "R4"].every((r) => cum.namedCorrect.indexOf(r) >= 0),
    "namedCorrect=[" + cum.namedCorrect + "] stillMissing=[" + cum.stillMissing + "]");
  assert("10/CORE: R5 (context-resolved 'No porque está en corto') is in excluded",
    cum.excluded.indexOf("R5") >= 0, "excluded=[" + cum.excluded + "]");

  // (b) FULL TRANSCRIPT → closureReady (criterion: full set named AND exclusions
  // reasoned). R3 excluded (req9 "No"), R5 excluded (req12 corto), R1/R2/R4 named.
  const fullMsgs = pairsToMessages([
    ["¿Está R3 en el camino de la corriente que va de N2 a tierra?", "No"],
    ["¿cómo se distribuye la corriente?", "pasa por r1 r2 r4"],
    ["¿Está R5 conectada a tierra en ambos extremos?", "No porque está en corto"],
    ["¿por qué R1, R2 y R4 son relevantes pero R3 no?", "Porque el interruptor está abierto"],
  ]);
  const full = computeCumulativeAnswer(fullMsgs, correctA, evalA);
  assert("10/CLOSURE: complete set + R3,R5 excluded + reasoned → closureReady=true",
    full.closureReady === true &&
    ["R3", "R5"].every((r) => full.excluded.indexOf(r) >= 0) &&
    full.reasoningConcepts.length > 0,
    "excluded=[" + full.excluded + "] concepts=[" + full.reasoningConcepts + "] closureReady=" + full.closureReady);

  // (c) GUARD: an INCOMPLETE session (R4 never named, never excluded) must NOT
  // be complete and must NOT be closureReady.
  const partialMsgs = pairsToMessages([
    ["¿Está R3 en el camino?", "No"],
    ["¿qué resistencias?", "r1 y r2"],
    ["¿Está R5?", "No porque está en corto"],
  ]);
  const partial = computeCumulativeAnswer(partialMsgs, correctA, evalA);
  assert("10/GUARD: missing R4 → not complete, not closureReady",
    partial.complete === false && partial.closureReady === false &&
    partial.stillMissing.indexOf("R4") >= 0,
    "stillMissing=[" + partial.stillMissing + "] complete=" + partial.complete);

  // (d) GUARD: a wrongly-excluded CORRECT element surfaces, but is CLEARED if the
  // student later names it (self-correction; naming wins).
  const wrongExclMsgs = pairsToMessages([
    ["¿Está R4 en el camino?", "no, R4 no influye"],
  ]);
  const wrongExcl = computeCumulativeAnswer(wrongExclMsgs, correctA, evalA);
  assert("10/GUARD: wrongly excluding correct R4 is flagged in wronglyExcluded",
    wrongExcl.wronglyExcluded.indexOf("R4") >= 0,
    "wronglyExcluded=[" + wrongExcl.wronglyExcluded + "]");
  const correctedMsgs = pairsToMessages([
    ["¿Está R4 en el camino?", "no, R4 no influye"],
    ["¿seguro?", "perdona, sí: r1 r2 r4"],
  ]);
  const corrected = computeCumulativeAnswer(correctedMsgs, correctA, evalA);
  assert("10/GUARD: naming R4 later clears it from wronglyExcluded (self-correction)",
    corrected.wronglyExcluded.indexOf("R4") < 0 && corrected.namedCorrect.indexOf("R4") >= 0,
    "wronglyExcluded=[" + corrected.wronglyExcluded + "] namedCorrect=[" + corrected.namedCorrect + "]");
}

// ─── 11. LOOP FIX WIRING: settled-element guardrail + cumulative closure ─────
async function section11() {
  section("11. Loop fix: settled-element guardrail (pipeline) + cumulative closure");
  const GuardrailPipeline = require(path.join(ROOT, "src/domain/services/GuardrailPipeline"));

  // (a) The req18 loop string, with the cumulative state that existed at that
  // point (R1,R2,R4 named; R3,R5 excluded). The pipeline must DETECT the
  // settled-element re-ask and RETRY (settled_element_question is retry-only and
  // must be in CRITICAL_GUARDRAILS, or the detection would be dead — BUG-CRIT class).
  let calls = 0;
  const pivot = "Has identificado las resistencias correctas. ¿Qué condición hace que una rama no transporte corriente?";
  const llm = { chatCompletion: async function () { calls++; return pivot; } };
  const pipeline = new GuardrailPipeline({ guardrails: createDefaultGuardrails(), llmService: llm, budgetMs: 45000 });
  const loopCtx = {
    correctAnswer: ["R1", "R2", "R4"], evaluableElements: ["R1", "R2", "R3", "R4", "R5"],
    kgConceptPatterns: [], lang: "es", messages: [],
    cumulativeAnswer: { namedCorrect: ["R1", "R2", "R4"], excluded: ["R3", "R5"], stillMissing: [], complete: true, closureReady: true, wronglyNamed: [], wronglyExcluded: [] },
  };
  const rLoop = await pipeline.validate(
    "R2 está confirmada. ¿Está R1 en el camino de la corriente que va desde la fuente hasta N2?",
    loopCtx, { messages: [{ role: "system", content: "s" }] });
  assert("11/SETTLED: a topology re-ask of a settled element triggers a retry/pivot",
    rLoop.llmRetryCount === 1 && calls === 1 &&
    !/¿est[aá]\s+r1\s+en el camino/i.test(rLoop.response),
    "path=" + rLoop.path + " retries=" + rLoop.llmRetryCount + " sent=" + JSON.stringify(rLoop.response).slice(0, 70));

  // (b) GUARD: a CONCEPTUAL consolidation question about settled elements is
  // GOOD (demanding reasoning) — it must pass through with NO retry.
  let calls2 = 0;
  const llm2 = { chatCompletion: async function () { calls2++; return pivot; } };
  const pipeline2 = new GuardrailPipeline({ guardrails: createDefaultGuardrails(), llmService: llm2, budgetMs: 45000 });
  const rConcept = await pipeline2.validate(
    "Has nombrado las correctas. ¿Por qué R2 forma parte del camino pero R3 no?",
    loopCtx, { messages: [{ role: "system", content: "s" }] });
  assert("11/SETTLED guard: conceptual '¿por qué…?' about settled elements is NOT retried",
    rConcept.path === "primary_ok" && calls2 === 0,
    "path=" + rConcept.path + " retries=" + rConcept.llmRetryCount);

  // (c) Orchestrator closure on the cumulative criterion (chosen with Irene:
  // full set named + exclusions reasoned). Drive the real methods on a bare
  // prototype instance (same technique as section 2d's _normaliseWhitespace).
  const Orchestrator = require(path.join(ROOT, "src/domain/agents/orchestrator"));
  const orch = Object.create(Orchestrator.prototype);
  const readyCum = { closureReady: true, wronglyNamed: [], wronglyExcluded: [] };
  assert("11/CLOSE: closureReady + non-blocked turn → deterministic finish",
    orch._shouldFinishDeterministically({ classification: { type: "wrong_concept" }, cumulativeAnswer: readyCum }) === true);
  assert("11/CLOSE guard: closureReady but current turn is dont_know → NO finish",
    orch._shouldFinishDeterministically({ classification: { type: "dont_know" }, cumulativeAnswer: readyCum }) === false);
  assert("11/CLOSE guard: closureReady but an outstanding wrong proposal → NO finish",
    orch._shouldFinishDeterministically({ classification: { type: "partial_correct" }, cumulativeAnswer: { closureReady: true, wronglyNamed: ["R3"], wronglyExcluded: [] } }) === false);
  assert("11/CLOSE guard: NOT closureReady → NO finish",
    orch._shouldFinishDeterministically({ classification: { type: "partial_correct" }, cumulativeAnswer: { closureReady: false, wronglyNamed: [], wronglyExcluded: [] } }) === false);
  assert("11/CLOSE: legacy correct_good_reasoning ×2 path still finishes",
    orch._shouldFinishDeterministically({ classification: { type: "correct_good_reasoning" }, loopState: { prevGoodReasoningTurns: 1 } }) === true);
  // GAP fix (2026-06-11): the explanation gate referenced a non-existent
  // ctx.asksExplanation (a tutorAgent local) so it never blocked. A solved
  // student who NOW asks the tutor to explain a concept must be ANSWERED, not
  // closed. Computed inline from the current message in _shouldFinishDeterministically.
  assert("11/CLOSE guard: closureReady but student asks to EXPLAIN a concept → NO finish",
    orch._shouldFinishDeterministically({
      classification: { type: "wrong_concept", concepts: ["divisor de tensión"] },
      userMessage: "¿puedes explicarme el concepto de divisor de tensión?",
      cumulativeAnswer: readyCum,
    }) === false);

  // (c-bis) DE-STICKY (gap 3 fix): closureReady stays true forever once reached,
  // so a follow-up turn after a close must NOT re-close. exerciseAlreadyClosed
  // short-circuits the deterministic finish.
  assert("11/DESTICKY: closureReady but exercise already closed → NO re-finish",
    orch._shouldFinishDeterministically({ classification: { type: "closed_answer" }, cumulativeAnswer: readyCum, exerciseAlreadyClosed: true }) === false);

  // (d) The <END_EXERCISE> token is AUTHORISED (kept) when closureReady, stripped otherwise.
  const ctxKeep = { finalResponse: "¡Bien! <END_EXERCISE>", classification: { type: "wrong_concept" }, cumulativeAnswer: readyCum };
  orch._stripUnauthorizedFinToken(ctxKeep);
  assert("11/CLOSE: FIN token kept when closureReady",
    /<END_EXERCISE>/.test(ctxKeep.finalResponse), "got: " + ctxKeep.finalResponse);
  const ctxStrip = { finalResponse: "¿Está R1 en el camino? <END_EXERCISE>", classification: { type: "wrong_answer" }, cumulativeAnswer: { closureReady: false, wronglyNamed: [], wronglyExcluded: [] }, loopState: {} };
  orch._stripUnauthorizedFinToken(ctxStrip);
  assert("11/CLOSE guard: unauthorised FIN token is stripped",
    !/<END_EXERCISE>/.test(ctxStrip.finalResponse), "got: " + ctxStrip.finalResponse);
  // De-sticky: a fresh FIN token in a follow-up after a prior close is stripped
  // (not re-authorised) even though closureReady is still true.
  const ctxReClose = { finalResponse: "¡Excelente! <END_EXERCISE>", classification: { type: "closed_answer" }, cumulativeAnswer: readyCum, exerciseAlreadyClosed: true, loopState: {} };
  orch._stripUnauthorizedFinToken(ctxReClose);
  assert("11/DESTICKY: FIN token in a post-close follow-up is stripped (no double close)",
    !/<END_EXERCISE>/.test(ctxReClose.finalResponse), "got: " + ctxReClose.finalResponse);
}

// ─── 12. TutorAgent cumulative banner (Block 2 wiring) ───────────────────────
async function section12() {
  section("12. TutorAgent [PROGRESO ACUMULADO] banner + stale-'Missing' suppression");
  const TutorAgent = require(path.join(ROOT, "src/domain/agents/tutorAgent"));
  let captured = null;
  const agent = new (class extends TutorAgent { constructor() {
    super({
      llmService: { chatCompletion: async function (msgs) { captured = msgs; return "ok"; } },
      buildSystemPrompt: function () { return "SYS"; },
      config: {},
      debugLogger: { logPrompt: function () {}, traceLlmCall: function () {}, logLlmOut: function () {} },
    });
  }})();
  // The exact failure shape: the student already named R1,R2,R4 in earlier turns
  // (cumulative), and THIS turn only negates R5 — so the per-turn verdict says
  // missing=[R1,R2,R4] (stale). The banner must reflect the cumulative truth and
  // the stale Missing line must be suppressed.
  const ctx = {
    exercise: {}, lang: "es", userMessage: "No porque está en corto", reqId: "t", config: {},
    classification: { type: "correct_no_reasoning", concepts: ["corto"], proposed: [], negated: ["R5"] },
    turnVerdict: { verdict: "only_negation", hits: [], errors: [], missing: ["R1", "R2", "R4"], wronglyNegated: [], proposed: [], negated: ["R5"] },
    detectedACs: [],
    cumulativeAnswer: { namedCorrect: ["R1", "R2", "R4"], excluded: ["R3", "R5"], stillMissing: [], complete: true, closureReady: false, wronglyNamed: [], wronglyExcluded: [] },
    correctAnswer: ["R1", "R2", "R4"], evaluableElements: ["R1", "R2", "R3", "R4", "R5"],
    history: [{ role: "assistant", content: "¿Está R5 conectada a tierra en ambos extremos?" }, { role: "user", content: "No porque está en corto" }],
    ragResult: { augmentation: "" }, historySummary: null,
    loopState: { prevCorrectTurns: 1, sameClassificationStreak: 1, tutorRepeating: false, lastAssistantQuestion: "¿Está R5 conectada a tierra en ambos extremos?", establishedFacts: [], tutorStuckOnElement: null, studentFrustrated: false, consecutiveWrongTurns: 0, totalAssistantTurns: 11, lastClassification: "correct_no_reasoning" },
    timing: { pipelineStartMs: Date.now() },
  };
  await agent.execute(ctx);
  const userMsg = captured[captured.length - 1].content;
  assert("12/BANNER: [PROGRESO ACUMULADO] names R1,R2,R4 as already identified",
    /PROGRESO ACUMULADO/.test(userMsg) && /YA ha identificado correctamente[^\n]*R1, R2, R4/.test(userMsg),
    "banner missing or incomplete");
  assert("12/BANNER: R3,R5 listed as already excluded",
    /YA ha excluido correctamente: R3, R5/.test(userMsg));
  assert("12/BANNER: the STALE 'Missing: R1,R2,R4' line is suppressed (no re-interrogation)",
    !/Missing \(correcto que el alumno a[uú]n NO/.test(userMsg),
    "stale Missing line leaked into the prompt");
  assert("12/BANNER: complete-but-not-closure → asks for ONE consolidation",
    /consolidaci[oó]n del razonamiento/.test(userMsg));

  // Localised banner (gap 1 fix, 2026-06-11): the banner must follow the
  // conversation language, not inject Spanish into a val/en session.
  const cumComplete = { namedCorrect: ["R1", "R2", "R4"], excluded: ["R3", "R5"], stillMissing: [], complete: true, closureReady: false };
  const bEn = agent._buildCumulativeBanner(cumComplete, "en", false);
  assert("12/I18N: English session → English banner ('CUMULATIVE PROGRESS')",
    /CUMULATIVE PROGRESS/.test(bEn) && !/PROGRESO ACUMULADO/.test(bEn), bEn.slice(0, 40));
  const bVal = agent._buildCumulativeBanner(cumComplete, "val", false);
  assert("12/I18N: Valencian session → Valencian banner ('PROGRÉS ACUMULAT')",
    /PROGR[ÉE]S ACUMULAT/.test(bVal) && /L'alumne JA ha identificat/.test(bVal), bVal.slice(0, 40));

  // De-sticky banner (gap 3 fix): once the exercise was already closed, the
  // banner must drop the "cierra/close" instruction and tell the tutor to
  // answer the follow-up instead — while still keeping the settled facts.
  const cumClosure = { namedCorrect: ["R1", "R2", "R4"], excluded: ["R3", "R5"], stillMissing: [], complete: true, closureReady: true };
  const bOpen = agent._buildCumulativeBanner(cumClosure, "es", false);
  const bClosed = agent._buildCumulativeBanner(cumClosure, "es", true);
  assert("12/DESTICKY: not-yet-closed → 'Cierra' instruction present",
    /Cierra con un reconocimiento/.test(bOpen));
  assert("12/DESTICKY: already-closed → drops 'Cierra', answers the follow-up, keeps settled facts",
    !/Cierra con un reconocimiento/.test(bClosed) &&
    /YA se cerró/.test(bClosed) && /R1, R2, R4/.test(bClosed),
    bClosed.slice(0, 60));
}

// ─── 13. 3rd real-server run (2026-06-11): cumulative fair-game, false
//        accusation, question-leak, settled flow phrases ────────────────────
async function section13() {
  section("13. Run-3: cumulative fair-game (SL), false accusation (AD), question-leak (SL), flow re-asks (SEQ)");
  const slg = byId.solution_leak;
  const adg13 = byId.adherence;
  const seq13 = byId.settled_element_question;
  const correct13 = ["R1", "R2", "R4"];
  const cum13 = {
    namedCorrect: ["R1", "R2", "R4"], excluded: ["R3", "R5"], stillMissing: [],
    complete: true, closureReady: true, wronglyNamed: [], wronglyExcluded: [],
    reasoningConcepts: ["abierto", "corto"],
    perTurn: [{ proposed: ["R1", "R2", "R4"], negated: [] }, { proposed: [], negated: ["R3", "R5"] }],
  };
  const ctx13 = {
    correctAnswer: correct13, lang: "es", turnVerdict: { verdict: "only_negation" },
    proposed: [], negated: ["R3", "R5"], cumulativeAnswer: cum13,
  };

  // (a) BUG-ALGUNOS-2: turn-7 of the run-3 transcript. The student named the
  // full set in an EARLIER turn; this turn only negates R3/R5 (verdict
  // only_negation). The per-turn fair-game gate alone missed it and the
  // "Algunos…" lie came back. The cumulative gate must exempt the echo.
  const echo13 = "R1, R2 y R4 están en el camino de la corriente. Bien razonado.";
  assert("13/SL: echo of the set is fair game when CUMULATIVE complete (verdict only_negation)",
    slg.check(echo13, ctx13).violated === false);
  const cumPartial13 = Object.assign({}, cum13, { complete: false, namedCorrect: ["R1", "R2"], stillMissing: ["R4"] });
  assert("13/SL guard: same echo with cumulative INCOMPLETE → still a leak",
    slg.check(echo13, Object.assign({}, ctx13, { cumulativeAnswer: cumPartial13, turnVerdict: { verdict: "partial_correct" } })).violated === true);

  // (b) FALSE ACCUSATION: "¿Por qué pensaste que R3 también influía?" right
  // after the student wrote "porque r3 está en interruptor abierto y r5 en
  // corto" (negated, never proposed). The student replied, furious: "no dije
  // que r3 influía". Retry-only rule in adherence.
  const acc13 = "¿Por qué pensaste que R3 también influía en la tensión entre N2 y tierra?";
  assert("13/AD: accusation about a negated, never-proposed element → violation",
    adg13.check(acc13, ctx13).violated === true);
  const cumR3prop = Object.assign({}, cum13, {
    perTurn: [{ proposed: ["R1", "R2", "R3"], negated: [] }, { proposed: [], negated: ["R3", "R5"] }],
  });
  assert("13/AD guard: student DID propose R3 in an earlier turn → legitimate, no violation",
    adg13.check(acc13, Object.assign({}, ctx13, { cumulativeAnswer: cumR3prop })).violated === false);
  assert("13/AD guard: '¿por qué pensaste que R3 NO influía?' (about the exclusion) → no violation",
    adg13.check("¿Por qué pensaste que R3 no influía en la tensión?", ctx13).violated === false);
  assert("13/AD guard: legacy ctx without negated/cumulative info → no violation (H/T1 compat)",
    adg13.check(acc13, { lang: "es", correctAnswer: correct13 }).violated === false);

  // (c) QUESTION-LEAK: a question naming the FULL correct set + influence verb
  // before the student named anything hands over the answer ("me da la
  // respuesta implícitamente"). Exempt once cumulative complete; never fires
  // when extra Rn are listed (enumerating everything reveals nothing).
  const qleak13 = "¿Has considerado cómo las resistencias conectadas a N2, como R1, R2 y R4, podrían afectar la tensión entre N2 y tierra?";
  assert("13/SL-Q: full-set + 'podrían afectar' question with nothing named yet → leak",
    slg.check(qleak13, { correctAnswer: correct13, lang: "es" }).violated === true);
  assert("13/SL-Q guard: same question AFTER cumulative complete (consolidation) → no leak",
    slg.check(qleak13, ctx13).violated === false);
  assert("13/SL-Q guard: question listing ALL evaluables R1–R5 → no leak",
    slg.check("¿Cuáles de R1, R2, R3, R4 y R5 influyen en la tensión?", { correctAnswer: correct13, lang: "es" }).violated === false);
  assert("13/SL-Q guard: '¿por qué R3 y R5 no influyen?' (names no correct element) → no leak",
    slg.check("¿Por qué R3 y R5 no influyen en la diferencia de potencial pedida?", ctx13).violated === false);

  // (d) SETTLED flow phrasing: run-3 turns 8–11 re-asked R5/R3 exclusions with
  // flow wording the original phrase list missed.
  assert("13/SEQ: 'no puede fluir a través de R3' (R3 settled) → violation",
    seq13.check("¿Significa el interruptor abierto que la corriente no puede fluir a través de R3?", { cumulativeAnswer: cum13 }).violated === true);
  assert("13/SEQ: 4th re-ask of R5's both-ends-grounded → violation",
    seq13.check("¿La resistencia R5, al estar conectada a tierra en ambos extremos, significa que no forma parte del camino de la corriente?", { cumulativeAnswer: cum13 }).violated === true);
  assert("13/SEQ guard: the same probe BEFORE R5 is settled → legitimate Socratic probe",
    seq13.check("¿Está R5 conectada a tierra en ambos extremos?", { cumulativeAnswer: { namedCorrect: ["R1", "R2", "R4"], excluded: ["R3"], stillMissing: [], complete: true } }).violated === false);

  // (d2) BUG-NEG-INT — THE ROOT of the run-3 turn-7 disaster. The student's
  // "porque r3 está en interruptor abierto y r5 en corto" was classified as
  // R3 PROPOSED (polar opposite): the state phrase needs 28 chars after the
  // element but POST_WINDOW was 25, and "en interruptor abierto" wasn't in the
  // dictionary. The misread made AcDetector emit errors=[R3] and the verdict
  // banner literally instructed the LLM to ask "¿por qué pensaste que también
  // R3?" → the false accusation came from OUR OWN banner. Fix: dictionary
  // entries + POST_WINDOW 40 (still sentence- and next-element-bounded).
  const t7 = classifyQuery("porque r3 está en interruptor abierto y r5 en corto", correct13, ["R1","R2","R3","R4","R5"], "¿Por qué R3 y R5 no influyen?");
  assert("13/NEG-INT: 'r3 está en interruptor abierto y r5 en corto' → R3,R5 negated, nothing proposed",
    t7.negated.indexOf("R3") >= 0 && t7.negated.indexOf("R5") >= 0 && t7.proposed.length === 0,
    "got P=[" + t7.proposed.join(",") + "] N=[" + t7.negated.join(",") + "]");
  // FP guard for the wider window: a positive claim with an unrelated trailing
  // clause must NOT pick up a distant negation from the next element's context.
  const t7g = classifyQuery("R4 influye porque R3 está en interruptor abierto", correct13, ["R1","R2","R3","R4","R5"]);
  assert("13/NEG-INT guard: 'R4 influye porque R3 está en interruptor abierto' → R4 proposed, R3 negated",
    t7g.proposed.indexOf("R4") >= 0 && t7g.negated.indexOf("R3") >= 0 && t7g.negated.indexOf("R4") < 0,
    "got P=[" + t7g.proposed.join(",") + "] N=[" + t7g.negated.join(",") + "]");

  // (d3) FULL run-3 replay → the cumulative state must reach closureReady at
  // turn 7 and the orchestrator must CLOSE instead of letting the tutor loop
  // (turns 8-11 of the production transcript would never happen).
  const { computeCumulativeAnswer } = require(path.join(ROOT, "src/domain/services/rag/cumulativeAnswer"));
  const run3 = [
    ["¿qué identificas en el enunciado?", "las resistencias por las que pasa la corriente"],
    ["¿Hacia qué nudo va la corriente desde N2?", "a tierra"],
    ["¿Has considerado cómo las resistencias R2 y R4 podrían influir en la tensión entre N2 y tierra?", "sí, influyen"],
    ["¿Has considerado cómo la resistencia R1 podría influir en la tensión?", "sí, influye"],
    ["¿Has considerado cómo la resistencia R2 podría influir en la tensión?", "sí, influyen r1 r2 r4"],
    ["R1, R2 y R4 son las resistencias que influyen. ¿Por qué R3 y R5 no influyen en la diferencia de potencial pedida?", "porque r3 está en interruptor abierto y r5 en corto"],
  ];
  const run3msgs = [];
  for (const [q, a] of run3) { run3msgs.push({ role: "assistant", content: q }); run3msgs.push({ role: "user", content: a }); }
  const run3cum = computeCumulativeAnswer(run3msgs, correct13, ["R1", "R2", "R3", "R4", "R5"]);
  assert("13/REPLAY: run-3 turn 7 → closureReady (set named + R3,R5 excluded + reasoned)",
    run3cum.closureReady === true && run3cum.wronglyNamed.length === 0,
    "excluded=[" + run3cum.excluded + "] wronglyNamed=[" + run3cum.wronglyNamed + "] closureReady=" + run3cum.closureReady);
  const Orch13 = require(path.join(ROOT, "src/domain/agents/orchestrator"));
  const orch13 = Object.create(Orch13.prototype);
  assert("13/REPLAY: orchestrator CLOSES at run-3 turn 7 (the 8-11 loop never happens)",
    orch13._shouldFinishDeterministically({
      classification: { type: t7.type, concepts: t7.concepts },
      userMessage: "porque r3 está en interruptor abierto y r5 en corto",
      cumulativeAnswer: run3cum, loopState: {},
    }) === true);

  // (e) PIPELINE e2e of the run-3 turn-7 disaster: LLM emits the honest echo
  // PLUS the false accusation. Expected: solution_leak does NOT rewrite the
  // echo (cumulative fair game), adherence false_accusation forces ONE retry,
  // and the student receives the clean pivot — not "Algunos…" nor the accusation.
  const GuardrailPipeline = require(path.join(ROOT, "src/domain/services/GuardrailPipeline"));
  let calls13 = 0;
  const pivot13 = "Exacto: esa exclusión es correcta. ¿Qué ley te permite calcular ahora la tensión entre N2 y tierra?";
  const llm13 = { chatCompletion: async function () { calls13++; return pivot13; } };
  const pl13 = new GuardrailPipeline({ guardrails: createDefaultGuardrails(), llmService: llm13, budgetMs: 45000 });
  const r13 = await pl13.validate(
    "R1, R2 y R4 están en el camino de la corriente. ¿Por qué pensaste que R3 también influía en la tensión entre N2 y tierra?",
    Object.assign({}, ctx13, { evaluableElements: ["R1", "R2", "R3", "R4", "R5"], kgConceptPatterns: [], messages: [] }),
    { messages: [{ role: "system", content: "s" }] });
  assert("13/E2E: turn-7 — no 'Algunos…' lie and no false accusation reaches the student",
    !/algunos de los elementos/i.test(r13.response) && !/pensaste que r3/i.test(r13.response) &&
    r13.llmRetryCount === 1 && calls13 === 1,
    "path=" + r13.path + " retries=" + r13.llmRetryCount + " sent=" + JSON.stringify(r13.response).slice(0, 80));
}

// ─── 14. 4th real-server run (2026-06-11): article variants, quantifier
//        'todo', excluding-state yes/no inversion, path-accusation verbs ─────
function section14() {
  section("14. Run-4: 'en UN interruptor' (NEG), 'todo menos' (QUANT), state-question polarity (STATEQ), path accusation (AD)");
  const correct14 = ["R1", "R2", "R4"];
  const eval14 = ["R1", "R2", "R3", "R4", "R5"];

  // (a) BUG-TODO: the student OPENED with the complete answer via the SINGULAR
  // quantifier "todo menos r3 r5" — only plural forms were listed, so the
  // first message was read as bare negations and 'complete' was delayed.
  const q14a = classifyQuery("todo menos r3 r5", correct14, eval14);
  assert("14/QUANT: 'todo menos r3 r5' expands → R1,R2,R4 proposed, R3,R5 negated",
    ["R1", "R2", "R4"].every((r) => q14a.proposed.indexOf(r) >= 0) &&
    ["R3", "R5"].every((r) => q14a.negated.indexOf(r) >= 0),
    "got P=[" + q14a.proposed + "] N=[" + q14a.negated + "]");
  assert("14/QUANT guard: idiom 'todo el rato pensando' does NOT expand",
    classifyQuery("todo el rato pensando en eso", correct14, eval14).proposed.length === 0);

  // (b) BUG-NEG-INT-2: "en UN interruptor abierto" — the ARTICLE variant broke
  // the substring match and R3 flipped to PROPOSED again (run-4 turn 3), which
  // re-triggered the whole errors=[R3] → banner-driven accusation chain.
  const q14b = classifyQuery("porque r3 esta en un interruptor abierto y r5 en corto", correct14, eval14, "¿Por qué crees que R3 y R5 no influyen?");
  assert("14/NEG: 'r3 esta en UN interruptor abierto y r5 en corto' → both negated, none proposed",
    q14b.negated.indexOf("R3") >= 0 && q14b.negated.indexOf("R5") >= 0 && q14b.proposed.length === 0,
    "got P=[" + q14b.proposed + "] N=[" + q14b.negated + "]");
  assert("14/NEG guard: global 'r1 r2 r4 porque el interruptor esta abierto' does NOT negate R4",
    classifyQuery("r1 r2 r4 porque el interruptor esta abierto", correct14, eval14).negated.indexOf("R4") < 0,
    "N=[" + classifyQuery("r1 r2 r4 porque el interruptor esta abierto", correct14, eval14).negated + "]");

  // (c) BUG-STATEQ: "sí" confirming an EXCLUDING-STATE question ("¿está R5
  // conectada a tierra en ambos extremos?") is the student agreeing R5 is
  // shorted — an EXCLUSION, not a proposal. The old polarity read it as
  // proposed=[R5] → errors=[R5] → "¿por qué pensaste que R5 también estaba en
  // el camino?" (run-4 turn 5 false accusation).
  const q14c = classifyQuery("sí", correct14, eval14, "¿Puedes confirmar si la resistencia R5 está conectada a tierra en ambos extremos?");
  assert("14/STATEQ: 'sí' to an excluding-state question → R5 NEGATED, correct_no_reasoning",
    q14c.negated.indexOf("R5") >= 0 && q14c.proposed.length === 0 && q14c.type === "correct_no_reasoning",
    "got P=[" + q14c.proposed + "] N=[" + q14c.negated + "] type=" + q14c.type);
  assert("14/STATEQ guard: 'sí' to a normal path question still PROPOSES the element",
    classifyQuery("sí", correct14, eval14, "¿Está R2 en el camino de la corriente hacia tierra?").proposed.indexOf("R2") >= 0);
  assert("14/STATEQ guard: 'No porque está en corto' (answer carries the state) still negates R5",
    classifyQuery("No porque está en corto", correct14, eval14, "¿Está R5 conectada a tierra en ambos extremos?").negated.indexOf("R5") >= 0);

  // (d) Accusation with a PATH predicate ("¿por qué pensaste que R5 también
  // ESTABA EN EL CAMINO?") — the influence-verb list missed it (run-4 turn 5).
  const adg14 = byId.adherence;
  const cum14 = { namedCorrect: ["R1", "R2", "R4"], excluded: ["R3", "R5"], stillMissing: [], complete: true, closureReady: true, wronglyNamed: [], wronglyExcluded: [], perTurn: [{ proposed: ["R1", "R2", "R4"], negated: ["R3", "R5"] }] };
  assert("14/AD: '¿por qué pensaste que R5 también estaba en el camino?' → false accusation",
    adg14.check("¿Por qué pensaste que R5 también estaba en el camino, considerando sus conexiones?",
      { lang: "es", correctAnswer: correct14, proposed: [], negated: [], cumulativeAnswer: cum14 }).violated === true);
  assert("14/AD guard: '¿por qué pensaste que R5 NO estaba en el camino?' → no violation",
    adg14.check("¿Por qué pensaste que R5 no estaba en el camino?",
      { lang: "es", correctAnswer: correct14, proposed: [], negated: [], cumulativeAnswer: cum14 }).violated === false);

  // (e) FULL run-4 replay: with the fixes, the session reaches closureReady at
  // turn 3 ("porque r3 esta en un interruptor abierto y r5 en corto") and the
  // orchestrator CLOSES — turns 4-5 of the production transcript never happen.
  const { computeCumulativeAnswer } = require(path.join(ROOT, "src/domain/services/rag/cumulativeAnswer"));
  const run4 = [
    { role: "user", content: "todo menos r3 r5" },
    { role: "assistant", content: "Entiendo. ¿hacia qué nudo crees que va la corriente desde N2, y qué resistencias podrían estar en su camino?" },
    { role: "user", content: "r1 r2 r4" },
    { role: "assistant", content: "R1, R2 y R4 son los elementos que influyen. ¿Por qué crees que R3 y R5 no influyen en esta tensión, considerando su conexión en el circuito?" },
    { role: "user", content: "porque r3 esta en un interruptor abierto y r5 en corto" },
  ];
  const run4cum = computeCumulativeAnswer(run4, correct14, eval14);
  assert("14/REPLAY: run-4 reaches closureReady at turn 3",
    run4cum.closureReady === true && run4cum.wronglyNamed.length === 0,
    "excluded=[" + run4cum.excluded + "] wronglyNamed=[" + run4cum.wronglyNamed + "] closureReady=" + run4cum.closureReady);
  // Turn-1 alone must NOT close (complete set but no reasoning yet — the tutor
  // must still demand the justification).
  const run4t1 = computeCumulativeAnswer(run4.slice(0, 1), correct14, eval14);
  assert("14/REPLAY guard: turn 1 ('todo menos r3 r5', no reasoning) → complete but NOT closureReady",
    run4t1.complete === true && run4t1.closureReady === false,
    "complete=" + run4t1.complete + " closureReady=" + run4t1.closureReady);
  const Orch14 = require(path.join(ROOT, "src/domain/agents/orchestrator"));
  const orch14 = Object.create(Orch14.prototype);
  const t3cls = classifyQuery(run4[4].content, correct14, eval14, run4[3].content);
  assert("14/REPLAY: orchestrator CLOSES at run-4 turn 3 (turns 4-5 never happen)",
    orch14._shouldFinishDeterministically({
      classification: { type: t3cls.type, concepts: t3cls.concepts },
      userMessage: run4[4].content, cumulativeAnswer: run4cum, loopState: {},
    }) === true);
}

// ─── Summary ────────────────────────────────────────────────────────────────
(async function main() {
  await section8();
  await section9();
  section10();
  await section11();
  await section12();
  await section13();
  section14();

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
