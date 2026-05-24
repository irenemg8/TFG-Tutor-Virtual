// backend/src/models/ejercicio.js
const mongoose = require("mongoose");

const tutorContextSchema = new mongoose.Schema(
  {
    objetivo: { type: String, default: "" },
    netlist: { type: String, default: "" },
    modoExperto: { type: String, default: "" },
    ac_refs: { type: [String], default: [] },
    version: { type: Number, default: 1 },
    respuestaCorrecta: { type: [String], default: [] },
  },
  { _id: false }
);

const ejercicioSchema = new mongoose.Schema({
  titulo: { type: String, required: true },
  enunciado: { type: String, required: true },
  imagen: { type: String, default: "" },

  asignatura: { type: String, required: true },
  concepto: { type: String, required: true },
  nivel: { type: Number, required: true },

  // Este campo lo tienes en tus docs actuales.
  // No lo borro aquí para no romper compatibilidad,
  // pero en Fase A lo dejaremos como “legacy” y el promptBuilder lo ignorará si hay tutorContext.

  tutorContext: { type: tutorContextSchema, default: () => ({}) },

  // Si lo estabas usando para otra cosa, déjalo; si no, puedes eliminarlo más adelante.
  // IMPORTANTE: required en String puede fallar con "" en mongoose.
  CA: { type: String, default: "" },
},
  { timestamps: true }
);

module.exports = mongoose.model("Ejercicio", ejercicioSchema, "ejercicios");
