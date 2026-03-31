// backend/src/routes/admin/ejercicios.js
const path = require("path");
const crypto = require("crypto");
const { Router } = require("express");
const multer = require("multer");
const Ejercicio = require("../../models/ejercicio");
const { isValidObjectId } = require("../../utils/validate");

const router = Router();

// ====== Multer — imagen de ejercicio ======
const staticDir = path.join(__dirname, "..", "..", "static");

const storage = multer.diskStorage({
  destination: function (_req, _file, cb) {
    cb(null, staticDir);
  },
  filename: function (_req, file, cb) {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, crypto.randomUUID() + ext);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5 MB
  fileFilter: function (_req, file, cb) {
    const allowed = ["image/jpeg", "image/png", "image/gif", "image/webp"];
    if (allowed.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(Object.assign(new Error("Tipo de archivo no permitido"), { code: "INVALID_TYPE" }));
    }
  },
});

// ====== Helpers ======
function validateEjercicioBody(body, requireAll) {
  const { titulo, enunciado, asignatura, concepto, nivel, concepciones_alternativas } = body;
  const errors = [];

  if (requireAll) {
    if (!titulo || !titulo.toString().trim()) errors.push("titulo");
    if (!enunciado || !enunciado.toString().trim()) errors.push("enunciado");
    if (!asignatura || !asignatura.toString().trim()) errors.push("asignatura");
    if (!concepto || !concepto.toString().trim()) errors.push("concepto");
    if (nivel === undefined || nivel === null || nivel === "") errors.push("nivel");
    else if (!Number.isInteger(Number(nivel)) || Number(nivel) < 1) {
      return { nivelError: true };
    }
  } else {
    if (nivel !== undefined && nivel !== null && nivel !== "") {
      if (!Number.isInteger(Number(nivel)) || Number(nivel) < 1) {
        return { nivelError: true };
      }
    }
  }

  if (errors.length > 0) {
    return { missingFields: errors };
  }

  if (concepciones_alternativas !== undefined) {
    if (!Array.isArray(concepciones_alternativas)) {
      return { concepcionesError: true };
    }
    const invalidIds = concepciones_alternativas.filter((c) => !isValidObjectId(c));
    if (invalidIds.length > 0) {
      return { concepcionesError: true };
    }
  }

  return null;
}

// ====== GET / — Listar ejercicios con concepciones populadas ======
router.get("/", async (req, res) => {
  try {
    const ejercicios = await Ejercicio.find()
      .populate("concepciones_alternativas", "codigo titulo descripcion");
    return res.status(200).json({ ejercicios });
  } catch (err) {
    console.error("[ADMIN EJERCICIOS] GET /", err);
    return res.status(500).json({ error: "Error interno del servidor" });
  }
});

// ====== GET /:id — Obtener un ejercicio por ID ======
router.get("/:id", async (req, res) => {
  const { id } = req.params;
  if (!isValidObjectId(id)) {
    return res.status(400).json({ error: "ID inválido" });
  }
  try {
    const ejercicio = await Ejercicio.findById(id)
      .populate("concepciones_alternativas", "codigo titulo descripcion");
    if (!ejercicio) {
      return res.status(404).json({ error: "Ejercicio no encontrado" });
    }
    return res.status(200).json({ ejercicio });
  } catch (err) {
    if (err.name === "CastError") {
      return res.status(400).json({ error: "ID inválido" });
    }
    console.error("[ADMIN EJERCICIOS] GET /:id", err);
    return res.status(500).json({ error: "Error interno del servidor" });
  }
});

// ====== POST / — Crear ejercicio ======
router.post("/", async (req, res) => {
  const validationError = validateEjercicioBody(req.body, true);
  if (validationError) {
    if (validationError.missingFields) {
      return res.status(400).json({
        error: "Campos requeridos faltantes",
        campos: validationError.missingFields,
      });
    }
    if (validationError.nivelError) {
      return res.status(400).json({ error: "nivel debe ser un entero positivo" });
    }
    if (validationError.concepcionesError) {
      return res.status(400).json({ error: "concepciones_alternativas contiene IDs inválidos" });
    }
  }

  const {
    titulo, enunciado, asignatura, concepto, nivel,
    imagen, CA, concepciones_alternativas, tutorContext,
  } = req.body;

  try {
    const ejercicio = await Ejercicio.create({
      titulo: titulo.trim(),
      enunciado: enunciado.trim(),
      asignatura: asignatura.trim(),
      concepto: concepto.trim(),
      nivel: Number(nivel),
      imagen: imagen || "",
      CA: CA || "",
      concepciones_alternativas: concepciones_alternativas || [],
      tutorContext: {
        ...(tutorContext || {}),
        version: 1,
      },
    });

    const populated = await ejercicio.populate("concepciones_alternativas", "codigo titulo descripcion");
    return res.status(201).json({ ejercicio: populated });
  } catch (err) {
    if (err.name === "ValidationError") {
      return res.status(400).json({ error: err.message });
    }
    if (err.name === "CastError") {
      return res.status(400).json({ error: "ID inválido" });
    }
    console.error("[ADMIN EJERCICIOS] POST /", err);
    return res.status(500).json({ error: "Error interno del servidor" });
  }
});

