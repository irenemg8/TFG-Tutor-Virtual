const express = require("express");
const container = require("../../../container");
const { canAccessUserData } = require("../middleware/authMiddleware");

const router = express.Router();

/*------------------------------------------------------------------------------
            _________________________________________________________
            |                   PROGRESO ROUTES                     |
            |  Express router that builds a student's progress       |
            |  dashboard (average interactions, difficulty per      |
            |  concept, weekly summary + streak, last session,      |
            |  frequent mistakes and a recommendation). Mounted     |
            |  under /api/progreso. Endpoints:                      |
            |     GET /         -> Obj   (current user's progress)  |
            |     GET /:userId   -> Obj   (other user, role-gated)   |
        ____|____________                                            |
   Obj -> | repos() | -> Obj | null                (reads container) |
          -----------                                                |
        ____|_____________                                           |
   Txt -> | isValidId() | -> T/F                   (pure check)      |
          -------------                                              |
        ____|________________                                        |
   Date -> | dayKeyMadrid() | -> Txt | null        (pure)            |
           ----------------                                          |
        ____|________________                                        |
   [Date] -> | computeStreak() | -> Z              (pure)            |
             ----------------                                        |
        ____|_______________________________                        |
   Txt, Obj -> | loadAndReturnProgreso() | -> Promise<void>          |
              -------------------------                              |
            |                                                       |
            |_______________________________________________________|
------------------------------------------------------------------------------*/

