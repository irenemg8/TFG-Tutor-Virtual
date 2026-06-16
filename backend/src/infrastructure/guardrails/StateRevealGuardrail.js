"use strict";

const IGuardrail = require("../../domain/ports/services/IGuardrail");
const { splitSentencesKeepEnd } = require("../../domain/services/text/sentenceSplitter");
const { stripAccents } = require("../../domain/services/text/accentNormalizer");
const { getAllPatterns, stateRevealPatterns: stateRevealDict, getStateRevealInstruction } = require("../../domain/services/languageManager");

// State dictionary, accent-folded on this side (check() folds the sentence too)
// so accent-less LLM output ("esta cortocircuitada") still matches. KG patterns
// arrive at runtime and are folded inside check().
const hardcodedStatePatterns = getAllPatterns(stateRevealDict);
const hardcodedStatePatternsF = hardcodedStatePatterns.map(function (p) {
  return stripAccents(String(p).toLowerCase());
});

/*
   Txt -> ____|________
         | _fold() | -> Txt
          --------
      Lowercases and strips accents from a pattern string.
*/
function _fold(p) { return stripAccents(String(p).toLowerCase()); }

// Topology ASSERTIONS ("en paralelo con X") reveal a connection even inside a
// question, so they fire like hardcoded state patterns. FLOW reveals fire only
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
// exclusion, not a reveal. Negation is checked PER OCCURRENCE so a sentence
// mixing a negated and an affirmed flow still fires on the affirmed one.
const NEGATED_FLOW_RE = /\bno\s+(?:pasa|circula|fluye|llega|passa|flueix)\b/;

/*
   Txt, Z -> ____|________________
            | _flowNegatedAt() | -> T/F
             ------------------
      True when the short span (0-2 words) before the flow verb at idx is a
      negation ("no", "tampoco", "ni").
*/
function _flowNegatedAt(folded, idx) {
  const before = folded.slice(Math.max(0, idx - 24), idx);
  return /\b(?:no|tampoco|ni)\b(?:\s+\w+){0,2}\s*$/.test(before);
}

/*
   Txt, [Txt] -> ____|__________________
                | _hasAffirmedFlow() | -> Txt | null
                 --------------------
      Returns the first flow pattern that occurs un-negated in the text, or
      null when every occurrence is negated.
*/
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

/*------------------------------------------------------------------------------
            _________________________________________________________
            |                  STATEREVEALGUARDRAIL               |
            |  Guardrail adapter (IGuardrail). Catches the tutor     |
            |  revealing the internal STATE of an element ("R5 está  |
            |  cortocircuitada"), a TOPOLOGY connection, or the      |
            |  current PATH. KG-concept patterns fire only in        |
            |  affirmations (concept questions are pedagogical);     |
            |  already-named elements are fair game.                 |
        ____|_____________________                                   |
        | check() | -> Obj   (reads response, evaluableElements, KG) |
        -----------                                                  |
        ____|_______________________                                 |
        | surgicalFix() | -> Obj | null  (reads response, messages)  |
        -----------------                                            |
        ____|___________________                                     |
        | buildRetryHint() | -> Txt                                  |
        --------------------                                         |
            |                                                       |
            |_______________________________________________________|
------------------------------------------------------------------------------*/
class StateRevealGuardrail extends IGuardrail {
  get id() { return "state_reveal"; }
  get severity() { return "high"; }

