"use strict";

const AgentInterface = require("./base/AgentInterface");

/*------------------------------------------------------------------------------
            _________________________________________________________
            |                    CLASSIFIERAGENT                    |
            |  Pipeline agent that classifies the student's message |
            |  to decide the tutor's response strategy. Thin wrapper|
            |  around the rule-based queryClassifier. Runs after    |
            |  ContextAgent so the conversation history is loaded.  |
        ____|________________                                       |
   Obj -> | constructor() | -> ClassifierAgent       (writes attrs) |
          -----------------                                         |
            |                                                       |
            |   name: Txt            classifyQuery: Fn              |
            |   debugLogger: Obj                                    |
        ____|_____________________________                          |
 AgentContext -> | execute() | -> Promise<void>  (reads classifyQuery (Fn),
                 ------------                      debugLogger (Obj))|
        ____|_____________________________                          |
 [Obj] -> | _lastAssistantText() | -> Txt                           |
          ----------------------                                    |
        ____|___________                                            |
        | canSkip() | -> T/F                                        |
        ------------                                                |
            |                                                       |
            |_______________________________________________________|
------------------------------------------------------------------------------*/
class ClassifierAgent extends AgentInterface {
  /*
   Obj -> ____|________________
         | constructor() | -> ClassifierAgent    (writes attributes name (Txt),
          -----------------                       classifyQuery (Fn), debugLogger (Obj))
      Stores the injected classifyQuery function and the required
      debugLogger, throwing when the logger is missing.
  */
  constructor(deps) {
    super("classifierAgent");
    this.classifyQuery = deps.classifyQuery;
    if (!deps.debugLogger) throw new Error("ClassifierAgent requires deps.debugLogger");
    this.debugLogger = deps.debugLogger;
  }

  /*
 AgentContext -> ____|___________
                | execute() | -> Promise<void>    (reads attributes classifyQuery (Fn)
                 -----------                        and debugLogger (Obj))
      Runs classifyQuery over the user message, correct answer and
      evaluable elements plus the tutor's last message (to disambiguate
      short yes/no replies from one-word wrong answers), then logs and
      writes the result to context.classification.
  */
  async execute(context) {
    const lastAssistantText = this._lastAssistantText(context.history);

    context.classification = this.classifyQuery(
      context.userMessage,
      context.correctAnswer,
      context.evaluableElements,
      lastAssistantText
    );
    this.debugLogger.logClassify(context.userMessage, context.classification);
  }

  /*
 [Obj] -> ____|_______________________
         | _lastAssistantText() | -> Txt
          ----------------------
      Walks the history backwards and returns the content of the most
      recent assistant message, or "" when there is none.
  */
  _lastAssistantText(history) {
    if (!Array.isArray(history)) return "";
    for (let i = history.length - 1; i >= 0; i--) {
      if (history[i] && history[i].role === "assistant") {
        return history[i].content || "";
      }
    }
    return "";
  }

  /*
       ____|___________
      | canSkip() | -> T/F
       ------------
      Always false: classification runs on every turn.
  */
  canSkip() {
    return false;
  }
}

module.exports = ClassifierAgent;
