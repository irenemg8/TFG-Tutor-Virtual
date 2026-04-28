"use strict";

const IGuardrail = require("../../domain/ports/services/IGuardrail");
const { stripAccents, includesAsWord } = require("../../domain/services/text/accentNormalizer");
const { isNegatedInContext } = require("../../domain/services/text/negationDetector");
const { getAllPatterns, confirmPhrases: confirmDict, getPartialConfirmationInstruction, getRandomIntermediatePhrase } = require("../../domain/services/languageManager");

const confirmPhrases = getAllPatterns(confirmDict);

/**
 * Detects when the tutor CLOSES an exercise prematurely by confirming a
 * partially-correct or correct-without-reasoning answer.
 *
 * Triggers when classification indicates the student gave elements but
 * hasn't justified their reasoning — the tutor must ask WHY before confirming.
 *
 * Same negation-awareness as FalseConfirmation: "No es correcto todavía" is
 * NOT a confirmation because of the preceding "no".
 */
class PrematureConfirmationGuardrail extends IGuardrail {
  get id() { return "premature_confirmation"; }
  get severity() { return "high"; }

  check(response, ctx) {
    const classification = ctx && ctx.classification;
    const partialTypes = ["correct_no_reasoning", "correct_wrong_reasoning", "partial_correct"];
    if (partialTypes.indexOf(classification) < 0) return { violated: false };
    if (typeof response !== "string") return { violated: false };

    const lower = stripAccents(response.toLowerCase().trim());
    const firstPart = lower.substring(0, 60);

    for (let i = 0; i < confirmPhrases.length; i++) {
      const phrase = stripAccents(confirmPhrases[i]);
      // Word-boundary match: avoids English "correct" matching inside Spanish
      // "correctas", "correctamente", etc.
      if (includesAsWord(firstPart, phrase)) {
        if (isNegatedInContext(lower.substring(0, 100), phrase)) continue;
        return {
          violated: true,
          evidence: "prematurely confirms with: '" + confirmPhrases[i] + "'",
          metadata: { phrase: confirmPhrases[i] },
        };
      }
    }
    return { violated: false };
  }

  surgicalFix(response, ctx) {
    if (typeof response !== "string") return null;
    const lang = (ctx && ctx.lang) || "es";
    const { removeOpeningConfirmation } = require("../../domain/services/rag/guardrails");
    const prefix = getRandomIntermediatePhrase("partial", lang);
    if (!prefix) return { applied: false, text: response };
    const cleaned = removeOpeningConfirmation(response, lang);
    const secondPass = removeOpeningConfirmation(cleaned, lang);
    const fixed = prefix + " " + secondPass;
    if (fixed === response) return { applied: false, text: response };
    return { applied: true, text: fixed, before: response, after: fixed };
  }

  buildRetryHint(lang) {
    // Partial instruction depends on classification; pipeline will pass ctx.
    return getPartialConfirmationInstruction(lang || "es", "correct_no_reasoning");
  }
}

module.exports = PrematureConfirmationGuardrail;
