"use strict";

// Unified pipeline debug/trace logger.
// Enable with DEBUG_PIPELINE=1. When disabled, every call is a no-op.
//
// Prefix: [TRACE] for the request-level flow trace (one line per stage)
// Prefix: [DEBUG_PIPELINE] kept for backward compat with agent calls
//
// Grep usage:
//   Full trace:       grep "TRACE"
//   Only decisions:   grep "TRACE.*decision\|TRACE.*fallthrough\|TRACE.*gate"
//   Only errors:      grep "TRACE.*ERROR\|TRACE.*fallthrough"
//   Legacy pipeline:  grep "DEBUG_PIPELINE"
//   Per-guardrail:    grep "GUARDRAIL_CHECK\|SURGICAL_FIX\|LLM_RETRY"
//   Budget:           grep "BUDGET"
//   Stage timing:     grep "STAGE"

const TAG = "[TRACE]";
const jsonAudit = require("./jsonAuditLogger");

function isOn() {
  return process.env.DEBUG_PIPELINE === "1";
}

function shortStr(s, max) {
  if (typeof s !== "string") return "";
  if (s.length <= max) return s;
  return s.substring(0, max) + "...(+" + (s.length - max) + ")";
}

function tailStr(s, max) {
  if (typeof s !== "string") return "";
  if (s.length <= max) return s;
  return "...(" + (s.length - max) + " before)..." + s.substring(s.length - max);
}

function oneLine(s) {
  if (typeof s !== "string") return "";
  return s.replace(/\r?\n/g, " | ").replace(/\s+/g, " ").trim();
}

// ─── Per-request context state ───────────────────────────────────────────────
// Tracks time budget, accumulated LLM calls, guardrail timings per request.
// Lives in-memory; cleared on traceRequestEnd. Enables aggregate summary.

const _reqCtx = Object.create(null);

function _ctx(reqId) {
  if (!reqId) return null;
  if (!_reqCtx[reqId]) {
    _reqCtx[reqId] = {
      startMs: Date.now(),
      budgetMs: null,
      llmCalls: 0,
      llmTotalMs: 0,
      guardrailChecks: [],      // { name, violated, checkMs }
      surgicalFixes: [],         // { name, applied, durationMs }
      llmRetries: [],            // { reason, attempt, durationMs, succeeded }
      stages: [],                // { name, durationMs }
      fallbacks: [],             // { primary, fallback, reason }
    };
  }
  return _reqCtx[reqId];
}

function _clearCtx(reqId) {
  if (reqId && _reqCtx[reqId]) delete _reqCtx[reqId];
}

// ─── Request lifecycle ───────────────────────────────────────────────────────

let _reqSeq = 0;

/**
 * Start tracing a new request. Returns a reqId for correlation.
 * Logs: handler identification + basic params.
 */
function traceRequestStart(handler, params) {
  if (!isOn()) return "";
  _reqSeq++;
  var id = "req" + _reqSeq;
  _ctx(id); // initialize
  console.log(
    TAG + " [" + id + "] ▶ START handler=" + handler
    + " userId=" + (params.userId || "-")
    + " exerciseId=" + (params.exerciseId || "-")
    + " interaccionId=" + (params.interaccionId || "-")
    + " msgLen=" + (params.userMessage ? params.userMessage.length : 0)
    + " msg=" + JSON.stringify(shortStr(params.userMessage || "", 80))
  );
  jsonAudit.write({ reqId: id, event: "request_start", handler: handler, userId: params.userId, exerciseId: params.exerciseId, interaccionId: params.interaccionId, msgLen: params.userMessage ? params.userMessage.length : 0 });
  return id;
}

