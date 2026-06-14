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

// BUG-SL (2026-06-10): this was the last guardrail in the set still comparing
// raw-lowercased text against ACCENTED dictionaries/regexes, so an accent-less
// LLM reveal ("La solucion es R1", "Asi es, esos elementos contribuyen") — and
// the ENTIRE Valencian reveal set — slipped through. Same recurring class as
// G1/S1. We fold accents on both sides: precompute accent-stripped copies of
// the reveal phrases and of the regex patterns (stripping accents from the
// pattern .source), and match against accent-folded text.
const revealPhrasesF = revealPhrases.map(function (p) { return stripAccents(p); });
function _foldPattern(re) {
  try { return new RegExp(stripAccents(re.source), re.flags); } catch (_) { return re; }
}
const SEMANTIC_AFFIRM_PATTERNS_F = SEMANTIC_AFFIRM_PATTERNS.map(_foldPattern);
const PLACEHOLDER_PATTERNS_F = PLACEHOLDER_PATTERNS.map(_foldPattern);

function _sentenceHasPlaceholder(s) {
  const folded = stripAccents(s);
  for (let p = 0; p < PLACEHOLDER_PATTERNS_F.length; p++) {
    if (PLACEHOLDER_PATTERNS_F[p].test(folded)) return true;
  }
  return false;
}

