"use strict";

const AgentInterface = require("./base/AgentInterface");

/**
 * PedagogicalReviewerAgent: applies deterministic pedagogical fixes to the
 * raw LLM response BEFORE the GuardrailAgent runs its safety pipeline.
 *
 * It centralises the three responsibilities that used to live in separate
 * IGuardrail adapters (PrematureConfirmation, DidacticExplanation,
 * DatasetStyle) plus a new one — "do not ask the student to define a
 * concept" — that the legacy stack didn't enforce. The original guardrail
 * adapters are kept intact and reachable via `createLegacyGuardrails()`
 * (env GUARDRAIL_PROFILE=legacy) so we can A/B-test if the agent regresses
 * any case.
 *
 * Why an agent and not a guardrail:
 *   - These checks are pedagogical, not safety. They reshape tone and
 *     scaffolding intent rather than block leaks or confirmations.
 *   - Running them BEFORE the safety guardrails means the safety stack
 *     sees a response that already follows the dataset style, which makes
 *     its own checks (solution_leak, false_confirmation, ...) cleaner.
 *   - It's deterministic — no LLM call — so it adds essentially no
 *     latency to the pipeline.
 *
 * Reads:  context.llmResponse, context.classification, context.userMessage,
 *         context.lang
 * Writes: context.llmResponse (mutated in place)
 *         context.pedagogicalCorrectionsApplied (string[] for auditing)
 */
class PedagogicalReviewerAgent extends AgentInterface {
  constructor() {
    super("pedagogicalReviewerAgent");
  }

  canSkip(context) {
    if (!context) return true;
    if (context.deterministicFinish) return true;
    if (typeof context.llmResponse !== "string" || context.llmResponse.trim() === "") return true;
    return false;
  }

  async execute(context) {
    if (this.canSkip(context)) return;

    const lang = context.lang || "es";
    const cls = (context.classification && context.classification.type) || null;
    const userMessage = context.userMessage || "";
    const corrections = [];
    let text = context.llmResponse;

    // --- 1. Premature confirmation -----------------------------------------
    // If the tutor opens with "Perfecto/Correcto/Genial..." while the student
    // hasn't justified yet (correct_no_reasoning, correct_wrong_reasoning,
    // partial_correct), strip the confirmation and prepend a partial-feedback
    // phrase so the response still reads naturally.
    //
    // Skip this when the student didn't mention any canonical element —
    // they are answering a Socratic concept question, not giving a final
    // list, so a "buena observación" / "correcto" from the tutor about a
    // conceptual point ("hay un interruptor abierto") is appropriate.
    const mentioned = (context.classification && context.classification.resistances) || [];
    const noElements = mentioned.length === 0;
    const partialTypes = ["correct_no_reasoning", "correct_wrong_reasoning", "partial_correct"];
    if (!noElements && partialTypes.indexOf(cls) >= 0) {
      const fixed = this._stripPrematureConfirmation(text, lang);
      if (fixed && fixed !== text) {
        text = fixed;
        corrections.push("premature_confirmation");
      }
    }

    // --- 2. Tutor asking the student to DEFINE a concept -------------------
    // The user's explicit complaint: the tutor was asking the student to
    // define concepts ("define divisor de tensión", "qué entiendes por...")
    // instead of testing the concept by applying it to THIS circuit.
    // Skip the rule when the student themselves asked for a definition in
    // their last message — answering a definition request is fine.
    if (!this._studentAskedForDefinition(userMessage)) {
      const reframed = this._reframeDefinitionRequest(text, lang);
      if (reframed && reframed !== text) {
        text = reframed;
        corrections.push("definition_request_reframed");
      }
    }

    // --- 3. Didactic explanation -------------------------------------------
    // The tutor must scaffold, not lecture. If the response contains
    // explanatory patterns ("esto significa que...", "cuando una resistencia
    // es X..."), keep only the question(s); if there isn't one, fall back
    // to a generic redirect + a rotating scaffolding question.
    const didactic = this._fixDidacticExplanation(text, lang);
    if (didactic && didactic !== text) {
      text = didactic;
      corrections.push("didactic_explanation");
    }

    // --- 4. Dataset style: strip markdown and over-long prose --------------
    const styled = this._enforceDatasetStyle(text);
    if (styled && styled !== text) {
      text = styled;
      corrections.push("dataset_style");
    }

    // --- 5. Intra-sentence English code-switch ------------------------------
    // The LanguageDriftGuardrail only catches WHOLE English sentences; a
    // Spanish/Valencian sentence with one or two English words embedded
    // ("estás en el right track", "specifically, …") reads as es/val and slips
    // through — yet it's a glaring "small/foreign-model" tell. Triggering a full
    // regeneration for two words would just produce the "regenerando…" spam, so
    // we repair it inline with a curated, high-precision phrase map. Only fires
    // for es/val sessions.
    if (lang === "es" || lang === "val") {
      const deswitched = this._fixCodeSwitch(text, lang);
      if (deswitched && deswitched !== text) {
        text = deswitched;
        corrections.push("code_switch");
      }
    }

    context.llmResponse = text;
    context.pedagogicalCorrectionsApplied = corrections;
  }

