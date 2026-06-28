"use strict";

const AgentInterface = require("./base/AgentInterface");
const { matchACs, getPatternsForExercise } = require("../services/acRegistry");

/*------------------------------------------------------------------------------
            _________________________________________________________
            |                    ACDETECTORAGENT                    |
            |  Pipeline agent that runs two deterministic per-turn  |
            |  computations: the confidence-ranked detectedACs list |
            |  (matching proposed/negated against the exercise AC   |
            |  patterns) and the canonical per-element turnVerdict  |
            |  (NS-30) against the correct answer. Pure: no I/O, no  |
            |  LLM. Runs after ClassifierAgent and before TutorAgent.|
        ____|________________                                       |
   Obj -> | constructor() | -> AcDetectorAgent       (writes attrs) |
          -----------------                                         |
            |                                                       |
            |   name: Txt            deps: Obj                      |
        ____|_____________________________                          |
 AgentContext -> | canSkip() | -> T/F                               |
                 ------------                                       |
        ____|_____________________________                          |
 AgentContext -> | execute() | -> Promise<void>                     |
                 ------------                                        |
            |_______________________________________________________|

   Module-level helpers (pure functions):
     -> | _traceAcDetection() | -> void
     -> | _computeStateMismatches() | -> [Obj]
     Txt -> | _norm() | -> Txt
     [Txt],[Txt],[Txt] -> | _computeVerdict() | -> Obj
------------------------------------------------------------------------------*/
class AcDetectorAgent extends AgentInterface {
  /*
   Obj -> ____|________________
         | constructor() | -> AcDetectorAgent    (writes attributes name (Txt),
          -----------------                       deps (Obj))
      Stores the (currently unused) deps object, defaulting to {}.
  */
  constructor(deps) {
    super("acDetectorAgent");
    this.deps = deps || {};
  }

  /*
 AgentContext -> ____|___________
                | canSkip() | -> T/F
                 -----------
      Skips when there is no classification, or when neither a proposed
      nor a negated element was detected this turn.
  */
  canSkip(context) {
    if (!context.classification) return true;
    const proposed = context.classification.proposed || [];
    const negated = context.classification.negated || [];
    return proposed.length === 0 && negated.length === 0;
  }

  /*
 AgentContext -> ____|___________
                | execute() | -> Promise<void>
                 -----------
      Always computes stateMismatches first (so an opposite-state
      attribution like "R3 en corto" is flagged even when the only
      signal is a negation), then, when not skipping, matches the
      exercise AC patterns into detectedACs and the per-element
      turnVerdict, writing both onto the context.
  */
  async execute(context) {
    context.stateMismatches = _computeStateMismatches(context);

    if (this.canSkip(context)) {
      context.detectedACs = [];
      context.turnVerdict = null;
      _traceAcDetection(context, [], null, "skipped");
      return;
    }
    const exerciseNum = context.exerciseNum != null
      ? context.exerciseNum
      : (context.exercise && context.exercise.getExerciseNumber && context.exercise.getExerciseNumber());
    const correctAnswer = context.correctAnswer ||
      (context.exercise && context.exercise.tutorContext && context.exercise.tutorContext.correctAnswer) ||
      [];

    const proposed = (context.classification.proposed || []).map(_norm).filter(Boolean);
    const negated = (context.classification.negated || []).map(_norm).filter(Boolean);
    const correct = (correctAnswer || []).map(_norm).filter(Boolean);

    const patterns = exerciseNum != null ? getPatternsForExercise(exerciseNum) : [];
    if (patterns.length > 0) {
      context.detectedACs = matchACs(patterns, proposed, negated, correct);
    } else {
      context.detectedACs = [];
    }

    context.turnVerdict = _computeVerdict(proposed, negated, correct);

    _traceAcDetection(context, context.detectedACs, context.turnVerdict,
      patterns.length === 0 ? "no_patterns_for_exercise" : "ok");
  }
}

