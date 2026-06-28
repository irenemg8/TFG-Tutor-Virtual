"use strict";

const IInteraccionRepository = require("../../../domain/ports/repositories/IInteraccionRepository");
const Interaccion = require("../../../domain/entities/Interaccion");

/*
   Obj -> ____|________________
         | rowToDomain() | -> Interaccion | null
          --------------
      Maps an interacciones row into an Interaccion entity, or null when
      the row is missing.
*/
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

/*------------------------------------------------------------------------------
            _________________________________________________________
            |                 PGINTERACCIONREPOSITORY               |
            |  Repository adapter implementing IInteraccionRepository|
            |  on top of PostgreSQL. Tracks tutoring interactions    |
            |  (one per user/exercise session) and their time span.  |
            |                                                       |
        ____|________________                                       |
   Pool -> | constructor() | -> PgInteraccionRepository (writes attrs)|
           -----------------                                        |
            |   pool: Pool (injected pg pool)                       |
        ____|__________                                             |
   Txt -> | findById() | -> Promise<Interaccion|null>  (reads attrs)|
          ------------                                              |
        ____|________                                              |
   Obj -> | create() | -> Promise<Interaccion>          (reads attrs)|
          ----------                                                |
        ____|______________                                        |
   Txt -> | deleteById() | -> Promise<void>             (reads attrs)|
          --------------                                            |
        ____|________                                              |
   Txt -> | exists() | -> Promise<T/F>                  (reads attrs)|
          ----------                                                |
        ____|_______________                                       |
   Txt,Txt -> | existsForUser() | -> Promise<T/F>       (reads attrs)|
              ---------------                                       |
        ____|_______________                                       |
   Txt,Date -> | updateEndTime() | -> Promise<void>     (reads attrs)|
               ---------------                                      |
        ____|_______________                                       |
   Txt -> | findByUserId() | -> Promise<[Interaccion]>  (reads attrs)|
          --------------                                            |
        ____|______________________________                        |
   Txt,Txt -> | findLatestByExerciseAndUser() | -> Promise<Interaccion|null> (reads attrs)|
              -----------------------------                        |
        ____|______________                                        |
   Z -> | findRecent() | -> Promise<[Interaccion]>      (reads attrs)|
        --------------                                              |
        ____|________________                                      |
   Obj -> | findByFilter() | -> Promise<[Interaccion]>  (reads attrs)|
          --------------                                            |
            |                                                       |
            |_______________________________________________________|
------------------------------------------------------------------------------*/
class PgInteraccionRepository extends IInteraccionRepository {
  /*
   Pool -> ____|________________
          | constructor() | -> PgInteraccionRepository    (writes attribute pool (Pool))
           -----------------
      Stores the injected pg connection pool.
  */
  constructor(pool) {
    super();
    this.pool = pool;
  }

  /*
   Txt -> ____|__________
         | findById() | -> Promise<Interaccion|null>    (reads attribute pool (Pool))
          ------------
      Fetches an interaction by primary key.
  */
  async findById(id) {
    const { rows } = await this.pool.query(
      "SELECT * FROM interacciones WHERE id = $1",
      [id]
    );
    return rowToDomain(rows[0]);
  }

  /*
   Obj -> ____|________
         | create() | -> Promise<Interaccion>    (reads attribute pool (Pool))
          ----------
      Inserts a new interaction for a user/exercise, stamping inicio and fin
      with NOW(), and returns the created entity.
  */
  async create(data) {
    const { rows } = await this.pool.query(
      `INSERT INTO interacciones (usuario_id, ejercicio_id, inicio, fin)
       VALUES ($1, $2, NOW(), NOW()) RETURNING *`,
      [data.userId, data.exerciseId]
    );
    return rowToDomain(rows[0]);
  }

  /*
   Txt -> ____|______________
         | deleteById() | -> Promise<void>    (reads attribute pool (Pool))
          --------------
      Deletes the interaction with the given id.
  */
  async deleteById(id) {
    await this.pool.query("DELETE FROM interacciones WHERE id = $1", [id]);
  }

  /*
   Txt -> ____|________
         | exists() | -> Promise<T/F>    (reads attribute pool (Pool))
          ----------
      True when an interaction with the given id exists.
  */
  async exists(id) {
    const { rows } = await this.pool.query(
      "SELECT 1 FROM interacciones WHERE id = $1 LIMIT 1",
      [id]
    );
    return rows.length > 0;
  }

  /*
   Txt, Txt -> ____|_______________
              | existsForUser() | -> Promise<T/F>    (reads attribute pool (Pool))
               ---------------
      True when the interaction belongs to the given user (ownership check).
  */
  async existsForUser(id, userId) {
    const { rows } = await this.pool.query(
      "SELECT 1 FROM interacciones WHERE id = $1 AND usuario_id = $2 LIMIT 1",
      [id, userId]
    );
    return rows.length > 0;
  }

  /*
   Txt, Date -> ____|_______________
               | updateEndTime() | -> Promise<void>    (reads attribute pool (Pool))
                ---------------
      Sets the fin (end) timestamp of the interaction.
  */
  async updateEndTime(id, endTime) {
    await this.pool.query(
      "UPDATE interacciones SET fin = $2 WHERE id = $1",
      [id, endTime]
    );
  }

  /*
   Txt -> ____|______________
         | findByUserId() | -> Promise<[Interaccion]>    (reads attribute pool (Pool))
          --------------
      Returns all interactions of a user, newest fin first.
  */
  async findByUserId(userId) {
    const { rows } = await this.pool.query(
      "SELECT * FROM interacciones WHERE usuario_id = $1 ORDER BY fin DESC",
      [userId]
    );
    return rows.map(rowToDomain);
  }

  /*
   Txt, Txt -> ____|______________________________
              | findLatestByExerciseAndUser() | -> Promise<Interaccion|null>    (reads attribute pool (Pool))
               -----------------------------
      Returns the most recent interaction for a given exercise and user.
  */
  async findLatestByExerciseAndUser(exerciseId, userId) {
    const { rows } = await this.pool.query(
      `SELECT * FROM interacciones
       WHERE ejercicio_id = $1 AND usuario_id = $2
       ORDER BY fin DESC LIMIT 1`,
      [exerciseId, userId]
    );
    return rowToDomain(rows[0]);
  }

  /*
   Z -> ____|______________
       | findRecent() | -> Promise<[Interaccion]>    (reads attribute pool (Pool))
        --------------
      Returns the most recent interactions, up to limit (default 50).
  */
  async findRecent(limit = 50) {
    const { rows } = await this.pool.query(
      "SELECT * FROM interacciones ORDER BY fin DESC LIMIT $1",
      [limit]
    );
    return rows.map(rowToDomain);
  }

  /*
   Obj -> ____|________________
         | findByFilter() | -> Promise<[Interaccion]>    (reads attribute pool (Pool))
          --------------
      Returns interactions matching an optional filter (userId, exerciseId,
      from/to date range), newest inicio first.
  */
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
