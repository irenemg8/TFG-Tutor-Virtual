#!/usr/bin/env node
"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");

/*------------------------------------------------------------------------------
            _________________________________________________________
            |                  CONVERSATION 13-TURN SMOKE           |
            |  13-turn smoke conversation against exercise 1 (correct|
            |  R1, R2, R4). For each turn it reports classification, |
            |  detected ACs, decision and response, then runs        |
            |  concrete pedagogical validations.                    |
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
        | loadLatestDump() | -> Obj | null                          |
        ----------------------                                      |
            |                                                       |
            |_______________________________________________________|
------------------------------------------------------------------------------*/

const BACKEND = process.env.SMOKE_BACKEND || "http://localhost:3030";
const DUMP_DIR = process.env.SMOKE_DUMP || "/tmp/tv_dump";
const C = { ok: "\x1b[32m", fail: "\x1b[31m", warn: "\x1b[33m", reset: "\x1b[0m", dim: "\x1b[2m", bold: "\x1b[1m" };
const c = (s, k) => (C[k] || "") + s + C.reset;

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
    const r = http.request({ method, host: u.hostname, port: u.port || 80, path: u.pathname + (u.search || ""), headers: opts.headers || {}, timeout: 60000 }, (res) => {
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
    const stats = { status: null, startMs: Date.now(), firstChunkMs: null, chunkCount: 0, sawReplace: false, sawDone: false, doneTiming: null, interaccionId: null, acc: "", error: null };
    const r = http.request({ method: "POST", host: u.hostname, port: u.port || 80, path: u.pathname + (u.search || ""), headers: opts.headers || {}, timeout: 90000 }, (res) => {
      stats.status = res.statusCode;
      let buf = "";
      res.on("data", (chunk) => {
        buf += chunk.toString("utf8");
        let nl;
        while ((nl = buf.indexOf("\n\n")) >= 0) {
          const ev = buf.slice(0, nl); buf = buf.slice(nl + 2);
          for (const line of ev.split("\n").map(l => l.replace(/^data:\s*/, ""))) {
            if (!line || line === "[DONE]") continue;
            let m; try { m = JSON.parse(line); } catch (_) { continue; }
            if (m.interaccionId) { stats.interaccionId = m.interaccionId; continue; }
            if (m.error) { stats.error = m.error; continue; }
            if (typeof m.chunk === "string" && m.chunk.length > 0) {
              if (stats.firstChunkMs == null) stats.firstChunkMs = Date.now() - stats.startMs;
              stats.chunkCount++;
              if (m.replace === true) { stats.sawReplace = true; stats.acc = m.chunk; }
              else stats.acc += m.chunk;
            }
            if (m.done === true) { stats.sawDone = true; stats.doneTiming = m.timing || null; }
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
function parseSetCookie(h) { if (!h) return null; const arr = Array.isArray(h) ? h : [h]; return arr.map(c => c.split(";")[0]).join("; "); }

/*
   IN -> ____|________
        | loadLatestDump() | -> Obj | null
         ----------
      Reads and parses the most recent debug summary dump from the dump directory.
   */
function loadLatestDump() {
  try {
    const all = fs.readdirSync(DUMP_DIR).filter(f => f.endsWith("_summary.txt"))
      .map(f => ({ f, mtime: fs.statSync(path.join(DUMP_DIR, f)).mtime }))
      .sort((a, b) => b.mtime - a.mtime);
    if (!all.length) return null;
    return JSON.parse(fs.readFileSync(path.join(DUMP_DIR, all[0].f), "utf8"));
  } catch (_) { return null; }
}

const TURNS = [
  { msg: "Hola",                                                             expectClass: "greeting",            note: "Greeting handler" },
  { msg: "R1",                                                               expectClass: "partial_correct",     note: "R1 ok pero falta R2,R4 — AC9 razonamiento local" },
  { msg: "R2",                                                               expectClass: "partial_correct",     note: "R2 ok pero falta R1,R4 — AC9" },
  { msg: "R1 y R4",                                                          expectClass: "partial_correct",     note: "R1,R4 ok, falta R2" },
  { msg: "R1 R4 y R5",                                                       expectClass: "partial_correct",     note: "Mix: R1,R4 ok + R5 mal — AC6 cortocircuito" },
  { msg: "R1 R5",                                                            expectClass: "partial_correct",     note: "Mix: R1 ok + R5 mal — AC6" },
  { msg: "R3",                                                               expectClass: "wrong_answer",        note: "Solo R3 (mal) — AC1 interruptor abierto" },
  { msg: "R1 R2 R3",                                                         expectClass: "partial_correct",     note: "Mix: R1,R2 ok + R3 mal — AC1" },
  { msg: "R1 R4 y R5",                                                       expectClass: "partial_correct",     note: "Repite turno 5 → debe escalar / no repetir pregunta" },
  { msg: "R1 R2 R4 porque R3 está en circuito abierto",                      expectClass: "correct_good_reasoning", note: "Respuesta CORRECTA con razonamiento" },
  { msg: "R5 si que influye",                                                expectClass: "wrong_answer",        note: "Insiste en R5 después de respuesta correcta — tutor debe NO ceder" },
  { msg: "te he dicho que R5 si influye",                                    expectClass: "wrong_answer",        note: "Frustración + insistencia — tutor debe acknowledge frustración + sostener AC6" },
  { msg: "R1 R2 y R4",                                                       expectClass: "correct_no_reasoning",note: "Vuelve a la respuesta correcta sin razón — pedir justificación" },
];

(async () => {
  console.log(c("\n=== CONVERSACIÓN 13-TURNOS Ej 1 ===\n", "bold"));
  const login = await req("POST", `${BACKEND}/api/auth/dev-login`, { headers: { "Content-Type": "application/json" }, body: "{}" });
  if (login.status !== 200) { console.error("login failed"); process.exit(1); }
  const cookie = parseSetCookie(login.headers["set-cookie"]);
  const ejs = JSON.parse((await req("GET", `${BACKEND}/api/ejercicios`, { headers: { cookie } })).body);
  const ej1 = ejs.find(e => /Ejercicio1/i.test(e.imagen || ""));
  if (!ej1) { console.error("Ej 1 not found"); process.exit(1); }
  console.log("ejercicioId=" + ej1._id.slice(0, 8) + " | userId=" + JSON.parse(login.body).user.id.slice(0, 8) + "\n");

  let interaccionId = null;
  const results = [];

  for (let i = 0; i < TURNS.length; i++) {
    const turn = TURNS[i];
    const turnNo = i + 1;
    process.stdout.write("T" + String(turnNo).padStart(2) + " " + JSON.stringify(turn.msg).slice(0, 50).padEnd(52) + " ");
    const t = await reqSSE(`${BACKEND}/api/ollama/chat/stream`, {
      headers: { "Content-Type": "application/json", "x-llm-mode": "upv", cookie },
      body: JSON.stringify({ exerciseId: ej1._id, llmMode: "upv", userMessage: turn.msg, interaccionId: interaccionId }),
    }).catch(e => ({ error: e.message }));
    if (!interaccionId && t.interaccionId) interaccionId = t.interaccionId;
    process.stdout.write("fc=" + (t.firstChunkMs || "?") + "ms ch=" + (t.chunkCount || 0));
    await new Promise(r => setTimeout(r, 500));
    const dump = loadLatestDump();
    const cls = dump && dump.classification ? dump.classification.type : "?";
    const acs = dump && dump.detectedACs ? dump.detectedACs.map(a => a.id + "@" + a.confidence.toFixed(2)).join(",") : "";
    const responseText = (t.acc || "").trim();
    const fallback = /tardando demasiado|reformular tu mensaje/i.test(responseText);
    const okClass = cls === turn.expectClass;
    process.stdout.write(" cls=" + (okClass ? c(cls, "ok") : c(cls + "/exp:" + turn.expectClass, "warn")));
    if (acs) process.stdout.write(" ACs=" + acs);
    console.log(fallback ? c(" FALLBACK", "fail") : "");
    console.log("    → " + responseText.slice(0, 200) + (responseText.length > 200 ? "…" : ""));
    results.push({ turnNo, turn, t, dump, cls, acs, okClass, responseText, fallback });
  }

  console.log(c("\n=== ANÁLISIS PEDAGÓGICO ===\n", "bold"));
  for (const r of results) {
    const issues = [];
    const txt = r.responseText.toLowerCase();
    if (/r1[, ]+r2[, ]+(y )?r4/.test(txt) && r.turnNo < 10) issues.push("REVELÓ respuesta correcta R1,R2,R4");
    if (/(perfecto|correcto|exacto|muy bien|excelente)/.test(txt) && r.turn.expectClass !== "correct_good_reasoning" && r.turn.expectClass !== "greeting") {
      issues.push("Confirma con elogio pleno cuando classifier=" + r.cls);
    }
    if (r.fallback) issues.push("FALLBACK del orchestrator");
    if (!r.okClass && r.turn.expectClass !== "correct_good_reasoning") issues.push("Clasificación: esperaba " + r.turn.expectClass + " obtuvo " + r.cls);
    if (r.responseText.length < 15) issues.push("Respuesta vacía o ultra-corta");
    if (issues.length > 0) {
      console.log(c("T" + r.turnNo + " " + r.turn.note, "fail"));
      for (const x of issues) console.log("   - " + x);
    } else {
      console.log(c("T" + r.turnNo + " " + r.turn.note + " ✓", "ok"));
    }
  }

  if (results[4] && results[8]) {
    const q5 = results[4].responseText;
    const q9 = results[8].responseText;
    if (q5 === q9 || q5.toLowerCase().slice(0, 80) === q9.toLowerCase().slice(0, 80)) {
      console.log(c("\nANTI-REPETICIÓN FAIL: Turn 5 y Turn 9 (mismo input 'R1 R4 y R5') tienen respuesta idéntica.", "fail"));
    } else {
      console.log(c("\nANTI-REPETICIÓN OK: Turn 5 y Turn 9 difieren.", "ok"));
    }
  }

  for (const r of results) {
    if (r.responseText.includes("<FIN_EJERCICIO>")) {
      console.log(c("\nFIN_EJERCICIO emitido en turn " + r.turnNo, r.turnNo >= 10 ? "ok" : "fail"));
    }
  }

  const times = results.filter(r => r.t.firstChunkMs != null).map(r => r.t.firstChunkMs);
  if (times.length) console.log(`\nfirstChunk avg=${Math.round(times.reduce((a,b)=>a+b,0)/times.length)}ms min=${Math.min(...times)} max=${Math.max(...times)}`);
})().catch(e => { console.error("crash:", e); process.exit(2); });