/*
 AgentContext,[Obj],Obj,Txt -> ____|_____________________
                              | _traceAcDetection() | -> void
                               ---------------------
      Diagnostic logger: prints the detected ACs and the turnVerdict
      decomposition for the turn. Never throws, so a logging failure
      can never break the pipeline flow.
*/
function _traceAcDetection(context, detectedACs, verdict, reason) {
  try {
    const reqId = (context && context.reqId) || "";
    const exNum = context && context.exerciseNum;
    const top = (detectedACs || []).slice(0, 3).map(function (a) {
      return a.id + "@" + (a.confidence != null ? a.confidence.toFixed(2) : "?")
        + (a.reason ? "[" + a.reason + "]" : "");
    }).join(",");
    const v = verdict
      ? verdict.verdict
        + " hits=[" + (verdict.hits || []).join(",") + "]"
        + " errors=[" + (verdict.errors || []).join(",") + "]"
        + " missing=[" + (verdict.missing || []).join(",") + "]"
        + " wronglyNegated=[" + (verdict.wronglyNegated || []).join(",") + "]"
      : "—";
    console.log(
      "[TRACE] [" + reqId + "] 🎯 AC_DETECTED ex=" + (exNum != null ? exNum : "?")
      + " count=" + (detectedACs || []).length
      + " top=[" + top + "]"
      + " verdict=" + v
      + " reason=" + reason
    );
  } catch (_) { }
}

/*
 AgentContext -> ____|_____________________________
                | _computeStateMismatches() | -> [Obj]
                 ---------------------------
      Derives each element's true state from the exercise netlist and
      expert reasoning, then flags any opposite-state attribution in the
      user message. Returns [] on any error or when there is no context.
*/
function _computeStateMismatches(context) {
  try {
    const { deriveElementStates, detectStateMismatch } = require("../services/rag/elementStates");
    const tc = context && context.exercise && context.exercise.tutorContext;
    if (!tc) return [];
    const states = deriveElementStates(tc.netlist, tc.expertMode || tc.expertReasoning);
    return detectStateMismatch(context.userMessage || "", states);
  } catch (_) {
    return [];
  }
}

/*
   Txt -> ____|________
         | _norm() | -> Txt
          ---------
      Normalises an element label to uppercase with whitespace removed;
      returns "" for non-string input.
*/
function _norm(x) {
  if (typeof x !== "string") return "";
  return x.toUpperCase().replace(/\s+/g, "");
}

/*
 [Txt],[Txt],[Txt] -> ____|__________________
                     | _computeVerdict() | -> Obj
                      -------------------
      Canonical per-element decomposition of the turn: splits proposed
      into hits/errors against the correct set, computes missing and
      wronglyNegated, and labels the verdict as correct, partial_correct,
      incorrect or only_negation.
*/
function _computeVerdict(proposed, negated, correct) {
  const correctSet = new Set(correct);
  const proposedSet = new Set(proposed);
  const negatedSet = new Set(negated);

  const hits = [];
  const errors = [];
  for (const p of proposed) {
    if (correctSet.has(p)) hits.push(p);
    else errors.push(p);
  }
  const missing = [];
  for (const c of correct) {
    if (!proposedSet.has(c) && !negatedSet.has(c)) missing.push(c);
  }
  const wronglyNegated = [];
  for (const n of negated) {
    if (correctSet.has(n)) wronglyNegated.push(n);
  }

  let verdict;
  if (proposed.length === 0 && negated.length > 0) {
    verdict = "only_negation";
  } else if (errors.length === 0 && missing.length === 0 && wronglyNegated.length === 0 && hits.length > 0) {
    verdict = "correct";
  } else if (hits.length > 0) {
    verdict = "partial_correct";
  } else {
    verdict = "incorrect";
  }

  return { verdict, hits, errors, missing, wronglyNegated, correct, proposed, negated };
}

module.exports = AcDetectorAgent;
