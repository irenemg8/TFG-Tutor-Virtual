"use strict";

const config = require("./environment");

/*------------------------------------------------------------------------------
            _________________________________________________________
            |                        DATABASE                       |
            |  Database connection helper (PostgreSQL only). The     |
            |  MongoDB connection was removed in the 2026-04-21      |
            |  migration; PostgreSQL pools are managed by the        |
            |  container via PgConnection.js. This module remains    |
            |  for callers that expect connectDatabase() or          |
            |  connectPostgreSQL().                                  |
        ____|___________________                                     |
        | connectPostgreSQL() | -> Promise<Pool>                     |
          ---------------------                                      |
        ____|_________________                                       |
        | connectDatabase() | -> Promise<Obj>                        |
          -------------------                                        |
            |                                                       |
            |_______________________________________________________|
------------------------------------------------------------------------------*/

/*
       ____|___________________
      | connectPostgreSQL() | -> Promise<Pool>
       ---------------------
      Opens a pg Pool from the configured connection string and
      verifies it with a trivial query before returning it.
*/
async function connectPostgreSQL() {
  const { Pool } = require("pg");
  const pool = new Pool({ connectionString: config.PG_CONNECTION_STRING });
  await pool.query("SELECT 1");
  console.log("[DB] Connected to PostgreSQL");
  return pool;
}

/*
       ____|_________________
      | connectDatabase() | -> Promise<Obj>
       -------------------
      Returns { type, pool } describing the active connection, always
      PostgreSQL after the migration.
*/
async function connectDatabase() {
  return { type: "postgresql", pool: await connectPostgreSQL() };
}

module.exports = { connectPostgreSQL, connectDatabase };
