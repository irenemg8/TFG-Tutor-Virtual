"use strict";

const IResultadoRepository = require("../../../domain/ports/repositories/IResultadoRepository");
const Resultado = require("../../../domain/entities/Resultado");
const Ejercicio = require("../../../domain/entities/Ejercicio");

/*
   Obj, [Obj] -> ____|________________
                | rowToDomain() | -> Resultado | null
                 --------------
      Maps a resultados row plus its error-entry list into a Resultado
      entity, translating the Spanish columns. Null when no row.
*/
function rowToDomain(row, errors) {
  if (!row) return null;
  return new Resultado({
    id: row.id,
    userId: row.usuario_id,
    exerciseId: row.ejercicio_id,
    interactionId: row.interaccion_id,
    messageCount: row.num_mensajes || 0,
    solvedOnFirstAttempt: row.resuelto_a_la_primera || false,
    aiAnalysis: row.analisis_ia || null,
    aiAdvice: row.consejo_ia || null,
    date: row.fecha,
    errors: errors || [],
  });
}

/*------------------------------------------------------------------------------
            _________________________________________________________
            |                  PGRESULTADOREPOSITORY                |
            |  Repository adapter implementing IResultadoRepository  |
            |  on top of PostgreSQL. Persists exercise results and   |
            |  their child error entries, mapping the Spanish        |
            |  columns to the domain shape.                          |
            |                                                       |
        ____|________________                                       |
   Pool -> | constructor() | -> PgResultadoRepository (writes attrs)|
           -----------------                                        |
            |   pool: Pool (injected pg pool)                       |
        ____|________                                              |
   Obj -> | create() | -> Promise<Resultado>          (reads attrs) |
          ----------                                                |
        ____|______________                                        |
   Txt -> | findByUserId() | -> Promise<[Resultado]>  (reads attrs) |
          --------------                                            |
        ____|__________________________                            |
   Txt -> | findByUserIdWithExercise() | -> Promise<[{resultado,ejercicio}]> (reads attrs)|
          --------------------------                                |
        ____|___________________________                           |
   Txt -> | findCompletedExerciseIds() | -> Promise<[Txt]> (reads attrs)|
          --------------------------                                |
        ____|________________                                      |
   Obj -> | findByFilter() | -> Promise<[Resultado]>  (reads attrs) |
          --------------                                            |
        ____|_______________________                               |
   Txt -> | getErrorTagsByUserId() | -> Promise<[Txt]> (reads attrs)|
          ----------------------                                    |
            |                                                       |
            |_______________________________________________________|
------------------------------------------------------------------------------*/
class PgResultadoRepository extends IResultadoRepository {
  /*
   Pool -> ____|________________
          | constructor() | -> PgResultadoRepository    (writes attribute pool (Pool))
           -----------------
      Stores the injected pg connection pool.
  */
  constructor(pool) {
    super();
    this.pool = pool;
  }

  /*
   Obj -> ____|________
         | create() | -> Promise<Resultado>    (reads attribute pool (Pool))
          ----------
      Inserts a result and its error entries within a single transaction,
      returning the created entity.
  */
  async create(data) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");

