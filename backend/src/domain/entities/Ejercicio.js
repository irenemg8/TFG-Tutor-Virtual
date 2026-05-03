"use strict";

const TutorContext = require("./TutorContext");

class Ejercicio {
  /**
   * @param {object} props
   * @param {string}  props.id
   * @param {string}  props.titulo
   * @param {string}  props.enunciado
   * @param {string} [props.imagen]
   * @param {string}  props.asignatura
   * @param {string}  props.concepto
   * @param {number}  props.nivel
   * @param {string} [props.ca]
   * @param {object} [props.tutorContext]
   * @param {Date}   [props.createdAt]
   * @param {Date}   [props.updatedAt]
   */
  constructor(props) {
    this.id = props.id;
    this.titulo = props.titulo;
    this.enunciado = props.enunciado;
    this.imagen = props.imagen || "";
    this.asignatura = props.asignatura;
    this.concepto = props.concepto;
    this.nivel = props.nivel;
    this.ca = props.ca || "";
    this.tutorContext = props.tutorContext
      ? new TutorContext(props.tutorContext)
      : null;
    this.createdAt = props.createdAt || new Date();
    this.updatedAt = props.updatedAt || new Date();
  }

  getCorrectAnswer() {
    return this.tutorContext?.respuestaCorrecta || [];
  }

  getEvaluableElements() {
    return this.tutorContext?.elementosEvaluables || [];
  }

  getExerciseNumber() {
    // 1) Title with explicit number ("Ejercicio 3", "3 - Foo", etc.)
    const fromTitle = this.titulo?.match(/\d+/);
    if (fromTitle) return parseInt(fromTitle[0], 10);
    // 2) Fallback to imagen path "/static/EjercicioN.jpg" (the seeder writes
    //    this convention). Without this, exercises seeded from the local
    //    JSON (titles like "Resistencias y Circuito Abierto") had
    //    exerciseNum=null and ragPipeline routed retrieval to collection
    //    "exercise_null" — BM25 / semantic search returned 0 results.
    const fromImagen = this.imagen?.match(/Ejercicio(\d+)/i);
    if (fromImagen) return parseInt(fromImagen[1], 10);
    return null;
  }

  hasValidTutorContext() {
    if (this.tutorContext === null) return false;
    if (this.getCorrectAnswer().length === 0) return false;
    const objetivo = (this.tutorContext.objetivo || "").trim();
    const netlist = (this.tutorContext.netlist || "").trim();
    const modoExperto = (this.tutorContext.modoExperto || "").trim();
    // Thresholds protect against historic data poisoning where seeds
    // produced rows with empty objetivo/netlist/modoExperto, sending
    // "(not defined)" placeholders into the tutor system prompt and
    // contradicting the "CORRECT ANSWER is your ground truth" rule.
    if (objetivo.length < 30) return false;
    if (netlist.length < 10) return false;
    if (modoExperto.length < 50) return false;
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
      titulo: this.titulo,
      enunciado: this.enunciado,
      imagen: this.imagen,
      asignatura: this.asignatura,
      concepto: this.concepto,
      nivel: this.nivel,
      CA: this.ca,
      tutorContext: this.tutorContext,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
    };
  }
}

module.exports = Ejercicio;
