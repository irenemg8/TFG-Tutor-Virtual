"use strict";

const AgentInterface = require("./base/AgentInterface");
const Message = require("../entities/Message");
const MessageMetadata = require("../entities/MessageMetadata");

/*------------------------------------------------------------------------------
            _________________________________________________________
            |                   PERSISTENCE AGENT                   |
            |  Saves the user message and the assistant response    |
            |  (with metadata) to the message repository, logs the  |
            |  interaction and emits a save event.                  |
        ____|________________                                       |
   Obj -> | constructor() | -> PersistenceAgent     (writes attrs)  |
          -----------------                                         |
            |                                                       |
            |   messageRepo: Obj        interaccionRepo: Obj        |
            |   logInteraction: Fn | null   emitEvent: Fn | null    |
        ____|___________                                            |
   Obj -> | execute() | -> Promise<void>             (reads attrs)  |
          -----------                                               |
            |                                                       |
            |_______________________________________________________|
------------------------------------------------------------------------------*/
class PersistenceAgent extends AgentInterface {
  /*
   Obj -> ____|________________
         | constructor() | -> PersistenceAgent    (writes attributes
          -----------------                        messageRepo (Obj),
                                                   interaccionRepo (Obj),
                                                   logInteraction (Fn|null),
                                                   emitEvent (Fn|null))
      Stores the injected repositories and the optional logger / event
      emitter dependencies.
  */
  constructor(deps) {
    super("persistenceAgent");
    this.messageRepo = deps.messageRepo;
    this.interaccionRepo = deps.interaccionRepo;
    this.logInteraction = deps.logInteraction || null;
    this.emitEvent = deps.emitEvent || null;
  }

  /*
       ____|___________
   Obj -> | execute() | -> Promise<void>    (reads attributes messageRepo (Obj),
          -----------                        logInteraction (Fn|null),
                                             emitEvent (Fn|null))
      Persists the user message, builds the assistant message with full
      metadata (classification, RAG decision, guardrails, timing, AC and
      surgical-fix audit fields), saves it, logs the interaction and emits
      the save event.
  */
  async execute(context) {
    const userMsg = new Message({
      interactionId: context.interactionId,
      role: "user",
      content: context.userMessage,
    });
    await this.messageRepo.appendMessage(context.interactionId, userMsg);

    const totalMs = Date.now() - context.timing.pipelineStartMs;
    const metadata = new MessageMetadata({
      classification: context.classification?.type || null,
      decision: context.ragResult?.decision || null,
      isCorrectAnswer: context.classification?.isCorrectAnswer ?? null,
      sourcesCount: context.ragResult?.sources?.length || 0,
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
      detectedACs: Array.isArray(context.detectedACs) ? context.detectedACs : [],
      guardrailPath: context.guardrailPath || null,
      guardrailLlmRetries: context.guardrailLlmRetries || 0,
      guardrailSurgicalFixes: Array.isArray(context.guardrailSurgicalFixes)
        ? context.guardrailSurgicalFixes
        : [],
      llmResponseOriginal: context.llmResponse || null,
      guardrailSurgicalFixDetails: Array.isArray(context.guardrailSurgicalFixDetails)
        ? context.guardrailSurgicalFixDetails
        : [],
      fallbackUsed: context.fallbackUsed || false,
      deterministicFinish: context.deterministicFinish || false,
    });

    const assistantMsg = new Message({
      interactionId: context.interactionId,
      role: "assistant",
      content: context.finalResponse || context.llmResponse,
      metadata,
    });
    await this.messageRepo.appendMessage(context.interactionId, assistantMsg);

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

    if (this.emitEvent) {
      this.emitEvent("mongodb_save", "save", {
        interaccionId: context.interactionId,
      });
    }
  }
}

module.exports = PersistenceAgent;
