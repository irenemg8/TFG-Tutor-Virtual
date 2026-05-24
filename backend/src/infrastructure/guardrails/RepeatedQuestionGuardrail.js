"use strict";

const IGuardrail = require("../../domain/ports/services/IGuardrail");

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
 *   - buildRetryHint(): refuerza la instrucción de variar.
 *
 * No dispara si la respuesta nueva no contiene "?". No dispara si no hay
 * pregunta previa identificable.
 */

const STOPWORDS = new Set([
  // ES
  "el","la","los","las","un","una","de","del","y","o","u","que","qué","es","en",
  "se","su","sus","con","sin","para","por","si","no","sí","te","le","me","la","lo",
  "este","esta","estos","estas","ese","esa","esos","esas","aquí","allí","cómo",
  "cuál","cuándo","dónde","podrías","podrias","decirme","explicarme","crees",
  "piensas","puedes","creo","pienso","yo","tú","tu","él","ella","nos","nosotros",
  // VAL
  "els","les","i","però","perquè","amb","sense","és","són","i","així","com","quin",
  // EN
  "the","a","an","of","to","and","or","but","because","for","with","without","in",
  "on","at","is","are","was","were","you","your","he","she","it","we","they",
  "this","that","these","those","what","which","when","where","how","do","does",
  "did","have","has","think","could","would","should",
  // funcionales
  "más","mas","menos","muy","tan","tanto","ya","aún","también",
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
  // Solapamiento sobre la lista más corta — más sensible cuando una pregunta
  // tiene 5 tokens content y la otra 6: si los 5 coinciden, similarity=1.0.
  return overlap / Math.min(a.length, b.length);
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
    // Si tenemos ctx.messages, citar literalmente la pregunta previa para
    // que qwen2.5 no la repita. El hint genérico solo lo ignora.
    var prevQ = "";
    if (ctx && Array.isArray(ctx.messages)) {
      prevQ = _findLastAssistantQuestion(ctx.messages);
    }
    var literal = prevQ.length > 0
      ? "\nPrevious question to AVOID: «" + prevQ.replace(/\s+/g, " ").trim() + "»"
      : "";
    if (lang === "en") {
      return (
        "\n\nIMPORTANT: Your previous reply repeated almost verbatim the " +
        "Socratic question you already asked the previous turn." + literal +
        "\nPick a DIFFERENT angle: change the element you focus on, change the " +
        "question shape (yes/no vs open), or give a concrete factual hint " +
        "and ask whether the student agrees."
      );
    }
    if (lang === "val") {
      return (
        "\n\nIMPORTANT: La teua resposta anterior repetia quasi paraula per " +
        "paraula la pregunta socràtica del torn previ." + literal +
        "\nTria un ANGLE DIFERENT: canvia l'element en què et centres, canvia la forma de " +
        "la pregunta (sí/no vs oberta), o dóna un fet concret i pregunta " +
        "si l'alumne hi està d'acord."
      );
    }
    return (
      "\n\nIMPORTANTE: Tu respuesta anterior repetía casi palabra por " +
      "palabra la pregunta socrática del turno previo." + literal +
      "\nElige un ÁNGULO DIFERENTE: cambia el elemento en el que te centras, cambia la " +
      "forma de la pregunta (sí/no vs abierta), o da un hecho concreto y " +
      "pregunta si el alumno está de acuerdo."
    );
  }
}

module.exports = RepeatedQuestionGuardrail;
module.exports._tokenizeContent = _tokenizeContent;
module.exports._extractLastQuestion = _extractLastQuestion;
module.exports._similarity = _similarity;
