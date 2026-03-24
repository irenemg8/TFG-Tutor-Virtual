// backend/src/models/concepcionAlternativa.js
const mongoose = require("mongoose");

const concepcionAlternativaSchema = new mongoose.Schema(
  {
    descripcion:         { type: String, required: true },
    codigo:              { type: String, required: true, unique: true, trim: true },
    ejemplosError:       { type: [String], default: [] },
    estrategiaSocratica: { type: String, default: "" },
    conceptos: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: "Concepto",
      },
    ],
  },
  { timestamps: true }
);

module.exports = mongoose.model(
  "ConcepcionAlternativa",
  concepcionAlternativaSchema,
  "concepciones_alternativas"
);
