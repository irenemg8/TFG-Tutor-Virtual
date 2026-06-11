"use strict";

const IGuardrail = require("../../domain/ports/services/IGuardrail");
const { stripAccents } = require("../../domain/services/text/accentNormalizer");
const {
  ADHERENCE_NEGATIVE_VERBS: NEGATIVE_VERBS,
  ADHERENCE_POSITIVE_VERBS: POSITIVE_VERBS,
} = require("../../domain/services/languageManager");

/**
 * AdherenceGuardrail (NS-33) — defensa en profundidad post-LLM contra
 * fallos sistemáticos de adherencia de qwen2.5 7B al protocolo socrático
 * y a la verdad pedagógica del backend.
 *
 * Tres sub-reglas, todas deterministas (sin LLM):
 *
 *   1. Contradicción Rn — el LLM dice "R1 no contribuye" cuando R1 sí
 *      está en correctAnswer (o "R5 sí contribuye" cuando no lo está).
 *      Las dos polaridades violan TUTOR AUTHORITY del system prompt.
 *      Surgical fix: eliminar la oración contradictoria.
 *
 *   2. Multi-pregunta — qwen2.5 7B encadena 2-3 preguntas en una sola
 *      respuesta a pesar de la regla "ONE single question". Surgical
 *      fix: truncar al primer signo de cierre de pregunta.
 *
 *   3. Missed affirmation (solo log) — el banner [VEREDICTO DEL TURNO]
 *      indicó hits que el LLM debía afirmar por nombre y la respuesta no
 *      menciona ninguno. No mutamos el texto en esta v1 (riesgo de fix
 *      automático mal compuesto); solo registramos para medir tasa real
 *      antes de decidir si el fix vale la pena.
 *
 * Severity: med — los violations de adherencia degradan la UX pero no
 * son leaks de la solución; SolutionLeakGuardrail (high) ya cubre eso.
 */
class AdherenceGuardrail extends IGuardrail {
  get id() { return "adherence"; }
  get severity() { return "med"; }

