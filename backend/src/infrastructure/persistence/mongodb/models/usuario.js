// backend/models/usuario.js
const mongoose = require("mongoose");

const userSchema = new mongoose.Schema(
  {
    // ✅ Campo que ya tenías (lo mantenemos para compatibilidad)
    loguin_usuario: {
      type: String,
      required: false, // lo dejamos NO obligatorio para que CAS/demo puedan crear usuario sin este campo
      default: null,
    },

    // ✅ Identificador real para CAS / demo (recomendado)
    upvLogin: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },

    // ✅ Campos opcionales útiles
    email: { type: String, default: null },
    nombre: { type: String, default: null },
    apellidos: { type: String, default: null },
    dni: { type: String, default: null },
    grupos: { type: [String], default: [] },

    rol: { type: String, default: "alumno" },
    lastLoginAt: { type: Date, default: null },
  },
  { timestamps: true }
);

module.exports = mongoose.model("Usuario", userSchema);
