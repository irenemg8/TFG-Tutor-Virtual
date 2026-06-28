#!/usr/bin/env node
"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

/*------------------------------------------------------------------------------
            _________________________________________________________
            |                     MODEL BENCHMARK                   |
            |  End-to-end harness that compares a set of PoliGPT LLM |
            |  models over a fixed 7-turn conversation. Per model it |
            |  swaps OLLAMA_MODEL in .env, restarts the backend,     |
            |  logs in, runs the turns measuring latency and flags,  |
            |  then aggregates metrics and writes JSON + Markdown.   |
        ____|________________                                       |
   Txt -> | req() | -> Promise<Obj>                                 |
          -----------------                                         |
        ____|________________                                       |
   Txt -> | reqSSE() | -> Promise<Obj>                              |
          -----------------                                         |
        ____|________________                                       |
   Txt -> | parseSetCookie() | -> Txt | null                        |
          -----------------                                         |
        ____|________________                                       |
   void -> | backupEnv() | -> void                                  |
          -----------------                                         |
        ____|________________                                       |
   void -> | restoreEnv() | -> void                                 |
          -----------------                                         |
        ____|________________                                       |
   Txt -> | setEnvModel() | -> void                                 |
          -----------------                                         |
        ____|________________                                       |
   void -> | killExistingBackend() | -> Promise<void>               |
          -----------------                                         |
        ____|________________                                       |
   Txt -> | startBackend() | -> Promise<Obj>                        |
          -----------------                                         |
        ____|________________                                       |
   Txt -> | detectFlags() | -> Obj                                  |
          -----------------                                         |
        ____|________________                                       |
   Txt -> | parseLogStats() | -> [Obj]                              |
          -----------------                                         |
        ____|________________                                       |
   [R] -> | median() | -> R | null                                 |
          -----------------                                         |
        ____|________________                                       |
   [R] -> | p95() | -> R | null                                    |
          -----------------                                         |
        ____|________________                                       |
   [R] -> | avg() | -> R | null                                    |
          -----------------                                         |
        ____|________________                                       |
   N -> | rate() | -> R                                             |
          -----------------                                         |
        ____|________________                                       |
   [Obj] -> | aggregate() | -> Obj                                  |
          -----------------                                         |
        ____|________________                                       |
   R -> | fmtMs() | -> Txt                                          |
          -----------------                                         |
        ____|________________                                       |
   R -> | fmtPct() | -> Txt                                         |
          -----------------                                         |
        ____|________________                                       |
   Obj -> | buildReport() | -> Txt                                  |
          -----------------                                         |
        ____|________________                                       |
   Txt -> | runOneModel() | -> Promise<Obj>                         |
          -----------------                                         |
            |                                                       |
            |_______________________________________________________|
------------------------------------------------------------------------------*/

const ROOT = path.resolve(__dirname, "..", "..");
const ENV_PATH = path.join(ROOT, ".env");
const ENV_BACKUP_PATH = path.join(ROOT, ".env.benchmark-backup");
const BACKEND_LOG_DIR = "/tmp";

const BACKEND = process.env.BENCHMARK_BACKEND || "http://localhost:3030";
const TIMEOUT_MS = Number(process.env.BENCHMARK_TIMEOUT || 180000);
const MODELS = (process.env.BENCHMARK_MODELS ||
  "qwen2.5:latest,qwen3:8b,llama3.1:8b,gemma3:27b,llama3.3:70b"
).split(",").map((s) => s.trim()).filter(Boolean);

const C = { ok: "\x1b[32m", fail: "\x1b[31m", warn: "\x1b[33m", reset: "\x1b[0m", dim: "\x1b[2m", bold: "\x1b[1m", cyan: "\x1b[36m" };
const c = (s, k) => (C[k] || "") + s + C.reset;

const TURNS = [
  { tag: "T0_warmup",      msg: "hola",                                     warmup: true },
  { tag: "T1_partial_R1",  msg: "R1" },
  { tag: "T2_concept",     msg: "Está en un divisor de tensión" },
  { tag: "T3_dont_know",   msg: "ni idea" },
  { tag: "T4_topology",    msg: "Porque está conectado uno al lado de otro" },
  { tag: "T5_voltage_path", msg: "Porque el voltaje sale de R1 y va a Tierra" },
  { tag: "T6_nodes",       msg: "N1 y N2" },
  { tag: "T7_zero",        msg: "A 0" },
];