  check(response, ctx) {
    if (typeof response !== "string" || response.length === 0) {
      return { violated: false };
    }
    const correctAnswer = _normSet((ctx && ctx.correctAnswer) || []);
    const verdict = (ctx && ctx.turnVerdict) || null;
    const violations = [];

    // Rule 1: contradicción Rn
    const contradictions = _findContradictions(response, correctAnswer);
    if (contradictions.length > 0) {
      violations.push({ rule: "contradiction", details: contradictions });
    }

    // Rule 2: multi-pregunta. BUG-AD (2026-06-10): antes contaba TODOS los "?",
    // así que una coletilla retórica ("…, ¿verdad?") + la pregunta socrática
    // real contaban 2 y disparaban la regla; peor, el surgicalFix truncaba en
    // el PRIMER "?", quedándose con la coletilla y tirando la pregunta buena.
    // Ahora contamos sólo preguntas SUSTANTIVAS (las coletillas no cuentan).
    const substantiveQs = _countSubstantiveQuestions(response);
    if (substantiveQs > 1) {
      violations.push({ rule: "multi_question", details: { count: substantiveQs } });
    }

    // Rule 4 (false-premise question): a QUESTION that presupposes a CORRECT
    // element does not contribute ("¿por qué R4 no influye?") plants a falsehood
    // — production showed qwen2.5 doing this repeatedly despite the system-prompt
    // rule. The contradiction rule (Rule 1) deliberately skips questions, so this
    // is a separate, question-targeted check restricted to CORRECT elements (it
    // must NOT fire on "¿por qué R3 no influye?" when R3 is genuinely irrelevant).
    const falsePremise = _findFalsePremiseQuestions(response, correctAnswer);
    if (falsePremise.length > 0) {
      violations.push({ rule: "false_premise", details: falsePremise });
    }

    // Rule 5 (false ACCUSATION, 2026-06-11): the inverse of Rule 4. A question
    // presupposing the student CLAIMED an element contributes ("¿por qué
    // pensaste que R3 también influía?") when the student in fact NEGATED it
    // and never proposed it. Production: the student wrote "porque r3 está en
    // interruptor abierto y r5 en corto" (a correct, reasoned exclusion) and
    // the tutor replied "¿Por qué pensaste que R3 también influía?" — the
    // student answered, furious: "no dije que r3 influía". Deterministic and
    // high-precision: requires an accusation verb (pensaste/creías/dijiste…)
    // + a contribute verb + an Rn the student has negated (this turn or
    // cumulatively) and NEVER proposed in any turn.
    const falseAccusation = _findFalseAccusations(response, ctx);
    if (falseAccusation.length > 0) {
      violations.push({ rule: "false_accusation", details: falseAccusation });
    }

    // Rule 3: missed affirmation (log-only — no surgical fix in v1)
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

    // Surgically-fixable rules (contradiction, multi_question) and retry-only
    // rules (false_premise / false_accusation — no safe rewrite, so they force
    // an LLM retry). missed_affirmation alone stays log-only.
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

    // Rule 2 fix: keep through the FIRST SUBSTANTIVE question, dropping any
    // extra questions after it. BUG-AD: we truncate at the first substantive
    // "?" (skipping rhetorical tag-questions like "¿verdad?") instead of the
    // first "?" — otherwise we'd keep the tag and discard the real question.
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

  buildRetryHint(_lang) {
    // Contradiction / multi_question are corrected surgically (no retry hint
    // needed). The rules that reach a retry are false_premise and
    // false_accusation — neither can be safely rewritten — so the hint targets
    // both: never put words in the student's mouth, in either polarity.
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

function _normSet(arr) {
  const s = new Set();
  for (const x of arr || []) {
    if (typeof x === "string") s.add(x.toUpperCase().trim());
  }
  return s;
}

function _esc(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Rhetorical tag-questions ("…, ¿verdad?", "…, right?") are NOT a second
// Socratic question — they're confirmation-seeking fillers. We must not count
// them toward the "ONE question" rule nor keep them when truncating. es/val/en.
const TAG_QUESTION_WORDS = [
  // es
  "verdad", "cierto", "vale", "no", "si", "sí", "de acuerdo", "no crees", "no es asi", "no es así",
  // val
  "veritat", "cert", "no et sembla", "oi",
  // en
  "right", "correct", "okay", "ok", "isn't it", "isnt it", "is not it", "you see",
];

// Returns the "core" of an interrogative fragment: the text from the last "¿"
// to the "?" (Spanish), lowercased and stripped of question punctuation.
function _questionCore(fragment) {
  let q = String(fragment);
  const op = q.lastIndexOf("¿");
  if (op >= 0) q = q.slice(op + 1);
  return q.replace(/[?¡!.]/g, "").trim().toLowerCase();
}

// A fragment is a tag-question if its core is exactly a tag word, or it ends
// with ", <tag>" (the comma-attached trailing tag, common when there is no "¿").
function _isTagQuestion(fragment) {
  const core = _questionCore(fragment);
  if (TAG_QUESTION_WORDS.indexOf(core) >= 0) return true;
  const m = core.match(/,\s*([a-záéíóúñ'¿\s]+)$/);
  if (m && TAG_QUESTION_WORDS.indexOf(m[1].trim()) >= 0) return true;
  return false;
}

// Count the interrogative fragments that are NOT rhetorical tag-questions.
function _countSubstantiveQuestions(text) {
  const frags = String(text).match(/[^.!?]*\?/g) || [];
  let n = 0;
  for (let i = 0; i < frags.length; i++) {
    if (!_isTagQuestion(frags[i])) n++;
  }
  return n;
}

// Char index just past the "?" of the first SUBSTANTIVE question, or -1.
function _firstSubstantiveQuestionEnd(text) {
  const re = /[^.!?]*\?/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    if (!_isTagQuestion(m[0])) return m.index + m[0].length;
  }
  return -1;
}

// Detects sentences/clauses that explicitly state Rn does/does not
// contribute, and crosses them against the correctAnswer ground truth.
//
// We match two polarities:
//   negativeClaim: "R5 no contribuye / R5 no es / R5 tampoco interviene"
//   positiveClaim: "R5 sí contribuye / R5 forma parte / R5 cumple"
// A negativeClaim about an Rn that IS correct → contradiction.
// A positiveClaim about an Rn that is NOT correct → contradiction.
//
// IMPORTANT: matches inside QUESTIONS are NOT contradictions. The Socratic
// strategy explicitly asks "¿por qué crees que R2 no influye?" to attack a
// misconception — that's a valid pedagogical move, not a tutor mistake.
// Same principle StateRevealGuardrail applies. Without this gate the
// guardrail destroys the Socratic question and the student receives a
// truncated affirmation with no question

// Detects QUESTION sentences that presuppose a CORRECT element does not
// contribute ("¿por qué R4 no influye?"). We scan only interrogatives, find each
// Rn, and check whether — within the span AFTER that Rn (truncated at the next
// element so a neighbour's negation doesn't bleed) — there is a negated
// contribute-verb. Only CORRECT elements count: "¿por qué R3 no influye?" with
// R3 irrelevant is a legitimate Socratic move.
// Review C5 (2026-06-11): added the path/membership predicates ("no está en el
// camino") that PAST_INFLUENCE_RE (rule 5) already had — the asymmetry let
// "¿por qué crees que R4 no está en el camino?" (R4 correct) pass clean.
var FALSE_PREMISE_NEG = /\bno\s+(?:influye|influyen|contribuye|contribuyen|afecta|afectan|participa|participan|cuenta|cuentan|interviene|intervienen|importa|importan|forma\s+parte|forman\s+parte|es\s+relevante|son\s+relevantes|esta(?:n)?\s+en\s+el\s+(?:mismo\s+)?camino|esta(?:n)?\s+en\s+la\s+rama)\b/;

function _findFalsePremiseQuestions(text, correctSet) {
  if (!text || !correctSet || correctSet.size === 0) return [];
  const out = [];
  const sentences = String(text).split(/(?<=[.!?])\s+/);
  for (const sent of sentences) {
    if (sent.indexOf("?") < 0 && sent.indexOf("¿") < 0) continue; // questions only
    const folded = stripAccents(sent.toLowerCase());
    const re = /\br(\d+)\b/gi;
    let m;
    while ((m = re.exec(folded)) !== null) {
      const rn = ("R" + m[1]).toUpperCase();
      if (!correctSet.has(rn)) continue;
      // span AFTER this Rn, truncated at the next element mention. The window is
      // generous (80 chars) so an intervening relative clause ("R2, que está
      // conectada entre N2 y tierra, no influye…") doesn't hide the verb; the
      // next-element truncation still prevents a neighbour's negation bleeding in.
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

// Rule 5 (false accusation) regexes, accent-folded. The accusation verb is the
// load-bearing precision gate: a bare "¿influye R3?" never fires; only the
// "you said/thought it mattered" shape does. The NEGATED form ("¿por qué
// pensaste que R3 NO influía?") is a different question (about the exclusion,
// not an accusation of inclusion) and is explicitly skipped.
var ACCUSE_VERB_RE = /\b(pensast\w*|pensab\w*|creist\w*|creia(s)?\b|creies|pensav\w*|dijist\w*|deies|you\s+(thought|said)|did\s+you\s+(think|say))/;
// Run-4 (2026-06-11): the LLM phrased the accusation as "¿por qué pensaste que
// R5 también ESTABA EN EL CAMINO?" — a path/membership predicate, not an
// influence verb — and the rule missed it. Both regexes carry the same
// additions so the negated-form skip stays symmetric.
var PAST_INFLUENCE_RE = /\b(influia|influian|influye|influyen|contribuia|contribuian|contribuye|contribuyen|afectaba|afectaban|afecta|afectan|importaba|importaban|importa|estaba\s+en\s+el\s+(mismo\s+)?camino|estaban\s+en\s+el\s+(mismo\s+)?camino|formaba\s+parte|formaban\s+parte|era\s+relevante|eran\s+relevantes|influenced|mattered|contributed|was\s+in\s+the\s+path|was\s+part)\b/;
var NEGATED_INFLUENCE_RE = /\bno\s+(influia|influian|influye|influyen|contribuia|contribuian|contribuye|contribuyen|afectaba|afectaban|afecta|afectan|importaba|importaban|importa|estaba\s+en\s+el\s+(mismo\s+)?camino|formaba\s+parte|era\s+relevante)\b/;

function _findFalseAccusations(text, ctx) {
  if (!text || !ctx) return [];
  const cum = ctx.cumulativeAnswer || null;
  // Everything the student has EVER negated (this turn + across the session)…
  const everNegated = _normSet(
    [].concat(ctx.negated || [],
      (cum && cum.excluded) || [],
      (cum && cum.wronglyExcluded) || [])
  );
  if (everNegated.size === 0) return [];
  // …minus anything they EVER proposed (any turn): if they once proposed Rn,
  // "why did you think Rn mattered" refers to that real proposal — legitimate.
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
    if (NEGATED_INFLUENCE_RE.test(folded)) continue; // "…que R3 NO influía" — not an accusation of inclusion
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

function _findContradictions(text, correctSet) {
  if (!text || correctSet.size === 0) return [];
  const out = [];
  // Walk sentences keeping their terminator so we can tell questions apart.
  const sentences = text.split(/(?<=[.!?])\s+/);
  for (const sent of sentences) {
    if (sent.includes("?") || sent.includes("¿")) continue; // skip questions
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
