"use strict";

/*------------------------------------------------------------------------------
            _________________________________________________________
            |                  PIPELINEDEBUGLOGGER                  |
            |  Unified pipeline debug/trace logger. Enabled with     |
            |  DEBUG_PIPELINE=1; otherwise every call is a no-op.    |
            |  Emits [TRACE] request-flow lines plus mirrored JSON   |
            |  audit events, keeping [DEBUG_PIPELINE] legacy lines   |
            |  for backward compatibility with agent calls.          |
            |                                                       |
            |          | isOn() | -> T/F                            |
            |   Txt, Obj -> | traceRequestStart() | -> Txt          |
            |   Txt, Obj -> | traceRequestEnd() | -> void           |
            |   Txt, Z -> | traceBudgetSet() | -> void              |
            |   Txt, Txt, Txt -> | traceBudgetCheckpoint() | -> Obj |
            |   Txt, Txt, Z, Obj -> | traceStage() | -> void        |
            |   Txt, Txt, Obj -> | traceRagGate() | -> void         |
            |   Txt, Obj -> | traceRagAccepted() | -> void          |
            |   Txt, Obj -> | traceSecurity() | -> void             |
            |   Txt, Obj -> | traceClassify() | -> void             |
            |   Txt, Obj -> | traceLoopState() | -> void            |
            |   Txt, Obj -> | traceDeterministicFinish() | -> void  |
            |   Txt, Txt, Obj -> | traceLlmCall() | -> void         |
            |   Txt, Txt, Z, Obj -> | traceLlmRetry() | -> void     |
            |   Txt, Txt, Obj -> | traceGuardrailCheck() | -> void  |
            |   Txt, Txt, Obj -> | traceSurgicalFix() | -> void     |
            |   Txt, Obj -> | traceGuardrails() | -> void           |
            |   Txt, Txt, Txt, Txt -> | traceFallback() | -> void   |
            |   Txt, Obj -> | traceResponse() | -> void             |
            |   Txt, Txt, Error -> | traceError() | -> void         |
            |   Txt, Txt, Obj -> | traceRouteHandler() | -> void    |
            |   Txt, Obj -> | logSecurity() | -> void               |
            |   Txt, Obj -> | logClassify() | -> void               |
            |   Txt, Txt -> | logPrompt() | -> void                 |
            |   Txt -> | logLlmOut() | -> void                      |
            |   Obj, Txt -> | logGuardrail() | -> void              |
            |                                                       |
            |_______________________________________________________|
------------------------------------------------------------------------------*/

const TAG = "[TRACE]";
const jsonAudit = require("./jsonAuditLogger");

function isOn() {
  return process.env.DEBUG_PIPELINE === "1";
}

/*
   Txt, Z -> ____|____________
            | shortStr() | -> Txt
             -----------
      Truncates s to max chars, appending a "(+N)" overflow marker.
*/
function shortStr(s, max) {
  if (typeof s !== "string") return "";
  if (s.length <= max) return s;
  return s.substring(0, max) + "...(+" + (s.length - max) + ")";
}

/*
   Txt, Z -> ____|___________
            | tailStr() | -> Txt
             ----------
      Keeps only the last max chars of s, prefixing a "before" marker.
*/
function tailStr(s, max) {
  if (typeof s !== "string") return "";
  if (s.length <= max) return s;
  return "...(" + (s.length - max) + " before)..." + s.substring(s.length - max);
}

/*
   Txt -> ____|___________
         | oneLine() | -> Txt
          ----------
      Collapses newlines and runs of whitespace into a single line.
*/
function oneLine(s) {
  if (typeof s !== "string") return "";
  return s.replace(/\r?\n/g, " | ").replace(/\s+/g, " ").trim();
}

const _reqCtx = Object.create(null);

/*
   Txt -> ____|________
         | _ctx() | -> Obj | null    (reads/writes module map _reqCtx (Obj))
          -------
      Returns the in-memory context for reqId, lazily creating it. Tracks
      time budget, LLM calls, guardrail timings and stages per request.
*/
function _ctx(reqId) {
  if (!reqId) return null;
  if (!_reqCtx[reqId]) {
    _reqCtx[reqId] = {
      startMs: Date.now(),
      budgetMs: null,
      llmCalls: 0,
      llmTotalMs: 0,
      guardrailChecks: [],
      surgicalFixes: [],
      llmRetries: [],
      stages: [],
      fallbacks: [],
    };
  }
  return _reqCtx[reqId];
}

/*
   Txt -> ____|_____________
         | _clearCtx() | -> void    (writes module map _reqCtx (Obj))
          ------------
      Discards the in-memory context for reqId.
*/
function _clearCtx(reqId) {
  if (reqId && _reqCtx[reqId]) delete _reqCtx[reqId];
}

