"use strict";

const { Pool } = require("pg");

/*------------------------------------------------------------------------------
            _________________________________________________________
            |                       PGCONNECTION                    |
            |  Module that manages a single PostgreSQL connection    |
            |  pool per process (singleton) and runs the migration   |
            |  SQL files in order.                                   |
            |                                                       |
            |   Txt -> | createPool() | -> Pool                     |
            |          | getPool() | -> Pool                        |
            |          | closePool() | -> Promise<void>             |
            |   Pool -> | runMigrations() | -> Promise<void>        |
            |                                                       |
            |_______________________________________________________|
------------------------------------------------------------------------------*/

let pool = null;

/*
   Txt -> ____|______________
         | createPool() | -> Pool    (reads/writes module pool (Pool))
          -------------
      Creates the singleton pool from the connection string, or returns the
      existing one. Registers an error handler on the pool.
*/
function createPool(connectionString) {
  if (pool) return pool;
  pool = new Pool({
    connectionString,
    max: 20,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
  });

  pool.on("error", (err) => {
    console.error("[PG] Unexpected pool error:", err.message);
  });

  return pool;
}

/*
       ____|___________
      | getPool() | -> Pool    (reads module pool (Pool))
       ----------
      Returns the singleton pool, throwing when it has not been created yet.
*/
function getPool() {
  if (!pool) throw new Error("[PG] Pool not initialized. Call createPool() first.");
  return pool;
}

/*
       ____|_____________
      | closePool() | -> Promise<void>    (reads/writes module pool (Pool))
       ------------
      Ends the pool and clears the singleton, if one exists.
*/
async function closePool() {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

/*
   Pool -> ____|_________________
          | runMigrations() | -> Promise<void>
           ----------------
      Runs every .sql file in the migrations directory, in name order,
      against the given pool.
*/
async function runMigrations(pgPool) {
  const fs = require("fs");
  const path = require("path");
  const dir = path.join(__dirname, "migrations");
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();

  for (const file of files) {
    const sql = fs.readFileSync(path.join(dir, file), "utf8");
    console.log(`[PG] Running migration: ${file}`);
    await pgPool.query(sql);
  }
  console.log(`[PG] All ${files.length} migrations completed.`);
}

module.exports = { createPool, getPool, closePool, runMigrations };
