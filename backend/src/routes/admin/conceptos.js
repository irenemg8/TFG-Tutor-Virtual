// backend/src/routes/admin/conceptos.js
const { Router } = require("express");
const Concepto = require("../../models/concepto");
const ConcepcionAlternativa = require("../../models/concepcionAlternativa");
const { isValidObjectId } = require("../../utils/validate");

const router = Router();

// GET / — Listar todos los conceptos ordenados por asignatura y nombre
router.get("/", async (req, res) => {
  try {
    const conceptos = await Concepto.find()
      .sort({ asignatura: 1, nombre: 1 });
    return res.status(200).json({ conceptos });
  } catch (err) {
    console.error("[ADMIN CONCEPTOS] GET /", err);
    return res.status(500).json({ error: "Error interno del servidor" });
  }
});

// GET /:id — Obtener un concepto por ID
router.get("/:id", async (req, res) => {
  const { id } = req.params;
  if (!isValidObjectId(id)) {
    return res.status(400).json({ error: "ID inválido" });
  }
  try {
    const concepto = await Concepto.findById(id);
    if (!concepto) {
      return res.status(404).json({ error: "Concepto no encontrado" });
    }
    return res.status(200).json({ concepto });
  } catch (err) {
    if (err.name === "CastError") {
      return res.status(400).json({ error: "ID inválido" });
    }
    console.error("[ADMIN CONCEPTOS] GET /:id", err);
    return res.status(500).json({ error: "Error interno del servidor" });
  }
});

// POST / — Crear un concepto
router.post("/", async (req, res) => {
  const { nombre, asignatura, descripcion } = req.body;

  const camposFaltantes = [];
  if (!nombre || !nombre.toString().trim()) camposFaltantes.push("nombre");
  if (!asignatura || !asignatura.toString().trim()) camposFaltantes.push("asignatura");

  if (camposFaltantes.length > 0) {
    return res.status(400).json({
      error: "Campos requeridos faltantes",
      campos: camposFaltantes,
    });
  }

  try {
    const concepto = await Concepto.create({
      nombre: nombre.trim(),
      asignatura: asignatura.trim(),
      descripcion: descripcion || "",
    });
    return res.status(201).json({ concepto });
  } catch (err) {
    if (err.name === "ValidationError") {
      return res.status(400).json({ error: err.message });
    }
    if (err.name === "CastError") {
      return res.status(400).json({ error: "ID inválido" });
    }
    console.error("[ADMIN CONCEPTOS] POST /", err);
    return res.status(500).json({ error: "Error interno del servidor" });
  }
});

// PUT /:id — Actualizar un concepto
router.put("/:id", async (req, res) => {
  const { id } = req.params;
  if (!isValidObjectId(id)) {
    return res.status(400).json({ error: "ID inválido" });
  }

  const { nombre, asignatura, descripcion } = req.body;
  const updateData = {};

  if (nombre !== undefined) {
    if (!nombre.toString().trim()) {
      return res.status(400).json({ error: "nombre no puede estar vacío" });
    }
    updateData.nombre = nombre.trim();
  }
  if (asignatura !== undefined) {
    if (!asignatura.toString().trim()) {
      return res.status(400).json({ error: "asignatura no puede estar vacía" });
    }
    updateData.asignatura = asignatura.trim();
  }
  if (descripcion !== undefined) {
    updateData.descripcion = descripcion;
  }

  try {
    const concepto = await Concepto.findByIdAndUpdate(
      id,
      { $set: updateData },
      { new: true, runValidators: true }
    );
    if (!concepto) {
      return res.status(404).json({ error: "Concepto no encontrado" });
    }
    return res.status(200).json({ concepto });
  } catch (err) {
    if (err.name === "ValidationError") {
      return res.status(400).json({ error: err.message });
    }
    if (err.name === "CastError") {
      return res.status(400).json({ error: "ID inválido" });
    }
    console.error("[ADMIN CONCEPTOS] PUT /:id", err);
    return res.status(500).json({ error: "Error interno del servidor" });
  }
});

// DELETE /:id — Eliminar un concepto (bloquear si está referenciado)
router.delete("/:id", async (req, res) => {
  const { id } = req.params;
  if (!isValidObjectId(id)) {
    return res.status(400).json({ error: "ID inválido" });
  }

  try {
    const concepto = await Concepto.findById(id);
    if (!concepto) {
      return res.status(404).json({ error: "Concepto no encontrado" });
    }

    const count = await ConcepcionAlternativa.countDocuments({ conceptos: id });
    if (count > 0) {
      return res.status(409).json({
        error: "No se puede eliminar: hay concepciones alternativas que referencian este concepto",
        count,
      });
    }

    await Concepto.findByIdAndDelete(id);
    return res.status(200).json({ message: "Concepto eliminado" });
  } catch (err) {
    if (err.name === "CastError") {
      return res.status(400).json({ error: "ID inválido" });
    }
    console.error("[ADMIN CONCEPTOS] DELETE /:id", err);
    return res.status(500).json({ error: "Error interno del servidor" });
  }
});

module.exports = router;