function traceRequestEnd(reqId, outcome) {
  if (!isOn()) return;
  console.log(
    TAG + " [" + reqId + "] ◀ END"
    + " outcome=" + (outcome.outcome || "-")
    + " totalMs=" + (outcome.totalMs || 0)
    + " responseLen=" + (outcome.responseLen || 0)
    + (outcome.classification ? " class=" + outcome.classification : "")
    + (outcome.decision ? " decision=" + outcome.decision : "")
    + (outcome.guardrailTriggered ? " guardrail=YES" : "")
  );
  // Emit aggregate summary line for easy grep/analysis
  var c = _reqCtx[reqId];
  if (c) {
    console.log(
      TAG + " [" + reqId + "] 📊 SUMMARY"
      + " totalMs=" + (outcome.totalMs || 0)
      + " budgetMs=" + (c.budgetMs != null ? c.budgetMs : "-")
      + " llmCalls=" + c.llmCalls
      + " llmTotalMs=" + c.llmTotalMs
      + " guardrailsChecked=" + c.guardrailChecks.length
      + " guardrailsViolated=" + c.guardrailChecks.filter(function (g) { return g.violated; }).length
      + " surgicalFixes=" + c.surgicalFixes.filter(function (s) { return s.applied; }).length
      + " llmRetries=" + c.llmRetries.length
      + " fallbacks=" + c.fallbacks.length
    );
    jsonAudit.write({
      reqId: reqId,
      event: "request_end",
      outcome: outcome.outcome,
      totalMs: outcome.totalMs,
      responseLen: outcome.responseLen,
      classification: outcome.classification,
      decision: outcome.decision,
      guardrailTriggered: !!outcome.guardrailTriggered,
      summary: {
        budgetMs: c.budgetMs,
        llmCalls: c.llmCalls,
        llmTotalMs: c.llmTotalMs,
        guardrailChecks: c.guardrailChecks,
        surgicalFixes: c.surgicalFixes,
        llmRetries: c.llmRetries,
        stages: c.stages,
        fallbacks: c.fallbacks,
      },
    });
  } else {
    jsonAudit.write({ reqId: reqId, event: "request_end", outcome: outcome.outcome, totalMs: outcome.totalMs });
  }
  _clearCtx(reqId);
}

// ─── Time budget ─────────────────────────────────────────────────────────────

/**
 * Declare a time budget for this request. All subsequent LLM calls and
 * guardrail retries should respect it. Phase-0 instrumentation only — does
 * not enforce. Phase-3 (GuardrailPipeline) will actually enforce.
 */
function traceBudgetSet(reqId, budgetMs) {
  var c = _ctx(reqId);
  if (c) c.budgetMs = budgetMs;
  if (!isOn()) return;
  console.log(TAG + " [" + reqId + "] ⏳ BUDGET_SET budgetMs=" + budgetMs);
  jsonAudit.write({ reqId: reqId, event: "budget_set", budgetMs: budgetMs });
}

/**
 * Checkpoint the budget: how much time has been spent, how much remains.
 * Emit at key decision points (before LLM call, before retry, etc.)
 */
function traceBudgetCheckpoint(reqId, phase, action) {
  var c = _ctx(reqId);
  if (!c) return;
  var elapsed = Date.now() - c.startMs;
  var remaining = c.budgetMs != null ? c.budgetMs - elapsed : null;
  if (isOn()) {
    console.log(
      TAG + " [" + reqId + "] ⏳ BUDGET phase=" + phase
      + " elapsedMs=" + elapsed
      + " remainingMs=" + (remaining != null ? remaining : "-")
      + (action ? " action=" + action : "")
    );
  }
  jsonAudit.write({ reqId: reqId, event: "budget_checkpoint", phase: phase, elapsedMs: elapsed, remainingMs: remaining, action: action });
  return { elapsedMs: elapsed, remainingMs: remaining, exceeded: remaining != null && remaining <= 0 };
}

// ─── Per-stage timing ────────────────────────────────────────────────────────

/**
 * Record a stage duration (e.g., "classify", "retrieve", "prompt_build").
 * Pass name and durationMs. Accumulates in request context.
 */
