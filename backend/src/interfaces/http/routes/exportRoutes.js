// Export routes: JSON/CSV export of interactions and results (profesor/admin).
// GET /api/export/interacciones?userId=...&exerciseId=...&from=...&to=...&format=csv|json
// GET /api/export/resultados?userId=...&exerciseId=...&from=...&to=...&format=csv|json

const express = require("express");
const container = require("../../../container");
const { requireRole } = require("../middleware/authMiddleware");

const router = express.Router();

router.use(requireRole("profesor", "admin"));

function repos(res) {
  if (!container._initialized) {
    res.status(503).json({ error: "service_unavailable" });
    return null;
  }
  return {
    interaccionRepo: container.interaccionRepo,
    resultadoRepo: container.resultadoRepo,
    usuarioRepo: container.usuarioRepo,
    ejercicioRepo: container.ejercicioRepo,
    messageRepo: container.messageRepo,
  };
}

function isValidId(v) {
  if (typeof v !== "string") return false;
  return /^[a-f0-9]{24}$/i.test(v) || /^[0-9a-f-]{36}$/i.test(v);
}

function buildFilter(query) {
  const filter = {};
  if (query.userId && isValidId(query.userId)) filter.userId = query.userId;
  if (query.exerciseId && isValidId(query.exerciseId)) filter.ejercicioId = query.exerciseId;
  if (query.from) filter.from = new Date(query.from);
  if (query.to) filter.to = new Date(query.to);
  return filter;
}

function csvEscape(val) {
  if (val == null) return "";
  const s = String(val);
  if (s.includes(",") || s.includes('"') || s.includes("\n") || s.includes("\r")) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

function rowsToCsv(rows) {
  if (rows.length === 0) return "";
  const headers = Object.keys(rows[0]);
  const lines = [headers.join(",")];
  for (const row of rows) {
    const vals = headers.map((h) => csvEscape(row[h]));
    lines.push(vals.join(","));
  }
  return lines.join("\n");
}

function flattenInteraccion(inter, messages, usuario, ejercicio) {
  const rows = [];
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    rows.push({
      interaccionId: inter.id || inter.interaccionId,
      usuarioId: inter.usuarioId,
      upvLogin: usuario?.upvLogin || "",
      nombreCompleto: usuario ? ((usuario.nombre || "") + " " + (usuario.apellidos || "")).trim() : "",
      ejercicioId: inter.ejercicioId,
      ejercicioTitulo: ejercicio?.titulo || "",
      sesionInicio: inter.inicio,
      sesionFin: inter.fin,
      mensajeIndex: i,
      role: m.role,
      content: m.content,
      timestamp: m.timestamp,
      classification: m.metadata?.classification || m.classification || "",
      decision: m.metadata?.decision || m.decision || "",
      isCorrectAnswer: (m.metadata?.isCorrectAnswer ?? m.isCorrectAnswer) ?? "",
      sourcesCount: (m.metadata?.sourcesCount ?? m.sourcesCount) ?? "",
      studentResponseMs: (m.metadata?.studentResponseMs ?? m.studentResponseMs) ?? "",
      pipelineMs: (m.metadata?.timing?.pipelineMs ?? m.timing?.pipelineMs) ?? "",
      ollamaMs: (m.metadata?.timing?.ollamaMs ?? m.timing?.ollamaMs) ?? "",
      totalMs: (m.metadata?.timing?.totalMs ?? m.timing?.totalMs) ?? "",
      guardrail_solutionLeak: (m.metadata?.guardrails?.solutionLeak ?? m.guardrails?.solutionLeak) ?? false,
      guardrail_falseConfirmation: (m.metadata?.guardrails?.falseConfirmation ?? m.guardrails?.falseConfirmation) ?? false,
      guardrail_prematureConfirmation: (m.metadata?.guardrails?.prematureConfirmation ?? m.guardrails?.prematureConfirmation) ?? false,
      guardrail_stateReveal: (m.metadata?.guardrails?.stateReveal ?? m.guardrails?.stateReveal) ?? false,
    });
  }
  return rows;
}

