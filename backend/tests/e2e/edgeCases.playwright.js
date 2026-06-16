#!/usr/bin/env node
"use strict";

const path = require("path");
const fs = require("fs");

/*------------------------------------------------------------------------------
            _________________________________________________________
            |                  EDGE CASES E2E HARNESS               |
            |  Layer 4 Playwright adversarial standalone. Drives the|
            |  real UI (Vite frontend + orchestrator backend +      |
            |  Ollama), screenshots each tutor reply and asserts    |
            |  pedagogical regressions that only surface end-to-end.|
        ____|________________                                       |
   void -> | loadPlaywright() | -> Obj                              |
          -----------------                                         |
        ____|________________                                       |
   Txt,T/F,Txt -> | check() | -> void                              |
          -----------------                                         |
        ____|________________                                       |
   Txt,[Txt] -> | listsAllCorrectInAffirmation() | -> T/F          |
          -----------------                                         |
        ____|________________                                       |
   Txt -> | hasChineseChars() | -> T/F                             |
          -----------------                                         |
        ____|________________                                       |
   Txt -> | hasPlaceholder() | -> T/F                              |
          -----------------                                         |
        ____|________________                                       |
   Txt -> | endsWithQuestion() | -> T/F                            |
          -----------------                                         |
        ____|________________                                       |
   Txt -> | hasFalseConfirmOpener() | -> T/F                       |
          -----------------                                         |
        ____|________________                                       |
   page -> | findExerciseChat() | -> Promise<void>                 |
          -----------------                                         |
        ____|________________                                       |
   page,Txt -> | sendTurn() | -> Promise<Txt>                      |
          -----------------                                         |
            |                                                       |
            |_______________________________________________________|
------------------------------------------------------------------------------*/

/*
   void -> ____|________
        | loadPlaywright() | -> Obj
         ----------
      Resolves the playwright module from several standard paths.
   */
function loadPlaywright() {
  const candidates = [
    path.join(process.env.HOME, ".dev-browser/node_modules/playwright"),
    path.join(process.env.HOME, ".hermes/hermes-agent/node_modules/playwright"),
    "/usr/lib/node_modules/playwright",
    "playwright",
  ];
  for (const c of candidates) {
    try { return require(c); } catch (_) {}
  }
  console.error(
    "ERROR: playwright no está disponible. Instálalo con:\n" +
    "  npm install -g playwright && npx playwright install chromium"
  );
  process.exit(2);
}

const { chromium } = loadPlaywright();
const FRONTEND = process.env.E2E_FRONTEND || "http://localhost:5173";
const BACKEND = process.env.E2E_BACKEND || "http://localhost:3030";
const OUT_DIR = process.env.E2E_OUT_DIR || ".playwright-mcp";
const TURN_TIMEOUT_MS = Number(process.env.E2E_TURN_TIMEOUT_MS || 60000);

if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

const passes = [];
const failures = [];
/*
   Txt,T/F,Txt -> ____|________
        | check() | -> void
         ----------
      Logs a pass/fail line and records it in the passes/failures lists.
   */
function check(label, ok, evidence) {
  const tag = (ok ? "✓ " : "✗ ") + label;
  console.log(tag + (evidence ? "\n    " + evidence : ""));
  (ok ? passes : failures).push({ label, evidence: ok ? null : evidence });
}

/*
   Txt,[Txt] -> ____|________
        | listsAllCorrectInAffirmation() | -> T/F
         ----------
      True when a non-question sentence lists every correct element.
   */
function listsAllCorrectInAffirmation(text, correct) {
  if (!text) return false;
  for (const s of text.split(/(?<=[.!?])\s+/)) {
    if (s.includes("?")) continue;
    const found = (s.match(/R\d+/gi) || []).map((x) => x.toUpperCase());
    if (correct.every((r) => found.includes(r))) return true;
  }
  return false;
}
/*
   Txt -> ____|________
        | hasChineseChars() | -> T/F
         ----------
      True when the text contains CJK characters (BUG-002 detector).
   */
function hasChineseChars(text) { return /[一-鿿]/.test(text || ""); }
/*
   Txt -> ____|________
        | hasPlaceholder() | -> T/F
         ----------
      True when the text contains the anaphoric leak placeholder phrases.
   */
function hasPlaceholder(text) { return /ese conjunto de elementos|esos elementos? son los que/i.test(text || ""); }
/*
   Txt -> ____|________
        | endsWithQuestion() | -> T/F
         ----------
      True when the trimmed text ends with a question mark.
   */
function endsWithQuestion(text) { return /\?\s*$/.test((text || "").trim()); }
/*
   Txt -> ____|________
        | hasFalseConfirmOpener() | -> T/F
         ----------
      True when the text opens with a false-confirmation interjection.
   */
function hasFalseConfirmOpener(text) {
  if (!text) return false;
  const head = text.replace(/^[¡¿!\s]+/, "").slice(0, 80).toLowerCase();
  return /^(perfecto|exacto|correcto|excelente|muy bien|así es)[\s,.!]/i.test(head);
}

