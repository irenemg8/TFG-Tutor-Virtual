"use strict";

const IGuardrail = require("../../domain/ports/services/IGuardrail");
const { extractResistances } = require("../../domain/services/text/elementExtractor");
const { containsAll } = require("../../domain/services/text/setComparison");
const { splitSentencesKeepEnd } = require("../../domain/services/text/sentenceSplitter");
const { stripAccents } = require("../../domain/services/text/accentNormalizer");
const {
  getAllPatterns,
  revealPhrases: revealDict,
  getStrongerInstruction,
  SOLUTION_LEAK_AFFIRM_PATTERNS: SEMANTIC_AFFIRM_PATTERNS,
  SOLUTION_LEAK_PLACEHOLDER_PATTERNS: PLACEHOLDER_PATTERNS,
} = require("../../domain/services/languageManager");

const revealPhrases = getAllPatterns(revealDict);

// Accent-folded copies of the reveal phrases and regex patterns so accent-less
// LLM reveals ("La solucion es R1") and the Valencian set still match.
const revealPhrasesF = revealPhrases.map(function (p) { return stripAccents(p); });

/*
   RegExp -> ____|______________
            | _foldPattern() | -> RegExp
             ----------------
      Returns the regex with accents stripped from its source (same flags),
      falling back to the original on error.
*/
function _foldPattern(re) {
  try { return new RegExp(stripAccents(re.source), re.flags); } catch (_) { return re; }
}
const SEMANTIC_AFFIRM_PATTERNS_F = SEMANTIC_AFFIRM_PATTERNS.map(_foldPattern);
const PLACEHOLDER_PATTERNS_F = PLACEHOLDER_PATTERNS.map(_foldPattern);

/*
   Txt -> ____|_______________________
         | _sentenceHasPlaceholder() | -> T/F
          -------------------------
      True when the sentence matches a placeholder noun-phrase pattern.
*/
function _sentenceHasPlaceholder(s) {
  const folded = stripAccents(s);
  for (let p = 0; p < PLACEHOLDER_PATTERNS_F.length; p++) {
    if (PLACEHOLDER_PATTERNS_F[p].test(folded)) return true;
  }
  return false;
}

/*
   Txt -> ____|___________________
         | _sentenceHasAffirm() | -> T/F
          --------------------
      True when the sentence carries an affirmative "you got it right"
      pattern; a preceding negation ("No es correcto") is skipped.
*/
function _sentenceHasAffirm(s) {
  const folded = stripAccents(s);
  for (let q = 0; q < SEMANTIC_AFFIRM_PATTERNS_F.length; q++) {
    const m = SEMANTIC_AFFIRM_PATTERNS_F[q].exec(folded);
    if (!m) continue;
    const before = folded.slice(Math.max(0, m.index - 16), m.index);
    if (/\b(no|tampoco|ni)\b[\s,]*(es|era|son|eran|esta|estas|fue|seria)?\s*$/i.test(before)) continue;
    return true;
  }
  return false;
}

/*
   Txt -> ____|____________________________
         | looksLikeSemanticAffirmation() | -> T/F
          ------------------------------
      True when a declarative sentence pairs a placeholder with an affirm, or
      a pure affirm sentence is immediately followed by a placeholder one —
      both forms being implicit post-redaction confirmation.
*/
function looksLikeSemanticAffirmation(text) {
  if (typeof text !== "string" || text.length === 0) return false;
  const sentences = splitSentencesKeepEnd(text);
  for (let i = 0; i < sentences.length; i++) {
    const s = sentences[i];
    if (s.includes("?")) continue;
    if (_sentenceHasPlaceholder(s) && _sentenceHasAffirm(s)) return true;
  }
  for (let i = 0; i < sentences.length - 1; i++) {
    const s1 = sentences[i];
    const s2 = sentences[i + 1];
    if (s1.includes("?") || s2.includes("?")) continue;
    if (!_sentenceHasAffirm(s1)) continue;
    if (_sentenceHasPlaceholder(s2)) return true;
  }
  return false;
}

