"use strict";

const AgentInterface = require("./base/AgentInterface");

/**
 * ContextAgent: Loads all data needed for the tutoring interaction.
 * Populates: exercise, exerciseNum, correctAnswer, evaluableElements,
 * history, lang, loopState in the AgentContext.
 *
 * Extracted from ragMiddleware.js lines 170-336, 371-504
 */
class ContextAgent extends AgentInterface {
  /**
   * @param {object} deps
   * @param {import('../ports/repositories/IEjercicioRepository')} deps.ejercicioRepo
   * @param {import('../ports/repositories/IInteraccionRepository')} deps.interaccionRepo
   * @param {import('../ports/repositories/IMessageRepository')} deps.messageRepo
   * @param {object} deps.config - RAG config
   */
  constructor(deps) {
    super("contextAgent");
    this.ejercicioRepo = deps.ejercicioRepo;
    this.interaccionRepo = deps.interaccionRepo;
    this.messageRepo = deps.messageRepo;
    this.config = deps.config;
    // Required. When the conversation exceeds HISTORY_MAX_MESSAGES, ContextAgent
    // calls summarize() on the older tail and exposes context.historySummary for
    // TutorAgent to inject as a second system message.
    // Use NullHistorySummarizer when summarization is intentionally disabled.
    if (!deps.historySummarizer) throw new Error("ContextAgent requires deps.historySummarizer");
    this.historySummarizer = deps.historySummarizer;
  }

