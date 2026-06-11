"use strict";

const IGuardrail = require("../../domain/ports/services/IGuardrail");
const { splitSentencesKeepEnd } = require("../../domain/services/text/sentenceSplitter");
const { stripAccents } = require("../../domain/services/text/accentNormalizer");
const { getAllPatterns, stateRevealPatterns: stateRevealDict, getStateRevealInstruction } = require("../../domain/services/languageManager");

const hardcodedStatePatterns = getAllPatterns(stateRevealDict);
// BUG-G1 (2026-06-10): the state dictionary is fully accented ("está
// cortocircuitada", "está abierto"), but check() only lowercased the sentence —
// so the very common accent-less LLM output ("esta cortocircuitada") slipped
// through and the state reveal leaked. We fold accents on BOTH sides, exactly
// like queryClassifier does for the student input. Precompute the stripped
// dictionary once; KG patterns arrive at runtime so they are stripped in check().
const hardcodedStatePatternsF = hardcodedStatePatterns.map(function (p) {
  return stripAccents(String(p).toLowerCase());
});

function _fold(p) { return stripAccents(String(p).toLowerCase()); }

// BUG-topo (2026-06-10): production showed the tutor leaking the answer via
// TOPOLOGY and CURRENT-PATH statements the state dictionary didn't cover
// ("R4 está conectada en paralelo con R2", "la corriente pasa por R2 y R4").
// Topology ASSERTIONS ("en paralelo con X") reveal a specific connection even
// when phrased as a question ("¿te das cuenta de que R4 está en paralelo con
// R2?"), so they fire like the hardcoded state patterns. FLOW reveals fire only
// in affirmations (a probing "¿pasa la corriente por R2?" is legitimate).
const TOPOLOGY_ASSERT_PATTERNS = [
  "en paralelo con", "en serie con",
  "conectada en paralelo", "conectado en paralelo",
  "conectada en serie", "conectado en serie",
  "en paral·lel amb", "en serie amb",
  "in parallel with", "in series with",
].map(_fold);
const FLOW_REVEAL_PATTERNS = [
  "pasa por", "circula por", "fluye por", "passa per", "circula per",
  "flows through", "passes through",
].map(_fold);
// A NEGATED flow ("la corriente no pasa por R3") is the student's correct
// exclusion, not an answer-path reveal — don't treat it as a leak.
// Review C3 (2026-06-11): the negation must be checked PER OCCURRENCE, not
// per sentence — "La corriente no pasa por R3, pero sí fluye por R2 y R4."
// contains a negated flow AND an affirmed one; the sentence-wide regex
// shielded the affirmed leak. _flowNegatedAt looks only at the short span
// before the specific flow verb (allowing 0-2 intervening words: "no llega ni
// pasa por").
const NEGATED_FLOW_RE = /\bno\s+(?:pasa|circula|fluye|llega|passa|flueix)\b/;
function _flowNegatedAt(folded, idx) {
  const before = folded.slice(Math.max(0, idx - 24), idx);
  return /\b(?:no|tampoco|ni)\b(?:\s+\w+){0,2}\s*$/.test(before);
}
function _hasAffirmedFlow(folded, patterns) {
  for (let p = 0; p < patterns.length; p++) {
    let from = 0;
    let idx;
    while ((idx = folded.indexOf(patterns[p], from)) >= 0) {
      if (!_flowNegatedAt(folded, idx)) return patterns[p];
      from = idx + patterns[p].length;
    }
  }
  return null;
}

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
      const folded = stripAccents(lower); // accent-insensitive pattern matching
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

      // Hardcoded state patterns fire even in questions ("¿sabías que R5 está
      // cortocircuitada?" is still a reveal). EXCEPTION (run-5 FP, 2026-06-11):
      // the dictionary also contains FLOW phrasings ("pasa corriente por") that
      // must follow the FLOW_REVEAL rules instead — a probing QUESTION
      // ("¿Pasa corriente por R3 hacia tierra?") is the tutor's legitimate
      // Socratic lead toward discovering the exclusion, not a reveal, and a
      // NEGATED flow is the correct exclusion being acknowledged. In production
      // this FP forced a useless retry and the identical question was sent
      // anyway (retry_failed_final_surgical). Matched accent-folded.
      for (let p = 0; p < hardcodedStatePatternsF.length; p++) {
        if (folded.includes(hardcodedStatePatternsF[p])) {
          const isFlowPattern = /(pasa|circula|fluye|passa|flueix|flows?|passes?)/.test(hardcodedStatePatternsF[p]);
          if (isFlowPattern) {
            if (isQuestion) continue;
            // A SELF-NEGATED flow pattern ("no pasa corriente por") IS the
            // correct-exclusion phrasing — same policy as NEGATED_FLOW: skip.
            if (/^(?:no|tampoco)\s/.test(hardcodedStatePatternsF[p])) continue;
            // Per-occurrence negation check (C3): only skip if EVERY occurrence
            // of this flow pattern in the sentence is negated.
            if (_hasAffirmedFlow(folded, [hardcodedStatePatternsF[p]]) === null) continue;
          }
          return {
            violated: true,
            evidence: "element '" + namedElements[0] + "' + state pattern '" + hardcodedStatePatterns[p] + "'",
            metadata: { element: namedElements[0], pattern: hardcodedStatePatterns[p], fromKG: false },
          };
        }
      }

      // Topology ASSERTIONS reveal a specific connection even inside a question.
      for (let p = 0; p < TOPOLOGY_ASSERT_PATTERNS.length; p++) {
        if (folded.includes(TOPOLOGY_ASSERT_PATTERNS[p])) {
          return {
            violated: true,
            evidence: "element '" + namedElements[0] + "' + topology reveal '" + TOPOLOGY_ASSERT_PATTERNS[p] + "'",
            metadata: { element: namedElements[0], pattern: TOPOLOGY_ASSERT_PATTERNS[p], fromKG: false },
          };
        }
      }

      // FLOW reveals ("la corriente pasa por R2 y R4") give away the answer path.
      // Affirmations only, and they fire even for fair-game elements (naming the
      // current path is a leak regardless of who mentioned the element first).
      if (!isQuestion) {
        // Per-occurrence negation (C3): a sentence mixing a negated flow and an
        // AFFIRMED one ("no pasa por R3, pero sí fluye por R2 y R4") must still
        // fire on the affirmed occurrence.
        const affirmed = _hasAffirmedFlow(folded, FLOW_REVEAL_PATTERNS);
        if (affirmed !== null) {
          return {
            violated: true,
            evidence: "element '" + namedElements[0] + "' + current-path reveal '" + affirmed + "'",
            metadata: { element: namedElements[0], pattern: affirmed, fromKG: false },
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
            if (folded.includes(stripAccents(String(kgPatterns[p]).toLowerCase()))) {
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
    // Review C8 (2026-06-11): tutorAgent prefixes the live user message with
    // the [TURN CONTEXT] banner block, which NAMES elements (verdict Missing,
    // cumulative progress…). Scanning it here credited those elements as
    // "student-mentioned", silently disabling the KG-pattern check for exactly
    // the elements that most need protection. Strip the injected block first.
    const studentText = m.content.replace(/\[TURN CONTEXT[\s\S]*?\[\/TURN CONTEXT\]/g, "");
    const hits = studentText.match(/\b[RVI]\d+\b/gi);
    if (!hits) continue;
    for (let h = 0; h < hits.length; h++) {
      set.add(hits[h].toUpperCase());
    }
  }
  return set;
}

module.exports = StateRevealGuardrail;
