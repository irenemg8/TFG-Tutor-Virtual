"use strict";

const AgentInterface = require("./base/AgentInterface");

/*------------------------------------------------------------------------------
            _________________________________________________________
            |                    GUARDRAIL AGENT                    |
            |  Output-side safety stage. Delegates to the           |
            |  GuardrailPipeline (parallel checks, surgical-first,  |
            |  at most one consolidated LLM retry, final surgical   |
            |  fallback) and maps the result onto the legacy        |
            |  triggered-flags shape PersistenceAgent expects.      |
        ____|________________                                       |
   Obj -> | constructor() | -> GuardrailAgent        (writes attrs) |
          -----------------                                         |
            |                                                       |
            |   pipeline: Obj          debugLogger: Obj             |
            |   kgConceptPatterns: [Obj]                            |
        ____|____________                                           |
   Obj -> | canSkip() | -> T/F                        (no attrs)    |
          -----------                                               |
        ____|___________                                            |
   Obj -> | execute() | -> Promise<void>             (reads attrs)  |
          -----------                                               |
            |                                                       |
            |_______________________________________________________|
------------------------------------------------------------------------------*/
class GuardrailAgent extends AgentInterface {
  /*
   Obj -> ____|________________
         | constructor() | -> GuardrailAgent    (writes attributes pipeline (Obj),
          -----------------                      debugLogger (Obj),
                                                 kgConceptPatterns ([Obj]))
      Validates and stores the injected pipeline and debug logger, plus the
      optional KG concept patterns used by some guardrails.
  */
  constructor(deps) {
    super("guardrailAgent");
    if (!deps || !deps.guardrailPipeline) {
      throw new Error("GuardrailAgent requires a guardrailPipeline dependency");
    }
    if (!deps.debugLogger) throw new Error("GuardrailAgent requires deps.debugLogger");
    this.pipeline = deps.guardrailPipeline;
    this.debugLogger = deps.debugLogger;
    this.kgConceptPatterns = deps.kgConceptPatterns || [];
  }

  /*
       ____|____________
   Obj -> | canSkip() | -> T/F    (no attributes)
          -----------
      Skips validation when the orchestrator already produced a
      deterministic finish response.
  */
  canSkip(context) {
    return context.deterministicFinish;
  }

  /*
       ____|___________
   Obj -> | execute() | -> Promise<void>    (reads attributes pipeline (Obj),
          -----------                        kgConceptPatterns ([Obj]),
                                             debugLogger (Obj))
      Builds the guardrail context, runs the pipeline against the LLM
      response with a phase-local time budget, writes the validated final
      response plus audit fields, and maps violations/fixes onto the legacy
      guardrailsTriggered flags object.
  */
  async execute(context) {
    if (!context.llmResponse) {
      context.finalResponse = "";
      return;
    }

    const guardrailCtx = {
      classification: context.classification && context.classification.type,
      correctAnswer: context.correctAnswer,
      evaluableElements: context.evaluableElements,
      kgConceptPatterns: this.kgConceptPatterns,
      lang: context.lang,
      mentionedElements: context.classification && context.classification.resistances,
      proposed: (context.classification && context.classification.proposed) || [],
      negated: (context.classification && context.classification.negated) || [],
      turnVerdict: context.turnVerdict || null,
      cumulativeAnswer: context.cumulativeAnswer || null,
      messages: context.llmMessages || [],
    };

    const result = await this.pipeline.validate(context.llmResponse, guardrailCtx, {
      messages: context.llmMessages,
      reqId: context.reqId || "",
      startMs: Date.now(),
    });

    context.finalResponse = result.response;
    context.guardrailPath = result.path;
    context.guardrailLlmRetries = result.llmRetryCount;
    context.guardrailSurgicalFixes = result.surgicalFixesApplied || [];
    context.guardrailSurgicalFixDetails = result.surgicalFixDetails || [];

    const fixed = new Set(result.surgicalFixesApplied || []);
    const residual = (result.residualViolations || []).map(v => v.id);
    const anyFor = (id) => fixed.has(id) || residual.indexOf(id) >= 0;

    context.guardrailsTriggered = {
      solutionLeak: anyFor("solution_leak"),
      falseConfirmation: anyFor("false_confirmation"),
      prematureConfirmation: anyFor("premature_confirmation"),
      completeSolution: anyFor("complete_solution"),
      stateReveal: anyFor("state_reveal"),
      elementNaming: false,
      adherence: anyFor("adherence"),
      didacticExplanation: anyFor("didactic_explanation"),
      datasetStyle: anyFor("dataset_style"),
      languageDrift: anyFor("language_drift"),
      repeatedQuestion: anyFor("repeated_question"),
      settledElementQuestion: anyFor("settled_element_question"),
    };

    this.debugLogger.logGuardrail && this.debugLogger.logGuardrail(context.guardrailsTriggered, context.finalResponse);
  }
}

module.exports = GuardrailAgent;
