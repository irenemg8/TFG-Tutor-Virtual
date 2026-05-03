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
   */
  constructor(deps) {
    super("retrievalAgent");
    this.runFullPipeline = deps.runFullPipeline;
  }

  canSkip(context) {
    return (
      context.classification?.type === "greeting" ||
      context.classification?.type === "off_topic"
    );
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
      context.retrievalBudgetMs ? { budgetMs: context.retrievalBudgetMs } : undefined
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
}

module.exports = RetrievalAgent;
