"use strict";

const IMessageRepository = require("../../../domain/ports/repositories/IMessageRepository");
const Message = require("../../../domain/entities/Message");

function rowToDomain(row) {
  if (!row) return null;
  const metadata = row.classification
    ? {
        classification: row.classification,
        decision: row.decision,
        isCorrectAnswer: row.is_correct_answer,
        sourcesCount: row.sources_count,
        studentResponseMs: row.student_response_ms,
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
    await this.pool.query(
      `INSERT INTO messages (
        interaccion_id, sequence_num, role, content, timestamp,
        classification, decision, is_correct_answer, sources_count, student_response_ms,
        guardrail_solution_leak, guardrail_false_confirmation,
        guardrail_premature_confirmation, guardrail_state_reveal,
        timing_pipeline_ms, timing_ollama_ms, timing_total_ms
      ) VALUES (
        $1::text,
        COALESCE((SELECT MAX(sequence_num) + 1 FROM messages WHERE interaccion_id = $1::text), 0),
        $2, $3, $4,
        $5, $6, $7, $8, $9,
        $10, $11, $12, $13,
        $14, $15, $16
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
}

module.exports = PgMessageRepository;
