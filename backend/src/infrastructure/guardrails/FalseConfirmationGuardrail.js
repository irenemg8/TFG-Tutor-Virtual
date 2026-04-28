"use strict";

const IGuardrail = require("../../domain/ports/services/IGuardrail");
const { stripAccents, includesAsWord } = require("../../domain/services/text/accentNormalizer");
const { isNegatedInContext } = require("../../domain/services/text/negationDetector");
const { getAllPatterns, confirmPhrases: confirmDict, getFalseConfirmationInstruction, getRandomIntermediatePhrase } = require("../../domain/services/languageManager");

const confirmPhrases = getAllPatterns(confirmDict);

/**
 * Detects when the tutor falsely CONFIRMS a student's wrong answer by opening
 * with a positive phrase ("Perfecto", "Correcto", "Exactamente").
 *
 * Fix for the key false positive: "No es exactamente así" used to trigger
 * because the old check was pure substring match. Now we call
 * isNegatedInContext() on the shared NegationDetector — if the phrase is
 * preceded by "no", "no es", "sin", etc., it is NOT a confirmation.
 *
 * Only active when the student's message was classified as WRONG.
 */
class FalseConfirmationGuardrail extends IGuardrail {
  get id() { return "false_confirmation"; }
  get severity() { return "high"; }

  check(response, ctx) {
    const classification = ctx && ctx.classification;
    const wrongTypes = ["wrong_answer", "wrong_concept", "single_word"];
    if (wrongTypes.indexOf(classification) < 0) return { violated: false };
    if (typeof response !== "string") return { violated: false };

    const lower = stripAccents(response.toLowerCase().trim());
    // Scan the head of the response: up to the first Socratic question mark
    // (which marks the end of the lead-in / start of the actual question)
    // OR up to 200 characters, whichever comes first. The legacy 60-char
    // window missed real cases like "Vamos a pensar paso a paso,
    // considerando la Ley de Ohm. Exactamente, así es como...". Capping at
    // the first "?" prevents false positives where a confirmation word
    // appears INSIDE a Socratic question further down ("¿está claro?").
    const firstQ = lower.indexOf("?");
    const cap = firstQ >= 0 ? Math.min(firstQ, 200) : 200;
    const firstPart = lower.slice(0, cap);

    for (let i = 0; i < confirmPhrases.length; i++) {
      const phrase = stripAccents(confirmPhrases[i]);
      // Word-boundary match: prevents English "correct" from matching inside
      // Spanish "correctas", and similar cross-language false positives.
      if (includesAsWord(firstPart, phrase)) {
        // CRITICAL: is the phrase actually negated in context?
        // "No es exactamente así" contains "exactamente" but is NOT a confirmation.
        if (isNegatedInContext(firstPart, phrase)) {
          continue; // skip this match — it's a negation, not a confirmation
        }
        return {
          violated: true,
          evidence: "opens with confirmation phrase: '" + confirmPhrases[i] + "'",
          metadata: { phrase: confirmPhrases[i] },
        };
      }
    }
    return { violated: false };
  }

  /**
   * Surgical fix: prepend a corrective phrase like "Eso no es del todo preciso"
   * and strip the opening confirmation. Uses languageManager primitives so
   * phrasing matches the user's language.
   */
  surgicalFix(response, ctx) {
    if (typeof response !== "string") return null;
    const lang = (ctx && ctx.lang) || "es";
    const { removeOpeningConfirmation } = require("../../domain/services/rag/guardrails");
    const prefix = getRandomIntermediatePhrase("wrong", lang);
    if (!prefix) return { applied: false, text: response };
    const cleaned = removeOpeningConfirmation(response, lang);
    const secondPass = removeOpeningConfirmation(cleaned, lang);
    const fixed = prefix + " " + secondPass;
    if (fixed === response) return { applied: false, text: response };
    return { applied: true, text: fixed, before: response, after: fixed };
  }

  buildRetryHint(lang) {
    return getFalseConfirmationInstruction(lang || "es");
  }
}

module.exports = FalseConfirmationGuardrail;