function traceStage(reqId, name, durationMs, metadata) {
  var c = _ctx(reqId);
  if (c) c.stages.push({ name: name, durationMs: durationMs });
  if (!isOn()) return;
  console.log(
    TAG + " [" + reqId + "] ⏱️ STAGE name=" + name
    + " durationMs=" + durationMs
    + (metadata ? " " + formatDetails(metadata) : "")
  );
  jsonAudit.write({ reqId: reqId, event: "stage", name: name, durationMs: durationMs, metadata: metadata });
}

// ─── RAG Middleware gates ────────────────────────────────────────────────────

/**
 * Log why the ragMiddleware decided to fall through (call next()).
 */
function traceRagGate(reqId, reason, details) {
  if (!isOn()) return;
  console.log(
    TAG + " [" + reqId + "] ⛔ RAG_FALLTHROUGH reason=\"" + reason + "\""
    + (details ? " " + formatDetails(details) : "")
  );
  jsonAudit.write({ reqId: reqId, event: "rag_fallthrough", reason: reason, details: details });
}

function traceRagAccepted(reqId, details) {
  if (!isOn()) return;
  console.log(
    TAG + " [" + reqId + "] ✓ RAG_ACCEPTED"
    + " exerciseNum=" + (details.exerciseNum || "-")
    + " correctAnswer=" + JSON.stringify(details.correctAnswer || [])
    + " evaluableElements=" + (details.evaluableElements || []).length
    + " lang=" + (details.lang || "-")
  );
  jsonAudit.write({ reqId: reqId, event: "rag_accepted", ...details });
}

// ─── Pipeline stages (ragMiddleware) ─────────────────────────────────────────

function traceSecurity(reqId, result) {
  if (!isOn()) return;
  console.log(
    TAG + " [" + reqId + "] 🛡️ SECURITY"
    + " safe=" + result.safe
    + " category=" + (result.category || "-")
    + " pattern=" + (result.matchedPattern || "-")
  );
  jsonAudit.write({ reqId: reqId, event: "security", safe: result.safe, category: result.category, matchedPattern: result.matchedPattern });
}

function traceClassify(reqId, classification) {
  if (!isOn()) return;
  var c = classification || {};
  console.log(
    TAG + " [" + reqId + "] 🏷️ CLASSIFY"
    + " type=" + (c.type || "-")
    + " decision=" + (c.decision || "-")
    + " proposed=" + JSON.stringify(c.proposed || [])
    + " negated=" + JSON.stringify(c.negated || [])
    + " concepts=" + JSON.stringify(c.concepts || [])
    + " hasReasoning=" + !!c.hasReasoning
  );
  jsonAudit.write({ reqId: reqId, event: "classify", ...c });
}

function traceLoopState(reqId, state) {
  if (!isOn()) return;
  console.log(
    TAG + " [" + reqId + "] 🔄 LOOP_STATE"
    + " prevCorrectTurns=" + (state.prevCorrectTurns || 0)
    + " wrongStreak=" + (state.wrongStreak || 0)
    + " totalTurns=" + (state.totalTurns || 0)
    + " repetition=" + !!state.repetition
    + " frustration=" + !!state.frustration
    + " demandJustification=" + !!state.demandJustification
    + " stuckHint=" + !!state.stuckHint
  );
  jsonAudit.write({ reqId: reqId, event: "loop_state", ...state });
}

function traceDeterministicFinish(reqId, details) {
  if (!isOn()) return;
  console.log(
    TAG + " [" + reqId + "] 🏁 DETERMINISTIC_FINISH"
    + " classification=" + (details.classification || "-")
    + " prevCorrectTurns=" + (details.prevCorrectTurns || 0)
    + " source=" + (details.source || "-")
    + " responseLen=" + (details.responseLen || 0)
  );
  jsonAudit.write({ reqId: reqId, event: "deterministic_finish", ...details });
}

// ─── LLM calls ───────────────────────────────────────────────────────────────

