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
 * Build the default guardrail list. Each adapter is stateless, so instances
 * can be created once at boot and reused across requests.
 */
function createDefaultGuardrails() {
  return [
    new SolutionLeakGuardrail(),           // high — leaks the answer
    new FalseConfirmationGuardrail(),      // high — confirms a wrong answer
    new PrematureConfirmationGuardrail(),  // high — closes without justification
    new CompleteSolutionGuardrail(),       // high — validates a wrong PART of the answer
    new StateRevealGuardrail(),            // high — exposes internal state
    new ElementNamingGuardrail(),          // med  — directs attention to specific elements
    new DidacticExplanationGuardrail(),    // med  — explains instead of scaffolding
    new DatasetStyleGuardrail(),           // low  — markdown cleanup
  ];
}

module.exports = {
  createDefaultGuardrails: createDefaultGuardrails,
  SolutionLeakGuardrail: SolutionLeakGuardrail,
  FalseConfirmationGuardrail: FalseConfirmationGuardrail,
  PrematureConfirmationGuardrail: PrematureConfirmationGuardrail,
  CompleteSolutionGuardrail: CompleteSolutionGuardrail,
  StateRevealGuardrail: StateRevealGuardrail,
  ElementNamingGuardrail: ElementNamingGuardrail,
  DidacticExplanationGuardrail: DidacticExplanationGuardrail,
  DatasetStyleGuardrail: DatasetStyleGuardrail,
};
