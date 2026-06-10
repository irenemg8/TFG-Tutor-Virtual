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
    if (!deps.debugLogger) throw new Error("TutorAgent requires deps.debugLogger");
    this.debugLogger = deps.debugLogger;
  }

  async execute(context) {
    // 1. Build base system prompt
    const basePrompt = this.buildSystemPrompt(context.exercise, context.lang);

    // 1b. Pedagogical priority banner — surface concepts the student
    //    EXPLICITLY used at the TOP of the augmented prompt instead of
    //    burying them inside [DOMAIN KNOWLEDGE]. These concepts (e.g.
    //    "divisor de tensión", "cortocircuito", "serie") are the most
    //    likely vector for an Alternative Conception (AC), so the LLM
    //    weights them more when they appear early in the system prompt.
    const detectedConcepts = (context.classification && context.classification.concepts) || [];
    const acRefs = (context.exercise && context.exercise.tutorContext && context.exercise.tutorContext.acRefs) || [];
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
        "Take the initiative: pick the next concrete step along the global current path that the student has not covered yet. " +
        "Reply with ONE short observable fact about that step (e.g. 'la corriente sale del + de V1 y llega al primer nudo') + ONE simple yes/no or 'where does it go next?' question. " +
        "Use 'esa rama' / 'ese nodo'; do not name elements, do not mention internal labels, do not repeat past questions, do not throw the question back open.\n\n";
      if (sameClsStreak >= 2) {
        dontKnowHint +=
          "[NO-SÉ STREAK x" + (sameClsStreak + 1) + " — DROP A LEVEL] " +
          "Acknowledge in ≤6 words, give TWO concrete facts of the path, then a yes/no question about the next node (no element names).\n\n";
      }
    }

    let demandJustificationHint = "";
    if ((cls === "correct_no_reasoning" || cls === "correct_wrong_reasoning") && prevCorrect >= 1) {
      // NS-31: describir intención, no proporcionar frases literales.
      // Antes el banner contenía "'Explica por qué' / 'Explain why'"
      // como ejemplo, lo cual qwen2.5 7B copia verbatim a la respuesta.
      demandJustificationHint =
        "[DEMAND JUSTIFICATION]\n" +
        "CRITICAL: the student has given the CORRECT elements " + prevCorrect +
        " time(s) without justifying them or with incorrect reasoning.\n" +
        "Do NOT accept the answer as final. Do NOT emit <END_EXERCISE>.\n" +
        "This turn must do exactly two things:\n" +
        "1. A short acknowledgement that they have the right elements (avoid generic praise).\n" +
        "2. ONE Socratic question that forces them to justify their choice using a circuit concept " +
          "(cortocircuito, circuito abierto, divisor de tensión, ley de Ohm, Kirchhoff). " +
          "The question must require a conceptual reason, not a yes/no. Do NOT mention internal labels.\n" +
        "Phrase the question yourself; do not use a fixed template. Refer to the elements " +
          "with their resistor name (e.g. R1) — not generic placeholders.\n\n";
    }

    // 1c-bis. NS-30 — VEREDICTO DEL TURNO (verdad estructurada).
    //    AcDetectorAgent computó context.turnVerdict con la descomposición
    //    canónica per-elemento contra correctAnswer:
    //      hits    = lo que el alumno propuso Y es correcto      → afirmar
    //      errors  = lo que propuso pero NO es correcto          → cuestionar
    //      missing = lo correcto que NO ha mencionado            → pista
    //    Antes el LLM tenía que deducir esto del prompt en prosa y fallaba
    //    sistemáticamente en partial_correct (decía "casi" + repetía R1
    //    sin afirmar nada y sin atacar el error específico). El banner le
    //    entrega la descomposición ya hecha + la estructura obligatoria de
    //    respuesta para qwen2.5 7B. Cuando hay AC fuerte, kgRegistry añade
    //    estrategia + razonamiento experto del catálogo y del KG.
    let verdictBanner = "";
    const verdict = context.turnVerdict;
    // BUG-A1 (2026-06-10): el gate exigía proposed.length>0, así que el veredicto
    // "only_negation" (el alumno SOLO rechazó un elemento que SÍ es correcto,
    // p.ej. "R1 no influye" con R1 correcto) suprimía todo el banner — incluida
    // la instrucción "Wrongly rejected … RETA su rechazo, no cedas". El LLM
    // nunca sabía del rechazo erróneo y podía ceder en silencio (el camino
    // legacy ragPipeline.analyzeStudentElements sí emitía [WRONG REJECTION]).
    // Ahora el banner también se renderiza cuando hay rechazos erróneos.
    if (this._shouldRenderVerdictBanner(verdict)) {
      const { getStrategyForAC, getExpertReasoningForAC } = require("../services/kgRegistry");
      const detectedForBanner = (context.detectedACs || []).filter((a) => a.confidence >= 0.6);
      const topAC = detectedForBanner[0] || null;

      verdictBanner =
        "[VEREDICTO DEL TURNO — verdad estructurada del backend, OBLIGATORIO]\n" +
        "Verdict: " + verdict.verdict + "\n";
      if (verdict.hits.length > 0) {
        verdictBanner +=
          "Hits (lo que el alumno acertó — AFÍRMALO POR NOMBRE en una frase corta): " +
          verdict.hits.join(", ") + "\n";
      }
      if (verdict.errors.length > 0) {
        verdictBanner +=
          "Errors (lo que propuso y NO contribuye — CUESTIÓNALO con UNA pregunta socrática del tipo " +
          "\"¿por qué pensaste que también ___?\", usando su nombre): " + verdict.errors.join(", ") + "\n";
      }
      if (verdict.missing.length > 0) {
        verdictBanner +=
          "Missing (correcto que el alumno no ha tocado — NO lo reveles; si das pista, hazla " +
          "conceptual y sin nombrarlo): " + verdict.missing.join(", ") + "\n";
      }
      if (verdict.wronglyNegated && verdict.wronglyNegated.length > 0) {
        verdictBanner +=
          "Wrongly rejected (correcto que el alumno descartó — RETA su rechazo, no cedas): " +
          verdict.wronglyNegated.join(", ") + "\n";
      }
      if (topAC) {
        const strat = getStrategyForAC(topAC.id);
        const expert = getExpertReasoningForAC(topAC.id);
        if (strat) verdictBanner += "Estrategia (" + topAC.id + " catálogo): " + strat + "\n";
        if (expert) {
          // Trim to ~280 chars: enough conceptual signal without inflating prompt.
          const trimmed = expert.length > 280 ? expert.slice(0, 280).trim() + "…" : expert;
          verdictBanner += "Razonamiento experto (KG, uso INTERNO, NO copies literal): " + trimmed + "\n";
        }
      }

      verdictBanner +=
        "Estructura obligatoria de tu respuesta:\n" +
        "1) UNA frase corta confirmando los Hits por nombre (si los hay). Sin elogio genérico.\n" +
        "2) UNA SOLA pregunta socrática sobre el primer Error (si lo hay), nombrándolo. " +
          "No dos preguntas, no encadenes interrogativos.\n" +
        "3) Si no hay Errors pero sí Missing, da UNA sola pista conceptual sobre un Missing sin nombrarlo.\n" +
        "Total: 1-3 frases cortas, exactamente UN signo de interrogación.\n\n";
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

    // BUG-010-C (2026-05-03): prevenir que el LLM repita LITERALMENTE su
    // última pregunta socrática. La traza real mostraba al tutor pidiendo
    // dos turnos seguidos "¿Podrías decirme a qué nodo está conectada la
    // otra terminal de R1?" — palabras idénticas. Con la pregunta previa
    // entre comillas el LLM tiene una referencia explícita de qué evitar.
    let doNotRepeatHint = "";
    const lastQ = (context.loopState && context.loopState.lastAssistantQuestion) || "";
    if (lastQ && lastQ.length > 10) {
      doNotRepeatHint =
        "[DO NOT REPEAT YOUR PREVIOUS QUESTION]\n" +
        "Your previous Socratic question was LITERALLY:\n" +
        "  «" + lastQ.replace(/\s+/g, " ").trim() + "»\n" +
        "Do NOT repeat that question, even with synonyms. " +
        "If the student didn't answer it, it means the question was unhelpful — " +
        "change angle: ask about a DIFFERENT element, a DIFFERENT property, or " +
        "give a concrete factual hint and ask a yes/no follow-up.\n\n";
    }

    // BUG-011-D (2026-05-03): hechos ya establecidos por el tutor en
    // turnos previos. Antes el LLM confirmaba "Sí, R1 conecta N1 con N2"
    // y al turno siguiente repreguntaba "¿a qué nodo está conectada la
    // otra terminal de R1?" — frustrante para el alumno. Este banner le
    // recuerda al LLM lo que él mismo ya ha dicho y le ordena avanzar.
    let establishedFactsHint = "";
    const establishedFacts =
      (context.loopState && context.loopState.establishedFacts) || [];
    if (establishedFacts.length > 0) {
      establishedFactsHint =
        "[ESTABLISHED FACTS — already confirmed in previous tutor turns]\n" +
        establishedFacts.map(function (f) { return "  • " + f; }).join("\n") +
        "\nDo NOT re-ask about these facts. ADVANCE the analysis: build on " +
        "them to introduce a NEW question about a different element, a " +
        "different property, or the next step in the reasoning chain.\n\n";
    }

    // BUG-007 (2026-05-03): cuando el tutor menciona el MISMO Rn en sus
    // últimas 2-3 preguntas se queda atascado. El banner de abajo le
    // PROHÍBE volver a preguntar sobre ese Rn y le obliga a saltar a otro
    // elemento del netlist.
    let stuckOnElementHint = "";
    const stuckRn = context.loopState && context.loopState.tutorStuckOnElement;
    if (stuckRn) {
      const evaluables = (context.evaluableElements || []).filter(
        (e) => /^R\d+$/i.test(e) && e.toUpperCase() !== stuckRn
      );
      const altRn = evaluables.length > 0 ? evaluables[0] : null;
      stuckOnElementHint =
        "[STUCK ON " + stuckRn + " — STRATEGY MUST CHANGE]\n" +
        "You have asked about " + stuckRn + " in the last 2+ tutor turns. " +
        "The student already understands the position of " + stuckRn + ".\n" +
        "OBLIGATORY this turn:\n" +
        "1. Acknowledge in <6 words what is established about " + stuckRn + ".\n" +
        "2. PIVOT to a DIFFERENT element from the netlist — do NOT mention " +
            stuckRn + " in your next question.\n" +
        (altRn
          ? "3. Suggested pivot target: " + altRn + ". Frame ONE concrete factual " +
            "yes/no question about " + altRn + "'s topology (its terminals, what node " +
            "it connects to, whether it forms a closed path).\n"
          : "3. Frame ONE concrete factual yes/no question about ANOTHER element's topology.\n") +
        "4. NEVER use the verb shape 'explica/describe cómo X afecta/contribuye/influye' — " +
            "that question shape is exhausted.\n" +
        "5. If you cannot find a new angle, say ONE concrete fact about the global " +
            "current path (V1 → ... → 0) and ask whether the student can trace it.\n\n";
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
    // Language directive lives in the system prompt (promptBuilder.js)
    // since the quality regression: burying it in TURN CONTEXT made qwen2.5
    // ignore it under conflicting banners. KV-cache invalidates on language
    // switches now, but switches are rare and reliability matters more.
    //
    // Banner gating: when a Tier-1 banner (structured VERDICT or AC detected
    // with high confidence) is active, it already tells the LLM EXACTLY what
    // to do this turn — generic hints (progress / repetition / strategy /
    // concepts) on top dilute the signal and produce contradictory
    // instructions. qwen2.5 7B kept the first directive it saw and ignored
    // the structured verdict, reverting to repetitive generic questions.
    // Suppressing the generic banners when Tier-1 is on restores focus.
    const hasTier1Banner =
      verdictBanner.length > 0 || acDetectedBanner.length > 0;
    const safeProgressHint = hasTier1Banner ? "" : progressHint;
    const safeRepetitionHint = hasTier1Banner ? "" : repetitionHint;
    const safeStrategyHint = hasTier1Banner ? "" : strategyHint;
    const safeConceptsBanner = acDetectedBanner.length > 0 ? "" : conceptsBanner;

    const dynamicContext =
      verdictBanner +
      acDetectedBanner +
      safeConceptsBanner +
      dontKnowHint +
      demandJustificationHint +
      safeProgressHint +
      safeRepetitionHint +
      doNotRepeatHint +
      establishedFactsHint +
      stuckOnElementHint +
      frustrationHint +
      stuckHint +
      safeStrategyHint +
      (context.ragResult.augmentation || "");

    const userWithContext = dynamicContext.trim().length > 0
      ? "[TURN CONTEXT — apply these instructions to your reply, do not echo them]\n" +
        dynamicContext.trim() +
        "\n[/TURN CONTEXT]\n\n" +
        context.userMessage
      : context.userMessage;

    // For logging / debugging keep the legacy combined view.
    const augmentedPrompt = basePrompt + "\n\n" + dynamicContext;

    // 5. Build messages: stable system + (optional rolling summary) +
    //    recent history + (context-prefixed) user.
    //    The current message is NOT yet persisted (PersistenceAgent writes it
    //    at the end of the pipeline), so we must append it explicitly here or
    //    the LLM would respond without knowing what the student just said.
    //
    //    historySummary (B2) is set by ContextAgent when the session exceeds
    //    HISTORY_MAX_MESSAGES — it's a 200-300-char condensation of the
    //    turns that no longer fit in the live window, fed as a second system
    //    message so the LLM still remembers confirmations from earlier turns
    //    ("te he dicho que R3 no influye"). When the session is short
    //    historySummary is null and this collapses to the pre-B2 shape.
    const summaryBanner = context.historySummary
      ? this._buildSummaryBanner(context.historySummary, context.lang)
      : null;
    const messages = [
      { role: "system", content: basePrompt },
      ...(summaryBanner ? [{ role: "system", content: summaryBanner }] : []),
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
  // BUG-A1 (2026-06-10): extracted so the gate is unit-testable. The verdict
  // banner must render when the student proposed something OR when they wrongly
  // rejected a correct element (verdict "only_negation") — otherwise the
  // "challenge the wrong rejection" instruction never reaches the LLM.
  _shouldRenderVerdictBanner(verdict) {
    if (!verdict) return false;
    const hasProposed = !!(verdict.proposed && verdict.proposed.length > 0);
    const hasWrongRejection = !!(verdict.wronglyNegated && verdict.wronglyNegated.length > 0);
    return hasProposed || hasWrongRejection;
  }

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

  _buildSummaryBanner(summary, lang) {
    const text = (summary || "").trim();
    if (!text) return null;
    if (lang === "val") {
      return "[RESUM DELS TORNS PREVIS NO MOSTRATS]\n" + text
        + "\n\nUtilitza aquest resum per recordar el que l'alumne ja ha confirmat "
        + "i evitar tornar a preguntar el mateix. No el repeteixes en la teua resposta.";
    }
    if (lang === "en") {
      return "[SUMMARY OF EARLIER TURNS NOT SHOWN]\n" + text
        + "\n\nUse this summary to remember what the student has already confirmed "
        + "and to avoid re-asking the same question. Do not echo it back to the student.";
    }
    return "[RESUMEN DE TURNOS PREVIOS NO MOSTRADOS]\n" + text
      + "\n\nUsa este resumen para recordar qué ha confirmado ya el alumno "
      + "y no volver a preguntarle lo mismo. No lo repitas literalmente en tu respuesta.";
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
