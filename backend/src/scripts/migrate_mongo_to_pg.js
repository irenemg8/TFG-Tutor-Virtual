#!/usr/bin/env node
"use strict";

/**
 * Data migration script: MongoDB Atlas → PostgreSQL local
 *
 * Copies all documents from MongoDB to PostgreSQL. The schema uses VARCHAR(50)
 * for IDs, so we preserve the ORIGINAL MongoDB ObjectId (as a hex string) as
 * the primary key in Postgres. Existing sessions (which carry the ObjectId
 * as userId) continue to work without re-login.
 *
 * Denormalizes embedded arrays:
 *   - Interaccion.conversacion[]  → messages table
 *   - Resultado.errores[]         → error_entries table
 *   - Ejercicio.tutorContext      → tutor_contexts table
 *
 * Idempotent: uses `ON CONFLICT DO NOTHING` on inserts. Safe to re-run.
 *
 * Usage:
 *   # Dry run — shows counts without writing
 *   node src/scripts/migrate_mongo_to_pg.js --dry-run
 *
 *   # Run migrations (creates tables) + copy data
 *   node src/scripts/migrate_mongo_to_pg.js
 *
 *   # Reset: DROP all tables first, recreate, then copy
 *   node src/scripts/migrate_mongo_to_pg.js --reset
 *
 * Env vars required: MONGODB_URI, PG_CONNECTION_STRING (from backend/.env)
 */

const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", "..", ".env") });

const fs = require("fs");
const mongoose = require("mongoose");
const { Pool } = require("pg");

const UsuarioModel = require("../infrastructure/persistence/mongodb/models/usuario");
const EjercicioModel = require("../infrastructure/persistence/mongodb/models/ejercicio");
const InteraccionModel = require("../infrastructure/persistence/mongodb/models/interaccion");
const ResultadoModel = require("../infrastructure/persistence/mongodb/models/resultado");

const PG_URI = process.env.PG_CONNECTION_STRING;
const MONGO_URI = process.env.MONGODB_URI;

const DRY_RUN = process.argv.includes("--dry-run");
const RESET = process.argv.includes("--reset");