/*------------------------------------------------------------------------------
            _________________________________________________________
            |                  SOLUTIONLEAKGUARDRAIL              |
            |  Guardrail adapter (IGuardrail). Catches the tutor     |
            |  revealing the answer: an explicit reveal phrase, the  |
            |  full correct set listed/asked together (order-        |
            |  independent), or a post-redaction placeholder +       |
            |  affirmative connector. Scoped by a fair-game gate so  |
            |  echoing what the student already named is not a leak. |
        ____|_____________________                                   |
        | check() | -> Obj  (reads correctAnswer, turnVerdict, cum…) |
        -----------                                                  |
        ____|_______________________                                 |
        | surgicalFix() | -> Obj | null          (reads response)    |
        -----------------                                            |
        ____|___________________                                     |
        | buildRetryHint() | -> Txt                                  |
        --------------------                                         |
            |                                                       |
            |_______________________________________________________|
------------------------------------------------------------------------------*/
class SolutionLeakGuardrail extends IGuardrail {
  get id() { return "solution_leak"; }
  get severity() { return "high"; }

  /*
   Txt, Obj -> ____|_________
              | check() | -> Obj
               -----------
      True (violated) on rules (a) explicit reveal phrase, (b)/(b2) full set
      in a sentence/question, or (c) semantic placeholder leak — all gated by
      whether the student already named the full answer.
  */
  check(response, ctx) {
    const correctAnswer = (ctx && ctx.correctAnswer) || [];
    if (typeof response !== "string" || correctAnswer.length === 0) {
      return { violated: false };
    }

    // Fair-game gate: scopes rules (b), (b2) and (c) — echoing what the
    // student already named in full is not a leak.
    const verdictStr = ctx && ctx.turnVerdict &&
      (typeof ctx.turnVerdict === "string" ? ctx.turnVerdict : ctx.turnVerdict.verdict);
    const cum = ctx && ctx.cumulativeAnswer;
    const studentNamedFullAnswer = verdictStr === "correct" || !!(cum && cum.complete);

    // (c) Post-redaction semantic leak.
    if (!studentNamedFullAnswer && looksLikeSemanticAffirmation(response)) {
      return {
        violated: true,
        evidence: "semantic_leak: placeholder + affirmative connector",
      };
    }

    const lowerFolded = stripAccents(response.toLowerCase());
    const mentioned = extractResistances(response);
    if (!containsAll(mentioned, correctAnswer)) {
      return { violated: false };
    }

    // (a) explicit reveal phrase, matched accent-folded.
    for (let i = 0; i < revealPhrasesF.length; i++) {
      if (lowerFolded.includes(revealPhrasesF[i])) {
        return {
          violated: true,
          evidence: "reveal_phrase: '" + revealPhrases[i] + "'",
        };
      }
    }

    // (b) all correct elements listed together in one affirmative sentence,
    // order-independent. Gated so echoing a fully-correct student answer is
    // not flagged as a leak.
    if (!studentNamedFullAnswer && correctAnswer.length >= 2) {
      const sentences = splitSentencesKeepEnd(response);
      for (let i = 0; i < sentences.length; i++) {
        const sent = sentences[i];
        if (sent.includes("?")) continue;
        const found = (sent.match(/R\d+/gi) || []).map((x) => x.toUpperCase());
        let all = true;
        for (let k = 0; k < correctAnswer.length; k++) {
          if (found.indexOf(String(correctAnswer[k]).toUpperCase()) < 0) {
            all = false;
            break;
          }
        }
        if (all) {
          return {
            violated: true,
            evidence: "affirmative sentence lists all correct elements (any order): '" + sent.trim() + "'",
          };
        }
      }

      // (b2) question-leak: a question that names the COMPLETE correct set.
      // Exempt only a full enumeration of every evaluable element; a partial
      // enumeration with extras still leaks if an influence verb is present.
      const INFLUENCE_RE = /\b(influy|influir|afect|contribu|relevant|important|depend|pasa|circula|fluye|passa|flueix|flows?|passes?|ocurre|sucede|identific|considera|piensa|recuerda|fijate|ten en cuenta|tienes en cuenta|que hay de|que pasa con)/;
      const correctSetB2 = new Set(correctAnswer.map((c) => String(c).toUpperCase()));
      const evalSetB2 = ((ctx && ctx.evaluableElements) || []).map((e) => String(e).toUpperCase());
      const nonCorrectEval = evalSetB2.filter((e) => !correctSetB2.has(e));
      for (let i = 0; i < sentences.length; i++) {
        const sent = sentences[i];
        if (!sent.includes("?") && !sent.includes("¿")) continue;
        const found = (sent.match(/R\d+/gi) || []).map((x) => x.toUpperCase());
        if (found.length === 0) continue;
        let allCorrectIn = true;
        for (const c of correctSetB2) {
          if (found.indexOf(c) < 0) { allCorrectIn = false; break; }
        }
        if (!allCorrectIn) continue;
        const extras = found.filter((f) => !correctSetB2.has(f));
        if (extras.length > 0) {
          const coversAll = nonCorrectEval.length === 0 ||
            nonCorrectEval.every((e) => found.indexOf(e) >= 0);
          if (coversAll) continue;
          if (!INFLUENCE_RE.test(stripAccents(sent.toLowerCase()))) continue;
          return {
            violated: true,
            evidence: "question names the full correct set + influence verb: '" + sent.trim().slice(0, 90) + "'",
          };
        }
        // Question names EXACTLY the correct set — leaks regardless of verb.
        return {
          violated: true,
          evidence: "question names exactly the correct set: '" + sent.trim().slice(0, 90) + "'",
        };
      }
    }
    return { violated: false };
  }

