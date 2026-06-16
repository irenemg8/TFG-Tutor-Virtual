"use strict";

const AgentContext = require("./base/AgentContext");

/*------------------------------------------------------------------------------
            _________________________________________________________
            |                 TUTORING ORCHESTRATOR                 |
            |  Wires and runs the full agent pipeline for each turn: |
            |  context -> input guardrail (+ parallel AC tracker) -> |
            |  classify -> AC detect -> retrieve -> deterministic    |
            |  finish? -> tutor -> pedagogical reviewer -> guardrail |
            |  -> fin-token/whitespace cleanup -> persist. Splits a  |
            |  per-stage time budget and emits workflow events.     |
        ____|________________                                       |
   Obj,Obj -> | constructor() | -> TutoringOrchestrator (writes attrs)|
              -----------------                                     |
            |                                                       |
            |   agents: Obj            emitEvent: Fn                |
        ____|___________                                            |
   Obj -> | process() | -> Promise<AgentContext>     (reads attrs)  |
          -----------                                               |
        ____|___________________                                    |
   Obj -> | _buildFallbackMessage() | -> Txt          (no attrs)    |
          -------------------------                                 |
        ____|___________________________________                    |
   Obj -> | _shouldFinishDeterministically() | -> T/F  (no attrs)   |
          ----------------------------------                        |
        ____|_____________________                                  |
   Obj -> | _normaliseWhitespace() | -> void           (no attrs)   |
          ------------------------                                  |
        ____|________________________                               |
   Obj -> | _stripUnauthorizedFinToken() | -> void     (no attrs)   |
          --------------------------                                |
        ____|_________________                                      |
   Obj -> | _buildFinishMessage() | -> Txt             (no attrs)   |
          -----------------------                                   |
            |                                                       |
            |_______________________________________________________|
------------------------------------------------------------------------------*/
class TutoringOrchestrator {
  /*
   Obj,Obj -> ____|________________
              | constructor() | -> TutoringOrchestrator    (writes attributes
              -----------------                             agents (Obj),
                                                            emitEvent (Fn))
      Stores the agent registry and the optional workflow-event emitter
      (defaults to a no-op).
  */
  constructor(agents, options = {}) {
    this.agents = agents;
    this.emitEvent = options.emitEvent || (() => {});
  }

