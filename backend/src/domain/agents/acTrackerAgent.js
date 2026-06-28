"use strict";

const AgentInterface = require("./base/AgentInterface");

/*------------------------------------------------------------------------------
            _________________________________________________________
            |                    ACTRACKERAGENT                     |
            |  Pipeline agent that aggregates the student's         |
            |  recurring Alternative Conceptions from two sources   |
            |  (closed-session Resultado.errors AC IDs and per-turn |
            |  message concepts/classifications) into one ranked    |
            |  list, regardless of whether sessions ever closed.    |
            |  Deterministic, no LLM call. TutorAgent later cross-  |
            |  references it to raise a [RECURRENT AC] banner.      |
        ____|________________                                       |
   Obj -> | constructor() | -> AcTrackerAgent        (writes attrs) |
          -----------------                                         |
            |                                                       |
            |   name: Txt            resultadoRepo: Obj             |
            |   messageRepo: Obj     topN: N                        |
            |   lookbackLimit: N                                    |
        ____|_____________________________                          |
 AgentContext -> | canSkip() | -> T/F   (reads resultadoRepo (Obj),
                 ------------            messageRepo (Obj))         |
        ____|_____________________________                          |
 AgentContext -> | execute() | -> Promise<void>  (reads resultadoRepo (Obj),
                 ------------                      messageRepo (Obj), topN (N),
                                                   lookbackLimit (N))           |
        ____|_____________________________                          |
   Txt -> | _safeFindResultados() | -> Promise<[Obj]>  (reads resultadoRepo (Obj))
          -----------------------                                   |
        ____|_____________________________                          |
   Txt -> | _safeGetEvidence() | -> Promise<Obj>    (reads messageRepo (Obj))
          --------------------                                      |
            |                                                       |
            |_______________________________________________________|
------------------------------------------------------------------------------*/
class AcTrackerAgent extends AgentInterface {
  /*
   Obj -> ____|________________
         | constructor() | -> AcTrackerAgent    (writes attributes name (Txt),
          -----------------                      resultadoRepo (Obj), messageRepo (Obj),
                                                 topN (N), lookbackLimit (N))
      Stores the two source repositories and the tuning knobs topN
      (how many top ACs to expose, default 3) and lookbackLimit (how
      many recent results to scan, default 50).
  */
  constructor(deps) {
    super("acTrackerAgent");
    this.resultadoRepo = deps && deps.resultadoRepo;
    this.messageRepo = deps && deps.messageRepo;
    this.topN = (deps && deps.topN) || 3;
    this.lookbackLimit = (deps && deps.lookbackLimit) || 50;
  }

  /*
 AgentContext -> ____|___________
                | canSkip() | -> T/F    (reads attributes resultadoRepo (Obj)
                 -----------             and messageRepo (Obj))
      Skips when neither source is wired or no userId is present;
      downstream degrades gracefully to "no history".
  */
  canSkip(context) {
    if (!this.resultadoRepo && !this.messageRepo) return true;
    if (!context || !context.userId) return true;
    return false;
  }

  /*
 AgentContext -> ____|___________
                | execute() | -> Promise<void>    (reads attributes resultadoRepo (Obj),
                 -----------                        messageRepo (Obj), topN (N),
                                                    lookbackLimit (N))
      Reads both sources in parallel, folds them into a per-tag count
      keyed by source, ranks the tags by frequency, and writes the
      ranked userACHistory summary onto the context.
  */
  async execute(context) {
    if (this.canSkip(context)) {
      context.userACHistory = { hasHistory: false, topACs: [], allTags: [], classifications: [] };
      return;
    }

    const [resultadosOutcome, evidenceOutcome] = await Promise.all([
      this._safeFindResultados(context.userId),
      this._safeGetEvidence(context.userId),
    ]);

    const counts = {};

    const resultados = resultadosOutcome || [];
    const limit = Math.min(this.lookbackLimit, resultados.length);
    for (let i = 0; i < limit; i++) {
      const r = resultados[i];
      const errs = (r && r.errors) || [];
      for (let j = 0; j < errs.length; j++) {
        const tag = errs[j] && errs[j].label;
        if (!tag) continue;
        if (!counts[tag]) counts[tag] = { count: 0, source: "resultado" };
        counts[tag].count++;
      }
    }

    const evidence = evidenceOutcome || { concepts: [], classifications: [] };
    for (let i = 0; i < evidence.concepts.length; i++) {
      const tag = evidence.concepts[i].concept;
      const c = evidence.concepts[i].count;
      if (!tag || !c) continue;
      if (!counts[tag]) {
        counts[tag] = { count: 0, source: "concept" };
      } else {
        counts[tag].source = counts[tag].source === "resultado" ? "both" : counts[tag].source;
      }
      counts[tag].count += c;
    }

    const ranked = Object.keys(counts).sort(function (a, b) {
      return counts[b].count - counts[a].count;
    });

    context.userACHistory = {
      hasHistory: ranked.length > 0,
      topACs: ranked.slice(0, this.topN).map(function (ac) {
        return { ac: ac, count: counts[ac].count, source: counts[ac].source };
      }),
      allTags: ranked,
      classifications: evidence.classifications || [],
    };
  }

  /*
   Txt -> ____|________________________
         | _safeFindResultados() | -> Promise<[Obj]>    (reads attribute resultadoRepo (Obj))
          -----------------------
      Fetches the user's finalised Resultados, swallowing any repo error
      and returning [] so a failed read never breaks the turn.
  */
  async _safeFindResultados(userId) {
    if (!this.resultadoRepo) return [];
    try {
      return await this.resultadoRepo.findByUserId(userId);
    } catch (e) {
      return [];
    }
  }

  /*
   Txt -> ____|_____________________
         | _safeGetEvidence() | -> Promise<Obj>    (reads attribute messageRepo (Obj))
          --------------------
      Fetches the user's aggregated concept/classification evidence,
      returning the empty { concepts, classifications } shape when the
      repo lacks the method or the read fails.
  */
  async _safeGetEvidence(userId) {
    if (!this.messageRepo || typeof this.messageRepo.getAcEvidenceByUserId !== "function") {
      return { concepts: [], classifications: [] };
    }
    try {
      return await this.messageRepo.getAcEvidenceByUserId(userId);
    } catch (e) {
      return { concepts: [], classifications: [] };
    }
  }
}

module.exports = AcTrackerAgent;
