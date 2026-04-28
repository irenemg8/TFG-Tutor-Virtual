// backend/src/interfaces/http/routes/ejercicios.js
const express = require("express");
const container = require("../../../container");
const { requireRole } = require("../middleware/authMiddleware");

const router = express.Router();

function repo(res) {
  if (!container._initialized || !container.ejercicioRepo) {
    res.status(503).json({ error: "service_unavailable" });
    return null;
  }
  return container.ejercicioRepo;
}

// Obtener todos los ejercicios
router.get("/", async (_req, res) => {
  const r = repo(res); if (!r) return;
  try {
    const data = await r.findAll();
    return res.status(200).json(data);
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
});

// Crear un nuevo ejercicio (profesor/admin only)
router.post("/", requireRole("profesor", "admin"), async (req, res) => {
  const r = repo(res); if (!r) return;
  try {
    const created = await r.create(req.body);
    return res.status(201).json(created);
  } catch (err) {
    return res.status(400).json({ message: err.message });
  }
});

// Obtener un ejercicio por ID
router.get("/:id", async (req, res) => {
  const r = repo(res); if (!r) return;
  try {
    const ej = await r.findById(req.params.id);
    if (!ej) return res.status(404).json({ message: "ejercicio no encontrado" });
    return res.json(ej);
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
});

// Actualizar un ejercicio por ID (profesor/admin only)
router.put("/:id", requireRole("profesor", "admin"), async (req, res) => {
  const r = repo(res); if (!r) return;
  try {
    const { titulo, enunciado, imagen, asignatura, concepto, nivel, CA } = req.body;
    const updated = await r.updateById(req.params.id, {
      titulo, enunciado, imagen, asignatura, concepto, nivel, CA,
    });
    return res.json(updated);
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
});

// Eliminar un ejercicio por ID (profesor/admin only)
router.delete("/:id", requireRole("profesor", "admin"), async (req, res) => {
  const r = repo(res); if (!r) return;
  try {
    await r.deleteById(req.params.id);
    return res.json({ ok: true });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
});

module.exports = router;
