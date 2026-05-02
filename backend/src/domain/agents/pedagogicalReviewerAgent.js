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
    // Patterns where the tutor explicitly asks the student to define a concept.
    // Multilingual: es / val / en. We only intervene when one is the LAST
    // sentence of the tutor response — otherwise we may corrupt valid prose.
    const patterns = [
      /\b(define|defíne(?:lo|la|me)?|defineix|definix)\b[^.?!]*[.?!]/i,
      /\b(qué|que|què)\s+(entiendes|entens|understand)\b[^.?!]*[.?!]/i,
      /\b(c[oó]mo\s+definir[íi]as|how\s+would\s+you\s+define)\b[^.?!]*[.?!]/i,
      /\bqu[eé]\s+(es|és|is)\b[^.?!]*\?/i,
    ];
    let modified = false;
    let out = text;
    for (let i = 0; i < patterns.length; i++) {
      if (patterns[i].test(out)) {
        // Replace the offending sentence with a redirect that pushes the
        // student to APPLY the concept to the circuit.
        out = out.replace(patterns[i], this._reframePromptForLang(lang));
        modified = true;
      }
    }
    return modified ? out.replace(/\s{2,}/g, " ").trim() : text;
  }

  _reframePromptForLang(lang) {
    if (lang === "en") return "How does that concept apply to THIS circuit?";
    if (lang === "val") return "Com s'aplica eixe concepte a AQUEST circuit?";
    return "¿Cómo se aplica ese concepto a ESTE circuito?";
  }

  _fixDidacticExplanation(text, lang) {
    const { checkDidacticExplanation } = require("../services/rag/guardrails");
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
    const FALLBACK_QUESTIONS = {
      es: [
        "¿Qué condición necesita una rama del circuito para que circule corriente por ella?",
        "¿Qué ocurre con la tensión entre dos puntos que están al mismo potencial?",
        "¿Cómo se distribuye la corriente entre ramas en paralelo?",
        "¿Qué efecto tiene un camino sin resistencia entre dos nodos?",
      ],
      val: [
        "Quina condició necessita una branca del circuit perquè hi circule corrent?",
        "Què passa amb la tensió entre dos punts que estan al mateix potencial?",
        "Com es distribueix el corrent entre branques en paral·lel?",
        "Quin efecte té un camí sense resistència entre dos nodes?",
      ],
      en: [
        "What condition does a branch of the circuit need for current to flow through it?",
        "What happens to the voltage between two points that share the same potential?",
        "How does current distribute among parallel branches?",
        "What is the effect of a path with no resistance between two nodes?",
      ],
    };
    const PREFIX = {
      es: "Vamos a no adelantar la explicación.",
      val: "No avancem l'explicació.",
      en: "Let's hold off on the explanation.",
    };
    const pool = FALLBACK_QUESTIONS[lang] || FALLBACK_QUESTIONS.es;
    const prefix = PREFIX[lang] || PREFIX.es;
    return prefix + " " + pool[Math.floor(Math.random() * pool.length)];
  }

  _enforceDatasetStyle(text) {
    const { enforceDatasetStyle } = require("../services/rag/guardrails");
    const r = enforceDatasetStyle(text);
    return r && r.changed ? r.text : text;
  }
}

module.exports = PedagogicalReviewerAgent;