  /*
       ____|___________
   Obj -> | process() | -> Promise<AgentContext>    (reads attributes agents (Obj),
          -----------                                emitEvent (Fn))
      Runs a tutoring request through every pipeline stage, splitting the
      time budget per stage, honouring early exits (input block, greeting,
      deterministic finish) and always returning a populated context — with
      a localized fallback message on error.
  */
  async process(request) {
    const ctx = new AgentContext(request);

    if (typeof ctx.budgetMs === "number" && ctx.budgetMs > 0) {
      ctx.retrievalBudgetMs = Math.min(8000, Math.floor(ctx.budgetMs * 0.20));
      ctx.retrievalBudgetMs = Math.max(2000, ctx.retrievalBudgetMs);
      ctx.guardrailBudgetMs = Math.min(5000, Math.floor(ctx.budgetMs * 0.10));
      ctx.guardrailBudgetMs = Math.max(1500, ctx.guardrailBudgetMs);
      const remainingForTutor =
        ctx.budgetMs - ctx.retrievalBudgetMs - ctx.guardrailBudgetMs - 2000;
      ctx.tutorBudgetMs = Math.max(8000, remainingForTutor);
    }

    try {
      this.emitEvent("agent_start", "context", { agent: "contextAgent" });
      await this.agents.context.execute(ctx);
      this.emitEvent("agent_end", "context", { agent: "contextAgent" });

      if (ctx.fallthrough) return ctx;

      const acTrackerPromise = this.agents.acTracker
        ? this.agents.acTracker.execute(ctx)
        : Promise.resolve();

      this.emitEvent("agent_start", "input_guardrail", {
        agent: "inputGuardrailAgent",
      });
      await this.agents.inputGuardrail.execute(ctx);
      this.emitEvent("agent_end", "input_guardrail", {
        agent: "inputGuardrailAgent",
        blocked: ctx.inputBlocked,
        category: ctx.inputSecurity?.category,
      });

      await acTrackerPromise;

      if (ctx.inputBlocked) {
        ctx.timing.pipelineMs = Date.now() - ctx.timing.pipelineStartMs;
        await this.agents.persistence.execute(ctx);
        return ctx;
      }

      this.emitEvent("agent_start", "classify", { agent: "classifierAgent" });
      await this.agents.classifier.execute(ctx);
      this.emitEvent("agent_end", "classify", {
        agent: "classifierAgent",
        classification: ctx.classification?.type,
      });

      if (ctx.classification && ctx.cumulativeAnswer) {
        ctx.classification.cumulativeNamedCorrect = ctx.cumulativeAnswer.namedCorrect;
      }

      if (this.agents.acDetector) {
        this.emitEvent("agent_start", "ac_detect", { agent: "acDetectorAgent" });
        await this.agents.acDetector.execute(ctx);
        this.emitEvent("agent_end", "ac_detect", {
          agent: "acDetectorAgent",
          detectedACs: (ctx.detectedACs || []).map(function (a) {
            return { id: a.id, confidence: a.confidence };
          }),
        });
      }

      if (
        ctx.classification?.type === "greeting" ||
        ctx.classification?.type === "off_topic"
      ) {
        ctx.fallthrough = true;
        return ctx;
      }

      this.emitEvent("agent_start", "retrieve", {
        agent: "retrievalAgent",
        budgetMs: ctx.retrievalBudgetMs,
      });
      const retrievalStart = Date.now();
      if (!this.agents.retrieval.canSkip(ctx)) {
        await this.agents.retrieval.execute(ctx);
      }
      const retrievalElapsed = Date.now() - retrievalStart;
      const retrievalOverBudget =
        ctx.retrievalBudgetMs && retrievalElapsed > ctx.retrievalBudgetMs;
      if (retrievalOverBudget || ctx.retrievalTimedOut) {
        console.warn(
          "[Orchestrator] retrieval " + (ctx.retrievalTimedOut ? "ABORTED by budget" : "exceeded budget") +
          ": elapsed=" + retrievalElapsed +
          "ms slice=" + ctx.retrievalBudgetMs + "ms reqId=" + (ctx.reqId || "")
        );
        this.emitEvent("rag_degraded", "retrieve", {
          reason: ctx.retrievalTimedOut ? "budget_abort" : "budget_exceeded",
          elapsedMs: retrievalElapsed,
          budgetMs: ctx.retrievalBudgetMs,
        });
      }
      this.emitEvent("agent_end", "retrieve", {
        agent: "retrievalAgent",
        decision: ctx.ragResult?.decision,
        sourcesCount: ctx.ragResult?.sources?.length || 0,
        elapsedMs: retrievalElapsed,
        overBudget: retrievalOverBudget || false,
        timedOut: ctx.retrievalTimedOut || false,
      });

      const willFinish = this._shouldFinishDeterministically(ctx);
      try {
        const c = ctx.cumulativeAnswer || {};
        console.log(
          "[TRACE] [" + (ctx.reqId || "") + "] 🏁 CLOSURE_CHECK close=" + willFinish +
          " ready=" + (c.closureReady === true) +
          " complete=" + (c.complete === true) +
          " named=[" + (c.namedCorrect || []).join(",") + "]" +
          " excluded=[" + (c.excluded || []).join(",") + "]" +
          " concepts=[" + (c.reasoningConcepts || []).join(",") + "]" +
          " wronglyNamed=[" + (c.wronglyNamed || []).join(",") + "]" +
          " alreadyClosed=" + (ctx.exerciseAlreadyClosed === true) +
          " cls=" + (ctx.classification && ctx.classification.type)
        );
      } catch (_) { }
      if (willFinish) {
        ctx.deterministicFinish = true;
        ctx.finalResponse = this._buildFinishMessage(ctx);
        ctx.timing.pipelineMs = Date.now() - ctx.timing.pipelineStartMs;

        await this.agents.persistence.execute(ctx);
        return ctx;
      }

      this.emitEvent("agent_start", "tutor", { agent: "tutorAgent" });
      await this.agents.tutor.execute(ctx);
      this.emitEvent("agent_end", "tutor", { agent: "tutorAgent" });

      if (this.agents.pedagogicalReviewer) {
        this.emitEvent("agent_start", "pedagogical_reviewer", { agent: "pedagogicalReviewerAgent" });
        await this.agents.pedagogicalReviewer.execute(ctx);
        this.emitEvent("agent_end", "pedagogical_reviewer", {
          agent: "pedagogicalReviewerAgent",
          corrections: ctx.pedagogicalCorrectionsApplied || [],
        });
      }

      this.emitEvent("agent_start", "guardrail", {
        agent: "guardrailAgent",
      });
      if (!this.agents.guardrail.canSkip(ctx)) {
        await this.agents.guardrail.execute(ctx);
      } else {
        ctx.finalResponse = ctx.llmResponse;
      }
      this.emitEvent("agent_end", "guardrail", {
        agent: "guardrailAgent",
        triggered: ctx.guardrailsTriggered,
      });

      this._stripUnauthorizedFinToken(ctx);
      this._normaliseWhitespace(ctx);

      ctx.timing.pipelineMs = Date.now() - ctx.timing.pipelineStartMs;

      await this.agents.persistence.execute(ctx);

      return ctx;
    } catch (error) {
      console.error("[Orchestrator] Pipeline error:", error.message);
      ctx.error = error;
      if (!ctx.finalResponse) {
        ctx.finalResponse = this._buildFallbackMessage(ctx);
        ctx.fallbackUsed = true;
      }
      return ctx;
    }
  }

