"use strict";

const IGuardrail = require("../../domain/ports/services/IGuardrail");
const { stripAccents } = require("../../domain/services/text/accentNormalizer");
const {
  ADHERENCE_NEGATIVE_VERBS: NEGATIVE_VERBS,
  ADHERENCE_POSITIVE_VERBS: POSITIVE_VERBS,
} = require("../../domain/services/languageManager");

/*------------------------------------------------------------------------------
            _________________________________________________________
            |                   ADHERENCEGUARDRAIL                |
            |  Guardrail adapter (IGuardrail). Deterministic defense |
            |  in depth against the LLM breaking Socratic protocol:  |
            |  contradicting the ground truth about an Rn, chaining  |
            |  several questions, planting a false premise/accusation|
            |  about an element, or missing an affirmation it owed.  |
        ____|_____________________                                   |
        | check() | -> Obj  (reads correctAnswer, turnVerdict, ctx)  |
        -----------                                                  |
        ____|_______________________                                 |
        | surgicalFix() | -> Obj          (reads correctAnswer)      |
        -----------------                                            |
        ____|___________________                                     |
        | buildRetryHint() | -> Txt                                  |
        --------------------                                         |
            |                                                       |
            |_______________________________________________________|
------------------------------------------------------------------------------*/
class AdherenceGuardrail extends IGuardrail {
  get id() { return "adherence"; }
  get severity() { return "med"; }

  /*
   Txt, Obj -> ____|_________
              | check() | -> Obj
               -----------
      Runs the contradiction, multi-question, false-premise, false-accusation
      and missed-affirmation rules; returns the surgical/retry violations.
  */
  check(response, ctx) {
    if (typeof response !== "string" || response.length === 0) {
      return { violated: false };
    }
    const correctAnswer = _normSet((ctx && ctx.correctAnswer) || []);
    const verdict = (ctx && ctx.turnVerdict) || null;
    const violations = [];

    // Rule 1: contradiction about an Rn.
    const contradictions = _findContradictions(response, correctAnswer);
    if (contradictions.length > 0) {
      violations.push({ rule: "contradiction", details: contradictions });
    }

    // Rule 2: multi-question (only substantive questions count, not tags).
    const substantiveQs = _countSubstantiveQuestions(response);
    if (substantiveQs > 1) {
      violations.push({ rule: "multi_question", details: { count: substantiveQs } });
    }

    // Rule 4: false-premise question about a CORRECT element.
    const falsePremise = _findFalsePremiseQuestions(response, correctAnswer);
    if (falsePremise.length > 0) {
      violations.push({ rule: "false_premise", details: falsePremise });
    }

    // Rule 5: false accusation (the student is told they claimed an element
    // they actually negated and never proposed).
    const falseAccusation = _findFalseAccusations(response, ctx);
    if (falseAccusation.length > 0) {
      violations.push({ rule: "false_accusation", details: falseAccusation });
    }

    // Rule 3: missed affirmation (log-only, no surgical fix).
    if (verdict && verdict.hits && verdict.hits.length > 0) {
      const lower = response.toLowerCase();
      const mentioned = verdict.hits.filter((h) => {
        const re = new RegExp("(^|[^a-z0-9])" + _esc(h.toLowerCase()) + "([^a-z0-9]|$)", "i");
        return re.test(lower);
      });
      if (mentioned.length === 0) {
        violations.push({
          rule: "missed_affirmation",
          details: { expectedHits: verdict.hits, surgical: false },
        });
      }
    }

    if (violations.length === 0) return { violated: false };

    // Surgically-fixable rules vs retry-only rules; missed_affirmation alone
    // stays log-only.
    const surgicalRules = violations.filter(
      (v) => v.rule === "contradiction" || v.rule === "multi_question"
    );
    const retryRules = violations.filter(
      (v) => v.rule === "false_premise" || v.rule === "false_accusation"
    );
    if (surgicalRules.length === 0 && retryRules.length === 0) {
      return { violated: false, metadata: { logOnly: violations } };
    }

    return {
      violated: true,
      evidence: surgicalRules.concat(retryRules).map((v) => v.rule).join(", "),
      metadata: { violations },
    };
  }

