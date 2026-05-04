"use strict";

const IMessageRepository = require("../../../domain/ports/repositories/IMessageRepository");
const Message = require("../../../domain/entities/Message");

function parseJsonbColumn(val, fallback) {
  if (val == null) return fallback;
  if (typeof val === "string") {
    try { return JSON.parse(val); } catch { return fallback; }
  }
  return val;
}

function rowToDomain(row) {
  if (!row) return null;
  // node-postgres parses JSONB automatically; the helper tolerates the
  // rare case where the driver hands us a raw string.
  const concepts = parseJsonbColumn(row.concepts, []);
  const extra = parseJsonbColumn(row.extra_metadata, {}) || {};

  const metadata = row.classification
    ? {
        classification: row.classification,
        decision: row.decision,
        isCorrectAnswer: row.is_correct_answer,
        sourcesCount: row.sources_count,
        studentResponseMs: row.student_response_ms,
        concepts: concepts,
        guardrails: {
          // Legacy four (DB columns):
          solutionLeak: row.guardrail_solution_leak,
          falseConfirmation: row.guardrail_false_confirmation,
          prematureConfirmation: row.guardrail_premature_confirmation,
          stateReveal: row.guardrail_state_reveal,
          // New (extra_metadata.guardrails):
          languageDrift: extra.guardrails?.languageDrift || false,
          completeSolution: extra.guardrails?.completeSolution || false,
          adherence: extra.guardrails?.adherence || false,
          repeatedQuestion: extra.guardrails?.repeatedQuestion || false,
          didacticExplanation: extra.guardrails?.didacticExplanation || false,
          datasetStyle: extra.guardrails?.datasetStyle || false,
          elementNaming: extra.guardrails?.elementNaming || false,
        },
        timing: {
          pipelineMs: row.timing_pipeline_ms,
          ollamaMs: row.timing_ollama_ms,
          totalMs: row.timing_total_ms,
          firstTokenMs: extra.firstTokenMs ?? null,
        },
        detectedACs: Array.isArray(extra.detectedACs) ? extra.detectedACs : [],
        guardrailPath: extra.guardrailPath || null,
        guardrailLlmRetries: extra.guardrailLlmRetries || 0,
        guardrailSurgicalFixes: Array.isArray(extra.guardrailSurgicalFixes)
          ? extra.guardrailSurgicalFixes
          : [],
        llmResponseOriginal: extra.llmResponseOriginal || null,
        guardrailSurgicalFixDetails: Array.isArray(extra.guardrailSurgicalFixDetails)
          ? extra.guardrailSurgicalFixDetails
          : [],
        fallbackUsed: extra.fallbackUsed || false,
        deterministicFinish: extra.deterministicFinish || false,
      }
    : null;

  return new Message({
    id: row.id,
    interaccionId: row.interaccion_id,
    sequenceNum: row.sequence_num,
    role: row.role,
    content: row.content,
    timestamp: row.timestamp,
    metadata,
  });
}

class PgMessageRepository extends IMessageRepository {
  constructor(pool) {
    super();
    this.pool = pool;
  }

  async appendMessage(interaccionId, message) {
    const meta = message.metadata;
    // Cast explícito $1::text para que PostgreSQL pueda deducir el tipo del
    // parámetro cuando se usa en dos sitios (columna interaccion_id + WHERE
    // del subselect). Sin el cast, PG da error 42P08 "inconsistent types".
    const conceptsJson = JSON.stringify(Array.isArray(meta?.concepts) ? meta.concepts : []);

    // Extra signals that don't have dedicated columns (migration 008).
    // Mirrors PersistenceAgent → MessageMetadata so the export CSV/JSON
    // can surface firstTokenMs, detectedACs, the new guardrails, and the
    // diagnostic counters.
    const extraMetadata = {
      firstTokenMs: meta?.timing?.firstTokenMs ?? null,
      detectedACs: Array.isArray(meta?.detectedACs) ? meta.detectedACs : [],
      guardrails: {
        languageDrift: meta?.guardrails?.languageDrift || false,
        completeSolution: meta?.guardrails?.completeSolution || false,
        adherence: meta?.guardrails?.adherence || false,
        repeatedQuestion: meta?.guardrails?.repeatedQuestion || false,
        didacticExplanation: meta?.guardrails?.didacticExplanation || false,
        datasetStyle: meta?.guardrails?.datasetStyle || false,
        elementNaming: meta?.guardrails?.elementNaming || false,
      },
      guardrailPath: meta?.guardrailPath || null,
      guardrailLlmRetries: meta?.guardrailLlmRetries || 0,
      guardrailSurgicalFixes: Array.isArray(meta?.guardrailSurgicalFixes)
        ? meta.guardrailSurgicalFixes
        : [],
      llmResponseOriginal: meta?.llmResponseOriginal || null,
      guardrailSurgicalFixDetails: Array.isArray(meta?.guardrailSurgicalFixDetails)
        ? meta.guardrailSurgicalFixDetails
        : [],
      fallbackUsed: meta?.fallbackUsed || false,
      deterministicFinish: meta?.deterministicFinish || false,
    };
    const extraMetadataJson = JSON.stringify(extraMetadata);

    await this.pool.query(
      `INSERT INTO messages (
        interaccion_id, sequence_num, role, content, timestamp,
        classification, decision, is_correct_answer, sources_count, student_response_ms,
        guardrail_solution_leak, guardrail_false_confirmation,
        guardrail_premature_confirmation, guardrail_state_reveal,
        timing_pipeline_ms, timing_ollama_ms, timing_total_ms,
        concepts, extra_metadata
      ) VALUES (
        $1::text,
        COALESCE((SELECT MAX(sequence_num) + 1 FROM messages WHERE interaccion_id = $1::text), 0),
        $2, $3, $4,
        $5, $6, $7, $8, $9,
        $10, $11, $12, $13,
        $14, $15, $16,
        $17::jsonb, $18::jsonb
      )`,
      [
        interaccionId,
        message.role,
        message.content,
        message.timestamp || new Date(),
        meta?.classification || null,
        meta?.decision || null,
        meta?.isCorrectAnswer ?? null,
        meta?.sourcesCount || 0,
        meta?.studentResponseMs || null,
        meta?.guardrails?.solutionLeak || false,
        meta?.guardrails?.falseConfirmation || false,
        meta?.guardrails?.prematureConfirmation || false,
        meta?.guardrails?.stateReveal || false,
        meta?.timing?.pipelineMs || null,
        meta?.timing?.ollamaMs || null,
        meta?.timing?.totalMs || null,
        conceptsJson,
        extraMetadataJson,
      ]
    );
    // Also update interacciones.fin
    await this.pool.query(
      "UPDATE interacciones SET fin = NOW() WHERE id = $1",
      [interaccionId]
    );
  }