  // -------------------------------------------------------------------------
  // Helpers — delegate to the existing rule-based helpers in
  // domain/services/rag/guardrails.js + languageManager.js so we don't
  // duplicate the multi-language patterns that already work.
  // -------------------------------------------------------------------------

  _stripPrematureConfirmation(text, lang) {
    const { removeOpeningConfirmation } = require("../services/rag/guardrails");
    const { getRandomIntermediatePhrase } = require("../services/languageManager");
    const cleaned = removeOpeningConfirmation(text, lang);
    const second = removeOpeningConfirmation(cleaned, lang);
    if (second === text) return text;
    const prefix = getRandomIntermediatePhrase("partial", lang);
    return prefix ? prefix + " " + second.trim() : second;
  }

  _studentAskedForDefinition(userMessage) {
    if (typeof userMessage !== "string" || !userMessage) return false;
    const lower = userMessage.toLowerCase().trim();
    // Anchored / boundary-aware patterns: avoid false positives like "creo
    // que es R1 y R2" matching the substring "que es" — only treat the
    // student as having asked for a definition when the trigger is at the
    // start of the message, just after a leading "¿"/"?" or after a clear
    // phrase boundary.
    const patterns = [
      // es — interrogative openers
      /^¿?\s*qu[eé]\s+(es|significa|quiere\s+decir|entiendes\s+por)\b/i,
      /^¿?\s*c[oó]mo\s+(es|funciona|defin)/i,
      /^¿?\s*(expl[ií]came|expl[ií]canos|defíneme|defineme|definelo|defínelo|puedes\s+definir|podr[ií]as\s+definir|puedes\s+explicar|podr[ií]as\s+explicar)/i,
      // val
      /^¿?\s*qu[eè]\s+(és|significa|vols\s+dir)\b/i,
      /^¿?\s*(explica'?m|definix|pots\s+definir|pots\s+explicar)/i,
      // en
      /^\??\s*(what\s+is|what\s+does|what\s+means|explain\s+me|define\b|can\s+you\s+define|can\s+you\s+explain|could\s+you\s+explain)/i,
    ];
    for (let i = 0; i < patterns.length; i++) {
      if (patterns[i].test(lower)) return true;
    }
    return false;
  }

  _reframeDefinitionRequest(text, lang) {
    if (typeof text !== "string") return text;
    // BUG-014 (2026-05-03): los patrones anteriores se aplicaban con un
    // simple .replace() sobre el texto entero, lo que provocaba que
    // "que es parte de un divisor de tensión?" dentro de la frase
    // "¿Cómo afecta R1 ... si consideramos que es parte de un divisor de
    // tensión?" fuera tragado como si fuera una pregunta del tutor
    // pidiendo definición, dejando la apertura "¿Cómo afecta R1..."
    // colgando seguida del canned "¿Cómo se aplica ese concepto a ESTE
    // circuito?" — output corrupto con dos ¿ anidados.
    //
    // Solución: trabajar frase a frase. Una frase es candidata a
    // reframe SOLO si:
    //   - empieza con ¿ o "?"  (pregunta directa), Y
    //   - todo el contenido de la frase encaja con un patrón de
    //     definición (qué es X, define X, cómo definirías X, etc.).
    // Si no es la frase completa la que es una pregunta-definición, no
    // tocamos. Esto preserva sub-cláusulas como "...si consideramos que
    // es parte de un divisor..." porque "que es" está embebido y no es
    // la pregunta principal.
    const wholeSentencePatterns = [
      /^\s*¿?\s*\b(define|defíne(?:lo|la|me)?|defineix|definix)\b[^.?!]*[.?!]\s*$/i,
      /^\s*¿?\s*\b(qué|que|què)\s+(entiendes|entens|understand)\b[^.?!]*[.?!]\s*$/i,
      /^\s*¿?\s*\b(c[oó]mo\s+definir[íi]as|how\s+would\s+you\s+define)\b[^.?!]*[.?!]\s*$/i,
      // ES/VAL: "¿Qué/Què/Que es/és X?" como pregunta directa.
      /^\s*¿\s*qu[eéè]\s+(es|és)\b[^.?!]*\?\s*$/i,
      // EN: "What is X?" como pregunta directa.
      /^\s*\??\s*what\s+is\b[^.?!]*\?\s*$/i,
    ];
    const sentences = text.split(/(?<=[.!?])\s+/);
    let modified = false;
    for (let i = 0; i < sentences.length; i++) {
      const s = sentences[i];
      for (let p = 0; p < wholeSentencePatterns.length; p++) {
        if (wholeSentencePatterns[p].test(s)) {
          sentences[i] = this._reframePromptForLang(lang);
          modified = true;
          break;
        }
      }
    }
    if (!modified) return text;
    return sentences.join(" ").replace(/\s{2,}/g, " ").trim();
  }

  _reframePromptForLang(lang) {
    if (lang === "en") return "How does that concept apply to THIS circuit?";
    if (lang === "val") return "Com s'aplica eixe concepte a AQUEST circuit?";
    return "¿Cómo se aplica ese concepto a ESTE circuito?";
  }

  _fixDidacticExplanation(text, lang) {
    const { checkDidacticExplanation } = require("../services/rag/guardrails");
    const { getDidacticFallbackQuestions, getDidacticFallbackPrefix } = require("../services/languageManager");
    const r = checkDidacticExplanation(text);
    if (!r || !r.explaining) return text;
    // Same surgical strategy as DidacticExplanationGuardrail: keep questions
    // if any, otherwise return a generic redirect + fallback scaffold.
    const qs = text.match(/[¿?][^.!?\n]*[.!?]?|[^.!?\n]*\?/g) || [];
    const cleanQs = qs.map(function (q) { return q.trim(); }).filter(function (q) {
      return q.length > 0 && q.indexOf("?") >= 0;
    });
    if (cleanQs.length > 0) {
      return cleanQs.slice(0, 2).join(" ").trim();
    }
    const pool = getDidacticFallbackQuestions(lang);
    const prefix = getDidacticFallbackPrefix(lang);
    return prefix + " " + pool[Math.floor(Math.random() * pool.length)];
  }

  _enforceDatasetStyle(text) {
    const { enforceDatasetStyle } = require("../services/rag/guardrails");
    const r = enforceDatasetStyle(text);
    return r && r.changed ? r.text : text;
  }

  // Curated, HIGH-PRECISION English→es/val replacements for the intra-sentence
  // code-switch that qwen drops into otherwise-Spanish replies (observed:
  // "right track", "specifically", "indeed"). Every entry is an unambiguously
  // English fragment that is NOT a Spanish/Valencian word or a common technical
  // loanword (we deliberately exclude "ok", "online", "test", "feedback",
  // "software"…). Multi-word phrases are listed before their single-word
  // substrings so the longest match wins. Matching is case-insensitive with
  // ASCII word boundaries (all keys are accent-free English), and the original
  // capitalisation of the first letter is preserved.
  _fixCodeSwitch(text, lang) {
    if (typeof text !== "string" || text.length === 0) return text;
    const val = lang === "val";
    // [pattern, es, val] — order matters: longest/most-specific first.
    const MAP = [
      ["on the right track", "por buen camino", "pel bon camí"],
      ["the right track", "el buen camino", "el bon camí"],
      ["right track", "buen camino", "bon camí"],
      ["good job", "buen trabajo", "bon treball"],
      ["well done", "bien hecho", "ben fet"],
      ["keep going", "sigue así", "continua així"],
      ["you are right", "tienes razón", "tens raó"],
      ["you're right", "tienes razón", "tens raó"],
      ["for example", "por ejemplo", "per exemple"],
      ["of course", "por supuesto", "per descomptat"],
      ["in other words", "en otras palabras", "en altres paraules"],
      ["that said", "dicho esto", "dit això"],
      ["let's see", "veamos", "vegem"],
      ["let us see", "veamos", "vegem"],
      ["specifically", "en concreto", "en concret"],
      ["actually", "en realidad", "en realitat"],
      ["however", "sin embargo", "no obstant"],
      ["therefore", "por tanto", "per tant"],
      ["instead", "en su lugar", "en el seu lloc"],
      ["indeed", "efectivamente", "efectivament"],
      ["exactly", "exactamente", "exactament"],
      ["remember", "recuerda", "recorda"],
    ];
    let out = text;
    for (let i = 0; i < MAP.length; i++) {
      const en = MAP[i][0];
      const repl = val ? MAP[i][2] : MAP[i][1];
      // ASCII boundaries: not preceded/followed by a letter or digit.
      const re = new RegExp("(^|[^A-Za-z0-9])(" + en.replace(/ /g, "\\s+") + ")(?![A-Za-z0-9])", "gi");
      out = out.replace(re, function (m, pre, hit) {
        // Preserve a leading capital if the matched fragment was capitalised.
        const r = /^[A-Z]/.test(hit) ? repl.charAt(0).toUpperCase() + repl.slice(1) : repl;
        return pre + r;
      });
    }
    return out;
  }
}

module.exports = PedagogicalReviewerAgent;