  async execute(context) {
    // 1. Load exercise
    const ejercicio = await this.ejercicioRepo.findById(context.exerciseId);
    if (!ejercicio || !ejercicio.hasValidTutorContext()) {
      context.fallthrough = true;
      return;
    }
    context.exercise = ejercicio;
    context.exerciseNum = ejercicio.getExerciseNumber();
    context.correctAnswer = ejercicio.getCorrectAnswer();
    context.evaluableElements = ejercicio.getEvaluableElements();

    // Canonical exercise number for retrieval. Two exercises that share the
    // same dataset file (e.g. ex.1 and ex.2 both use dataset_exercise_1.json)
    // also share the same ChromaDB collection — so retrieval must use the
    // FIRST exercise number that maps to that dataset, otherwise the search
    // hits an empty collection and degrades silently to BM25 only. The legacy
    // ragMiddleware did this; the orchestrator path was missing it.
    context.canonicalExerciseNum = this._canonicalExerciseNum(context.exerciseNum);

    // 2. Load or create interaccion
    if (context.interactionId) {
      const exists = await this.interaccionRepo.existsForUser(
        context.interactionId,
        context.userId
      );
      if (!exists) context.interactionId = null;
    }
    if (!context.interactionId) {
      const interaccion = await this.interaccionRepo.create({
        userId: context.userId,
        exerciseId: context.exerciseId,
      });
      context.interactionId = interaccion.id;
    }

    // 3. Load conversation history.
    //    When the session is longer than HISTORY_MAX_MESSAGES we still want
    //    the LLM to remember earlier confirmations ("te he dicho que R3 no
    //    influye"), so we fetch ALL messages, keep the last N as the live
    //    history, and (if a summariser is wired) condense the older tail
    //    into context.historySummary. TutorAgent injects that summary as a
    //    second system message before the live history.
    const maxMessages = this.config.HISTORY_MAX_MESSAGES || 20;
    const allMessages = await this.messageRepo.getAllMessages(context.interactionId);
    let recentMessages;
    let olderMessages;
    if (allMessages.length > maxMessages) {
      const splitIdx = allMessages.length - maxMessages;
      olderMessages = allMessages.slice(0, splitIdx);
      recentMessages = allMessages.slice(splitIdx);
    } else {
      olderMessages = [];
      recentMessages = allMessages;
    }
    context.history = recentMessages.map((m) => m.toOllamaFormat());

    // 4. Resolve language BEFORE summarising so the summary is generated in
    //    the language of the conversation (not a default).
    const historyWithCurrent = context.userMessage
      ? context.history.concat([{ role: "user", content: context.userMessage }])
      : context.history;
    context.lang = this._resolveLanguage(historyWithCurrent);

    // 4b. Summarise the older tail. Best-effort: if the summariser call fails
    //     (network error, LLM timeout) the turn proceeds with just the recent
    //     window so a flaky LLM can never block the chat.
    context.historySummary = null;
    if (olderMessages.length > 0) {
      try {
        const olderForLlm = olderMessages.map((m) => m.toOllamaFormat());
        context.historySummary = await this.historySummarizer.summarize(
          olderForLlm, context.lang, context.interactionId
        );
      } catch (err) {
        // Swallow — the chat must keep working even if summarisation breaks.
        context.historySummary = null;
      }
    }

    // 5. Compute loop state
    const correctTypes = [
      "correct_no_reasoning",
      "correct_wrong_reasoning",
      "correct_good_reasoning",
      "partial_correct",
    ];
    const wrongTypes = ["wrong_answer", "wrong_concept"];

    const [
      prevCorrectTurns,
      prevGoodReasoningTurns,
      consecutiveWrongTurns,
      totalAssistantTurns,
      lastAssistantMessages,
    ] = await Promise.all([
      this._countClassifications(context.interactionId, correctTypes),
      // STRICT count: only correct_good_reasoning counts towards
      // _shouldFinishDeterministically. partial_correct, correct_no_reasoning
      // and correct_wrong_reasoning are NOT enough to close the exercise —
      // the student must give the right elements WITH a justification (real
      // reasoning) at least twice in a row before we end the session.
      this._countClassifications(context.interactionId, ["correct_good_reasoning"]),
      this.messageRepo.countConsecutiveFromEnd(
        context.interactionId,
        wrongTypes
      ),
      this.messageRepo.countAssistantMessages(context.interactionId),
      this.messageRepo.getLastAssistantMessages(context.interactionId, 4),
    ]);

    const tutorRepeating = this._detectRepetition(lastAssistantMessages);
    const studentFrustrated = this._detectFrustration(context.userMessage);
    const lastClassificationStreak = await this._lastClassificationStreak(
      context.interactionId
    );
    // BUG-007 (2026-05-03): cuando el tutor menciona el MISMO Rn en sus
    // últimas 2-3 preguntas se queda en bucle conceptual sobre ese
    // elemento, ignorando que el alumno ya respondió a la topología y
    // pidió pasar a otro tema. tutorStuckOnElement = el Rn dominante en
    // las últimas 3 preguntas si aparece >= 2 veces; null si no hay
    // dominante claro.
    const tutorStuckOnElement = this._detectStuckOnElement(lastAssistantMessages);
    // BUG-010-C (2026-05-03): la pregunta socrática literal del último
    // turno del tutor para que el banner de tutorAgent pueda decirle al
    // LLM "NO repitas exactamente esta pregunta: «...»". Sin esto el LLM
    // a veces produce respuestas idénticas turno-tras-turno.
    const lastAssistantQuestion = this._extractLastQuestion(lastAssistantMessages);
    // BUG-011-D (2026-05-03): hechos ya establecidos por el tutor en turnos
    // previos (afirmaciones tipo "Sí, R1 conecta N1 con N2"). El alumno
    // se frustraba cuando el tutor confirmaba algo y al turno siguiente
    // repreguntaba sobre lo mismo. Usamos esto para inyectar un banner
    // ESTABLISHED FACTS que ordena al LLM avanzar en vez de repetir.
    const establishedFacts = this._extractEstablishedFacts(lastAssistantMessages);

    context.loopState = {
      prevCorrectTurns,
      prevGoodReasoningTurns,
      consecutiveWrongTurns,
      totalAssistantTurns,
      tutorRepeating,
      studentFrustrated,
      tutorStuckOnElement,
      lastAssistantQuestion,
      establishedFacts,
      // { type, streak } — how many consecutive prior assistant turns shared
      // the same classification. Used by TutorAgent to escalate strategy
      // when the same situation repeats (e.g. correct_no_reasoning x3).
      lastClassification: lastClassificationStreak.type,
      sameClassificationStreak: lastClassificationStreak.streak,
    };
  }

