"use strict";

/*------------------------------------------------------------------------------
            _________________________________________________________
            |                     JSONAUDITLOGGER                   |
            |  Module that writes one JSON line per event to a daily |
            |  file (<AUDIT_LOG_DIR or backend/logs/audit>/YYYY-MM-  |
            |  DD.jsonl). Enabled with AUDIT_LOG=1; otherwise every  |
            |  call is a no-op. Records are queued in memory and     |
            |  flushed asynchronously so write() never blocks the    |
            |  event loop.                                           |
            |                                                       |
            |          | isOn() | -> T/F                            |
            |   Obj -> | write() | -> void                          |
            |                                                       |
            |_______________________________________________________|
------------------------------------------------------------------------------*/

const fs = require("fs");
const path = require("path");

const ENABLED = process.env.AUDIT_LOG === "1";
const DIR = process.env.AUDIT_LOG_DIR
  || path.join(__dirname, "..", "..", "..", "logs", "audit");

let _dirReady = false;
/*
       ____|______________
      | _ensureDir() | -> T/F    (reads/writes module flag _dirReady (T/F))
       --------------
      Creates the log directory once per process. Returns false when the
      directory cannot be created.
*/
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

/*
       ____|_____________
      | _filename() | -> Txt
       -------------
      Returns the path of today's daily log file (YYYY-MM-DD.jsonl).
*/
function _filename() {
  var d = new Date();
  var y = d.getFullYear();
  var m = String(d.getMonth() + 1).padStart(2, "0");
  var day = String(d.getDate()).padStart(2, "0");
  return path.join(DIR, y + "-" + m + "-" + day + ".jsonl");
}

/*
       ____|_________
      | isOn() | -> T/F    (reads module flag ENABLED (T/F))
       --------
      True when audit logging is enabled via AUDIT_LOG=1.
*/
function isOn() {
  return ENABLED;
}

const _queue = [];
let _drainScheduled = false;
let _flushing = false;
const FLUSH_INTERVAL_MS = 100;
const FLUSH_BATCH_SIZE = 32;

/*
   T/F -> ____|__________________
         | _scheduleDrain() | -> void    (reads/writes module flag _drainScheduled (T/F))
          ------------------
      Schedules the background drain, immediately or after FLUSH_INTERVAL_MS.
      The queue drains on whichever comes first: the interval or
      FLUSH_BATCH_SIZE records, with a single in-flight write at a time.
*/
function _scheduleDrain(immediate) {
  if (_drainScheduled) return;
  _drainScheduled = true;
  if (immediate) {
    setImmediate(_drain);
  } else {
    setTimeout(_drain, FLUSH_INTERVAL_MS);
  }
}

/*
       ____|_________
      | _drain() | -> void    (reads/writes module queue _queue ([Obj]) and flag _flushing (T/F))
       ---------
      Flushes the queued records to the daily file in a single async append.
      Drops the queue when the directory is unavailable and reschedules
      itself while records remain. Failures are swallowed silently.
*/
function _drain() {
  _drainScheduled = false;
  if (_flushing) return;
  if (_queue.length === 0) return;
  if (!_ensureDir()) {
    _queue.length = 0;
    return;
  }
  const batch = _queue.splice(0, _queue.length);
  const payload = batch.map(function (rec) { return JSON.stringify(rec); }).join("\n") + "\n";
  _flushing = true;
  fs.appendFile(_filename(), payload, "utf8", function (err) {
    _flushing = false;
    if (_queue.length > 0) _scheduleDrain(false);
  });
}

/*
   Obj -> ____|_________
         | write() | -> void    (writes module queue _queue ([Obj]))
          ---------
      Enqueues one record (stamped with an ISO timestamp) and returns
      immediately; the flush is async. No-op when disabled.
*/
function write(payload) {
  if (!ENABLED) return;
  try {
    const record = Object.assign({ ts: new Date().toISOString() }, payload || {});
    _queue.push(record);
    _scheduleDrain(_queue.length >= FLUSH_BATCH_SIZE);
  } catch (err) {
  }
}

process.on("beforeExit", function () {
  if (_queue.length === 0) return;
  if (!_ensureDir()) return;
  try {
    const batch = _queue.splice(0, _queue.length);
    const out = batch.map(function (r) { return JSON.stringify(r); }).join("\n") + "\n";
    fs.appendFileSync(_filename(), out, "utf8");
  } catch (e) {
  }
});

module.exports = {
  isOn: isOn,
  write: write,
};
