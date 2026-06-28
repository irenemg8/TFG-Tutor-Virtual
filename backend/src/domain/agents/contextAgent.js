"use strict";

const AgentInterface = require("./base/AgentInterface");

/*------------------------------------------------------------------------------
            _________________________________________________________
            |                     CONTEXTAGENT                      |
            |  First pipeline agent. Loads every piece of data the  |
            |  tutoring turn needs: the exercise, the interaction,  |
            |  the conversation history (summarising the older tail |
            |  past HISTORY_MAX_MESSAGES), the language, the         |
            |  cumulative answer state and the loop state, writing  |
            |  them all onto the AgentContext.                      |
        ____|________________                                       |
   Obj -> | constructor() | -> ContextAgent          (writes attrs) |
          -----------------                                         |
            |                                                       |
            |   name: Txt            ejercicioRepo: Obj             |
            |   interaccionRepo: Obj messageRepo: Obj               |
            |   config: Obj          historySummarizer: Obj         |
        ____|_____________________________                          |
 AgentContext -> | execute() | -> Promise<void>  (reads all attrs)  |
                 ------------                                        |
        ____|_____________________________                          |
 [Obj] -> | _detectStuckOnElement() | -> Txt | null                 |
          -------------------------                                 |
        ____|_____________________________                          |
   Txt -> | _lastClassificationStreak() | -> Promise<Obj>  (reads messageRepo (Obj))
          -----------------------------                             |
        ____|_____________________________                          |
 [Obj] -> | _resolveLanguage() | -> Txt                             |
          --------------------                                      |
        ____|_____________________________                          |
 Txt,[Txt] -> | _countClassifications() | -> Promise<Z>  (reads messageRepo (Obj))
              -------------------------                             |
        ____|_____________________________                          |
 [Obj] -> | _extractEstablishedFacts() | -> [Txt]                   |
          ----------------------------                              |
        ____|_____________________________                          |
 [Obj] -> | _extractLastQuestion() | -> Txt                         |
          ------------------------                                  |
        ____|_____________________________                          |
 [Obj] -> | _detectRepetition() | -> T/F                            |
          ---------------------                                     |
        ____|_____________________________                          |
 Txt,Txt -> | _questionSimilarity() | -> R                          |
            -----------------------                                 |
        ____|_____________________________                          |
   Z -> | _canonicalExerciseNum() | -> Z | null   (reads config (Obj))
        -------------------------                                   |
        ____|_____________________________                          |
   Txt -> | _detectFrustration() | -> T/F                           |
          ----------------------                                    |
            |_______________________________________________________|
------------------------------------------------------------------------------*/
class ContextAgent extends AgentInterface {
  /*
   Obj -> ____|________________
         | constructor() | -> ContextAgent    (writes attributes name (Txt),
          -----------------                    ejercicioRepo (Obj), interaccionRepo (Obj),
                                               messageRepo (Obj), config (Obj),
                                               historySummarizer (Obj))
      Stores the three repositories, the RAG config and the required
      historySummarizer (throws when missing; pass NullHistorySummarizer
      to disable summarisation on purpose).
  */
  constructor(deps) {
    super("contextAgent");
    this.ejercicioRepo = deps.ejercicioRepo;
    this.interaccionRepo = deps.interaccionRepo;
    this.messageRepo = deps.messageRepo;
    this.config = deps.config;
    if (!deps.historySummarizer) throw new Error("ContextAgent requires deps.historySummarizer");
    this.historySummarizer = deps.historySummarizer;
  }

