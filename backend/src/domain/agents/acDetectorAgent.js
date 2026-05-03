"use strict";

const AgentInterface = require("./base/AgentInterface");
const { matchACs, getPatternsForExercise } = require("../services/acRegistry");

/**
 * AcDetectorAgent: cruza la propuesta del alumno (context.classification.proposed
 * / negated) con los acPatterns del ejercicio actual (context.ejercicio.tutorContext.acPatterns)
 * y guarda en context.detectedACs los matches ordenados por confianza.
 *
 * Se ejecuta DESPUÉS de classifierAgent (que rellena classification.proposed/negated)
 * y ANTES de tutorAgent (que lee detectedACs para inyectar el banner [AC DETECTADA]).
 *
 * Es puro: no hace I/O, no llama al LLM. Coste despreciable.
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
      return;
    }
    // acPatterns NO se persisten en la entidad TutorContext / DB (decisión
    // NS-1.b: evitar migrar el schema). Se cargan del JSON via acRegistry.
    const exerciseNum = context.exerciseNum != null
      ? context.exerciseNum
      : (context.ejercicio && context.ejercicio.getExerciseNumber && context.ejercicio.getExerciseNumber());
    const patterns = exerciseNum != null ? getPatternsForExercise(exerciseNum) : [];
    if (patterns.length === 0) {
      context.detectedACs = [];
      return;
    }
    const correctAnswer = context.correctAnswer ||
      (context.ejercicio && context.ejercicio.tutorContext && context.ejercicio.tutorContext.respuestaCorrecta) ||
      [];
    const matches = matchACs(
      patterns,
      context.classification.proposed || [],
      context.classification.negated || [],
      correctAnswer
    );
    context.detectedACs = matches;
  }
}

module.exports = AcDetectorAgent;