/*
   IN -> ____|____
        | req() | -> Promise<Obj>
         ----------
      Performs a buffered HTTP request and resolves status, headers and body (Txt, Txt, Obj).
   */
function req(method, urlStr, opts) {
  opts = opts || {};
  const u = new URL(urlStr);
  return new Promise((resolve, reject) => {
    const r = http.request({
      method, host: u.hostname, port: u.port || 80,
      path: u.pathname + (u.search || ""),
      headers: opts.headers || {}, timeout: 60000,
    }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") }));
    });
    r.on("error", reject);
    r.on("timeout", () => { r.destroy(new Error("timeout")); });
    if (opts.body) r.write(opts.body);
    r.end();
  });
}

/*
   IN -> ____|________
        | reqSSE() | -> Promise<Obj>
         -----------
      Streams an SSE chat response and collects latency, chunks and accumulated text (Txt, Obj).
   */
function reqSSE(urlStr, opts) {
  opts = opts || {};
  const u = new URL(urlStr);
  return new Promise((resolve) => {
    const stats = {
      status: null, startMs: Date.now(), firstChunkMs: null, chunkCount: 0,
      sawDone: false, interaccionId: null, acc: "", error: null, totalMs: null,
    };
    const r = http.request({
      method: "POST", host: u.hostname, port: u.port || 80,
      path: u.pathname + (u.search || ""),
      headers: opts.headers || {}, timeout: TIMEOUT_MS,
    }, (res) => {
      stats.status = res.statusCode;
      let buf = "";
      res.on("data", (chunk) => {
        buf += chunk.toString("utf8");
        let nl;
        while ((nl = buf.indexOf("\n\n")) >= 0) {
          const ev = buf.slice(0, nl); buf = buf.slice(nl + 2);
          for (const line of ev.split("\n").map((l) => l.replace(/^data:\s*/, ""))) {
            if (!line || line === "[DONE]") continue;
            let m;
            try { m = JSON.parse(line); } catch (_) { continue; }
            if (m.interaccionId && !stats.interaccionId) { stats.interaccionId = m.interaccionId; continue; }
            if (m.error) { stats.error = m.error; continue; }
            if (typeof m.chunk === "string" && m.chunk.length > 0) {
              if (stats.firstChunkMs == null) stats.firstChunkMs = Date.now() - stats.startMs;
              stats.chunkCount++;
              if (m.replace === true) stats.acc = m.chunk; else stats.acc += m.chunk;
            }
            if (m.done === true) stats.sawDone = true;
          }
        }
      });
      res.on("end", () => { stats.totalMs = Date.now() - stats.startMs; resolve(stats); });
    });
    r.on("error", (e) => { stats.error = e.message; stats.totalMs = Date.now() - stats.startMs; resolve(stats); });
    r.on("timeout", () => { stats.error = "timeout"; stats.totalMs = Date.now() - stats.startMs; r.destroy(); resolve(stats); });
    if (opts.body) r.write(opts.body);
    r.end();
  });
}

/*
   IN -> ____|______________
        | parseSetCookie() | -> Txt | null
         -----------------
      Collapses a Set-Cookie header into a single cookie string (Txt | [Txt]).
   */
function parseSetCookie(h) {
  if (!h) return null;
  const arr = Array.isArray(h) ? h : [h];
  return arr.map((c) => c.split(";")[0]).join("; ");
}

/*
   IN -> ____|___________
        | backupEnv() | -> void
         -------------
      Copies .env to a one-time backup so it can be restored after the run.
   */
function backupEnv() {
  if (!fs.existsSync(ENV_BACKUP_PATH)) {
    fs.copyFileSync(ENV_PATH, ENV_BACKUP_PATH);
    console.log(c("[bench] .env backed up to " + ENV_BACKUP_PATH, "dim"));
  }
}

/*
   IN -> ____|____________
        | restoreEnv() | -> void
         --------------
      Restores .env from the backup and deletes the backup file.
   */
function restoreEnv() {
  if (fs.existsSync(ENV_BACKUP_PATH)) {
    fs.copyFileSync(ENV_BACKUP_PATH, ENV_PATH);
    fs.unlinkSync(ENV_BACKUP_PATH);
    console.log(c("[bench] .env restored from backup", "dim"));
  }
}

/*
   IN -> ____|_____________
        | setEnvModel() | -> void
         ---------------
      Writes OLLAMA_MODEL=<model> into .env, replacing or appending it (Txt).
   */