      const { rows } = await client.query(
        `INSERT INTO resultados (usuario_id, ejercicio_id, interaccion_id, num_mensajes, resuelto_a_la_primera, analisis_ia, consejo_ia)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
        [
          data.userId,
          data.exerciseId,
          data.interactionId,
          data.messageCount || 0,
          data.solvedOnFirstAttempt || false,
          data.aiAnalysis || null,
          data.aiAdvice || null,
        ]
      );
      const resultado = rows[0];

      const errors = [];
      for (const err of data.errors || []) {
        const { rows: eRows } = await client.query(
          `INSERT INTO error_entries (resultado_id, etiqueta, texto)
           VALUES ($1, $2, $3) RETURNING *`,
          [resultado.id, err.label, err.text]
        );
        errors.push({ label: eRows[0].etiqueta, text: eRows[0].texto });
      }

      await client.query("COMMIT");
      return rowToDomain(resultado, errors);
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
  }

  /*
   Txt -> ____|______________
         | findByUserId() | -> Promise<[Resultado]>    (reads attribute pool (Pool))
          --------------
      Returns all results of a user with their aggregated error entries,
      newest first.
  */
  async findByUserId(userId) {
    const { rows } = await this.pool.query(
      `SELECT r.*, json_agg(json_build_object('label', ee.etiqueta, 'text', ee.texto))
         FILTER (WHERE ee.id IS NOT NULL) AS errores_arr
       FROM resultados r
       LEFT JOIN error_entries ee ON ee.resultado_id = r.id
       WHERE r.usuario_id = $1
       GROUP BY r.id
       ORDER BY r.fecha DESC`,
      [userId]
    );
    return rows.map((r) => rowToDomain(r, r.errores_arr || []));
  }

  /*
   Txt -> ____|__________________________
         | findByUserIdWithExercise() | -> Promise<[{resultado,ejercicio}]>    (reads attribute pool (Pool))
          --------------------------
      Returns each result of a user paired with a lightweight Ejercicio
      built from the joined exercise columns, newest first.
  */
  async findByUserIdWithExercise(userId) {
    const { rows } = await this.pool.query(
      `SELECT r.*,
              e.titulo AS ej_titulo, e.concepto AS ej_concepto, e.nivel AS ej_nivel, e.asignatura AS ej_asignatura,
              json_agg(json_build_object('label', ee.etiqueta, 'text', ee.texto))
                FILTER (WHERE ee.id IS NOT NULL) AS errores_arr
       FROM resultados r
       JOIN ejercicios e ON e.id = r.ejercicio_id
       LEFT JOIN error_entries ee ON ee.resultado_id = r.id
       WHERE r.usuario_id = $1
       GROUP BY r.id, e.id
       ORDER BY r.fecha DESC`,
      [userId]
    );
    return rows.map((r) => ({
      resultado: rowToDomain(r, r.errores_arr || []),
      ejercicio: new Ejercicio({
        id: r.ejercicio_id,
        title: r.ej_titulo,
        statement: "",
        subject: r.ej_asignatura || "",
        concept: r.ej_concepto || "",
        level: r.ej_nivel || 0,
      }),
    }));
  }

  /*
   Txt -> ____|___________________________
         | findCompletedExerciseIds() | -> Promise<[Txt]>    (reads attribute pool (Pool))
          --------------------------
      Returns the distinct ids of exercises the user has results for.
  */
  async findCompletedExerciseIds(userId) {
    const { rows } = await this.pool.query(
      "SELECT DISTINCT ejercicio_id FROM resultados WHERE usuario_id = $1",
      [userId]
    );
    return rows.map((r) => r.ejercicio_id);
  }

  /*
   Obj -> ____|________________
         | findByFilter() | -> Promise<[Resultado]>    (reads attribute pool (Pool))
          --------------
      Returns results matching an optional filter (userId, exerciseId,
      from/to date range), with aggregated error entries, newest first.
  */
  async findByFilter(filter) {
    const conditions = [];
    const vals = [];
    let idx = 1;

    if (filter.userId) {
      conditions.push(`r.usuario_id = $${idx++}`);
      vals.push(filter.userId);
    }
    if (filter.exerciseId) {
      conditions.push(`r.ejercicio_id = $${idx++}`);
      vals.push(filter.exerciseId);
    }
    if (filter.from instanceof Date && !isNaN(filter.from.getTime())) {
      conditions.push(`r.fecha >= $${idx++}`);
      vals.push(filter.from);
    }
    if (filter.to instanceof Date && !isNaN(filter.to.getTime())) {
      conditions.push(`r.fecha <= $${idx++}`);
      vals.push(filter.to);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const { rows } = await this.pool.query(
      `SELECT r.*, json_agg(json_build_object('label', ee.etiqueta, 'text', ee.texto))
         FILTER (WHERE ee.id IS NOT NULL) AS errores_arr
       FROM resultados r
       LEFT JOIN error_entries ee ON ee.resultado_id = r.id
       ${where}
       GROUP BY r.id
       ORDER BY r.fecha DESC`,
      vals
    );
    return rows.map((r) => rowToDomain(r, r.errores_arr || []));
  }

  /*
   Txt -> ____|_______________________
         | getErrorTagsByUserId() | -> Promise<[Txt]>    (reads attribute pool (Pool))
          ----------------------
      Returns the distinct error labels recorded across the user's results.
  */
  async getErrorTagsByUserId(userId) {
    const { rows } = await this.pool.query(
      `SELECT DISTINCT ee.etiqueta AS label
       FROM error_entries ee
       JOIN resultados r ON r.id = ee.resultado_id
       WHERE r.usuario_id = $1`,
      [userId]
    );
    return rows.map((r) => r.label);
  }
}

module.exports = PgResultadoRepository;
