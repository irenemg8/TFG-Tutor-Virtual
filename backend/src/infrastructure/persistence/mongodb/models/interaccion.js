const mongoose = require('mongoose');

// Per-message metadata (only present on assistant messages from the RAG pipeline)
const messageMetadataSchema = new mongoose.Schema({
    classification: { type: String, default: null },     // e.g. "correct_no_reasoning"
    decision: { type: String, default: null },           // e.g. "rag_examples", "deterministic_finish"
    guardrails: {
        solutionLeak: { type: Boolean, default: false },
        falseConfirmation: { type: Boolean, default: false },
        prematureConfirmation: { type: Boolean, default: false },
        stateReveal: { type: Boolean, default: false },
    },
    timing: {
        pipelineMs: { type: Number, default: null },     // RAG pipeline duration
        ollamaMs: { type: Number, default: null },       // LLM call duration
        totalMs: { type: Number, default: null },         // total request duration
    },
    sourcesCount: { type: Number, default: 0 },           // number of retrieved docs
    isCorrectAnswer: { type: Boolean, default: null },    // whether the student's answer was correct
    studentResponseMs: { type: Number, default: null },   // time since last assistant message
}, { _id: false });

// Schema for each individual message in the conversation
const messageSchema = new mongoose.Schema({
    role: {
        type: String,
        required: true,
        enum: ['user', 'assistant'],
        default: 'user'
    },
    content: {
        type: String,
        required: true
    },
    timestamp: {
        type: Date,
        default: Date.now
    },
    metadata: {
        type: messageMetadataSchema,
        default: null
    }
}, { _id: false });


// Definición del esquema principal para una Interacción completa entre usuario y tutor
const interaccionSchema = mongoose.Schema({
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
    inicio: {
        type: Date,
        required: true,
        default: Date.now
    },
    fin: {
        type: Date,
        default: Date.now // Establece la fecha actual por defecto, se actualizará
    },
    conversacion: {
        type: [messageSchema], // Este es el campo clave: un array de mensajes
        default: []
    }
});

module.exports = mongoose.model("Interaccion", interaccionSchema);