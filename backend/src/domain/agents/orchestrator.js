"use strict";

const AgentContext = require("./base/AgentContext");

/**
 * TutoringOrchestrator: Coordinates the agent pipeline for each tutoring interaction.
 *
 * Pipeline stages (each may be skipped based on context):
 * 1. CONTEXT         → Load exercise, history, language, loop state
 * 2. INPUT GUARDRAIL → Block prompt injection / off-topic BEFORE the LLM
 * 3. CLASSIFY        → Classify student message
 * 4. RETRIEVE        → RAG retrieval (BM25 + semantic + KG)
 * 5. TUTOR           → Build prompt + call LLM
 * 6. GUARDRAIL (out) → Validate response safety
 * 7. PERSIST         → Save messages + log
 *
 * Returns an AgentContext with the final response and metadata.
 */
class TutoringOrchestrator {
  /**
   * @param {object} agents - Agent registry
   * @param {import('./contextAgent')} agents.context
   * @param {import('./classifierAgent')} agents.classifier
   * @param {import('./retrievalAgent')} agents.retrieval
   * @param {import('./tutorAgent')} agents.tutor
   * @param {import('./guardrailAgent')} agents.guardrail
   * @param {import('./persistenceAgent')} agents.persistence
   * @param {object} [options]
   * @param {Function} [options.emitEvent] - Event emitter for workflow monitoring
   */
  constructor(agents, options = {}) {
    this.agents = agents;
    this.emitEvent = options.emitEvent || (() => {});
  }

