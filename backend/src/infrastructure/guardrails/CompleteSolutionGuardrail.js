"use strict";

const IGuardrail = require("../../domain/ports/services/IGuardrail");
const { stripAccents, includesAsWord } = require("../../domain/services/text/accentNormalizer");
const { isNegatedInContext } = require("../../domain/services/text/negationDetector");
const {
  getAllPatterns,
  confirmPhrases: confirmDict,
  getCompleteSolutionInstruction,
  getRandomIntermediatePhrase,
} = require("../../domain/services/languageManager");

const confirmPhrases = getAllPatterns(confirmDict);

/**
 * Semantic guardrail: blocks the tutor from validating a wrong PART of the
 * student's answer, even when the response doesn't open with a generic
 * confirmation phrase.
 *
 * Triggers when EITHER of these holds:
 *   1. The student NEGATED an element that IS in the correct answer
 *      (e.g. "R4 no contribuye" when correctAnswer includes R4).
 *   2. The student PROPOSED an element that is NOT in the correct answer
 *      (e.g. "R3" when correctAnswer = ["R1","R2","R4"]).
 *
 * In either case, ANY opening confirmation in the tutor response is wrong —
 * the tutor must redirect with a Socratic question, not validate.
 *
 * Difference vs FalseConfirmationGuardrail: FalseConfirmation only fires when
 * the WHOLE answer is wrong (classification = wrong_answer). This one fires
 * when ANY PART is wrong — which catches cases the classifier marks as
 * partial_correct or wrong_answer with partial elements right.
 */
class CompleteSolutionGuardrail extends IGuardrail {
  get id() { return "complete_solution"; }
  get severity() { return "high"; }

  check(response, ctx) {
    if (typeof response !== "string") return { violated: false };
    const correctAnswer = (ctx && ctx.correctAnswer) || [];
    if (correctAnswer.length === 0) return { violated: false };

    const proposed = (ctx && Array.isArray(ctx.proposed)) ? ctx.proposed : [];
    const negated = (ctx && Array.isArray(ctx.negated)) ? ctx.negated : [];

    const wronglyNegated = negated.filter(function (e) {
      return correctAnswer.indexOf(e) >= 0;
    });
    const wronglyProposed = proposed.filter(function (e) {
      return correctAnswer.indexOf(e) < 0;
    });

    if (wronglyNegated.length === 0 && wronglyProposed.length === 0) {
      return { violated: false };
    }

    const lower = stripAccents(response.toLowerCase().trim());
    const firstPart = lower.substring(0, 80);

    for (let i = 0; i < confirmPhrases.length; i++) {
      const phrase = stripAccents(confirmPhrases[i]);
      if (includesAsWord(firstPart, phrase)) {
        if (isNegatedInContext(lower.substring(0, 120), phrase)) continue;
        return {
          violated: true,
          evidence:
            "tutor opens with '" + confirmPhrases[i] + "' but student got " +
            (wronglyNegated.length > 0 ? "wrongly-negated [" + wronglyNegated.join(",") + "] " : "") +
            (wronglyProposed.length > 0 ? "wrongly-proposed [" + wronglyProposed.join(",") + "] " : "") +
            "(correct answer = [" + correctAnswer.join(",") + "])",
          metadata: {
            phrase: confirmPhrases[i],
            wronglyNegated: wronglyNegated,
            wronglyProposed: wronglyProposed,
          },
        };
      }
    }
    return { violated: false };
  }

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

  buildRetryHint(lang, ctx) {
    const wronglyNegated = (ctx && ctx.wronglyNegated) || [];
    const wronglyProposed = (ctx && ctx.wronglyProposed) || [];
    return getCompleteSolutionInstruction(lang || "es", wronglyNegated, wronglyProposed);
  }
}

module.exports = CompleteSolutionGuardrail;
