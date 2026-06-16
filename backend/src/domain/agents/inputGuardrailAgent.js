"use strict";

const AgentInterface = require("./base/AgentInterface");

/*------------------------------------------------------------------------------
            _________________________________________________________
            |                  INPUT GUARDRAIL AGENT                |
            |  First-line defense on the INPUT side of the pipeline.|
            |  Runs after ContextAgent and BEFORE the classifier;   |
            |  short-circuits the pipeline with a localized redirect|
            |  on prompt-injection or clear off-topic requests.     |
        ____|________________                                       |
   Obj -> | constructor() | -> InputGuardrailAgent  (writes attrs)  |
          -----------------                                         |
            |                                                       |
            |   securityService: Obj                                |
        ____|___________                                            |
   Obj -> | execute() | -> Promise<void>             (reads attrs)  |
          -----------                                               |
        ____|____________                                           |
   Obj -> | canSkip() | -> F                          (no attrs)    |
          -----------                                               |
            |                                                       |
            |_______________________________________________________|
------------------------------------------------------------------------------*/
class InputGuardrailAgent extends AgentInterface {
  /*
   Obj -> ____|________________
         | constructor() | -> InputGuardrailAgent    (writes attribute
          -----------------                           securityService (Obj))
      Stores the injected security service used to analyse student input.
  */
  constructor(deps) {
    super("inputGuardrailAgent");
    this.securityService = deps.securityService;
  }

  /*
       ____|___________
   Obj -> | execute() | -> Promise<void>    (reads attribute securityService (Obj))
          -----------
      Analyses the student message; on an unsafe verdict, blocks the turn
      and sets the localized redirect as the final response.
  */
  async execute(context) {
    const result = await Promise.resolve(this.securityService.analyzeInput(context.userMessage, {
      lang: context.lang,
      exercise: context.exercise,
      evaluableElements: context.evaluableElements,
    }));

    context.inputSecurity = {
      safe: result.safe,
      category: result.category,
      matchedPattern: result.matchedPattern || null,
    };

    if (!result.safe) {
      context.inputBlocked = true;
      context.finalResponse = result.redirectMessage;
      context.fallthrough = true;
    }
  }

  /*
       ____|____________
   Obj -> | canSkip() | -> F    (no attributes)
          -----------
      Never skips: input is always evaluated since injection can hide
      inside an innocent-looking message such as a greeting.
  */
  canSkip(context) {
    return false;
  }
}

module.exports = InputGuardrailAgent;
