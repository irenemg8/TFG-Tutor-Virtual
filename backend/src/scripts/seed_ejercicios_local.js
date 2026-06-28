#!/usr/bin/env node
"use strict";

/*------------------------------------------------------------------------------
            _________________________________________________________
            |                  SEED EJERCICIOS LOCAL                |
            |  Idempotent dev seed script that merges                |
            |  tutorContext_por_ejercicio.json (primary) with        |
            |  ohm_exercises.json (fallback) and inserts ejercicios  |
            |  and tutor_contexts into PostgreSQL. Supports --reset. |
            |                                                       |
            |   Txt -> | difficultyToNivel() | -> Z                  |
            |   Txt -> | normalizeNetlistLine() | -> Txt             |
            |   Obj,Obj -> | buildNetlist() | -> Txt                 |
            |   Obj,Obj -> | buildObjetivo() | -> Txt                |
            |   Obj,Obj -> | buildModoExperto() | -> Txt             |
            |   Obj,Obj -> | buildAcRefs() | -> [Txt]                |
            |   Obj,Obj -> | isCloneOfFirst() | -> T/F               |
            |          | main() | -> Promise<void>                   |
            |_______________________________________________________|
------------------------------------------------------------------------------*/

const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", "..", ".env") });

const fs = require("fs");
const { Pool } = require("pg");

const DATA_DIR = path.resolve(__dirname, "..", "data");
const OHM_JSON = path.join(DATA_DIR, "ohm_exercises.json");
const CTX_JSON = path.join(DATA_DIR, "contextos-ejercicios", "tutorContext_por_ejercicio.json");

const RESET = process.argv.includes("--reset");

/*
   Txt -> ____|_____________________
         | difficultyToNivel() | -> Z
          ---------------------
      Maps a difficulty token ("easy"/"hard"/other) to a numeric level.
*/
function difficultyToNivel(d) {
  if (d === "easy") return 1;
  if (d === "hard") return 3;
  return 2;
}

/*
   Txt -> ____|________________________
         | normalizeNetlistLine() | -> Txt
          ------------------------
      Converts a netlist line like "R1(N1,A,2)" into the space-separated
      form "R1 N1 A 2" the prompt builder expects; leaves other lines trimmed.
*/
function normalizeNetlistLine(line) {
  if (typeof line !== "string") return "";
  const m = line.match(/^([A-Za-z]\d+)\(([^)]+)\)\s*$/);
  if (m) {
    const name = m[1];
    const tokens = m[2].split(",").map((s) => s.trim()).filter(Boolean);
    return [name].concat(tokens).join(" ");
  }
  return line.trim();
}

/*
   Obj,Obj -> ____|_____________
             | buildNetlist() | -> Txt
              ---------------
      Returns the primary netlist when long enough, otherwise builds one
      from the ohm exercise netlist, falling back to the primary value.
*/
function buildNetlist(tc, ex) {
  if (tc.netlist && tc.netlist.length > 30) return tc.netlist;
  if (Array.isArray(ex.netlist) && ex.netlist.length > 0) {
    return ex.netlist.map(normalizeNetlistLine).join("\n");
  }
  return tc.netlist || "";
}

/*
   Obj,Obj -> ____|______________
             | buildObjetivo() | -> Txt
              ----------------
      Returns the primary objective when present, otherwise fabricates a
      Socratic-tutor objective from the exercise statement and question.
*/
function buildObjetivo(tc, ex) {
  if (tc.objetivo && tc.objetivo.trim().length > 30) return tc.objetivo;
  const enunciado = ex.description || "";
  const pregunta = ex.question || "";
  return (
    "Tutor socrático para el Ejercicio " + ex.id + ". " +
    "Enunciado: " + enunciado + " " +
    "Pregunta a resolver: " + pregunta + " " +
    "Tu objetivo es guiar al estudiante mediante preguntas socráticas " +
    "para que descubra la respuesta por sí mismo, identificando y " +
    "corrigiendo posibles concepciones alternativas. NUNCA des la " +
    "respuesta directamente."
  );
}

/*
   Obj,Obj -> ____|_________________
             | buildModoExperto() | -> Txt
              -------------------
      Returns the primary expert reasoning when present, otherwise builds
      one from the exercise explanation/calculation.
*/
function buildModoExperto(tc, ex) {
  if (tc.modoExperto && tc.modoExperto.trim().length > 50) return tc.modoExperto;
  const expl = ex.explanation || ex.calculation || "";
  if (!expl) return tc.modoExperto || "";
  return (
    "Análisis experto del circuito: " + expl + " " +
    "Considera siempre el camino global de la corriente y verifica si " +
    "cada componente contribuye al resultado pedido."
  );
}

/*
   Obj,Obj -> ____|____________
             | buildAcRefs() | -> [Txt]
              --------------
      Returns the primary alternative-conception refs, falling back to the
      keys of the ohm exercise alternative_conceptions object.
*/
function buildAcRefs(tc, ex) {
  if (Array.isArray(tc.ac_refs) && tc.ac_refs.length > 0) return tc.ac_refs;
  const acs = ex.alternative_conceptions;
  if (acs && typeof acs === "object") return Object.keys(acs);
  return [];
}

