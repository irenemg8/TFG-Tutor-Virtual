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

    const ragResult = await this.runFullPipeline(
      context.userMessage,
      context.exerciseNum,
      context.correctAnswer,
      context.userId,
      context.evaluableElements,
      context.lang
    );

    context.ragResult = {
      augmentation: ragResult.augmentation || "",
      decision: ragResult.decision || null,
      sources: ragResult.sources || [],
      classification: ragResult.classification || context.classification,
    };

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