if (!PG_URI) {
  console.error("ERROR: PG_CONNECTION_STRING not set (check backend/.env)");
  process.exit(1);
}
if (!MONGO_URI) {
  console.error("ERROR: MONGODB_URI not set (check backend/.env)");
  process.exit(1);
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

const counts = { usuarios: 0, ejercicios: 0, tutor_contexts: 0, interacciones: 0, messages: 0, resultados: 0, error_entries: 0 };
const skipped = { usuarios: 0, ejercicios: 0, interacciones: 0, resultados: 0 };

function oid(value) {
  if (!value) return null;
  if (typeof value === "string") return value;
  if (value.toString) return value.toString();
  return String(value);
}

async function runSqlFile(pool, sqlPath) {
  const sql = fs.readFileSync(sqlPath, "utf8");
  await pool.query(sql);
}

async function resetDatabase(pool) {
  console.log("[MIGRATE] --reset: dropping all tables...");
  await pool.query(`
    DROP TABLE IF EXISTS sessions CASCADE;
    DROP TABLE IF EXISTS error_entries CASCADE;
    DROP TABLE IF EXISTS resultados CASCADE;
    DROP TABLE IF EXISTS messages CASCADE;
    DROP TABLE IF EXISTS interacciones CASCADE;
    DROP TABLE IF EXISTS tutor_contexts CASCADE;
    DROP TABLE IF EXISTS ejercicios CASCADE;
    DROP TABLE IF EXISTS usuarios CASCADE;
  `);
  console.log("[MIGRATE] Tables dropped.");
}

async function applyMigrations(pool) {
  console.log("[MIGRATE] Applying schema migrations...");
  const migDir = path.join(
    __dirname, "..", "infrastructure", "persistence", "postgresql", "migrations"
  );
  const files = fs.readdirSync(migDir).filter(f => f.endsWith(".sql")).sort();
  for (const file of files) {
    console.log(`[MIGRATE]   running ${file}`);
    await runSqlFile(pool, path.join(migDir, file));
  }
  console.log(`[MIGRATE] ${files.length} migrations applied.`);
}

// ─── Per-collection copy ─────────────────────────────────────────────────────

async function migrateUsuarios(pool) {
  console.log("[MIGRATE] ── usuarios ──");
  const docs = await UsuarioModel.find().lean();
  for (const doc of docs) {
    const id = oid(doc._id);
    if (DRY_RUN) { counts.usuarios++; continue; }
    try {
      const res = await pool.query(
        `INSERT INTO usuarios (id, upv_login, loguin_usuario, email, nombre, apellidos, dni, grupos, rol, last_login_at, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
         ON CONFLICT (id) DO NOTHING`,
        [
          id, doc.upvLogin, doc.loguin_usuario, doc.email, doc.nombre, doc.apellidos, doc.dni,
          doc.grupos || [], doc.rol || "alumno", doc.lastLoginAt,
          doc.createdAt || new Date(), doc.updatedAt || new Date(),
        ]
      );
      if (res.rowCount > 0) counts.usuarios++;
      else skipped.usuarios++;
    } catch (e) {
      console.error(`[MIGRATE] Usuario ${id} failed:`, e.message);
    }
  }
  console.log(`[MIGRATE] usuarios: inserted=${counts.usuarios} skipped=${skipped.usuarios} total=${docs.length}`);
}

async function migrateEjercicios(pool) {
  console.log("[MIGRATE] ── ejercicios + tutor_contexts ──");
  const docs = await EjercicioModel.find().lean();
  for (const doc of docs) {
    const id = oid(doc._id);
    if (DRY_RUN) { counts.ejercicios++; if (doc.tutorContext) counts.tutor_contexts++; continue; }
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const res = await client.query(
        `INSERT INTO ejercicios (id, titulo, enunciado, imagen, asignatura, concepto, nivel, ca, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         ON CONFLICT (id) DO NOTHING`,
        [
          id, doc.titulo, doc.enunciado, doc.imagen || "", doc.asignatura,
          doc.concepto, doc.nivel, doc.CA || "",
          doc.createdAt || new Date(), doc.updatedAt || new Date(),
        ]
      );
      if (res.rowCount > 0) counts.ejercicios++;
      else skipped.ejercicios++;

      if (doc.tutorContext) {
        const tc = doc.tutorContext;
        const tcRes = await client.query(
          `INSERT INTO tutor_contexts (ejercicio_id, objetivo, netlist, modo_experto, ac_refs, respuesta_correcta, elementos_evaluables, version)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
           ON CONFLICT (ejercicio_id) DO NOTHING`,
          [
            id, tc.objetivo || "", tc.netlist || "", tc.modoExperto || "",
            tc.ac_refs || [], tc.respuestaCorrecta || [],
            tc.elementosEvaluables || [], tc.version || 1,
          ]
        );
        if (tcRes.rowCount > 0) counts.tutor_contexts++;
      }
      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK");
      console.error(`[MIGRATE] Ejercicio ${id} failed:`, e.message);
    } finally {
      client.release();
    }
  }
  console.log(`[MIGRATE] ejercicios: inserted=${counts.ejercicios} skipped=${skipped.ejercicios} total=${docs.length}`);
  console.log(`[MIGRATE] tutor_contexts: inserted=${counts.tutor_contexts}`);
}

async function migrateInteracciones(pool) {
  console.log("[MIGRATE] ── interacciones + messages ──");
  const total = await InteraccionModel.countDocuments();
  const cursor = InteraccionModel.find().lean().cursor();
  let processed = 0;
  for await (const doc of cursor) {
    const id = oid(doc._id);
    const uid = oid(doc.usuario_id);
    const eid = oid(doc.ejercicio_id);
    if (!uid || !eid) {
      skipped.interacciones++;
      continue;
    }
    if (DRY_RUN) {
      counts.interacciones++;
      counts.messages += (doc.conversacion || []).length;
      processed++;
      continue;
    }
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const res = await client.query(
        `INSERT INTO interacciones (id, usuario_id, ejercicio_id, inicio, fin, created_at)
         VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (id) DO NOTHING`,
        [id, uid, eid, doc.inicio || new Date(), doc.fin || new Date(), doc.inicio || new Date()]
      );
      if (res.rowCount > 0) {
        counts.interacciones++;

        // Only insert messages if the interaccion was inserted (not if skipped)
        const msgs = doc.conversacion || [];
        for (let i = 0; i < msgs.length; i++) {
          const m = msgs[i];
          const meta = m.metadata || {};
          const guard = meta.guardrails || {};
          const timing = meta.timing || {};
          await client.query(
            `INSERT INTO messages (interaccion_id, sequence_num, role, content, timestamp,
              classification, decision, is_correct_answer, sources_count, student_response_ms,
              guardrail_solution_leak, guardrail_false_confirmation,
              guardrail_premature_confirmation, guardrail_state_reveal,
              timing_pipeline_ms, timing_ollama_ms, timing_total_ms)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
             ON CONFLICT (interaccion_id, sequence_num) DO NOTHING`,
            [
              id, i, m.role, m.content, m.timestamp || new Date(),
              meta.classification || null, meta.decision || null,
              meta.isCorrectAnswer != null ? meta.isCorrectAnswer : null,
              meta.sourcesCount || 0,
              meta.studentResponseMs || null,
              guard.solutionLeak || false, guard.falseConfirmation || false,
              guard.prematureConfirmation || false, guard.stateReveal || false,
              timing.pipelineMs || null, timing.ollamaMs || null, timing.totalMs || null,
            ]
          );
          counts.messages++;
        }
      } else {
        skipped.interacciones++;
      }
      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK");
      console.error(`[MIGRATE] Interaccion ${id} failed:`, e.message);
    } finally {
      client.release();
    }
    processed++;
    if (processed % 50 === 0) {
      console.log(`[MIGRATE]   progress: ${processed}/${total}`);
    }
  }
  console.log(`[MIGRATE] interacciones: inserted=${counts.interacciones} skipped=${skipped.interacciones} total=${total}`);
  console.log(`[MIGRATE] messages: inserted=${counts.messages}`);
}