/*
   Obj,Obj -> ____|_______________
             | isCloneOfFirst() | -> T/F
              -----------------
      True when an exercise's expert reasoning and netlist match those of
      exercise 1 exactly, flagging it as a literal clone of the first.
*/
function isCloneOfFirst(tc, firstTc) {
  if (!firstTc) return false;
  if (!tc.modoExperto || !tc.netlist) return false;
  return (
    tc.modoExperto === firstTc.modoExperto &&
    tc.netlist === firstTc.netlist
  );
}

/*
        ____|_______
       | main() | -> Promise<void>
        --------
      Loads both data sources, merges them per exercise, and inserts
      ejercicios and tutor_contexts into PostgreSQL; --reset deletes first.
*/
async function main() {
  const conn = process.env.PG_CONNECTION_STRING;
  if (!conn) {
    console.error("PG_CONNECTION_STRING no está definido. Revisa backend/.env.");
    process.exit(1);
  }

  const ohm = JSON.parse(fs.readFileSync(OHM_JSON, "utf8"));
  const ctxArr = JSON.parse(fs.readFileSync(CTX_JSON, "utf8"));
  const ctxByEx = new Map();
  for (const item of ctxArr) ctxByEx.set(item.ejercicio, item.tutorContext || {});
  const firstTc = ctxByEx.get(1) || {};

  const pool = new Pool({ connectionString: conn });
  const client = await pool.connect();

  try {
    if (RESET) {
      console.log("[reset] DELETE FROM ejercicios (cascade borra tutor_contexts)");
      await client.query("DELETE FROM ejercicios");
    }

    let created = 0, skipped = 0;
    for (const ex of ohm.exercises) {
      const titulo = "Ejercicio " + ex.id;
      const exists = await client.query(
        "SELECT id FROM ejercicios WHERE titulo = $1 LIMIT 1",
        [titulo]
      );
      if (exists.rows[0] && !RESET) {
        console.log(`[skip] "${titulo}" ya existe (id=${exists.rows[0].id})`);
        skipped++;
        continue;
      }

      let tc = ctxByEx.get(ex.id) || {};
      if (ex.id > 1 && isCloneOfFirst(tc, firstTc)) {
        console.log(`[merge] Ej ${ex.id}: tutorContext clon de Ej 1, usando ohm_exercises como fuente`);
        tc = {};
      }

      const objetivo   = buildObjetivo(tc, ex);
      const netlist    = buildNetlist(tc, ex);
      const modoExperto = buildModoExperto(tc, ex);
      const acRefs     = buildAcRefs(tc, ex);
      const respuesta  = Array.isArray(tc.respuestaCorrecta) && tc.respuestaCorrecta.length > 0
        ? tc.respuestaCorrecta
        : (Array.isArray(ex.correct_answer) ? ex.correct_answer : []);
      const evaluables = (() => {
        if (Array.isArray(tc.elementosEvaluables) && tc.elementosEvaluables.length > 0) {
          return tc.elementosEvaluables;
        }
        const set = new Set();
        const matches = (netlist || "").match(/R\d+/gi) || [];
        for (const m of matches) set.add(m.toUpperCase());
        return Array.from(set);
      })();

      const enunciado = (tc.enunciado && String(tc.enunciado).trim().length > 20)
        ? String(tc.enunciado).trim()
        : [ex.description, ex.question].filter(Boolean).join("\n\n");
      const imagen = "Ejercicio" + ex.id + ".jpg";
      const asignatura = "Dispositivos electrónicos";
      const concepto = "Ley de Ohm";
      const nivel = difficultyToNivel(ex.difficulty);
      const ca = Array.isArray(ex.correct_answer) ? ex.correct_answer.join(", ") : (ex.correct_answer || "");

      await client.query("BEGIN");
      try {
        const ins = await client.query(
          `INSERT INTO ejercicios (titulo, enunciado, imagen, asignatura, concepto, nivel, ca)
           VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
          [titulo, enunciado, imagen, asignatura, concepto, nivel, ca]
        );
        const ejId = ins.rows[0].id;
        await client.query(
          `INSERT INTO tutor_contexts (ejercicio_id, objetivo, netlist, modo_experto, ac_refs, respuesta_correcta, elementos_evaluables, version)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [ejId, objetivo, netlist, modoExperto, acRefs, respuesta, evaluables, tc.version || 1]
        );
        await client.query("COMMIT");
        created++;
        console.log(
          `[ok]   "${titulo}" → obj=${objetivo.length}c netlist=${netlist.length}c ` +
          `expert=${modoExperto.length}c ACs=[${acRefs.join(",")}] respCorrect=[${respuesta.slice(0,5).join(",")}]` +
          (respuesta.length > 5 ? ",..." : "")
        );
      } catch (e) {
        await client.query("ROLLBACK");
        console.error(`[fail] "${titulo}":`, e.message);
      }
    }

    console.log(`\nResumen: ${created} creados, ${skipped} ya existían.`);
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