  /*
   Txt, Obj -> ____|_______________
              | surgicalFix() | -> Obj
               -----------------
      Fixes the two safe rules: drops sentences with a contradicted Rn claim,
      and truncates after the first substantive question.
  */
  surgicalFix(response, ctx) {
    if (typeof response !== "string" || response.length === 0) {
      return { applied: false, text: response };
    }
    const correctAnswer = _normSet((ctx && ctx.correctAnswer) || []);
    let text = response;
    let mutated = false;

    // Rule 1 fix: drop entire sentences containing a contradicted Rn claim.
    const contradictions = _findContradictions(text, correctAnswer);
    if (contradictions.length > 0) {
      const sentences = text.split(/(?<=[.!?])\s+/);
      const kept = [];
      for (const sent of sentences) {
        const sentContradictions = _findContradictions(sent, correctAnswer);
        if (sentContradictions.length === 0) kept.push(sent);
      }
      const next = kept.join(" ").trim();
      if (next.length > 0 && next !== text) {
        text = next;
        mutated = true;
      }
    }

    // Rule 2 fix: keep through the first substantive question (skipping
    // rhetorical tag-questions), dropping any extra questions after it.
    if (_countSubstantiveQuestions(text) > 1) {
      const end = _firstSubstantiveQuestionEnd(text);
      if (end > 0) {
        const next = text.slice(0, end).trim();
        if (next.length > 0 && next !== text) {
          text = next;
          mutated = true;
        }
      }
    }

    if (!mutated) return { applied: false, text: response };
    return { applied: true, text: text, before: response, after: text };
  }

  /*
   Txt -> ____|___________________
         | buildRetryHint() | -> Txt
          --------------------
      Hint for the retry-only rules (false_premise, false_accusation): never
      put words in the student's mouth, in either polarity, without revealing.
  */
  buildRetryHint(_lang) {
    return (
      "[CORRIGE TU PREGUNTA] Dos prohibiciones sobre premisas falsas:\n" +
      "1. NO preguntes '¿por qué [X] no influye / no contribuye?' sobre una resistencia que SÍ " +
      "forma parte de la respuesta — el alumno NO la ha negado y la premisa es falsa. Reformula " +
      "invitándole a CONSIDERAR todas las resistencias de la rama (p.ej. '¿has tenido en cuenta " +
      "todas las resistencias conectadas a ese nodo?'), sin afirmar que ninguna sobra.\n" +
      "2. NO preguntes '¿por qué pensaste/dijiste que [X] influía?' sobre un elemento que el " +
      "alumno ha EXCLUIDO correctamente y nunca propuso — le estás atribuyendo algo que no dijo. " +
      "Responde a lo que el alumno realmente dijo: si su exclusión es correcta y razonada, " +
      "reconócela y avanza al siguiente paso pendiente.\n" +
      "En ambos casos: sin revelar la respuesta.\n\n"
    );
  }
}

// ---------- helpers ----------

/*
   [Txt] -> ____|____________
           | _normSet() | -> Set<Txt>
            ------------
      Uppercased, trimmed Set of the string entries in the array.
*/
function _normSet(arr) {
  const s = new Set();
  for (const x of arr || []) {
    if (typeof x === "string") s.add(x.toUpperCase().trim());
  }
  return s;
}

