"use strict";

const IEjercicioRepository = require("../../../domain/ports/repositories/IEjercicioRepository");
const Ejercicio = require("../../../domain/entities/Ejercicio");

/*
   Obj, Obj -> ____|________________
              | rowToDomain() | -> Ejercicio | null
               --------------
      Maps an ejercicios row plus its optional tutor-context row into an
      Ejercicio entity, translating the Spanish columns. Null when no row.
*/
function rowToDomain(row, tutorCtx) {
  if (!row) return null;
  return new Ejercicio({
    id: row.id,
    title: row.titulo,
    statement: row.enunciado,
    image: row.imagen || "",
    subject: row.asignatura,
    concept: row.concepto,
    level: row.nivel,
    ac: row.ca || "",
    tutorContext: tutorCtx
      ? {
          objective: tutorCtx.objetivo,
          netlist: tutorCtx.netlist,
          expertMode: tutorCtx.modo_experto,
          acRefs: tutorCtx.ac_refs,
          correctAnswer: tutorCtx.respuesta_correcta,
          evaluableElements: tutorCtx.elementos_evaluables,
          version: tutorCtx.version,
        }
      : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

/*------------------------------------------------------------------------------
            _________________________________________________________
            |                  PGEJERCICIOREPOSITORY                |
            |  Repository adapter implementing IEjercicioRepository  |
            |  on top of PostgreSQL. Persists exercises and their    |
            |  one-to-one tutor_contexts row, mapping the Spanish    |
            |  columns to the domain shape.                          |
            |                                                       |
        ____|________________                                       |
   Pool -> | constructor() | -> PgEjercicioRepository (writes attrs)|
           -----------------                                        |
            |   pool: Pool (injected pg pool)                       |
        ____|__________                                             |
   Txt -> | findById() | -> Promise<Ejercicio|null>   (reads attrs) |
          ------------                                              |
        ____|_________                                             |
        | findAll() | -> Promise<[Ejercicio]>         (reads attrs) |
        -----------                                                 |
        ____|________                                              |
   Obj -> | create() | -> Promise<Ejercicio>          (reads attrs) |
          ----------                                                |
        ____|____________                                          |
   Txt,Obj -> | updateById() | -> Promise<Ejercicio>  (reads attrs) |
              ------------                                          |
        ____|______________                                        |
   Txt -> | deleteById() | -> Promise<void>           (reads attrs) |
          --------------                                            |
        ____|___________________                                   |
   Txt -> | findOneByConcept() | -> Promise<Ejercicio|null> (reads attrs)|
          ------------------                                        |
        ____|__________                                            |
   [Txt] -> | findByIds() | -> Promise<[Ejercicio]>   (reads attrs) |
            ------------                                            |
            |                                                       |
            |_______________________________________________________|
------------------------------------------------------------------------------*/
class PgEjercicioRepository extends IEjercicioRepository {
  /*
   Pool -> ____|________________
          | constructor() | -> PgEjercicioRepository    (writes attribute pool (Pool))
           -----------------
      Stores the injected pg connection pool.
  */
  constructor(pool) {
    super();
    this.pool = pool;
  }

  /*
   Txt -> ____|__________
         | findById() | -> Promise<Ejercicio|null>    (reads attribute pool (Pool))
          ------------
      Fetches an exercise by id, left-joining its tutor context.
  */
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

  /*
       ____|_________
      | findAll() | -> Promise<[Ejercicio]>    (reads attribute pool (Pool))
       -----------
      Returns every exercise with its tutor context, ordered by creation date.
  */
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

  /*
   Obj -> ____|________
         | create() | -> Promise<Ejercicio>    (reads attribute pool (Pool))
          ----------
      Inserts an exercise and, when present, its tutor context within a
      single transaction, returning the created entity.
  */
  async create(data) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const { rows } = await client.query(
        `INSERT INTO ejercicios (titulo, enunciado, imagen, asignatura, concepto, nivel, ca)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
        [data.title, data.statement, data.image || "", data.subject, data.concept, data.level, data.ac || ""]
      );
      const ej = rows[0];
      let tutorCtx = null;

      if (data.tutorContext) {
        const tc = data.tutorContext;
        const { rows: tcRows } = await client.query(
          `INSERT INTO tutor_contexts (ejercicio_id, objetivo, netlist, modo_experto, ac_refs, respuesta_correcta, elementos_evaluables, version)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
          [ej.id, tc.objective || "", tc.netlist || "", tc.expertMode || "", tc.acRefs || [], tc.correctAnswer || [], tc.evaluableElements || [], tc.version || 1]
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

  /*
   Txt, Obj -> ____|____________
              | updateById() | -> Promise<Ejercicio>    (reads attribute pool (Pool))
               ------------
      Updates the mapped scalar columns (tutorContext is ignored here),
      bumps updated_at, and returns the refreshed entity.
  */
  async updateById(id, fields) {
    const sets = [];
    const vals = [];
    let idx = 1;
    const COLUMN_MAP = {
      title: "titulo",
      statement: "enunciado",
      image: "imagen",
      subject: "asignatura",
      concept: "concepto",
      level: "nivel",
      ac: "ca",
    };
    for (const [key, val] of Object.entries(fields)) {
      if (key === "tutorContext") continue;
      const col = COLUMN_MAP[key] || key;
      sets.push(`${col} = $${idx}`);
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

  /*
   Txt -> ____|______________
         | deleteById() | -> Promise<void>    (reads attribute pool (Pool))
          --------------
      Deletes the exercise with the given id.
  */
  async deleteById(id) {
    await this.pool.query("DELETE FROM ejercicios WHERE id = $1", [id]);
  }

  /*
   Txt -> ____|___________________
         | findOneByConcept() | -> Promise<Ejercicio|null>    (reads attribute pool (Pool))
          ------------------
      Returns the first exercise matching the given concept, with its
      tutor context.
  */
  async findOneByConcept(concept) {
    const { rows } = await this.pool.query(
      `SELECT e.*, tc.objetivo, tc.netlist, tc.modo_experto, tc.ac_refs,
              tc.respuesta_correcta, tc.elementos_evaluables, tc.version AS tc_version
       FROM ejercicios e
       LEFT JOIN tutor_contexts tc ON tc.ejercicio_id = e.id
       WHERE e.concepto = $1 LIMIT 1`,
      [concept]
    );
    if (!rows[0]) return null;
    const row = rows[0];
    const tutorCtx = row.respuesta_correcta ? { objetivo: row.objetivo, netlist: row.netlist, modo_experto: row.modo_experto, ac_refs: row.ac_refs, respuesta_correcta: row.respuesta_correcta, elementos_evaluables: row.elementos_evaluables, version: row.tc_version } : null;
    return rowToDomain(row, tutorCtx);
  }

  /*
   [Txt] -> ____|____________
           | findByIds() | -> Promise<[Ejercicio]>    (reads attribute pool (Pool))
            ------------
      Returns the exercises whose ids are in the given list ([] when empty),
      each with its tutor context.
  */
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
