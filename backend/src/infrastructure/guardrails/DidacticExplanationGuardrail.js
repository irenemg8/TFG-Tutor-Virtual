"use strict";

const IGuardrail = require("../../domain/ports/services/IGuardrail");

/**
 * Detects when the tutor explains concepts didactically instead of scaffolding.
 * Patterns like "esto significa que", "cuando una resistencia está" etc.
 *
 * Surgical fix strategy:
 *   1. If the response already contains a question (?), strip the explanatory
 *      sentences and keep ONLY the questions. This preserves whatever
 *      pedagogical intent the LLM had at the end of its response.
 *   2. If there is no question at all, replace the response with a brief
 *      generic redirect plus one rotating scaffolding question. This avoids
 *      leaving the student with a dead-end explanation while still being
 *      pedagogically reasonable.
 *
 * Both branches are deterministic and never name a specific element.
 */

const FALLBACK_QUESTIONS = {
  es: [
    "¿Qué condición necesita una rama del circuito para que circule corriente por ella?",
    "¿Qué ocurre con la tensión entre dos puntos que están al mismo potencial?",
    "¿Cómo se distribuye la corriente entre ramas en paralelo?",
    "¿Qué efecto tiene un camino sin resistencia entre dos nodos?",
  ],
  val: [
    "Quina condició necessita una branca del circuit perquè hi circule corrent?",
    "Què passa amb la tensió entre dos punts que estan al mateix potencial?",
    "Com es distribueix el corrent entre branques en paral·lel?",
    "Quin efecte té un camí sense resistència entre dos nodes?",
  ],
  en: [
    "What condition does a branch of the circuit need for current to flow through it?",
    "What happens to the voltage between two points that share the same potential?",
    "How does current distribute among parallel branches?",
    "What is the effect of a path with no resistance between two nodes?",
  ],
};

const FALLBACK_PREFIX = {
  es: "Vamos a no adelantar la explicación.",
  val: "No avancem l'explicació.",
  en: "Let's hold off on the explanation.",
};

class DidacticExplanationGuardrail extends IGuardrail {
  get id() { return "didactic_explanation"; }
  get severity() { return "med"; }

  check(response, ctx) {
    if (typeof response !== "string") return { violated: false };
    const { checkDidacticExplanation } = require("../../domain/services/rag/guardrails");
    const r = checkDidacticExplanation(response);
    if (!r || !r.explaining) return { violated: false };
    return { violated: true, evidence: r.details };
  }

  surgicalFix(response, ctx) {
    if (typeof response !== "string" || response.trim() === "") {
      return { applied: false, text: response };
    }
    const lang = (ctx && ctx.lang) || "es";

    // Strategy 1: keep existing questions only.
    // Match "?" or Spanish "¿...?" terminated questions; tolerate newlines.
    const qs = response.match(/[¿?][^.!?\n]*[.!?]?|[^.!?\n]*\?/g) || [];
    const cleanQs = qs.map(q => q.trim()).filter(q => q.length > 0 && q.includes("?"));
    if (cleanQs.length > 0) {
      const joined = cleanQs.slice(0, 2).join(" ").trim();
      if (joined !== response.trim()) {
        return { applied: true, text: joined, before: response, after: joined };
      }
    }

    // Strategy 2: replace with deterministic redirect + rotating fallback.
    const pool = FALLBACK_QUESTIONS[lang] || FALLBACK_QUESTIONS.es;
    const prefix = FALLBACK_PREFIX[lang] || FALLBACK_PREFIX.es;
    const fallback = prefix + " " + pool[Math.floor(Math.random() * pool.length)];
    return { applied: true, text: fallback, before: response, after: fallback };
  }

  buildRetryHint(lang) {
    const { getScaffoldInstruction } = require("../../domain/services/rag/guardrails");
    return getScaffoldInstruction(lang || "es");
  }
}

module.exports = DidacticExplanationGuardrail;
