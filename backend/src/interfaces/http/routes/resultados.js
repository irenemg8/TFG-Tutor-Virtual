const express = require("express");
const axios = require("axios");
const https = require("https");

const container = require("../../../container");
const { canAccessUserData } = require("../middleware/authMiddleware");

const acData = require("../../../data/alternative_conceptions.json");
const AC_MAP = acData?.alternative_conceptions || {};
const ALLOWED_AC_IDS = Object.keys(AC_MAP);
const ALLOWED_AC_IDS_TEXT = ALLOWED_AC_IDS.join(", ");

const router = express.Router();

/*------------------------------------------------------------------------------
            _________________________________________________________
            |                   RESULTADOS ROUTES                   |
            |  Express router that lists a student's completed       |
            |  exercises and finalizes a result. On finalize it     |
            |  runs an LLM classifier over the conversation to       |
            |  detect alternative conceptions (AC) and persists the |
            |  analysis. Mounted under /api/resultados. Endpoints:  |
            |     GET  /completed          -> [Txt]                 |
            |     GET  /completed/:userId   -> [Txt]  (role-gated)   |
            |     POST /finalizar          -> Obj                   |
        ____|____________                                            |
   Obj -> | repos() | -> Obj | null                (reads container) |
          -----------                                                |
        ____|_____________                                           |
   Txt -> | isValidId() | -> T/F                   (pure check)      |
          -------------                                              |
        ____|___________________                                     |
   Txt -> | extractJsonObject() | -> Obj | null    (pure parse)      |
          ---------------------                                      |
        ____|_________________                                       |
   Obj -> | callClassifier() | -> Promise<Txt>     (calls Ollama)    |
          ------------------                                         |
            |                                                       |
            |_______________________________________________________|
------------------------------------------------------------------------------*/

