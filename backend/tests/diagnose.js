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
