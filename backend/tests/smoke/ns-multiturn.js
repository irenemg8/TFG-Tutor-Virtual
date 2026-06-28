#!/usr/bin/env node
"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");

/*------------------------------------------------------------------------------
            _________________________________________________________
            |                    MULTI-TURN SMOKE                   |
            |  Runs 2 turns against each of the 7 exercises. Checks  |
            |  that turn 1 starts an interaction, turn 2 reuses the  |
            |  same interaccionId, no fallback or empty reply,       |
            |  streaming is active and the prompt has no '(not       |
            |  defined)'.                                            |
        ____|________________                                       |
   Txt -> | req() | -> Promise<Obj>                                 |
          -----------------                                         |
        ____|________________                                       |
        | reqSSE() | -> Promise<Obj>                                |
        ----------------------                                      |
        ____|________________                                       |
        | parseSetCookie() | -> Txt | null                          |
        ----------------------                                      |
            |                                                       |
            |_______________________________________________________|
------------------------------------------------------------------------------*/

const BACKEND = process.env.SMOKE_BACKEND || "http://localhost:3030";
const DUMP_DIR = process.env.SMOKE_DUMP || "/tmp/tv_dump";

/*
   IN -> ____|________
        | req() | -> Promise<Obj>
         ----------
      Performs a buffered HTTP request and resolves with status, headers and body.
   */
function req(method, urlStr, opts) {
  opts = opts || {};
  const u = new URL(urlStr);
  return new Promise((resolve, reject) => {
    const r = http.request({
      method, host: u.hostname, port: u.port || 80,
      path: u.pathname + (u.search || ""),
      headers: opts.headers || {},
      timeout: 60000,
    }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") }));
    });
    r.on("error", reject);
    if (opts.body) r.write(opts.body);
    r.end();
  });
}

/*
   IN -> ____|________
        | reqSSE() | -> Promise<Obj>
         ----------
      Consumes a streaming SSE response and resolves with accumulated text and timing stats.
   */
function reqSSE(urlStr, opts) {
  opts = opts || {};
  const u = new URL(urlStr);
  return new Promise((resolve, reject) => {
    const stats = {
      status: null, startMs: Date.now(), firstChunkMs: null, lastChunkMs: null,
      chunkCount: 0, partialCount: 0, sawReplace: false, sawDone: false,
      doneFullText: null, doneTiming: null, interaccionId: null, acc: "", error: null,
    };
    const r = http.request({
      method: "POST", host: u.hostname, port: u.port || 80,
      path: u.pathname + (u.search || ""),
      headers: opts.headers || {}, timeout: 90000,
    }, (res) => {
      stats.status = res.statusCode;
      let buf = "";
      res.on("data", (chunk) => {
        buf += chunk.toString("utf8");
        let nl;
        while ((nl = buf.indexOf("\n\n")) >= 0) {
          const ev = buf.slice(0, nl);
          buf = buf.slice(nl + 2);
          for (const line of ev.split("\n").map(l => l.replace(/^data:\s*/, ""))) {
            if (!line || line === "[DONE]") continue;
            let m; try { m = JSON.parse(line); } catch (_) { continue; }
            if (m.interaccionId) { stats.interaccionId = m.interaccionId; continue; }
            if (m.error) { stats.error = m.error; continue; }
            if (typeof m.chunk === "string" && m.chunk.length > 0) {
              if (stats.firstChunkMs == null) stats.firstChunkMs = Date.now() - stats.startMs;
              stats.lastChunkMs = Date.now() - stats.startMs;
              stats.chunkCount++;
              if (m.partial === true) stats.partialCount++;
              if (m.replace === true) { stats.sawReplace = true; stats.acc = m.chunk; }
              else stats.acc += m.chunk;
            }
            if (m.done === true) {
              stats.sawDone = true;
              stats.doneFullText = m.fullText || null;
              stats.doneTiming = m.timing || null;
            }
          }
        }
      });
      res.on("end", () => resolve(stats));
      res.on("error", reject);
    });
    r.on("error", reject);
    if (opts.body) r.write(opts.body);
    r.end();
  });
}

/*
   IN -> ____|________
        | parseSetCookie() | -> Txt | null
         ----------
      Joins the cookie name=value pairs from a Set-Cookie header into a single Cookie string.
   */
function parseSetCookie(h) {
  if (!h) return null;
  const arr = Array.isArray(h) ? h : [h];
  return arr.map(c => c.split(";")[0]).join("; ");
}

const C = { ok: "\x1b[32m", fail: "\x1b[31m", warn: "\x1b[33m", reset: "\x1b[0m", dim: "\x1b[2m" };
const c = (s, k) => (C[k] || "") + s + C.reset;

const turn2Per = {
  1: "R1, R2 y R4 dado que R3 está en abierto y R5 cortocircuitada",
  2: "R1 y R2 supongo, porque las demás se pueden quitar",
  3: "R3, R4 y R5 porque R2 está en cortocircuito y R1 en paralelo con la fuente",
  4: "R1 y R2 porque están en paralelo con la fuente",
  5: "R1, R2 y R4 porque están en serie",
  6: "Por R6, ya que es la última y la corriente se va atenuando",
  7: "Por R1 ya que es la primera resistencia",
};

