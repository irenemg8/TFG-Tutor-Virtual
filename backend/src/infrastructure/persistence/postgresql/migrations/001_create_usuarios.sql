-- Migration 001: Create usuarios table
-- Replaces MongoDB Usuario model.
-- id is VARCHAR(50) (not UUID) so we can store either MongoDB ObjectIds
-- (24 hex chars, for data migrated from Atlas) or new UUIDs (36 chars).
-- The default still auto-generates UUIDs for brand-new users.

CREATE TABLE IF NOT EXISTS usuarios (
    id              VARCHAR(50) PRIMARY KEY DEFAULT gen_random_uuid()::text,
    upv_login       VARCHAR(100) NOT NULL UNIQUE,
    loguin_usuario  VARCHAR(100),
    email           VARCHAR(255),
    nombre          VARCHAR(255),
    apellidos       VARCHAR(255),
    dni             VARCHAR(20),
    grupos          TEXT[] DEFAULT '{}',
    rol             VARCHAR(50) NOT NULL DEFAULT 'alumno',
    last_login_at   TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_usuarios_upv_login ON usuarios(upv_login);
CREATE INDEX IF NOT EXISTS idx_usuarios_rol ON usuarios(rol);
