"use strict";

const IGuardrail = require("../../domain/ports/services/IGuardrail");
const { splitSentencesKeepEnd } = require("../../domain/services/text/sentenceSplitter");
const { getAllPatterns, stateRevealPatterns: stateRevealDict, getStateRevealInstruction } = require("../../domain/services/languageManager");

const hardcodedStatePatterns = getAllPatterns(stateRevealDict);

/**
 * Detects when the tutor reveals the internal STATE of a specific element
 * (e.g. "R5 está cortocircuitada", "circula corriente por R2").
 *
 * Previous false positive: Socratic QUESTIONS like "¿Por qué R1 contribuye a
 * la diferencia de potencial?" triggered because "diferencia de potencial"
 * (from the KG) appeared near "R1" in the same sentence. Fix: if the sentence
 * containing the element IS a question (ends with "?"), do NOT treat KG
 * concept patterns as state-reveals (questions about concepts are pedagogical,
 * not leaks). Hardcoded patterns (e.g. "está cortocircuitada") DO still fire
 * in questions, because affirmatively stating a state inside a question is
 * still a reveal ("¿Sabías que R5 está cortocircuitada?" = leak).
 */
class StateRevealGuardrail extends IGuardrail {
  get id() { return "state_reveal"; }
  get severity() { return "high"; }

  check(response, ctx) {
    if (typeof response !== "string") return { violated: false };
    const ctxElements = (ctx && ctx.evaluableElements) || [];
    const kgPatterns = (ctx && ctx.kgConceptPatterns) || [];

    // Fallback: if the exercise's elementosEvaluables is empty or missing
    // some elements, also check any R\d+ tokens that appear in the response.
    // Revealing the state of an element is harmful regardless of whether the
    // domain registered it as "evaluable".
    const regexElements = (response.match(/R\d+/gi) || []).map(function (s) { return s.toUpperCase(); });
    const seen = {};
    const evaluableElements = [];
    for (let i = 0; i < ctxElements.length; i++) {
      const e = String(ctxElements[i]).toUpperCase();
      if (!seen[e]) { seen[e] = true; evaluableElements.push(ctxElements[i]); }
    }
    for (let i = 0; i < regexElements.length; i++) {
      if (!seen[regexElements[i]]) { seen[regexElements[i]] = true; evaluableElements.push(regexElements[i]); }
    }
    if (evaluableElements.length === 0) return { violated: false };

    const sentences = splitSentencesKeepEnd(response);
    for (let s = 0; s < sentences.length; s++) {
      const sentence = sentences[s];
      const lower = sentence.toLowerCase();
      const isQuestion = sentence.includes("?");

      // Which elements are named in this sentence?
      const namedElements = [];
      for (let e = 0; e < evaluableElements.length; e++) {
        const elem = evaluableElements[e];
        const elemLower = elem.toLowerCase();
        // Word-boundary-aware check (same logic as elementExtractor)
        const re = new RegExp(
          "(^|[^a-z0-9_])" + _escape(elemLower) + "([^a-z0-9_]|$)",
          "i"
        );
        if (re.test(sentence)) namedElements.push(elem);
      }
      if (namedElements.length === 0) continue;

      // Hardcoded state patterns fire even in questions.
      for (let p = 0; p < hardcodedStatePatterns.length; p++) {
        if (lower.includes(hardcodedStatePatterns[p])) {
          return {
            violated: true,
            evidence: "element '" + namedElements[0] + "' + state pattern '" + hardcodedStatePatterns[p] + "'",
            metadata: { element: namedElements[0], pattern: hardcodedStatePatterns[p], fromKG: false },
          };
        }
      }

      // KG concept patterns ONLY fire in affirmations, not questions.
      // Rationale: "¿Por qué R1 contribuye a la diferencia de potencial?" is
      // a pedagogical question about a concept, not a state reveal.
      if (!isQuestion) {
        for (let p = 0; p < kgPatterns.length; p++) {
          if (lower.includes(kgPatterns[p])) {
            return {
              violated: true,
              evidence: "element '" + namedElements[0] + "' + KG concept '" + kgPatterns[p] + "'",
              metadata: { element: namedElements[0], pattern: kgPatterns[p], fromKG: true },
            };
          }
        }
      }
    }
    return { violated: false };
  }

  surgicalFix(response, ctx) {
    if (typeof response !== "string") return null;
    const evaluableElements = (ctx && ctx.evaluableElements) || [];
    const lang = (ctx && ctx.lang) || "es";
    // We don't know the pattern without re-running check; cheap to do.
    const res = this.check(response, ctx);
    if (!res.violated) return { applied: false, text: response };
    const pattern = res.metadata && res.metadata.pattern;
    if (!pattern) return { applied: false, text: response };
    const { redactStateRevealSentence } = require("../../domain/services/rag/guardrails");
    const r = redactStateRevealSentence(response, evaluableElements, pattern, lang);
    if (!r || !r.redacted) return { applied: false, text: response };
    return { applied: true, text: r.text, before: response, after: r.text };
  }

  buildRetryHint(lang) {
    return getStateRevealInstruction(lang || "es");
  }
}

function _escape(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

module.exports = StateRevealGuardrail;
