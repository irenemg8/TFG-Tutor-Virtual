-- Migration 005: Create resultados and error_entries tables
-- Replaces MongoDB Resultado model (embedded errores[] → separate table)

CREATE TABLE IF NOT EXISTS resultados (
    id                    VARCHAR(50) PRIMARY KEY DEFAULT gen_random_uuid()::text,
    usuario_id            VARCHAR(50) NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
    ejercicio_id          VARCHAR(50) NOT NULL REFERENCES ejercicios(id) ON DELETE CASCADE,
    interaccion_id        VARCHAR(50) NOT NULL REFERENCES interacciones(id) ON DELETE CASCADE,
    num_mensajes          INTEGER DEFAULT 0,
    resuelto_a_la_primera BOOLEAN DEFAULT FALSE,
    analisis_ia           TEXT,
    consejo_ia            TEXT,
    fecha                 TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_resultados_usuario ON resultados(usuario_id);
CREATE INDEX IF NOT EXISTS idx_resultados_ejercicio ON resultados(ejercicio_id);
CREATE INDEX IF NOT EXISTS idx_resultados_interaccion ON resultados(interaccion_id);
CREATE INDEX IF NOT EXISTS idx_resultados_usuario_fecha ON resultados(usuario_id, fecha DESC);

-- Error entries: replaces embedded errores[] array in Resultado
CREATE TABLE IF NOT EXISTS error_entries (
    id           VARCHAR(50) PRIMARY KEY DEFAULT gen_random_uuid()::text,
    resultado_id VARCHAR(50) NOT NULL REFERENCES resultados(id) ON DELETE CASCADE,
    etiqueta     VARCHAR(50) NOT NULL,
    texto        TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_error_entries_resultado ON error_entries(resultado_id);
CREATE INDEX IF NOT EXISTS idx_error_entries_etiqueta ON error_entries(etiqueta);
