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

    // BUG-B (2026-05-11): elements the student has already named are
    // "fair game" per the system-prompt EXCEPTION clause — the tutor may
    // refer to them by id. Mentioning them next to a KG concept word
    // (e.g. "R1 ... la corriente ...") is NOT a state reveal, it's a
    // legitimate Socratic exchange. Hardcoded state patterns
    // ("cortocircuitada", "circuito abierto") still fire even in that case.
    const studentMentioned = _collectStudentMentions((ctx && ctx.messages) || []);

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
      //
      // ALSO skip if ALL the elements named in this sentence have already
      // been mentioned by the student in earlier turns. The system prompt's
      // EXCEPTION clause lets the tutor refer to those by id; pairing the
      // id with a KG concept word is part of a normal Socratic exchange,
      // not a leak. Without this the guardrail thrashed against legitimate
      // replies like "Has identificado correctamente a R1 como una de las
      // resistencias relevantes." after the student wrote "a r1".
      if (!isQuestion) {
        const allFairGame = namedElements.every(function (el) {
          return studentMentioned.has(String(el).toUpperCase());
        });
        if (!allFairGame) {
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
    const { redactStateRevealSentence, STATE_REVEAL_PLACEHOLDER_REGEX } =
      require("../../domain/services/rag/guardrails");
    // BUG-009-B: contar disparos previos del placeholder en mensajes
    // assistant anteriores para rotar el wording (3 variantes y luego
    // supresión).
    var priorHits = 0;
    var msgs = (ctx && ctx.messages) || [];
    for (var i = 0; i < msgs.length; i++) {
      var m = msgs[i];
      if (m && m.role === "assistant" && typeof m.content === "string") {
        if (STATE_REVEAL_PLACEHOLDER_REGEX.test(m.content)) priorHits++;
      }
    }
    const r = redactStateRevealSentence(response, evaluableElements, pattern, lang, priorHits);
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

// Collect every R\d+/V\d+/I\d+ token the student mentioned across the
// conversation. Used to short-circuit KG-pattern hits when the element is
// already "fair game" per the system prompt's EXCEPTION clause.
function _collectStudentMentions(messages) {
  const set = new Set();
  if (!Array.isArray(messages)) return set;
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (!m || m.role !== "user" || typeof m.content !== "string") continue;
    const hits = m.content.match(/\b[RVI]\d+\b/gi);
    if (!hits) continue;
    for (let h = 0; h < hits.length; h++) {
      set.add(hits[h].toUpperCase());
    }
  }
  return set;
}

module.exports = StateRevealGuardrail;
