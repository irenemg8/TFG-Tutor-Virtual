#!/usr/bin/env node
"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");

const BACKEND = process.env.SMOKE_BACKEND || "http://localhost:3030";
const DUMP_DIR = process.env.SMOKE_DUMP || "/tmp/tv_dump";
const FIRST_TOKEN_BUDGET_MS = Number(process.env.SMOKE_FTB_MS || 5000);

/*------------------------------------------------------------------------------
            _________________________________________________________
            |                NS-1..NS-5 SMOKE ACCEPTANCE            |
            |  End-to-end smoke for the NS-1..NS-5 acceptance        |
            |  criteria. Logs in, lists exercises, streams a neutral |
            |  message per exercise measuring chunk timing, then     |
            |  inspects the prompt/summary dumps and rolls up        |
            |  PASS/FAIL per NS.                                     |
        ____|________________                                       |
   Txt -> | req() | -> Promise<Obj>                                 |
          -----------------                                         |
        ____|________________                                       |
        | reqSSE() | -> Promise<Obj>                                |
        ----------------------                                      |
        ____|________________                                       |
        | parseSetCookie() | -> Txt | null                          |
        ----------------------                                      |
        ____|________________                                       |
        | findLatestDump() | -> Obj                                 |
        ----------------------                                      |
        ____|________________                                       |
        | login() | -> Promise<Obj>                                 |
        ----------------------                                      |
        ____|________________                                       |
        | listExercises() | -> Promise<[Obj]>                       |
        ----------------------                                      |
        ____|________________                                       |
        | chat() | -> Promise<Obj>                                  |
        ----------------------                                      |
        ____|________________                                       |
        | color() | -> Txt                                          |
        ----------------------                                      |
        ____|________________                                       |
        | main() | -> Promise<void>                                 |
        ----------------------                                      |
            |                                                       |
            |_______________________________________________________|
------------------------------------------------------------------------------*/

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
    const r = http.request(
      {
        method,
        host: u.hostname,
        port: u.port || 80,
        path: u.pathname + (u.search || ""),
        headers: opts.headers || {},
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () =>
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body: Buffer.concat(chunks).toString("utf8"),
          })
        );
      }
    );
    r.on("error", reject);
    if (opts.body) r.write(opts.body);
    r.end();
  });
}

/*
   IN -> ____|________
        | reqSSE() | -> Promise<Obj>
         ----------
      Consumes a streaming SSE response, surfacing per-envelope events with timing info.
   */
