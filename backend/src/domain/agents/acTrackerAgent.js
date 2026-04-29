"use strict";

const AgentInterface = require("./base/AgentInterface");

/**
 * AcTrackerAgent: aggregates the student's recurring Alternative Conceptions
 * from TWO sources, regardless of whether the conversation ever closed:
 *
 *   1. Resultado.errores — canonical AC IDs ("AC1", "AC6", ...) extracted by
 *      the LLM-based classifier when an interaction was finalised. Strong
 *      signal but only available for closed sessions.
 *
 *   2. messages.concepts + messages.classification — rule-based concepts
 *      (e.g. "divisor de tensión", "cortocircuito") and classification
 *      types (wrong_concept, correct_wrong_reasoning, ...) saved on every
 *      assistant turn, including interactions that were abandoned without
 *      a final Resultado. Weaker signal per-row but covers the gaps.
 *
 * Both sources are folded into one ranked list. The TutorAgent later
 * cross-references this with the concepts the student is using in the
 * CURRENT turn to surface a "[RECURRENT AC FOR THIS USER]" banner.
 *
 * Determinístic — no LLM call.
 *
 * Output (added to context):
 *   context.userACHistory = {
 *     hasHistory: boolean,
 *     topACs:    Array<{ ac: string, count: number, source: "resultado"|"concept"|"both" }>,
 *     allTags:   string[],                                  // ranked, debug
 *     classifications: Array<{ classification: string, count: number }>,
 *   }
 */
class AcTrackerAgent extends AgentInterface {
  /**
   * @param {object} deps
   * @param {import('../ports/repositories/IResultadoRepository')} [deps.resultadoRepo]
   * @param {import('../ports/repositories/IMessageRepository')}   [deps.messageRepo]
   * @param {number} [deps.topN] — how many top ACs to expose (default 3)
   * @param {number} [deps.lookbackLimit] — how many recent results to scan (default 50)
   */
  constructor(deps) {
    super("acTrackerAgent");
    this.resultadoRepo = deps && deps.resultadoRepo;
    this.messageRepo = deps && deps.messageRepo;
    this.topN = (deps && deps.topN) || 3;
    this.lookbackLimit = (deps && deps.lookbackLimit) || 50;
  }

  canSkip(context) {
    // We need at least one of the two sources wired — otherwise there's
    // nothing to read. Tests / partial configs degrade gracefully to
    // "no history" downstream.
    if (!this.resultadoRepo && !this.messageRepo) return true;
    if (!context || !context.userId) return true;
    return false;
  }

  async execute(context) {
    if (this.canSkip(context)) {
      context.userACHistory = { hasHistory: false, topACs: [], allTags: [], classifications: [] };
      return;
    }

    // Run both reads in parallel; either may fail independently.
    const [resultadosOutcome, evidenceOutcome] = await Promise.all([
      this._safeFindResultados(context.userId),
      this._safeGetEvidence(context.userId),
    ]);

    // counts: { tag → { count, source } }
    const counts = {};

    // Source 1 — closed sessions, canonical AC IDs.
    const resultados = resultadosOutcome || [];
    const limit = Math.min(this.lookbackLimit, resultados.length);
    for (let i = 0; i < limit; i++) {
      const r = resultados[i];
      const errs = (r && r.errores) || [];
      for (let j = 0; j < errs.length; j++) {
        const tag = errs[j] && errs[j].etiqueta;
        if (!tag) continue;
        if (!counts[tag]) counts[tag] = { count: 0, source: "resultado" };
        counts[tag].count++;
      }
    }

    // Source 2 — concepts aggregated from every assistant turn, INCLUDING
    // open / abandoned interactions. The agent doesn't try to map concepts
    // to canonical AC IDs here; we trust that downstream cross-referencing
    // in the TutorAgent does the matching when concepts overlap.
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

  async _safeFindResultados(userId) {
    if (!this.resultadoRepo) return [];
    try {
      return await this.resultadoRepo.findByUserId(userId);
    } catch (e) {
      return [];
    }
  }

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
