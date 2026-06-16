"use strict";

/*------------------------------------------------------------------------------
            _________________________________________________________
            |                      AGENTCONTEXT                     |
            |  Shared mutable context object (blackboard pattern)   |
            |  that flows through the agent pipeline. Each agent    |
            |  reads what it needs and writes its own output onto   |
            |  it, so the agents stay decoupled from one another.   |
        ____|________________                                       |
   Obj -> | constructor() | -> AgentContext         (writes attrs)  |
          -----------------                                         |
            |                                                       |
            |   userId: Txt          exerciseId: Txt                |
            |   userMessage: Txt     interactionId: Txt | null      |
            |   budgetMs: N | null   reqId: Txt | null              |
            |   tokenStreamHandler: Fn | null                       |
            |   streamedText: Txt    exercise: Obj | null           |
            |   exerciseNum: Z | null    correctAnswer: [Txt]       |
            |   evaluableElements: [Txt] history: [Obj]             |
            |   lang: Txt            loopState: Obj                  |
            |   inputSecurity: Obj   inputBlocked: T/F              |
            |   classification: Obj | null   ragResult: Obj         |
            |   retrievalTimedOut: T/F   llmResponse: Obj | null    |
            |   llmMessages: [Obj]   kgConceptPatterns: [Obj]       |
            |   finalResponse: Txt | null    guardrailsTriggered:Obj|
            |   guardrailPath: Txt | null    guardrailLlmRetries: Z |
            |   guardrailSurgicalFixes: [Txt]    timing: Obj        |
            |   deterministicFinish: T/F     fallthrough: T/F       |
            |                                                       |
            |_______________________________________________________|
------------------------------------------------------------------------------*/
class AgentContext {
  /*
   Obj -> ____|________________
         | constructor() | -> AgentContext    (writes attributes userId (Txt),
          -----------------                    exerciseId (Txt), userMessage (Txt),
                                               interactionId (Txt|null), budgetMs (N|null),
                                               reqId (Txt|null), tokenStreamHandler (Fn|null),
                                               streamedText (Txt) and the per-stage output
                                               slots the pipeline later fills in)
      Seeds the immutable request inputs and initialises every output
      slot to its empty default so each downstream agent can write into
      a known shape. tokenStreamHandler is kept only when callable.
  */
  constructor(request) {
    this.userId = request.userId;
    this.exerciseId = request.exerciseId;
    this.userMessage = request.userMessage;
    this.interactionId = request.interactionId || null;
    this.budgetMs = request.budgetMs || null;
    this.reqId = request.reqId || null;
    this.tokenStreamHandler =
      typeof request.tokenStreamHandler === "function" ? request.tokenStreamHandler : null;
    this.streamedText = "";

    this.exercise = null;
    this.exerciseNum = null;
    this.correctAnswer = [];
    this.evaluableElements = [];
    this.history = [];
    this.lang = "es";
    this.loopState = {
      prevCorrectTurns: 0,
      consecutiveWrongTurns: 0,
      totalAssistantTurns: 0,
      tutorRepeating: false,
      studentFrustrated: false,
    };

    this.inputSecurity = { safe: true, category: "safe", matchedPattern: null };
    this.inputBlocked = false;

    this.classification = null;

    this.ragResult = {
      augmentation: "",
      decision: null,
      sources: [],
    };
    this.retrievalTimedOut = false;

    this.llmResponse = null;
    this.llmMessages = [];

    this.kgConceptPatterns = [];

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
    this.guardrailPath = null;
    this.guardrailLlmRetries = 0;
    this.guardrailSurgicalFixes = [];

    this.timing = {
      pipelineStartMs: Date.now(),
      pipelineMs: null,
      ollamaMs: null,
      totalMs: null,
    };

    this.deterministicFinish = false;
    this.fallthrough = false;
  }
}

module.exports = AgentContext;
