"use strict";

const AgentInterface = require("./base/AgentInterface");

/*------------------------------------------------------------------------------
            _________________________________________________________
            |                    RETRIEVAL AGENT                    |
            |  Executes the RAG retrieval pipeline, wrapping         |
            |  runFullPipeline. Routes to hybrid search (BM25 +     |
            |  semantic + RRF), knowledge graph and CRAG            |
            |  reformulation based on the classification type.      |
        ____|________________                                       |
   Obj -> | constructor() | -> RetrievalAgent       (writes attrs)  |
          -----------------                                         |
            |                                                       |
            |   runFullPipeline: Fn    resultadoRepo: Obj | null    |
        ____|____________                                           |
   Obj -> | canSkip() | -> T/F                        (reads attrs) |
          -----------                                               |
        ____|___________                                            |
   Obj -> | execute() | -> Promise<void>             (reads attrs)  |
          -----------                                               |
        ____|_________________________                              |
   Obj -> | _buildPipelineOptions() | -> Obj | void   (reads attrs) |
          ---------------------------                               |
            |                                                       |
            |_______________________________________________________|
------------------------------------------------------------------------------*/
class RetrievalAgent extends AgentInterface {
  /*
   Obj -> ____|________________
         | constructor() | -> RetrievalAgent    (writes attributes
          -----------------                      runFullPipeline (Fn),
                                                 resultadoRepo (Obj|null))
      Stores the injected pipeline function and the optional resultado
      repository (NS-5) so the domain layer no longer reaches into the DI
      container for student history.
  */
  constructor(deps) {
    super("retrievalAgent");
    this.runFullPipeline = deps.runFullPipeline;
    this.resultadoRepo = deps.resultadoRepo || null;
  }

  /*
       ____|____________
   Obj -> | canSkip() | -> T/F    (reads attributes runFullPipeline (Fn),
          -----------              resultadoRepo (Obj|null))
      Skips retrieval on greetings/off-topic, on empty messages, and on
      very short (<=5 char) queries whose classification triggers the slow
      embedding call, where BM25/Chroma add no useful signal.
  */
  canSkip(context) {
    if (
      context.classification?.type === "greeting" ||
      context.classification?.type === "off_topic"
    ) {
      return true;
    }
    var msg = (context.userMessage || "").trim();
    if (msg.length === 0) return true;
    if (msg.length <= 5) {
      var embedHeavy = ["partial_correct", "wrong_answer", "only_negation", "correct"];
      if (embedHeavy.includes(context.classification?.type)) return true;
    }
    return false;
  }

  /*
       ____|___________
   Obj -> | execute() | -> Promise<void>    (reads attributes runFullPipeline (Fn),
          -----------                        resultadoRepo (Obj|null))
      Runs the full RAG pipeline on the canonical exercise number, writes
      the augmentation/decision/sources to context, surfaces the budget
      abort signal, and refines the classification type only (preserving
      the original classification object).
  */
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

    const searchNum = context.canonicalExerciseNum != null
      ? context.canonicalExerciseNum
      : context.exerciseNum;

    const ragResult = await this.runFullPipeline(
      context.userMessage,
      searchNum,
      context.correctAnswer,
      context.userId,
      context.evaluableElements,
      context.lang,
      this._buildPipelineOptions(context)
    );

    context.ragResult = {
      augmentation: ragResult.augmentation || "",
      decision: ragResult.decision || null,
      sources: ragResult.sources || [],
      classification: ragResult.classification || context.classification,
    };
    if (ragResult.retrievalTimedOut) {
      context.retrievalTimedOut = true;
    }

    if (
      ragResult.classification &&
      typeof ragResult.classification === "string" &&
      context.classification &&
      typeof context.classification === "object"
    ) {
      context.classification.type = ragResult.classification;
    }
  }

  /*
       ____|_________________________
   Obj -> | _buildPipelineOptions() | -> Obj | void    (reads attribute
          ---------------------------                   resultadoRepo (Obj|null))
      Merges the per-stage budget (NS-3) and the injected resultado repo
      (NS-5) into the options bag for runFullPipeline. Returns undefined
      when neither is set so the legacy six-arg call shape is preserved.
  */
  _buildPipelineOptions(context) {
    const opts = {};
    if (context.retrievalBudgetMs) opts.budgetMs = context.retrievalBudgetMs;
    if (this.resultadoRepo) opts.resultadoRepo = this.resultadoRepo;
    return Object.keys(opts).length > 0 ? opts : undefined;
  }
}

module.exports = RetrievalAgent;