function traceLlmCall(reqId, phase, details) {
  if (phase === "start") {
    if (!isOn()) return;
    console.log(
      TAG + " [" + reqId + "] 🤖 LLM_CALL_START"
      + " model=" + (details.model || "-")
      + " messagesCount=" + (details.messagesCount || 0)
      + " promptLen=" + (details.promptLen || 0)
      + " reason=" + (details.reason || "primary")
    );
    jsonAudit.write({ reqId: reqId, event: "llm_call_start", ...details });
  } else {
    var c = _ctx(reqId);
    if (c) {
      c.llmCalls++;
      c.llmTotalMs += details.durationMs || 0;
    }
    if (!isOn()) return;
    console.log(
      TAG + " [" + reqId + "] 🤖 LLM_CALL_END"
      + " durationMs=" + (details.durationMs || 0)
      + " responseLen=" + (details.responseLen || 0)
      + " reason=" + (details.reason || "primary")
      + " head=" + JSON.stringify(shortStr(details.response || "", 120))
    );
    jsonAudit.write({
      reqId: reqId, event: "llm_call_end",
      durationMs: details.durationMs,
      responseLen: details.responseLen,
      reason: details.reason,
      responseHead: shortStr(details.response || "", 200),
    });
  }
}

/**
 * Record that an LLM retry was triggered by a specific guardrail.
 * Pair with traceLlmCall(end) that follows. This one records the CAUSE.
 */
function traceLlmRetry(reqId, reason, attempt, details) {
  var c = _ctx(reqId);
  if (c) c.llmRetries.push({ reason: reason, attempt: attempt, durationMs: (details && details.durationMs) || 0, succeeded: !!(details && details.succeeded) });
  if (!isOn()) return;
  console.log(
    TAG + " [" + reqId + "] 🔁 LLM_RETRY reason=" + reason
    + " attempt=" + attempt
    + (details && details.durationMs != null ? " durationMs=" + details.durationMs : "")
    + (details && details.succeeded != null ? " succeeded=" + details.succeeded : "")
  );
  jsonAudit.write({ reqId: reqId, event: "llm_retry", reason: reason, attempt: attempt, ...(details || {}) });
}

// ─── Guardrails (granular) ───────────────────────────────────────────────────

/**
 * Record a single guardrail check (one of N run in parallel or sequentially).
 * name: "solution_leak", "false_confirmation", etc.
 * violated: bool
 * checkMs: time to run the check (not the fix, not the retry)
 * evidence: free-text reason (pattern matched, etc.)
 */
function traceGuardrailCheck(reqId, name, result) {
  var c = _ctx(reqId);
  if (c) c.guardrailChecks.push({ name: name, violated: !!result.violated, checkMs: result.checkMs || 0 });
  if (!isOn()) return;
  console.log(
    TAG + " [" + reqId + "] 🔍 GUARDRAIL_CHECK name=" + name
    + " violated=" + !!result.violated
    + " checkMs=" + (result.checkMs || 0)
    + (result.evidence ? " evidence=" + JSON.stringify(shortStr(result.evidence, 80)) : "")
  );
  jsonAudit.write({ reqId: reqId, event: "guardrail_check", name: name, violated: !!result.violated, checkMs: result.checkMs, evidence: result.evidence });
}

/**
 * Record a surgical fix attempt (deterministic, no LLM).
 * applied: did the fix actually modify the response?
 * durationMs: how long the fix took (usually <1ms)
 * before/after: text snippets (heads only, capped)
 */
function traceSurgicalFix(reqId, name, result) {
  var c = _ctx(reqId);
  if (c) c.surgicalFixes.push({ name: name, applied: !!result.applied, durationMs: result.durationMs || 0 });
  if (!isOn()) return;
  console.log(
    TAG + " [" + reqId + "] 🔧 SURGICAL_FIX name=" + name
    + " applied=" + !!result.applied
    + " durationMs=" + (result.durationMs || 0)
    + (result.applied && result.before ? " before=" + JSON.stringify(shortStr(result.before, 60)) : "")
    + (result.applied && result.after ? " after=" + JSON.stringify(shortStr(result.after, 60)) : "")
  );
  jsonAudit.write({
    reqId: reqId, event: "surgical_fix", name: name,
    applied: !!result.applied, durationMs: result.durationMs,
    before: shortStr(result.before || "", 200),
    after: shortStr(result.after || "", 200),
  });
}

