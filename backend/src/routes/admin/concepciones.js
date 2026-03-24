// backend/src/routes/admin/concepciones.js
const { Router } = require("express");
const ConcepcionAlternativa = require("../../models/concepcionAlternativa");
const Ejercicio = require("../../models/ejercicio");
const { isValidObjectId } = require("../../utils/validate");

const router = Router();

// GET / — Listar todas las concepciones con conceptos populados
router.get("/", async (req, res) => {
  try {
    const concepciones = await ConcepcionAlternativa.find()
      .populate("conceptos", "nombre asignatura");
    return res.status(200).json({ concepciones });
  } catch (err) {
    console.error("[ADMIN CONCEPCIONES] GET /", err);
    return res.status(500).json({ error: "Error interno del servidor" });
  }
});

// GET /:id — Obtener una concepción por ID (populada)
router.get("/:id", async (req, res) => {
  const { id } = req.params;
  if (!isValidObjectId(id)) {
    return res.status(400).json({ error: "ID inválido" });
  }
  try {
    const concepcion = await ConcepcionAlternativa.findById(id)
      .populate("conceptos", "nombre asignatura");
    if (!concepcion) {
      return res.status(404).json({ error: "Concepción alternativa no encontrada" });
    }
    return res.status(200).json({ concepcion });
  } catch (err) {
    if (err.name === "CastError") {
      return res.status(400).json({ error: "ID inválido" });
    }
    console.error("[ADMIN CONCEPCIONES] GET /:id", err);
    return res.status(500).json({ error: "Error interno del servidor" });
  }
});

// POST / — Crear una concepción alternativa
router.post("/", async (req, res) => {
  let { descripcion, codigo, ejemplosError, estrategiaSocratica, conceptos } = req.body;

  // If ejemplosError is provided, filter empty strings
  if (Array.isArray(ejemplosError)) {
    ejemplosError = ejemplosError.map(e => String(e).trim()).filter(e => e.length > 0);
  }

  const camposFaltantes = [];
  if (!descripcion || !descripcion.toString().trim()) camposFaltantes.push("descripcion");
  if (!codigo || !codigo.toString().trim()) camposFaltantes.push("codigo");

  if (camposFaltantes.length > 0) {
    return res.status(400).json({
      error: "Campos requeridos faltantes",
      campos: camposFaltantes,
    });
  }

  if (conceptos !== undefined) {
    if (!Array.isArray(conceptos)) {
      return res.status(400).json({ error: "conceptos debe ser un array" });
    }
    const invalidIds = conceptos.filter((c) => !isValidObjectId(c));
    if (invalidIds.length > 0) {
      return res.status(400).json({ error: "conceptos contiene IDs inválidos" });
    }
  }

  try {
    const concepcion = await ConcepcionAlternativa.create({
      descripcion: descripcion.trim(),
      codigo: codigo.trim(),
      ejemplosError: ejemplosError || [],
      estrategiaSocratica: estrategiaSocratica || "",
      conceptos: conceptos || [],
    });

    const populated = await concepcion.populate("conceptos", "nombre asignatura");
    return res.status(201).json({ concepcion: populated });
  } catch (err) {
    if (err.name === "ValidationError") {
      return res.status(400).json({ error: err.message });
    }
    if (err.name === "CastError") {
      return res.status(400).json({ error: "ID inválido" });
    }
    if (err.code === 11000) {
      return res.status(409).json({ error: "El código ya existe" });
    }
    console.error("[ADMIN CONCEPCIONES] POST /", err);
    return res.status(500).json({ error: "Error interno del servidor" });
  }
});

// PUT /:id — Actualizar una concepción alternativa
router.put("/:id", async (req, res) => {
  const { id } = req.params;
  if (!isValidObjectId(id)) {
    return res.status(400).json({ error: "ID inválido" });
  }

  let { descripcion, codigo, ejemplosError, estrategiaSocratica, conceptos } = req.body;

  // If ejemplosError is provided, filter empty strings
  if (Array.isArray(ejemplosError)) {
    ejemplosError = ejemplosError.map(e => String(e).trim()).filter(e => e.length > 0);
  }

  if (conceptos !== undefined) {
    if (!Array.isArray(conceptos)) {
      return res.status(400).json({ error: "conceptos debe ser un array" });
    }
    const invalidIds = conceptos.filter((c) => !isValidObjectId(c));
    if (invalidIds.length > 0) {
      return res.status(400).json({ error: "conceptos contiene IDs inválidos" });
    }
  }

  const updateData = {};
  if (descripcion !== undefined) updateData.descripcion = descripcion;
  if (codigo !== undefined) updateData.codigo = codigo;
  if (ejemplosError !== undefined) updateData.ejemplosError = ejemplosError;
  if (estrategiaSocratica !== undefined) updateData.estrategiaSocratica = estrategiaSocratica;
  if (conceptos !== undefined) updateData.conceptos = conceptos;

  try {
    const concepcion = await ConcepcionAlternativa.findByIdAndUpdate(
      id,
      { $set: updateData },
      { new: true, runValidators: true }
    ).populate("conceptos", "nombre asignatura");

    if (!concepcion) {
      return res.status(404).json({ error: "Concepción alternativa no encontrada" });
    }
    return res.status(200).json({ concepcion });
  } catch (err) {
    if (err.name === "ValidationError") {
      return res.status(400).json({ error: err.message });
    }
    if (err.name === "CastError") {
      return res.status(400).json({ error: "ID inválido" });
    }
    if (err.code === 11000) {
      return res.status(409).json({ error: "El código ya existe" });
    }
    console.error("[ADMIN CONCEPCIONES] PUT /:id", err);
    return res.status(500).json({ error: "Error interno del servidor" });
  }
});

// DELETE /:id — Eliminar una concepción (bloquear si está referenciada por ejercicios)
router.delete("/:id", async (req, res) => {
  const { id } = req.params;
  if (!isValidObjectId(id)) {
    return res.status(400).json({ error: "ID inválido" });
  }

  try {
    const concepcion = await ConcepcionAlternativa.findById(id);
    if (!concepcion) {
      return res.status(404).json({ error: "Concepción alternativa no encontrada" });
    }

    const count = await Ejercicio.countDocuments({ concepciones_alternativas: id });
    if (count > 0) {
      return res.status(409).json({
        error: "No se puede eliminar: hay ejercicios que referencian esta concepción",
        count,
      });
    }

    await ConcepcionAlternativa.findByIdAndDelete(id);
    return res.status(200).json({ message: "Concepción alternativa eliminada" });
  } catch (err) {
    if (err.name === "CastError") {
      return res.status(400).json({ error: "ID inválido" });
    }
    console.error("[ADMIN CONCEPCIONES] DELETE /:id", err);
    return res.status(500).json({ error: "Error interno del servidor" });
  }
});

module.exports = router;
