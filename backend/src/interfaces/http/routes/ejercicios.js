const express = require("express");
const container = require("../../../container");
const { requireRole } = require("../middleware/authMiddleware");

const router = express.Router();

/*------------------------------------------------------------------------------
            _________________________________________________________
            |                   EJERCICIOS ROUTES                   |
            |  Express router exposing CRUD over exercises. Mounted  |
            |  under /api/ejercicios. Reads are open; writes require |
            |  the profesor/admin role. Endpoints:                  |
            |     GET    /          -> [Ejercicio]                  |
            |     POST   /          -> Ejercicio   (profesor/admin) |
            |     GET    /:id        -> Ejercicio                    |
            |     PUT    /:id        -> Ejercicio   (profesor/admin) |
            |     DELETE /:id        -> Obj         (profesor/admin) |
        ____|__________                                              |
   Obj -> | repo() | -> EjercicioRepo | null     (reads container)   |
          ----------                                                 |
            |                                                       |
            |_______________________________________________________|
------------------------------------------------------------------------------*/

/*
 Obj -> ____|__________
       | repo() | -> EjercicioRepo | null    (reads container (Obj))
        ----------
    Resolves the exercise repository from the container. Sends a 503 and
    returns null when the persistence layer is not initialized yet.
*/
function repo(res) {
  if (!container._initialized || !container.ejercicioRepo) {
    res.status(503).json({ error: "service_unavailable" });
    return null;
  }
  return container.ejercicioRepo;
}

router.get("/", async (_req, res) => {
  const r = repo(res); if (!r) return;
  try {
    const data = await r.findAll();
    return res.status(200).json(data);
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
});

router.post("/", requireRole("profesor", "admin"), async (req, res) => {
  const r = repo(res); if (!r) return;
  try {
    const b = req.body || {};
    const created = await r.create({
      title: b.title ?? b.titulo,
      statement: b.statement ?? b.enunciado,
      image: b.image ?? b.imagen,
      subject: b.subject ?? b.asignatura,
      concept: b.concept ?? b.concepto,
      level: b.level ?? b.nivel,
      ac: b.ac ?? b.CA,
      tutorContext: b.tutorContext,
    });
    return res.status(201).json(created);
  } catch (err) {
    return res.status(400).json({ message: err.message });
  }
});

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

router.put("/:id", requireRole("profesor", "admin"), async (req, res) => {
  const r = repo(res); if (!r) return;
  try {
    const b = req.body || {};
    const updated = await r.updateById(req.params.id, {
      title: b.title ?? b.titulo,
      statement: b.statement ?? b.enunciado,
      image: b.image ?? b.imagen,
      subject: b.subject ?? b.asignatura,
      concept: b.concept ?? b.concepto,
      level: b.level ?? b.nivel,
      ac: b.ac ?? b.CA,
    });
    return res.json(updated);
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
});

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
