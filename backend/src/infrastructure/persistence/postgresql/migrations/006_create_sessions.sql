-- Migration 006: Create sessions table
-- Replaces connect-mongo session store with connect-pg-simple

CREATE TABLE IF NOT EXISTS sessions (
    sid     VARCHAR NOT NULL PRIMARY KEY,
    sess    JSONB NOT NULL,
    expire  TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sessions_expire ON sessions(expire);
