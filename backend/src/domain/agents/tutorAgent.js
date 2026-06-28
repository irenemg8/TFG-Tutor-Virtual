"use strict";

const AgentInterface = require("./base/AgentInterface");

/*------------------------------------------------------------------------------
            _________________________________________________________
            |                       TUTOR AGENT                     |
            |  Builds the augmented prompt (base system prompt +    |
            |  many context-gated pedagogical banners + RAG         |
            |  augmentation) and calls the LLM, with loop-breaking, |
            |  frustration and progress hints, KV-cache-friendly    |
            |  message splitting and optional token streaming.      |
        ____|________________                                       |
   Obj -> | constructor() | -> TutorAgent           (writes attrs)  |
          -----------------                                         |
            |                                                       |
            |   llmService: Obj         buildSystemPrompt: Fn       |
            |   config: Obj             debugLogger: Obj            |
        ____|___________                                            |
   Obj -> | execute() | -> Promise<void>             (reads attrs)  |
          -----------                                               |
        ____|_______________________________                        |
   Obj -> | _shouldRenderVerdictBanner() | -> T/F     (no attrs)    |
          --------------------------------                          |
        ____|____________________                                   |
   Txt,Z,Txt -> | _buildStrategyHint() | -> Txt       (reads attrs) |
                ----------------------                              |
        ____|____________________                                   |
   Txt,Txt -> | _buildSummaryBanner() | -> Txt | null  (no attrs)   |
              -----------------------                               |
        ____|_______________________                                |
   Obj,Txt,T/F,T/F -> | _buildCumulativeBanner() | -> Txt (no attrs)|
                      --------------------------                    |
        ____|_______________________                                |
   [Obj],Z -> | _recentTutorQuestions() | -> [Txt]     (no attrs)   |
              ---------------------------                           |
        ____|___________________                                    |
   [Obj] -> | _buildProgressHint() | -> Txt            (no attrs)   |
            ----------------------                                  |
            |                                                       |
            |_______________________________________________________|
------------------------------------------------------------------------------*/
class TutorAgent extends AgentInterface {
  /*
   Obj -> ____|________________
         | constructor() | -> TutorAgent    (writes attributes llmService (Obj),
          -----------------                  buildSystemPrompt (Fn), config (Obj),
                                             debugLogger (Obj))
      Stores the injected LLM service, prompt builder, config and the
      required pipeline debug logger (kept on the domain side via DI).
  */
  constructor(deps) {
    super("tutorAgent");
    this.llmService = deps.llmService;
    this.buildSystemPrompt = deps.buildSystemPrompt;
    this.config = deps.config;
    if (!deps.debugLogger) throw new Error("TutorAgent requires deps.debugLogger");
    this.debugLogger = deps.debugLogger;
  }

