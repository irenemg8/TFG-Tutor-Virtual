-- Migration 002: Create ejercicios and tutor_contexts tables
-- Replaces MongoDB Ejercicio model (embedded tutorContext → separate table)

CREATE TABLE IF NOT EXISTS ejercicios (
    id          VARCHAR(50) PRIMARY KEY DEFAULT gen_random_uuid()::text,
    titulo      VARCHAR(500) NOT NULL,
    enunciado   TEXT NOT NULL,
    imagen      VARCHAR(1000) DEFAULT '',
    asignatura  VARCHAR(255) NOT NULL,
    concepto    VARCHAR(255) NOT NULL,
    nivel       INTEGER NOT NULL,
    ca          TEXT DEFAULT '',
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ejercicios_concepto ON ejercicios(concepto);
CREATE INDEX IF NOT EXISTS idx_ejercicios_asignatura ON ejercicios(asignatura);
CREATE INDEX IF NOT EXISTS idx_ejercicios_nivel ON ejercicios(nivel);

-- TutorContext: 1:1 with ejercicios (was embedded sub-document)
CREATE TABLE IF NOT EXISTS tutor_contexts (
    id                   VARCHAR(50) PRIMARY KEY DEFAULT gen_random_uuid()::text,
    ejercicio_id         VARCHAR(50) NOT NULL UNIQUE REFERENCES ejercicios(id) ON DELETE CASCADE,
    objetivo             TEXT DEFAULT '',
    netlist              TEXT DEFAULT '',
    modo_experto         TEXT DEFAULT '',
    ac_refs              TEXT[] DEFAULT '{}',
    respuesta_correcta   TEXT[] DEFAULT '{}',
    elementos_evaluables TEXT[] DEFAULT '{}',
    version              INTEGER DEFAULT 1,
    created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