// GET /api/export/interacciones
router.get("/interacciones", async (req, res) => {
  const r = repos(res); if (!r) return;
  try {
    const filter = buildFilter(req.query);
    const format = req.query.format || "json";

    const interacciones = await r.interaccionRepo.findByFilter(filter);

    // Enrich with users and exercises
    const userIds = [...new Set(interacciones.map((i) => i.usuarioId).filter(Boolean))];
    const exIds = [...new Set(interacciones.map((i) => i.ejercicioId).filter(Boolean))];

    const usuarios = userIds.length ? await r.usuarioRepo.findByIds(userIds) : [];
    const ejercicios = exIds.length ? await r.ejercicioRepo.findByIds(exIds) : [];

    const userMap = Object.fromEntries(usuarios.map((u) => [u.id, u]));
    const exMap = Object.fromEntries(ejercicios.map((e) => [e.id, e]));

    // Load messages for each interaccion (necesario para CSV y para enriquecer JSON)
    const interWithMessages = await Promise.all(
      interacciones.map(async (inter) => ({
        inter,
        messages: await r.messageRepo.getAllMessages(inter.id),
      }))
    );

    if (format === "csv") {
      const allRows = [];
      for (const { inter, messages } of interWithMessages) {
        allRows.push(...flattenInteraccion(inter, messages, userMap[inter.usuarioId], exMap[inter.ejercicioId]));
      }
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader("Content-Disposition", "attachment; filename=interacciones.csv");
      return res.send(rowsToCsv(allRows));
    }

    // JSON
    const result = interWithMessages.map(({ inter, messages }) => {
      const u = userMap[inter.usuarioId] || null;
      const e = exMap[inter.ejercicioId] || null;
      return {
        interaccionId: inter.id,
        usuario: u ? { upvLogin: u.upvLogin, nombre: u.nombre, apellidos: u.apellidos } : null,
        ejercicio: e ? { titulo: e.titulo, concepto: e.concepto } : null,
        inicio: inter.inicio,
        fin: inter.fin,
        numMensajes: messages.length,
        conversacion: messages,
      };
    });
    return res.json(result);
  } catch (err) {
    console.error("[EXPORT] Error:", err.message);
    return res.status(500).json({ error: "Error exporting interactions" });
  }
});

// GET /api/export/resultados
router.get("/resultados", async (req, res) => {
  const r = repos(res); if (!r) return;
  try {
    const filter = buildFilter(req.query);
    const format = req.query.format || "json";

    const resultados = await r.resultadoRepo.findByFilter(filter);

    const userIds = [...new Set(resultados.map((x) => x.usuarioId).filter(Boolean))];
    const exIds = [...new Set(resultados.map((x) => x.ejercicioId).filter(Boolean))];

    const usuarios = userIds.length ? await r.usuarioRepo.findByIds(userIds) : [];
    const ejercicios = exIds.length ? await r.ejercicioRepo.findByIds(exIds) : [];

    const userMap = Object.fromEntries(usuarios.map((u) => [u.id, u]));
    const exMap = Object.fromEntries(ejercicios.map((e) => [e.id, e]));

    if (format === "csv") {
      const rows = resultados.map((x) => {
        const u = userMap[x.usuarioId];
        const e = exMap[x.ejercicioId];
        return {
          resultadoId: x.id,
          usuarioId: x.usuarioId,
          upvLogin: u?.upvLogin || "",
          nombreCompleto: u ? ((u.nombre || "") + " " + (u.apellidos || "")).trim() : "",
          ejercicioId: x.ejercicioId,
          ejercicioTitulo: e?.titulo || "",
          interaccionId: x.interaccionId || "",
          fecha: x.fecha,
          numMensajes: x.numMensajes,
          resueltoALaPrimera: x.resueltoALaPrimera,
          errores: (x.errores || []).map((er) => er.etiqueta).join("; "),
          analisisIA: x.analisisIA || "",
          consejoIA: x.consejoIA || "",
        };
      });
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader("Content-Disposition", "attachment; filename=resultados.csv");
      return res.send(rowsToCsv(rows));
    }

    // JSON
    const result = resultados.map((x) => {
      const u = userMap[x.usuarioId] || null;
      const e = exMap[x.ejercicioId] || null;
      return {
        resultadoId: x.id,
        usuario: u ? { upvLogin: u.upvLogin, nombre: u.nombre, apellidos: u.apellidos } : null,
        ejercicio: e ? { titulo: e.titulo } : null,
        interaccionId: x.interaccionId,
        fecha: x.fecha,
        numMensajes: x.numMensajes,
        resueltoALaPrimera: x.resueltoALaPrimera,
        errores: x.errores,
        analisisIA: x.analisisIA,
        consejoIA: x.consejoIA,
      };
    });
    return res.json(result);
  } catch (err) {
    console.error("[EXPORT] Error:", err.message);
    return res.status(500).json({ error: "Error exporting results" });
  }
});

module.exports = router;
