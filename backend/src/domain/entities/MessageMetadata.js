"use strict";

/*------------------------------------------------------------------------------
            _________________________________________________________
            |                    MESSAGEMETADATA                    |
            |  Value object for assistant-message metadata. Splits   |
            |  into core fields (dedicated DB columns on `messages`)  |
            |  and extra fields (JSONB messages.extra_metadata).     |
        ____|________________                                       |
   Obj -> | constructor() | -> MessageMetadata       (writes attrs)  |
          -----------------                                         |
            |                                                       |
            |   classification: Txt | null   decision: Txt | null   |
            |   isCorrectAnswer: T/F | null   sourcesCount: Z        |
            |   studentResponseMs: Z | null   concepts: [Txt]        |
            |   guardrails: Obj               timing: Obj            |
            |   detectedACs: [Txt]            guardrailPath: Txt|null|
            |   guardrailLlmRetries: Z                              |
            |   guardrailSurgicalFixes: [Txt]                       |
            |   llmResponseOriginal: Txt | null                     |
            |   guardrailSurgicalFixDetails: [Obj]                  |
            |   fallbackUsed: T/F             deterministicFinish:T/F|
            |                                                       |
            |_______________________________________________________|
------------------------------------------------------------------------------*/
class MessageMetadata {
  /*
   Obj -> ____|________________
         | constructor() | -> MessageMetadata    (writes all attributes above)
          -----------------
      Builds the metadata from a plain props object. Core fields map to
      dedicated `messages` columns; extra fields (firstTokenMs, detectedACs,
      the post-NS guardrails, guardrailPath, surgical-fix tracking,
      fallbackUsed, deterministicFinish) live in the JSONB extra_metadata
      column added by migration 008. `elementNaming` is retired (NS-32) but
      kept for schema compatibility.
  */
  constructor(props) {
    this.classification = props.classification || null;
    this.decision = props.decision || null;
    this.isCorrectAnswer = props.isCorrectAnswer ?? null;
    this.sourcesCount = props.sourcesCount || 0;
    this.studentResponseMs = props.studentResponseMs || null;
    this.concepts = Array.isArray(props.concepts) ? props.concepts : [];

    this.guardrails = {
      solutionLeak: props.guardrails?.solutionLeak || false,
      falseConfirmation: props.guardrails?.falseConfirmation || false,
      prematureConfirmation: props.guardrails?.prematureConfirmation || false,
      stateReveal: props.guardrails?.stateReveal || false,
      languageDrift: props.guardrails?.languageDrift || false,
      completeSolution: props.guardrails?.completeSolution || false,
      adherence: props.guardrails?.adherence || false,
      repeatedQuestion: props.guardrails?.repeatedQuestion || false,
      didacticExplanation: props.guardrails?.didacticExplanation || false,
      datasetStyle: props.guardrails?.datasetStyle || false,
      elementNaming: props.guardrails?.elementNaming || false,
    };

    this.timing = {
      pipelineMs: props.timing?.pipelineMs || null,
      ollamaMs: props.timing?.ollamaMs || null,
      totalMs: props.timing?.totalMs || null,
      firstTokenMs: props.timing?.firstTokenMs || null,
    };

    this.detectedACs = Array.isArray(props.detectedACs) ? props.detectedACs : [];
    this.guardrailPath = props.guardrailPath || null;
    this.guardrailLlmRetries = props.guardrailLlmRetries || 0;
    this.guardrailSurgicalFixes = Array.isArray(props.guardrailSurgicalFixes)
      ? props.guardrailSurgicalFixes
      : [];
    this.llmResponseOriginal = props.llmResponseOriginal || null;
    this.guardrailSurgicalFixDetails = Array.isArray(props.guardrailSurgicalFixDetails)
      ? props.guardrailSurgicalFixDetails
      : [];
    this.fallbackUsed = props.fallbackUsed || false;
    this.deterministicFinish = props.deterministicFinish || false;
  }
}

module.exports = MessageMetadata;
