"use strict";

// JSON audit logger: one JSON line per event, appended to a daily file.
// Enable with AUDIT_LOG=1. When disabled, write() is a no-op.
//
// File: <AUDIT_LOG_DIR or backend/logs/audit>/YYYY-MM-DD.jsonl
// Each line: {"ts":"2026-04-21T...","reqId":"req7","event":"llm_call_end", ...}
//
// Post-hoc analysis: `jq 'select(.event=="llm_call_end")' audit.jsonl`
//                     `jq -s 'map(select(.event=="request_end")) | length'`
//
// IMPORTANT: write() is non-blocking. A pipelineDebugLogger turn fires up
// to ~23 audit events; the previous fs.appendFileSync version stalled the
// event loop ~400-700ms per request on Windows production servers and was
// a non-trivial chunk of the perceived LLM latency. Now records are
// queued in memory and flushed via fs.appendFile in a background loop.

const fs = require("fs");
const path = require("path");

const ENABLED = process.env.AUDIT_LOG === "1";
const DIR = process.env.AUDIT_LOG_DIR
  || path.join(__dirname, "..", "..", "..", "logs", "audit");

// Lazy mkdir (once per process)
let _dirReady = false;
function _ensureDir() {
  if (_dirReady) return true;
  try {
    fs.mkdirSync(DIR, { recursive: true });
    _dirReady = true;
    return true;
  } catch (err) {
    console.warn("[AUDIT] Could not create log dir " + DIR + ": " + err.message);
    return false;
  }
}

function _filename() {
  var d = new Date();
  var y = d.getFullYear();
  var m = String(d.getMonth() + 1).padStart(2, "0");
  var day = String(d.getDate()).padStart(2, "0");
  return path.join(DIR, y + "-" + m + "-" + day + ".jsonl");
}

function isOn() {
  return ENABLED;
}

// In-memory queue + background drainer.
// Drains either every FLUSH_INTERVAL_MS or whenever the queue reaches
// FLUSH_BATCH_SIZE — whichever comes first. Single in-flight write
// avoids interleaved appends to the same file.
const _queue = [];
let _drainScheduled = false;
let _flushing = false;
const FLUSH_INTERVAL_MS = 100;
const FLUSH_BATCH_SIZE = 32;

function _scheduleDrain(immediate) {
  if (_drainScheduled) return;
  _drainScheduled = true;
  if (immediate) {
    setImmediate(_drain);
  } else {
    setTimeout(_drain, FLUSH_INTERVAL_MS);
  }
}

function _drain() {
  _drainScheduled = false;
  if (_flushing) return;
  if (_queue.length === 0) return;
  if (!_ensureDir()) {
    // Drop queue if we can't write; keep moving on.
    _queue.length = 0;
    return;
  }
  const batch = _queue.splice(0, _queue.length);
  const payload = batch.map(function (rec) { return JSON.stringify(rec); }).join("\n") + "\n";
  _flushing = true;
  fs.appendFile(_filename(), payload, "utf8", function (err) {
    _flushing = false;
    // Silent fail — we don't want logging to crash the app.
    if (_queue.length > 0) _scheduleDrain(false);
  });
}

/**
 * Append one JSON object as a line. Timestamp is added automatically.
 * Non-blocking: enqueues and returns immediately; flush is async.
 */
function write(payload) {
  if (!ENABLED) return;
  try {
    const record = Object.assign({ ts: new Date().toISOString() }, payload || {});
    _queue.push(record);
    _scheduleDrain(_queue.length >= FLUSH_BATCH_SIZE);
  } catch (err) {
    // Silent fail
  }
}

// Best-effort flush before the process exits, so the last batch isn't lost.
process.on("beforeExit", function () {
  if (_queue.length === 0) return;
  if (!_ensureDir()) return;
  try {
    const batch = _queue.splice(0, _queue.length);
    const out = batch.map(function (r) { return JSON.stringify(r); }).join("\n") + "\n";
    // Synchronous on shutdown is acceptable — process is already winding down.
    fs.appendFileSync(_filename(), out, "utf8");
  } catch (e) {
    // Silent
  }
});

module.exports = {
  isOn: isOn,
  write: write,
};
