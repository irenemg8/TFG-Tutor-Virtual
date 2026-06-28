-- Migration 008: Add `extra_metadata` JSONB column to messages.
-- Purpose: capture per-turn signals introduced after the original schema
-- (004) without one migration per field. The orchestrator pipeline writes
-- the following keys when present:
--
--   firstTokenMs              streaming TTFT measured by tutorAgent
--   detectedACs               output of acDetectorAgent (per-turn AC verdict)
--   guardrails                full map of triggered guardrails — including
--                             the ones added on feat/ac-detection that don't
--                             have dedicated columns (languageDrift,
--                             completeSolution, adherence, repeatedQuestion,
--                             didacticExplanation, datasetStyle).
--   guardrailLlmRetries       number of consolidated LLM retries fired
--   guardrailSurgicalFixes    list of surgical fix ids that applied
--   guardrailPath             primary_ok | surgical_ok | llm_retry_ok | ...
--   fallbackUsed              true when the LLM call failed and we returned
--                             a localised canned message instead
--   deterministicFinish       true when the orchestrator short-circuited
--                             (greeting / off-topic / FIN canned response)
--
-- Reading: the export endpoints surface these as additional CSV/JSON
-- columns; older interactions (NULL/empty {}) just get blank cells.
-- Idempotent: safe to re-run.

ALTER TABLE messages ADD COLUMN IF NOT EXISTS extra_metadata JSONB DEFAULT '{}'::jsonb;

CREATE INDEX IF NOT EXISTS idx_messages_extra_metadata_gin
    ON messages USING GIN (extra_metadata);
