"use strict";

const IGuardrail = require("../../domain/ports/services/IGuardrail");
const { stripAccents, includesAsWord } = require("../../domain/services/text/accentNormalizer");
const { isNegatedInContext } = require("../../domain/services/text/negationDetector");
const {
  getAllPatterns,
  confirmPhrases: confirmDict,
  getCompleteSolutionInstruction,
  getRandomIntermediatePhrase,
  startsWithIntermediatePhrase,
} = require("../../domain/services/languageManager");

const confirmPhrases = getAllPatterns(confirmDict);

/*------------------------------------------------------------------------------
            _________________________________________________________
            |               COMPLETESOLUTIONGUARDRAIL              |
            |  Guardrail adapter (IGuardrail). Catches the tutor     |
            |  validating a wrong PART of the answer: the student    |
            |  negated a correct element or proposed a wrong one,    |
            |  yet the response opens with a confirmation. Fires on  |
            |  partial errors that FalseConfirmation (whole-wrong)   |
            |  misses.                                               |
        ____|_____________________                                   |
        | check() | -> Obj    (reads correctAnswer, proposed, negated)|
        -----------                                                  |
        ____|_______________________                                 |
        | surgicalFix() | -> Obj | null          (reads response)    |
        -----------------                                            |
        ____|___________________                                     |
        | buildRetryHint() | -> Txt              (reads ctx)         |
        --------------------                                         |
            |                                                       |
            |_______________________________________________________|
------------------------------------------------------------------------------*/
class CompleteSolutionGuardrail extends IGuardrail {
  get id() { return "complete_solution"; }
  get severity() { return "high"; }

  /*
   Txt, Obj -> ____|_________
              | check() | -> Obj
               -----------
      True (violated) when, given a wrongly-negated or wrongly-proposed
      element, the response head opens with a non-negated confirmation.
  */
  check(response, ctx) {
    if (typeof response !== "string") return { violated: false };
    const correctAnswer = (ctx && ctx.correctAnswer) || [];
    if (correctAnswer.length === 0) return { violated: false };

    const proposed = (ctx && Array.isArray(ctx.proposed)) ? ctx.proposed : [];
    const negated = (ctx && Array.isArray(ctx.negated)) ? ctx.negated : [];

    const norm = function (x) { return typeof x === "string" ? x.toUpperCase().trim() : x; };
    const correctSet = correctAnswer.map(norm);
    const wronglyNegated = negated.filter(function (e) {
      return correctSet.indexOf(norm(e)) >= 0;
    });
    const wronglyProposed = proposed.filter(function (e) {
      return correctSet.indexOf(norm(e)) < 0;
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

  /*
   Txt, Obj -> ____|_______________
              | surgicalFix() | -> Obj | null
               -----------------
      Strips the opening confirmation and prepends a "wrong" intermediate
      phrase. Idempotent: bails out if already prefixed or nothing stripped.
  */
  surgicalFix(response, ctx) {
    if (typeof response !== "string") return null;
    if (startsWithIntermediatePhrase(response)) return { applied: false, text: response };
    const lang = (ctx && ctx.lang) || "es";
    const { removeOpeningConfirmation } = require("../../domain/services/rag/guardrails");
    const prefix = getRandomIntermediatePhrase("wrong", lang);
    if (!prefix) return { applied: false, text: response };
    const cleaned = removeOpeningConfirmation(response, lang);
    const secondPass = removeOpeningConfirmation(cleaned, lang);
    if (secondPass.trim() === response.trim()) return { applied: false, text: response };
    const fixed = prefix + " " + secondPass;
    if (fixed === response) return { applied: false, text: response };
    return { applied: true, text: fixed, before: response, after: fixed };
  }

  /*
   Txt, Obj -> ____|___________________
              | buildRetryHint() | -> Txt
               --------------------
      Derives the wrongly-negated/proposed sets from ctx (the same cross
      check() performs) and returns the complete-solution instruction.
  */
  buildRetryHint(lang, ctx) {
    const correct = ((ctx && ctx.correctAnswer) || []).map(function (x) { return String(x).toUpperCase(); });
    const proposed = ((ctx && ctx.proposed) || []).map(function (x) { return String(x).toUpperCase(); });
    const negated = ((ctx && ctx.negated) || []).map(function (x) { return String(x).toUpperCase(); });
    const wronglyNegated = (ctx && ctx.wronglyNegated) ||
      negated.filter(function (n) { return correct.indexOf(n) >= 0; });
    const wronglyProposed = (ctx && ctx.wronglyProposed) ||
      proposed.filter(function (p) { return correct.indexOf(p) < 0; });
    return getCompleteSolutionInstruction(lang || "es", wronglyNegated, wronglyProposed);
  }
}

module.exports = CompleteSolutionGuardrail;
