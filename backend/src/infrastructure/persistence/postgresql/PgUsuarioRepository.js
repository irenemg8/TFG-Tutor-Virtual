"use strict";

const IUsuarioRepository = require("../../../domain/ports/repositories/IUsuarioRepository");
const Usuario = require("../../../domain/entities/Usuario");

/*
   Obj -> ____|________________
         | rowToDomain() | -> Usuario | null
          --------------
      Maps a usuarios row (Spanish columns) into a Usuario entity, or null
      when the row is missing.
*/
function rowToDomain(row) {
  if (!row) return null;
  return new Usuario({
    id: row.id,
    upvLogin: row.upv_login,
    email: row.email || "",
    firstName: row.nombre || "",
    lastName: row.apellidos || "",
    nationalId: row.dni || "",
    groups: row.grupos || [],
    role: row.rol || "alumno",
    lastLoginAt: row.last_login_at || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

/*------------------------------------------------------------------------------
            _________________________________________________________
            |                   PGUSUARIOREPOSITORY                 |
            |  Repository adapter implementing IUsuarioRepository on |
            |  top of PostgreSQL. Persists and reads users, mapping  |
            |  domain fields to the Spanish usuarios columns.        |
            |                                                       |
        ____|________________                                       |
   Pool -> | constructor() | -> PgUsuarioRepository  (writes attrs) |
           -----------------                                        |
            |   pool: Pool (injected pg pool)                       |
        ____|__________                                             |
   Txt -> | findById() | -> Promise<Usuario|null>     (reads attrs) |
          ------------                                              |
        ____|________________                                       |
   Txt -> | findByUpvLogin() | -> Promise<Usuario|null> (reads attrs)|
          ------------------                                        |
        ____|____________________                                   |
   Txt,Obj,Obj -> | upsertByUpvLogin() | -> Promise<Usuario> (reads attrs)|
                  ------------------                                |
        ____|________                                              |
   Obj -> | create() | -> Promise<Usuario>            (reads attrs) |
          ----------                                                |
        ____|____________                                          |
   Txt,Obj -> | updateById() | -> Promise<Usuario>    (reads attrs) |
              ------------                                          |
        ____|_________                                             |
        | findAll() | -> Promise<[Usuario]>           (reads attrs) |
        -----------                                                 |
        ____|__________                                            |
   [Txt] -> | findByIds() | -> Promise<[Usuario]>     (reads attrs) |
            ------------                                            |
            |                                                       |
            |_______________________________________________________|
------------------------------------------------------------------------------*/
class PgUsuarioRepository extends IUsuarioRepository {
  /*
   Pool -> ____|________________
          | constructor() | -> PgUsuarioRepository    (writes attribute pool (Pool))
           -----------------
      Stores the injected pg connection pool.
  */
  constructor(pool) {
    super();
    this.pool = pool;
  }

  /*
   Txt -> ____|__________
         | findById() | -> Promise<Usuario|null>    (reads attribute pool (Pool))
          ------------
      Fetches a user by primary key.
  */
  async findById(id) {
    const { rows } = await this.pool.query(
      "SELECT * FROM usuarios WHERE id = $1",
      [id]
    );
    return rowToDomain(rows[0]);
  }

  /*
   Txt -> ____|________________
         | findByUpvLogin() | -> Promise<Usuario|null>    (reads attribute pool (Pool))
          ------------------
      Fetches a user by their UPV login.
  */
  async findByUpvLogin(upvLogin) {
    const { rows } = await this.pool.query(
      "SELECT * FROM usuarios WHERE upv_login = $1",
      [upvLogin]
    );
    return rowToDomain(rows[0]);
  }

  /*
   Txt, Obj, Obj -> ____|____________________
                   | upsertByUpvLogin() | -> Promise<Usuario>    (reads attribute pool (Pool))
                    ------------------
      Inserts a user or updates the existing one on UPV-login conflict.
      Explicit ::text/::text[] casts let PostgreSQL deduce types when the
      same $N is reused in the COALESCE UPDATE branch (avoids error 42P08).
  */
  async upsertByUpvLogin(upvLogin, updateFields, insertFields) {
    const { rows } = await this.pool.query(
      `INSERT INTO usuarios (upv_login, email, nombre, apellidos, dni, grupos, rol)
       VALUES ($1::text, $2::text, $3::text, $4::text, $5::text, $6::text[], $7::text)
       ON CONFLICT (upv_login) DO UPDATE SET
         email = COALESCE($2::text, usuarios.email),
         nombre = COALESCE($3::text, usuarios.nombre),
         apellidos = COALESCE($4::text, usuarios.apellidos),
         dni = COALESCE($5::text, usuarios.dni),
         updated_at = NOW()
       RETURNING *`,
      [
        upvLogin,
        updateFields.email || null,
        updateFields.firstName || null,
        updateFields.lastName || null,
        updateFields.nationalId || null,
        insertFields?.groups || [],
        insertFields?.role || "alumno",
      ]
    );
    return rowToDomain(rows[0]);
  }

  /*
   Obj -> ____|________
         | create() | -> Promise<Usuario>    (reads attribute pool (Pool))
          ----------
      Inserts a new user from the given data and returns the created entity.
  */
  async create(userData) {
    const { rows } = await this.pool.query(
      `INSERT INTO usuarios (upv_login, email, nombre, apellidos, dni, grupos, rol)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [
        userData.upvLogin,
        userData.email || null,
        userData.firstName || null,
        userData.lastName || null,
        userData.nationalId || null,
        userData.groups || [],
        userData.role || "alumno",
      ]
    );
    return rowToDomain(rows[0]);
  }

  /*
   Txt, Obj -> ____|____________
              | updateById() | -> Promise<Usuario>    (reads attribute pool (Pool))
               ------------
      Updates the mapped columns for the given user id, bumps updated_at,
      and returns the refreshed entity.
  */
  async updateById(id, fields) {
    const sets = [];
    const vals = [];
    let idx = 1;
    const COLUMN_MAP = {
      lastLoginAt: "last_login_at",
      upvLogin: "upv_login",
      firstName: "nombre",
      lastName: "apellidos",
      nationalId: "dni",
      groups: "grupos",
      role: "rol",
    };
    for (const [key, val] of Object.entries(fields)) {
      const col = COLUMN_MAP[key] || key;
      sets.push(`${col} = $${idx}`);
      vals.push(val);
      idx++;
    }
    sets.push(`updated_at = NOW()`);
    vals.push(id);

    const { rows } = await this.pool.query(
      `UPDATE usuarios SET ${sets.join(", ")} WHERE id = $${idx} RETURNING *`,
      vals
    );
    return rowToDomain(rows[0]);
  }

  /*
       ____|_________
      | findAll() | -> Promise<[Usuario]>    (reads attribute pool (Pool))
       -----------
      Returns every user, ordered by creation date.
  */
  async findAll() {
    const { rows } = await this.pool.query("SELECT * FROM usuarios ORDER BY created_at");
    return rows.map(rowToDomain);
  }

  /*
   [Txt] -> ____|____________
           | findByIds() | -> Promise<[Usuario]>    (reads attribute pool (Pool))
            ------------
      Returns the users whose ids are in the given list ([] when empty).
  */
  async findByIds(ids) {
    if (!ids.length) return [];
    const { rows } = await this.pool.query(
      "SELECT * FROM usuarios WHERE id = ANY($1::text[])",
      [ids]
    );
    return rows.map(rowToDomain);
  }
}

module.exports = PgUsuarioRepository;