/*
 Obj -> ____|____________
       | repos() | -> Obj | null    (reads container (Obj))
        -----------
    Resolves the resultado + ejercicio repositories from the container.
    Sends a 503 and returns null when persistence is not ready yet.
*/
function repos(res) {
  if (!container._initialized) {
    res.status(503).json({ error: "service_unavailable" });
    return null;
  }
  return {
    resultadoRepo: container.resultadoRepo,
    ejercicioRepo: container.ejercicioRepo,
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
  if (/^[a-f0-9]{24}$/i.test(v)) return true;
  if (/^[0-9a-f-]{36}$/i.test(v)) return true;
  return false;
}

/*
 Date -> ____|________________
        | dayKeyMadrid() | -> Txt | null
         ----------------
    Maps a date to its "YYYY-MM-DD" key in the Europe/Madrid timezone.
    Returns null for missing or invalid dates.
*/
function dayKeyMadrid(date) {
  if (!date) return null;
  const d = new Date(date);
  if (Number.isNaN(d.getTime())) return null;
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Madrid",
    year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(d);
  const y = parts.find((p) => p.type === "year")?.value;
  const m = parts.find((p) => p.type === "month")?.value;
  const da = parts.find((p) => p.type === "day")?.value;
  return y && m && da ? `${y}-${m}-${da}` : null;
}

/*
 [Date] -> ____|________________
          | computeStreak() | -> Z
           ----------------
    Counts the run of consecutive calendar days (Madrid time) ending at
    the most recent activity day. Returns 0 when there are no dates.
*/
function computeStreak(dates) {
  const set = new Set();
  for (const dt of dates) {
    const k = dayKeyMadrid(dt);
    if (k) set.add(k);
  }
  if (set.size === 0) return 0;
  const days = Array.from(set).sort();
  let streak = 1;
  for (let i = days.length - 1; i > 0; i--) {
    const a = new Date(days[i] + "T00:00:00");
    const b = new Date(days[i - 1] + "T00:00:00");
    const diff = (a - b) / (1000 * 60 * 60 * 24);
    if (diff === 1) streak += 1;
    else break;
  }
  return streak;
}

/*
 Txt, Obj -> ____|_______________________________
            | loadAndReturnProgreso() | -> Promise<void>    (sends JSON)
             -------------------------
    Loads the user's results joined with their exercises and computes the
    full progress payload (averages, per-concept difficulty, weekly summary
    and streak, last session, frequent errors, recommendation), then
    responds with it. Returns an empty welcome payload when there is no data.
*/
async function loadAndReturnProgreso(userId, res) {
  const r = repos(res); if (!r) return;

  const pairs = await r.resultadoRepo.findByUserIdWithExercise(userId);

  if (pairs.length === 0) {
    return res.json({
      interaccionesMedias: 0,
      eficienciaPorConcepto: [],
      resumenSemanal: { ejerciciosCompletados: 0, conceptosDistintos: 0, rachaDias: 0 },
      ultimaSesion: {
        tituloEjercicio: "¡Bienvenido!",
        analisis: "Aún no has completado ningún ejercicio.",
        consejo: "Empieza con uno para ver aquí tu progreso.",
      },
      erroresFrecuentes: [],
      recomendacion: {
        titulo: "",
        motivo: "Haz un ejercicio para que el tutor pueda recomendarte una práctica personalizada.",
        ejercicioId: null,
        concepto: "",
      },
    });
  }

  const totalInteracciones = pairs.reduce((sum, p) => sum + (p.resultado.messageCount || 0), 0);
  const interaccionesMedias = totalInteracciones / pairs.length;

  const eficiencia = {};
  for (const p of pairs) {
    const concepto = p.ejercicio?.concept;
    if (!concepto) continue;
    if (!eficiencia[concepto]) eficiencia[concepto] = { total: 0, count: 0 };
    eficiencia[concepto].total += p.resultado.messageCount || 0;
    eficiencia[concepto].count += 1;
  }
  const eficienciaPorConcepto = Object.keys(eficiencia).map((c) => ({
    concepto: c,
    interacciones: eficiencia[c].total / eficiencia[c].count,
  }));

  const hoy = new Date();
  const haceUnaSemana = new Date();
  haceUnaSemana.setDate(hoy.getDate() - 7);

  const pairsSemana = pairs.filter((p) => p.resultado.date && new Date(p.resultado.date) >= haceUnaSemana);
  const conceptosSemana = new Set(pairsSemana.map((p) => p.ejercicio?.concept).filter(Boolean));
  const ejerciciosUnicosSemana = new Set(pairsSemana.map((p) => p.ejercicio?.id).filter(Boolean));
  const rachaDias = computeStreak(pairs.map((p) => p.resultado.date));

  const resumenSemanal = {
    ejerciciosCompletados: ejerciciosUnicosSemana.size,
    conceptosDistintos: conceptosSemana.size,
    rachaDias,
  };

  const ultimo = pairs[0];
  const ultimaSesion = {
    tituloEjercicio: ultimo.ejercicio?.title || "Ejercicio Reciente",
    analisis: ultimo.resultado.aiAnalysis || "Análisis no disponible.",
    consejo: ultimo.resultado.aiAdvice || "Sigue practicando.",
  };

  const mapaErrores = {};
  for (const p of pairs) {
    for (const e of p.resultado.errors || []) {
      if (!e?.label) continue;
      if (!mapaErrores[e.label]) {
        mapaErrores[e.label] = { etiqueta: e.label, texto: e.text || e.label, veces: 0 };
      }
      mapaErrores[e.label].veces += 1;
    }
  }
  const erroresFrecuentes = Object.values(mapaErrores).sort((a, b) => b.veces - a.veces).slice(0, 3);

  let recomendacion = {
    titulo: "",
    motivo: "Haz un ejercicio para que el tutor pueda recomendarte una práctica personalizada.",
    ejercicioId: null,
    concepto: "",
  };

  const hasRealErrors = erroresFrecuentes.some((e) => e.etiqueta && e.etiqueta !== "AC_UNK");

  if (hasRealErrors) {
    const conceptoObjetivo = ultimo.ejercicio?.concept || "";
    if (conceptoObjetivo) {
      const ej = await r.ejercicioRepo.findOneByConcept(conceptoObjetivo);
      if (ej) {
        recomendacion = {
          titulo: ej.title || "Ejercicio recomendado",
          motivo: "Recomendación basada en tus errores recientes.",
          ejercicioId: ej.id,
          concepto: ej.concept || conceptoObjetivo,
        };
      } else {
        recomendacion = {
          titulo: "Recomendación",
          motivo: "Revisa el concepto de tu última sesión y prueba un ejercicio similar.",
          ejercicioId: null,
          concepto: conceptoObjetivo,
        };
      }
    }
  } else if (eficienciaPorConcepto.length > 0) {
    const peor = [...eficienciaPorConcepto].sort((a, b) => b.interacciones - a.interacciones)[0];
    const conceptoObjetivo = peor.concepto;
    const ej = await r.ejercicioRepo.findOneByConcept(conceptoObjetivo);
    if (ej) {
      recomendacion = {
        titulo: ej.title || "Ejercicio recomendado",
        motivo: "Te recomiendo reforzar este concepto según tu actividad reciente.",
        ejercicioId: ej.id,
        concepto: ej.concept || conceptoObjetivo,
      };
    } else {
      recomendacion = {
        titulo: "Recomendación",
        motivo: `Refuerza el concepto: ${conceptoObjetivo}.`,
        ejercicioId: null,
        concepto: conceptoObjetivo,
      };
    }
  }

  return res.status(200).json({
    interaccionesMedias,
    eficienciaPorConcepto,
    resumenSemanal,
    ultimaSesion,
    erroresFrecuentes,
    recomendacion,
  });
}

router.get("/", async (req, res) => {
  try {
    return await loadAndReturnProgreso(req.userId, res);
  } catch (error) {
    console.error("[PROGRESO] Error:", error?.message || error);
    return res.status(500).json({ message: "Error del servidor." });
  }
});

router.get("/:userId", async (req, res) => {
  try {
    const { userId } = req.params;
    if (!isValidId(userId)) return res.status(400).json({ message: "ID de usuario inválido." });
    if (!canAccessUserData(userId, req)) {
      return res.status(403).json({ message: "No autorizado." });
    }
    return await loadAndReturnProgreso(userId, res);
  } catch (error) {
    console.error("Error al generar progreso:", error);
    return res.status(500).json({ message: "Error en el servidor." });
  }
});

module.exports = router;
