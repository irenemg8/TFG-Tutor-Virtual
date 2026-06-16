"use strict";

/*------------------------------------------------------------------------------
            _________________________________________________________
            |                      IGUARDRAIL                       |
            |  Port/interface defining the contract for output      |
            |  guardrails that validate LLM tutor responses.        |
            |  Adapters are PURE (no side effects, state or I/O),   |
            |  making them unit-testable, parallelizable and        |
            |  composable in arbitrary order. id and check() are    |
            |  abstract (throw); the rest ship safe defaults.       |
            |                                                       |
        ____|_______                                               |
        | id | -> Txt                                              |
        -----                                                       |
        ____|___________                                           |
        | severity | -> Txt                                        |
        -----------                                                 |
        ____|________________                                      |
   Txt, Obj -> | check() | -> Obj                                 |
              ----------                                           |
        ____|_______________                                       |
   Txt, Obj -> | surgicalFix() | -> Obj | null                    |
              ---------------                                      |
        ____|____________________                                  |
   Txt -> | buildRetryHint() | -> Txt                              |
          ------------------                                       |
            |                                                       |
            |_______________________________________________________|
------------------------------------------------------------------------------*/
class IGuardrail {
  /*
       ____|_______
      | id | -> Txt
       -----
      Contract: stable identifier used for logs, traces and retry
      consolidation (e.g. "solution_leak"). Abstract here.
  */
  get id() {
    throw new Error("IGuardrail.id must be implemented by adapter");
  }

  /*
       ____|___________
      | severity | -> Txt
       -----------
      Returns the guardrail's priority for the pipeline's consolidation
      logic. Defaults to "med"; adapters may override with "high" or
      "low".
  */
  get severity() {
    return "med";
  }

  /*
   Txt, Obj -> ____|__________
              | check() | -> Obj
               ----------
      Contract: decide whether the response violates this guardrail
      given the context, returning { violated, evidence?, metadata? }.
      Abstract here (sync or async in adapters).
  */
  check(response, ctx) {
    throw new Error("IGuardrail.check must be implemented by adapter");
  }

  /*
   Txt, Obj -> ____|_______________
              | surgicalFix() | -> Obj | null
               ---------------
      Tries to repair the response deterministically without the LLM,
      returning { applied, text, before?, after? }. Default
      implementation returns null when no surgical fix is available.
  */
  surgicalFix(response, ctx) {
    return null;
  }

  /*
   Txt -> ____|____________________
         | buildRetryHint() | -> Txt
          ------------------
      Builds the prompt-suffix instruction appended when the pipeline
      needs an LLM retry to fix violations. Default implementation
      returns the empty string.
  */
  buildRetryHint(lang) {
    return "";
  }
}

module.exports = IGuardrail;
