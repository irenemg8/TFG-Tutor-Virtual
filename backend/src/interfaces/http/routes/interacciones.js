const express = require("express");
const container = require("../../../container");
const { canAccessUserData } = require("../middleware/authMiddleware");

const router = express.Router();

/*------------------------------------------------------------------------------
            _________________________________________________________
            |                  INTERACCIONES ROUTES                 |
            |  Express router over tutoring interactions. Mounted    |
            |  under /api/interacciones; globalAuth runs upstream so |
            |  req.userId comes from the session. Ownership is       |
            |  enforced per route via canAccessUserData. Endpoints:  |
            |     GET    /mine                          -> [Obj]    |
            |     GET    /user/:userId                  -> [Obj]    |
            |     GET    /byExercise/:exerciseId         -> Obj|null |
            |     GET    /byExerciseAndUser/:ex/:user    -> Obj|null |
            |     GET    /:id                            -> Obj     |
            |     DELETE /:id                            -> Obj     |
        ____|__________                                              |
   Obj -> | repo() | -> InteraccionRepo | null    (reads container)  |
          ----------                                                 |
        ____|_____________                                           |
   Txt -> | isValidId() | -> T/F                  (pure check)       |
          -------------                                              |
            |                                                       |
            |_______________________________________________________|
------------------------------------------------------------------------------*/

/*
 Obj -> ____|__________
       | repo() | -> InteraccionRepo | null    (reads container (Obj))
        ----------
    Resolves the interaction repository from the container. Sends a 503
    and returns null when the persistence layer is not initialized yet.
*/
function repo(res) {
  if (!container._initialized || !container.interaccionRepo) {
    res.status(503).json({ error: "service_unavailable" });
    return null;
  }
  return container.interaccionRepo;
}

/*
 Txt -> ____|_____________
       | isValidId() | -> T/F
        -------------
    True when the value is a legacy ObjectId (24 hex) or a UUID (36 chars
    with dashes). Basic guard; the Postgres FK validates the rest.
*/
function isValidId(v) {
  if (typeof v !== "string") return false;
  if (/^[a-f0-9]{24}$/i.test(v)) return true;
  if (/^[0-9a-f-]{36}$/i.test(v)) return true;
  return false;
}

router.get("/mine", async (req, res) => {
  const r = repo(res); if (!r) return;
  try {
    const data = await r.findByUserId(req.userId);
    return res.status(200).json(data);
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
});

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

router.get("/:id", async (req, res) => {
  const r = repo(res); if (!r) return;
  try {
    const { id } = req.params;
    if (!isValidId(id)) return res.status(400).json({ message: "ID inválido." });
    const i = await r.findById(id);
    if (!i) return res.status(404).json({ message: "Interacción no encontrada." });
    if (!canAccessUserData(i.userId || i.usuario_id, req)) {
      return res.status(403).json({ message: "No autorizado." });
    }
    const messages = await container.messageRepo.getAllMessages(id);
    const body = i.toJSON();
    body.conversacion = messages;
    return res.status(200).json(body);
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
});

router.delete("/:id", async (req, res) => {
  const r = repo(res); if (!r) return;
  try {
    const { id } = req.params;
    if (!isValidId(id)) return res.status(400).json({ message: "ID inválido." });
    const i = await r.findById(id);
    if (!i) return res.status(404).json({ message: "Interacción no encontrada." });
    const ownerId = i.userId || i.usuario_id;
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
