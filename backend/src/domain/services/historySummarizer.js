"use strict";

/**
 * HistorySummarizer: keeps an evergreen summary of the conversation turns
 * that have fallen out of the LLM's recent-history window.
 *
 * Without this, sessions longer than HISTORY_MAX_MESSAGES turns silently
 * lose context — the student writes "te he dicho que R3 no influye" and the
 * tutor has no record of the earlier confirmation because that turn already
 * fell out of the window. The summariser keeps an incremental, in-memory
 * rolling summary indexed by interactionId, which the TutorAgent injects
 * back into the LLM prompt as a system message.
 *
 * Cache strategy: per-interaction (interactionId → {count, summary}). When
 * new turns push older messages out of the recent window, we extend the
 * previous summary with the newcomers via a short LLM call instead of
 * re-reading the entire tail. The cache lives in process memory only — on
 * restart it's regenerated lazily from the persisted messages on the first
 * post-window turn of each conversation.
 *
 * LLM cost: 1 call per turn once the conversation exceeds the recent window.
 * Prompt is short (~300 chars previous summary + 2 new turns) so it adds
 * ~300-800ms to the turn. On the very first post-restart hit for a long
 * conversation the cost is higher because we have to summarise from scratch.
 */
class HistorySummarizer {
  /**
   * @param {object} deps
   * @param {import('../ports/services/ILlmService')} deps.llmService
   * @param {object} [deps.logger]
   */
  constructor(deps) {
    if (!deps || !deps.llmService) {
      throw new Error("HistorySummarizer requires llmService");
    }
    this.llm = deps.llmService;
    this.logger = deps.logger || { log: function () {} };
    this.cache = new Map();
  }

  /**
   * @param {Array<{role,content}>} olderMessages — messages that fell out
   *    of the recent-history window (chronological order, oldest first).
   * @param {string} lang — "es" / "val" / "en"
   * @param {string} interactionId — cache key
   * @returns {Promise<string|null>}
   */
  async summarize(olderMessages, lang, interactionId) {
    if (!Array.isArray(olderMessages) || olderMessages.length === 0) {
      return null;
    }

    const cached = this.cache.get(interactionId);
    const currentCount = olderMessages.length;
    if (cached && cached.count === currentCount) {
      return cached.summary;
    }

    let summary;
    if (cached && cached.count > 0 && cached.count < currentCount) {
      const newMessages = olderMessages.slice(cached.count);
      summary = await this._summarizeIncremental(cached.summary, newMessages, lang);
    } else {
      summary = await this._summarizeFromScratch(olderMessages, lang);
    }

    if (summary && summary.length > 0) {
      this.cache.set(interactionId, { count: currentCount, summary: summary });
    }
    return summary || null;
  }

  async _summarizeFromScratch(messages, lang) {
    const transcript = this._formatTranscript(messages);
    const prompt = [
      { role: "system", content: this._systemPrompt(lang) },
      { role: "user", content: this._userPrompt(lang, transcript, null) },
    ];
    try {
      const out = await this.llm.chatCompletion(prompt, {
        temperature: 0.2, numPredict: 300, budgetMs: 8000,
      });
      return (out || "").trim();
    } catch (err) {
      this.logger.log && this.logger.log(
        "[HistorySummarizer] summarise-from-scratch failed: " + (err.message || err)
      );
      return "";
    }
  }

  async _summarizeIncremental(prevSummary, newMessages, lang) {
    const transcript = this._formatTranscript(newMessages);
    const prompt = [
      { role: "system", content: this._systemPrompt(lang) },
      { role: "user", content: this._userPrompt(lang, transcript, prevSummary) },
    ];
    try {
      const out = await this.llm.chatCompletion(prompt, {
        temperature: 0.2, numPredict: 300, budgetMs: 6000,
      });
      return (out || "").trim();
    } catch (err) {
      this.logger.log && this.logger.log(
        "[HistorySummarizer] summarise-incremental failed; reusing previous summary: "
        + (err.message || err)
      );
      return prevSummary;
    }
  }

  _formatTranscript(messages) {
    let out = "";
    for (let i = 0; i < messages.length; i++) {
      const m = messages[i];
      const role = m.role === "assistant" ? "TUTOR"
        : (m.role === "user" ? "ALUMNO" : (m.role || "").toUpperCase());
      const content = (m.content || "").replace(/\s+/g, " ").trim().slice(0, 500);
      if (content) out += role + ": " + content + "\n";
    }
    return out.trim();
  }

  _systemPrompt(lang) {
    if (lang === "val") {
      return "Eres un resumidor neutral. Comprimix una conversa tutor-alumne en una sola frase d'aproximadament 250 caràcters: qué ha confirmat l'alumne, qué conceptes ha esmentat i qué ha establert el tutor. Mai inventes informació; mai esmentes la solució completa. Resposta en valencià.";
    }
    if (lang === "en") {
      return "You are a neutral summariser. Compress a tutor-student conversation into a single sentence of about 250 characters: what the student has confirmed, which concepts they touched, and what the tutor established. Never invent information; never reveal the full solution. Respond in English.";
    }
    return "Eres un resumidor neutral. Comprime una conversación tutor-alumno en una sola frase de aproximadamente 250 caracteres: qué ha confirmado el alumno, qué conceptos ha mencionado y qué ha establecido el tutor. Nunca inventes información; nunca menciones la solución completa. Responde en español.";
  }

  _userPrompt(lang, transcript, prevSummary) {
    if (prevSummary) {
      if (lang === "val") {
        return "Resum previ:\n" + prevSummary + "\n\nNous torns:\n" + transcript
          + "\n\nFusiona el resum previ amb els nous torns en un únic resum continu d'unes 250 caràcters.";
      }
      if (lang === "en") {
        return "Previous summary:\n" + prevSummary + "\n\nNew turns:\n" + transcript
          + "\n\nMerge the previous summary with the new turns into a single continuous summary of about 250 characters.";
      }
      return "Resumen previo:\n" + prevSummary + "\n\nNuevos turnos:\n" + transcript
        + "\n\nFusiona el resumen previo con los nuevos turnos en un único resumen continuo de unos 250 caracteres.";
    }
    if (lang === "val") {
      return "Conversa:\n" + transcript + "\n\nFes un resum d'unes 250 caràcters.";
    }
    if (lang === "en") {
      return "Conversation:\n" + transcript + "\n\nSummarise in about 250 characters.";
    }
    return "Conversación:\n" + transcript + "\n\nResume en unos 250 caracteres.";
  }

  invalidate(interactionId) {
    this.cache.delete(interactionId);
  }
}

module.exports = HistorySummarizer;