let _reqSeq = 0;

/*
   Txt, Obj -> ____|_____________________
              | traceRequestStart() | -> Txt    (reads/writes module counter _reqSeq (Z))
               --------------------
      Starts tracing a new request, logging the handler and basic params,
      and returns the generated reqId used to correlate later events.
*/
function traceRequestStart(handler, params) {
  if (!isOn()) return "";
  _reqSeq++;
  var id = "req" + _reqSeq;
  _ctx(id);
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

/*
   Txt, Obj -> ____|___________________
              | traceRequestEnd() | -> void    (reads/writes module map _reqCtx (Obj))
               ------------------
      Logs the request outcome plus an aggregate summary line, mirrors both
      to the JSON audit log, and clears the request context.
*/
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

/*
   Txt, Z -> ____|________________
            | traceBudgetSet() | -> void    (writes module map _reqCtx (Obj))
             -----------------
      Records a time budget for the request. Instrumentation only; it does
      not enforce the budget.
*/
function traceBudgetSet(reqId, budgetMs) {
  var c = _ctx(reqId);
  if (c) c.budgetMs = budgetMs;
  if (!isOn()) return;
  console.log(TAG + " [" + reqId + "] ⏳ BUDGET_SET budgetMs=" + budgetMs);
  jsonAudit.write({ reqId: reqId, event: "budget_set", budgetMs: budgetMs });
}

/*
   Txt, Txt, Txt -> ____|_______________________
                   | traceBudgetCheckpoint() | -> Obj    (reads module map _reqCtx (Obj))
                    ------------------------
      Reports elapsed and remaining time at a decision point and returns
      { elapsedMs, remainingMs, exceeded }.
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

/*
   Txt, Txt, Z, Obj -> ____|______________
                      | traceStage() | -> void    (writes module map _reqCtx (Obj))
                       -------------
      Records a named stage duration (e.g. "classify", "retrieve") in the
      request context and logs it.
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

/*
   Txt, Txt, Obj -> ____|________________
                   | traceRagGate() | -> void
                    ---------------
      Logs why the ragMiddleware fell through (called next()).
*/
function traceRagGate(reqId, reason, details) {
  if (!isOn()) return;
  console.log(
    TAG + " [" + reqId + "] ⛔ RAG_FALLTHROUGH reason=\"" + reason + "\""
    + (details ? " " + formatDetails(details) : "")
  );
  jsonAudit.write({ reqId: reqId, event: "rag_fallthrough", reason: reason, details: details });
}

/*
   Txt, Obj -> ____|_____________________
              | traceRagAccepted() | -> void
               -------------------
      Logs that the ragMiddleware accepted the request, with exercise and
      correct-answer details.
*/
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

/*
   Txt, Obj -> ____|________________
              | traceSecurity() | -> void
               ----------------
      Logs the security-check verdict (safe, category, matched pattern).
*/
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

/*
   Txt, Obj -> ____|________________
              | traceClassify() | -> void
               ----------------
      Logs the classifier output (type, decision, proposed/negated elements,
      concepts).
*/
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

/*
   Txt, Obj -> ____|_________________
              | traceLoopState() | -> void
               -----------------
      Logs the tutoring loop state (correct/wrong streaks, repetition,
      frustration and hint flags).
*/
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

/*
   Txt, Obj -> ____|___________________________
              | traceDeterministicFinish() | -> void
               --------------------------
      Logs that the pipeline finished deterministically (without an LLM call),
      with classification and source.
*/
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

/*
   Txt, Txt, Obj -> ____|_______________
                   | traceLlmCall() | -> void    (writes module map _reqCtx (Obj))
                    ---------------
      Logs an LLM call start or end (phase "start"|"end"). On end it
      accumulates the call count and total LLM time in the request context.
*/
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

/*
   Txt, Txt, Z, Obj -> ____|________________
                      | traceLlmRetry() | -> void    (writes module map _reqCtx (Obj))
                       ----------------
      Records the cause of an LLM retry (which guardrail and attempt number)
      in the request context. Pair with the traceLlmCall(end) that follows.
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

/*
   Txt, Txt, Obj -> ____|______________________
                   | traceGuardrailCheck() | -> void    (writes module map _reqCtx (Obj))
                    ---------------------
      Records one guardrail check (name, violated, checkMs, evidence) in the
      request context and logs it. checkMs times the check, not the fix.
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

/*
   Txt, Txt, Obj -> ____|___________________
                   | traceSurgicalFix() | -> void    (writes module map _reqCtx (Obj))
                    ------------------
      Records a deterministic (no-LLM) surgical fix attempt (name, applied,
      durationMs, before/after heads) in the request context and logs it.
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

/*
   Txt, Obj -> ____|__________________
              | traceGuardrails() | -> void
               -----------------
      Legacy aggregated guardrail trace kept for ragMiddleware compatibility.
      New code prefers traceGuardrailCheck + traceSurgicalFix + traceLlmRetry.
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

/*
   Txt, Txt, Txt, Txt -> ____|________________
                        | traceFallback() | -> void    (writes module map _reqCtx (Obj))
                         ----------------
      Records a fallback (e.g. semantic to BM25-only) in the request context
      and logs the primary, fallback and reason.
*/
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

/*
   Txt, Obj -> ____|________________
              | traceResponse() | -> void
               ----------------
      Logs the response sent to the client (length, FIN marker, head).
*/
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

/*
   Txt, Txt, Error -> ____|_____________
                     | traceError() | -> void
                      -------------
      Logs an error raised at a given pipeline stage (message and code).
*/
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

/*
   Txt, Txt, Obj -> ____|____________________
                   | traceRouteHandler() | -> void
                    --------------------
      Logs a route-handler-specific event with optional details.
*/
function traceRouteHandler(reqId, event, details) {
  if (!isOn()) return;
  console.log(
    TAG + " [" + reqId + "] 📡 ROUTE_HANDLER event=" + event
    + (details ? " " + formatDetails(details) : "")
  );
  jsonAudit.write({ reqId: reqId, event: "route_handler", handler_event: event, ...(details || {}) });
}

/*
   Txt, Obj -> ____|______________
              | logSecurity() | -> void
               --------------
      Legacy [DEBUG_PIPELINE] security log line kept for agent compatibility.
*/
function logSecurity(userMessage, result) {
  if (!isOn()) return;
  var line = "[DEBUG_PIPELINE] stage=security"
    + " safe=" + result.safe
    + " category=" + (result.category || "-")
    + " pattern=" + (result.matchedPattern || "-")
    + " msg=" + JSON.stringify(shortStr(userMessage || "", 160));
  console.log(line);
}

/*
   Txt, Obj -> ____|______________
              | logClassify() | -> void
               --------------
      Legacy [DEBUG_PIPELINE] classify log line kept for agent compatibility.
*/
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

/*
   Txt, Txt -> ____|____________
              | logPrompt() | -> void
               ------------
      Legacy [DEBUG_PIPELINE] prompt log line; emits the augmented prompt
      tail and total length for the given classification type.
*/
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

/*
   Txt -> ____|____________
         | logLlmOut() | -> void
          ------------
      Legacy [DEBUG_PIPELINE] log line for the raw LLM output head.
*/
function logLlmOut(response) {
  if (!isOn()) return;
  var head = shortStr(response || "", 400);
  console.log(
    "[DEBUG_PIPELINE] stage=llm_out"
    + " len=" + ((response || "").length)
    + " head=" + JSON.stringify(oneLine(head))
  );
}

/*
   Obj, Txt -> ____|______________
              | logGuardrail() | -> void
               --------------
      Legacy [DEBUG_PIPELINE] guardrail log line listing the four legacy
      guardrail flags and the final response head.
*/
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

/*
   Obj -> ____|________________
         | formatDetails() | -> Txt
          ----------------
      Renders a details object as a "key=value" string, JSON-quoting strings
      (capped) and objects and skipping null/undefined entries.
*/
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
  isOn: isOn,

  traceRequestStart: traceRequestStart,
  traceRequestEnd: traceRequestEnd,

  traceBudgetSet: traceBudgetSet,
  traceBudgetCheckpoint: traceBudgetCheckpoint,

  traceStage: traceStage,

  traceRagGate: traceRagGate,
  traceRagAccepted: traceRagAccepted,

  traceSecurity: traceSecurity,
  traceClassify: traceClassify,
  traceLoopState: traceLoopState,
  traceDeterministicFinish: traceDeterministicFinish,

  traceLlmCall: traceLlmCall,
  traceLlmRetry: traceLlmRetry,

  traceGuardrailCheck: traceGuardrailCheck,
  traceSurgicalFix: traceSurgicalFix,
  traceGuardrails: traceGuardrails,

  traceFallback: traceFallback,

  traceResponse: traceResponse,
  traceError: traceError,

  traceRouteHandler: traceRouteHandler,

  logSecurity: logSecurity,
  logClassify: logClassify,
  logPrompt: logPrompt,
  logLlmOut: logLlmOut,
  logGuardrail: logGuardrail,
};
