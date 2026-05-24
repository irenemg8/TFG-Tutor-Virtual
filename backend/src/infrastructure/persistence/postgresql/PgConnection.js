"use strict";

const { Pool } = require("pg");

let pool = null;

/**
 * PostgreSQL connection pool manager.
 * Singleton pattern — one pool per process.
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

function getPool() {
  if (!pool) throw new Error("[PG] Pool not initialized. Call createPool() first.");
  return pool;
}

async function closePool() {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

/**
 * Run all migration SQL files in order.
 * @param {Pool} pgPool
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
