"use strict";

const AgentInterface = require("./base/AgentInterface");

/**
 * TutorAgent: Builds the augmented prompt and calls the LLM.
 * Includes loop-breaking hints, frustration detection, and conversation progress.
 *
 * Hex compliance: pipeline trace/debug logger is injected via constructor
 * (deps.debugLogger). Falls back to require() if not injected so legacy
 * callers don't break — the container DOES inject it to keep the domain
 * layer free of `require("../../infrastructure/...")` calls.
 */
class TutorAgent extends AgentInterface {
  /**
   * @param {object} deps
   * @param {import('../ports/services/ILlmService')} deps.llmService
   * @param {Function} deps.buildSystemPrompt - buildTutorSystemPrompt from promptBuilder.js
   * @param {object} deps.config
   * @param {object} [deps.debugLogger] - IPipelineLogger adapter (preferred)
   */
  constructor(deps) {
    super("tutorAgent");
    this.llmService = deps.llmService;
    this.buildSystemPrompt = deps.buildSystemPrompt;
    this.config = deps.config;
    // Lazy fallback only triggered if the container forgets to inject. Domain
    // code should not normally reach into infrastructure.
    this.debugLogger = deps.debugLogger ||
      require("../../infrastructure/events/pipelineDebugLogger");
  }

  async execute(context) {
    // 1. Build base system prompt
    const basePrompt = this.buildSystemPrompt(context.ejercicio, context.lang);

    // 1b. Pedagogical priority banner — surface concepts the student
    //    EXPLICITLY used at the TOP of the augmented prompt instead of
    //    burying them inside [DOMAIN KNOWLEDGE]. These concepts (e.g.
    //    "divisor de tensión", "cortocircuito", "serie") are the most
    //    likely vector for an Alternative Conception (AC), so the LLM
    //    weights them more when they appear early in the system prompt.
    const detectedConcepts = (context.classification && context.classification.concepts) || [];
    const acRefs = (context.ejercicio && context.ejercicio.tutorContext && context.ejercicio.tutorContext.ac_refs) || [];
    let conceptsBanner = "";
    if (detectedConcepts.length > 0 || acRefs.length > 0) {
      conceptsBanner = "[PEDAGOGICAL PRIORITY — STUDENT-MENTIONED CONCEPTS]\n";
      if (detectedConcepts.length > 0) {
        conceptsBanner +=
          "The student explicitly used these concept(s): " + detectedConcepts.join(", ") + ".\n" +
          "Address these concepts directly in your Socratic question. If their use suggests an " +
          "Alternative Conception (AC), focus your question on challenging that specific concept " +
          "rather than asking about specific elements.\n";
      }
      if (acRefs.length > 0) {
        conceptsBanner +=
          "Relevant ACs for this exercise: " + acRefs.join(", ") + ". " +
          "If the student's reasoning aligns with any of them, prioritise the corresponding " +
          "Socratic strategy from the [DOMAIN KNOWLEDGE] block below.\n";
      }
      conceptsBanner += "\n";
    }

    // 2. Build conversation progress hint
    const progressHint = this._buildProgressHint(context.history);

    // 3. Build loop-breaking hints
    let repetitionHint = "";
    if (context.loopState.tutorRepeating) {
      repetitionHint =
        "[ANTI-REPETITION] You have been asking the same question repeatedly. " +
        "Change your approach: try a different angle, give a concrete hint, " +
        "or ask about a different aspect of the problem.\n\n";
    }

    let frustrationHint = "";
    if (context.loopState.studentFrustrated) {
      frustrationHint =
        "[STUDENT FRUSTRATED] The student is expressing frustration. " +
        "Acknowledge their effort, be encouraging, and provide a more " +
        "concrete hint to help them make progress.\n\n";
    }

    let stuckHint = "";
    const { consecutiveWrongTurns, totalAssistantTurns } = context.loopState;
    const MAX_WRONG_STREAK = this.config.MAX_WRONG_STREAK || 4;
    const MAX_TOTAL_TURNS = this.config.MAX_TOTAL_TURNS || 16;

    if (
      consecutiveWrongTurns >= MAX_WRONG_STREAK ||
      totalAssistantTurns >= MAX_TOTAL_TURNS
    ) {
      stuckHint =
        "[LOOP BREAKING - SCAFFOLD] The student has been stuck for too long. " +
        "Provide a very concrete hint: name a specific concept to review, " +
        "or narrow down the problem significantly. " +
        "Do NOT repeat the same question.\n\n";
    }

    // 4. Strategy-change hint: when the SAME classification fires for several
    //    turns in a row, the tutor is in a soft loop (the previous Socratic
    //    nudge isn't moving the student). Force a change of approach instead
    //    of repeating the same kind of question.
    let strategyHint = this._buildStrategyHint(
      context.classification && context.classification.type,
      context.loopState.sameClassificationStreak || 0,
      context.loopState.lastClassification
    );

    // 5. Combine all into augmented prompt.
    //    Order matters: conceptsBanner first so the student's own words land
    //    at the top of the system prompt, where the LLM weights them most.
    const augmentedPrompt =
      basePrompt +
      "\n\n" +
      conceptsBanner +
      progressHint +
      repetitionHint +
      frustrationHint +
      stuckHint +
      strategyHint +
      (context.ragResult.augmentation || "");

    // 5. Build messages: system + history + CURRENT user message.
    //    The current message is NOT yet persisted (PersistenceAgent writes it
    //    at the end of the pipeline), so we must append it explicitly here or
    //    the LLM would respond without knowing what the student just said.
    const messages = [
      { role: "system", content: augmentedPrompt },
      ...context.history,
      { role: "user", content: context.userMessage },
    ];
    context.llmMessages = messages;

    this.debugLogger.logPrompt(augmentedPrompt, context.classification?.type);
    const trace = this.debugLogger;
    trace.traceLlmCall(context.reqId, "start", {
      model: this.config.OLLAMA_MODEL,
      messagesCount: messages.length,
      promptLen: augmentedPrompt.length,
      reason: "primary",
    });

    // 6. Call LLM — propagate the TUTOR slice of the budget when the
    //    orchestrator (P1c) splits it per stage. Falls back to "remaining
    //    total" for backwards compatibility when no per-stage budget is set.
    const ollamaStart = Date.now();
    const elapsed = Date.now() - context.timing.pipelineStartMs;
    const stageBudget = context.tutorBudgetMs;
    const totalRemaining = context.budgetMs != null
      ? Math.max(0, context.budgetMs - elapsed)
      : undefined;
    const remainingBudget = stageBudget != null
      ? Math.min(stageBudget, totalRemaining != null ? totalRemaining : stageBudget)
      : totalRemaining;
    context.llmResponse = await this.llmService.chatCompletion(messages, {
      temperature: this.config.OLLAMA_TEMPERATURE,
      numPredict: this.config.OLLAMA_NUM_PREDICT,
      numCtx: this.config.OLLAMA_NUM_CTX,
      budgetMs: remainingBudget,
    });
    context.timing.ollamaMs = Date.now() - ollamaStart;

    trace.traceLlmCall(context.reqId, "end", {
      durationMs: context.timing.ollamaMs,
      responseLen: (context.llmResponse || "").length,
      reason: "primary",
      response: context.llmResponse,
    });
    this.debugLogger.logLlmOut(context.llmResponse);
  }

