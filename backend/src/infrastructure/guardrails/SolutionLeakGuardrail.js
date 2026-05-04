"use strict";

const IGuardrail = require("../../domain/ports/services/IGuardrail");
const { extractResistances } = require("../../domain/services/text/elementExtractor");
const { containsAll } = require("../../domain/services/text/setComparison");
const { splitSentencesKeepEnd } = require("../../domain/services/text/sentenceSplitter");
const { getAllPatterns, revealPhrases: revealDict, getStrongerInstruction } = require("../../domain/services/languageManager");

const revealPhrases = getAllPatterns(revealDict);

// Affirmative connectors that, when paired with a redacted element list,
// still tell the student "you got it right" semantically — even after the
// element list itself was replaced with a placeholder. Detected per-language
// because qwen2.5 mixes them with valencià/EN.
//   "son los que / las que contribuyen"
//   "are the ones that contribute"
//   "són les que contribueixen"
// We don't try to enumerate every verb — pattern is generic: redacted noun
// phrase followed by "son los que / are the ones / són les que" + ANY verb.
const SEMANTIC_AFFIRM_PATTERNS = [
  // es
  /\b(?:son|eran)\s+(?:las|los)\s+que\b/i,
  /\b(?:contribuyen|importan|aportan|cuentan|afectan|determinan)\b[^.?!]*\b(?:son|eran)\s+(?:las|los)\b/i,
  /\b(?:exactamente|así\s+es|tienes\s+razón|en\s+efecto|correcto)\b/i,
  // val
  /\b(?:són|eren)\s+les\s+que\b/i,
  /\b(?:contribueixen|importen|aporten|afecten|determinen)\b[^.?!]*\b(?:són|eren)\s+les\b/i,
  /\b(?:exactament|així\s+és|tens\s+raó|correcte)\b/i,
  // en
  /\b(?:are|were)\s+the\s+ones\s+that\b/i,
  /\b(?:contribute|matter|count|affect|determine)\b[^.?!]*\b(?:are|were)\s+the\s+ones\b/i,
  /\b(?:exactly|that's\s+right|you'?re\s+right|correct)\b/i,
];