/**
 * Legacy: aggregated guardrail trace (kept for compat with ragMiddleware).
 * New code should prefer traceGuardrailCheck + traceSurgicalFix + traceLlmRetry.
 */
function traceGuardrails(reqId, results) {
  if (!isOn()) return;
  var flags = [];
  if (results.solutionLeak) flags.push("LEAK");
  if (results.falseConfirmation) flags.push("FALSE_CONFIRM");
  if (results.prematureConfirmation) flags.push("PREMATURE");
  if (results.stateReveal) flags.push("STATE_REVEAL");
  if (results.elementNaming) flags.push("ELEMENT_NAMING");
  if (results.didacticExplanation) flags.push("DIDACTIC");
  if (results.styleFixed) flags.push("STYLE");
  if (results.finStripped) flags.push("FIN_STRIPPED");
  console.log(
    TAG + " [" + reqId + "] 🚧 GUARDRAILS"
    + " triggered=" + (flags.length > 0)
    + " flags=[" + flags.join(",") + "]"
    + " retries=" + (results.retries || 0)
    + " finalLen=" + (results.finalLen || 0)
    + " finalHead=" + JSON.stringify(shortStr(results.finalResponse || "", 120))
  );
  jsonAudit.write({
    reqId: reqId, event: "guardrails_aggregate", flags: flags,
    retries: results.retries, finalLen: results.finalLen,
  });
}

// ─── Fallbacks (e.g., semantic → BM25-only) ──────────────────────────────────

function traceFallback(reqId, primary, fallback, reason) {
  var c = _ctx(reqId);
  if (c) c.fallbacks.push({ primary: primary, fallback: fallback, reason: reason });
  if (!isOn()) return;
  console.log(
    TAG + " [" + reqId + "] 🔀 FALLBACK primary=" + primary
    + " fallback=" + fallback
    + " reason=" + JSON.stringify(reason || "-")
  );
  jsonAudit.write({ reqId: reqId, event: "fallback", primary: primary, fallback: fallback, reason: reason });
}

// ─── Response and errors ─────────────────────────────────────────────────────

function traceResponse(reqId, details) {
  if (!isOn()) return;
  console.log(
    TAG + " [" + reqId + "] 📤 RESPONSE_SENT"
    + " len=" + (details.len || 0)
    + " containsFIN=" + !!details.containsFIN
    + " head=" + JSON.stringify(shortStr(details.response || "", 120))
  );
  jsonAudit.write({
    reqId: reqId, event: "response_sent",
    len: details.len, containsFIN: !!details.containsFIN,
    responseHead: shortStr(details.response || "", 200),
  });
}

function traceError(reqId, stage, error) {
  if (!isOn()) return;
  console.log(
    TAG + " [" + reqId + "] ❌ ERROR stage=" + stage
    + " message=" + JSON.stringify((error && error.message) || String(error))
    + " code=" + ((error && error.code) || "-")
  );
  jsonAudit.write({
    reqId: reqId, event: "error", stage: stage,
    message: (error && error.message) || String(error),
    code: error && error.code,
  });
}

// ─── Route handler specific ──────────────────────────────────────────────────

function traceRouteHandler(reqId, event, details) {
  if (!isOn()) return;
  console.log(
    TAG + " [" + reqId + "] 📡 ROUTE_HANDLER event=" + event
    + (details ? " " + formatDetails(details) : "")
  );
  jsonAudit.write({ reqId: reqId, event: "route_handler", handler_event: event, ...(details || {}) });
}

// ─── Legacy compatibility (agents use these) ─────────────────────────────────

function logSecurity(userMessage, result) {
  if (!isOn()) return;
  var line = "[DEBUG_PIPELINE] stage=security"
    + " safe=" + result.safe
    + " category=" + (result.category || "-")
    + " pattern=" + (result.matchedPattern || "-")
    + " msg=" + JSON.stringify(shortStr(userMessage || "", 160));
  console.log(line);
}

