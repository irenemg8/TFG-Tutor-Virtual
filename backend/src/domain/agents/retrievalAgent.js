"use strict";

const AgentInterface = require("./base/AgentInterface");

/**
 * RetrievalAgent: Executes the RAG retrieval pipeline.
 * Wraps the existing runFullPipeline from ragPipeline.js.
 *
 * Routes to hybrid search (BM25 + semantic + RRF), knowledge graph,
 * and CRAG reformulation based on classification type.
 */
class RetrievalAgent extends AgentInterface {
  /**
   * @param {object} deps
   * @param {Function} deps.runFullPipeline - The runFullPipeline function from ragPipeline.js
   * @param {object}   [deps.resultadoRepo] - PgResultadoRepository, injected so
   *                   the pipeline's loadStudentHistory call no longer reaches
   *                   into the DI container from the domain layer (NS-5).
   */
  constructor(deps) {
    super("retrievalAgent");
    this.runFullPipeline = deps.runFullPipeline;
    this.resultadoRepo = deps.resultadoRepo || null;
  }

  canSkip(context) {
    if (
      context.classification?.type === "greeting" ||
      context.classification?.type === "off_topic"
    ) {
      return true;
    }
    // BUG-013 (2026-05-03): el embedding (Ollama UPV remoto) tarda 10-18s
    // en cold-start. Solo las clasificaciones que disparan hybridSearch
    // (que usa embedding) sufren esa latencia: partial_correct y
    // wrong_answer. Las demás (dont_know, closed_answer) usan KG/hint
    // local, son rápidas y aportan scaffold pedagógico necesario para
    // que el LLM no produzca preguntas arbitrarias — NO se deben skipear.
    //
    // Skipeamos solo cuando: query <=5 chars (Rn corto) Y clasificación
    // dispara embedding. En ese caso BM25/Chroma sobre 1-2 tokens no
    // aporta info útil que el LLM no tenga por el clasificador + system.
    var msg = (context.userMessage || "").trim();
    if (msg.length === 0) return true;
    if (msg.length <= 5) {
      var embedHeavy = ["partial_correct", "wrong_answer", "only_negation", "correct"];
      if (embedHeavy.includes(context.classification?.type)) return true;
    }
    return false;
  }

  async execute(context) {
    if (this.canSkip(context)) {
      context.ragResult = {
        augmentation: "",
        decision: "no_rag",
        sources: [],
        classification: context.classification,
      };
      return;
    }

    // Use canonical exercise number for retrieval (e.g. ex.2 shares dataset
    // and Chroma collection with ex.1). contextAgent populates this; falls
    // back to exerciseNum if missing for any reason.
    const searchNum = context.canonicalExerciseNum != null
      ? context.canonicalExerciseNum
      : context.exerciseNum;

    const ragResult = await this.runFullPipeline(
      context.userMessage,
      searchNum,
      context.correctAnswer,
      context.userId,
      context.evaluableElements,
      context.lang,
      this._buildPipelineOptions(context)
    );

    context.ragResult = {
      augmentation: ragResult.augmentation || "",
      decision: ragResult.decision || null,
      sources: ragResult.sources || [],
      classification: ragResult.classification || context.classification,
    };
    // Surface the abort signal so the orchestrator (and downstream telemetry)
    // can mark the turn as degraded. tutorAgent doesn't currently react to
    // it directly — the empty augmentation already nudges it towards a more
    // cautious answer — but the flag is now first-class instead of hidden
    // inside ragPipeline's emitEvent.
    if (ragResult.retrievalTimedOut) {
      context.retrievalTimedOut = true;
    }

    // Update classification.type if the pipeline refined it.
    // BUG FIX (2026-04-27, dump-cazado): el código anterior hacía
    //   context.classification = ragResult.classification;
    // pero ragPipeline devuelve `classification: classification.type` (string),
    // así que el objeto original — con .concepts, .proposed, .negated — se
    // perdía. Eso rompía el conceptsBanner del tutorAgent (P1a) y cualquier
    // otro consumer downstream que esperase el objeto. Ahora solo refinamos
    // el .type, preservando el resto del objeto.
    if (
      ragResult.classification &&
      typeof ragResult.classification === "string" &&
      context.classification &&
      typeof context.classification === "object"
    ) {
      context.classification.type = ragResult.classification;
    }
  }

  // Combine NS-3's per-stage budget with NS-5's injected resultadoRepo into
  // the single options bag that runFullPipeline accepts. Returns undefined
  // when neither is available so the legacy ragMiddleware path keeps the
  // same six-arg call shape it had before.
  _buildPipelineOptions(context) {
    const opts = {};
    if (context.retrievalBudgetMs) opts.budgetMs = context.retrievalBudgetMs;
    if (this.resultadoRepo) opts.resultadoRepo = this.resultadoRepo;
    return Object.keys(opts).length > 0 ? opts : undefined;
  }
}

module.exports = RetrievalAgent;