function setEnvModel(model) {
  let txt = fs.readFileSync(ENV_PATH, "utf8");
  if (/^OLLAMA_MODEL=/m.test(txt)) {
    txt = txt.replace(/^OLLAMA_MODEL=.*$/m, "OLLAMA_MODEL=" + model);
  } else {
    txt += "\nOLLAMA_MODEL=" + model + "\n";
  }
  fs.writeFileSync(ENV_PATH, txt);
}

/*
   IN -> ____|____________________
        | killExistingBackend() | -> Promise<void>
         ----------------------
      Kills any process listening on the backend port.
   */
async function killExistingBackend() {
  try {
    await new Promise((resolve) => {
      const p = spawn("bash", ["-c", "lsof -tiTCP:3030 -sTCP:LISTEN 2>/dev/null | xargs -r kill 2>/dev/null; sleep 1"]);
      p.on("close", () => resolve());
    });
  } catch (_) {}
}

/*
   IN -> ____|______________
        | startBackend() | -> Promise<Obj>
         ----------------
      Spawns the backend detached and waits for health plus warmup (Txt).
   */
async function startBackend(model) {
  const logPath = path.join(BACKEND_LOG_DIR, "backend-bench-" + model.replace(/[:\/]/g, "_") + ".log");
  const out = fs.openSync(logPath, "w");
  const child = spawn("node", ["src/index.js"], {
    cwd: ROOT, detached: true, stdio: ["ignore", out, out],
  });
  child.unref();
  const start = Date.now();
  let warmedUp = false;
  while (Date.now() - start < 90000) {
    await new Promise((r) => setTimeout(r, 1500));
    try {
      const h = await req("GET", BACKEND + "/api/health");
      if (h.status === 200) {
        const log = fs.readFileSync(logPath, "utf8");
        if (/Warmup OK/.test(log) || /Hex container ready/.test(log)) {
          warmedUp = true;
          break;
        }
      }
    } catch (_) {}
  }
  return { pid: child.pid, logPath, warmedUp };
}

const NON_LATIN_RE = /[Ѐ-ӿԀ-ԯ԰-֏֐-׿؀-ۿ܀-ݏऀ-ॿ฀-๿぀-ゟ゠-ヿ㄀-ㄯ㐀-䶿一-鿿가-힯＀-￯豈-﫿]/;
/*
   IN -> ____|_____________
        | detectFlags() | -> Obj
         ---------------
      Derives per-turn heuristics (multi-question, non-Latin, English, length) from text (Txt).
   */
function detectFlags(text) {
  if (!text) return { multiQuestion: false, nonLatin: false, looksEnglish: false, len: 0, qCount: 0 };
  const qCount = (text.match(/\?/g) || []).length;
  const tokens = text.toLowerCase().match(/\b[a-z]+\b/g) || [];
  const enWords = ["the", "is", "you", "what", "of", "to", "and", "consider", "are", "do", "this", "that", "if", "how"];
  let enHits = 0;
  for (const t of tokens) if (enWords.indexOf(t) >= 0) enHits++;
  return {
    multiQuestion: qCount >= 2,
    nonLatin: NON_LATIN_RE.test(text),
    looksEnglish: enHits >= 3,
    len: text.length,
    qCount: qCount,
  };
}

/*
   IN -> ____|_______________
        | parseLogStats() | -> [Obj]
         -----------------
      Parses backend log lines into per-request metrics for one interaction (Txt, Txt).
   */