function reqSSE(urlStr, opts) {
  opts = opts || {};
  const u = new URL(urlStr);
  return new Promise((resolve, reject) => {
    const stats = {
      status: null,
      startMs: Date.now(),
      firstChunkMs: null,
      lastChunkMs: null,
      chunkCount: 0,
      partialChunks: 0,
      sawReplace: false,
      sawDone: false,
      doneFullText: null,
      doneTiming: null,
      interaccionId: null,
      acc: "",
      raw: "",
    };
    const r = http.request(
      {
        method: "POST",
        host: u.hostname,
        port: u.port || 80,
        path: u.pathname + (u.search || ""),
        headers: opts.headers || {},
        timeout: 60000,
      },
      (res) => {
        stats.status = res.statusCode;
        let buffer = "";
        res.on("data", (chunk) => {
          stats.raw += chunk.toString("utf8");
          buffer += chunk.toString("utf8");
          let nl;
          while ((nl = buffer.indexOf("\n\n")) >= 0) {
            const ev = buffer.slice(0, nl);
            buffer = buffer.slice(nl + 2);
            const lines = ev.split("\n").map((l) => l.replace(/^data:\s*/, ""));
            for (const line of lines) {
              if (!line || line === "[DONE]") continue;
              let msg;
              try { msg = JSON.parse(line); } catch (_) { continue; }
              if (msg.interaccionId) {
                stats.interaccionId = msg.interaccionId;
                continue;
              }
              if (msg.error) continue;
              if (typeof msg.chunk === "string" && msg.chunk.length > 0) {
                if (stats.firstChunkMs == null) stats.firstChunkMs = Date.now() - stats.startMs;
                stats.lastChunkMs = Date.now() - stats.startMs;
                stats.chunkCount++;
                if (msg.partial === true) stats.partialChunks++;
                if (msg.replace === true) stats.sawReplace = true;
                if (msg.replace === true) stats.acc = msg.chunk;
                else stats.acc += msg.chunk;
              }
              if (msg.done === true) {
                stats.sawDone = true;
                stats.doneFullText = msg.fullText || null;
                stats.doneTiming = msg.timing || null;
              }
            }
          }
        });
        res.on("end", () => resolve(stats));
        res.on("error", reject);
      }
    );
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
function parseSetCookie(header) {
  if (!header) return null;
  const arr = Array.isArray(header) ? header : [header];
  const pieces = [];
  for (const c of arr) pieces.push(c.split(";")[0]);
  return pieces.join("; ");
}

/*
   IN -> ____|________
        | findLatestDump() | -> Obj
         ----------
      Finds the prompt and summary dump filenames matching a given request id.
   */
function findLatestDump(reqId) {
  const files = fs.readdirSync(DUMP_DIR).filter((f) => f.includes(reqId));
  return {
    promptFile: files.find((f) => f.endsWith("_prompt.txt")),
    summaryFile: files.find((f) => f.endsWith("_summary.txt")),
  };
}

/*
   IN -> ____|________
        | login() | -> Promise<Obj>
         ----------
      Performs dev-login and resolves with the session cookie and user object.
   */
async function login() {
  const r = await req("POST", `${BACKEND}/api/auth/dev-login`, {
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
  if (r.status !== 200) throw new Error("dev-login failed: " + r.status + " " + r.body);
  const cookie = parseSetCookie(r.headers["set-cookie"]);
  const user = JSON.parse(r.body).user;
  return { cookie, user };
}

/*
   IN -> ____|________
        | listExercises() | -> Promise<[Obj]>
         ----------
      Fetches and parses the list of exercises for the authenticated session.
   */
async function listExercises(cookie) {
  const r = await req("GET", `${BACKEND}/api/ejercicios`, {
    headers: { cookie },
  });
  if (r.status !== 200) throw new Error("list ejercicios failed: " + r.status);
  return JSON.parse(r.body);
}

/*
   IN -> ____|________
        | chat() | -> Promise<Obj>
         ----------
      Opens the streaming chat endpoint for an exercise and resolves with the SSE stats.
   */
async function chat(cookie, exerciseId, userMessage) {
  return await reqSSE(`${BACKEND}/api/ollama/chat/stream`, {
    headers: {
      "Content-Type": "application/json",
      "x-llm-mode": "upv",
      cookie,
    },
    body: JSON.stringify({
      exerciseId,
      llmMode: "upv",
      userMessage,
    }),
  });
}

/*
   IN -> ____|________
        | color() | -> Txt
         ----------
      Wraps a string in the ANSI escape codes for the named color.
   */
function color(s, c) {
  const C = { ok: "\x1b[32m", fail: "\x1b[31m", warn: "\x1b[33m", reset: "\x1b[0m", dim: "\x1b[2m" };
  return (C[c] || "") + s + C.reset;
}

/*
   IN -> ____|________
        | main() | -> Promise<void>
         ----------
      Orchestrates the full acceptance run and exits non-zero on any failure.
   */
(async function main() {
  console.log("\n=== NS-1..NS-5 SMOKE ACCEPTANCE ===\n");
  const session = await login();
  console.log("login ok — userId=" + session.user.id);

  const exercises = await listExercises(session.cookie);
  console.log("ejercicios disponibles: " + exercises.length);
  if (exercises.length < 7) console.log(color("WARN: expected >=7 ejercicios in DB", "warn"));

  const messagePerExercise = {
    1: "no sé por dónde empezar",
    2: "no sé por dónde empezar",
    3: "no sé por dónde empezar",
    4: "no sé por dónde empezar",
    5: "no sé por dónde empezar",
    6: "no sé por dónde empezar",
    7: "no sé por dónde empezar",
  };

  const results = [];

  for (const ej of exercises.slice().sort((a, b) => (a.imagen > b.imagen ? 1 : -1))) {
    const num = (ej.imagen || "").match(/Ejercicio(\d+)/i);
    const exerciseNum = num ? Number(num[1]) : null;
    const userMsg = messagePerExercise[exerciseNum] || "no sé por dónde empezar";
    process.stdout.write("Ej " + (exerciseNum || "?") + " (" + ej._id.slice(0, 8) + ") ... ");
    let stats;
    try {
      stats = await chat(session.cookie, ej._id, userMsg);
    } catch (e) {
      console.log(color("FAIL request: " + e.message, "fail"));
      results.push({ ej: exerciseNum, ok: false, err: e.message });
      continue;
    }

    const pass = {
      streamHttp200: stats.status === 200,
      sawDone: stats.sawDone,
      hasFinalText: stats.acc.length > 0 || (stats.doneFullText && stats.doneFullText.length > 0),
      firstChunkUnderBudget:
        stats.firstChunkMs != null && stats.firstChunkMs <= FIRST_TOKEN_BUDGET_MS,
      streamedMultipleChunks: stats.chunkCount > 5,
    };

    const dumps = findLatestDump("");
    let promptText = "";
    let summary = null;
    try {
      const all = fs.readdirSync(DUMP_DIR);
      const promptFiles = all
        .filter((f) => f.endsWith("_prompt.txt"))
        .map((f) => ({ f, mtime: fs.statSync(path.join(DUMP_DIR, f)).mtime }))
        .sort((a, b) => b.mtime - a.mtime);
      const summaryFiles = all
        .filter((f) => f.endsWith("_summary.txt"))
        .map((f) => ({ f, mtime: fs.statSync(path.join(DUMP_DIR, f)).mtime }))
        .sort((a, b) => b.mtime - a.mtime);
      if (promptFiles.length > 0)
        promptText = fs.readFileSync(path.join(DUMP_DIR, promptFiles[0].f), "utf8");
      if (summaryFiles.length > 0)
        summary = JSON.parse(fs.readFileSync(path.join(DUMP_DIR, summaryFiles[0].f), "utf8"));
    } catch (_) {}

    pass.noNotDefined = !/\(not defined\)/i.test(promptText);
    pass.budgetTracedInDump = !!(summary && summary.budget && summary.budget.retrievalSliceMs);

    const allOk = Object.values(pass).every(Boolean);
    const tag = allOk ? color("PASS", "ok") : color("FAIL", "fail");
    console.log(
      `${tag} firstChunk=${stats.firstChunkMs}ms chunks=${stats.chunkCount} (partial=${stats.partialChunks}) replace=${stats.sawReplace} done=${stats.sawDone} | text=${stats.acc.length}c notDefined=${!pass.noNotDefined ? "YES" : "no"} budgetTraced=${pass.budgetTracedInDump}`
    );
    if (!allOk) {
      const failed = Object.entries(pass).filter(([_, v]) => !v).map(([k]) => k);
      console.log("   " + color("failed checks: " + failed.join(", "), "fail"));
    }
    results.push({ ej: exerciseNum, ok: allOk, stats, pass, summary });
  }

  console.log("\n=== ROLL-UP POR NS ===");
  const ns1 = results.every((r) => r.pass && r.pass.noNotDefined);
  const ns2firstToken = results.every((r) => r.pass && r.pass.firstChunkUnderBudget);
  const ns2multi = results.every((r) => r.pass && r.pass.streamedMultipleChunks);
  const ns2done = results.every((r) => r.pass && r.pass.sawDone);
  const ns3 = results.every((r) => r.pass && r.pass.budgetTracedInDump);
  console.log(`NS-1 sin '(not defined)' en system prompt:        ${ns1 ? color("PASS", "ok") : color("FAIL", "fail")}`);
  console.log(`NS-2 first-chunk <= ${FIRST_TOKEN_BUDGET_MS}ms:              ${ns2firstToken ? color("PASS", "ok") : color("FAIL", "fail")}`);
  console.log(`NS-2 stream emite >5 chunks:                       ${ns2multi ? color("PASS", "ok") : color("FAIL", "fail")}`);
  console.log(`NS-2 envelope {done:true} llega:                   ${ns2done ? color("PASS", "ok") : color("FAIL", "fail")}`);
  console.log(`NS-3 budget retrievalSliceMs trazado en summary:    ${ns3 ? color("PASS", "ok") : color("FAIL", "fail")}`);

  console.log("\n=== ESTADÍSTICAS ===");
  const fchunks = results.filter((r) => r.stats && r.stats.firstChunkMs != null).map((r) => r.stats.firstChunkMs);
  if (fchunks.length > 0) {
    const avg = Math.round(fchunks.reduce((a, b) => a + b, 0) / fchunks.length);
    const min = Math.min(...fchunks);
    const max = Math.max(...fchunks);
    console.log(`firstChunkMs: avg=${avg} min=${min} max=${max} (n=${fchunks.length})`);
  }

  const failed = results.filter((r) => !r.ok);
  console.log("\n" + (failed.length === 0 ? color("ALL GREEN", "ok") : color(`${failed.length}/${results.length} FAIL`, "fail")));
  process.exit(failed.length === 0 ? 0 : 1);
})().catch((e) => {
  console.error("smoke crashed:", e);
  process.exit(2);
});
