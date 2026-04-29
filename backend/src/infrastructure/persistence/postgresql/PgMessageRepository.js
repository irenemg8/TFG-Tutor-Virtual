"use strict";

const IMessageRepository = require("../../../domain/ports/repositories/IMessageRepository");
const Message = require("../../../domain/entities/Message");

function rowToDomain(row) {
  if (!row) return null;
  // concepts is JSONB. node-postgres parses jsonb to JS automatically when
  // the row comes back from a regular SELECT, but defensive parsing here
  // tolerates the rare case where it's still a string.
  let concepts = [];
  if (row.concepts != null) {
    if (Array.isArray(row.concepts)) {
      concepts = row.concepts;
    } else if (typeof row.concepts === "string") {
      try { concepts = JSON.parse(row.concepts); } catch { concepts = []; }
    }
  }
  const metadata = row.classification
    ? {
        classification: row.classification,
        decision: row.decision,
        isCorrectAnswer: row.is_correct_answer,
        sourcesCount: row.sources_count,
        studentResponseMs: row.student_response_ms,
        concepts: concepts,
        guardrails: {
          solutionLeak: row.guardrail_solution_leak,
          falseConfirmation: row.guardrail_false_confirmation,
          prematureConfirmation: row.guardrail_premature_confirmation,
          stateReveal: row.guardrail_state_reveal,
        },
        timing: {
          pipelineMs: row.timing_pipeline_ms,
          ollamaMs: row.timing_ollama_ms,
          totalMs: row.timing_total_ms,
        },
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
    await this.pool.query(
      `INSERT INTO messages (
        interaccion_id, sequence_num, role, content, timestamp,
        classification, decision, is_correct_answer, sources_count, student_response_ms,
        guardrail_solution_leak, guardrail_false_confirmation,
        guardrail_premature_confirmation, guardrail_state_reveal,
        timing_pipeline_ms, timing_ollama_ms, timing_total_ms,
        concepts
      ) VALUES (
        $1::text,
        COALESCE((SELECT MAX(sequence_num) + 1 FROM messages WHERE interaccion_id = $1::text), 0),
        $2, $3, $4,
        $5, $6, $7, $8, $9,
        $10, $11, $12, $13,
        $14, $15, $16,
        $17::jsonb
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