  /**
   * Process a tutoring request through the full agent pipeline.
   *
   * @param {object} request
   * @param {string}      request.userId
   * @param {string}      request.exerciseId
   * @param {string}      request.userMessage
   * @param {string|null} request.interactionId
   * @returns {Promise<AgentContext>}
   */
  async process(request) {
    const ctx = new AgentContext(request);

    // P1c — Budget split per stage. Without this, if retrieval is slow (BM25 +
    // semantic + KG) it eats the whole budget and tutorAgent gets <0ms left,
    // returning a fallback message. Distribution: retrieval ≤30%, tutor ≤60%,
    // guardrails ≤10%. Each agent that supports a budget reads its slice; the
    // ones that don't (retrieval today) just log when they exceed it.
    if (typeof ctx.budgetMs === "number" && ctx.budgetMs > 0) {
      // Budget split with ABSOLUTE caps instead of pure % of total.
      //
      // Observation from production logs against Ollama UPV (2026-05-11):
      // retrieval consistently consumes the full slice (10-11s) and aborts
      // without producing useful augmentation, then the tutor runs against
      // a depleted budget. The bottleneck is the embedding call (query →
      // nomic-embed-text on UPV), not Chroma/BM25 which run locally in
      // <500ms. Giving retrieval more time doesn't help — the embedding
      // either responds or it doesn't.
      //
      // Caps reasoning:
      //  - retrieval ≤ 8s: if the embedding hasn't returned by then, fall
      //    back to BM25-only and move on; do NOT eat into tutor budget.
      //  - guardrails ≤ 5s: surgical phase needs <200ms; LLM retry is
      //    gated separately and only fires for critical violations.
      //  - tutor: whatever's left, minus a 2s safety buffer for the rest
      //    of the pipeline overhead (classify, ac-detect, persistence).
      ctx.retrievalBudgetMs = Math.min(8000, Math.floor(ctx.budgetMs * 0.20));
      ctx.retrievalBudgetMs = Math.max(2000, ctx.retrievalBudgetMs);
      ctx.guardrailBudgetMs = Math.min(5000, Math.floor(ctx.budgetMs * 0.10));
      ctx.guardrailBudgetMs = Math.max(1500, ctx.guardrailBudgetMs);
      const remainingForTutor =
        ctx.budgetMs - ctx.retrievalBudgetMs - ctx.guardrailBudgetMs - 2000;
      ctx.tutorBudgetMs = Math.max(8000, remainingForTutor);
    }

    try {
      // Stage 1: Load context
      this.emitEvent("agent_start", "context", { agent: "contextAgent" });
      await this.agents.context.execute(ctx);
      this.emitEvent("agent_end", "context", { agent: "contextAgent" });

      if (ctx.fallthrough) return ctx;

      // Stage 1.5: AC tracker (parallel with input guardrail).
      // Loads the student's recurring Alternative Conceptions from past
      // results so the TutorAgent can prioritise them when one matches a
      // concept used in this turn. No LLM, just a DB read.
      const acTrackerPromise = this.agents.acTracker
        ? this.agents.acTracker.execute(ctx)
        : Promise.resolve();

      // Stage 2: Input guardrail (prompt injection / off-topic)
      this.emitEvent("agent_start", "input_guardrail", {
        agent: "inputGuardrailAgent",
      });
      await this.agents.inputGuardrail.execute(ctx);
      this.emitEvent("agent_end", "input_guardrail", {
        agent: "inputGuardrailAgent",
        blocked: ctx.inputBlocked,
        category: ctx.inputSecurity?.category,
      });

      // Make sure the AC tracker has finished writing context.userACHistory
      // before any downstream agent (TutorAgent) reads it.
      await acTrackerPromise;

      if (ctx.inputBlocked) {
        ctx.timing.pipelineMs = Date.now() - ctx.timing.pipelineStartMs;
        await this.agents.persistence.execute(ctx);
        return ctx;
      }

      // Stage 3: Classify
      this.emitEvent("agent_start", "classify", { agent: "classifierAgent" });
      await this.agents.classifier.execute(ctx);
      this.emitEvent("agent_end", "classify", {
        agent: "classifierAgent",
        classification: ctx.classification?.type,
      });

      // Stage 3.5: AC detection (per-turn, structural). Cruza la propuesta
      // del alumno contra los acPatterns del ejercicio actual y deja
      // ctx.detectedACs ordenados por confianza para que tutorAgent inyecte
      // el banner [AC DETECTADA] con misconception y estrategia específicas.
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

      // Early exit: greeting or off-topic → let fallback handler deal with it
      if (
        ctx.classification?.type === "greeting" ||
        ctx.classification?.type === "off_topic"
      ) {
        ctx.fallthrough = true;
        return ctx;
      }

      // Stage 3: Retrieve
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
        // Notify the SSE layer so the frontend can log the degradation.
        // The LLM will still respond but without semantic augmentation.
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

      // Check for deterministic finish
      if (this._shouldFinishDeterministically(ctx)) {
        ctx.deterministicFinish = true;
        ctx.finalResponse = this._buildFinishMessage(ctx);
        ctx.timing.pipelineMs = Date.now() - ctx.timing.pipelineStartMs;

        // Save and return
        await this.agents.persistence.execute(ctx);
        return ctx;
      }

      // Stage 4: Generate (Tutor)
      this.emitEvent("agent_start", "tutor", { agent: "tutorAgent" });
      await this.agents.tutor.execute(ctx);
      this.emitEvent("agent_end", "tutor", { agent: "tutorAgent" });

      // Stage 4.5: Pedagogical reviewer — deterministic style/scaffolding
      // fixes BEFORE the safety guardrails. Replaces the legacy adapters
      // PrematureConfirmation / DidacticExplanation / DatasetStyle in the
      // default GUARDRAIL_PROFILE (legacy profile keeps them inside the
      // pipeline for A/B comparison).
      if (this.agents.pedagogicalReviewer) {
        this.emitEvent("agent_start", "pedagogical_reviewer", { agent: "pedagogicalReviewerAgent" });
        await this.agents.pedagogicalReviewer.execute(ctx);
        this.emitEvent("agent_end", "pedagogical_reviewer", {
          agent: "pedagogicalReviewerAgent",
          corrections: ctx.pedagogicalCorrectionsApplied || [],
        });
      }

      // Stage 5: Validate (Guardrail)
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

      // Last-resort safety net: if the LLM emitted <END_EXERCISE> in a
      // turn that should NOT close the exercise (i.e. classification is not
      // correct_good_reasoning OR we haven't accumulated enough correct
      // turns), strip the token so the frontend doesn't end the session
      // prematurely. The legacy ragMiddleware did this; without it the
      // orchestrator path could close mid-conversation.
      this._stripUnauthorizedFinToken(ctx);
      this._normaliseWhitespace(ctx);

      ctx.timing.pipelineMs = Date.now() - ctx.timing.pipelineStartMs;

      // Stage 6: Persist
      await this.agents.persistence.execute(ctx);

      return ctx;
    } catch (error) {
      console.error("[Orchestrator] Pipeline error:", error.message);
      ctx.error = error;
      // Always set a friendly fallback so the SSE handler has something to
      // send. The previous behavior left ctx.finalResponse empty on LLM
      // timeouts, which made the chat stay blank with no signal to the user.
      if (!ctx.finalResponse) {
        ctx.finalResponse = this._buildFallbackMessage(ctx);
        ctx.fallbackUsed = true;
      }
      return ctx;
    }
  }

