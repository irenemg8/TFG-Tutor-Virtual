// backend/src/interfaces/http/routes/progresoRoutes.js
const express = require("express");
const container = require("../../../container");
const { canAccessUserData } = require("../middleware/authMiddleware");

const router = express.Router();

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

function isValidId(v) {
  if (typeof v !== "string") return false;
  if (/^[a-f0-9]{24}$/i.test(v)) return true;
  if (/^[0-9a-f-]{36}$/i.test(v)) return true;
  return false;
}

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

async function loadAndReturnProgreso(userId, res) {
  const r = repos(res); if (!r) return;

  // Join results with exercise data (replaces .populate())
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

  // A) Interacciones medias
  const totalInteracciones = pairs.reduce((sum, p) => sum + (p.resultado.numMensajes || 0), 0);
  const interaccionesMedias = totalInteracciones / pairs.length;

  // B) Dificultad por concepto
  const eficiencia = {};
  for (const p of pairs) {
    const concepto = p.ejercicio?.concepto;
    if (!concepto) continue;
    if (!eficiencia[concepto]) eficiencia[concepto] = { total: 0, count: 0 };
    eficiencia[concepto].total += p.resultado.numMensajes || 0;
    eficiencia[concepto].count += 1;
  }
  const eficienciaPorConcepto = Object.keys(eficiencia).map((c) => ({
    concepto: c,
    interacciones: eficiencia[c].total / eficiencia[c].count,
  }));

  // C) Resumen semanal
  const hoy = new Date();
  const haceUnaSemana = new Date();
  haceUnaSemana.setDate(hoy.getDate() - 7);

  const pairsSemana = pairs.filter((p) => p.resultado.fecha && new Date(p.resultado.fecha) >= haceUnaSemana);
  const conceptosSemana = new Set(pairsSemana.map((p) => p.ejercicio?.concepto).filter(Boolean));
  const ejerciciosUnicosSemana = new Set(pairsSemana.map((p) => p.ejercicio?.id).filter(Boolean));
  const rachaDias = computeStreak(pairs.map((p) => p.resultado.fecha));

  const resumenSemanal = {
    ejerciciosCompletados: ejerciciosUnicosSemana.size,
    conceptosDistintos: conceptosSemana.size,
    rachaDias,
  };

  // D) Última sesión
  const ultimo = pairs[0];
  const ultimaSesion = {
    tituloEjercicio: ultimo.ejercicio?.titulo || "Ejercicio Reciente",
    analisis: ultimo.resultado.analisisIA || "Análisis no disponible.",
    consejo: ultimo.resultado.consejoIA || "Sigue practicando.",
  };

  // E) Errores frecuentes
  const mapaErrores = {};
  for (const p of pairs) {
    for (const e of p.resultado.errores || []) {
      if (!e?.etiqueta) continue;
      if (!mapaErrores[e.etiqueta]) {
        mapaErrores[e.etiqueta] = { etiqueta: e.etiqueta, texto: e.texto || e.etiqueta, veces: 0 };
      }
      mapaErrores[e.etiqueta].veces += 1;
    }
  }
  const erroresFrecuentes = Object.values(mapaErrores).sort((a, b) => b.veces - a.veces).slice(0, 3);

  // F) Recomendación
  let recomendacion = {
    titulo: "",
    motivo: "Haz un ejercicio para que el tutor pueda recomendarte una práctica personalizada.",
    ejercicioId: null,
    concepto: "",
  };

  const hasRealErrors = erroresFrecuentes.some((e) => e.etiqueta && e.etiqueta !== "AC_UNK");

  if (hasRealErrors) {
    const conceptoObjetivo = ultimo.ejercicio?.concepto || "";
    if (conceptoObjetivo) {
      const ej = await r.ejercicioRepo.findOneByConcepto(conceptoObjetivo);
      if (ej) {
        recomendacion = {
          titulo: ej.titulo || "Ejercicio recomendado",
          motivo: "Recomendación basada en tus errores recientes.",
          ejercicioId: ej.id,
          concepto: ej.concepto || conceptoObjetivo,
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
    const ej = await r.ejercicioRepo.findOneByConcepto(conceptoObjetivo);
    if (ej) {
      recomendacion = {
        titulo: ej.titulo || "Ejercicio recomendado",
        motivo: "Te recomiendo reforzar este concepto según tu actividad reciente.",
        ejercicioId: ej.id,
        concepto: ej.concepto || conceptoObjetivo,
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