/*
   Txt -> ____|________
         | _esc() | -> Txt
          --------
      Escapes regex metacharacters in a string.
*/
function _esc(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Rhetorical tag-questions ("…, ¿verdad?", "…, right?") that must NOT count
// toward the one-question rule nor be kept when truncating (es/val/en).
const TAG_QUESTION_WORDS = [
  "verdad", "cierto", "vale", "no", "si", "sí", "de acuerdo", "no crees", "no es asi", "no es así",
  "veritat", "cert", "no et sembla", "oi",
  "right", "correct", "okay", "ok", "isn't it", "isnt it", "is not it", "you see",
];

/*
   Txt -> ____|_______________
         | _questionCore() | -> Txt
          -----------------
      Core of an interrogative fragment (text after the last "¿"), lowercased
      and stripped of question punctuation.
*/
function _questionCore(fragment) {
  let q = String(fragment);
  const op = q.lastIndexOf("¿");
  if (op >= 0) q = q.slice(op + 1);
  return q.replace(/[?¡!.]/g, "").trim().toLowerCase();
}

/*
   Txt -> ____|_________________
         | _isTagQuestion() | -> T/F
          ------------------
      True when the fragment's core is a tag word, or it ends with ", <tag>".
*/
function _isTagQuestion(fragment) {
  const core = _questionCore(fragment);
  if (TAG_QUESTION_WORDS.indexOf(core) >= 0) return true;
  const m = core.match(/,\s*([a-záéíóúñ'¿\s]+)$/);
  if (m && TAG_QUESTION_WORDS.indexOf(m[1].trim()) >= 0) return true;
  return false;
}

/*
   Txt -> ____|___________________________
         | _countSubstantiveQuestions() | -> Z
          ----------------------------
      Count of interrogative fragments that are not rhetorical tag-questions.
*/
function _countSubstantiveQuestions(text) {
  const frags = String(text).match(/[^.!?]*\?/g) || [];
  let n = 0;
  for (let i = 0; i < frags.length; i++) {
    if (!_isTagQuestion(frags[i])) n++;
  }
  return n;
}

/*
   Txt -> ____|____________________________
         | _firstSubstantiveQuestionEnd() | -> Z
          -----------------------------
      Char index just past the "?" of the first substantive question, or -1.
*/
function _firstSubstantiveQuestionEnd(text) {
  const re = /[^.!?]*\?/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    if (!_isTagQuestion(m[0])) return m.index + m[0].length;
  }
  return -1;
}

// Negated contribute/path predicate used by the false-premise scan; matches in
// QUESTIONS only (declarative contradictions are handled by Rule 1).
var FALSE_PREMISE_NEG = /\bno\s+(?:influye|influyen|contribuye|contribuyen|afecta|afectan|participa|participan|cuenta|cuentan|interviene|intervienen|importa|importan|forma\s+parte|forman\s+parte|es\s+relevante|son\s+relevantes|esta(?:n)?\s+en\s+el\s+(?:mismo\s+)?camino|esta(?:n)?\s+en\s+la\s+rama)\b/;

/*
   Txt, Set<Txt> -> ____|___________________________
                   | _findFalsePremiseQuestions() | -> [Obj]
                    ----------------------------
      Finds questions that presuppose a CORRECT element does not contribute
      ("¿por qué R4 no influye?"), returning {element, evidence} entries.
*/
function _findFalsePremiseQuestions(text, correctSet) {
  if (!text || !correctSet || correctSet.size === 0) return [];
  const out = [];
  const sentences = String(text).split(/(?<=[.!?])\s+/);
  for (const sent of sentences) {
    if (sent.indexOf("?") < 0 && sent.indexOf("¿") < 0) continue;
    const folded = stripAccents(sent.toLowerCase());
    const re = /\br(\d+)\b/gi;
    let m;
    while ((m = re.exec(folded)) !== null) {
      const rn = ("R" + m[1]).toUpperCase();
      if (!correctSet.has(rn)) continue;
      let after = folded.slice(m.index + m[0].length, m.index + m[0].length + 80);
      const nextEl = after.search(/\br\d+\b/i);
      if (nextEl >= 0) after = after.slice(0, nextEl);
      if (FALSE_PREMISE_NEG.test(after)) {
        out.push({ element: rn, evidence: sent.trim().slice(0, 90) });
      }
    }
  }
  return out;
}

// Rule 5 (false accusation) regexes, accent-folded. ACCUSE_VERB_RE is the
// precision gate (only the "you said/thought it mattered" shape fires);
// NEGATED_INFLUENCE_RE marks the negated form, which is skipped.
var ACCUSE_VERB_RE = /\b(pensast\w*|pensab\w*|creist\w*|creia(s)?\b|creies|pensav\w*|dijist\w*|deies|you\s+(thought|said)|did\s+you\s+(think|say))/;
var PAST_INFLUENCE_RE = /\b(influia|influian|influye|influyen|contribuia|contribuian|contribuye|contribuyen|afectaba|afectaban|afecta|afectan|importaba|importaban|importa|estaba\s+en\s+el\s+(mismo\s+)?camino|estaban\s+en\s+el\s+(mismo\s+)?camino|formaba\s+parte|formaban\s+parte|era\s+relevante|eran\s+relevantes|influenced|mattered|contributed|was\s+in\s+the\s+path|was\s+part)\b/;
var NEGATED_INFLUENCE_RE = /\bno\s+(influia|influian|influye|influyen|contribuia|contribuian|contribuye|contribuyen|afectaba|afectaban|afecta|afectan|importaba|importaban|importa|estaba\s+en\s+el\s+(mismo\s+)?camino|formaba\s+parte|era\s+relevante)\b/;

/*
   Txt, Obj -> ____|________________________
              | _findFalseAccusations() | -> [Obj]
               -------------------------
      Finds questions accusing the student of having claimed an Rn matters
      when they negated it and never proposed it; returns {element, evidence}.
*/
function _findFalseAccusations(text, ctx) {
  if (!text || !ctx) return [];
  const cum = ctx.cumulativeAnswer || null;
  const everNegated = _normSet(
    [].concat(ctx.negated || [],
      (cum && cum.excluded) || [],
      (cum && cum.wronglyExcluded) || [])
  );
  if (everNegated.size === 0) return [];
  const everProposed = _normSet(
    [].concat(ctx.proposed || [],
      (cum && cum.namedCorrect) || [],
      (cum && cum.wronglyNamed) || [],
      (cum && Array.isArray(cum.perTurn))
        ? cum.perTurn.reduce((acc, t) => acc.concat(t.proposed || []), [])
        : [])
  );

  const out = [];
  const sentences = String(text).split(/(?<=[.!?])\s+/);
  for (const sent of sentences) {
    if (sent.indexOf("?") < 0 && sent.indexOf("¿") < 0) continue;
    const folded = stripAccents(sent.toLowerCase());
    if (!ACCUSE_VERB_RE.test(folded)) continue;
    if (NEGATED_INFLUENCE_RE.test(folded)) continue;
    if (!PAST_INFLUENCE_RE.test(folded)) continue;
    const re = /\br(\d+)\b/gi;
    let m;
    while ((m = re.exec(folded)) !== null) {
      const rn = ("R" + m[1]).toUpperCase();
      if (everNegated.has(rn) && !everProposed.has(rn)) {
        out.push({ element: rn, evidence: sent.trim().slice(0, 90) });
      }
    }
  }
  return out;
}

/*
   Txt, Set<Txt> -> ____|____________________
                   | _findContradictions() | -> [Obj]
                    ---------------------
      Declarative sentences (questions skipped) that state an Rn does/does not
      contribute against the ground truth; returns {element, polarity, evidence}.
*/
function _findContradictions(text, correctSet) {
  if (!text || correctSet.size === 0) return [];
  const out = [];
  const sentences = text.split(/(?<=[.!?])\s+/);
  for (const sent of sentences) {
    if (sent.includes("?") || sent.includes("¿")) continue;
    const hits = sent.matchAll(/\bR(\d+)\b\s+([^.,!?\n]{0,80})/gi);
    for (const m of hits) {
      const rn = "R" + m[1];
      const tail = m[2].toLowerCase();
      const isCorrect = correctSet.has(rn.toUpperCase());
      const negRe = new RegExp(NEGATIVE_VERBS, "i");
      const posRe = new RegExp("^\\s*" + POSITIVE_VERBS, "i");
      if (negRe.test(tail) && isCorrect) {
        out.push({ element: rn, polarity: "negative_about_correct", evidence: rn + " " + tail });
      } else if (posRe.test(tail) && !isCorrect) {
        out.push({ element: rn, polarity: "positive_about_wrong", evidence: rn + " " + tail });
      }
    }
  }
  return out;
}

module.exports = AdherenceGuardrail;