  /**
   * Build a strategy-change instruction when the same classification has
   * fired ≥2 turns in a row. The current classification AND the prior one
   * must match for this to fire — that means the student is responding the
   * same way and the tutor's previous question didn't move them.
   *
   * Hints are written in English (same convention as the other hints) but
   * instruct the LLM to respond in the student's language. The body of the
   * hint differs per classification type so the escalation is appropriate
   * to the situation:
   *   - correct_no_reasoning: stop asking conceptual questions; ask the
   *     student to justify ONE specific element they already named.
   *   - wrong_answer / wrong_concept / single_word: stop asking the same
   *     Socratic question; offer a concrete CONCEPT-level partial hint.
   *   - dont_know: stop asking generic questions; introduce a concrete
   *     definitional anchor and ask the student to react.
   */
  _buildStrategyHint(currentType, streak, lastType) {
    if (!currentType || streak < 2) return "";
    if (lastType && lastType !== currentType) return "";

    if (currentType === "correct_no_reasoning") {
      return (
        "[ESCALATE — STUDENT REPEATS CORRECT ANSWER WITHOUT JUSTIFYING " +
        "(streak=" + streak + ")]\n" +
        "The student gave the right answer multiple times but never explained " +
        "WHY. Stop asking general concept questions. Pick ONE element the " +
        "STUDENT named in their last message and ask 'Why specifically that " +
        "one and not another?' or 'Walk me through how you decided that.' " +
        "Do NOT ask a question that could be answered with another bare list " +
        "of elements. Do NOT name elements yourself.\n\n"
      );
    }
    if (currentType === "wrong_answer" || currentType === "wrong_concept" || currentType === "single_word") {
      return (
        "[ESCALATE — STUDENT IS STUCK ON WRONG TRACK (streak=" + streak + ")]\n" +
        "The student has given the same kind of wrong answer multiple times. " +
        "Stop reusing the same Socratic angle. Offer a CONCRETE partial hint " +
        "about ONE underlying concept (e.g., what happens when current finds " +
        "a path with no resistance, or what constraint a closed circuit " +
        "needs). Do NOT name any element. Do NOT confirm anything.\n\n"
      );
    }
    if (currentType === "dont_know") {
      return (
        "[ESCALATE — STUDENT KEEPS SAYING THEY DON'T KNOW (streak=" + streak + ")]\n" +
        "Generic Socratic questions are not landing. Anchor the conversation " +
        "with a concrete definitional reminder of ONE concept that's directly " +
        "relevant (e.g., what 'circuit closed' or 'voltage between two nodes' " +
        "actually means) and then ask the student to apply it to the schematic. " +
        "Do NOT name any element.\n\n"
      );
    }
    return "";
  }

  _buildProgressHint(history) {
    if (!Array.isArray(history) || history.length < 2) return "";

    let lastAssistant = null;
    for (let i = history.length - 1; i >= 0; i--) {
      if (history[i].role === "assistant") {
        lastAssistant = history[i].content;
        break;
      }
    }
    if (!lastAssistant) return "";

    const questions = lastAssistant.match(/[^.!?]*\?/g);
    const lastQuestion =
      questions && questions.length > 0
        ? questions[questions.length - 1].trim()
        : null;
    if (!lastQuestion) return "";

    return (
      "[CONVERSATION CONTEXT]\n" +
      'Your last question to the student was: "' +
      lastQuestion +
      '"\n' +
      "Evaluate the student's current response as an answer to THIS question.\n" +
      "If they answered it correctly, acknowledge and advance. Do NOT re-ask.\n\n"
    );
  }
}

module.exports = TutorAgent;
