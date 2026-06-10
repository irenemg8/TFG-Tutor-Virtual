"use strict";

const IGuardrail = require("../../domain/ports/services/IGuardrail");
const {
  HEURISTIC_STOPWORDS,
  getAllPatterns,
  getRepeatedQuestionRetryHint,
  QUESTION_FRAME_STOPWORDS,
} = require("../../domain/services/languageManager");

/**
 * BUG-010-C (2026-05-03): red de seguridad post-LLM contra repetición
 * literal de la pregunta socrática del turno anterior. El banner
 * [DO NOT REPEAT YOUR PREVIOUS QUESTION] del tutorAgent ya advierte al
 * LLM, pero qwen2.5 7B ignora la instrucción con cierta frecuencia.
 *
 * Mecanismo:
 *   - check(): extrae la última pregunta del response y la última del
 *     mensaje assistant más reciente (ctx.messages). Calcula similarity
 *     por solapamiento de tokens-no-stopword. Si ratio >= 0.7, viola.
 *   - surgicalFix(): no rescribe la pregunta (no podemos saber qué AC
 *     debería atacar). Devuelve null para forzar retry con el hint.
 *   - buildRetryHint(): centralised in languageManager.
 *
 * No dispara si la respuesta nueva no contiene "?". No dispara si no hay
 * pregunta previa identificable.
 */

// Combined stopwords for question tokenization: union of all language stopwords
// plus common question-framing words. Sourced from languageManager so adding
// a 4th language only requires editing that file.
const STOPWORDS = new Set([
  ...getAllPatterns(HEURISTIC_STOPWORDS),
  ...QUESTION_FRAME_STOPWORDS,
]);

function _tokenizeContent(text) {
  if (typeof text !== "string") return [];
  return text
    .toLowerCase()
    .replace(/[¿¡?!.,;:()"'`´‘’“”]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length >= 3 && !STOPWORDS.has(t));
}

function _extractLastQuestion(text) {
  if (typeof text !== "string" || text.length === 0) return "";
  const matches = text.match(/[¿]?[^.!?]*\?/g);
  if (!matches || matches.length === 0) return "";
  return matches[matches.length - 1].trim();
}

function _similarity(qa, qb) {
  const a = _tokenizeContent(qa);
  const b = _tokenizeContent(qb);
  if (a.length === 0 || b.length === 0) return 0;
  const setB = new Set(b);
  let overlap = 0;
  for (let i = 0; i < a.length; i++) {
    if (setB.has(a[i])) overlap++;
  }
  // BUG-G4 (2026-06-10): the denominator used to be min(len), which is
  // ASYMMETRIC — a short new question whose content tokens are a SUBSET of a
  // longer, semantically different previous question scored 1.0 and was
  // flagged as a repeat (false positive, forcing a needless retry). max(len)
  // is symmetric: a true repeat (similar length, high overlap) still scores
  // high, but "¿qué resistencias importan?" vs a long unrelated question no
  // longer reaches the 0.7 threshold.
  return overlap / Math.max(a.length, b.length);
}

function _findLastAssistantQuestion(messages) {
  if (!Array.isArray(messages)) return "";
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m && m.role === "assistant" && typeof m.content === "string") {
      const q = _extractLastQuestion(m.content);
      if (q.length > 0) return q;
    }
  }
  return "";
}

class RepeatedQuestionGuardrail extends IGuardrail {
  get id() { return "repeated_question"; }
  get severity() { return "med"; }

  check(response, ctx) {
    if (typeof response !== "string" || response.length === 0) {
      return { violated: false };
    }
    const newQ = _extractLastQuestion(response);
    if (newQ.length === 0) return { violated: false };
    const prevQ = _findLastAssistantQuestion((ctx && ctx.messages) || []);
    if (prevQ.length === 0) return { violated: false };
    const sim = _similarity(newQ, prevQ);
    if (sim < 0.7) return { violated: false };
    return {
      violated: true,
      evidence:
        "similarity=" + sim.toFixed(2) +
        " newQ='" + newQ.slice(0, 60) + "'" +
        " prevQ='" + prevQ.slice(0, 60) + "'",
    };
  }

  surgicalFix(response, ctx) {
    if (typeof response !== "string") return null;
    const r = this.check(response, ctx);
    if (!r.violated) return { applied: false, text: response };
    // No podemos rescribir la pregunta — necesitamos el LLM. Forzamos retry.
    return null;
  }

  buildRetryHint(lang, ctx) {
    const prevQ = ctx && Array.isArray(ctx.messages)
      ? _findLastAssistantQuestion(ctx.messages)
      : "";
    return getRepeatedQuestionRetryHint(lang, prevQ);
  }
}

module.exports = RepeatedQuestionGuardrail;
module.exports._tokenizeContent = _tokenizeContent;
module.exports._extractLastQuestion = _extractLastQuestion;
module.exports._similarity = _similarity;