  /*
       ____|___________
   Obj -> | execute() | -> Promise<void>    (reads attributes buildSystemPrompt (Fn),
          -----------                        config (Obj), llmService (Obj),
                                             debugLogger (Obj))
      Assembles the base system prompt plus all context-gated banners and
      hints, splits stable/volatile content for KV-cache reuse, calls the
      LLM (streaming when a token handler is present) and records the
      response and timing onto the context.
  */
  async execute(context) {
    const basePrompt = this.buildSystemPrompt(context.exercise, context.lang);

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

    const cls = context.classification && context.classification.type;
    const prevCorrect = (context.loopState && context.loopState.prevCorrectTurns) || 0;

    const sameClsStreak = (context.loopState && context.loopState.sameClassificationStreak) || 0;

    const { isExplanationRequest } = require("../services/rag/queryClassifier");
    const turnConcepts = (context.classification && context.classification.concepts) || [];
    const asksExplanation =
      isExplanationRequest(context.userMessage || "") && turnConcepts.length > 0;

    let explanationHint = "";
    if (asksExplanation) {
      explanationHint =
        "[STUDENT ASKS YOU TO EXPLAIN A CONCEPT]\n" +
        "The student is asking YOU to explain: " + turnConcepts.join(", ") + ". " +
        "Do NOT ignore this and do NOT restart the analysis from the voltage source. " +
        "In 1-2 short sentences give a concrete, intuitive idea of that concept AS IT APPLIES " +
        "TO THIS CIRCUIT — without revealing which elements are the answer, any element's state, " +
        "or the topology — then ask ONE simple question that lets the student apply it to the " +
        "step you are currently on.\n\n";
    }

    let dontKnowHint = "";
    if (cls === "dont_know" && !asksExplanation) {
      dontKnowHint =
        "[STUDENT DOESN'T KNOW]\n" +
        "Take the initiative: pick the next concrete step along the global current path that the student has NOT covered yet — continue from where the conversation already is, do NOT restart from the voltage source if you already advanced past it. " +
        "Reply with ONE short observable fact about that next step + ONE simple yes/no or 'where does it go next?' question. Vary your wording from previous turns. " +
        "Use 'esa rama' / 'ese nodo'; do not name elements, do not mention internal labels, do not repeat past questions, do not throw the question back open.\n\n";
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

    let verdictBanner = "";
    const verdict = context.turnVerdict;
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
      const cumNamed = (context.cumulativeAnswer && context.cumulativeAnswer.namedCorrect) || [];
      const effectiveMissing = verdict.missing.filter(function (m) {
        return cumNamed.indexOf(String(m).toUpperCase()) < 0;
      });
      if (effectiveMissing.length > 0) {
        verdictBanner +=
          "Missing (correcto que el alumno aún NO ha mencionado — NO lo reveles ni lo nombres). " +
          "PROHIBIDO preguntar '¿por qué [X] no influye / no contribuye?': eso afirma una FALSEDAD " +
          "sobre un elemento que SÍ importa, y el alumno NO lo ha negado. Para guiarle, invítale a " +
          "CONSIDERAR la rama entera, p.ej. '¿has tenido en cuenta TODAS las resistencias conectadas " +
          "a ese nodo?': " + effectiveMissing.join(", ") + "\n";
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

    const cum = context.cumulativeAnswer;
    const turnHasNewErrors = !!(verdict &&
      ((verdict.errors && verdict.errors.length > 0) ||
       (verdict.wronglyNegated && verdict.wronglyNegated.length > 0)));
    const cumulativeBanner = this._buildCumulativeBanner(
      cum, context.lang, context.exerciseAlreadyClosed, turnHasNewErrors
    );

    let acDetectedBanner = "";
    const detectedACs = (context.detectedACs || []).filter((a) => a.confidence >= 0.6);
    if (detectedACs.length > 0) {
      const ac = detectedACs[0];
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

    let stateMismatchBanner = "";
    const stateMismatches = context.stateMismatches || [];
    if (stateMismatches.length > 0) {
      const sm = stateMismatches[0];
      const saidEs = sm.said === "short" ? "en cortocircuito" : "en circuito abierto";
      stateMismatchBanner =
        "[ESTADO CONFUNDIDO — PRIORIDAD MÁXIMA, IGNORA OTROS HINTS]\n" +
        "El alumno ha atribuido a " + sm.element + " un estado que NO le corresponde: afirma que está " + saidEs + ".\n" +
        "Aunque quizá excluya bien " + sm.element + ", el MOTIVO es erróneo: NO se lo confirmes, NO le felicites, NO digas '¡Bien!'.\n" +
        "Cuestiónaselo de forma socrática: invítale a mirar los terminales de " + sm.element +
        " (y el interruptor, si lo hubiera) en el netlist y a reconsiderar qué estado tiene realmente. " +
        "NUNCA reveles tú el estado correcto. UNA sola pregunta, corta.\n\n";
    }

    const progressHint = this._buildProgressHint(context.history);

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

    let doNotRepeatHint = "";
    const lastQ = (context.loopState && context.loopState.lastAssistantQuestion) || "";
    const recentQs = this._recentTutorQuestions(context.history, 3);
    const askedList = recentQs.length > 0
      ? recentQs
      : (lastQ && lastQ.length > 10 ? [lastQ.replace(/\s+/g, " ").trim()] : []);
    if (askedList.length > 0) {
      doNotRepeatHint =
        "[NO REPITAS TUS PREGUNTAS ANTERIORES]\n" +
        "Ya has hecho estas preguntas:\n" +
        askedList.map(function (q) { return "  • «" + q + "»"; }).join("\n") + "\n" +
        "PROHIBIDO repetir cualquiera de ellas, aunque sea: (a) reformulada con otras palabras, " +
        "(b) con la MISMA estructura aplicada a otro elemento (p.ej. '¿por qué no influye R5?' → " +
        "'¿por qué no influye R3?'), o (c) la misma idea general ('¿por qué las otras no influyen?'). " +
        "Si el alumno sigue atascado, esa pregunta NO le está ayudando: CAMBIA de táctica de verdad — " +
        "da UN hecho concreto del circuito (sin revelar la respuesta ni los estados) y pregunta algo simple de sí/no, " +
        "o pídele que justifique UN elemento concreto que él ya nombró. Nunca devuelvas la misma pregunta abierta.\n\n";
    }

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

    let strategyHint = this._buildStrategyHint(
      context.classification && context.classification.type,
      context.loopState.sameClassificationStreak || 0,
      context.loopState.lastClassification
    );

    const cumulativeIsTier1 = !!(cum && cum.complete && cum.stillMissing.length === 0);
    const hasTier1Banner =
      verdictBanner.length > 0 || acDetectedBanner.length > 0 || cumulativeIsTier1 ||
      stateMismatchBanner.length > 0;
    const safeProgressHint = hasTier1Banner ? "" : progressHint;
    const safeRepetitionHint = hasTier1Banner ? "" : repetitionHint;
    const safeStrategyHint = hasTier1Banner ? "" : strategyHint;
    const safeConceptsBanner = acDetectedBanner.length > 0 ? "" : conceptsBanner;

    const dynamicContext =
      stateMismatchBanner +
      explanationHint +
      cumulativeBanner +
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

    const augmentedPrompt = basePrompt + "\n\n" + dynamicContext;

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
    if (
      typeof context.tokenStreamHandler === "function" &&
      typeof this.llmService.chatCompletionStreamWithCallback === "function"
    ) {
      let firstTokenAt = null;
      const onToken = (token) => {
        if (firstTokenAt == null) firstTokenAt = Date.now();
        context.streamedText += token;
        try { context.tokenStreamHandler(token); } catch (_) { }
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

  /*
       ____|_______________________________
   Obj -> | _shouldRenderVerdictBanner() | -> T/F    (no attributes)
          --------------------------------
      True when the verdict banner should render: the student proposed an
      element OR wrongly rejected a correct one (only_negation), so the
      challenge instruction always reaches the LLM.
  */
  _shouldRenderVerdictBanner(verdict) {
    if (!verdict) return false;
    const hasProposed = !!(verdict.proposed && verdict.proposed.length > 0);
    const hasWrongRejection = !!(verdict.wronglyNegated && verdict.wronglyNegated.length > 0);
    return hasProposed || hasWrongRejection;
  }

  /*
   Txt,Z,Txt -> ____|____________________
                | _buildStrategyHint() | -> Txt    (reads no attributes)
                ----------------------
      Returns a per-classification escalation hint when the same
      classification has fired >=2 turns in a row (and matches the prior
      turn), forcing a change of Socratic approach. Returns "" otherwise.
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

  /*
   Txt,Txt -> ____|____________________
              | _buildSummaryBanner() | -> Txt | null    (no attributes)
              -----------------------
      Wraps the rolling history summary (set by ContextAgent on long
      sessions) in a localized banner so the LLM still remembers earlier
      confirmations. Returns null when there is no summary.
  */
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

  /*
   Obj,Txt,T/F,T/F -> ____|_______________________
                      | _buildCumulativeBanner() | -> Txt    (no attributes)
                      --------------------------
      Pure, localized (es/val/en) banner summarising the session-level
      progress: which correct elements are named, which are excluded, and
      whether to consolidate/close, answer a follow-up, or keep advancing.
  */
  _buildCumulativeBanner(cum, lang, alreadyClosed, turnHasNewErrors) {
    if (!cum || (cum.namedCorrect.length === 0 && cum.excluded.length === 0)) return "";
    const L = (lang === "val" || lang === "en") ? lang : "es";
    const T = {
      es: {
        head: "[PROGRESO ACUMULADO — memoria de toda la sesión, OBLIGATORIO respetarlo]\n",
        named: function (x) { return "El alumno YA ha identificado correctamente, en turnos anteriores: " + x + ". Da esto por ESTABLECIDO. NO vuelvas a preguntar si están en el camino ni por su topología — ya está resuelto.\n"; },
        excl: function (x) { return "El alumno YA ha excluido correctamente: " + x + ". No re-preguntes por su exclusión.\n"; },
        closure: "El alumno ha nombrado el conjunto correcto COMPLETO y ha razonado las exclusiones. Cierra con un reconocimiento breve y comprueba si le queda alguna duda. NO abras nuevas preguntas de topología.\n",
        complete: "El conjunto correcto está COMPLETO. NO sigas interrogando elemento por elemento. Tu única tarea ahora: pedir UNA consolidación del razonamiento que aún falte (por qué se excluyen los elementos restantes), con UNA sola pregunta conceptual.\n",
        partial: "Aún falta por identificar algún elemento correcto (no lo reveles). Avanza hacia él sin volver sobre los ya establecidos.\n",
      },
      val: {
        head: "[PROGRÉS ACUMULAT — memòria de tota la sessió, OBLIGATORI respectar-lo]\n",
        named: function (x) { return "L'alumne JA ha identificat correctament, en torns anteriors: " + x + ". Dóna-ho per ESTABLERT. NO tornes a preguntar si estan en el camí ni per la seua topologia — ja està resolt.\n"; },
        excl: function (x) { return "L'alumne JA ha exclòs correctament: " + x + ". No tornes a preguntar per la seua exclusió.\n"; },
        closure: "L'alumne ha anomenat el conjunt correcte COMPLET i ha raonat les exclusions. Tanca amb un reconeixement breu i comprova si li queda algun dubte. NO òbrigues noves preguntes de topologia.\n",
        complete: "El conjunt correcte està COMPLET. NO continues interrogant element per element. La teua única tasca ara: demanar UNA consolidació del raonament que encara falte (per què s'exclouen els elements restants), amb UNA sola pregunta conceptual.\n",
        partial: "Encara falta per identificar algun element correcte (no el reveles). Avança cap a ell sense tornar sobre els ja establerts.\n",
      },
      en: {
        head: "[CUMULATIVE PROGRESS — memory of the whole session, MUST be respected]\n",
        named: function (x) { return "The student has ALREADY correctly identified, in earlier turns: " + x + ". Treat this as ESTABLISHED. Do NOT ask again whether they are in the path or about their topology — it is resolved.\n"; },
        excl: function (x) { return "The student has ALREADY correctly excluded: " + x + ". Do not re-ask about their exclusion.\n"; },
        closure: "The student has named the COMPLETE correct set and reasoned the exclusions. Close with a brief acknowledgement and check for remaining doubts. Do NOT open new topology questions.\n",
        complete: "The correct set is COMPLETE. Do NOT keep interrogating element by element. Your only task now: ask for ONE consolidation of the reasoning that is still missing (why the remaining elements are excluded), with a SINGLE conceptual question.\n",
        partial: "There is still a correct element left to identify (do not reveal it). Advance toward it without revisiting what is already established.\n",
        closed: "The exercise was ALREADY closed in a previous turn — do NOT congratulate or close again. Simply answer the student's current follow-up briefly and clearly, without re-interrogating the settled elements.\n",
      },
    }[L];
    const CLOSED = {
      es: "El ejercicio YA se cerró en un turno anterior — NO felicites ni cierres otra vez. Responde brevemente a la consulta actual del alumno, sin re-interrogar los elementos ya resueltos.\n",
      val: "L'exercici JA es va tancar en un torn anterior — NO felicites ni tanques una altra vegada. Respon breument a la consulta actual de l'alumne, sense tornar a interrogar els elements ja resolts.\n",
      en: T.closed,
    };

    let banner = T.head;
    if (cum.namedCorrect.length > 0) banner += T.named(cum.namedCorrect.join(", "));
    if (cum.excluded.length > 0) banner += T.excl(cum.excluded.join(", "));
    if (alreadyClosed) {
      banner += CLOSED[L];
    } else if (cum.complete && cum.stillMissing.length === 0) {
      if (!turnHasNewErrors) {
        banner += cum.closureReady ? T.closure : T.complete;
      }
    } else if (cum.stillMissing.length > 0 && cum.namedCorrect.length > 0) {
      banner += T.partial;
    }
    return banner + "\n";
  }

  /*
   [Obj],Z -> ____|_______________________
              | _recentTutorQuestions() | -> [Txt]    (no attributes)
              ---------------------------
      Returns up to N distinct Socratic questions the tutor has asked, most
      recent first, so the anti-repetition hint can show more than just the
      immediately-previous question.
  */
  _recentTutorQuestions(history, n) {
    if (!Array.isArray(history)) return [];
    const out = [];
    const seen = new Set();
    for (let i = history.length - 1; i >= 0 && out.length < (n || 3); i--) {
      if (history[i].role !== "assistant") continue;
      const matches = (history[i].content || "").match(/[^.!?]*\?/g);
      if (!matches || matches.length === 0) continue;
      const q = matches[matches.length - 1].replace(/\s+/g, " ").trim();
      const key = q.toLowerCase();
      if (q.length > 8 && !seen.has(key)) { seen.add(key); out.push(q); }
    }
    return out;
  }

  /*
   [Obj] -> ____|___________________
            | _buildProgressHint() | -> Txt    (no attributes)
            ----------------------
      Surfaces the tutor's last up-to-2 questions in a banner instructing
      the LLM to evaluate the student's reply against them and to vary
      wording and angle on the next question. Returns "" when none.
  */
  _buildProgressHint(history) {
    if (!Array.isArray(history) || history.length < 2) return "";

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
