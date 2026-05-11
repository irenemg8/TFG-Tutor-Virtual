"use strict";

const IInteraccionRepository = require("../../../domain/ports/repositories/IInteraccionRepository");
const Interaccion = require("../../../domain/entities/Interaccion");

function rowToDomain(row) {
  if (!row) return null;
  return new Interaccion({
    id: row.id,
    userId: row.usuario_id,
    exerciseId: row.ejercicio_id,
    startTime: row.inicio,
    endTime: row.fin,
    createdAt: row.created_at,
  });
}

class PgInteraccionRepository extends IInteraccionRepository {
  constructor(pool) {
    super();
    this.pool = pool;
  }

  async findById(id) {
    const { rows } = await this.pool.query(
      "SELECT * FROM interacciones WHERE id = $1",
      [id]
    );
    return rowToDomain(rows[0]);
  }

  async create(data) {
    const { rows } = await this.pool.query(
      `INSERT INTO interacciones (usuario_id, ejercicio_id, inicio, fin)
       VALUES ($1, $2, NOW(), NOW()) RETURNING *`,
      [data.userId, data.exerciseId]
    );
    return rowToDomain(rows[0]);
  }

  async deleteById(id) {
    await this.pool.query("DELETE FROM interacciones WHERE id = $1", [id]);
  }

  async exists(id) {
    const { rows } = await this.pool.query(
      "SELECT 1 FROM interacciones WHERE id = $1 LIMIT 1",
      [id]
    );
    return rows.length > 0;
  }

  async existsForUser(id, userId) {
    const { rows } = await this.pool.query(
      "SELECT 1 FROM interacciones WHERE id = $1 AND usuario_id = $2 LIMIT 1",
      [id, userId]
    );
    return rows.length > 0;
  }

  async updateEndTime(id, endTime) {
    await this.pool.query(
      "UPDATE interacciones SET fin = $2 WHERE id = $1",
      [id, endTime]
    );
  }

  async findByUserId(userId) {
    const { rows } = await this.pool.query(
      "SELECT * FROM interacciones WHERE usuario_id = $1 ORDER BY fin DESC",
      [userId]
    );
    return rows.map(rowToDomain);
  }

  async findLatestByExerciseAndUser(exerciseId, userId) {
    const { rows } = await this.pool.query(
      `SELECT * FROM interacciones
       WHERE ejercicio_id = $1 AND usuario_id = $2
       ORDER BY fin DESC LIMIT 1`,
      [exerciseId, userId]
    );
    return rowToDomain(rows[0]);
  }

  async findRecent(limit = 50) {
    const { rows } = await this.pool.query(
      "SELECT * FROM interacciones ORDER BY fin DESC LIMIT $1",
      [limit]
    );
    return rows.map(rowToDomain);
  }

  async findByFilter(filter) {
    const conditions = [];
    const vals = [];
    let idx = 1;

    if (filter.userId) {
      conditions.push(`usuario_id = $${idx++}`);
      vals.push(filter.userId);
    }
    if (filter.exerciseId) {
      conditions.push(`ejercicio_id = $${idx++}`);
      vals.push(filter.exerciseId);
    }
    if (filter.from instanceof Date && !isNaN(filter.from.getTime())) {
      conditions.push(`inicio >= $${idx++}`);
      vals.push(filter.from);
    }
    if (filter.to instanceof Date && !isNaN(filter.to.getTime())) {
      conditions.push(`inicio <= $${idx++}`);
      vals.push(filter.to);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const { rows } = await this.pool.query(
      `SELECT * FROM interacciones ${where} ORDER BY inicio DESC`,
      vals
    );
    return rows.map(rowToDomain);
  }
}

module.exports = PgInteraccionRepository;
