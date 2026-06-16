"use strict";

const IMessageRepository = require("../../../domain/ports/repositories/IMessageRepository");
const Message = require("../../../domain/entities/Message");

/*
   Obj, Obj -> ____|____________________
              | parseJsonbColumn() | -> Obj
               ------------------
      Returns a JSONB column already parsed by the driver, parses it when the
      driver hands back a raw string, and falls back when null or invalid.
*/
function parseJsonbColumn(val, fallback) {
  if (val == null) return fallback;
  if (typeof val === "string") {
    try { return JSON.parse(val); } catch { return fallback; }
  }
  return val;
}

/*
   Obj -> ____|________________
         | rowToDomain() | -> Message | null
          --------------
      Maps a messages row into a Message entity, reassembling its metadata
      from the dedicated guardrail columns and the extra_metadata JSONB blob.
      Null when no row.
*/
function rowToDomain(row) {
  if (!row) return null;
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
          solutionLeak: row.guardrail_solution_leak,
          falseConfirmation: row.guardrail_false_confirmation,
          prematureConfirmation: row.guardrail_premature_confirmation,
          stateReveal: row.guardrail_state_reveal,
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
    interactionId: row.interaccion_id,
    sequenceNum: row.sequence_num,
    role: row.role,
    content: row.content,
    timestamp: row.timestamp,
    metadata,
  });
}

/*------------------------------------------------------------------------------
            _________________________________________________________
            |                   PGMESSAGEREPOSITORY                 |
            |  Repository adapter implementing IMessageRepository on |
            |  top of PostgreSQL. Appends chat messages with their   |
            |  rich pipeline metadata and serves the read/aggregate  |
            |  queries the tutoring loop and analytics rely on.      |
            |                                                       |
        ____|________________                                       |
   Pool -> | constructor() | -> PgMessageRepository  (writes attrs) |
           -----------------                                        |
            |   pool: Pool (injected pg pool)                       |
        ____|_______________                                       |
   Txt,Message -> | appendMessage() | -> Promise<void>  (reads attrs)|
                  ---------------                                   |
        ____|________________                                      |
   Txt,Z -> | getLastMessages() | -> Promise<[Message]> (reads attrs)|
            -----------------                                       |
        ____|_______________                                       |
   Txt -> | getAllMessages() | -> Promise<[Message]>    (reads attrs)|
          ----------------                                          |
        ____|___________________________                           |
   Txt,[Txt] -> | countConsecutiveFromEnd() | -> Promise<Z> (reads attrs)|
                -------------------------                          |
        ____|_________________________                             |
   Txt -> | countAssistantMessages() | -> Promise<Z>     (reads attrs)|
          ------------------------                                  |
        ____|__________________________                            |
   Txt,Z -> | getLastAssistantMessages() | -> Promise<[Message]> (reads attrs)|
            --------------------------                            |
        ____|_______________                                       |
   Txt -> | getLastMessage() | -> Promise<Message|null>  (reads attrs)|
          ----------------                                          |
        ____|_____________________                                 |
   Txt -> | getAcEvidenceByUserId() | -> Promise<Obj>    (reads attrs)|
          -----------------------                                   |
            |                                                       |
            |_______________________________________________________|
------------------------------------------------------------------------------*/
class PgMessageRepository extends IMessageRepository {
  /*
   Pool -> ____|________________
          | constructor() | -> PgMessageRepository    (writes attribute pool (Pool))
           -----------------
      Stores the injected pg connection pool.
  */
  constructor(pool) {
    super();
    this.pool = pool;
  }

  /*
   Txt, Message -> ____|_________________
                  | appendMessage() | -> Promise<void>    (reads attribute pool (Pool))
                   ---------------
      Inserts a message at the next sequence number, persisting the legacy
      guardrail columns and packing the remaining signals into extra_metadata,
      then refreshes interacciones.fin. The $1::text cast lets PostgreSQL
      deduce the type when the param is reused in the subselect (error 42P08).
  */
  async appendMessage(interaccionId, message) {
    const meta = message.metadata;
    const conceptsJson = JSON.stringify(Array.isArray(meta?.concepts) ? meta.concepts : []);

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
    await this.pool.query(
      "UPDATE interacciones SET fin = NOW() WHERE id = $1",
      [interaccionId]
    );
  }

  /*
   Txt, Z -> ____|_________________
            | getLastMessages() | -> Promise<[Message]>    (reads attribute pool (Pool))
             -----------------
      Returns the last count messages of an interaction in chronological order.
  */
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

  /*
   Txt -> ____|________________
         | getAllMessages() | -> Promise<[Message]>    (reads attribute pool (Pool))
          ----------------
      Returns every message of an interaction in ascending sequence order.
  */
  async getAllMessages(interaccionId) {
    const { rows } = await this.pool.query(
      `SELECT * FROM messages
       WHERE interaccion_id = $1
       ORDER BY sequence_num ASC`,
      [interaccionId]
    );
    return rows.map(rowToDomain);
  }

  /*
   Txt, [Txt] -> ____|_________________________
                | countConsecutiveFromEnd() | -> Promise<Z>    (reads attribute pool (Pool))
                 -------------------------
      Counts how many of the latest assistant messages, from the end backwards,
      carry one of the given classifications before the streak breaks.
  */
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

  /*
   Txt -> ____|_________________________
         | countAssistantMessages() | -> Promise<Z>    (reads attribute pool (Pool))
          ------------------------
      Returns the number of assistant messages in the interaction.
  */
  async countAssistantMessages(interaccionId) {
    const { rows } = await this.pool.query(
      `SELECT COUNT(*) AS cnt FROM messages
       WHERE interaccion_id = $1 AND role = 'assistant'`,
      [interaccionId]
    );
    return parseInt(rows[0].cnt, 10);
  }

  /*
   Txt, Z -> ____|__________________________
            | getLastAssistantMessages() | -> Promise<[Message]>    (reads attribute pool (Pool))
             --------------------------
      Returns the last count assistant messages of an interaction in
      chronological order.
  */
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

  /*
   Txt -> ____|________________
         | getLastMessage() | -> Promise<Message|null>    (reads attribute pool (Pool))
          ----------------
      Returns the most recent message of an interaction, or null when none.
  */
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

  /*
   Txt -> ____|_____________________
         | getAcEvidenceByUserId() | -> Promise<Obj>    (reads attribute pool (Pool))
          -----------------------
      Returns two aggregates in one round trip: the concepts the classifier
      flagged on the user's assistant turns (by frequency), and the count of
      each assistant classification (a coarse fallback for older messages
      persisted before the concepts column existed).
  */
  async getAcEvidenceByUserId(userId) {
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