// ====== PUT /:id — Actualizar ejercicio (incrementa version) ======
router.put("/:id", async (req, res) => {
  const { id } = req.params;
  if (!isValidObjectId(id)) {
    return res.status(400).json({ error: "ID inválido" });
  }

  const validationError = validateEjercicioBody(req.body, false);
  if (validationError) {
    if (validationError.nivelError) {
      return res.status(400).json({ error: "nivel debe ser un entero positivo" });
    }
    if (validationError.concepcionesError) {
      return res.status(400).json({ error: "concepciones_alternativas contiene IDs inválidos" });
    }
  }

  const {
    titulo, enunciado, asignatura, concepto, nivel,
    imagen, CA, concepciones_alternativas, tutorContext,
  } = req.body;

  const setFields = {};
  if (titulo !== undefined) setFields.titulo = titulo;
  if (enunciado !== undefined) setFields.enunciado = enunciado;
  if (asignatura !== undefined) setFields.asignatura = asignatura;
  if (concepto !== undefined) setFields.concepto = concepto;
  if (nivel !== undefined) setFields.nivel = Number(nivel);
  if (imagen !== undefined) setFields.imagen = imagen;
  if (CA !== undefined) setFields.CA = CA;
  if (concepciones_alternativas !== undefined) setFields.concepciones_alternativas = concepciones_alternativas;

  // Merge partial tutorContext fields (not overwriting the whole subdoc)
  if (tutorContext !== undefined) {
    const allowed = ["objetivo", "netlist", "modoExperto", "ac_refs", "respuestaCorrecta"];
    for (const key of allowed) {
      if (tutorContext[key] !== undefined) {
        setFields[`tutorContext.${key}`] = tutorContext[key];
      }
    }
  }

  try {
    const ejercicio = await Ejercicio.findByIdAndUpdate(
      id,
      {
        $set: setFields,
        $inc: { "tutorContext.version": 1 },
      },
      { new: true, runValidators: true }
    ).populate("concepciones_alternativas", "codigo titulo descripcion");

    if (!ejercicio) {
      return res.status(404).json({ error: "Ejercicio no encontrado" });
    }
    return res.status(200).json({ ejercicio });
  } catch (err) {
    if (err.name === "ValidationError") {
      return res.status(400).json({ error: err.message });
    }
    if (err.name === "CastError") {
      return res.status(400).json({ error: "ID inválido" });
    }
    console.error("[ADMIN EJERCICIOS] PUT /:id", err);
    return res.status(500).json({ error: "Error interno del servidor" });
  }
});

// ====== DELETE /:id — Eliminar ejercicio ======
router.delete("/:id", async (req, res) => {
  const { id } = req.params;
  if (!isValidObjectId(id)) {
    return res.status(400).json({ error: "ID inválido" });
  }
  try {
    const ejercicio = await Ejercicio.findByIdAndDelete(id);
    if (!ejercicio) {
      return res.status(404).json({ error: "Ejercicio no encontrado" });
    }
    return res.status(200).json({ message: "Ejercicio eliminado" });
  } catch (err) {
    if (err.name === "CastError") {
      return res.status(400).json({ error: "ID inválido" });
    }
    console.error("[ADMIN EJERCICIOS] DELETE /:id", err);
    return res.status(500).json({ error: "Error interno del servidor" });
  }
});

// ====== POST /:id/imagen — Subir imagen del ejercicio ======
router.post("/:id/imagen", (req, res) => {
  const { id } = req.params;
  if (!isValidObjectId(id)) {
    return res.status(400).json({ error: "ID inválido" });
  }

  upload.single("imagen")(req, res, async (err) => {
    if (err) {
      if (err.code === "INVALID_TYPE") {
        return res.status(400).json({ error: "Tipo de archivo no permitido" });
      }
      if (err.code === "LIMIT_FILE_SIZE") {
        return res.status(400).json({ error: "El archivo supera el tamaño máximo (5 MB)" });
      }
      console.error("[ADMIN EJERCICIOS] POST /:id/imagen multer error", err);
      return res.status(400).json({ error: err.message || "Error al procesar el archivo" });
    }

    if (!req.file) {
      return res.status(400).json({ error: "No se recibió ningún archivo" });
    }

    try {
      const ejercicio = await Ejercicio.findByIdAndUpdate(
        id,
        { $set: { imagen: req.file.filename } },
        { new: true }
      );
      if (!ejercicio) {
        return res.status(404).json({ error: "Ejercicio no encontrado" });
      }
      return res.status(200).json({ imagen: req.file.filename });
    } catch (dbErr) {
      if (dbErr.name === "CastError") {
        return res.status(400).json({ error: "ID inválido" });
      }
      console.error("[ADMIN EJERCICIOS] POST /:id/imagen DB error", dbErr);
      return res.status(500).json({ error: "Error interno del servidor" });
    }
  });
});

module.exports = router;
