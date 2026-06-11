"use strict";

// Guardrail registry: default set of output guardrails to enforce on LLM
// tutor responses. Ordered by severity — the GuardrailPipeline doesn't care
// about order (checks run in parallel), but logs read better when listed
// from most to least important.

const SolutionLeakGuardrail = require("./SolutionLeakGuardrail");
const FalseConfirmationGuardrail = require("./FalseConfirmationGuardrail");
const PrematureConfirmationGuardrail = require("./PrematureConfirmationGuardrail");
const CompleteSolutionGuardrail = require("./CompleteSolutionGuardrail");
const StateRevealGuardrail = require("./StateRevealGuardrail");
// ElementNamingGuardrail retired 2026-05-03 (NS-32): redactaba "Rn" →
// "ese conjunto de elementos", lo que generaba respuestas vagas como
// "Vamos a pensar en los dos terminales de ese conjunto de elementos".
// Decidimos que el tutor pueda decir "Resistencia R1" textual.
const AdherenceGuardrail = require("./AdherenceGuardrail");
const DidacticExplanationGuardrail = require("./DidacticExplanationGuardrail");
const DatasetStyleGuardrail = require("./DatasetStyleGuardrail");
const LanguageDriftGuardrail = require("./LanguageDriftGuardrail");
const RepeatedQuestionGuardrail = require("./RepeatedQuestionGuardrail");
const SettledElementQuestionGuardrail = require("./SettledElementQuestionGuardrail");

/**
 * Build the DEFAULT guardrail list — only hard safety checks. The
 * pedagogical-style guardrails (premature confirmation, didactic
 * explanation, dataset style) are now handled by the
 * PedagogicalReviewerAgent BEFORE the safety pipeline runs. They are
 * kept as adapters but disconnected from defaults so they can be
 * re-enabled for A/B testing via createLegacyGuardrails().
 *
 * Each adapter is stateless, so instances can be created once at boot
 * and reused across requests.
 */
function createDefaultGuardrails() {
  return [
    new LanguageDriftGuardrail(),      // high — BUG-002: scripts no-latinos en mid-respuesta
    new SolutionLeakGuardrail(),       // high — leaks the answer
    new FalseConfirmationGuardrail(),  // high — confirms a wrong answer
    new CompleteSolutionGuardrail(),   // high — validates a wrong PART of the answer
    new StateRevealGuardrail(),        // high — exposes internal state
    new AdherenceGuardrail(),          // med  — NS-33: contradicción Rn + multi-pregunta
    new RepeatedQuestionGuardrail(),   // med  — BUG-010-C: pregunta socrática repetida literal
    new SettledElementQuestionGuardrail(), // med — BUG-LOOP: re-pregunta de elementos ya resueltos
  ];
}

/**
 * LEGACY profile: includes the three pedagogical adapters that
 * createDefaultGuardrails() now leaves out. Use this profile to compare
 * the new PedagogicalReviewerAgent against the old guardrail-based
 * approach. Activate with `GUARDRAIL_PROFILE=legacy` in env.
 */
function createLegacyGuardrails() {
  return [
    new LanguageDriftGuardrail(),
    new SolutionLeakGuardrail(),
    new FalseConfirmationGuardrail(),
    new PrematureConfirmationGuardrail(),
    new CompleteSolutionGuardrail(),
    new StateRevealGuardrail(),
    new AdherenceGuardrail(),
    new RepeatedQuestionGuardrail(),
    new SettledElementQuestionGuardrail(),
    new DidacticExplanationGuardrail(),
    new DatasetStyleGuardrail(),
  ];
}

/**
 * Profile resolver — keeps container.js free of env-coupling logic.
 * Falls back to default profile on any unrecognised value.
 */
function createGuardrailsForProfile(profile) {
  if (typeof profile === "string" && profile.toLowerCase() === "legacy") {
    return createLegacyGuardrails();
  }
  return createDefaultGuardrails();
}

module.exports = {
  createDefaultGuardrails: createDefaultGuardrails,
  createLegacyGuardrails: createLegacyGuardrails,
  createGuardrailsForProfile: createGuardrailsForProfile,
  SolutionLeakGuardrail: SolutionLeakGuardrail,
  FalseConfirmationGuardrail: FalseConfirmationGuardrail,
  PrematureConfirmationGuardrail: PrematureConfirmationGuardrail,
  CompleteSolutionGuardrail: CompleteSolutionGuardrail,
  StateRevealGuardrail: StateRevealGuardrail,
  AdherenceGuardrail: AdherenceGuardrail,
  DidacticExplanationGuardrail: DidacticExplanationGuardrail,
  DatasetStyleGuardrail: DatasetStyleGuardrail,
  LanguageDriftGuardrail: LanguageDriftGuardrail,
  RepeatedQuestionGuardrail: RepeatedQuestionGuardrail,
};
