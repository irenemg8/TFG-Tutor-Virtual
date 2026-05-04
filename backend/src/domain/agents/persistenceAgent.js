"use strict";

const AgentInterface = require("./base/AgentInterface");
const Message = require("../entities/Message");
const MessageMetadata = require("../entities/MessageMetadata");

/**
 * PersistenceAgent: Saves messages and logs the interaction.
 * Handles both user message and assistant response persistence.
 *
 * Extracted from ragMiddleware.js lines 446-460, 710-749.
 */
class PersistenceAgent extends AgentInterface {
  /**
   * @param {object} deps
   * @param {import('../ports/repositories/IMessageRepository')} deps.messageRepo
   * @param {import('../ports/repositories/IInteraccionRepository')} deps.interaccionRepo
   * @param {Function} [deps.logInteraction] - Optional logging function
   * @param {Function} [deps.emitEvent] - Optional event emitter
   */
  constructor(deps) {
    super("persistenceAgent");
    this.messageRepo = deps.messageRepo;
    this.interaccionRepo = deps.interaccionRepo;
    this.logInteraction = deps.logInteraction || null;
    this.emitEvent = deps.emitEvent || null;
  }

  async execute(context) {
    // 1. Save user message
    const userMsg = new Message({
      interaccionId: context.interaccionId,
      role: "user",
      content: context.userMessage,
    });
    await this.messageRepo.appendMessage(context.interaccionId, userMsg);

    // 2. Save assistant response with metadata
    const totalMs = Date.now() - context.timing.pipelineStartMs;
    const metadata = new MessageMetadata({
      classification: context.classification?.type || null,
      decision: context.ragResult?.decision || null,
      isCorrectAnswer: context.classification?.isCorrectAnswer ?? null,
      sourcesCount: context.ragResult?.sources?.length || 0,
      // Persist the rule-based concepts the classifier flagged so the
      // AcTrackerAgent can rebuild long-term AC evidence in future
      // sessions, even if this interaction is later abandoned without
      // a final Resultado.
      concepts: Array.isArray(context.classification?.concepts)
        ? context.classification.concepts
        : [],
      guardrails: context.guardrailsTriggered,
      timing: {
        pipelineMs: context.timing.pipelineMs,
        ollamaMs: context.timing.ollamaMs,
        totalMs,
        firstTokenMs: context.timing?.firstTokenMs || null,
      },
      // Extra signals introduced after the original schema (migration 008
      // — extra_metadata JSONB). These let the export CSV/JSON reflect
      // the marquee features of feat/ac-detection without one DB column
      // per field.
      detectedACs: Array.isArray(context.detectedACs) ? context.detectedACs : [],
      guardrailPath: context.guardrailPath || null,
      guardrailLlmRetries: context.guardrailLlmRetries || 0,
      guardrailSurgicalFixes: Array.isArray(context.guardrailSurgicalFixes)
        ? context.guardrailSurgicalFixes
        : [],
      fallbackUsed: context.fallbackUsed || false,
      deterministicFinish: context.deterministicFinish || false,
    });

    const assistantMsg = new Message({
      interaccionId: context.interaccionId,
      role: "assistant",
      content: context.finalResponse || context.llmResponse,
      metadata,
    });
    await this.messageRepo.appendMessage(context.interaccionId, assistantMsg);

    // 3. Log interaction (if logger available)
    if (this.logInteraction) {
      try {
        this.logInteraction({
          exerciseNum: context.exerciseNum,
          userId: context.userId,
          correctAnswer: context.correctAnswer,
          classification: context.classification?.type,
          decision: context.ragResult?.decision,
          query: context.userMessage,
          sources: context.ragResult?.sources,
          augmentation: context.ragResult?.augmentation,
          response: context.finalResponse || context.llmResponse,
          guardrails: context.guardrailsTriggered,
          timing: { pipelineMs: context.timing.pipelineMs, ollamaMs: context.timing.ollamaMs, totalMs },
        });
      } catch (e) {
        console.error("[PersistenceAgent] Log error:", e.message);
      }
    }

    // 4. Emit event
    if (this.emitEvent) {
      this.emitEvent("mongodb_save", "save", {
        interaccionId: context.interaccionId,
      });
    }
  }
}

module.exports = PersistenceAgent;
