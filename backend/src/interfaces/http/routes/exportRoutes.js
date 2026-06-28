const express = require("express");
const container = require("../../../container");
const { requireRole } = require("../middleware/authMiddleware");

const router = express.Router();

router.use(requireRole("profesor", "admin"));

/*------------------------------------------------------------------------------
            _________________________________________________________
            |                    EXPORT ROUTES                      |
            |  Express router that exports interactions and results  |
            |  as JSON or CSV for analysis. Every route requires the |
            |  profesor/admin role (router-level guard). Enriches    |
            |  rows with user and exercise data. Endpoints:         |
            |     GET /interacciones  -> [Obj] | CSV                |
            |     GET /resultados     -> [Obj] | CSV                |
        ____|____________                                            |
   Obj -> | repos() | -> Obj | null                (reads container) |
          -----------                                                |
        ____|_____________                                           |
   Txt -> | isValidId() | -> T/F                   (pure check)      |
          -------------                                              |
        ____|______________                                          |
   Obj -> | buildFilter() | -> Obj                 (pure)            |
          ---------------                                            |
        ____|_____________                                           |
   * -> | csvEscape() | -> Txt                     (pure)            |
        -------------                                                |
        ____|_____________                                           |
   [Obj] -> | rowsToCsv() | -> Txt                 (pure)            |
            -------------                                            |
        ____|_____________________                                   |
   Obj, [Obj], Usuario, Ejercicio -> | flattenInteraccion() | -> [Obj]|
                                    ---------------------            |
            |                                                       |
            |_______________________________________________________|
------------------------------------------------------------------------------*/

/*
 Obj -> ____|____________
       | repos() | -> Obj | null    (reads container (Obj))
        -----------
    Resolves the interaccion, resultado, usuario, ejercicio and message
    repositories from the container. Sends a 503 and returns null when
    persistence is not initialized yet.
*/
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

/*
 Txt -> ____|_____________
       | isValidId() | -> T/F
        -------------
    True when the value is a legacy ObjectId (24 hex) or a UUID.
*/
function isValidId(v) {
  if (typeof v !== "string") return false;
  return /^[a-f0-9]{24}$/i.test(v) || /^[0-9a-f-]{36}$/i.test(v);
}

/*
 Obj -> ____|______________
       | buildFilter() | -> Obj
        ---------------
    Builds a repository filter from the query string, keeping only valid
    userId/exerciseId and parsing from/to into Date bounds.
*/
function buildFilter(query) {
  const filter = {};
  if (query.userId && isValidId(query.userId)) filter.userId = query.userId;
  if (query.exerciseId && isValidId(query.exerciseId)) filter.exerciseId = query.exerciseId;
  if (query.from) filter.from = new Date(query.from);
  if (query.to) filter.to = new Date(query.to);
  return filter;
}

/*
 * -> ____|_____________
     | csvEscape() | -> Txt
      -------------
    Escapes a value for a CSV cell: empty for null/undefined, otherwise
    quoting and doubling internal quotes when the text holds , " or newlines.
*/
function csvEscape(val) {
  if (val == null) return "";
  const s = String(val);
  if (s.includes(",") || s.includes('"') || s.includes("\n") || s.includes("\r")) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

/*
 [Obj] -> ____|_____________
         | rowsToCsv() | -> Txt
          -------------
    Serializes an array of flat row objects to a CSV string, using the
    keys of the first row as the header. Returns "" for an empty array.
*/
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

/*
 Obj, [Obj], Usuario, Ejercicio -> ____|_____________________
                                  | flattenInteraccion() | -> [Obj]
                                   ---------------------
    Flattens one interaction and its messages into CSV-ready rows, one per
    message, expanding metadata (classification, timing, guardrails, AC
    detection, surgical fixes) and enriching with user and exercise fields.
*/
function flattenInteraccion(inter, messages, usuario, ejercicio) {
  const rows = [];
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    const md = m.metadata || {};
    const g = md.guardrails || {};
    const t = md.timing || {};
    const detectedACsList = Array.isArray(md.detectedACs) ? md.detectedACs : [];
    const detectedACsStr = detectedACsList
      .map((a) => (a && a.id ? a.id + (a.confidence != null ? `(${a.confidence.toFixed(2)})` : "") : ""))
      .filter(Boolean)
      .join("; ");
    const surgicalFixesStr = Array.isArray(md.guardrailSurgicalFixes)
      ? md.guardrailSurgicalFixes.join("; ")
      : "";
    const conceptsStr = Array.isArray(md.concepts) ? md.concepts.join("; ") : "";

    rows.push({
      interaccionId: inter.id || inter.interaccionId,
      usuarioId: inter.userId,
      upvLogin: usuario?.upvLogin || "",
      nombreCompleto: usuario ? ((usuario.firstName || "") + " " + (usuario.lastName || "")).trim() : "",
      ejercicioId: inter.exerciseId,
      ejercicioTitulo: ejercicio?.title || "",
      sesionInicio: inter.startTime,
      sesionFin: inter.endTime,
      mensajeIndex: i,
      role: m.role,
      content: m.content,
      timestamp: m.timestamp,
      classification: md.classification || "",
      decision: md.decision || "",
      isCorrectAnswer: md.isCorrectAnswer ?? "",
      sourcesCount: md.sourcesCount ?? "",
      studentResponseMs: md.studentResponseMs ?? "",
      pipelineMs: t.pipelineMs ?? "",
      ollamaMs: t.ollamaMs ?? "",
      totalMs: t.totalMs ?? "",
      firstTokenMs: t.firstTokenMs ?? "",
      concepts: conceptsStr,
      detectedACs: detectedACsStr,
      detectedACsCount: detectedACsList.length,
      guardrail_solutionLeak: g.solutionLeak ?? false,
      guardrail_falseConfirmation: g.falseConfirmation ?? false,
      guardrail_prematureConfirmation: g.prematureConfirmation ?? false,
      guardrail_stateReveal: g.stateReveal ?? false,
      guardrail_languageDrift: g.languageDrift ?? false,
      guardrail_completeSolution: g.completeSolution ?? false,
      guardrail_adherence: g.adherence ?? false,
      guardrail_repeatedQuestion: g.repeatedQuestion ?? false,
      guardrail_didacticExplanation: g.didacticExplanation ?? false,
      guardrail_datasetStyle: g.datasetStyle ?? false,
      guardrailPath: md.guardrailPath || "",
      guardrailLlmRetries: md.guardrailLlmRetries ?? 0,
      guardrailSurgicalFixes: surgicalFixesStr,
      llmResponseOriginal: md.llmResponseOriginal || "",
      guardrailRewrites: Array.isArray(md.guardrailSurgicalFixDetails)
        ? JSON.stringify(md.guardrailSurgicalFixDetails)
        : "",
      fallbackUsed: md.fallbackUsed ?? false,
      deterministicFinish: md.deterministicFinish ?? false,
    });
  }
  return rows;
}

