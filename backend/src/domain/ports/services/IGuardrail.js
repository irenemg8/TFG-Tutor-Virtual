"use strict";

/**
 * IGuardrail: port for output guardrails that validate LLM tutor responses.
 *
 * Contract (each adapter MUST implement):
 *   - id: string          — stable name, used in logs/traces (e.g. "solution_leak")
 *   - check(response, ctx) → CheckResult   (sync or async, returned value)
 *
 * Optional overrides:
 *   - surgicalFix(response, ctx) → FixResult | null
 *       Deterministic, fast (<1ms ideal) repair of the offending text.
 *       Return null (default) if the guardrail cannot fix itself without the LLM.
 *   - buildRetryHint(lang) → string
 *       Instruction to append to the system prompt if an LLM retry is needed.
 *       Return "" (default) for guardrails that rely only on surgical fixes.
 *   - severity (getter) → "high" | "med" | "low"
 *       Priority for the pipeline's consolidation logic. Default "med".
 *
 * Types:
 *   CheckResult  = { violated: bool, evidence?: string, metadata?: object }
 *   FixResult    = { applied: bool, text: string, before?: string, after?: string }
 *   Ctx          = {
 *     classification?: string,            // e.g. "wrong_answer"
 *     correctAnswer?: string[],           // e.g. ["R1","R2","R4"]
 *     evaluableElements?: string[],       // all possible answer elements
 *     kgConceptPatterns?: string[],       // state-reveal patterns from KG
 *     lang?: string,                      // "es" | "val" | "en"
 *     mentionedElements?: string[],       // elements the student mentioned
 *   }
 *
 * Adapters are PURE: no side effects, no state, no I/O. This makes them:
 *   - Trivially unit-testable (pass inputs, assert outputs)
 *   - Parallelizable (Promise.all)
 *   - Composable in arbitrary order
 */
class IGuardrail {
  /** Stable identifier — used for logs, traces, and retry consolidation. */
  get id() {
    throw new Error("IGuardrail.id must be implemented by adapter");
  }

  /** Default severity; adapters may override. */
  get severity() {
    return "med";
  }

  /**
   * Check whether `response` violates this guardrail given the context.
   * @param {string} response - the LLM-generated tutor response
   * @param {object} ctx - see Ctx above
   * @returns {{violated: boolean, evidence?: string, metadata?: object}}
   */
  check(response, ctx) {
    throw new Error("IGuardrail.check must be implemented by adapter");
  }

  /**
   * Try to repair the response deterministically without calling the LLM.
   * Default: no surgical fix available.
   * @returns {{applied: boolean, text: string, before?: string, after?: string} | null}
   */
  surgicalFix(response, ctx) {
    return null;
  }

  /**
   * Build the prompt-suffix instruction used when the pipeline needs an LLM
   * retry to fix violations of this guardrail. Default: empty string.
   * @param {string} lang - "es" | "val" | "en"
   * @returns {string}
   */
  buildRetryHint(lang) {
    return "";
  }
}

module.exports = IGuardrail;