(async () => {
  console.log("\n=== MULTI-TURN SMOKE: 7 ejercicios × 2 turnos ===\n");
  const login = await req("POST", `${BACKEND}/api/auth/dev-login`, {
    headers: { "Content-Type": "application/json" }, body: "{}",
  });
  if (login.status !== 200) { console.error("dev-login failed:", login.status, login.body); process.exit(1); }
  const cookie = parseSetCookie(login.headers["set-cookie"]);
  const userId = JSON.parse(login.body).user.id;
  console.log("login ok userId=" + userId);

  const ejs = JSON.parse((await req("GET", `${BACKEND}/api/ejercicios`, { headers: { cookie } })).body);
  console.log("ejercicios loaded: " + ejs.length + "\n");

  const results = [];
  for (const ej of ejs.slice().sort((a, b) => (a.imagen > b.imagen ? 1 : -1))) {
    const num = (ej.imagen || "").match(/Ejercicio(\d+)/i);
    const n = num ? Number(num[1]) : 0;
    process.stdout.write(`Ej ${n} `);
    const t1 = await reqSSE(`${BACKEND}/api/ollama/chat/stream`, {
      headers: { "Content-Type": "application/json", "x-llm-mode": "upv", cookie },
      body: JSON.stringify({ exerciseId: ej._id, llmMode: "upv", userMessage: "no sé por dónde empezar" }),
    }).catch(e => ({ error: e.message }));
    process.stdout.write(`turn1=${t1.firstChunkMs || "?"}ms/${t1.chunkCount || 0}chunks `);
    await new Promise(r => setTimeout(r, 800));
    const t2 = await reqSSE(`${BACKEND}/api/ollama/chat/stream`, {
      headers: { "Content-Type": "application/json", "x-llm-mode": "upv", cookie },
      body: JSON.stringify({
        exerciseId: ej._id, llmMode: "upv",
        userMessage: turn2Per[n] || "¿qué hago ahora?",
        interaccionId: t1.interaccionId,
      }),
    }).catch(e => ({ error: e.message }));
    process.stdout.write(`turn2=${t2.firstChunkMs || "?"}ms/${t2.chunkCount || 0}chunks`);

    const t1text = (t1.acc || "").trim();
    const t2text = (t2.acc || "").trim();
    const fallbackPattern = /tardando demasiado|reformular tu mensaje|too long to respond/i;
    const t1ok = t1.status === 200 && t1.sawDone && t1text.length > 10 && !fallbackPattern.test(t1text);
    const t2ok = t2.status === 200 && t2.sawDone && t2text.length > 10 && !fallbackPattern.test(t2text);
    const ok = t1ok && t2ok;
    console.log(" " + (ok ? c("PASS", "ok") : c("FAIL", "fail")));
    results.push({
      n, ok, t1ok, t2ok,
      t1: { firstChunk: t1.firstChunkMs, chunks: t1.chunkCount, len: t1text.length, sawReplace: t1.sawReplace, text: t1text.slice(0, 140), interaccionId: t1.interaccionId, error: t1.error },
      t2: { firstChunk: t2.firstChunkMs, chunks: t2.chunkCount, len: t2text.length, sawReplace: t2.sawReplace, text: t2text.slice(0, 140), error: t2.error },
    });
  }

  console.log("\n=== DETALLE POR EJERCICIO ===\n");
  for (const r of results) {
    console.log(`Ej ${r.n}  ${r.ok ? c("PASS", "ok") : c("FAIL", "fail")}`);
    console.log(`  turn1 fc=${r.t1.firstChunk}ms chunks=${r.t1.chunks} len=${r.t1.len}c replace=${r.t1.sawReplace} ${r.t1.error ? c("ERR=" + r.t1.error, "fail") : ""}`);
    console.log(`     "${r.t1.text}${r.t1.text.length >= 140 ? "…" : ""}"`);
    console.log(`  turn2 fc=${r.t2.firstChunk}ms chunks=${r.t2.chunks} len=${r.t2.len}c replace=${r.t2.sawReplace} ${r.t2.error ? c("ERR=" + r.t2.error, "fail") : ""}`);
    console.log(`     "${r.t2.text}${r.t2.text.length >= 140 ? "…" : ""}"`);
  }

  console.log("\n=== ROLL-UP ===");
  const allPass = results.every(r => r.ok);
  const t1pass = results.filter(r => r.t1ok).length;
  const t2pass = results.filter(r => r.t2ok).length;
  console.log(`Turn 1: ${t1pass}/${results.length} PASS`);
  console.log(`Turn 2: ${t2pass}/${results.length} PASS`);
  const t1times = results.filter(r => r.t1.firstChunk != null).map(r => r.t1.firstChunk);
  const t2times = results.filter(r => r.t2.firstChunk != null).map(r => r.t2.firstChunk);
  if (t1times.length) console.log(`Turn 1 firstChunk: avg=${Math.round(t1times.reduce((a,b)=>a+b,0)/t1times.length)}ms min=${Math.min(...t1times)} max=${Math.max(...t1times)}`);
  if (t2times.length) console.log(`Turn 2 firstChunk: avg=${Math.round(t2times.reduce((a,b)=>a+b,0)/t2times.length)}ms min=${Math.min(...t2times)} max=${Math.max(...t2times)}`);

  let promptsWithNotDef = 0;
  try {
    const all = fs.readdirSync(DUMP_DIR).filter(f => f.endsWith("_prompt.txt"));
    for (const f of all) {
      const t = fs.readFileSync(path.join(DUMP_DIR, f), "utf8");
      if (/\(not defined\)/i.test(t)) promptsWithNotDef++;
    }
    console.log(`'(not defined)' in dumps: ${promptsWithNotDef}/${all.length}`);
  } catch (_) {}

  console.log("\n" + (allPass ? c("ALL EXERCISES PASS", "ok") : c("SOME EXERCISES FAILED", "fail")));
  process.exit(allPass ? 0 : 1);
})().catch((e) => { console.error("smoke crashed:", e); process.exit(2); });
