"use strict";

/**
 * Shared mutable context object (blackboard pattern) that flows through
 * the agent pipeline. Each agent reads what it needs and writes its output.
 */
class AgentContext {
  /**
   * @param {object} request
   * @param {string}      request.userId
   * @param {string}      request.exerciseId
   * @param {string}      request.userMessage
   * @param {string|null} request.interaccionId
   */
  constructor(request) {
    // --- Input (immutable) ---
    this.userId = request.userId;
    this.exerciseId = request.exerciseId;
    this.userMessage = request.userMessage;
    this.interaccionId = request.interaccionId || null;
    this.budgetMs = request.budgetMs || null;           // optional time budget
    this.reqId = request.reqId || null;                  // optional trace id

    // --- Populated by ContextAgent ---
    this.ejercicio = null;
    this.exerciseNum = null;
    this.correctAnswer = [];
    this.evaluableElements = [];
    /** @type {import('../../entities/Message')[]} */
    this.history = [];
    this.lang = "es";
    this.loopState = {
      prevCorrectTurns: 0,
      consecutiveWrongTurns: 0,
      totalAssistantTurns: 0,
      tutorRepeating: false,
      studentFrustrated: false,
    };

    // --- Populated by InputGuardrailAgent ---
    this.inputSecurity = { safe: true, category: "safe", matchedPattern: null };
    this.inputBlocked = false;

    // --- Populated by ClassifierAgent ---
    this.classification = null;

    // --- Populated by RetrievalAgent ---
    this.ragResult = {
      augmentation: "",
      decision: null,
      sources: [],
    };

    // --- Populated by TutorAgent ---
    this.llmResponse = null;
    this.llmMessages = [];                // messages array actually sent to LLM (needed for consolidated retry)

    // --- Shared config snapshot (for guardrails that need KG patterns) ---
    this.kgConceptPatterns = [];

    // --- Populated by GuardrailAgent ---
    this.finalResponse = null;
    this.guardrailsTriggered = {
      solutionLeak: false,
      falseConfirmation: false,
      prematureConfirmation: false,
      stateReveal: false,
      elementNaming: false,
      didacticExplanation: false,
      datasetStyle: false,
    };
    this.guardrailPath = null;            // e.g. "primary_ok", "surgical_ok", "llm_retry_ok"
    this.guardrailLlmRetries = 0;         // number of LLM retries (0 or 1 with new pipeline)
    this.guardrailSurgicalFixes = [];     // ids of surgical fixes that applied

    // --- Timing ---
    this.timing = {
      pipelineStartMs: Date.now(),
      pipelineMs: null,
      ollamaMs: null,
      totalMs: null,
    };

    // --- Flags ---
    this.deterministicFinish = false;
    this.fallthrough = false;
  }
}

module.exports = AgentContext;
