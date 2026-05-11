"use strict";

const TutorContext = require("./TutorContext");

class Ejercicio {
  /**
   * @param {object} props
   * @param {string}  props.id
   * @param {string}  props.title
   * @param {string}  props.statement
   * @param {string} [props.image]
   * @param {string}  props.subject
   * @param {string}  props.concept
   * @param {number}  props.level
   * @param {string} [props.ac]
   * @param {object} [props.tutorContext]
   * @param {Date}   [props.createdAt]
   * @param {Date}   [props.updatedAt]
   */
  constructor(props) {
    this.id = props.id;
    this.title = props.title;
    this.statement = props.statement;
    this.image = props.image || "";
    this.subject = props.subject;
    this.concept = props.concept;
    this.level = props.level;
    this.ac = props.ac || "";
    this.tutorContext = props.tutorContext
      ? new TutorContext(props.tutorContext)
      : null;
    this.createdAt = props.createdAt || new Date();
    this.updatedAt = props.updatedAt || new Date();
  }

  getCorrectAnswer() {
    return this.tutorContext?.correctAnswer || [];
  }

  getEvaluableElements() {
    return this.tutorContext?.evaluableElements || [];
  }

  getExerciseNumber() {
    // 1) Title with explicit number ("Ejercicio 3", "3 - Foo", etc.)
    const fromTitle = this.title?.match(/\d+/);
    if (fromTitle) return parseInt(fromTitle[0], 10);
    // 2) Fallback to image path "/static/EjercicioN.jpg" (the seeder writes
    //    this convention). Without this, exercises seeded from the local
    //    JSON (titles like "Resistencias y Circuito Abierto") had
    //    exerciseNum=null and ragPipeline routed retrieval to collection
    //    "exercise_null" — BM25 / semantic search returned 0 results.
    const fromImage = this.image?.match(/Ejercicio(\d+)/i);
    if (fromImage) return parseInt(fromImage[1], 10);
    return null;
  }

  hasValidTutorContext() {
    if (this.tutorContext === null) return false;
    if (this.getCorrectAnswer().length === 0) return false;
    const objective = (this.tutorContext.objective || "").trim();
    const netlist = (this.tutorContext.netlist || "").trim();
    const expertMode = (this.tutorContext.expertMode || "").trim();
    // Thresholds protect against historic data poisoning where seeds
    // produced rows with empty objective/netlist/expertMode, sending
    // "(not defined)" placeholders into the tutor system prompt and
    // contradicting the "CORRECT ANSWER is your ground truth" rule.
    if (objective.length < 30) return false;
    if (netlist.length < 10) return false;
    if (expertMode.length < 50) return false;
    return true;
  }

  /**
   * JSON shape compatible with the legacy Mongo API consumed by the frontend.
   * Emits `_id`, and keeps `tutorContext` in camelCase (matches frontend usage).
   */
  toJSON() {
    return {
      _id: this.id,
      id: this.id,
      titulo: this.title,
      enunciado: this.statement,
      imagen: this.image,
      asignatura: this.subject,
      concepto: this.concept,
      nivel: this.level,
      CA: this.ac,
      tutorContext: this.tutorContext,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
    };
  }
}

module.exports = Ejercicio;
