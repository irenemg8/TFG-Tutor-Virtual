-- Migration 004: Create messages table
-- KEY MIGRATION: replaces embedded conversacion[] array in MongoDB Interaccion
-- Each element of the array becomes a row in this table

CREATE TABLE IF NOT EXISTS messages (
    id                  VARCHAR(50) PRIMARY KEY DEFAULT gen_random_uuid()::text,
    interaccion_id      VARCHAR(50) NOT NULL REFERENCES interacciones(id) ON DELETE CASCADE,
    sequence_num        INTEGER NOT NULL,
    role                VARCHAR(20) NOT NULL CHECK (role IN ('user', 'assistant')),
    content             TEXT NOT NULL,
    timestamp           TIMESTAMPTZ DEFAULT NOW(),

    -- Metadata (only populated on assistant messages, from RAG pipeline)
    classification      VARCHAR(50),
    decision            VARCHAR(50),
    is_correct_answer   BOOLEAN,
    sources_count       INTEGER DEFAULT 0,
    student_response_ms INTEGER,

    -- Guardrails (flattened from nested object)
    guardrail_solution_leak          BOOLEAN DEFAULT FALSE,
    guardrail_false_confirmation     BOOLEAN DEFAULT FALSE,
    guardrail_premature_confirmation BOOLEAN DEFAULT FALSE,
    guardrail_state_reveal           BOOLEAN DEFAULT FALSE,

    -- Timing (flattened from nested object)
    timing_pipeline_ms  INTEGER,
    timing_ollama_ms    INTEGER,
    timing_total_ms     INTEGER,

    UNIQUE(interaccion_id, sequence_num)
);

CREATE INDEX IF NOT EXISTS idx_messages_interaccion ON messages(interaccion_id);
CREATE INDEX IF NOT EXISTS idx_messages_interaccion_seq_desc
    ON messages(interaccion_id, sequence_num DESC);