  async getLastMessages(interaccionId, count) {
    const { rows } = await this.pool.query(
      `SELECT * FROM messages
       WHERE interaccion_id = $1
       ORDER BY sequence_num DESC
       LIMIT $2`,
      [interaccionId, count]
    );
    return rows.reverse().map(rowToDomain);
  }

  async getAllMessages(interaccionId) {
    const { rows } = await this.pool.query(
      `SELECT * FROM messages
       WHERE interaccion_id = $1
       ORDER BY sequence_num ASC`,
      [interaccionId]
    );
    return rows.map(rowToDomain);
  }

  async countConsecutiveFromEnd(interaccionId, classificationTypes) {
    const { rows } = await this.pool.query(
      `SELECT classification FROM messages
       WHERE interaccion_id = $1 AND role = 'assistant'
       ORDER BY sequence_num DESC`,
      [interaccionId]
    );
    let count = 0;
    for (const row of rows) {
      if (row.classification && classificationTypes.includes(row.classification)) {
        count++;
      } else {
        break;
      }
    }
    return count;
  }

  async countAssistantMessages(interaccionId) {
    const { rows } = await this.pool.query(
      `SELECT COUNT(*) AS cnt FROM messages
       WHERE interaccion_id = $1 AND role = 'assistant'`,
      [interaccionId]
    );
    return parseInt(rows[0].cnt, 10);
  }

  async getLastAssistantMessages(interaccionId, count) {
    const { rows } = await this.pool.query(
      `SELECT * FROM messages
       WHERE interaccion_id = $1 AND role = 'assistant'
       ORDER BY sequence_num DESC
       LIMIT $2`,
      [interaccionId, count]
    );
    return rows.reverse().map(rowToDomain);
  }

  async getLastMessage(interaccionId) {
    const { rows } = await this.pool.query(
      `SELECT * FROM messages
       WHERE interaccion_id = $1
       ORDER BY sequence_num DESC
       LIMIT 1`,
      [interaccionId]
    );
    return rowToDomain(rows[0]);
  }

  async getAcEvidenceByUserId(userId) {
    // Two aggregates in one round trip:
    //  1. concepts: every concept the classifier flagged on assistant turns,
    //     across every interaccion of the user, counted by frequency.
    //  2. classifications: how many times each assistant classification
    //     fired (e.g. wrong_concept, correct_wrong_reasoning, ...). Lets
    //     the AcTrackerAgent fall back to a coarse signal when concepts
    //     happen to be empty for older messages persisted before the
    //     concepts column existed.
    const conceptsQ = this.pool.query(
      `SELECT concept_value AS concept, COUNT(*)::int AS count
       FROM messages m
       JOIN interacciones i ON i.id = m.interaccion_id
       , jsonb_array_elements_text(COALESCE(m.concepts, '[]'::jsonb)) AS concept_value
       WHERE i.usuario_id = $1
         AND m.role = 'assistant'
       GROUP BY concept_value
       ORDER BY count DESC, concept_value ASC`,
      [userId]
    );
    const classificationsQ = this.pool.query(
      `SELECT m.classification AS classification, COUNT(*)::int AS count
       FROM messages m
       JOIN interacciones i ON i.id = m.interaccion_id
       WHERE i.usuario_id = $1
         AND m.role = 'assistant'
         AND m.classification IS NOT NULL
       GROUP BY m.classification
       ORDER BY count DESC`,
      [userId]
    );
    const [conceptsRes, classificationsRes] = await Promise.all([conceptsQ, classificationsQ]);
    return {
      concepts: conceptsRes.rows.map((r) => ({ concept: r.concept, count: r.count })),
      classifications: classificationsRes.rows.map((r) => ({
        classification: r.classification,
        count: r.count,
      })),
    };
  }
}

module.exports = PgMessageRepository;
