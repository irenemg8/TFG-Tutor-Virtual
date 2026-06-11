"use strict";

const IGuardrail = require("../../domain/ports/services/IGuardrail");
const { stripAccents } = require("../../domain/services/text/accentNormalizer");

/**
 * SettledElementQuestionGuardrail (BUG-LOOP, 2026-06-11)
 *
 * Deterministic safety net for the looping Irene flagged in the 2026-06-11
 * transcript: after the student had ALREADY named R1,R2,R4 and excluded R3,R5,
 * the tutor kept re-asking yes/no topology questions about those same settled
 * elements ("¿Está R1 en el camino…?", "¿R2 está conectada a tierra…?",
 * "¿Está R4 en el mismo camino que R2…?") for 7+ turns.
 *
 * The [PROGRESO ACUMULADO] banner (tutorAgent) already TELLS the LLM not to do
 * this, but qwen2.5 ignores scaffolding with some frequency — same reason the
 * [ESTABLISHED FACTS] / [STUCK ON Rn] banners weren't enough. This guardrail is
 * the post-hoc net: if the tutor's question is a TOPOLOGY/POSITION yes-no
 * re-ask about an element that is ALREADY settled (in cumulativeAnswer's
 * namedCorrect ∪ excluded) AND introduces no not-yet-settled element, force a
 * retry that pivots to consolidation.
 *
 * Deliberately HIGH PRECISION (avoid false positives that would kill good
 * turns). It does NOT fire on:
 *   - conceptual questions ("¿por qué…?", "¿cómo…?", "explica/justifica") —
 *     demanding reasoning about a settled element is GOOD, not a loop;
 *   - questions that mention an element NOT yet settled (a legitimate probe
 *     toward the missing element);
 *   - any turn where no cumulative state is available.
 *
 * Retry-only: there is no safe deterministic rewrite of the question, so
 * surgicalFix returns null (forces the consolidated LLM retry, exactly like
 * RepeatedQuestionGuardrail). Its id is added to the pipeline's
 * CRITICAL_GUARDRAILS so the retry actually runs.
 */

// Position/topology phrases that mark a "where is it / is it in the path" probe.
// Accent-folded. If one of these is present AND the question targets a settled
// element, it's a re-ask of something already established.
const TOPOLOGY_PHRASES = [
  "en el camino", "en el mismo camino", "mismo camino",
  "conectad", "conecta", "hacia tierra", "a tierra",
  "forma parte del camino", "pasa corriente por", "pasa la corriente por",
  "terminal", "entre n", "directamente",
  // Flow re-asks observed in the 2026-06-11 production loop ("¿…la corriente
  // no puede fluir a través de R3?", "¿…cualquier corriente que pase por
  // ella…?") — same settled-element re-interrogation, flow phrasing.
  "a traves de", "pase por", "pasa por", "fluir", "fluya",
  "passe per", "flow through", "passes through", "pass through",
].map(function (p) { return stripAccents(p.toLowerCase()); });

// Conceptual/justification question shapes — these are GOOD (asking the student
// to reason), so a settled element appearing in them must NOT fire the rule.
const CONCEPTUAL_MARKERS = [
  "por que", "porque", "explica", "justifica", "razona", "como afecta",
  "como crees", "como se relaciona", "que concepto", "por motivo",
].map(function (p) { return stripAccents(p.toLowerCase()); });

function _settledSet(ctx) {
  const cum = ctx && ctx.cumulativeAnswer;
  const set = new Set();
  if (!cum) return set;
  for (const e of (cum.namedCorrect || [])) set.add(String(e).toUpperCase());
  for (const e of (cum.excluded || [])) set.add(String(e).toUpperCase());
  return set;
}

// Last interrogative fragment of a response (the actual question being asked).
function _lastQuestion(text) {
  const matches = String(text).match(/[¿]?[^.!?]*\?/g);
  if (!matches || matches.length === 0) return "";
  return matches[matches.length - 1].trim();
}