  /**
   * Friendly message shown when the pipeline fails (typically LLM timeout
   * against the UPV Ollama server). Localized to the conversation language.
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

  /**
   * Check if the exercise should be finished deterministically.
   * We ONLY finish when the student has shown good reasoning — never on
   * "correct_no_reasoning" or "correct_wrong_reasoning" alone, even after
   * many turns. This enforces "justify before validating" pedagogically.
   *
   * Threshold raised to 2 prior correct turns (was 1) so a single
   * misclassification of "correct_good_reasoning" can no longer close the
   * exercise prematurely.
   */
  _shouldFinishDeterministically(ctx) {
    const cls = ctx && ctx.classification && ctx.classification.type;
    // We require at least ONE prior correct_good_reasoning turn so the
    // exercise closes only after the student justified TWICE (this turn +
    // a previous one). The old check used prevCorrectTurns which counted
    // partial_correct / correct_no_reasoning too — leading to premature
    // closures the very first time the student finally gave a good answer.
    const prevGoodReasoning = (ctx && ctx.loopState && ctx.loopState.prevGoodReasoningTurns) || 0;
    return cls === "correct_good_reasoning" && prevGoodReasoning >= 1;
  }

  /**
   * Defense in depth: strip <END_EXERCISE> from the LLM output unless the
   * orchestrator's own deterministic-finish criteria are met
   * (correct_good_reasoning + ≥2 prior correct turns). The legacy path did
   * this in ragMiddleware:981-986; the orchestrator path was missing it,
   * so the LLM could close the session by emitting the token on its own.
   */
  /**
   * Defense in depth against qwen2.5 occasionally producing pasted-together
   * sentences like "...avances!ese elemento..." or "...importante.Vamos a..."
   * (no space after punctuation). We also fix this when guardrails substitute
   * a sentence into the response without a leading space. Idempotent: never
   * collapses legitimate whitespace, only inserts when missing.
   */
  _normaliseWhitespace(ctx) {
    const txt = ctx && ctx.finalResponse;
    if (typeof txt !== "string" || txt.length === 0) return;
    let out = txt;
    // 1. Insert a space after sentence terminators that are immediately
    //    followed by an uppercase / lowercase letter or "¿"/"¡"/digit.
    out = out.replace(/([.!?…])([A-Za-zÁÉÍÓÚÜÑáéíóúüñ¿¡0-9])/g, "$1 $2");
    // 1b. Insert a space when a 4+ char lowercase run is glued to the start of
    //     a new clause. BUG-ORC (2026-06-10): the old rule split before ANY
    //     uppercase, so it could also break a legitimately-glued uppercase RUN
    //     (acronyms) or a lone capital. We now only split in the two cases that
    //     are unambiguously concat errors:
    //       (i)  glued to an opening "¿"/"¡" (an opener never glues legitimately)
    //       (ii) glued to a Title-case word start (uppercase FOLLOWED BY
    //            lowercase, e.g. "identificarAhora") — not before an acronym
    //            run ("DC"/"AC") nor a lone capital.
    out = out.replace(/([a-záéíóúñü]{4,})([¿¡])/g, "$1 $2");
    out = out.replace(/([a-záéíóúñü]{4,})([A-ZÁÉÍÓÚÑÜ])(?=[a-záéíóúñü])/g, "$1 $2");
    // 2. Collapse runs of whitespace to a single space (but keep newlines).
    out = out.replace(/[ \t]+/g, " ");
    // 3. Trim leading whitespace.
    out = out.replace(/^\s+/, "");
    if (out !== txt) {
      ctx.finalResponse = out;
      ctx.whitespaceNormalised = true;
    }
  }

  _stripUnauthorizedFinToken(ctx) {
    const FIN = "<END_EXERCISE>";
    const final = ctx && ctx.finalResponse;
    if (typeof final !== "string" || final.indexOf(FIN) === -1) return;
    if (ctx.deterministicFinish) return;
    const cls = ctx.classification && ctx.classification.type;
    const prevGoodReasoning = (ctx.loopState && ctx.loopState.prevGoodReasoningTurns) || 0;
    const authorized = cls === "correct_good_reasoning" && prevGoodReasoning >= 1;
    if (authorized) return;
    ctx.finalResponse = final.split(FIN).join("").trimEnd();
    ctx.finStripped = true;
  }

  /**
   * Closure message: congratulate, ask for remaining doubts, and mark
   * <END_EXERCISE> so the frontend closes the session. The student can
   * still ask follow-up questions in the same chat; those are re-evaluated
   * by the pipeline on the next turn.
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
