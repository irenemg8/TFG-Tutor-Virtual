"use strict";

const IGuardrail = require("../../domain/ports/services/IGuardrail");

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

    // Rule 2: multi-pregunta
    const qmarks = (response.match(/\?/g) || []).length;
    if (qmarks > 1) {
      violations.push({ rule: "multi_question", details: { count: qmarks } });
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

    // missed_affirmation alone does NOT trigger surgicalFix (v1 policy):
    // mark the guardrail as not violated for the pipeline retry path,
    // but still surface the metadata in evidence so debug logs see it.
    const surgicalRules = violations.filter(
      (v) => v.rule === "contradiction" || v.rule === "multi_question"
    );
    if (surgicalRules.length === 0) {
      return { violated: false, metadata: { logOnly: violations } };
    }

    return {
      violated: true,
      evidence: surgicalRules.map((v) => v.rule).join(", "),
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

    // Rule 2 fix: truncate at the first sentence-final question mark, but
    // only if there are still multiple "?" after rule 1 redaction.
    const qmarks = (text.match(/\?/g) || []).length;
    if (qmarks > 1) {
      const firstQ = text.indexOf("?");
      if (firstQ >= 0) {
        const next = text.slice(0, firstQ + 1).trim();
        if (next.length > 0) {
          text = next;
          mutated = true;
        }
      }
    }

    if (!mutated) return { applied: false, text: response };
    return { applied: true, text: text, before: response, after: text };
  }

  buildRetryHint(_lang) {
    // Adherence violations are corrected surgically, not by LLM retry —
    // re-prompting qwen2.5 7B with the same prompt gives the same
    // violation rate. The retry hint is a no-op so the pipeline goes
    // straight to surgicalFix.
    return "";
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
// truncated affirmation with no question (Vicente flagged 2026-05-03).
const NEGATIVE_VERBS = "(?:no|tampoco)\\s+(?:es|son|cumple|cumplen|contribuye|contribuyen|forma|forman|influye|influyen|interviene|intervienen|aporta|aportan)";
const POSITIVE_VERBS = "(?:s[ií]\\s+)?(?:es|son|cumple|cumplen|contribuye|contribuyen|forma|forman|influye|influyen|interviene|intervienen|aporta|aportan)";

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