class SettledElementQuestionGuardrail extends IGuardrail {
  get id() { return "settled_element_question"; }
  get severity() { return "med"; }

  check(response, ctx) {
    if (typeof response !== "string" || response.length === 0) {
      return { violated: false };
    }
    const settled = _settledSet(ctx);
    if (settled.size === 0) return { violated: false };

    const question = _lastQuestion(response);
    if (question.length === 0) return { violated: false };
    const folded = stripAccents(question.toLowerCase());

    // Conceptual / justification questions are legitimate even about settled
    // elements — never fire on them.
    for (let i = 0; i < CONCEPTUAL_MARKERS.length; i++) {
      if (folded.indexOf(CONCEPTUAL_MARKERS[i]) >= 0) return { violated: false };
    }

    // Which evaluable elements does the QUESTION name?
    const named = (question.match(/\bR\d+\b/gi) || []).map(function (s) { return s.toUpperCase(); });
    if (named.length === 0) return { violated: false };

    // Fire only when EVERY named element is already settled (re-asking nothing
    // new) AND the question is a topology/position probe. If it introduces a
    // not-yet-settled element it's a legitimate advance — do not fire.
    const allSettled = named.every(function (e) { return settled.has(e); });
    if (!allSettled) return { violated: false };

    let isTopology = false;
    for (let i = 0; i < TOPOLOGY_PHRASES.length; i++) {
      if (folded.indexOf(TOPOLOGY_PHRASES[i]) >= 0) { isTopology = true; break; }
    }
    if (!isTopology) return { violated: false };

    return {
      violated: true,
      evidence: "re-asks settled element(s) " + named.join(",") +
        " with a topology question: '" + question.slice(0, 70) + "'",
      metadata: { elements: named },
    };
  }

  surgicalFix(response) {
    // No safe rewrite — we don't know which NEW element/angle to pivot to.
    // Returning null forces the consolidated LLM retry (id is in the pipeline's
    // CRITICAL_GUARDRAILS so the retry runs).
    return null;
  }

  buildRetryHint(lang, ctx) {
    const settled = Array.from(_settledSet(ctx)).join(", ");
    if (lang === "en") {
      return (
        "[STOP RE-ASKING SETTLED ELEMENTS] You just asked a topology/position " +
        "question about element(s) the student ALREADY established earlier (" +
        settled + "). Do NOT re-ask whether they are in the path or how they " +
        "connect — that is resolved. Either advance to an element still in " +
        "question, or, if the correct set is complete, ask ONE conceptual " +
        "question that consolidates WHY the excluded elements are left out. " +
        "Do not reveal the answer.\n\n"
      );
    }
    if (lang === "val") {
      return (
        "[DEIXA DE RE-PREGUNTAR ELEMENTS JA RESOLTS] Acabes de preguntar per la " +
        "topologia/posició d'element(s) que l'alumne JA ha establit abans (" +
        settled + "). NO tornes a preguntar si estan en el camí ni com es " +
        "connecten. Avança cap a un element encara pendent o, si el conjunt " +
        "correcte ja és complet, fes UNA pregunta conceptual que consolide PER " +
        "QUÈ s'exclouen els altres. No reveles la resposta.\n\n"
      );
    }
    return (
      "[DEJA DE RE-PREGUNTAR ELEMENTOS YA RESUELTOS] Acabas de preguntar por la " +
      "topología/posición de elemento(s) que el alumno YA estableció en turnos " +
      "anteriores (" + settled + "). NO vuelvas a preguntar si están en el " +
      "camino ni cómo se conectan: eso ya está resuelto. O bien avanza hacia un " +
      "elemento que aún quede pendiente, o, si el conjunto correcto ya está " +
      "completo, formula UNA pregunta conceptual que consolide POR QUÉ se " +
      "excluyen los elementos restantes. No reveles la respuesta.\n\n"
    );
  }
}

module.exports = SettledElementQuestionGuardrail;
