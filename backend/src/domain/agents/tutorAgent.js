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

    const sameClsStreak = (context.loopState && context.loopState.sameClassificationStreak) || 0;

    let dontKnowHint = "";
    if (cls === "dont_know") {
      // Compact form (NS-22). The full pattern + 3 example sentences had
      // ballooned this hint to ~1200 chars per request — paid every turn the
      // student says "no sé". The system prompt already enforces "1-3 short
      // sentences, ONE question, never name elements, never define concepts".
      dontKnowHint =
        "[STUDENT DOESN'T KNOW]\n" +
        "Pick the next step from EXPERT REASONING that they have not covered. " +
        "State it as ONE short fact + ONE simple question about that step. " +
        "Use 'esa rama' / 'ese nodo'; do not name elements or repeat past questions.\n\n";
      if (sameClsStreak >= 2) {
        dontKnowHint +=
          "[NO-SÉ STREAK x" + (sameClsStreak + 1) + " — DROP A LEVEL] " +
          "Acknowledge in ≤6 words, give TWO concrete facts of the path, then a yes/no question about the next node (no element names).\n\n";
      }
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

    // 1d. AC DETECTADA banner — el AcDetectorAgent cruzó la propuesta del
    //    alumno con los acPatterns del ejercicio y devolvió matches por
    //    confianza. Cuando hay un match fuerte (>= 0.6) inyectamos el
    //    misconception y la estrategia específica para que el LLM no se
    //    quede en preguntas genéricas y aborde el error real del alumno.
    let acDetectedBanner = "";
    const detectedACs = (context.detectedACs || []).filter((a) => a.confidence >= 0.6);
    if (detectedACs.length > 0) {
      const ac = detectedACs[0];
      // Extract the SPECIFIC element this AC flags (R3, R5, R1...) so the
      // tutor can name it under the system-prompt EXCEPTION clause. Falls
      // back to "ese elemento" if the misconception text doesn't mention one.
      const elementMatch = (ac.misconception || "").match(/R\d+|V\d+|I\d+/i);
      const targetElement = elementMatch ? elementMatch[0].toUpperCase() : null;
      const proposed = (context.classification && context.classification.proposed) || [];
      const correct = context.correctAnswer || [];
      const correctlyProposed = proposed.filter((p) => correct.indexOf(p) >= 0);
      const wronglyProposed = proposed.filter((p) => correct.indexOf(p) < 0);

      acDetectedBanner =
        "[AC DETECTADA EN ESTE TURNO — PRIORIDAD MÁXIMA, IGNORA OTROS HINTS GENÉRICOS]\n" +
        "El alumno está mostrando " + ac.id + ": " + ac.name + ".\n" +
        "Misconception concreta: " + ac.misconception + "\n";
      if (correctlyProposed.length > 0) {
        acDetectedBanner +=
          "Elementos bien propuestos: " + correctlyProposed.join(", ") +
          ". RECONÓCELOS explícitamente y diles brevemente por qué SÍ contribuyen (sin revelar estados).\n";
      }
      if (wronglyProposed.length > 0) {
        acDetectedBanner +=
          "Elementos mal propuestos: " + wronglyProposed.join(", ") +
          ". CUESTIÓNALOS específicamente.\n";
      }
      acDetectedBanner +=
        "Estrategia obligatoria: " + ac.strategy + "\n" +
        "PUEDES nombrar " + (targetElement || "ese elemento concreto") +
        " en tu pregunta — el system prompt te lo permite cuando hay AC detectada.\n" +
        "Mantén la pregunta corta y socrática. NO repitas la pregunta del turno anterior.\n\n";
      if (detectedACs.length > 1) {
        acDetectedBanner +=
          "[AC SECUNDARIA] También aparece " + detectedACs[1].id + " (" + detectedACs[1].name + "). " +
          "Trata la principal ahora y deja la secundaria para el siguiente turno.\n\n";
      }
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
        "[STUDENT FRUSTRATED — ACKNOWLEDGE + CHANGE ANGLE]\n" +
        "El alumno está mostrando frustración (\"te he dicho que\", \"ya lo he dicho\", etc.).\n" +
        "OBLIGATORIO en esta respuesta:\n" +
        "1. Empieza acusando recibo de su frustración con UNA frase corta y empática (\"Entiendo que insistas en eso, vamos a verlo juntos paso a paso.\"). NO le digas \"tienes razón\" si no la tiene.\n" +
        "2. CAMBIA EL ÁNGULO respecto a tu última pregunta — si antes preguntaste por los terminales, ahora pregunta por una propiedad del netlist; si antes pediste justificar, ahora da UN hecho concreto del expert reasoning y pregunta sí/no.\n" +
        "3. NO repitas literalmente tu pregunta anterior. NO uses las mismas palabras de apertura.\n" +
        "4. Mantén la posición pedagógica si el alumno se equivoca — un alumno frustrado por una respuesta equivocada necesita cambio de explicación, NO que cedas.\n\n";
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

    // 5. Split content into STABLE (system) and VOLATILE (per-turn) parts so
    //    Ollama can reuse its KV-cache across turns. Production telemetry
    //    showed every turn paid ~15s of "prefill" because the entire system
    //    prompt changed each request (different banners, different RAG hits)
    //    — Ollama could never reuse the cached prefix and recomputed all
    //    ~1700 tokens from scratch.
    //
    //    The base prompt (rules + circuit topology) is identical for every
    //    turn of the same exercise. Putting only that in `system` lets
    //    Ollama cache it once. Banners + RAG augmentation move into the
    //    last user message, prefixed with a clear delimiter so the LLM
    //    still treats them as instructions.
    // Language directive lives here (not in the system prompt) so the
    // system block stays identical across language switches and Ollama
    // can KV-cache reuse the prefix between turns of the same exercise.
    // See languageManager.getLanguageRules for the per-lang content.
    const { getLanguageRules } = require("../services/languageManager");
    const langBanner =
      "[LANGUAGE]\n" + getLanguageRules(context.lang || "es") + "\n\n";

    const dynamicContext =
      langBanner +
      acDetectedBanner +
      conceptsBanner +
      dontKnowHint +
      demandJustificationHint +
      progressHint +
      repetitionHint +
      frustrationHint +
      stuckHint +
      strategyHint +
      (context.ragResult.augmentation || "");

    const userWithContext = dynamicContext.trim().length > 0
      ? "[TURN CONTEXT — apply these instructions to your reply, do not echo them]\n" +
        dynamicContext.trim() +
        "\n[/TURN CONTEXT]\n\n" +
        context.userMessage
      : context.userMessage;

    // For logging / debugging keep the legacy combined view.
    const augmentedPrompt = basePrompt + "\n\n" + dynamicContext;

    // 5. Build messages: stable system + history + (context-prefixed) user.
    //    The current message is NOT yet persisted (PersistenceAgent writes it
    //    at the end of the pipeline), so we must append it explicitly here or
    //    the LLM would respond without knowing what the student just said.
    const messages = [
      { role: "system", content: basePrompt },
      ...context.history,
      { role: "user", content: userWithContext },
    ];
    context.llmMessages = messages;

    this.debugLogger.logPrompt(augmentedPrompt, context.classification?.type);
    const trace = this.debugLogger;
    trace.traceLlmCall(context.reqId, "start", {
      model: this.config.OLLAMA_MODEL,
      messagesCount: messages.length,
      promptLen: augmentedPrompt.length,
      systemLen: basePrompt.length,
      turnContextLen: dynamicContext.length,
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
    const llmOptions = {
      temperature: this.config.OLLAMA_TEMPERATURE,
      numPredict: this.config.OLLAMA_NUM_PREDICT,
      numCtx: this.config.OLLAMA_NUM_CTX,
      budgetMs: remainingBudget,
    };
    // When the HTTP adapter installed a tokenStreamHandler we use the
    // native Ollama stream and emit one SSE envelope per token, so the
    // user sees text appearing live instead of waiting 10-25s. The
    // accumulated full text is still returned for the downstream
    // pedagogicalReviewer + guardrail stages, which need the complete
    // message before they can validate or rewrite it.
    if (
      typeof context.tokenStreamHandler === "function" &&
      typeof this.llmService.chatCompletionStreamWithCallback === "function"
    ) {
      let firstTokenAt = null;
      const onToken = (token) => {
        if (firstTokenAt == null) firstTokenAt = Date.now();
        context.streamedText += token;
        try { context.tokenStreamHandler(token); } catch (_) { /* never let SSE errors crash the pipeline */ }
      };
      context.llmResponse = await this.llmService.chatCompletionStreamWithCallback(
        messages,
        llmOptions,
        onToken
      );
      if (firstTokenAt != null) context.timing.firstTokenMs = firstTokenAt - ollamaStart;
    } else {
      context.llmResponse = await this.llmService.chatCompletion(messages, llmOptions);
    }
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

    // Recoge las ÚLTIMAS hasta 2 preguntas del tutor (en turnos distintos)
    // para que el LLM pueda contrastar y NO repetir literalmente. La regla
    // "NEVER repeat a question" del system prompt no se cumple a menos que
    // la pregunta concreta esté visible en el turn-context.
    const recentQuestions = [];
    for (let i = history.length - 1; i >= 0 && recentQuestions.length < 2; i--) {
      if (history[i].role !== "assistant") continue;
      const content = history[i].content || "";
      const matches = content.match(/[^.!?]*\?/g);
      if (matches && matches.length > 0) {
        recentQuestions.push(matches[matches.length - 1].trim());
      }
    }
    if (recentQuestions.length === 0) return "";

    let block = "[CONVERSATION CONTEXT — DO NOT REPEAT THESE QUESTIONS]\n";
    block += 'Your last question to the student was: "' + recentQuestions[0] + '"\n';
    if (recentQuestions.length >= 2) {
      block += 'Two turns ago you also asked: "' + recentQuestions[1] + '"\n';
    }
    block +=
      "Evaluate the student's current response as an answer to those questions.\n" +
      "If they answered correctly, acknowledge and advance — do NOT re-ask.\n" +
      "If their answer is wrong/partial, your NEXT question MUST differ in wording AND in angle from the questions above (different concept, different node, or a more concrete level).\n\n";
    return block;
  }
}

module.exports = TutorAgent;
