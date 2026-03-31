// backend/src/utils/promptBuilder.js

const FIN_TOKEN = "<FIN_EJERCICIO>";

function safeStr(x) {
  if (typeof x !== "string") return "";
  return x.trim();
}

function pickFirstStr(obj, keys) {
  for (const k of keys) {
    const v = safeStr(obj?.[k]);
    if (v) return v;
  }
  return "";
}

function normId(s) {
  return String(s || "")
    .toUpperCase()
    .replace(/\s+/g, "")
    .trim();
}

function formatList(arr) {
  if (!Array.isArray(arr) || arr.length === 0) return "";
  return arr.filter(Boolean).join(", ");
}

function buildTutorSystemPrompt(ejercicio) {
  // Campos base del ejercicio
  const titulo = pickFirstStr(ejercicio, ["titulo", "nombre", "name"]);
  const enunciado = pickFirstStr(ejercicio, ["enunciado", "texto", "statement", "descripcion"]);
  const concepto = pickFirstStr(ejercicio, ["concepto", "tema", "topic"]);
  const asignatura = pickFirstStr(ejercicio, ["asignatura", "subject"]);
  const nivel = ejercicio?.nivel != null ? String(ejercicio.nivel) : "";
  const imagen = pickFirstStr(ejercicio, ["imagen", "image", "imageUrl", "img"]);

  // TutorContext estructurado
  const tc = ejercicio?.tutorContext || {};
  const objetivo = pickFirstStr(tc, ["objetivo"]);
  const netlist = pickFirstStr(tc, ["netlist"]);
  const modoExperto = pickFirstStr(tc, ["modoExperto"]);
  const version = tc?.version != null ? String(tc.version) : "";

  // Concepciones alternativas populadas (objetos completos)
  const acDocs = Array.isArray(ejercicio?.concepciones_alternativas)
    ? ejercicio.concepciones_alternativas.filter(Boolean)
    : [];

  // Fallback: si no hay objetos populados, usar los IDs del tutorContext
  const acRefs = Array.isArray(tc?.ac_refs) ? tc.ac_refs.map(normId).filter(Boolean) : [];

  // ✅ Respuesta correcta (lista cerrada para este ejercicio)
  const respuestaCorrecta = Array.isArray(tc?.respuestaCorrecta)
    ? tc.respuestaCorrecta.map(normId).filter(Boolean)
    : [];

  const rules = `
Eres un tutor socrático para ayudar al estudiante a razonar sobre circuitos (Ley de Ohm).
- Responde SIEMPRE en español.
- NO des la solución final directamente.
- No uses analogías
- Si el estudiante se equivoca, guía con preguntas socráticas para que detecte el error  y le guíen hacia el modo de pensar de un experto.
- Mantén un tono claro, paciente y técnico.

CRITERIO DE FIN (MUY IMPORTANTE):
- En el momento que el estudiante da la respuesta correcta del ejercicio (diga exactamente las resistencias), indícalo brevemente y añade EXACTAMENTE el token ${FIN_TOKEN} al final de tu mensaje (sin espacios extra ni mostrarlo al usuario).
- La respuesta correcta se define por "RESPUESTA CORRECTA (RESISTENCIAS)".
- Considera correcta SOLO si el estudiante incluye TODAS esas resistencias y NO añade resistencias extra.
- Da por finalizado el ejercicio en el momento que el estudiante da la respuesta correcta, aunque haya errores previos en la conversación.
`.trim();

  const acSection = (() => {
    if (acDocs.length > 0) {
      return acDocs.map((ac) => {
        const lineas = [`[${ac.codigo}] ${ac.descripcion}`];
        if (Array.isArray(ac.ejemplosError) && ac.ejemplosError.length > 0) {
          lineas.push(`  Ejemplos de error: ${ac.ejemplosError.filter(Boolean).join("; ")}`);
        }
        if (ac.estrategiaSocratica?.trim()) {
          lineas.push(`  Estrategia socrática: ${ac.estrategiaSocratica.trim()}`);
        }
        return lineas.join("\n");
      }).join("\n\n");
    }
    if (acRefs.length > 0) return `(solo IDs disponibles: ${formatList(acRefs)})`;
    return "(ninguna)";
  })();

  const contexto = `
OBJETIVO:
${objetivo || "(no definido)"}

NETLIST:
${netlist || "(no definido)"}

MODO DE PENSAR EXPERTO:
${modoExperto || "(no definido)"}

CONCEPCIONES ALTERNATIVAS DE LOS ESTUDIANTES:
${acSection}

RESPUESTA CORRECTA (RESISTENCIAS):
${respuestaCorrecta.length ? formatList(respuestaCorrecta) : "(no definida)"}

VERSIÓN CONTEXTO:
${version || "(no definida)"}
`.trim();

  const ejercicioInfo = `
EJERCICIO ACTUAL:
${titulo ? `Título: ${titulo}` : ""}
${asignatura ? `Asignatura: ${asignatura}` : ""}
${concepto ? `Concepto: ${concepto}` : ""}
${nivel ? `Nivel: ${nivel}` : ""}
${enunciado ? `Enunciado: ${enunciado}` : ""}
${imagen ? `Imagen asociada (referencia): ${imagen}` : ""}
`.trim();

  return [contexto, rules, ejercicioInfo].filter(Boolean).join("\n\n");
}

module.exports = { buildTutorSystemPrompt };
