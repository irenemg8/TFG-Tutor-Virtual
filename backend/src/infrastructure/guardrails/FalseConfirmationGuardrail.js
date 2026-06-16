"use strict";

const IGuardrail = require("../../domain/ports/services/IGuardrail");
const { stripAccents, includesAsWord } = require("../../domain/services/text/accentNormalizer");
const { splitSentencesKeepEnd } = require("../../domain/services/text/sentenceSplitter");
const { isNegatedInContext } = require("../../domain/services/text/negationDetector");
const { getAllPatterns, confirmPhrases: confirmDict, getFalseConfirmationInstruction, getRandomIntermediatePhrase, startsWithIntermediatePhrase } = require("../../domain/services/languageManager");

const confirmPhrases = getAllPatterns(confirmDict);

/*------------------------------------------------------------------------------
            _________________________________________________________
            |               FALSECONFIRMATIONGUARDRAIL             |
            |  Guardrail adapter (IGuardrail). Catches the tutor     |
            |  falsely CONFIRMING a wrong answer by opening with a   |
            |  positive phrase ("Perfecto", "Correcto"). Active only |
            |  for WRONG classifications; negation- and              |
            |  question-aware to avoid false positives.              |
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
class FalseConfirmationGuardrail extends IGuardrail {
  get id() { return "false_confirmation"; }
  get severity() { return "high"; }

  /*
   Txt, Obj -> ____|_________
              | check() | -> Obj
               -----------
      True (violated) when, for a WRONG answer that named elements, a
      declarative sentence in the head opens with a non-negated confirmation.
  */
  check(response, ctx) {
    const classification = ctx && ctx.classification;
    const wrongTypes = ["wrong_answer", "wrong_concept"];
    if (wrongTypes.indexOf(classification) < 0) return { violated: false };
    if (typeof response !== "string") return { violated: false };

    const mentionedElements = ctx && ctx.mentionedElements;
    const noElementsMentioned = !Array.isArray(mentionedElements) || mentionedElements.length === 0;
    if (noElementsMentioned) return { violated: false };

    const sentences = splitSentencesKeepEnd(response);
    let budget = 200;
    for (let s = 0; s < sentences.length && budget > 0; s++) {
      if (sentences[s].includes("?")) continue;
      const sentLower = stripAccents(sentences[s].toLowerCase().trim());
      const slice = sentLower.slice(0, budget);
      budget -= slice.length;
      for (let i = 0; i < confirmPhrases.length; i++) {
        const phrase = stripAccents(confirmPhrases[i]);
        if (includesAsWord(slice, phrase)) {
          if (isNegatedInContext(slice, phrase)) {
            continue;
          }
          return {
            violated: true,
            evidence: "opens with confirmation phrase: '" + confirmPhrases[i] + "'",
            metadata: { phrase: confirmPhrases[i] },
          };
        }
      }
    }
    return { violated: false };
  }

  /*
   Txt, Obj -> ____|_______________
              | surgicalFix() | -> Obj | null
               -----------------
      Strips the opening confirmation and prepends a "wrong" intermediate
      phrase, in the user's language. Idempotent: bails out if the text
      already starts with an intermediate phrase or nothing was stripped.
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
   Txt -> ____|___________________
         | buildRetryHint() | -> Txt
          --------------------
      Returns the false-confirmation instruction for the given language.
  */
  buildRetryHint(lang) {
    return getFalseConfirmationInstruction(lang || "es");
  }
}

module.exports = FalseConfirmationGuardrail;
