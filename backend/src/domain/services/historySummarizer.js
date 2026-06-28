"use strict";

/*------------------------------------------------------------------------------
            _________________________________________________________
            |                   HISTORYSUMMARIZER                   |
            |  Keeps an evergreen rolling summary of conversation   |
            |  turns that have fallen out of the recent-history     |
            |  window, indexed by interactionId, so long sessions   |
            |  do not silently lose context. Updated incrementally  |
            |  via a short LLM call; cache lives in process memory. |
        ____|________________                                       |
   Obj -> | constructor() | -> HistorySummarizer    (writes attrs)  |
          -----------------                                         |
            |                                                       |
            |   llm: ILlmService    logger: Obj    cache: Map       |
        ____|_______________                                        |
   [Obj], Txt, Txt -> | summarize() | -> Promise<Txt | null>  (reads attrs) |
                       ---------------                                 |
        ____|________________________                               |
        | _summarizeFromScratch() | -> Promise<Txt>  (reads attrs)  |
        ---------------------------                                 |
        ____|________________________                               |
        | _summarizeIncremental() | -> Promise<Txt>  (reads attrs)  |
        ---------------------------                                 |
        ____|____________________                                   |
        | _formatTranscript() | -> Txt                              |
        -----------------------                                     |
        ____|_______________                                        |
   Txt -> | _systemPrompt() | -> Txt                                |
          ------------------                                        |
        ____|_____________                                          |
        | _userPrompt() | -> Txt                                    |
        ----------------                                            |
        ____|______________                                         |
   Txt -> | invalidate() | -> void                  (reads attrs)   |
          ----------------                                          |
            |                                                       |
            |_______________________________________________________|
------------------------------------------------------------------------------*/
class HistorySummarizer {
  /*
   Obj -> ____|________________
         | constructor() | -> HistorySummarizer    (writes attributes llm (ILlmService),
          -----------------                         logger (Obj), cache (Map))
      Builds the summariser from a deps object. Requires an llmService;
      defaults the logger to a no-op and starts with an empty cache.
  */
  constructor(deps) {
    if (!deps || !deps.llmService) {
      throw new Error("HistorySummarizer requires llmService");
    }
    this.llm = deps.llmService;
    this.logger = deps.logger || { log: function () {} };
    this.cache = new Map();
  }

  /*
   [Obj], Txt, Txt -> ____|_______________
                     | summarize() | -> Promise<Txt | null>    (reads attribute cache (Map))
                      ---------------
      Returns a rolling summary of the messages that fell out of the
      recent window, reusing or extending the cached one when possible.
      Resolves to null when there is nothing to summarise.
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

  /*
   [Obj], Txt -> ____|________________________
                | _summarizeFromScratch() | -> Promise<Txt>    (reads attributes llm (ILlmService),
                 ---------------------------                    logger (Obj))
      Summarises the full transcript in one LLM call. Returns "" on error.
  */
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

  /*
   Txt, [Obj], Txt -> ____|________________________
                     | _summarizeIncremental() | -> Promise<Txt>    (reads attributes llm (ILlmService),
                      ---------------------------                    logger (Obj))
      Merges the previous summary with the new turns in one LLM call.
      Falls back to the previous summary on error.
  */
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

  /*
   [Obj] -> ____|____________________
           | _formatTranscript() | -> Txt
            -----------------------
      Renders the messages into a "ROLE: content" transcript, mapping
      assistant/user to TUTOR/ALUMNO and clipping each turn to 500 chars.
  */
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

  /*
   Txt -> ____|_______________
         | _systemPrompt() | -> Txt
          ------------------
      Returns the neutral-summariser system instruction in the requested
      language (valencian / english / spanish default).
  */
  _systemPrompt(lang) {
    if (lang === "val") {
      return "Eres un resumidor neutral. Comprimix una conversa tutor-alumne en una sola frase d'aproximadament 250 caràcters: qué ha confirmat l'alumne, qué conceptes ha esmentat i qué ha establert el tutor. Mai inventes informació; mai esmentes la solució completa. Resposta en valencià.";
    }
    if (lang === "en") {
      return "You are a neutral summariser. Compress a tutor-student conversation into a single sentence of about 250 characters: what the student has confirmed, which concepts they touched, and what the tutor established. Never invent information; never reveal the full solution. Respond in English.";
    }
    return "Eres un resumidor neutral. Comprime una conversación tutor-alumno en una sola frase de aproximadamente 250 caracteres: qué ha confirmado el alumno, qué conceptos ha mencionado y qué ha establecido el tutor. Nunca inventes información; nunca menciones la solución completa. Responde en español.";
  }

  /*
   Txt, Txt, Txt -> ____|_____________
                   | _userPrompt() | -> Txt
                    ----------------
      Builds the user-turn prompt in the requested language, choosing a
      merge prompt when a previous summary is given, otherwise a plain one.
  */
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

  /*
   Txt -> ____|______________
         | invalidate() | -> void    (reads attribute cache (Map))
          ----------------
      Drops the cached summary for the given interaction id.
  */
  invalidate(interactionId) {
    this.cache.delete(interactionId);
  }
}

module.exports = HistorySummarizer;