function parseLogStats(logPath, interaccionId) {
  if (!fs.existsSync(logPath)) return [];
  const log = fs.readFileSync(logPath, "utf8");
  const lines = log.split("\n");
  const byReq = {};
  for (const ln of lines) {
    const m = ln.match(/\[req(\d+)\]/);
    if (!m) continue;
    const reqId = "req" + m[1];
    byReq[reqId] = byReq[reqId] || { reqId, lines: [], interaccionId: null };
    byReq[reqId].lines.push(ln);
    const idMatch = ln.match(/interaccionId=([0-9a-f-]{36})/);
    if (idMatch) byReq[reqId].interaccionId = idMatch[1];
  }
  const reqs = Object.values(byReq).filter((r) => r.interaccionId === interaccionId);
  return reqs.map((r) => {
    const summaryLn = r.lines.find((l) => /📊 SUMMARY/.test(l)) || "";
    const totalMs = (summaryLn.match(/totalMs=(\d+)/) || [])[1];
    const llmRetries = (summaryLn.match(/llmRetries=(\d+)/) || [])[1];
    const guardrailsViolated = (summaryLn.match(/guardrailsViolated=(\d+)/) || [])[1];
    const llmTotalMs = (summaryLn.match(/llmTotalMs=(\d+)/) || [])[1];
    const surgicalFixes = (summaryLn.match(/surgicalFixes=(\d+)/) || [])[1];
    const endLn = r.lines.find((l) => /◀ END/.test(l)) || "";
    const classification = (endLn.match(/class=(\S+)/) || [])[1];
    const decision = (endLn.match(/decision=(\S+)/) || [])[1];
    const violatedNames = new Set();
    for (const ln of r.lines) {
      const vm = ln.match(/GUARDRAIL_CHECK name=(\S+)\s+violated=true/);
      if (vm) violatedNames.add(vm[1]);
    }
    return {
      reqId: r.reqId,
      totalMs: totalMs ? Number(totalMs) : null,
      llmTotalMs: llmTotalMs ? Number(llmTotalMs) : null,
      llmRetries: llmRetries ? Number(llmRetries) : 0,
      surgicalFixes: surgicalFixes ? Number(surgicalFixes) : 0,
      guardrailsViolated: guardrailsViolated ? Number(guardrailsViolated) : 0,
      violatedNames: Array.from(violatedNames),
      classification: classification || null,
      decision: decision || null,
    };
  });
}

/*
   IN -> ____|_______
        | median() | -> R | null
         ----------
      Returns the median of a numeric array, or null when empty ([R]).
   */
function median(arr) {
  if (arr.length === 0) return null;
  const s = arr.slice().sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[mid - 1] + s[mid]) / 2 : s[mid];
}
/*
   IN -> ____|____
        | p95() | -> R | null
         -------
      Returns the 95th-percentile value of a numeric array, or null when empty ([R]).
   */
function p95(arr) {
  if (arr.length === 0) return null;
  const s = arr.slice().sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(s.length * 0.95))];
}
/*
   IN -> ____|____
        | avg() | -> R | null
         -------
      Returns the arithmetic mean of a numeric array, or null when empty ([R]).
   */
function avg(arr) {
  if (arr.length === 0) return null;
  return arr.reduce((s, v) => s + v, 0) / arr.length;
}
/*
   IN -> ____|_____
        | rate() | -> R
         --------
      Returns num/den, or 0 when den is 0 (N, N).
   */
function rate(num, den) { return den === 0 ? 0 : num / den; }

/*
   IN -> ____|__________
        | aggregate() | -> Obj
         ------------
      Aggregates measured turns into latency, retry, violation and drift stats ([Obj]).
   */
function aggregate(turns) {
  const measured = turns.filter((t) => !t.warmup && t.ok);
  const lat = measured.map((t) => t.totalMs).filter((x) => x != null);
  const llmLat = measured.map((t) => t.llmTotalMs).filter((x) => x != null);
  const retries = measured.filter((t) => (t.llmRetries || 0) > 0).length;
  const violations = {};
  for (const t of measured) {
    for (const v of t.violatedNames || []) {
      violations[v] = (violations[v] || 0) + 1;
    }
  }
  const multiQ = measured.filter((t) => t.flags?.multiQuestion).length;
  const nonLat = measured.filter((t) => t.flags?.nonLatin).length;
  const enRate = measured.filter((t) => t.flags?.looksEnglish).length;
  return {
    samples: measured.length,
    latency: {
      median: median(lat),
      p95: p95(lat),
      avg: avg(lat),
      llmMedian: median(llmLat),
      llmAvg: avg(llmLat),
    },
    retryRate: rate(retries, measured.length),
    violationCounts: violations,
    multiQuestionRate: rate(multiQ, measured.length),
    nonLatinRate: rate(nonLat, measured.length),
    looksEnglishRate: rate(enRate, measured.length),
    avgResponseLen: avg(measured.map((t) => t.flags?.len || 0)),
  };
}

/*
   IN -> ____|______
        | fmtMs() | -> Txt
         ---------
      Formats a millisecond value, using an em dash for null (R).
   */
function fmtMs(v) { return v == null ? "—" : Math.round(v) + "ms"; }
/*
   IN -> ____|_______
        | fmtPct() | -> Txt
         ----------
      Formats a 0..1 ratio as a whole-number percentage, em dash for null (R).
   */
function fmtPct(v) { return v == null ? "—" : (v * 100).toFixed(0) + "%"; }

/*
   IN -> ____|____________
        | buildReport() | -> Txt
         --------------
      Builds the full Markdown benchmark report from the summary object (Obj).
   */
