"use strict";

const fs = require("fs");
const path = require("path");

/**
 * AC Registry — matchea la respuesta del alumno contra los patrones de
 * Alternative Conceptions definidos por ejercicio en
 * tutorContext_por_ejercicio.json (campo `acPatterns`).
 *
 * Patrón soportado:
 *   {
 *     id: "AC1",
 *     name: "Modelo del circuito abierto",
 *     misconception: "Incluye R3 pensando que circula corriente por el interruptor abierto",
 *     strategy: "Pregunta sobre lo que ocurre con la corriente en una rama interrumpida; no nombres R3.",
 *     match: {
 *       includes?: ["R3"],         // dispara si proposed contiene CUALQUIERA
 *       includesAll?: ["R5","R3"], // dispara si proposed contiene TODOS
 *       excludes?: ["R3"],         // dispara si negated (rejected) contiene cualquiera
 *       missesAny?: ["R4"],        // dispara si MISSING contiene cualquiera
 *       missesAll?: ["R1","R2"],   // dispara si MISSING contiene TODOS
 *       proposedSetEquals?: ["R3","R4","R5"]  // dispara si proposed === exactamente esa set
 *     }
 *   }
 *
 * El matcher devuelve un array de matches con confianza (0..1) ordenados
 * por relevancia, para que el TutorAgent inyecte el banner [AC DETECTADA].
 */

function toUpperSet(arr) {
  const s = new Set();
  if (!Array.isArray(arr)) return s;
  for (const x of arr) {
    if (typeof x === "string") s.add(x.toUpperCase().replace(/\s+/g, ""));
  }
  return s;
}

function intersect(a, b) {
  const out = [];
  for (const x of a) if (b.has(x)) out.push(x);
  return out;
}

/**
 * @param {Array<object>} acPatterns - el campo acPatterns del tutorContext
 * @param {Array<string>} proposedRaw - elementos que el alumno propone
 * @param {Array<string>} negatedRaw - elementos que el alumno rechaza
 * @param {Array<string>} correctAnswerRaw - respuesta correcta del ejercicio
 * @returns {Array<{id, name, misconception, strategy, confidence, reason}>}
 */
function matchACs(acPatterns, proposedRaw, negatedRaw, correctAnswerRaw) {
  if (!Array.isArray(acPatterns) || acPatterns.length === 0) return [];
  const proposed = toUpperSet(proposedRaw);
  const negated = toUpperSet(negatedRaw);
  const correct = toUpperSet(correctAnswerRaw);
  const missing = new Set();
  for (const c of correct) {
    if (!proposed.has(c) && !negated.has(c)) missing.add(c);
  }

  const matches = [];
  for (const ac of acPatterns) {
    if (!ac || !ac.match) continue;
    let confidence = 0;
    const reasons = [];
    const m = ac.match;

    if (Array.isArray(m.proposedSetEquals)) {
      const target = toUpperSet(m.proposedSetEquals);
      const equal =
        proposed.size === target.size && [...target].every((x) => proposed.has(x));
      if (equal) {
        confidence = Math.max(confidence, 0.95);
        reasons.push("proposed exactly matches " + [...target].join(","));
      }
    }

    if (Array.isArray(m.includesAll)) {
      const target = toUpperSet(m.includesAll);
      const all = [...target].every((x) => proposed.has(x));
      if (all && target.size > 0) {
        confidence = Math.max(confidence, 0.9);
        reasons.push("proposed includes all of " + [...target].join(","));
      }
    }

    if (Array.isArray(m.includes)) {
      const target = toUpperSet(m.includes);
      const hit = intersect(target, proposed);
      if (hit.length > 0) {
        // Solo cuenta si el elemento NO está en la respuesta correcta
        // (incluir un elemento que no debería) — esa es la marca de la AC.
        const wronglyIncluded = hit.filter((x) => !correct.has(x));
        if (wronglyIncluded.length > 0) {
          confidence = Math.max(confidence, 0.85);
          reasons.push("wrongly includes " + wronglyIncluded.join(","));
        }
      }
    }

    if (Array.isArray(m.excludes)) {
      const target = toUpperSet(m.excludes);
      const hit = intersect(target, negated);
      if (hit.length > 0) {
        // El alumno rechaza algo que SÍ debería estar
        const wronglyRejected = hit.filter((x) => correct.has(x));
        if (wronglyRejected.length > 0) {
          confidence = Math.max(confidence, 0.8);
          reasons.push("wrongly excludes " + wronglyRejected.join(","));
        }
      }
    }

    if (Array.isArray(m.missesAll)) {
      const target = toUpperSet(m.missesAll);
      const all = [...target].every((x) => missing.has(x));
      if (all && target.size > 0) {
        confidence = Math.max(confidence, 0.8);
        reasons.push("misses all of " + [...target].join(","));
      }
    }

    if (Array.isArray(m.missesAny)) {
      const target = toUpperSet(m.missesAny);
      const hit = intersect(target, missing);
      if (hit.length > 0) {
        // misses_any es señal débil: muchos alumnos olvidan algo aunque
        // no estén mostrando esa AC. Confianza más baja.
        confidence = Math.max(confidence, 0.55);
        reasons.push("misses " + hit.join(","));
      }
    }

    if (confidence > 0) {
      matches.push({
        id: ac.id,
        name: ac.name || ac.id,
        misconception: ac.misconception || "",
        strategy: ac.strategy || "",
        confidence,
        reason: reasons.join("; "),
      });
    }
  }

  matches.sort((a, b) => b.confidence - a.confidence);
  return matches;
}

// In-memory cache of acPatterns por número de ejercicio. Se carga la
// primera vez que alguien lo pide y se reutiliza después. La entidad
// TutorContext / la DB no persisten acPatterns (decisión NS-1.b para no
// migrar el schema), así que el JSON es la fuente de verdad en runtime.
let _patternsByExercise = null;
const DEFAULT_JSON = path.resolve(
  __dirname,
  "..",
  "..",
  "data",
  "contextos-ejercicios",
  "tutorContext_por_ejercicio.json"
);

function _load(jsonPath) {
  const raw = fs.readFileSync(jsonPath || DEFAULT_JSON, "utf8");
  const arr = JSON.parse(raw);
  const map = new Map();
  for (const item of arr) {
    const tc = item.tutorContext || {};
    map.set(Number(item.ejercicio), Array.isArray(tc.acPatterns) ? tc.acPatterns : []);
  }
  return map;
}

function getPatternsForExercise(exerciseNum) {
  if (_patternsByExercise == null) _patternsByExercise = _load();
  return _patternsByExercise.get(Number(exerciseNum)) || [];
}

function reloadPatternsForTests(jsonPath) {
  _patternsByExercise = _load(jsonPath);
}

module.exports = { matchACs, getPatternsForExercise, reloadPatternsForTests };
