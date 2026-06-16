"use strict";

const IGuardrail = require("../../domain/ports/services/IGuardrail");
const { detectLanguageHeuristic, getLanguageDriftRetryHint } = require("../../domain/services/languageManager");

/*------------------------------------------------------------------------------
            _________________________________________________________
            |                 LANGUAGEDRIFTGUARDRAIL              |
            |  Guardrail adapter (IGuardrail). Catches two language  |
            |  leaks the LLM produces: non-latin scripts mid-answer  |
            |  (CJK/Cyrillic/Arabic/Hebrew/Devanagari) and English   |
            |  sentences when es/val was expected.                   |
        ____|_____________________                                   |
        | check() | -> Obj            (reads response, ctx.lang)     |
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

// Any character outside ASCII printable + latin extended + common signs.
// Explicitly excludes CJK, Cyrillic, Arabic, Hebrew, Devanagari, Hangul.
const NON_LATIN_REGEX =
  /[Ѐ-ӿԀ-ԯ԰-֏֐-׿؀-ۿ܀-ݏऀ-ॿ฀-๿぀-ゟ゠-ヿ㄀-ㄯ㐀-䶿一-鿿가-힯＀-￯豈-﫿]/;

const NON_LATIN_REGEX_GLOBAL =
  /[Ѐ-ӿԀ-ԯ԰-֏֐-׿؀-ۿ܀-ݏऀ-ॿ฀-๿぀-ゟ゠-ヿ㄀-ㄯ㐀-䶿一-鿿가-힯＀-￯豈-﫿]/g;

/*
   Txt -> ____|________________
         | _splitSentences() | -> [Txt]
          ------------------
      Splits on terminal punctuation/newlines, keeping the delimiter; avoids
      spurious splits inside decimals by requiring whitespace/EOL after.
*/
function _splitSentences(text) {
  return text.split(/(?<=[.!?\n])\s+/);
}

/*
   Txt, Txt -> ____|_________________________
              | _isEnglishDriftSentence() | -> T/F
               ---------------------------
      True when the sentence is long enough to judge, reads as English, and
      the expected language is not English.
*/
function _isEnglishDriftSentence(sentence, expectedLang) {
  const trimmed = sentence.trim();
  if (trimmed.length < 12) return false;
  const lang = detectLanguageHeuristic(trimmed);
  if (lang !== "en") return false;
  return expectedLang !== "en";
}

class LanguageDriftGuardrail extends IGuardrail {
  get id() { return "language_drift"; }
  get severity() { return "high"; }

  /*
   Txt, Obj -> ____|_________
              | check() | -> Obj
               -----------
      True (violated) when the response contains non-latin characters, or an
      English sentence while ctx.lang is es/val; reason/evidence describe it.
  */
  check(response, ctx) {
    if (typeof response !== "string" || response.length === 0) {
      return { violated: false };
    }
    const m = response.match(NON_LATIN_REGEX_GLOBAL);
    if (m) {
      return {
        violated: true,
        reason: "non_latin",
        evidence:
          "non_latin_chars_count=" + m.length +
          " sample='" + m.slice(0, 8).join("") + "'",
      };
    }
    const expected = ctx && ctx.lang;
    if (expected === "es" || expected === "val") {
      const sentences = _splitSentences(response);
      const drift = [];
      for (let i = 0; i < sentences.length; i++) {
        if (_isEnglishDriftSentence(sentences[i], expected)) {
          drift.push(sentences[i].trim());
        }
      }
      if (drift.length > 0) {
        return {
          violated: true,
          reason: "es_en_drift",
          evidence:
            "expected=" + expected +
            " driftSentences=" + drift.length +
            " sample='" + drift[0].slice(0, 80) + "'",
        };
      }
    }
    return { violated: false };
  }

  /*
   Txt, Obj -> ____|_______________
              | surgicalFix() | -> Obj | null
               -----------------
      Drops the offending sentences and keeps the rest. Returns null (force
      retry) when <20 chars survive or the original question is lost.
  */
  surgicalFix(response, ctx) {
    if (typeof response !== "string") return null;
    const expected = ctx && ctx.lang;
    const checkEsEn = expected === "es" || expected === "val";
    const hasNonLatin = NON_LATIN_REGEX.test(response);

    if (!hasNonLatin && !checkEsEn) {
      return { applied: false, text: response };
    }

    const sentences = _splitSentences(response);
    const clean = [];
    let dropped = false;
    for (let i = 0; i < sentences.length; i++) {
      const s = sentences[i];
      if (NON_LATIN_REGEX.test(s)) {
        dropped = true;
        continue;
      }
      if (checkEsEn && _isEnglishDriftSentence(s, expected)) {
        dropped = true;
        continue;
      }
      clean.push(s);
    }
    if (!dropped) {
      return { applied: false, text: response };
    }
    const text = clean.join(" ").replace(/\s+/g, " ").trim();
    if (text.length < 20) {
      return null;
    }
    if (response.indexOf("?") !== -1 && text.indexOf("?") === -1) {
      return null;
    }
    return {
      applied: dropped,
      text: text,
      before: response,
      after: text,
    };
  }

  /*
   Txt -> ____|___________________
         | buildRetryHint() | -> Txt
          --------------------
      Returns the drift retry hint, reinforcing the expected language and
      banning non-latin scripts and mixed-in English.
  */
  buildRetryHint(lang) {
    return getLanguageDriftRetryHint(lang);
  }
}

module.exports = LanguageDriftGuardrail;
module.exports.NON_LATIN_REGEX = NON_LATIN_REGEX;
module.exports.NON_LATIN_REGEX_GLOBAL = NON_LATIN_REGEX_GLOBAL;
module.exports._isEnglishDriftSentence = _isEnglishDriftSentence;
module.exports._splitSentences = _splitSentences;
