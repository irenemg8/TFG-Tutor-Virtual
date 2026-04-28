"use strict";

const IGuardrail = require("../../domain/ports/services/IGuardrail");
const { extractResistances } = require("../../domain/services/text/elementExtractor");
const { containsAll } = require("../../domain/services/text/setComparison");
const { splitSentencesKeepEnd } = require("../../domain/services/text/sentenceSplitter");
const { getAllPatterns, revealPhrases: revealDict, getStrongerInstruction } = require("../../domain/services/languageManager");

const revealPhrases = getAllPatterns(revealDict);

/**
 * Detects when the tutor reveals the correct answer by either:
 *   (a) using an explicit reveal phrase ("la respuesta es...") when all
 *       correct elements are also mentioned, OR
 *   (b) listing ALL correct elements together in an affirmative sentence
 *       (not a question).
 *
 * Surgical fix: delegate to redactElementMentions (keeps shape of response,
 * replaces the specific element list with a generic placeholder).
 */
class SolutionLeakGuardrail extends IGuardrail {
  get id() { return "solution_leak"; }
  get severity() { return "high"; }

  check(response, ctx) {
    const correctAnswer = (ctx && ctx.correctAnswer) || [];
    if (typeof response !== "string" || correctAnswer.length === 0) {
      return { violated: false };
    }

    const lower = response.toLowerCase();
    const mentioned = extractResistances(response);
    if (!containsAll(mentioned, correctAnswer)) {
      return { violated: false };
    }

    // (a) explicit reveal phrase
    for (let i = 0; i < revealPhrases.length; i++) {
      if (lower.includes(revealPhrases[i])) {
        return {
          violated: true,
          evidence: "reveal_phrase: '" + revealPhrases[i] + "'",
        };
      }
    }

    // (b) all correct elements in one AFFIRMATIVE sentence
    if (correctAnswer.length >= 2) {
      const sorted = correctAnswer.slice().sort();
      let pattern = sorted[0];
      for (let i = 1; i < sorted.length; i++) {
        pattern += "[,\\s]+(y\\s+)?" + sorted[i];
      }
      const regex = new RegExp(pattern, "i");
      if (regex.test(response)) {
        const sentences = splitSentencesKeepEnd(response);
        for (let i = 0; i < sentences.length; i++) {
          if (regex.test(sentences[i]) && !sentences[i].includes("?")) {
            return {
              violated: true,
              evidence: "affirmative sentence lists all correct elements: '" + sentences[i] + "'",
            };
          }
        }
      }
    }
    return { violated: false };
  }

  /**
   * Surgical fix: redact the element list using the existing helper from
   * guardrails.js. Keeps rest of the response intact.
   * Deferred import to avoid circular deps.
   */
  surgicalFix(response, ctx) {
    if (typeof response !== "string") return null;
    const correctAnswer = (ctx && ctx.correctAnswer) || [];
    const lang = (ctx && ctx.lang) || "es";
    const { redactElementMentions } = require("../../domain/services/rag/guardrails");
    const r = redactElementMentions(response, correctAnswer, lang);
    if (!r || !r.redacted) return { applied: false, text: response };
    return { applied: true, text: r.text, before: response, after: r.text };
  }

  buildRetryHint(lang) {
    return getStrongerInstruction(lang || "es");
  }
}

module.exports = SolutionLeakGuardrail;
