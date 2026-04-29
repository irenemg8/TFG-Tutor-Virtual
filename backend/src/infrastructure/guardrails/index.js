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
const ElementNamingGuardrail = require("./ElementNamingGuardrail");
const DidacticExplanationGuardrail = require("./DidacticExplanationGuardrail");
const DatasetStyleGuardrail = require("./DatasetStyleGuardrail");

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
    new SolutionLeakGuardrail(),       // high — leaks the answer
    new FalseConfirmationGuardrail(),  // high — confirms a wrong answer
    new CompleteSolutionGuardrail(),   // high — validates a wrong PART of the answer
    new StateRevealGuardrail(),        // high — exposes internal state
    new ElementNamingGuardrail(),      // med  — directs attention to specific elements
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
    new SolutionLeakGuardrail(),
    new FalseConfirmationGuardrail(),
    new PrematureConfirmationGuardrail(),
    new CompleteSolutionGuardrail(),
    new StateRevealGuardrail(),
    new ElementNamingGuardrail(),
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
  ElementNamingGuardrail: ElementNamingGuardrail,
  DidacticExplanationGuardrail: DidacticExplanationGuardrail,
  DatasetStyleGuardrail: DatasetStyleGuardrail,
};