function _sentenceHasAffirm(s) {
  const folded = stripAccents(s);
  for (let q = 0; q < SEMANTIC_AFFIRM_PATTERNS_F.length; q++) {
    const m = SEMANTIC_AFFIRM_PATTERNS_F[q].exec(folded);
    if (!m) continue;
    // Review C1 (2026-06-11): a NEGATED affirmation is a refutation, not a
    // confirmation — "No es correcto." was matching /correcto/ and flagging a
    // legitimate correction as a semantic leak (then forcing a useless retry).
    const before = folded.slice(Math.max(0, m.index - 16), m.index);
    if (/\b(no|tampoco|ni)\b[\s,]*(es|era|son|eran|esta|estas|fue|seria)?\s*$/i.test(before)) continue;
    return true;
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

    // Fair-game gate, computed FIRST because it scopes rules (b), (b2) AND (c)
    // — review C2 (2026-06-11): rule (c) used to ignore it, so a legitimate
    // post-completion confirmation ("Correcto, esas resistencias son las que
    // influyen.") still fired semantic_leak. See the BUG-ALGUNOS comments at
    // rule (b) for the full rationale of each disjunct.
    const verdictStr = ctx && ctx.turnVerdict &&
      (typeof ctx.turnVerdict === "string" ? ctx.turnVerdict : ctx.turnVerdict.verdict);
    const cum = ctx && ctx.cumulativeAnswer;
    const studentNamedFullAnswer = verdictStr === "correct" || !!(cum && cum.complete);

    // (c) Post-redaction semantic leak — fires even when no R\d+ remains
    //     because the redaction already swapped them out.
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

    // (a) explicit reveal phrase — matched accent-folded (BUG-SL).
    for (let i = 0; i < revealPhrasesF.length; i++) {
      if (lowerFolded.includes(revealPhrasesF[i])) {
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
    //
    // BUG-ALGUNOS (2026-06-11): EXCEPTION — if the student THIS TURN already
    // produced the exact correct set (turnVerdict.verdict === "correct": every
    // correct element proposed, no errors, nothing missing), the tutor echoing
    // those same elements reveals NOTHING — the student supplied them. Treating
    // it as a leak triggered the surgical rewrite that turned the honest
    // acknowledgment "R1, R2 y R4 están en el camino" into the FALSE and
    // demoralising "Algunos de los elementos que has propuesto están en el
    // camino" ("algunos" = some, when it was ALL). That misrewrite made the
    // student think they were only partly right and the conversation looped.
    // The fair-game gate is scoped to verdict==="correct" (an EXACT match, set
    // by AcDetector only when proposed === correctAnswer), so a wrong/superset
    // answer like "R1 R2 R3 R4" still has its correct subset protected. The
    // "don't confirm without reasoning" policy is a SEPARATE concern handled by
    // the false/premature-confirmation guardrails, not by faking a partial leak.
    // (BUG-ALGUNOS-2 note: studentNamedFullAnswer is computed at the top of
    // check() — per-turn verdict OR cumulative complete — because it also
    // scopes rule (c). See comment there.)
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

      // (b2) QUESTION-LEAK (2026-06-11). Rule (b) skips questions, but a
      // QUESTION that names the COMPLETE correct set together with an
      // influence verb hands the student the answer wrapped in "¿has
      // considerado…?" — production: "¿has considerado cómo las resistencias
      // conectadas a N2, como R1, R2 y R4, podrían afectar la tensión…?" when
      // the student had named NOTHING yet. That was the "me da la respuesta
      // implícitamente" complaint. Guards against false positives:
      //   - only when the student has NOT named the full set (outer gate);
      //   - the question must name ALL correct elements; extra Rn only exempt
      //     it when they cover the WHOLE remaining evaluable set (review C7,
      //     2026-06-11: "¿cómo R1, R2 y R4, a diferencia de R3, afectan…?"
      //     still hands over the answer — one token extra is not a neutral
      //     enumeration; "¿cuáles de R1…R5 influyen?" lists everything and
      //     reveals nothing);
      //   - an influence/affect/FLOW verb must be present (review C4: "¿te das
      //     cuenta de que la corriente pasa por R1, R2 y R4?" is the same leak
      //     with flow phrasing — StateReveal exempts flow questions by design,
      //     so this rule is the net for the full-set variant).
      // BUG-SL-EXACT (2026-06-14): broadened with the neutral "what about X"
      // verbs ("ocurre", "sucede", "identific…", "considera", "piensa en",
      // "recuerda", "fíjate", "ten en cuenta"). Production CONV[109] leaked
      // "¿Y qué ocurre con … R1, R2 y R4 en esa ruta?" — no influence verb, so
      // it escaped even though it named the full set before the student did.
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
          // Exempt only a full enumeration: the extras must cover EVERY
          // non-correct evaluable element. Without evaluableElements in ctx we
          // can't judge coverage, so any extra exempts (legacy behaviour).
          const coversAll = nonCorrectEval.length === 0 ||
            nonCorrectEval.every((e) => found.indexOf(e) >= 0);
          if (coversAll) continue;
          // Extras present but not a full enumeration (e.g. a comparison
          // "¿cómo R1,R2,R4 frente a R3…?"): still requires an influence verb,
          // otherwise it could be a neutral mention of a wrong element.
          if (!INFLUENCE_RE.test(stripAccents(sent.toLowerCase()))) continue;
          return {
            violated: true,
            evidence: "question names the full correct set + influence verb: '" + sent.trim().slice(0, 90) + "'",
          };
        }
        // BUG-SL-EXACT (2026-06-14): the question names EXACTLY the correct set
        // and no other element. Listing precisely R1,R2,R4 together hands the
        // student the answer regardless of the verb ("¿has identificado ya R1,
        // R2 y R4?", "¿qué ocurre con R1, R2 y R4…?"). No influence verb needed.
        return {
          violated: true,
          evidence: "question names exactly the correct set: '" + sent.trim().slice(0, 90) + "'",
        };
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
      fixOpeningAntecedent,
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

    // After all the trimming the bubble may start with a dangling
    // "esos elementos sí contribuyen…" — promote that to a form with an
    // explicit antecedent ("Algunos de los elementos que has propuesto…")
    // so the first sentence of the bubble parses as a complete utterance.
    const beforeAntecedent = text;
    text = fixOpeningAntecedent(text, lang);
    if (text !== beforeAntecedent) applied = true;

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
    // Reuse the accent-folded helpers (BUG-SL) so the stripper catches the same
    // accent-less leaks that looksLikeSemanticAffirmation now detects.
    if (_sentenceHasPlaceholder(s) && _sentenceHasAffirm(s)) continue;
    kept.push(s);
  }
  return kept.join("").trim();
}

module.exports = SolutionLeakGuardrail;
module.exports.looksLikeSemanticAffirmation = looksLikeSemanticAffirmation;
module.exports.stripSemanticAffirmation = stripSemanticAffirmation;
