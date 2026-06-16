"use strict";

const ContextAgent = require("./contextAgent");
const AcTrackerAgent = require("./acTrackerAgent");
const InputGuardrailAgent = require("./inputGuardrailAgent");
const ClassifierAgent = require("./classifierAgent");
const AcDetectorAgent = require("./acDetectorAgent");
const RetrievalAgent = require("./retrievalAgent");
const TutorAgent = require("./tutorAgent");
const PedagogicalReviewerAgent = require("./pedagogicalReviewerAgent");
const GuardrailAgent = require("./guardrailAgent");
const PersistenceAgent = require("./persistenceAgent");

/*------------------------------------------------------------------------------
            _________________________________________________________
            |                    AGENTREGISTRY                      |
            |  Plain module that wires the default agent pipeline.  |
            |  Builds one instance of every agent and injects its   |
            |  dependencies, so the orchestrator receives a ready   |
            |  registry keyed by pipeline stage. The GuardrailAgent |
            |  uses the new GuardrailPipeline (parallel, surgical-  |
            |  first, single consolidated retry).                   |
            |_______________________________________________________|

   Obj -> ____|______________________
         | createAgentRegistry() | -> Obj
          -----------------------
------------------------------------------------------------------------------*/

/*
   Obj -> ____|______________________
         | createAgentRegistry() | -> Obj
          -----------------------
      Instantiates each pipeline agent from the injected deps object
      (repositories, llmService, guardrailPipeline, config and the
      classifyQuery / runFullPipeline / buildSystemPrompt functions) and
      returns them keyed by stage name.
*/
function createAgentRegistry(deps) {
  return {
    context: new ContextAgent({
      ejercicioRepo: deps.ejercicioRepo,
      interaccionRepo: deps.interaccionRepo,
      messageRepo: deps.messageRepo,
      config: deps.config,
      historySummarizer: deps.historySummarizer,
    }),

    acTracker: new AcTrackerAgent({
      resultadoRepo: deps.resultadoRepo,
      messageRepo: deps.messageRepo,
    }),

    inputGuardrail: new InputGuardrailAgent({
      securityService: deps.securityService,
    }),

    classifier: new ClassifierAgent({
      classifyQuery: deps.classifyQuery,
      debugLogger: deps.debugLogger,
    }),

    acDetector: new AcDetectorAgent({}),

    retrieval: new RetrievalAgent({
      runFullPipeline: deps.runFullPipeline,
      resultadoRepo: deps.resultadoRepo,
    }),

    tutor: new TutorAgent({
      llmService: deps.llmService,
      buildSystemPrompt: deps.buildSystemPrompt,
      config: deps.config,
      debugLogger: deps.debugLogger,
    }),

    pedagogicalReviewer: new PedagogicalReviewerAgent(),

    guardrail: new GuardrailAgent({
      guardrailPipeline: deps.guardrailPipeline,
      kgConceptPatterns: deps.kgConceptPatterns || [],
      debugLogger: deps.debugLogger,
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
