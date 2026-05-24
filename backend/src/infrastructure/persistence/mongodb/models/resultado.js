const mongoose = require('mongoose');

const resultadoSchema = new mongoose.Schema({
    usuario_id: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Usuario',
        required: true
    },
    ejercicio_id: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Ejercicio',
        required: true
    },
    interaccion_id: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Interaccion',
        required: true
    },
    numMensajes: {
        type: Number,
        default: 0
    },

    // Guardará 'true' si el usuario resolvió el ejercicio en el primer intento.
    resueltoALaPrimera: {
        type: Boolean,
        default: false
    },
    // --------------------------
    analisisIA: { type: String, default: null },
    consejoIA: { type: String, default: null },
    fecha: { type: Date, default: Date.now },
    // --------------------
    errores: [
    {
      etiqueta: { type: String, required: true },
      texto: { type: String, required: true }
    }
  ],

});

// Recuerda tener el nombre de la colección ('resultados') como tercer parámetro.
module.exports = mongoose.model('Resultado', resultadoSchema, 'resultados');