  // BUG-007: detecta cuando el tutor está obsesionado con el mismo Rn.
  // Examina las preguntas (último '?' de cada mensaje del tutor) en los
  // últimos N mensajes; si el mismo Rn aparece ≥2 veces → devuelve ese Rn.
  // Si hay múltiples Rn empatados → devuelve el más reciente.
  _detectStuckOnElement(lastAssistantMessages) {
    if (!Array.isArray(lastAssistantMessages) || lastAssistantMessages.length < 2) {
      return null;
    }
    const counts = {};
    let mostRecent = null;
    for (let i = 0; i < lastAssistantMessages.length; i++) {
      const m = lastAssistantMessages[i];
      const content = (m && m.content) || "";
      // Extrae el último fragmento interrogativo del mensaje.
      const qs = content.match(/[^.!?]*\?/g);
      const lastQ = qs && qs.length > 0 ? qs[qs.length - 1] : "";
      const rns = lastQ.match(/\bR\d+\b/gi);
      if (!rns) continue;
      const seenInThisQ = {};
      for (let k = 0; k < rns.length; k++) {
        const rn = rns[k].toUpperCase();
        if (seenInThisQ[rn]) continue;
        seenInThisQ[rn] = true;
        counts[rn] = (counts[rn] || 0) + 1;
        mostRecent = rn;
      }
    }
    let best = null;
    let bestCount = 1;
    const keys = Object.keys(counts);
    for (let i = 0; i < keys.length; i++) {
      const k = keys[i];
      if (counts[k] > bestCount) { best = k; bestCount = counts[k]; }
    }
    if (best == null) return null;
    return best; // Rn que apareció >=2 veces en preguntas recientes.
  }

  /**
   * Count how many of the most recent assistant messages share the SAME
   * metadata.classification value, walking backwards from the end of the
   * conversation. Returns { type, streak }. If there are no assistant
   * messages with classification metadata, returns { type: null, streak: 0 }.
   */
  async _lastClassificationStreak(interactionId) {
    const all = await this.messageRepo.getAllMessages(interactionId);
    let last = null;
    let streak = 0;
    for (let i = all.length - 1; i >= 0; i--) {
      const m = all[i];
      if (!m.isAssistant() || !m.metadata || !m.metadata.classification) continue;
      const cls = m.metadata.classification;
      if (last === null) {
        last = cls;
        streak = 1;
        continue;
      }
      if (cls === last) {
        streak++;
      } else {
        break;
      }
    }
    return { type: last, streak };
  }

  _resolveLanguage(history) {
    // Delegate to the conservative resolver: only USER messages are inspected,
    // and the switch must be EXPLICIT (e.g. "parla en valencià", "speak in
    // english"). This prevents the previous bug where the tutor accidentally
    // emitting one Catalan word ("però") permanently flipped the conversation
    // to Valencian — which would also swap the system prompt to Valencian and
    // make the LLM keep responding in Valencian.
    const { resolveLanguage } = require("../services/languageManager");
    return resolveLanguage(history);
  }

  async _countClassifications(interactionId, types) {
    const messages = await this.messageRepo.getAllMessages(interactionId);
    let count = 0;
    for (const msg of messages) {
      if (
        msg.isAssistant() &&
        msg.metadata?.classification &&
        types.includes(msg.metadata.classification)
      ) {
        count++;
      }
    }
    return count;
  }

