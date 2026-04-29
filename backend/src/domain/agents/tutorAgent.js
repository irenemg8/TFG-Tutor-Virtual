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
          "Test their use of the concept by asking a question about how it applies to THIS circuit. " +
          "NEVER ask the student to define the concept (no 'define X', no 'what do you understand by Y'). " +
          "If their use suggests an Alternative Conception (AC), challenge that specific concept rather " +
          "than asking about specific elements.\n";
      }
      if (acRefs.length > 0) {
        conceptsBanner +=
          "Relevant ACs for this exercise: " + acRefs.join(", ") + ". " +
          "If the student's reasoning aligns with any of them, prioritise the corresponding " +
          "Socratic strategy from the [DOMAIN KNOWLEDGE] block below.\n";
      }
      conceptsBanner += "\n";
    }

    // 1b-bis. Recurrent AC banner: when the student is showing a concept
    //         this turn that matches one of their TOP recurring ACs from
    //         past sessions, surface it loudly. AcTrackerAgent populates
    //         context.userACHistory; we cross-reference it with concepts
    //         the classifier just detected and with the exercise's ac_refs
    //         so we don't shout about ACs unrelated to this exercise.
    const userHistory = (context.userACHistory && context.userACHistory.topACs) || [];
    if (userHistory.length > 0 && (detectedConcepts.length > 0 || acRefs.length > 0)) {
      const acRefsLower = acRefs.map(function (a) { return String(a).toLowerCase(); });
      const conceptsLower = detectedConcepts.map(function (c) { return String(c).toLowerCase(); });
      const recurrent = [];
      for (let i = 0; i < userHistory.length; i++) {
        const tag = String(userHistory[i].ac).toLowerCase();
        const matchesExerciseAc = acRefsLower.indexOf(tag) >= 0;
        const matchesConcept = conceptsLower.some(function (c) { return tag.indexOf(c) >= 0 || c.indexOf(tag) >= 0; });
        if (matchesExerciseAc || matchesConcept) {
          recurrent.push(userHistory[i]);
        }
      }
      if (recurrent.length > 0) {
        conceptsBanner +=
          "[RECURRENT AC FOR THIS USER]\n" +
          "This student has hit the following AC(s) before across past sessions: " +
          recurrent.map(function (r) { return r.ac + " (×" + r.count + ")"; }).join(", ") + ".\n" +
          "The signal is strong: focus your Socratic question on challenging that AC " +
          "rather than asking generic questions. Do NOT name elements or reveal states.\n\n";
      }
    }

    // 1c. Pedagogical safety banners that the legacy ragMiddleware injected
    //    but that were lost in the hexagonal refactor. Each one is a hard
    //    instruction tied to a specific classification/state combination.
    const cls = context.classification && context.classification.type;
    const prevCorrect = (context.loopState && context.loopState.prevCorrectTurns) || 0;

    let dontKnowHint = "";
    if (cls === "dont_know") {
      dontKnowHint =
        "[STUDENT DOESN'T KNOW]\n" +
        "CRITICAL: The student just said they don't know. You MUST:\n" +
        "- NOT explain concepts. NOT give definitions. NOT say 'this means that...' or 'when a resistor is X, then Y'.\n" +
        "- NOT reveal internal states (short-circuited, open, same potential, etc.).\n" +
        "- Lower the scaffolding: ask ONE simpler, more concrete question about a VISIBLE feature of the circuit (e.g. 'Look at where the two terminals of one of the elements are connected. Do you notice anything?').\n" +
        "- Keep the response to a SINGLE question, no preamble, no explanation.\n\n";
    }

    let demandJustificationHint = "";
    if ((cls === "correct_no_reasoning" || cls === "correct_wrong_reasoning") && prevCorrect >= 1) {
      demandJustificationHint =
        "[DEMAND JUSTIFICATION]\n" +
        "CRITICAL: The student has given the CORRECT elements " + prevCorrect +
        " time(s) WITHOUT justifying them, or with INCORRECT reasoning.\n" +
        "You MUST NOT accept the answer as final. You MUST NOT emit <FIN_EJERCICIO>.\n" +
        "Your ONLY task this turn is:\n" +
        "1. Briefly acknowledge they have the right elements (do NOT say 'Perfect' / 'Correcto').\n" +
        "2. Ask DIRECTLY: 'Explica por qué' / 'Explain why', requiring them to use a concept such as cortocircuito, circuito abierto, divisor de tensión, ley de Ohm or Kirchhoff.\n" +
        "3. Do NOT name the correct elements in your question. Use generic wording like 'esos elementos' / 'those elements'.\n" +
        "4. Do NOT provide the reasoning yourself. The student must produce it.\n\n";
    }

    // 2. Build conversation progress hint
    const progressHint = this._buildProgressHint(context.history);

    // 3. Build loop-breaking hints
    let repetitionHint = "";
    if (context.loopState.tutorRepeating) {
      repetitionHint =
        "[ANTI-LOOP]\n" +
        "CRITICAL: You have been asking similar questions repeatedly and the student is stuck.\n" +
        "DO NOT ask any question you have asked before. Instead:\n" +
        "1. Briefly acknowledge what the student has said correctly so far.\n" +
        "2. Give a CONCRETE HINT about the circuit (without revealing the answer).\n" +
        "3. Ask a NEW, DIFFERENT question that the student has NOT been asked before.\n\n";
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
      dontKnowHint +
      demandJustificationHint +
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
   *   - wrong_answer / wrong_concept: stop asking the same Socratic
   *     question; offer a concrete CONCEPT-level partial hint.
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
    if (currentType === "wrong_answer" || currentType === "wrong_concept") {
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
