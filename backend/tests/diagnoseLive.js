"use strict";

/**
 * Real-LLM diagnosis (no mocks). Hits the UPV Ollama with qwen2.5:latest.
 * Run from backend/:    node tests/diagnoseLive.js
 *
 * Goals:
 *   1. Verify qwen2.5:latest is reachable.
 *   2. Reproduce the "retry-hint plagiarism" bug: the LLM copies the example
 *      phrase from buildRetryHint() verbatim into its response, which is what
 *      creates the visible infinite loop in production.
 *   3. Reproduce the "didactic explanation in retry" bug: the LLM keeps
 *      explaining instead of asking after a guardrail retry.
 */

const path = require("path");
const ROOT = path.join(__dirname, "..");
process.chdir(ROOT);
require("dotenv").config({ path: path.join(ROOT, ".env") });

const axios = require("axios");
const https = require("https");

const BASE = (process.env.OLLAMA_API_URL_UPV || "https://ollama.gti-ia.upv.es:443").replace(/\/$/, "");
const MODEL = "qwen2.5:latest";
const httpsAgent = new https.Agent({ rejectUnauthorized: false });

async function chat(messages, options = {}) {
  const t0 = Date.now();
  const r = await axios.post(`${BASE}/api/chat`, {
    model: MODEL,
    stream: false,
    keep_alive: "10m",
    messages,
    options: { num_predict: 200, num_ctx: 4096, temperature: 0.4, ...options },
  }, { httpsAgent, timeout: 120000 });
  return { content: r.data?.message?.content || "", ms: Date.now() - t0 };
}

(async function main() {
  console.log("Endpoint:", BASE, "  Model:", MODEL);

  // Step 1: reachability
  console.log("\n--- Step 1: reachability ---");
  try {
    const v = await axios.get(`${BASE}/api/version`, { httpsAgent, timeout: 5000 });
    console.log("  OK Ollama version:", JSON.stringify(v.data));
  } catch (e) {
    console.log("  FAIL Ollama not reachable:", e.message); process.exit(1);
  }

  // Step 2: simple chat warm-up
  console.log("\n--- Step 2: warm-up chat ---");
  const w = await chat([{ role: "system", content: "You are concise." }, { role: "user", content: "Say hi in one word." }]);
  console.log(`  OK warm-up (${w.ms}ms): ${JSON.stringify(w.content.slice(0, 60))}`);

  // Step 3: reproduce the retry-hint plagiarism
  // We mimic the orchestrator: a base tutor prompt + the element_naming retry hint appended.
  // If qwen2.5 copies the example verbatim, we see the same generic question users see in prod.
  console.log("\n--- Step 3: reproduce retry-hint plagiarism (the loop) ---");
  const baseSystem = [
    "Eres un tutor socrático de circuitos eléctricos. NUNCA des la solución directamente.",
    "El alumno está resolviendo: '¿De qué resistencias depende la tensión entre N2 y 0?' La respuesta correcta es R1, R2, R4.",
    "El alumno acaba de decir 'r1 r2 r4' SIN justificar.",
    "Tu tarea: pídele que justifique. NO confirmes. NO nombres elementos específicos.",
  ].join(" ");

  const hint = require(path.join(ROOT, "src/domain/services/languageManager")).getElementNamingInstruction("es");

  // Pass 1: base prompt, no hint
  const r1 = await chat([
    { role: "system", content: baseSystem },
    { role: "user", content: "r1 r2 r4" },
  ]);
  console.log(`  base (${r1.ms}ms): ${r1.content}`);

  // Pass 2: base + retry hint appended at end (this is what GuardrailPipeline does)
  const r2 = await chat([
    { role: "system", content: baseSystem + hint },
    { role: "user", content: "r1 r2 r4" },
  ]);
  console.log(`\n  base+hint (${r2.ms}ms): ${r2.content}`);

  const exampleFromHint = "qué condiciones se necesitan para que circule corriente por una rama";
  const plagiarized = r2.content.toLowerCase().includes(exampleFromHint.toLowerCase());
  console.log(`\n  PLAGIARISM: ${plagiarized ? "YES — qwen2.5 copied the example verbatim (CONFIRMED LOOP BUG)" : "NO — model reformulated"}`);

  // Step 4: language drift — student writes Spanish, ask if model stays in Spanish
  console.log("\n--- Step 4: language adherence ---");
  const r3 = await chat([
    { role: "system", content: "Reply ALWAYS in Spanish. " + baseSystem },
    { role: "user", content: "no lo sé" },
  ]);
  const isSpanish = !/\b(hello|the|that|because|when)\b/i.test(r3.content) && /\b(la|el|que|por|cuando|porque)\b/i.test(r3.content);
  console.log(`  reply (${r3.ms}ms): ${r3.content.slice(0, 200)}...`);
  console.log(`  Spanish-only: ${isSpanish ? "YES" : "NO (drifted)"}`);

  // Step 5: state-reveal pattern — does the model emit non-canonical state phrasings the guardrail misses?
  console.log("\n--- Step 5: state-reveal phrasing variety ---");
  const r4 = await chat([
    { role: "system", content: baseSystem + " El alumno propuso R5 incorrectamente. Una resistencia no contribuye porque tiene los dos terminales conectados al mismo nodo (sin pasar corriente)." },
    { role: "user", content: "creo que R5 importa" },
  ]);
  console.log(`  reply (${r4.ms}ms): ${r4.content}`);
  const phrases = [
    "está cortocircuitad",       // canonical (caught)
    "está en corto",             // missed
    "se cortocircuita",          // missed
    "queda en corto",            // missed
    "interruptor abierto",       // missed
    "terminales unidos",         // missed
  ];
  for (const p of phrases) {
    if (r4.content.toLowerCase().includes(p)) console.log(`    HIT: '${p}' present in response`);
  }

  console.log("\nDone.");
})().catch(e => {
  console.error("CRASH:", e.message);
  process.exit(2);
});