router.get("/interacciones", async (req, res) => {
  const r = repos(res); if (!r) return;
  try {
    const filter = buildFilter(req.query);
    const format = req.query.format || "json";

    const interacciones = await r.interaccionRepo.findByFilter(filter);

    const userIds = [...new Set(interacciones.map((i) => i.userId).filter(Boolean))];
    const exIds = [...new Set(interacciones.map((i) => i.exerciseId).filter(Boolean))];

    const usuarios = userIds.length ? await r.usuarioRepo.findByIds(userIds) : [];
    const ejercicios = exIds.length ? await r.ejercicioRepo.findByIds(exIds) : [];

    const userMap = Object.fromEntries(usuarios.map((u) => [u.id, u]));
    const exMap = Object.fromEntries(ejercicios.map((e) => [e.id, e]));

    const interWithMessages = await Promise.all(
      interacciones.map(async (inter) => ({
        inter,
        messages: await r.messageRepo.getAllMessages(inter.id),
      }))
    );

    if (format === "csv") {
      const allRows = [];
      for (const { inter, messages } of interWithMessages) {
        allRows.push(...flattenInteraccion(inter, messages, userMap[inter.userId], exMap[inter.exerciseId]));
      }
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader("Content-Disposition", "attachment; filename=interacciones.csv");
      return res.send(rowsToCsv(allRows));
    }

    const result = interWithMessages.map(({ inter, messages }) => {
      const u = userMap[inter.userId] || null;
      const e = exMap[inter.exerciseId] || null;
      return {
        interaccionId: inter.id,
        usuario: u ? { upvLogin: u.upvLogin, nombre: u.firstName, apellidos: u.lastName } : null,
        ejercicio: e ? { titulo: e.title, concepto: e.concept } : null,
        inicio: inter.startTime,
        fin: inter.endTime,
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

router.get("/resultados", async (req, res) => {
  const r = repos(res); if (!r) return;
  try {
    const filter = buildFilter(req.query);
    const format = req.query.format || "json";

    const resultados = await r.resultadoRepo.findByFilter(filter);

    const userIds = [...new Set(resultados.map((x) => x.userId).filter(Boolean))];
    const exIds = [...new Set(resultados.map((x) => x.exerciseId).filter(Boolean))];

    const usuarios = userIds.length ? await r.usuarioRepo.findByIds(userIds) : [];
    const ejercicios = exIds.length ? await r.ejercicioRepo.findByIds(exIds) : [];

    const userMap = Object.fromEntries(usuarios.map((u) => [u.id, u]));
    const exMap = Object.fromEntries(ejercicios.map((e) => [e.id, e]));

    if (format === "csv") {
      const rows = resultados.map((x) => {
        const u = userMap[x.userId];
        const e = exMap[x.exerciseId];
        return {
          resultadoId: x.id,
          usuarioId: x.userId,
          upvLogin: u?.upvLogin || "",
          nombreCompleto: u ? ((u.firstName || "") + " " + (u.lastName || "")).trim() : "",
          ejercicioId: x.exerciseId,
          ejercicioTitulo: e?.title || "",
          interaccionId: x.interactionId || "",
          fecha: x.date,
          numMensajes: x.messageCount,
          resueltoALaPrimera: x.solvedOnFirstAttempt,
          errores: (x.errors || []).map((er) => er.label).join("; "),
          analisisIA: x.aiAnalysis || "",
          consejoIA: x.aiAdvice || "",
        };
      });
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader("Content-Disposition", "attachment; filename=resultados.csv");
      return res.send(rowsToCsv(rows));
    }

    const result = resultados.map((x) => {
      const u = userMap[x.userId] || null;
      const e = exMap[x.exerciseId] || null;
      return {
        resultadoId: x.id,
        usuario: u ? { upvLogin: u.upvLogin, nombre: u.firstName, apellidos: u.lastName } : null,
        ejercicio: e ? { titulo: e.title } : null,
        interaccionId: x.interactionId,
        fecha: x.date,
        numMensajes: x.messageCount,
        resueltoALaPrimera: x.solvedOnFirstAttempt,
        errores: (x.errors || []).map((e) => ({ etiqueta: e.label, texto: e.text })),
        analisisIA: x.aiAnalysis,
        consejoIA: x.aiAdvice,
      };
    });
    return res.json(result);
  } catch (err) {
    console.error("[EXPORT] Error:", err.message);
    return res.status(500).json({ error: "Error exporting results" });
  }
});

module.exports = router;
module.exports._test = { flattenInteraccion, buildFilter, rowsToCsv };
