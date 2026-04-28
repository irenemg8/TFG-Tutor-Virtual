"use strict";

const IEjercicioRepository = require("../../../domain/ports/repositories/IEjercicioRepository");
const Ejercicio = require("../../../domain/entities/Ejercicio");

function rowToDomain(row, tutorCtx) {
  if (!row) return null;
  return new Ejercicio({
    id: row.id,
    titulo: row.titulo,
    enunciado: row.enunciado,
    imagen: row.imagen || "",
    asignatura: row.asignatura,
    concepto: row.concepto,
    nivel: row.nivel,
    ca: row.ca || "",
    tutorContext: tutorCtx
      ? {
          objetivo: tutorCtx.objetivo,
          netlist: tutorCtx.netlist,
          modoExperto: tutorCtx.modo_experto,
          ac_refs: tutorCtx.ac_refs,
          respuestaCorrecta: tutorCtx.respuesta_correcta,
          elementosEvaluables: tutorCtx.elementos_evaluables,
          version: tutorCtx.version,
        }
      : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

class PgEjercicioRepository extends IEjercicioRepository {
  constructor(pool) {
    super();
    this.pool = pool;
  }

  async findById(id) {
    const { rows } = await this.pool.query(
      `SELECT e.*, tc.objetivo, tc.netlist, tc.modo_experto, tc.ac_refs,
              tc.respuesta_correcta, tc.elementos_evaluables, tc.version AS tc_version
       FROM ejercicios e
       LEFT JOIN tutor_contexts tc ON tc.ejercicio_id = e.id
       WHERE e.id = $1`,
      [id]
    );
    if (!rows[0]) return null;
    const row = rows[0];
    const tutorCtx = row.respuesta_correcta
      ? {
          objetivo: row.objetivo,
          netlist: row.netlist,
          modo_experto: row.modo_experto,
          ac_refs: row.ac_refs,
          respuesta_correcta: row.respuesta_correcta,
          elementos_evaluables: row.elementos_evaluables,
          version: row.tc_version,
        }
      : null;
    return rowToDomain(row, tutorCtx);
  }

  async findAll() {
    const { rows } = await this.pool.query(
      `SELECT e.*, tc.objetivo, tc.netlist, tc.modo_experto, tc.ac_refs,
              tc.respuesta_correcta, tc.elementos_evaluables, tc.version AS tc_version
       FROM ejercicios e
       LEFT JOIN tutor_contexts tc ON tc.ejercicio_id = e.id
       ORDER BY e.created_at`
    );
    return rows.map((row) => {
      const tutorCtx = row.respuesta_correcta
        ? {
            objetivo: row.objetivo,
            netlist: row.netlist,
            modo_experto: row.modo_experto,
            ac_refs: row.ac_refs,
            respuesta_correcta: row.respuesta_correcta,
            elementos_evaluables: row.elementos_evaluables,
            version: row.tc_version,
          }
        : null;
      return rowToDomain(row, tutorCtx);
    });
  }

  async create(data) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const { rows } = await client.query(
        `INSERT INTO ejercicios (titulo, enunciado, imagen, asignatura, concepto, nivel, ca)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
        [data.titulo, data.enunciado, data.imagen || "", data.asignatura, data.concepto, data.nivel, data.CA || ""]
      );
      const ej = rows[0];
      let tutorCtx = null;

      if (data.tutorContext) {
        const tc = data.tutorContext;
        const { rows: tcRows } = await client.query(
          `INSERT INTO tutor_contexts (ejercicio_id, objetivo, netlist, modo_experto, ac_refs, respuesta_correcta, elementos_evaluables, version)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
          [ej.id, tc.objetivo || "", tc.netlist || "", tc.modoExperto || "", tc.ac_refs || [], tc.respuestaCorrecta || [], tc.elementosEvaluables || [], tc.version || 1]
        );
        tutorCtx = tcRows[0];
      }
      await client.query("COMMIT");
      return rowToDomain(ej, tutorCtx);
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
  }

  async updateById(id, fields) {
    const sets = [];
    const vals = [];
    let idx = 1;
    for (const [key, val] of Object.entries(fields)) {
      if (key === "tutorContext") continue;
      sets.push(`${key} = $${idx}`);
      vals.push(val);
      idx++;
    }
    if (sets.length > 0) {
      sets.push("updated_at = NOW()");
      vals.push(id);
      await this.pool.query(
        `UPDATE ejercicios SET ${sets.join(", ")} WHERE id = $${idx}`,
        vals
      );
    }
    return this.findById(id);
  }

  async deleteById(id) {
    await this.pool.query("DELETE FROM ejercicios WHERE id = $1", [id]);
  }

  async findOneByConcepto(concepto) {
    const { rows } = await this.pool.query(
      `SELECT e.*, tc.objetivo, tc.netlist, tc.modo_experto, tc.ac_refs,
              tc.respuesta_correcta, tc.elementos_evaluables, tc.version AS tc_version
       FROM ejercicios e
       LEFT JOIN tutor_contexts tc ON tc.ejercicio_id = e.id
       WHERE e.concepto = $1 LIMIT 1`,
      [concepto]
    );
    if (!rows[0]) return null;
    const row = rows[0];
    const tutorCtx = row.respuesta_correcta ? { objetivo: row.objetivo, netlist: row.netlist, modo_experto: row.modo_experto, ac_refs: row.ac_refs, respuesta_correcta: row.respuesta_correcta, elementos_evaluables: row.elementos_evaluables, version: row.tc_version } : null;
    return rowToDomain(row, tutorCtx);
  }

  async findByIds(ids) {
    if (!ids.length) return [];
    const { rows } = await this.pool.query(
      `SELECT e.*, tc.objetivo, tc.netlist, tc.modo_experto, tc.ac_refs,
              tc.respuesta_correcta, tc.elementos_evaluables, tc.version AS tc_version
       FROM ejercicios e
       LEFT JOIN tutor_contexts tc ON tc.ejercicio_id = e.id
       WHERE e.id = ANY($1::text[])`,
      [ids]
    );
    return rows.map((row) => {
      const tutorCtx = row.respuesta_correcta ? { objetivo: row.objetivo, netlist: row.netlist, modo_experto: row.modo_experto, ac_refs: row.ac_refs, respuesta_correcta: row.respuesta_correcta, elementos_evaluables: row.elementos_evaluables, version: row.tc_version } : null;
      return rowToDomain(row, tutorCtx);
    });
  }
}

module.exports = PgEjercicioRepository;
