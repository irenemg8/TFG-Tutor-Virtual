"use strict";

const IGuardrail = require("../../domain/ports/services/IGuardrail");
const { stripAccents } = require("../../domain/services/text/accentNormalizer");

/*------------------------------------------------------------------------------
            _________________________________________________________
            |             SETTLEDELEMENTQUESTIONGUARDRAIL          |
            |  Guardrail adapter (IGuardrail). Catches the looping   |
            |  tutor re-asking yes/no topology questions about       |
            |  elements the student ALREADY settled (named or        |
            |  excluded), introducing nothing new. High precision:   |
            |  spares conceptual questions and probes toward         |
            |  not-yet-settled elements. Retry-only.                 |
        ____|_____________________                                   |
        | check() | -> Obj    (reads response, ctx.cumulativeAnswer) |
        -----------                                                  |
        ____|_______________________                                 |
        | surgicalFix() | -> null                (no safe rewrite)   |
        -----------------                                            |
        ____|___________________                                     |
        | buildRetryHint() | -> Txt   (reads ctx.cumulativeAnswer)   |
        --------------------                                         |
            |                                                       |
            |_______________________________________________________|
------------------------------------------------------------------------------*/

// Position/topology phrases marking a "where is it / is it in the path" probe.
// Accent-folded. Present + targeting a settled element => re-ask of something
// already established.
const TOPOLOGY_PHRASES = [
  "en el camino", "en el mismo camino", "mismo camino",
  "conectad", "conecta", "hacia tierra", "a tierra",
  "forma parte del camino", "pasa corriente por", "pasa la corriente por",
  "terminal", "entre n", "directamente",
  "a traves de", "pase por", "pasa por", "fluir", "fluya",
  "passe per", "flow through", "passes through", "pass through",
].map(function (p) { return stripAccents(p.toLowerCase()); });

// Conceptual/justification question shapes — GOOD (asking the student to
// reason), so a settled element appearing in them must NOT fire the rule.
const CONCEPTUAL_MARKERS = [
  "por que", "porque", "explica", "justifica", "razona", "como afecta",
  "como crees", "como se relaciona", "que concepto", "por motivo",
  "que impide", "que impediria", "que evita", "que pasaria", "que ocurriria",
  "que ocurre si", "que sucede si", "que condicion", "que ley",
  "que impedeix", "que passaria", "what prevents", "what would happen",
].map(function (p) { return stripAccents(p.toLowerCase()); });

/*
   Obj -> ____|______________
         | _settledSet() | -> Set<Txt>
          ---------------
      Uppercased union of cumulativeAnswer.namedCorrect and .excluded — the
      elements considered already resolved.
*/
function _settledSet(ctx) {
  const cum = ctx && ctx.cumulativeAnswer;
  const set = new Set();
  if (!cum) return set;
  for (const e of (cum.namedCorrect || [])) set.add(String(e).toUpperCase());
  for (const e of (cum.excluded || [])) set.add(String(e).toUpperCase());
  return set;
}

/*
   Txt -> ____|_______________
         | _lastQuestion() | -> Txt
          -----------------
      Returns the last interrogative fragment of the response (the actual
      question being asked), or "".
*/
function _lastQuestion(text) {
  const matches = String(text).match(/[¿]?[^.!?]*\?/g);
  if (!matches || matches.length === 0) return "";
  return matches[matches.length - 1].trim();
}

class SettledElementQuestionGuardrail extends IGuardrail {
  get id() { return "settled_element_question"; }
  get severity() { return "med"; }

  /*
   Txt, Obj -> ____|_________
              | check() | -> Obj
               -----------
      True (violated) only when every element named in the last question is
      already settled AND the question is a topology probe (not conceptual).
  */
  check(response, ctx) {
    if (typeof response !== "string" || response.length === 0) {
      return { violated: false };
    }
    const settled = _settledSet(ctx);
    if (settled.size === 0) return { violated: false };

    const question = _lastQuestion(response);
    if (question.length === 0) return { violated: false };
    const folded = stripAccents(question.toLowerCase());

    for (let i = 0; i < CONCEPTUAL_MARKERS.length; i++) {
      if (folded.indexOf(CONCEPTUAL_MARKERS[i]) >= 0) return { violated: false };
    }

    const named = (question.match(/\bR\d+\b/gi) || []).map(function (s) { return s.toUpperCase(); });
    if (named.length === 0) return { violated: false };

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

  /*
        ____|_______________
        | surgicalFix() | -> null
         -----------------
      No safe rewrite (we don't know which new element/angle to pivot to);
      returning null forces the consolidated LLM retry.
  */
  surgicalFix(response) {
    return null;
  }

  /*
   Txt, Obj -> ____|___________________
              | buildRetryHint() | -> Txt
               --------------------
      Per-language hint listing the settled elements and telling the LLM to
      advance or consolidate instead of re-asking topology.
  */
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
