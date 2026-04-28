"use strict";

const config = require("./environment");

/**
 * Database connection helper (PostgreSQL only).
 *
 * The MongoDB connection was removed in the 2026-04-21 migration.
 * PostgreSQL connections are managed by the container via PgConnection.js;
 * this module remains for compatibility with any caller that expects
 * connectDatabase() or connectPostgreSQL().
 */

async function connectPostgreSQL() {
  const { Pool } = require("pg");
  const pool = new Pool({ connectionString: config.PG_CONNECTION_STRING });
  await pool.query("SELECT 1");
  console.log("[DB] Connected to PostgreSQL");
  return pool;
}

async function connectDatabase() {
  return { type: "postgresql", pool: await connectPostgreSQL() };
}

module.exports = { connectPostgreSQL, connectDatabase };
