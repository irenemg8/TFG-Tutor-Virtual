"use strict";

/*------------------------------------------------------------------------------
            _________________________________________________________
            |                    GUARDRAILS INDEX                  |
            |  Guardrail registry. Re-exports every IGuardrail       |
            |  adapter and the factory functions that assemble the   |
            |  output-guardrail list for the LLM tutor pipeline.     |
            |                                                       |
            |  Aggregates: SolutionLeak, FalseConfirmation,         |
            |  PrematureConfirmation, CompleteSolution, StateReveal,|
            |  Adherence, DidacticExplanation, DatasetStyle,        |
            |  LanguageDrift, RepeatedQuestion, SettledElement.     |
            |                                                       |
            |  | createDefaultGuardrails() | -> [IGuardrail]        |
            |  | createLegacyGuardrails()  | -> [IGuardrail]        |
            |  | createGuardrailsForProfile() | -> [IGuardrail]     |
            |                                                       |
            |_______________________________________________________|
------------------------------------------------------------------------------*/

const SolutionLeakGuardrail = require("./SolutionLeakGuardrail");
const FalseConfirmationGuardrail = require("./FalseConfirmationGuardrail");
const PrematureConfirmationGuardrail = require("./PrematureConfirmationGuardrail");
const CompleteSolutionGuardrail = require("./CompleteSolutionGuardrail");
const StateRevealGuardrail = require("./StateRevealGuardrail");
const AdherenceGuardrail = require("./AdherenceGuardrail");
const DidacticExplanationGuardrail = require("./DidacticExplanationGuardrail");
const DatasetStyleGuardrail = require("./DatasetStyleGuardrail");
const LanguageDriftGuardrail = require("./LanguageDriftGuardrail");
const RepeatedQuestionGuardrail = require("./RepeatedQuestionGuardrail");
const SettledElementQuestionGuardrail = require("./SettledElementQuestionGuardrail");

/*
        ____|___________________________
        | createDefaultGuardrails() | -> [IGuardrail]
        -----------------------------
      Builds the default list (hard safety checks only); the pedagogical-style
      adapters are kept but left out for the PedagogicalReviewerAgent to handle.
*/
function createDefaultGuardrails() {
  return [
    new LanguageDriftGuardrail(),
    new SolutionLeakGuardrail(),
    new FalseConfirmationGuardrail(),
    new CompleteSolutionGuardrail(),
    new StateRevealGuardrail(),
    new AdherenceGuardrail(),
    new RepeatedQuestionGuardrail(),
    new SettledElementQuestionGuardrail(),
  ];
}

/*
        ____|__________________________
        | createLegacyGuardrails() | -> [IGuardrail]
        ----------------------------
      Builds the legacy list, adding the three pedagogical adapters left out of
      the default, for A/B comparison (GUARDRAIL_PROFILE=legacy).
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

/*
   Txt -> ____|______________________________
         | createGuardrailsForProfile() | -> [IGuardrail]
          --------------------------------
      Resolves a profile name to its guardrail list, defaulting to the default
      profile on any unrecognised value.
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