  /*
       ____|___________________
   Obj -> | _buildFallbackMessage() | -> Txt    (no attributes)
          -------------------------
      Returns the localized friendly message shown when the pipeline fails
      (typically an LLM timeout against the UPV Ollama server).
  */
  _buildFallbackMessage(ctx) {
    const lang = ctx && ctx.lang;
    if (lang === "en") {
      return "Sorry, the tutor is taking too long to respond right now. Could you rephrase your message or try again in a moment?";
    }
    if (lang === "val") {
      return "Disculpa, el tutor està tardant massa a respondre ara mateix. Pots reformular el teu missatge o tornar-ho a provar d'ací a un moment?";
    }
    return "Disculpa, el tutor está tardando demasiado en responder ahora mismo. ¿Puedes reformular tu mensaje o intentarlo de nuevo en un momento?";
  }

  /*
       ____|___________________________________
   Obj -> | _shouldFinishDeterministically() | -> T/F    (no attributes)
          ----------------------------------
      True only when the exercise may close deterministically: either a
      reasoned correct turn following a prior one, or the cumulative set is
      complete and reasoned with no outstanding errors. Blocked on an
      already-closed exercise, a state mismatch, or a blocked turn type.
  */
  _shouldFinishDeterministically(ctx) {
    const cls = ctx && ctx.classification && ctx.classification.type;
    if (ctx && ctx.exerciseAlreadyClosed) return false;
    if (ctx && Array.isArray(ctx.stateMismatches) && ctx.stateMismatches.length > 0) return false;
    const prevGoodReasoning = (ctx && ctx.loopState && ctx.loopState.prevGoodReasoningTurns) || 0;
    if (cls === "correct_good_reasoning" && prevGoodReasoning >= 1) return true;

    const cum = ctx && ctx.cumulativeAnswer;
    if (cum && cum.closureReady &&
        cum.wronglyNamed.length === 0 && cum.wronglyExcluded.length === 0) {
      const { isExplanationRequest } = require("../services/rag/queryClassifier");
      const turnConcepts = (ctx.classification && ctx.classification.concepts) || [];
      const asksExplanation =
        isExplanationRequest(ctx.userMessage || "") && turnConcepts.length > 0;
      const blocked = cls === "dont_know" || cls === "off_topic" ||
        cls === "greeting" || asksExplanation;
      if (!blocked) return true;
    }
    return false;
  }

  /*
       ____|_____________________
   Obj -> | _normaliseWhitespace() | -> void    (no attributes)
          ------------------------
      Idempotently inserts missing spaces after punctuation and around
      glued clause boundaries, collapses horizontal whitespace and trims
      the lead, repairing qwen2.5 pasted-together sentences.
  */
  _normaliseWhitespace(ctx) {
    const txt = ctx && ctx.finalResponse;
    if (typeof txt !== "string" || txt.length === 0) return;
    let out = txt;
    out = out.replace(/([.!?…])([A-Za-zÁÉÍÓÚÜÑáéíóúüñ¿¡0-9])/g, "$1 $2");
    out = out.replace(/([a-záéíóúñü]{4,})([¿¡])/g, "$1 $2");
    out = out.replace(/([a-záéíóúñü]{4,})([A-ZÁÉÍÓÚÑÜ])(?=[a-záéíóúñü])/g, "$1 $2");
    out = out.replace(/[ \t]+/g, " ");
    out = out.replace(/^\s+/, "");
    if (out !== txt) {
      ctx.finalResponse = out;
      ctx.whitespaceNormalised = true;
    }
  }

  /*
       ____|________________________
   Obj -> | _stripUnauthorizedFinToken() | -> void    (no attributes)
          --------------------------
      Removes a spontaneous <END_EXERCISE> token from the response unless
      the deterministic-finish criterion authorises a close this turn.
  */
  _stripUnauthorizedFinToken(ctx) {
    const FIN = "<END_EXERCISE>";
    const final = ctx && ctx.finalResponse;
    if (typeof final !== "string" || final.indexOf(FIN) === -1) return;
    if (ctx.deterministicFinish) return;
    if (this._shouldFinishDeterministically(ctx)) return;
    ctx.finalResponse = final.split(FIN).join("").trimEnd();
    ctx.finStripped = true;
  }

  /*
       ____|_________________
   Obj -> | _buildFinishMessage() | -> Txt    (no attributes)
          -----------------------
      Returns the localized closure message: congratulate, ask for any
      remaining doubts and append the <END_EXERCISE> token.
  */
  _buildFinishMessage(ctx) {
    const lang = ctx.lang;
    if (lang === "en") {
      return "Excellent work! You've correctly identified the answer and justified it well. Before we close: do you have any remaining doubts about this circuit or the concepts involved? <END_EXERCISE>";
    }
    if (lang === "val") {
      return "Excel·lent treball! Has identificat correctament la resposta i l'has justificat bé. Abans de tancar: tens algun dubte pendent sobre aquest circuit o els conceptes implicats? <END_EXERCISE>";
    }
    return "¡Excelente trabajo! Has identificado correctamente la respuesta y la has justificado bien. Antes de cerrar: ¿te queda alguna duda sobre este circuito o los conceptos implicados? <END_EXERCISE>";
  }
}

module.exports = TutoringOrchestrator;