  /*
   Txt, Obj -> ____|_______________
              | surgicalFix() | -> Obj | null
               -----------------
      Redacts the element list, strips semantic affirmations and affirmative
      openers, fixes a dangling antecedent, and ensures a closing question.
      Returns null when nothing survives so the pipeline can retry.
  */
  surgicalFix(response, ctx) {
    if (typeof response !== "string") return null;
    const correctAnswer = (ctx && ctx.correctAnswer) || [];
    const lang = (ctx && ctx.lang) || "es";
    const {
      redactElementMentions,
      removeOpeningConfirmation,
      fixOpeningAntecedent,
      ensureResponseHasQuestion,
    } = require("../../domain/services/rag/guardrails");

    const r = redactElementMentions(response, correctAnswer, lang);
    let text = r && r.redacted ? r.text : response;
    let applied = !!(r && r.redacted);

    if (looksLikeSemanticAffirmation(text)) {
      text = stripSemanticAffirmation(text);
      applied = true;
    }

    const beforeOpener = text;
    text = removeOpeningConfirmation(text, lang);
    if (text !== beforeOpener) applied = true;

    const beforeAntecedent = text;
    text = fixOpeningAntecedent(text, lang);
    if (text !== beforeAntecedent) applied = true;

    text = ensureResponseHasQuestion(text, lang);

    if (!applied) return { applied: false, text: response };
    if (!text || text.trim().length === 0) return null;
    return { applied: true, text: text, before: response, after: text };
  }

  /*
   Txt -> ____|___________________
         | buildRetryHint() | -> Txt
          --------------------
      Returns the stronger no-reveal instruction for the given language.
  */
  buildRetryHint(lang) {
    return getStrongerInstruction(lang || "es");
  }
}

/*
   Txt -> ____|_________________________
         | stripSemanticAffirmation() | -> Txt
          --------------------------
      Drops every declarative sentence pairing a placeholder with an affirm,
      keeping questions; returns "" when nothing remains.
*/
function stripSemanticAffirmation(text) {
  const sentences = splitSentencesKeepEnd(text);
  const kept = [];
  for (let i = 0; i < sentences.length; i++) {
    const s = sentences[i];
    if (s.includes("?")) { kept.push(s); continue; }
    if (_sentenceHasPlaceholder(s) && _sentenceHasAffirm(s)) continue;
    kept.push(s);
  }
  return kept.join("").trim();
}

module.exports = SolutionLeakGuardrail;
module.exports.looksLikeSemanticAffirmation = looksLikeSemanticAffirmation;
module.exports.stripSemanticAffirmation = stripSemanticAffirmation;
