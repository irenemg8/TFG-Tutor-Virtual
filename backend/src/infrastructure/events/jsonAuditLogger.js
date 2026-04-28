"use strict";

// JSON audit logger: one JSON line per event, appended to a daily file.
// Enable with AUDIT_LOG=1. When disabled, write() is a no-op.
//
// File: <AUDIT_LOG_DIR or backend/logs/audit>/YYYY-MM-DD.jsonl
// Each line: {"ts":"2026-04-21T...","reqId":"req7","event":"llm_call_end", ...}
//
// Post-hoc analysis: `jq 'select(.event=="llm_call_end")' audit.jsonl`
//                     `jq -s 'map(select(.event=="request_end")) | length'`

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
    // Silent fail — we don't want logging to crash the app
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

/**
 * Append one JSON object as a line. Timestamp is added automatically.
 * Fire-and-forget: errors are swallowed to avoid impacting the request path.
 */
function write(payload) {
  if (!ENABLED) return;
  if (!_ensureDir()) return;
  try {
    var record = Object.assign({ ts: new Date().toISOString() }, payload || {});
    fs.appendFileSync(_filename(), JSON.stringify(record) + "\n", "utf8");
  } catch (err) {
    // Silent fail
  }
}

module.exports = {
  isOn: isOn,
  write: write,
};
