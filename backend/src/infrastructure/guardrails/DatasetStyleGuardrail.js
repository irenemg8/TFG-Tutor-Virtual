"use strict";

const IGuardrail = require("../../domain/ports/services/IGuardrail");

/*------------------------------------------------------------------------------
            _________________________________________________________
            |                   DATASETSTYLEGUARDRAIL               |
            |  Guardrail adapter (IGuardrail). Catches the tutor     |
            |  emitting markdown (bullets, bold, numbered lists,     |
            |  headings); the training dataset has none, so any      |
            |  markdown is off-style and must be stripped.           |
        ____|_____________________                                   |
        | check() | -> Obj                       (reads response)    |
        -----------                                                  |
        ____|_______________________                                 |
        | surgicalFix() | -> Obj | null          (reads response)    |
        -----------------                                            |
        ____|___________________                                     |
        | buildRetryHint() | -> Txt              (surgical-only)     |
        --------------------                                         |
            |                                                       |
            |_______________________________________________________|
------------------------------------------------------------------------------*/
class DatasetStyleGuardrail extends IGuardrail {
  get id() { return "dataset_style"; }
  get severity() { return "low"; }

  /*
   Txt, Obj -> ____|_________
              | check() | -> Obj
               -----------
      True (violated) when the response carries markdown formatting; the
      cleaned text is returned in metadata.
  */
  check(response, ctx) {
    if (typeof response !== "string") return { violated: false };
    const { enforceDatasetStyle } = require("../../domain/services/rag/guardrails");
    const r = enforceDatasetStyle(response);
    if (!r || !r.changed) return { violated: false };
    return { violated: true, evidence: "contains markdown formatting", metadata: { cleanText: r.text } };
  }

  /*
   Txt, Obj -> ____|_______________
              | surgicalFix() | -> Obj | null
               -----------------
      Deterministically strips the markdown and returns the cleaned text,
      or applied:false when nothing changed.
  */
  surgicalFix(response, ctx) {
    if (typeof response !== "string") return null;
    const { enforceDatasetStyle } = require("../../domain/services/rag/guardrails");
    const r = enforceDatasetStyle(response);
    if (!r || !r.changed) return { applied: false, text: response };
    return { applied: true, text: r.text, before: response, after: r.text };
  }

  /*
   Txt -> ____|___________________
         | buildRetryHint() | -> Txt
          --------------------
      Empty string: this guardrail is surgical-only and never forces a retry.
  */
  buildRetryHint(lang) {
    return "";
  }
}

module.exports = DatasetStyleGuardrail;