  /*
 AgentContext -> ____|___________
                | execute() | -> Promise<void>    (reads attributes ejercicioRepo (Obj),
                 -----------                        interaccionRepo (Obj), messageRepo (Obj),
                                                    config (Obj), historySummarizer (Obj))
      Loads the exercise (falling through if it has no valid tutor
      context), resolves or creates the interaction, loads and windows
      the history, computes the cumulative answer and closure flags,
      resolves the language, summarises the older tail, and finally
      derives the full loop state, writing everything onto the context.
  */
  async execute(context) {
    const ejercicio = await this.ejercicioRepo.findById(context.exerciseId);
    if (!ejercicio || !ejercicio.hasValidTutorContext()) {
      context.fallthrough = true;
      return;
    }
    context.exercise = ejercicio;
    context.exerciseNum = ejercicio.getExerciseNumber();
    context.correctAnswer = ejercicio.getCorrectAnswer();
    context.evaluableElements = ejercicio.getEvaluableElements();

    context.canonicalExerciseNum = this._canonicalExerciseNum(context.exerciseNum);

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

    {
      const { computeCumulativeAnswer } = require("../services/rag/cumulativeAnswer");
      const allForReplay = allMessages.map((m) => m.toOllamaFormat());
      if (context.userMessage) {
        allForReplay.push({ role: "user", content: context.userMessage });
      }
      context.cumulativeAnswer = computeCumulativeAnswer(
        allForReplay, context.correctAnswer, context.evaluableElements
      );
    }

    context.exerciseAlreadyClosed = allMessages.some(function (m) {
      return m && m.isAssistant && m.isAssistant() &&
        typeof m.content === "string" && m.content.indexOf("<END_EXERCISE>") >= 0;
    });

    const historyWithCurrent = context.userMessage
      ? context.history.concat([{ role: "user", content: context.userMessage }])
      : context.history;
    context.lang = this._resolveLanguage(historyWithCurrent);

    context.historySummary = null;
    if (olderMessages.length > 0) {
      try {
        const olderForLlm = olderMessages.map((m) => m.toOllamaFormat());
        context.historySummary = await this.historySummarizer.summarize(
          olderForLlm, context.lang, context.interactionId
        );
      } catch (err) {
        context.historySummary = null;
      }
    }

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
    const tutorStuckOnElement = this._detectStuckOnElement(lastAssistantMessages);
    const lastAssistantQuestion = this._extractLastQuestion(lastAssistantMessages);
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
      lastClassification: lastClassificationStreak.type,
      sameClassificationStreak: lastClassificationStreak.streak,
    };
  }

  /*
 [Obj] -> ____|__________________________
         | _detectStuckOnElement() | -> Txt | null
          -------------------------
      Detects when the tutor is stuck on the same Rn: scans the question
      fragments of the recent assistant messages and returns the element
      that appears in >= 2 of them (the most recent on a tie), else null.
  */
  _detectStuckOnElement(lastAssistantMessages) {
    if (!Array.isArray(lastAssistantMessages) || lastAssistantMessages.length < 2) {
      return null;
    }
    const counts = {};
    let mostRecent = null;
    for (let i = 0; i < lastAssistantMessages.length; i++) {
      const m = lastAssistantMessages[i];
      const content = (m && m.content) || "";
      const qs = content.match(/[^.!?]*\?/g);
      const allQ = qs && qs.length > 0 ? qs.join(" ") : "";
      const rns = allQ.match(/\bR\d+\b/gi);
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
    return best;
  }

  /*
   Txt -> ____|______________________________
         | _lastClassificationStreak() | -> Promise<Obj>    (reads attribute messageRepo (Obj))
          -----------------------------
      Walks the messages backwards counting how many consecutive recent
      assistant turns share the same metadata.classification. Returns
      { type, streak }, or { type: null, streak: 0 } when none.
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

  /*
 [Obj] -> ____|___________________
         | _resolveLanguage() | -> Txt
          --------------------
      Delegates to the conservative language resolver, which inspects
      only USER messages and requires an explicit switch, so one stray
      foreign word can never flip the conversation language.
  */
  _resolveLanguage(history) {
    const { resolveLanguage } = require("../services/languageManager");
    return resolveLanguage(history);
  }

  /*
 Txt,[Txt] -> ____|________________________
             | _countClassifications() | -> Promise<Z>    (reads attribute messageRepo (Obj))
              -------------------------
      Counts the assistant messages whose metadata.classification is one
      of the given types.
  */
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

  /*
 [Obj] -> ____|____________________________
         | _extractEstablishedFacts() | -> [Txt]
          ----------------------------
      Heuristic regex extractor of facts the tutor already asserted in
      prior turns (assertive R/N sentences), rejecting questions and
      hypotheticals. Returns up to 5 unique facts, oldest first, to feed
      the ESTABLISHED FACTS banner.
  */
  _extractEstablishedFacts(lastAssistantMessages) {
    if (!Array.isArray(lastAssistantMessages) || lastAssistantMessages.length === 0) {
      return [];
    }
    const facts = [];
    const seen = new Set();
    const FACT_RE = /(?:^|[.!\n]\s*|sí[,]\s*)((?:R\d+|N\d+)[^.!?¿\n]{0,120}?(?:está|conecta|forma|es parte|es la|es el|se conecta|se sitúa|sale|llega)[^.!?¿\n]{0,80}[.!\n])/gi;
    const QUESTION_OPENERS = /^(si\b|qu[eé]\b|c[oó]mo\b|cu[aá]l\b|cu[aá]ndo\b|d[oó]nde\b|por\s+qu[eé]\b|crees\b|puedes\b|sabes\b|què\b|com\b|quin\b|on\b|what\b|how\b|where\b|when\b|why\b|do\s+you\b|can\s+you\b)/i;
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

  /*
 [Obj] -> ____|_______________________
         | _extractLastQuestion() | -> Txt
          ------------------------
      Returns the most recent literal Socratic question asked by the
      tutor (last '?' fragment of the newest assistant message that has
      one), trimmed, or "" when there is none.
  */
  _extractLastQuestion(lastAssistantMessages) {
    if (!Array.isArray(lastAssistantMessages) || lastAssistantMessages.length === 0) {
      return "";
    }
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

  /*
 [Obj] -> ____|____________________
         | _detectRepetition() | -> T/F
          ---------------------
      True when any two of the recent assistant questions are more than
      50% similar, signalling the tutor is looping.
  */
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

  /*
 Txt,Txt -> ____|______________________
           | _questionSimilarity() | -> R
            -----------------------
      Symmetric lexical overlap ratio between two questions (shared words
      longer than 3 chars over the longer word set). 0 when either is empty.
  */
  _questionSimilarity(qa, qb) {
    const wordsA = qa.split(/\s+/).filter((w) => w.length > 3);
    const wordsB = qb.split(/\s+/).filter((w) => w.length > 3);
    if (wordsA.length === 0 || wordsB.length === 0) return 0;
    const overlap = wordsA.filter((w) => wordsB.includes(w)).length;
    return overlap / Math.max(wordsA.length, wordsB.length);
  }

  /*
   Z -> ____|________________________
       | _canonicalExerciseNum() | -> Z | null    (reads attribute config (Obj))
        -------------------------
      Maps an exercise number to the canonical one sharing its dataset
      collection via config.CANONICAL_EXERCISE_MAP, so retrieval never
      hits an empty Chroma collection. Falls back to the input number.
  */
  _canonicalExerciseNum(exerciseNum) {
    if (exerciseNum == null) return exerciseNum;
    const map = this.config && this.config.CANONICAL_EXERCISE_MAP;
    if (!map) return exerciseNum;
    return map[exerciseNum] ?? exerciseNum;
  }

  /*
   Txt -> ____|____________________
         | _detectFrustration() | -> T/F
          ----------------------
      True when the message matches any phrase in the shared multilingual
      frustration dictionary from languageManager.
  */
  _detectFrustration(message) {
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
