"use strict";

const AgentInterface = require("./base/AgentInterface");

/*------------------------------------------------------------------------------
            _________________________________________________________
            |               PEDAGOGICAL REVIEWER AGENT              |
            |  Applies deterministic pedagogical fixes to the raw   |
            |  LLM response BEFORE the safety guardrails run. No LLM |
            |  call. Centralises premature-confirmation, definition-|
            |  reframing, didactic-explanation, dataset-style and   |
            |  intra-sentence code-switch repairs.                  |
        ____|________________                                       |
        | constructor() | -> PedagogicalReviewerAgent  (no attrs)   |
        -----------------                                           |
        ____|____________                                           |
   Obj -> | canSkip() | -> T/F                          (no attrs)  |
          -----------                                               |
        ____|___________                                            |
   Obj -> | execute() | -> Promise<void>               (no attrs)   |
          -----------                                               |
        ____|________________________________                       |
   Txt,Txt -> | _stripPrematureConfirmation() | -> Txt  (no attrs)  |
              ---------------------------------                     |
        ____|_______________________________                        |
   Txt -> | _studentAskedForDefinition() | -> T/F        (no attrs) |
          --------------------------------                          |
        ____|______________________________                         |
   Txt,Txt -> | _reframeDefinitionRequest() | -> Txt     (no attrs) |
              -------------------------------                       |
        ____|___________________________                            |
   Txt -> | _reframePromptForLang() | -> Txt              (no attrs)|
          ---------------------------                               |
        ____|______________________________                         |
   Txt,Txt -> | _fixDidacticExplanation() | -> Txt       (no attrs) |
              -----------------------------                         |
        ____|_________________________                              |
   Txt -> | _enforceDatasetStyle() | -> Txt               (no attrs)|
          --------------------------                                |
        ____|__________________                                     |
   Txt,Txt -> | _fixCodeSwitch() | -> Txt                 (no attrs)|
              --------------------                                  |
            |                                                       |
            |_______________________________________________________|
------------------------------------------------------------------------------*/
class PedagogicalReviewerAgent extends AgentInterface {
  /*
       ____|________________
      | constructor() | -> PedagogicalReviewerAgent    (no attributes)
       -----------------
      Sets the agent name. No injected dependencies; helpers lazy-require
      the existing rule-based modules.
  */
  constructor() {
    super("pedagogicalReviewerAgent");
  }

  /*
       ____|____________
   Obj -> | canSkip() | -> T/F    (no attributes)
          -----------
      Skips on missing context, on a deterministic finish, or when there is
      no non-empty LLM response to review.
  */
  canSkip(context) {
    if (!context) return true;
    if (context.deterministicFinish) return true;
    if (typeof context.llmResponse !== "string" || context.llmResponse.trim() === "") return true;
    return false;
  }

