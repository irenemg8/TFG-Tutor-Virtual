"use strict";

const ContextAgent = require("./contextAgent");
const InputGuardrailAgent = require("./inputGuardrailAgent");
const ClassifierAgent = require("./classifierAgent");
const RetrievalAgent = require("./retrievalAgent");
const TutorAgent = require("./tutorAgent");
const GuardrailAgent = require("./guardrailAgent");
const PersistenceAgent = require("./persistenceAgent");

/**
 * Creates and returns the default agent registry.
 * Dependencies are injected via constructor. The GuardrailAgent now uses
 * the new GuardrailPipeline (parallel, surgical-first, single consolidated
 * retry) instead of the old sequential LLM retry loop.
 *
 * @param {object} deps
 * @param {object} deps.ejercicioRepo
 * @param {object} deps.interaccionRepo
 * @param {object} deps.messageRepo
 * @param {object} deps.llmService                  — ILlmService adapter
 * @param {object} deps.guardrailPipeline           — GuardrailPipeline instance
 * @param {Function} deps.classifyQuery
 * @param {Function} deps.runFullPipeline
 * @param {object} deps.securityService
 * @param {Function} deps.buildSystemPrompt
 * @param {Function} [deps.logInteraction]
 * @param {Function} [deps.emitEvent]
 * @param {object} deps.config
 */
function createAgentRegistry(deps) {
  return {
    context: new ContextAgent({
      ejercicioRepo: deps.ejercicioRepo,
      interaccionRepo: deps.interaccionRepo,
      messageRepo: deps.messageRepo,
      config: deps.config,
    }),

    inputGuardrail: new InputGuardrailAgent({
      securityService: deps.securityService,
    }),

    classifier: new ClassifierAgent({
      classifyQuery: deps.classifyQuery,
      debugLogger: deps.debugLogger,
    }),

    retrieval: new RetrievalAgent({
      runFullPipeline: deps.runFullPipeline,
    }),

    tutor: new TutorAgent({
      llmService: deps.llmService,
      buildSystemPrompt: deps.buildSystemPrompt,
      config: deps.config,
      debugLogger: deps.debugLogger,
    }),

    guardrail: new GuardrailAgent({
      guardrailPipeline: deps.guardrailPipeline,
      kgConceptPatterns: deps.kgConceptPatterns || [],
    }),

    persistence: new PersistenceAgent({
      messageRepo: deps.messageRepo,
      interaccionRepo: deps.interaccionRepo,
      logInteraction: deps.logInteraction,
      emitEvent: deps.emitEvent,
    }),
  };
}

module.exports = { createAgentRegistry };