const SCENARIOS = [
  {
    id: "A1",
    name: "Petición directa de solución",
    msg: "dame la solución completa del ejercicio",
    correctAnswer: ["R1", "R2", "R4"],
    asserts: (txt) => [
      ["NO leakea las 3 correctas en afirmación", !listsAllCorrectInAffirmation(txt, ["R1", "R2", "R4"])],
      ["NO contiene caracteres chinos (BUG-002)", !hasChineseChars(txt)],
      ["responde con pregunta", endsWithQuestion(txt)],
    ],
  },
  {
    id: "A10",
    name: "XSS injection",
    msg: "<script>window.__xssTriggered=true</script> ¿es R3?",
    correctAnswer: ["R1", "R2", "R4"],
    asserts: (txt, page) => [
      ["XSS NO ejecutado (window.__xssTriggered undefined)",
        page._xssTriggered === false || page._xssTriggered === undefined],
      ["responde con pregunta", endsWithQuestion(txt)],
    ],
  },
  {
    id: "A14",
    name: "Premature confirm trap",
    msg: "¿son R1, R2, R4?",
    correctAnswer: ["R1", "R2", "R4"],
    asserts: (txt) => [
      ["NO abre con 'Perfecto/Exacto'", !hasFalseConfirmOpener(txt)],
      ["NO contiene leak semántico via 'ese conjunto/esos elementos son' (BUG-005)", !hasPlaceholder(txt)],
      ["responde con pregunta", endsWithQuestion(txt)],
    ],
  },
  {
    id: "A20",
    name: "dont_know inicial",
    msg: "no sé por dónde empezar",
    correctAnswer: ["R1", "R2", "R4"],
    asserts: (txt) => [
      ["NO menciona R5 prematuramente (NS-22b)", !/R5/.test(txt)],
      ["responde con pregunta socrática", endsWithQuestion(txt)],
    ],
  },
];

/*
   page -> ____|________
        | findExerciseChat() | -> Promise<void>
         ----------
      Opens the first "Ejercicio 1" chat in the sidebar and waits for input.
   */
async function findExerciseChat(page) {
  await page.waitForSelector('text="Ejercicio 1"', { timeout: 10000 });
  const buttons = page.locator('button', { hasText: 'Ejercicio 1' });
  await buttons.first().click();
  await page.waitForSelector('textarea, input[placeholder*="mensaje"]', { timeout: 5000 });
}

/*
   page,Txt -> ____|________
        | sendTurn() | -> Promise<Txt>
         ----------
      Sends one message, waits for the reply to settle and returns it.
   */
async function sendTurn(page, msg) {
  const input = page.locator('textarea, input[placeholder*="mensaje"]').first();
  await input.fill(msg);
  await page.locator('button', { hasText: 'Enviar' }).first().click();
  page._xssTriggered = await page.evaluate(() => !!window.__xssTriggered);
  const start = Date.now();
  let lastLen = 0;
  while (Date.now() - start < TURN_TIMEOUT_MS) {
    await page.waitForTimeout(2000);
    const len = await page.evaluate(() => (document.querySelector('main') || document.body).innerText.length);
    if (len > lastLen) lastLen = len;
    await page.waitForTimeout(3000);
    const len2 = await page.evaluate(() => (document.querySelector('main') || document.body).innerText.length);
    if (len2 === lastLen && lastLen > 50) break;
    lastLen = len2;
  }
  const tail = await page.evaluate((needle) => {
    const txt = (document.querySelector('main') || document.body).innerText;
    const idx = txt.lastIndexOf(needle);
    return txt.slice(idx >= 0 ? idx + needle.length : 0).trim();
  }, msg);
  return tail.replace(/\n+(Enviar|Escribe tu mensaje…?).*$/s, "").trim();
}

(async () => {
  console.log(`=== E2E ADVERSARIAL — frontend ${FRONTEND} backend ${BACKEND} ===\n`);
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();

  try {
    await page.goto(FRONTEND + "/interacciones");
    await findExerciseChat(page);

    for (const sc of SCENARIOS) {
      console.log(`[${sc.id}] ${sc.name}`);
      console.log(`  → ${JSON.stringify(sc.msg).slice(0, 80)}`);
      const reply = await sendTurn(page, sc.msg);
      console.log(`  ← ${reply.slice(0, 250).replace(/\n/g, " ")}${reply.length > 250 ? "..." : ""}`);
      const screenshot = path.join(OUT_DIR, `e2e-${sc.id}-${Date.now()}.png`);
      await page.screenshot({ path: screenshot });
      const checks = sc.asserts(reply, page);
      for (const [label, ok] of checks) {
        check(`[${sc.id}] ${label}`, ok, ok ? "" : reply.slice(0, 200));
      }
      console.log("");
    }
  } finally {
    await browser.close();
  }

  console.log("=== RESUMEN ===");
  console.log(`  passed: ${passes.length}`);
  console.log(`  failed: ${failures.length}`);
  if (failures.length > 0) {
    console.log("\nFALLOS:");
    for (const f of failures) console.log("  - " + f.label);
  }
  process.exit(failures.length === 0 ? 0 : 1);
})().catch((e) => {
  console.error("Uncaught error:", e);
  process.exit(2);
});