function buildReport(summary) {
  const lines = [];
  lines.push("# Model Benchmark — TFG-Tutor-Virtual");
  lines.push("");
  lines.push("**Backend**: " + summary.backend);
  lines.push("**Started**: " + summary.startedAt);
  lines.push("**Models**: " + summary.models.map((m) => "`" + m.name + "`").join(", "));
  lines.push("");
  lines.push("## Resumen comparativo");
  lines.push("");
  lines.push("| Modelo | n | Lat. median | Lat. p95 | LLM median | Retry rate | Drift ES↔EN | Repeated Q | State leak | Multi-Q rate | Looks EN |");
  lines.push("|--------|---|-------------|----------|------------|------------|-------------|------------|------------|--------------|----------|");
  for (const m of summary.models) {
    const a = m.aggregate;
    if (!a) { lines.push("| `" + m.name + "` | err | — | — | — | — | — | — | — | — | — |"); continue; }
    lines.push("| `" + m.name + "` | " + a.samples
      + " | " + fmtMs(a.latency.median)
      + " | " + fmtMs(a.latency.p95)
      + " | " + fmtMs(a.latency.llmMedian)
      + " | " + fmtPct(a.retryRate)
      + " | " + fmtPct(rate(a.violationCounts.language_drift || 0, a.samples))
      + " | " + fmtPct(rate(a.violationCounts.repeated_question || 0, a.samples))
      + " | " + fmtPct(rate(a.violationCounts.state_reveal || 0, a.samples))
      + " | " + fmtPct(a.multiQuestionRate)
      + " | " + fmtPct(a.looksEnglishRate)
      + " |");
  }
  lines.push("");
  for (const m of summary.models) {
    lines.push("## `" + m.name + "`");
    lines.push("");
    if (m.error) {
      lines.push("**ERROR:** " + m.error);
      lines.push("");
      continue;
    }
    if (!m.aggregate) {
      lines.push("**No data captured.**");
      lines.push("");
      continue;
    }
    lines.push("- Warmed up: " + (m.warmedUp ? "yes" : "no"));
    lines.push("- Backend log: `" + (m.logPath || "?") + "`");
    lines.push("- Interacción: `" + (m.interaccionId || "?") + "`");
    lines.push("");
    lines.push("### Turnos");
    lines.push("");
    lines.push("| # | Tag | Mensaje | Δms total | Retry | Class | Decision | Viol. | First chars de la respuesta |");
    lines.push("|---|-----|---------|-----------|-------|-------|----------|-------|------------------------------|");
    for (const t of m.turns) {
      const txt = (t.reply || "").replace(/\s+/g, " ").slice(0, 100).replace(/\|/g, "\\|");
      const viol = (t.violatedNames || []).join(",");
      lines.push("| " + (t.warmup ? "0" : t.idx) + " | " + t.tag + " | "
        + (t.msg || "").slice(0, 30).replace(/\|/g, "\\|")
        + " | " + (t.totalMs || "—")
        + " | " + (t.llmRetries || 0)
        + " | " + (t.classification || "—")
        + " | " + (t.decision || "—")
        + " | " + viol
        + " | " + txt + " |");
    }
    lines.push("");
  }
  return lines.join("\n");
}

/*
   IN -> ____|______________
        | runOneModel() | -> Promise<Obj>
         ----------------
      Runs the full benchmark for a single model and returns its result (Txt, Txt).
   */
