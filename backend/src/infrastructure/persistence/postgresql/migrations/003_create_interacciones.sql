-- Migration 003: Create interacciones table
-- Replaces MongoDB Interaccion model (without embedded conversacion[] array)

CREATE TABLE IF NOT EXISTS interacciones (
    id           VARCHAR(50) PRIMARY KEY DEFAULT gen_random_uuid()::text,
    usuario_id   VARCHAR(50) NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
    ejercicio_id VARCHAR(50) NOT NULL REFERENCES ejercicios(id) ON DELETE CASCADE,
    inicio       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    fin          TIMESTAMPTZ DEFAULT NOW(),
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_interacciones_usuario ON interacciones(usuario_id);
CREATE INDEX IF NOT EXISTS idx_interacciones_ejercicio ON interacciones(ejercicio_id);
CREATE INDEX IF NOT EXISTS idx_interacciones_usuario_ejercicio ON interacciones(usuario_id, ejercicio_id);
CREATE INDEX IF NOT EXISTS idx_interacciones_fin ON interacciones(fin DESC);
