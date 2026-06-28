-- Migration 007: Add `concepts` column to messages
-- Purpose: persist the rule-based concepts the classifier detected on each
-- assistant turn (e.g. ["divisor de tensión", "cortocircuito"]). These are
-- aggregated by the AcTrackerAgent across ALL of a user's interactions —
-- including ones that were abandoned without a final Resultado — so the
-- tutor can recognise recurring AC tendencies even when the LLM-based
-- closing classifier never ran.
-- Idempotent: safe to re-run.

ALTER TABLE messages ADD COLUMN IF NOT EXISTS concepts JSONB DEFAULT '[]'::jsonb;

CREATE INDEX IF NOT EXISTS idx_messages_concepts_gin ON messages USING GIN (concepts);
