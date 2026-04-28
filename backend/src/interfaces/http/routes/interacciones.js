// backend/src/interfaces/http/routes/interacciones.js
const express = require("express");
const container = require("../../../container");
const { canAccessUserData } = require("../middleware/authMiddleware");

const router = express.Router();

function repo(res) {
  if (!container._initialized || !container.interaccionRepo) {
    res.status(503).json({ error: "service_unavailable" });
    return null;
  }
  return container.interaccionRepo;
}

// Validación de IDs: ObjectId (24 hex) o UUID (36 con guiones).
// Suficiente como guardia básica; la FK de Postgres valida el resto.
function isValidId(v) {
  if (typeof v !== "string") return false;
  if (/^[a-f0-9]{24}$/i.test(v)) return true;           // ObjectId legacy
  if (/^[0-9a-f-]{36}$/i.test(v)) return true;          // UUID
  return false;
}

// NOTE: globalAuth está aplicado a nivel de app. req.userId viene de la sesión.

// 0. Interacciones del usuario actual
router.get("/mine", async (req, res) => {
  const r = repo(res); if (!r) return;
  try {
    const data = await r.findByUserId(req.userId);
    return res.status(200).json(data);
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
});

// 1. LEGACY: interacciones de otro usuario (solo admin/profesor)
router.get("/user/:userId", async (req, res) => {
  const r = repo(res); if (!r) return;
  try {
    const { userId } = req.params;
    if (!isValidId(userId)) return res.status(400).json({ message: "ID inválido." });
    if (!canAccessUserData(userId, req)) {
      return res.status(403).json({ message: "No autorizado." });
    }
    const data = await r.findByUserId(userId);
    return res.status(200).json(data);
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
});

// 2. Última interacción del usuario actual + ejercicio
router.get("/byExercise/:exerciseId", async (req, res) => {
  const r = repo(res); if (!r) return;
  try {
    const { exerciseId } = req.params;
    if (!isValidId(exerciseId)) return res.status(400).json({ message: "ID de ejercicio inválido." });
    const i = await r.findLatestByExerciseAndUser(exerciseId, req.userId);
    return res.status(200).json(i || null);
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
});

// 2b. LEGACY: compat frontend anterior
router.get("/byExerciseAndUser/:exerciseId/:userId", async (req, res) => {
  const r = repo(res); if (!r) return;
  try {
    const { exerciseId, userId } = req.params;
    if (!isValidId(exerciseId) || !isValidId(userId)) {
      return res.status(400).json({ message: "IDs inválidos." });
    }
    if (!canAccessUserData(userId, req)) {
      return res.status(403).json({ message: "No autorizado." });
    }
    const i = await r.findLatestByExerciseAndUser(exerciseId, userId);
    return res.status(200).json(i || null);
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
});

// 3. Obtener una interacción concreta (con conversacion embedded al estilo legacy)
router.get("/:id", async (req, res) => {
  const r = repo(res); if (!r) return;
  try {
    const { id } = req.params;
    if (!isValidId(id)) return res.status(400).json({ message: "ID inválido." });
    const i = await r.findById(id);
    if (!i) return res.status(404).json({ message: "Interacción no encontrada." });
    if (!canAccessUserData(i.usuarioId || i.usuario_id, req)) {
      return res.status(403).json({ message: "No autorizado." });
    }
    // El frontend legacy espera `conversacion` como array embebido (como era
    // en Mongo). En Pg los mensajes viven en tabla aparte; los cargamos y los
    // inyectamos aquí para mantener el contrato del API sin tocar React.
    const messages = await container.messageRepo.getAllMessages(id);
    const body = i.toJSON();
    body.conversacion = messages;
    return res.status(200).json(body);
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
});

// 4. Borrar interacción (solo owner)
router.delete("/:id", async (req, res) => {
  const r = repo(res); if (!r) return;
  try {
    const { id } = req.params;
    if (!isValidId(id)) return res.status(400).json({ message: "ID inválido." });
    const i = await r.findById(id);
    if (!i) return res.status(404).json({ message: "Interacción no encontrada." });
    const ownerId = i.usuarioId || i.usuario_id;
    if (String(ownerId) !== String(req.userId)) {
      return res.status(403).json({ message: "No autorizado." });
    }
    await r.deleteById(id);
    return res.status(200).json({ message: "Interacción eliminada." });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
});

module.exports = router;