async function runOneModel(model, ejId) {
  console.log(c("\n══════ MODEL: " + model + " ══════", "bold"));
  setEnvModel(model);
  await killExistingBackend();
  const { pid, logPath, warmedUp } = await startBackend(model);
  console.log(c("[bench] backend pid=" + pid + " warmedUp=" + warmedUp + " log=" + logPath, "dim"));
  if (!warmedUp) {
    return { name: model, error: "backend warmup timeout", logPath, turns: [] };
  }

  let cookie;
  try {
    const login = await req("POST", BACKEND + "/api/auth/dev-login", {
      headers: { "Content-Type": "application/json" }, body: "{}",
    });
    if (login.status !== 200) {
      return { name: model, error: "dev-login status=" + login.status, logPath, turns: [] };
    }
    cookie = parseSetCookie(login.headers["set-cookie"]);
  } catch (e) {
    return { name: model, error: "login error " + e.message, logPath, turns: [] };
  }

  let exerciseId = ejId;
  if (!exerciseId) {
    try {
      const ejs = JSON.parse((await req("GET", BACKEND + "/api/ejercicios", { headers: { cookie } })).body);
      const e1 = ejs.find((e) => /Ejercicio\s*1\b/i.test(e.titulo || e.nombre || ""));
      exerciseId = (e1 || ejs[0])._id;
    } catch (e) {
      return { name: model, error: "load exercises " + e.message, logPath, turns: [] };
    }
  }
  console.log(c("[bench] exerciseId=" + exerciseId, "dim"));

  const turns = [];
  let interaccionId = null;
  for (let i = 0; i < TURNS.length; i++) {
    const t = TURNS[i];
    process.stdout.write(c("  T" + i + " " + t.tag.padEnd(20) + " ", "cyan"));
    const resp = await reqSSE(BACKEND + "/api/ollama/chat/stream", {
      headers: { "Content-Type": "application/json", "x-llm-mode": "upv", cookie },
      body: JSON.stringify({ exerciseId, llmMode: "upv", userMessage: t.msg, interaccionId }),
    });
    if (!interaccionId && resp.interaccionId) interaccionId = resp.interaccionId;
    const reply = (resp.acc || "").trim();
    const ok = resp.status === 200 && resp.sawDone && reply.length > 0;
    const flags = detectFlags(reply);
    console.log((ok ? c("ok", "ok") : c("FAIL", "fail"))
      + " " + (resp.totalMs || "?") + "ms"
      + (resp.error ? " err=" + resp.error : "")
      + " chars=" + reply.length
      + " q=" + flags.qCount);
    turns.push({
      idx: i, tag: t.tag, msg: t.msg, warmup: !!t.warmup,
      ok, totalMs: resp.totalMs, firstChunkMs: resp.firstChunkMs,
      chunkCount: resp.chunkCount, error: resp.error,
      reply, flags,
    });
  }

  const reqStats = parseLogStats(logPath, interaccionId);
  for (let i = 0; i < turns.length && i < reqStats.length; i++) {
    Object.assign(turns[i], reqStats[i]);
  }

  await killExistingBackend();

  return {
    name: model,
    logPath,
    warmedUp,
    interaccionId,
    turns,
    aggregate: aggregate(turns),
  };
}

(async () => {
  console.log(c("\n=== MODEL BENCHMARK — " + MODELS.length + " models ===\n", "bold"));
  console.log("Models: " + MODELS.join(", "));
  console.log("Backend: " + BACKEND);
  console.log("Turns: " + TURNS.length + " (1 warmup + " + (TURNS.length - 1) + " measured)");
  console.log("");

  backupEnv();
  process.on("SIGINT", () => { restoreEnv(); process.exit(130); });
  process.on("SIGTERM", () => { restoreEnv(); process.exit(143); });

  const summary = {
    backend: BACKEND,
    startedAt: new Date().toISOString(),
    models: [],
  };

  try {
    let ejId = null;
    for (const model of MODELS) {
      const result = await runOneModel(model, ejId);
      if (!ejId && result.turns.length > 0 && result.warmedUp) {
      }
      summary.models.push(result);
      const a = result.aggregate;
      if (a) {
        console.log(c("  ▸ median=" + fmtMs(a.latency.median)
          + " p95=" + fmtMs(a.latency.p95)
          + " retryRate=" + fmtPct(a.retryRate)
          + " driftRate=" + fmtPct(rate(a.violationCounts.language_drift || 0, a.samples)),
          "warn"));
      }
    }
  } finally {
    restoreEnv();
    await killExistingBackend();
  }

  const jsonPath = "/tmp/model-benchmark-summary.json";
  const mdPath = "/tmp/model-benchmark-report.md";
  fs.writeFileSync(jsonPath, JSON.stringify(summary, null, 2));
  fs.writeFileSync(mdPath, buildReport(summary));
  console.log(c("\n✔ JSON  → " + jsonPath, "ok"));
  console.log(c("✔ Report → " + mdPath, "ok"));
  console.log("");
  const lines = buildReport(summary).split("\n");
  const tableStart = lines.findIndex((l) => l.startsWith("| Modelo"));
  if (tableStart >= 0) {
    let i = tableStart;
    while (i < lines.length && (lines[i].startsWith("|") || lines[i].startsWith("|--"))) {
      console.log(lines[i]);
      i++;
    }
  }
})().catch((e) => {
  console.error(c("FATAL: " + e.message, "fail"));
  console.error(e.stack);
  restoreEnv();
  process.exit(1);
});
