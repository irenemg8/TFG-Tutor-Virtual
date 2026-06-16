const express = require("express");
const container = require("../../../container");
const { requireRole } = require("../middleware/authMiddleware");

const router = express.Router();

/*------------------------------------------------------------------------------
            _________________________________________________________
            |                    USUARIOS ROUTES                    |
            |  Express router exposing admin-only CRUD over users.   |
            |  Every endpoint requires the admin role. Endpoints:   |
            |     POST /usuarios       -> Usuario                   |
            |     GET  /usuarios       -> [Usuario]                 |
            |     GET  /usuarios/:id    -> Usuario                   |
            |     PUT  /usuarios/:id    -> Usuario                   |
        ____|__________                                              |
   Obj -> | repo() | -> UsuarioRepo | null       (reads container)   |
          ----------                                                 |
            |                                                       |
            |_______________________________________________________|
------------------------------------------------------------------------------*/

/*
 Obj -> ____|__________
       | repo() | -> UsuarioRepo | null    (reads container (Obj))
        ----------
    Resolves the user repository from the container. Sends a 503 and
    returns null when the persistence layer is not initialized yet.
*/
function repo(res) {
  if (!container._initialized || !container.usuarioRepo) {
    res.status(503).json({ error: "service_unavailable" });
    return null;
  }
  return container.usuarioRepo;
}

router.post("/usuarios", requireRole("admin"), async (req, res) => {
  const r = repo(res); if (!r) return;
  try {
    const created = await r.create(req.body);
    return res.json(created);
  } catch (err) {
    return res.status(400).json({ message: err.message });
  }
});

router.get("/usuarios", requireRole("admin"), async (_req, res) => {
  const r = repo(res); if (!r) return;
  try {
    const all = await r.findAll();
    return res.json(all);
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
});

router.get("/usuarios/:id", requireRole("admin"), async (req, res) => {
  const r = repo(res); if (!r) return;
  try {
    const u = await r.findById(req.params.id);
    if (!u) return res.status(404).json({ message: "Usuario no encontrado" });
    return res.json(u);
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
});

router.put("/usuarios/:id", requireRole("admin"), async (req, res) => {
  const r = repo(res); if (!r) return;
  try {
    const { loguin_usuario } = req.body;
    const updated = await r.updateById(req.params.id, { loguin_usuario });
    return res.json(updated);
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
});

module.exports = router;
