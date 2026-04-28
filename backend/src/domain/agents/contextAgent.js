"use strict";

const AgentInterface = require("./base/AgentInterface");

/**
 * ContextAgent: Loads all data needed for the tutoring interaction.
 * Populates: ejercicio, exerciseNum, correctAnswer, evaluableElements,
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
  }

  async execute(context) {
    // 1. Load exercise
    const ejercicio = await this.ejercicioRepo.findById(context.exerciseId);
    if (!ejercicio || !ejercicio.hasValidTutorContext()) {
      context.fallthrough = true;
      return;
    }
    context.ejercicio = ejercicio;
    context.exerciseNum = ejercicio.getExerciseNumber();
    context.correctAnswer = ejercicio.getCorrectAnswer();
    context.evaluableElements = ejercicio.getEvaluableElements();

    // 2. Load or create interaccion
    if (context.interaccionId) {
      const exists = await this.interaccionRepo.existsForUser(
        context.interaccionId,
        context.userId
      );
      if (!exists) context.interaccionId = null;
    }
    if (!context.interaccionId) {
      const interaccion = await this.interaccionRepo.create({
        usuarioId: context.userId,
        ejercicioId: context.exerciseId,
      });
      context.interaccionId = interaccion.id;
    }

    // 3. Load conversation history
    const maxMessages = this.config.HISTORY_MAX_MESSAGES || 6;
    const messages = await this.messageRepo.getLastMessages(
      context.interaccionId,
      maxMessages
    );
    context.history = messages.map((m) => m.toOllamaFormat());

    // 4. Resolve language
    context.lang = this._resolveLanguage(context.history);

    // 5. Compute loop state
    const correctTypes = [
      "correct_no_reasoning",
      "correct_wrong_reasoning",
      "correct_good_reasoning",
      "partial_correct",
    ];
    const wrongTypes = ["wrong_answer", "wrong_concept", "single_word"];

    const [
      prevCorrectTurns,
      consecutiveWrongTurns,
      totalAssistantTurns,
      lastAssistantMessages,
    ] = await Promise.all([
      this._countClassifications(context.interaccionId, correctTypes),
      this.messageRepo.countConsecutiveFromEnd(
        context.interaccionId,
        wrongTypes
      ),
      this.messageRepo.countAssistantMessages(context.interaccionId),
      this.messageRepo.getLastAssistantMessages(context.interaccionId, 4),
    ]);

    const tutorRepeating = this._detectRepetition(lastAssistantMessages);
    const studentFrustrated = this._detectFrustration(context.userMessage);
    const lastClassificationStreak = await this._lastClassificationStreak(
      context.interaccionId
    );

    context.loopState = {
      prevCorrectTurns,
      consecutiveWrongTurns,
      totalAssistantTurns,
      tutorRepeating,
      studentFrustrated,
      // { type, streak } — how many consecutive prior assistant turns shared
      // the same classification. Used by TutorAgent to escalate strategy
      // when the same situation repeats (e.g. correct_no_reasoning x3).
      lastClassification: lastClassificationStreak.type,
      sameClassificationStreak: lastClassificationStreak.streak,
    };
  }

  /**
   * Count how many of the most recent assistant messages share the SAME
   * metadata.classification value, walking backwards from the end of the
   * conversation. Returns { type, streak }. If there are no assistant
   * messages with classification metadata, returns { type: null, streak: 0 }.
   */
  async _lastClassificationStreak(interaccionId) {
    const all = await this.messageRepo.getAllMessages(interaccionId);
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

  async _countClassifications(interaccionId, types) {
    const messages = await this.messageRepo.getAllMessages(interaccionId);
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

  _detectFrustration(message) {
    const lower = message.toLowerCase();
    const patterns = [
      "ya te lo he dicho",
      "te lo acabo de decir",
      "no me entiendes",
      "no entiendes",
      "ya lo he dicho",
      "te lo he explicado",
      "already told you",
      "i already said",
      "you don't understand",
      "ja t'ho he dit",
    ];
    return patterns.some((p) => lower.includes(p));
  }
}

module.exports = ContextAgent;
