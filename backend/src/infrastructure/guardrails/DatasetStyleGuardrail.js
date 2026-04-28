"use strict";

const IGuardrail = require("../../domain/ports/services/IGuardrail");

/**
 * Enforces the dataset style: concise prose + one final question, no markdown
 * (bullets, bold, numbered lists, headings). The dataset that trained the
 * expected tutor style has no markdown, so we strip it.
 *
 * Surgical-only guardrail: the fix is deterministic markdown stripping.
 * No LLM retry needed — buildRetryHint returns empty.
 */
class DatasetStyleGuardrail extends IGuardrail {
  get id() { return "dataset_style"; }
  get severity() { return "low"; }

  check(response, ctx) {
    if (typeof response !== "string") return { violated: false };
    const { enforceDatasetStyle } = require("../../domain/services/rag/guardrails");
    const r = enforceDatasetStyle(response);
    if (!r || !r.changed) return { violated: false };
    return { violated: true, evidence: "contains markdown formatting", metadata: { cleanText: r.text } };
  }

  surgicalFix(response, ctx) {
    if (typeof response !== "string") return null;
    const { enforceDatasetStyle } = require("../../domain/services/rag/guardrails");
    const r = enforceDatasetStyle(response);
    if (!r || !r.changed) return { applied: false, text: response };
    return { applied: true, text: r.text, before: response, after: r.text };
  }

  buildRetryHint(lang) {
    return ""; // surgical-only
  }
}

module.exports = DatasetStyleGuardrail;