  /*
       ____|___________
   Obj -> | execute() | -> Promise<void>    (no attributes)
          -----------
      Runs the five sequential repairs (premature confirmation, definition
      reframing, didactic explanation, dataset style, code-switch) on the
      response, mutating context.llmResponse and recording the list of
      applied corrections.
  */
  async execute(context) {
    if (this.canSkip(context)) return;

    const lang = context.lang || "es";
    const cls = (context.classification && context.classification.type) || null;
    const userMessage = context.userMessage || "";
    const corrections = [];
    let text = context.llmResponse;

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

    if (!this._studentAskedForDefinition(userMessage)) {
      const reframed = this._reframeDefinitionRequest(text, lang);
      if (reframed && reframed !== text) {
        text = reframed;
        corrections.push("definition_request_reframed");
      }
    }

    const didactic = this._fixDidacticExplanation(text, lang);
    if (didactic && didactic !== text) {
      text = didactic;
      corrections.push("didactic_explanation");
    }

    const styled = this._enforceDatasetStyle(text);
    if (styled && styled !== text) {
      text = styled;
      corrections.push("dataset_style");
    }

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

  /*
   Txt,Txt -> ____|________________________________
              | _stripPrematureConfirmation() | -> Txt    (no attributes)
              ---------------------------------
      Removes an opening "Perfecto/Correcto/…" confirmation and prepends a
      partial-feedback phrase so the reply still reads naturally.
  */
  _stripPrematureConfirmation(text, lang) {
    const { removeOpeningConfirmation } = require("../services/rag/guardrails");
    const { getRandomIntermediatePhrase } = require("../services/languageManager");
    const cleaned = removeOpeningConfirmation(text, lang);
    const second = removeOpeningConfirmation(cleaned, lang);
    if (second === text) return text;
    const prefix = getRandomIntermediatePhrase("partial", lang);
    return prefix ? prefix + " " + second.trim() : second;
  }

  /*
   Txt -> ____|_______________________________
         | _studentAskedForDefinition() | -> T/F    (no attributes)
          --------------------------------
      True when the student's own message is a definition/explanation
      request, using anchored es/val/en patterns to avoid false positives.
  */
  _studentAskedForDefinition(userMessage) {
    if (typeof userMessage !== "string" || !userMessage) return false;
    const lower = userMessage.toLowerCase().trim();
    const patterns = [
      /^¿?\s*qu[eé]\s+(es|significa|quiere\s+decir|entiendes\s+por)\b/i,
      /^¿?\s*c[oó]mo\s+(es|funciona|defin)/i,
      /^¿?\s*(expl[ií]came|expl[ií]canos|defíneme|defineme|definelo|defínelo|puedes\s+definir|podr[ií]as\s+definir|puedes\s+explicar|podr[ií]as\s+explicar)/i,
      /^¿?\s*qu[eè]\s+(és|significa|vols\s+dir)\b/i,
      /^¿?\s*(explica'?m|definix|pots\s+definir|pots\s+explicar)/i,
      /^\??\s*(what\s+is|what\s+does|what\s+means|explain\s+me|define\b|can\s+you\s+define|can\s+you\s+explain|could\s+you\s+explain)/i,
    ];
    for (let i = 0; i < patterns.length; i++) {
      if (patterns[i].test(lower)) return true;
    }
    return false;
  }

  /*
   Txt,Txt -> ____|______________________________
              | _reframeDefinitionRequest() | -> Txt    (no attributes)
              -------------------------------
      Works sentence by sentence: replaces any whole sentence that is a
      direct definition question by the tutor with a "how does it apply to
      THIS circuit?" reframe, preserving embedded "que es …" sub-clauses.
  */
  _reframeDefinitionRequest(text, lang) {
    if (typeof text !== "string") return text;
    const wholeSentencePatterns = [
      /^\s*¿?\s*\b(define|defíne(?:lo|la|me)?|defineix|definix)\b[^.?!]*[.?!]\s*$/i,
      /^\s*¿?\s*\b(qué|que|què)\s+(entiendes|entens|understand)\b[^.?!]*[.?!]\s*$/i,
      /^\s*¿?\s*\b(c[oó]mo\s+definir[íi]as|how\s+would\s+you\s+define)\b[^.?!]*[.?!]\s*$/i,
      /^\s*¿\s*qu[eéè]\s+(es|és)\b[^.?!]*\?\s*$/i,
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

  /*
   Txt -> ____|___________________________
         | _reframePromptForLang() | -> Txt    (no attributes)
          ---------------------------
      Returns the localized "how does that concept apply to THIS circuit?"
      reframe prompt.
  */
  _reframePromptForLang(lang) {
    if (lang === "en") return "How does that concept apply to THIS circuit?";
    if (lang === "val") return "Com s'aplica eixe concepte a AQUEST circuit?";
    return "¿Cómo se aplica ese concepto a ESTE circuito?";
  }

  /*
   Txt,Txt -> ____|____________________________
              | _fixDidacticExplanation() | -> Txt    (no attributes)
              -----------------------------
      When the response lectures instead of scaffolds, keeps only its
      question(s); if there are none, returns a localized redirect plus a
      random fallback scaffolding question.
  */
  _fixDidacticExplanation(text, lang) {
    const { checkDidacticExplanation } = require("../services/rag/guardrails");
    const { getDidacticFallbackQuestions, getDidacticFallbackPrefix } = require("../services/languageManager");
    const r = checkDidacticExplanation(text);
    if (!r || !r.explaining) return text;
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

  /*
   Txt -> ____|_________________________
         | _enforceDatasetStyle() | -> Txt    (no attributes)
          --------------------------
      Strips markdown and over-long prose to match the dataset style,
      returning the cleaned text or the original when unchanged.
  */
  _enforceDatasetStyle(text) {
    const { enforceDatasetStyle } = require("../services/rag/guardrails");
    const r = enforceDatasetStyle(text);
    return r && r.changed ? r.text : text;
  }

  /*
   Txt,Txt -> ____|__________________
              | _fixCodeSwitch() | -> Txt    (no attributes)
              --------------------
      Replaces a curated set of English fragments embedded in an es/val
      reply with their localized equivalent, longest match first, preserving
      the original leading capitalisation.
  */
  _fixCodeSwitch(text, lang) {
    if (typeof text !== "string" || text.length === 0) return text;
    const val = lang === "val";
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
      const re = new RegExp("(^|[^A-Za-z0-9])(" + en.replace(/ /g, "\\s+") + ")(?![A-Za-z0-9])", "gi");
      out = out.replace(re, function (m, pre, hit) {
        const r = /^[A-Z]/.test(hit) ? repl.charAt(0).toUpperCase() + repl.slice(1) : repl;
        return pre + r;
      });
    }
    return out;
  }
}

module.exports = PedagogicalReviewerAgent;