  // BUG-011-D: extrae afirmaciones que el tutor ya ha establecido en
  // turnos previos. Heurística regex sobre frases assistant que:
  //   - empiezan por "Sí, R\d+ ..." (confirmación explícita), o
  //   - contienen "R\d+ (está|conecta|forma|es) ..." en cláusula afirmativa
  // Devuelve hasta 5 hechos únicos en orden de aparición (más antiguo
  // primero). No es un parser semántico — es una red de seguridad
  // pragmática para que el banner ESTABLISHED FACTS recuerde al LLM lo
  // que ya ha dicho él mismo.
  _extractEstablishedFacts(lastAssistantMessages) {
    if (!Array.isArray(lastAssistantMessages) || lastAssistantMessages.length === 0) {
      return [];
    }
    const facts = [];
    const seen = new Set();
    // Match assertive sentences in indicative present, terminated by .!? (no ?).
    // Capturing '?' in the terminator was producing false positives: questions
    // like "¿R1 está entre N1 y N2?" were extracted as established "facts",
    // and the LLM saw its own prior questions echoed back as confirmed truths,
    // which broke the Socratic flow. We now require '.' or '!' as terminator
    // AND we reject any candidate containing '?' or '¿' anywhere.
    const FACT_RE = /(?:^|[.!\n]\s*|sí[,]\s*)((?:R\d+|N\d+)[^.!?¿\n]{0,120}?(?:está|conecta|forma|es parte|es la|es el|se conecta|se sitúa|sale|llega)[^.!?¿\n]{0,80}[.!\n])/gi;
    // Question-opening words (Spanish + Valencian + English). If the fact
    // candidate starts with one of these, it's almost certainly a question
    // the tutor asked, not a confirmed fact.
    const QUESTION_OPENERS = /^(si\b|qu[eé]\b|c[oó]mo\b|cu[aá]l\b|cu[aá]ndo\b|d[oó]nde\b|por\s+qu[eé]\b|crees\b|puedes\b|sabes\b|què\b|com\b|quin\b|on\b|what\b|how\b|where\b|when\b|why\b|do\s+you\b|can\s+you\b)/i;
    // Hypothetical / future / conditional markers: drop facts in subjunctive
    // or conditional clauses, which are speculation, not established truth.
    const HYPOTHETICAL = /\b(podr[íi]a|ser[íi]a|si\s+conect|si\s+est|imagina|supongam|hipot[eé]ti|condicional|would|could|might)/i;
    for (let i = 0; i < lastAssistantMessages.length; i++) {
      const m = lastAssistantMessages[i];
      const content = (m && m.content) || "";
      let match;
      FACT_RE.lastIndex = 0;
      while ((match = FACT_RE.exec(content)) !== null) {
        const raw = match[1].trim().replace(/\s+/g, " ");
        if (/[?¿]/.test(raw)) continue;
        if (QUESTION_OPENERS.test(raw)) continue;
        if (HYPOTHETICAL.test(raw)) continue;
        const key = raw.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        facts.push(raw);
        if (facts.length >= 5) return facts;
      }
    }
    return facts;
  }

  // BUG-010-C: extrae la pregunta socrática literal más reciente del tutor
  // (último "?" del mensaje assistant más reciente que tenga uno). Devuelve
  // string trimmed o "" si no hay.
  _extractLastQuestion(lastAssistantMessages) {
    if (!Array.isArray(lastAssistantMessages) || lastAssistantMessages.length === 0) {
      return "";
    }
    // Recorrer del más reciente al más antiguo.
    for (let i = lastAssistantMessages.length - 1; i >= 0; i--) {
      const m = lastAssistantMessages[i];
      const content = (m && m.content) || "";
      const qs = content.match(/[¿]?[^.!?]*\?/g);
      if (qs && qs.length > 0) {
        return qs[qs.length - 1].trim();
      }
    }
    return "";
  }

  _detectRepetition(lastAssistantMessages) {
    if (lastAssistantMessages.length < 2) return false;

    const questions = lastAssistantMessages
      .map((m) => {
        const qs = m.content.match(/[^.!?]*\?/g);
        return qs && qs.length > 0
          ? qs[qs.length - 1].toLowerCase().trim()
          : "";
      })
      .filter((q) => q.length > 0);

    if (questions.length < 2) return false;

    for (let a = 0; a < questions.length; a++) {
      for (let b = a + 1; b < questions.length; b++) {
        const sim = this._questionSimilarity(questions[a], questions[b]);
        if (sim > 0.5) return true;
      }
    }
    return false;
  }

  _questionSimilarity(qa, qb) {
    const wordsA = qa.split(/\s+/).filter((w) => w.length > 3);
    const wordsB = qb.split(/\s+/).filter((w) => w.length > 3);
    if (wordsA.length === 0) return 0;
    const overlap = wordsA.filter((w) => wordsB.includes(w)).length;
    return overlap / wordsA.length;
  }

  _canonicalExerciseNum(exerciseNum) {
    if (exerciseNum == null) return exerciseNum;
    const map = this.config && this.config.CANONICAL_EXERCISE_MAP;
    if (!map) return exerciseNum;
    return map[exerciseNum] ?? exerciseNum;
  }

  _detectFrustration(message) {
    // Use the multilingual frustration dictionary from languageManager so any
    // phrase added there propagates to the orchestrator path. Previously this
    // method had a hardcoded list that drifted behind the legacy ragMiddleware.
    const { getAllPatterns, frustrationPatterns } = require("../services/languageManager");
    const lower = (message || "").toLowerCase();
    const patterns = getAllPatterns(frustrationPatterns);
    for (let i = 0; i < patterns.length; i++) {
      if (lower.includes(patterns[i])) return true;
    }
    return false;
  }
}

module.exports = ContextAgent;