// Placeholders left by redactElementMentions — used to detect post-redaction
// semantic leaks (BUG-005): "esa(s) resistencia(s)/ese conjunto..." + an
// affirmative verb still constitutes a confirmation.
const PLACEHOLDER_PATTERNS = [
  /\bese\s+conjunto\s+de\s+elementos\b/i,
  /\beixe\s+conjunt\s+d['e]\s*elements\b/i,
  /\bthat\s+set\s+of\s+elements\b/i,
  /\besas?\s+resistencias?\b/i,
  /\beixa\s+resist[èe]ncia\b/i,
  /\beixes\s+resist[èe]ncies\b/i,
  /\bthose\s+resistors?\b/i,
  /\bthat\s+resistor\b/i,
  /\besos\s+elementos\b/i,
  /\beixos\s+elements\b/i,
  /\bthose\s+elements\b/i,
];

function _sentenceHasPlaceholder(s) {
  for (let p = 0; p < PLACEHOLDER_PATTERNS.length; p++) {
    if (PLACEHOLDER_PATTERNS[p].test(s)) return true;
  }
  return false;
}

function _sentenceHasAffirm(s) {
  for (let q = 0; q < SEMANTIC_AFFIRM_PATTERNS.length; q++) {
    if (SEMANTIC_AFFIRM_PATTERNS[q].test(s)) return true;
  }
  return false;
}

function looksLikeSemanticAffirmation(text) {
  if (typeof text !== "string" || text.length === 0) return false;
  const sentences = splitSentencesKeepEnd(text);
  // Caso 1: placeholder + affirm en la MISMA frase declarativa.
  for (let i = 0; i < sentences.length; i++) {
    const s = sentences[i];
    if (s.includes("?")) continue;
    if (_sentenceHasPlaceholder(s) && _sentenceHasAffirm(s)) return true;
  }
  // Caso 2: frase 1 = affirm puro ("Tienes razón.", "Exacto.", "Sí."),
  //         frase 2 = placeholder en declarativa. La proximidad declarativa
  //         entre afirmación y placeholder constituye confirmación implícita
  //         post-redacción.
  for (let i = 0; i < sentences.length - 1; i++) {
    const s1 = sentences[i];
    const s2 = sentences[i + 1];
    if (s1.includes("?") || s2.includes("?")) continue;
    if (!_sentenceHasAffirm(s1)) continue;
    if (_sentenceHasPlaceholder(s2)) return true;
  }
  return false;
}

/**
 * Detects when the tutor reveals the correct answer by either:
 *   (a) using an explicit reveal phrase ("la respuesta es...") when all
 *       correct elements are also mentioned,
 *   (b) listing ALL correct elements together in an affirmative sentence
 *       — order-INDEPENDENT (BUG-001 fix), or
 *   (c) post-redaction semantic leak where a placeholder noun phrase is
 *       still the subject of an affirmative verb that means "you got it
 *       right" (BUG-005).
 *
 * Surgical fix: delegate to redactElementMentions + strip affirmative
 * openers + ensure the response ends with a Socratic question.
 */
class SolutionLeakGuardrail extends IGuardrail {
  get id() { return "solution_leak"; }
  get severity() { return "high"; }

  check(response, ctx) {
    const correctAnswer = (ctx && ctx.correctAnswer) || [];
    if (typeof response !== "string" || correctAnswer.length === 0) {
      return { violated: false };
    }

    // (c) Post-redaction semantic leak — fires even when no R\d+ remains
    //     because the redaction already swapped them out.
    if (looksLikeSemanticAffirmation(response)) {
      return {
        violated: true,
        evidence: "semantic_leak: placeholder + affirmative connector",
      };
    }

    const lower = response.toLowerCase();
    const mentioned = extractResistances(response);
    if (!containsAll(mentioned, correctAnswer)) {
      return { violated: false };
    }

    // (a) explicit reveal phrase
    for (let i = 0; i < revealPhrases.length; i++) {
      if (lower.includes(revealPhrases[i])) {
        return {
          violated: true,
          evidence: "reveal_phrase: '" + revealPhrases[i] + "'",
        };
      }
    }

    // (b) all correct elements listed together in one AFFIRMATIVE sentence,
    //     order-INDEPENDENT. We split into sentences, drop questions, and
    //     check whether any non-question sentence mentions every correct
    //     element regardless of permutation.
    if (correctAnswer.length >= 2) {
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
    }
    return { violated: false };
  }

  /**
   * Surgical fix: redact element list AND strip affirmative openers/connectors
   * that semantically confirm the answer post-redaction.
   * Returns null when the response would be empty after the surgery so the
   * pipeline can escalate to an LLM retry.
   */
  surgicalFix(response, ctx) {
    if (typeof response !== "string") return null;
    const correctAnswer = (ctx && ctx.correctAnswer) || [];
    const lang = (ctx && ctx.lang) || "es";
    const {
      redactElementMentions,
      removeOpeningConfirmation,
      ensureResponseHasQuestion,
    } = require("../../domain/services/rag/guardrails");

    const r = redactElementMentions(response, correctAnswer, lang);
    let text = r && r.redacted ? r.text : response;
    let applied = !!(r && r.redacted);

    // Strip semantic affirmation patterns even if redactElementMentions
    // didn't touch the response — BUG-005 fires when the LLM emitted a
    // placeholder-form leak directly (qwen2.5 sometimes does this when the
    // previous turn's redacted response is in its history).
    if (looksLikeSemanticAffirmation(text)) {
      text = stripSemanticAffirmation(text);
      applied = true;
    }

    // Always also trim affirmative openers — "Sí, ", "Exacto, ", "Tienes
    // razón, " — because they propagate the implicit confirmation past the
    // redaction.
    const beforeOpener = text;
    text = removeOpeningConfirmation(text, lang);
    if (text !== beforeOpener) applied = true;

    text = ensureResponseHasQuestion(text, lang);

    if (!applied) return { applied: false, text: response };
    if (!text || text.trim().length === 0) return null;
    return { applied: true, text: text, before: response, after: text };
  }

  buildRetryHint(lang) {
    return getStrongerInstruction(lang || "es");
  }
}

// Strip every sentence that combines a placeholder + affirmative connector.
// Keeps interrogative sentences intact. If everything gets stripped the
// caller (surgicalFix) returns null so the pipeline can retry.
function stripSemanticAffirmation(text) {
  const sentences = splitSentencesKeepEnd(text);
  const kept = [];
  for (let i = 0; i < sentences.length; i++) {
    const s = sentences[i];
    if (s.includes("?")) { kept.push(s); continue; }
    let hasPlaceholder = false;
    for (let p = 0; p < PLACEHOLDER_PATTERNS.length; p++) {
      if (PLACEHOLDER_PATTERNS[p].test(s)) { hasPlaceholder = true; break; }
    }
    let hasAffirm = false;
    for (let q = 0; q < SEMANTIC_AFFIRM_PATTERNS.length; q++) {
      if (SEMANTIC_AFFIRM_PATTERNS[q].test(s)) { hasAffirm = true; break; }
    }
    if (hasPlaceholder && hasAffirm) continue;
    kept.push(s);
  }
  return kept.join("").trim();
}

module.exports = SolutionLeakGuardrail;
module.exports.looksLikeSemanticAffirmation = looksLikeSemanticAffirmation;
module.exports.stripSemanticAffirmation = stripSemanticAffirmation;
