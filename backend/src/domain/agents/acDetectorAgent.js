"use strict";

const AgentInterface = require("./base/AgentInterface");
const { matchACs, getPatternsForExercise } = require("../services/acRegistry");

/**
 * AcDetectorAgent: dos cómputos deterministas por turno.
 *
 *   1. detectedACs — cruza proposed/negated contra los acPatterns del
 *      ejercicio (delega en acRegistry.matchACs). Lista ordenada por
 *      confianza, consumida por tutorAgent para el banner [AC DETECTADA].
 *
 *   2. turnVerdict (NS-30) — descomposición canónica per-elemento contra
 *      la respuesta correcta del ejercicio:
 *        hits    = proposed ∩ correctAnswer
 *        errors  = proposed \ correctAnswer
 *        missing = correctAnswer \ proposed (ignorando negated)
 *        verdict ∈ {correct, partial_correct, incorrect, only_negation}
 *      Esta descomposición es la "verdad estructurada" que el banner
 *      [VEREDICTO DEL TURNO] entrega al LLM para que cumpla el protocolo
 *      pedagógico de Irene (afirmar hits + cuestionar errors + pista para
 *      missing) sin tener que deducirlo del prompt en prosa.
 *
 * Se ejecuta DESPUÉS de classifierAgent y ANTES de tutorAgent.
 * Puro: no I/O, no LLM. Coste despreciable.
 */
class AcDetectorAgent extends AgentInterface {
  constructor(deps) {
    super("acDetectorAgent");
    this.deps = deps || {};
  }

  canSkip(context) {
    if (!context.classification) return true;
    const proposed = context.classification.proposed || [];
    const negated = context.classification.negated || [];
    return proposed.length === 0 && negated.length === 0;
  }

  async execute(context) {
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

    // 1. AC matches (existing behaviour)
    const patterns = exerciseNum != null ? getPatternsForExercise(exerciseNum) : [];
    if (patterns.length > 0) {
      context.detectedACs = matchACs(patterns, proposed, negated, correct);
    } else {
      context.detectedACs = [];
    }

    // 2. NS-30 — turn verdict (deterministic)
    context.turnVerdict = _computeVerdict(proposed, negated, correct);

    _traceAcDetection(context, context.detectedACs, context.turnVerdict,
      patterns.length === 0 ? "no_patterns_for_exercise" : "ok");
  }
}

// Temporary diagnostic trace (2026-05-11): visibilizar en logs qué ACs
// se detectan por turno y qué descomposición arroja el turnVerdict. Sin
// esto, el log sólo mostraba [PER-ELEMENT ANALYSIS] al final del prompt
// (recortado en logs largos) y no había forma de confirmar si el banner
// [AC DETECTADA] estaba inyectándose. Quitar cuando se valide en prod.
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
  } catch (_) { /* nunca romper el flujo por una traza */ }
}

function _norm(x) {
  if (typeof x !== "string") return "";
  return x.toUpperCase().replace(/\s+/g, "");
}

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
  // Negated elements that ARE in the correct answer = wrong rejections.
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