async function migrateResultados(pool) {
  console.log("[MIGRATE] ── resultados + error_entries ──");
  const docs = await ResultadoModel.find().lean();
  for (const doc of docs) {
    const id = oid(doc._id);
    const uid = oid(doc.usuario_id);
    const eid = oid(doc.ejercicio_id);
    const iid = oid(doc.interaccion_id);
    if (!uid || !eid || !iid) {
      skipped.resultados++;
      continue;
    }
    if (DRY_RUN) {
      counts.resultados++;
      counts.error_entries += (doc.errores || []).length;
      continue;
    }
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const res = await client.query(
        `INSERT INTO resultados (id, usuario_id, ejercicio_id, interaccion_id, num_mensajes, resuelto_a_la_primera, analisis_ia, consejo_ia, fecha)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         ON CONFLICT (id) DO NOTHING`,
        [
          id, uid, eid, iid,
          doc.numMensajes || 0, doc.resueltoALaPrimera || false,
          doc.analisisIA || null, doc.consejoIA || null,
          doc.fecha || new Date(),
        ]
      );
      if (res.rowCount > 0) {
        counts.resultados++;
        for (const err of (doc.errores || [])) {
          await client.query(
            "INSERT INTO error_entries (resultado_id, etiqueta, texto) VALUES ($1,$2,$3)",
            [id, err.etiqueta, err.texto]
          );
          counts.error_entries++;
        }
      } else {
        skipped.resultados++;
      }
      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK");
      console.error(`[MIGRATE] Resultado ${id} failed:`, e.message);
    } finally {
      client.release();
    }
  }
  console.log(`[MIGRATE] resultados: inserted=${counts.resultados} skipped=${skipped.resultados} total=${docs.length}`);
  console.log(`[MIGRATE] error_entries: inserted=${counts.error_entries}`);
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`[MIGRATE] mode=${DRY_RUN ? "DRY-RUN" : "WRITE"} reset=${RESET ? "YES" : "no"}`);

  console.log("[MIGRATE] Connecting to MongoDB...");
  await mongoose.connect(MONGO_URI);
  console.log("[MIGRATE] ✓ MongoDB");

  console.log("[MIGRATE] Connecting to PostgreSQL...");
  const pool = new Pool({ connectionString: PG_URI });
  await pool.query("SELECT 1");
  console.log("[MIGRATE] ✓ PostgreSQL");

  try {
    if (RESET && !DRY_RUN) await resetDatabase(pool);
    if (!DRY_RUN) await applyMigrations(pool);

    await migrateUsuarios(pool);
    await migrateEjercicios(pool);
    await migrateInteracciones(pool);
    await migrateResultados(pool);

    console.log("\n[MIGRATE] ═══ SUMMARY ═══");
    console.log(JSON.stringify(counts, null, 2));
    if (DRY_RUN) console.log("\n[MIGRATE] (dry-run: no writes)");
  } catch (err) {
    console.error("[MIGRATE] FATAL:", err);
    process.exitCode = 1;
  } finally {
    await pool.end();
    await mongoose.disconnect();
    console.log("[MIGRATE] Done.");
  }
}

main().catch((err) => {
  console.error("[MIGRATE] Unhandled error:", err);
  process.exit(1);
});
