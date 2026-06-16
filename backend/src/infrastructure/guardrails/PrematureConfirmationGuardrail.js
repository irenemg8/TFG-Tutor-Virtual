"use strict";

const IGuardrail = require("../../domain/ports/services/IGuardrail");
const { stripAccents, includesAsWord } = require("../../domain/services/text/accentNormalizer");
const { isNegatedInContext } = require("../../domain/services/text/negationDetector");
const { getAllPatterns, confirmPhrases: confirmDict, getPartialConfirmationInstruction, getRandomIntermediatePhrase, startsWithIntermediatePhrase } = require("../../domain/services/languageManager");

const confirmPhrases = getAllPatterns(confirmDict);

/*------------------------------------------------------------------------------
            _________________________________________________________
            |              PREMATURECONFIRMATIONGUARDRAIL           |
            |  Guardrail adapter (IGuardrail). Catches the tutor     |
            |  closing the exercise too soon by confirming a         |
            |  partial / unjustified answer instead of asking WHY    |
            |  first. Negation-aware ("No es correcto todavía").     |
        ____|_____________________                                   |
        | check() | -> Obj            (reads classification, response)|
        -----------                                                  |
        ____|_______________________                                 |
        | surgicalFix() | -> Obj | null          (reads response)    |
        -----------------                                            |
        ____|___________________                                     |
        | buildRetryHint() | -> Txt                                  |
        --------------------                                         |
            |                                                       |
            |_______________________________________________________|
------------------------------------------------------------------------------*/
class PrematureConfirmationGuardrail extends IGuardrail {
  get id() { return "premature_confirmation"; }
  get severity() { return "high"; }

  /*
   Txt, Obj -> ____|_________
              | check() | -> Obj
               -----------
      Active only for partial/no-reasoning classifications; true (violated)
      when the response head opens with a (non-negated) confirmation phrase.
  */
  check(response, ctx) {
    const classification = ctx && ctx.classification;
    const partialTypes = ["correct_no_reasoning", "correct_wrong_reasoning", "partial_correct"];
    if (partialTypes.indexOf(classification) < 0) return { violated: false };
    if (typeof response !== "string") return { violated: false };

    const lower = stripAccents(response.toLowerCase().trim());
    const firstPart = lower.substring(0, 60);

    for (let i = 0; i < confirmPhrases.length; i++) {
      const phrase = stripAccents(confirmPhrases[i]);
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

  /*
   Txt, Obj -> ____|_______________
              | surgicalFix() | -> Obj | null
               -----------------
      Strips the opening confirmation and prepends a "partial" intermediate
      phrase. Idempotent: bails out if the text already starts with one.
  */
  surgicalFix(response, ctx) {
    if (typeof response !== "string") return null;
    if (startsWithIntermediatePhrase(response)) return { applied: false, text: response };
    const lang = (ctx && ctx.lang) || "es";
    const { removeOpeningConfirmation } = require("../../domain/services/rag/guardrails");
    const prefix = getRandomIntermediatePhrase("partial", lang);
    if (!prefix) return { applied: false, text: response };
    const cleaned = removeOpeningConfirmation(response, lang);
    const secondPass = removeOpeningConfirmation(cleaned, lang);
    if (secondPass.trim() === response.trim()) return { applied: false, text: response };
    const fixed = prefix + " " + secondPass;
    if (fixed === response) return { applied: false, text: response };
    return { applied: true, text: fixed, before: response, after: fixed };
  }

  /*
   Txt -> ____|___________________
         | buildRetryHint() | -> Txt
          --------------------
      Returns the partial-confirmation instruction for the given language.
  */
  buildRetryHint(lang) {
    return getPartialConfirmationInstruction(lang || "es", "correct_no_reasoning");
  }
}

module.exports = PrematureConfirmationGuardrail;
