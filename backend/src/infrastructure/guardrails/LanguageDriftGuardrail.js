"use strict";

const IGuardrail = require("../../domain/ports/services/IGuardrail");
const { detectLanguageHeuristic } = require("../../domain/services/languageManager");

/**
 * BUG-002 (CRÍTICO 2026-05-03): qwen2.5:7b ocasionalmente mezcla chino
 * (CJK), cirílico u otros scripts no-latinos en mid-respuesta — el resto
 * de guardrails no detectan el leak porque siguen mirando "R5"/"R3" en
 * caracteres latinos.
 *
 * BUG-008 (2026-05-03): qwen2.5 también mezcla frases en inglés dentro de
 * una respuesta esperada en español/valenciano (ej. "R1 is indeed part of
 * the answer. ¿Cómo afecta...?"). Latín-script puro, así que BUG-002 no
 * lo detecta. Esta guardrail ahora cubre ambos casos.
 *
 *   - check() devuelve violated:true si:
 *       a) hay caracteres en rangos CJK/cirílico/árabe/hebreo/devanagari, o
 *       b) ctx.lang ∈ {es, val} y al menos UNA frase de la respuesta es
 *          claramente inglesa (heurística de stopwords con ratio 1.5x).
 *   - surgicalFix() elimina frases con drift y deja el resto. Si tras el
 *     filtrado queda <20 chars o pierde la pregunta interrogativa,
 *     devolvemos null para que el GuardrailPipeline escale a retry con un
 *     hint que refuerza el idioma esperado.
 *
 * El detector ES↔EN se apoya en detectLanguageHeuristic del languageManager,
 * que sólo dispara si una frase tiene ≥2 stopwords y ratio 1.5x sobre el
 * siguiente idioma — protege frases ES/VAL con préstamos técnicos puntuales
 * tipo "el ground" o "current eléctrico".
 */

// Cualquier carácter fuera de:
//   ASCII printable + latin extended + signos comunes
// Excluye explícitamente CJK, cirílico, árabe, hebreo, devanagari, hangul.
const NON_LATIN_REGEX =
  /[Ѐ-ӿԀ-ԯ԰-֏֐-׿؀-ۿ܀-ݏऀ-ॿ฀-๿぀-ゟ゠-ヿ㄀-ㄯ㐀-䶿一-鿿가-힯＀-￯豈-﫿]/;

const NON_LATIN_REGEX_GLOBAL =
  /[Ѐ-ӿԀ-ԯ԰-֏֐-׿؀-ۿ܀-ݏऀ-ॿ฀-๿぀-ゟ゠-ヿ㄀-ㄯ㐀-䶿一-鿿가-힯＀-￯豈-﫿]/g;

function _splitSentences(text) {
  // Conservador: divide por puntuación final + saltos de línea, conservando
  // el delimitador en la frase de la izquierda. Evita splits espurios en
  // decimales tipo "3.14" porque exige whitespace o EOL después.
  return text.split(/(?<=[.!?\n])\s+/);
}

function _isEnglishDriftSentence(sentence, expectedLang) {
  // Frase muy corta: la heurística no tiene señal suficiente. Mejor no
  // condenarla — un "Yes." aislado no es drift accionable.
  const trimmed = sentence.trim();
  if (trimmed.length < 12) return false;
  const lang = detectLanguageHeuristic(trimmed);
  if (lang !== "en") return false;
  // Sólo hablamos de "drift" si el idioma esperado NO es inglés.
  return expectedLang !== "en";
}

class LanguageDriftGuardrail extends IGuardrail {
  get id() { return "language_drift"; }
  get severity() { return "high"; }

  check(response, ctx) {
    if (typeof response !== "string" || response.length === 0) {
      return { violated: false };
    }
    // BUG-002: scripts no-latinos
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
    // BUG-008: ES↔EN drift
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

  /**
   * Surgical fix: elimina frases que contengan cualquier carácter no-latino
   * o que sean inglés cuando se espera ES/VAL, y devuelve el resto. Si tras
   * el filtrado queda <20 chars o se pierde la pregunta interrogativa
   * original, devolvemos null para forzar retry — preferimos un retry con
   * hint reforzado a entregar una respuesta mutilada al alumno.
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
      // Demasiado poco que rescatar — pipeline retry con hint.
      return null;
    }
    // Si la respuesta original incluía una pregunta y el filtrado se la ha
    // llevado, preferimos retry para no romper el patrón socrático.
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

  /**
   * Retry hint que el GuardrailPipeline antepone cuando el surgicalFix
   * devuelve null. Refuerza el idioma esperado y prohíbe explícitamente
   * el uso de cualquier script no-latino o de inglés mezclado.
   */
  buildRetryHint(lang) {
    if (lang === "en") {
      return (
        "\n\nIMPORTANT: Your previous reply contained characters from a " +
        "non-Latin script (Chinese, Cyrillic, etc). Rewrite your reply " +
        "using ONLY the Latin alphabet, in English. One short Socratic " +
        "question, no element names."
      );
    }
    if (lang === "val") {
      return (
        "\n\nIMPORTANT: La teua resposta anterior contenia text en un " +
        "altre idioma (anglés o caràcters d'un alfabet no-llatí). Reescriu la " +
        "resposta ÍNTEGRAMENT en valencià, una sola pregunta socràtica " +
        "curta, sense nomenar elements i sense barrejar paraules angleses."
      );
    }
    return (
      "\n\nIMPORTANTE: Tu respuesta anterior contenía texto en otro idioma " +
      "(inglés o caracteres no-latinos). Reescribe la respuesta " +
      "ÍNTEGRAMENTE en español, una sola pregunta socrática corta, sin " +
      "nombrar elementos y sin mezclar palabras inglesas."
    );
  }
}

module.exports = LanguageDriftGuardrail;
module.exports.NON_LATIN_REGEX = NON_LATIN_REGEX;
module.exports.NON_LATIN_REGEX_GLOBAL = NON_LATIN_REGEX_GLOBAL;
module.exports._isEnglishDriftSentence = _isEnglishDriftSentence;
module.exports._splitSentences = _splitSentences;
