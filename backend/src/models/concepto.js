// backend/src/models/concepto.js
const mongoose = require("mongoose");

const conceptoSchema = new mongoose.Schema(
  {
    nombre:      { type: String, required: true, trim: true },
    descripcion: { type: String, default: "" },
    asignatura:  { type: String, required: true, trim: true },
  },
  { timestamps: true }
);

module.exports = mongoose.model("Concepto", conceptoSchema, "conceptos");
