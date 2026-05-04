"use strict";

const IResultadoRepository = require("../../../domain/ports/repositories/IResultadoRepository");
const Resultado = require("../../../domain/entities/Resultado");
const Ejercicio = require("../../../domain/entities/Ejercicio");

function rowToDomain(row, errores) {
  if (!row) return null;
  return new Resultado({
    id: row.id,
    usuarioId: row.usuario_id,
    ejercicioId: row.ejercicio_id,
    interaccionId: row.interaccion_id,
    numMensajes: row.num_mensajes || 0,
    resueltoALaPrimera: row.resuelto_a_la_primera || false,
    analisisIA: row.analisis_ia || null,
    consejoIA: row.consejo_ia || null,
    fecha: row.fecha,
    errores: errores || [],
  });
}

class PgResultadoRepository extends IResultadoRepository {
  constructor(pool) {
    super();
    this.pool = pool;
  }

  async create(data) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");

      const { rows } = await client.query(
        `INSERT INTO resultados (usuario_id, ejercicio_id, interaccion_id, num_mensajes, resuelto_a_la_primera, analisis_ia, consejo_ia)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
        [
          data.usuarioId,
          data.ejercicioId,
          data.interaccionId,
          data.numMensajes || 0,
          data.resueltoALaPrimera || false,
          data.analisisIA || null,
          data.consejoIA || null,
        ]
      );
      const resultado = rows[0];

      const errores = [];
      for (const err of data.errores || []) {
        const { rows: eRows } = await client.query(
          `INSERT INTO error_entries (resultado_id, etiqueta, texto)
           VALUES ($1, $2, $3) RETURNING *`,
          [resultado.id, err.etiqueta, err.texto]
        );
        errores.push({ etiqueta: eRows[0].etiqueta, texto: eRows[0].texto });
      }

      await client.query("COMMIT");
      return rowToDomain(resultado, errores);
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
  }

  async findByUserId(userId) {
    const { rows } = await this.pool.query(
      `SELECT r.*, json_agg(json_build_object('etiqueta', ee.etiqueta, 'texto', ee.texto))
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

  async findByUserIdWithExercise(userId) {
    const { rows } = await this.pool.query(
      `SELECT r.*,
              e.titulo AS ej_titulo, e.concepto AS ej_concepto, e.nivel AS ej_nivel, e.asignatura AS ej_asignatura,
              json_agg(json_build_object('etiqueta', ee.etiqueta, 'texto', ee.texto))
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
        titulo: r.ej_titulo,
        enunciado: "",
        asignatura: r.ej_asignatura || "",
        concepto: r.ej_concepto || "",
        nivel: r.ej_nivel || 0,
      }),
    }));
  }

  async findCompletedExerciseIds(userId) {
    const { rows } = await this.pool.query(
      "SELECT DISTINCT ejercicio_id FROM resultados WHERE usuario_id = $1",
      [userId]
    );
    return rows.map((r) => r.ejercicio_id);
  }

  async findByFilter(filter) {
    const conditions = [];
    const vals = [];
    let idx = 1;

    if (filter.userId) {
      conditions.push(`r.usuario_id = $${idx++}`);
      vals.push(filter.userId);
    }
    if (filter.ejercicioId) {
      conditions.push(`r.ejercicio_id = $${idx++}`);
      vals.push(filter.ejercicioId);
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
      `SELECT r.*, json_agg(json_build_object('etiqueta', ee.etiqueta, 'texto', ee.texto))
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

  async getErrorTagsByUserId(userId) {
    const { rows } = await this.pool.query(
      `SELECT DISTINCT ee.etiqueta
       FROM error_entries ee
       JOIN resultados r ON r.id = ee.resultado_id
       WHERE r.usuario_id = $1`,
      [userId]
    );
    return rows.map((r) => r.etiqueta);
  }
}

module.exports = PgResultadoRepository;