  /*
   Txt, Obj -> ____|_________
              | check() | -> Obj
               -----------
      Scans each sentence for a named element plus a state/topology/flow/KG
      reveal; returns the offending element and pattern in metadata.
  */
  check(response, ctx) {
    if (typeof response !== "string") return { violated: false };
    const ctxElements = (ctx && ctx.evaluableElements) || [];
    const kgPatterns = (ctx && ctx.kgConceptPatterns) || [];

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

    const studentMentioned = _collectStudentMentions((ctx && ctx.messages) || []);

    const sentences = splitSentencesKeepEnd(response);
    for (let s = 0; s < sentences.length; s++) {
      const sentence = sentences[s];
      const lower = sentence.toLowerCase();
      const folded = stripAccents(lower);
      const isQuestion = sentence.includes("?");

      const namedElements = [];
      for (let e = 0; e < evaluableElements.length; e++) {
        const elem = evaluableElements[e];
        const elemLower = elem.toLowerCase();
        const re = new RegExp(
          "(^|[^a-z0-9_])" + _escape(elemLower) + "([^a-z0-9_]|$)",
          "i"
        );
        if (re.test(sentence)) namedElements.push(elem);
      }
      if (namedElements.length === 0) continue;

      for (let p = 0; p < hardcodedStatePatternsF.length; p++) {
        if (folded.includes(hardcodedStatePatternsF[p])) {
          const isFlowPattern = /(pasa|circula|fluye|passa|flueix|flows?|passes?)/.test(hardcodedStatePatternsF[p]);
          if (isFlowPattern) {
            if (isQuestion) continue;
            if (/^(?:no|tampoco)\s/.test(hardcodedStatePatternsF[p])) continue;
            if (_hasAffirmedFlow(folded, [hardcodedStatePatternsF[p]]) === null) continue;
          }
          return {
            violated: true,
            evidence: "element '" + namedElements[0] + "' + state pattern '" + hardcodedStatePatterns[p] + "'",
            metadata: { element: namedElements[0], pattern: hardcodedStatePatterns[p], fromKG: false },
          };
        }
      }

      for (let p = 0; p < TOPOLOGY_ASSERT_PATTERNS.length; p++) {
        if (folded.includes(TOPOLOGY_ASSERT_PATTERNS[p])) {
          return {
            violated: true,
            evidence: "element '" + namedElements[0] + "' + topology reveal '" + TOPOLOGY_ASSERT_PATTERNS[p] + "'",
            metadata: { element: namedElements[0], pattern: TOPOLOGY_ASSERT_PATTERNS[p], fromKG: false },
          };
        }
      }

      if (!isQuestion) {
        const affirmed = _hasAffirmedFlow(folded, FLOW_REVEAL_PATTERNS);
        if (affirmed !== null) {
          return {
            violated: true,
            evidence: "element '" + namedElements[0] + "' + current-path reveal '" + affirmed + "'",
            metadata: { element: namedElements[0], pattern: affirmed, fromKG: false },
          };
        }
      }

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

  /*
   Txt, Obj -> ____|_______________
              | surgicalFix() | -> Obj | null
               -----------------
      Re-runs check() for the matched pattern, then redacts the offending
      sentence, rotating the placeholder wording by prior assistant hits.
  */
  surgicalFix(response, ctx) {
    if (typeof response !== "string") return null;
    const evaluableElements = (ctx && ctx.evaluableElements) || [];
    const lang = (ctx && ctx.lang) || "es";
    const res = this.check(response, ctx);
    if (!res.violated) return { applied: false, text: response };
    const pattern = res.metadata && res.metadata.pattern;
    if (!pattern) return { applied: false, text: response };
    const { redactStateRevealSentence, STATE_REVEAL_PLACEHOLDER_REGEX } =
      require("../../domain/services/rag/guardrails");
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

  /*
   Txt -> ____|___________________
         | buildRetryHint() | -> Txt
          --------------------
      Returns the state-reveal instruction for the given language.
  */
  buildRetryHint(lang) {
    return getStateRevealInstruction(lang || "es");
  }
}

/*
   Txt -> ____|___________
         | _escape() | -> Txt
          -----------
      Escapes regex metacharacters in a string.
*/
function _escape(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/*
   [Obj] -> ____|_______________________
           | _collectStudentMentions() | -> Set<Txt>
            -------------------------
      Collects every R/V/I token the student mentioned across the
      conversation (the injected [TURN CONTEXT] block is stripped first) so
      already-named elements can be treated as fair game.
*/
function _collectStudentMentions(messages) {
  const set = new Set();
  if (!Array.isArray(messages)) return set;
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (!m || m.role !== "user" || typeof m.content !== "string") continue;
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
