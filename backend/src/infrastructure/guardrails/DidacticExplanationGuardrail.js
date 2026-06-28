"use strict";

const IGuardrail = require("../../domain/ports/services/IGuardrail");
const {
  getDidacticFallbackQuestions,
  getDidacticFallbackPrefix,
} = require("../../domain/services/languageManager");

/*------------------------------------------------------------------------------
            _________________________________________________________
            |               DIDACTICEXPLANATIONGUARDRAIL            |
            |  Guardrail adapter (IGuardrail). Catches the tutor     |
            |  lecturing the concept ("esto significa que", "cuando  |
            |  una resistencia está…") instead of scaffolding with   |
            |  a Socratic question.                                  |
        ____|_____________________                                   |
        | check() | -> Obj                       (reads response)    |
        -----------                                                  |
        ____|_______________________                                 |
        | surgicalFix() | -> Obj                 (reads response)    |
        -----------------                                            |
        ____|___________________                                     |
        | buildRetryHint() | -> Txt                                  |
        --------------------                                         |
            |                                                       |
            |_______________________________________________________|
------------------------------------------------------------------------------*/

class DidacticExplanationGuardrail extends IGuardrail {
  get id() { return "didactic_explanation"; }
  get severity() { return "med"; }

  /*
   Txt, Obj -> ____|_________
              | check() | -> Obj
               -----------
      True (violated) when the response explains didactically rather than
      scaffolding; the detected detail is returned as evidence.
  */
  check(response, ctx) {
    if (typeof response !== "string") return { violated: false };
    const { checkDidacticExplanation } = require("../../domain/services/rag/guardrails");
    const r = checkDidacticExplanation(response);
    if (!r || !r.explaining) return { violated: false };
    return { violated: true, evidence: r.details };
  }

  /*
   Txt, Obj -> ____|_______________
              | surgicalFix() | -> Obj
               -----------------
      Two deterministic strategies, neither naming an element: keep only the
      existing question(s) when present, else replace with a redirect plus
      one rotating scaffolding question.
  */
  surgicalFix(response, ctx) {
    if (typeof response !== "string" || response.trim() === "") {
      return { applied: false, text: response };
    }
    const lang = (ctx && ctx.lang) || "es";

    const qs = response.match(/[¿?][^.!?\n]*[.!?]?|[^.!?\n]*\?/g) || [];
    const cleanQs = qs.map(q => q.trim()).filter(q => q.length > 0 && q.includes("?"));
    if (cleanQs.length > 0) {
      const joined = cleanQs.slice(0, 2).join(" ").trim();
      if (joined !== response.trim()) {
        return { applied: true, text: joined, before: response, after: joined };
      }
    }

    const pool = getDidacticFallbackQuestions(lang);
    const prefix = getDidacticFallbackPrefix(lang);
    const fallback = prefix + " " + pool[Math.floor(Math.random() * pool.length)];
    return { applied: true, text: fallback, before: response, after: fallback };
  }

  /*
   Txt -> ____|___________________
         | buildRetryHint() | -> Txt
          --------------------
      Delegates to the scaffolding instruction for the given language.
  */
  buildRetryHint(lang) {
    const { getScaffoldInstruction } = require("../../domain/services/rag/guardrails");
    return getScaffoldInstruction(lang || "es");
  }
}

module.exports = DidacticExplanationGuardrail;