/*
 Obj -> ____|____________
       | repos() | -> Obj | null    (reads container (Obj))
        -----------
    Resolves resultado + interaccion + message repositories from the
    container. Sends a 503 and returns null when persistence is not ready.
*/
function repos(res) {
  if (!container._initialized) {
    res.status(503).json({ error: "service_unavailable" });
    return null;
  }
  return {
    resultadoRepo: container.resultadoRepo,
    interaccionRepo: container.interaccionRepo,
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
  if (/^[a-f0-9]{24}$/i.test(v)) return true;
  if (/^[0-9a-f-]{36}$/i.test(v)) return true;
  return false;
}

const OLLAMA_BASE_URL =
  process.env.OLLAMA_API_URL_UPV ||
  process.env.OLLAMA_UPV_URL ||
  process.env.OLLAMA_API_URL ||
  "https://ollama.gti-ia.upv.es:443";
const OLLAMA_TIMEOUT_MS = Number(process.env.OLLAMA_CLASSIFIER_TIMEOUT_MS || 240000);
const insecureTLS = ["1", "true", "on", "yes"].includes(
  String(process.env.OLLAMA_INSECURE_TLS || "").toLowerCase()
);
const httpsAgent = insecureTLS ? new https.Agent({ rejectUnauthorized: false }) : undefined;
const ollama = axios.create({
  baseURL: String(OLLAMA_BASE_URL).replace(/\/+$/, ""),
  timeout: OLLAMA_TIMEOUT_MS,
  httpsAgent,
});

/*
 Txt -> ____|___________________
       | extractJsonObject() | -> Obj | null
        ---------------------
    Best-effort parse of a JSON object out of an LLM reply: strips code
    fences, then tries the whole string and finally the first {...} match.
    Returns null when nothing parses.
*/
function extractJsonObject(text) {
  if (typeof text !== "string") return null;
  const s = text.trim();
  if (!s) return null;
  const cleaned = s.replace(/^```(json)?/i, "").replace(/```$/i, "").trim();
  if (cleaned.startsWith("{") && cleaned.endsWith("}")) {
    try { return JSON.parse(cleaned); } catch {}
  }
  const match = cleaned.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try { return JSON.parse(match[0]); } catch { return null; }
}

/*
 Obj -> ____|_________________
       | callClassifier() | -> Promise<Txt>
        ------------------
    Calls the Ollama /api/chat classifier (temperature 0, JSON format)
    with the given model and prompt, returning the raw message content.
*/
async function callClassifier({ model, prompt }) {
  const r = await ollama.post("/api/chat", {
    model,
    stream: false,
    format: "json",
    options: { temperature: 0 },
    messages: [{ role: "user", content: prompt }],
  });
  return r?.data?.message?.content;
}

router.get("/completed", async (req, res) => {
  const r = repos(res); if (!r) return;
  try {
    const ids = await r.resultadoRepo.findCompletedExerciseIds(req.userId);
    return res.status(200).json(ids);
  } catch (err) {
    console.error("Error obteniendo ejercicios completados:", err);
    return res.status(500).json({ message: "Error del servidor." });
  }
});

router.get("/completed/:userId", async (req, res) => {
  const r = repos(res); if (!r) return;
  try {
    const { userId } = req.params;
    if (!isValidId(userId)) return res.status(400).json({ message: "ID inválido." });
    if (!canAccessUserData(userId, req)) {
      return res.status(403).json({ message: "No autorizado." });
    }
    const ids = await r.resultadoRepo.findCompletedExerciseIds(userId);
    return res.status(200).json(ids);
  } catch (err) {
    console.error("Error obteniendo ejercicios completados:", err);
    return res.status(500).json({ message: "Error del servidor." });
  }
});

router.post("/finalizar", async (req, res) => {
  const r = repos(res); if (!r) return;
  try {
    const userId = req.userId;
    const { exerciseId, interaccionId, resueltoALaPrimera = false } = req.body;

    if (!exerciseId || !interaccionId) {
      return res.status(400).json({ message: "Faltan datos para finalizar el resultado." });
    }
    if (!isValidId(exerciseId) || !isValidId(interaccionId)) {
      return res.status(400).json({ message: "Alguno de los IDs no es válido." });
    }

    const interaccion = await r.interaccionRepo.findById(interaccionId);
    if (!interaccion) {
      return res.status(404).json({ message: "Interacción no encontrada." });
    }

    const messages = await r.messageRepo.getAllMessages(interaccionId);
    const numMensajes = messages.length;

    const conversacionTexto = messages.length > 0
      ? messages.map((m) => `${m.role}: ${m.content}`).join("\n")
      : "Conversación vacía.";

    const promptBase = `
Eres un asistente que clasifica concepciones alternativas (AC) en un diálogo de tutoría.

REGLAS ESTRICTAS (OBLIGATORIAS):
- Devuelve ÚNICAMENTE JSON válido.
- No escribas ningún texto fuera del JSON.
- No incluyas explicaciones, comentarios ni markdown.

Solo puedes devolver IDs de esta lista cerrada:
${ALLOWED_AC_IDS_TEXT}

Devuelve como máximo 3 IDs.
Si no detectas ninguna con claridad, devuelve [].

FORMATO EXACTO:
{
  "analisis": "1-2 frases muy cortas",
  "consejo": "1 frase muy corta",
  "acs": ["AC13", "AC14"]
}

CONVERSACIÓN:
---
${conversacionTexto}
---
`.trim();

    const promptRetry = `
DEVUELVE SOLO UN OBJETO JSON VÁLIDO. SIN TEXTO ADICIONAL. SIN MARKDOWN.
${promptBase}
`.trim();

    let analisisIA = null;
    let consejoIA = null;
    let errores = [];
    let classifierStatus = "skipped";

    const model = process.env.OLLAMA_CLASSIFIER_MODEL || process.env.OLLAMA_MODEL;

    try {
      const content1 = await callClassifier({ model, prompt: promptBase });
      let parsed = extractJsonObject(content1);
      if (!parsed) {
        const content2 = await callClassifier({ model, prompt: promptRetry });
        parsed = extractJsonObject(content2);
      }
      if (!parsed) {
        classifierStatus = "fail_invalid_json";
        throw new Error("Clasificador devolvió contenido no-JSON o JSON inválido.");
      }
      classifierStatus = "ok";

      if (typeof parsed.analisis === "string" && parsed.analisis.trim()) analisisIA = parsed.analisis.trim();
      if (typeof parsed.consejo === "string" && parsed.consejo.trim()) consejoIA = parsed.consejo.trim();

      const acs = Array.isArray(parsed.acs) ? parsed.acs : [];
      const acsFiltrados = acs
        .filter((id) => typeof id === "string")
        .map((id) => id.trim())
        .filter((id) => ALLOWED_AC_IDS.includes(id))
        .slice(0, 3);

      errores = acsFiltrados.map((id) => ({
        label: id,
        text: AC_MAP[id]?.name || id,
      }));
    } catch (e) {
      const msg = String(e?.message || e);
      const isTimeout = msg.toLowerCase().includes("timeout") || e?.code === "ECONNABORTED";
      classifierStatus = isTimeout ? "fail_timeout" : classifierStatus;
      console.error("[RESULTADOS] Clasificador AC falló:", msg);
      if (numMensajes > 0) {
        errores = [{
          label: "AC_UNK",
          text: isTimeout ? "No se pudo clasificar (timeout)" : "No se pudo clasificar (formato inválido)",
        }];
      }
    }

    await r.resultadoRepo.create({
      userId: userId,
      exerciseId: exerciseId,
      interactionId: interaccionId,
      solvedOnFirstAttempt: resueltoALaPrimera,
      messageCount: numMensajes,
      aiAnalysis: analisisIA,
      aiAdvice: consejoIA,
      errors: errores,
    });

    return res.status(200).json({
      message: "Resultado guardado con éxito.",
      classifierStatus,
      saved: {
        numMensajes,
        analisisIA: Boolean(analisisIA),
        consejoIA: Boolean(consejoIA),
        errores: (errores || []).map((x) => x.label),
      },
    });
  } catch (error) {
    console.error("Error al finalizar resultado:", error);
    return res.status(500).json({ message: "Error del servidor al finalizar resultado." });
  }
});

module.exports = router;
