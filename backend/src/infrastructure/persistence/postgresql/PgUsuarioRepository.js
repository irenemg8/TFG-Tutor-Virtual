"use strict";

const IUsuarioRepository = require("../../../domain/ports/repositories/IUsuarioRepository");
const Usuario = require("../../../domain/entities/Usuario");

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

class PgUsuarioRepository extends IUsuarioRepository {
  constructor(pool) {
    super();
    this.pool = pool;
  }

  async findById(id) {
    const { rows } = await this.pool.query(
      "SELECT * FROM usuarios WHERE id = $1",
      [id]
    );
    return rowToDomain(rows[0]);
  }

  async findByUpvLogin(upvLogin) {
    const { rows } = await this.pool.query(
      "SELECT * FROM usuarios WHERE upv_login = $1",
      [upvLogin]
    );
    return rowToDomain(rows[0]);
  }

  async upsertByUpvLogin(upvLogin, updateFields, insertFields) {
    // Cast explícito (::text/text[]) en el INSERT para que cuando los mismos
    // $N se usen en el UPDATE dentro de COALESCE, PostgreSQL pueda deducir
    // los tipos. Sin esto, queries con $N reutilizado dan error 42P08
    // "inconsistent types deduced for parameter".
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

  async findAll() {
    const { rows } = await this.pool.query("SELECT * FROM usuarios ORDER BY created_at");
    return rows.map(rowToDomain);
  }

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