function logClassify(userMessage, classification) {
  if (!isOn()) return;
  var c = classification || {};
  var line = "[DEBUG_PIPELINE] stage=classify"
    + " type=" + (c.type || "-")
    + " proposed=" + JSON.stringify(c.proposed || [])
    + " negated=" + JSON.stringify(c.negated || [])
    + " concepts=" + JSON.stringify(c.concepts || [])
    + " hasReasoning=" + !!c.hasReasoning
    + " msg=" + JSON.stringify(shortStr(userMessage || "", 160));
  console.log(line);
}

function logPrompt(augmentedPrompt, classificationType) {
  if (!isOn()) return;
  var len = typeof augmentedPrompt === "string" ? augmentedPrompt.length : 0;
  var tail = tailStr(augmentedPrompt || "", 1200);
  console.log(
    "[DEBUG_PIPELINE] stage=prompt"
    + " classType=" + (classificationType || "-")
    + " totalLen=" + len
    + " tail=" + JSON.stringify(oneLine(tail))
  );
}

function logLlmOut(response) {
  if (!isOn()) return;
  var head = shortStr(response || "", 400);
  console.log(
    "[DEBUG_PIPELINE] stage=llm_out"
    + " len=" + ((response || "").length)
    + " head=" + JSON.stringify(oneLine(head))
  );
}

function logGuardrail(triggered, finalResponse) {
  if (!isOn()) return;
  var t = triggered || {};
  var line = "[DEBUG_PIPELINE] stage=guardrail"
    + " solutionLeak=" + !!t.solutionLeak
    + " falseConfirmation=" + !!t.falseConfirmation
    + " prematureConfirmation=" + !!t.prematureConfirmation
    + " stateReveal=" + !!t.stateReveal
    + " finalHead=" + JSON.stringify(oneLine(shortStr(finalResponse || "", 300)));
  console.log(line);
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function formatDetails(obj) {
  if (!obj) return "";
  var parts = [];
  var keys = Object.keys(obj);
  for (var i = 0; i < keys.length; i++) {
    var v = obj[keys[i]];
    if (v === undefined || v === null) continue;
    if (typeof v === "string") {
      parts.push(keys[i] + "=" + JSON.stringify(shortStr(v, 60)));
    } else if (typeof v === "object") {
      parts.push(keys[i] + "=" + JSON.stringify(v));
    } else {
      parts.push(keys[i] + "=" + v);
    }
  }
  return parts.join(" ");
}

module.exports = {
  // Activation check
  isOn: isOn,

  // Request lifecycle
  traceRequestStart: traceRequestStart,
  traceRequestEnd: traceRequestEnd,

  // Time budget
  traceBudgetSet: traceBudgetSet,
  traceBudgetCheckpoint: traceBudgetCheckpoint,

  // Per-stage timing
  traceStage: traceStage,

  // RAG middleware decisions
  traceRagGate: traceRagGate,
  traceRagAccepted: traceRagAccepted,

  // Pipeline stages
  traceSecurity: traceSecurity,
  traceClassify: traceClassify,
  traceLoopState: traceLoopState,
  traceDeterministicFinish: traceDeterministicFinish,

  // LLM
  traceLlmCall: traceLlmCall,
  traceLlmRetry: traceLlmRetry,

  // Guardrails (granular)
  traceGuardrailCheck: traceGuardrailCheck,
  traceSurgicalFix: traceSurgicalFix,
  traceGuardrails: traceGuardrails, // legacy aggregate

  // Fallbacks
  traceFallback: traceFallback,

  // Response
  traceResponse: traceResponse,
  traceError: traceError,

  // Route handler
  traceRouteHandler: traceRouteHandler,

  // Legacy (backward compat with agents)
  logSecurity: logSecurity,
  logClassify: logClassify,
  logPrompt: logPrompt,
  logLlmOut: logLlmOut,
  logGuardrail: logGuardrail,
};
