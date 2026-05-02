// backend/src/utils/promptBuilder.js

const { getLanguageRules } = require("./languageManager");
const FIN_TOKEN = "<FIN_EJERCICIO>";

function safeStr(x) {
  if (typeof x !== "string") return "";
  return x.trim();
}

function pickFirstStr(obj, keys) {
  for (const k of keys) {
    const v = safeStr(obj?.[k]);
    if (v) return v;
  }
  return "";
}

function normId(s) {
  return String(s || "")
    .toUpperCase()
    .replace(/\s+/g, "")
    .trim();
}

function formatList(arr) {
  if (!Array.isArray(arr) || arr.length === 0) return "";
  return arr.filter(Boolean).join(", ");
}

// Parse netlist to generate an explicit per-resistance topology summary
// so the LLM doesn't need to reason about circuit topology itself
function buildResistanceSummary(netlist) {
  if (!netlist) return "";

  const lines = netlist.split("\n").map(l => l.trim()).filter(Boolean);
  const resistances = [];
  const otherComponents = [];
  const notes = [];

  for (const line of lines) {
    // Parse resistance lines like "R1 N1 N2 1"
    const rMatch = line.match(/^(R\d+)\s+(\S+)\s+(\S+)/i);
    if (rMatch) {
      resistances.push({ name: rMatch[1].toUpperCase(), node1: rMatch[2], node2: rMatch[3] });
      continue;
    }
    // Parse voltage sources like "V1 N1 0 1"
    const vMatch = line.match(/^(V\d+)\s+(\S+)\s+(\S+)/i);
    if (vMatch) {
      otherComponents.push(vMatch[1] + ": fuente de tensión entre " + vMatch[2] + " y " + vMatch[3]);
      continue;
    }
    // Capture notes (switch info, etc.)
    if (line.length > 5) {
      notes.push(line);
    }
  }

  if (resistances.length === 0) return "";

  let summary = "CIRCUIT TOPOLOGY (internal information, DO NOT reveal to the student):\n";

  // Components
  for (const c of otherComponents) {
    summary += "- " + c + "\n";
  }

  // Resistances with detected states
  for (const r of resistances) {
    let status = "Connected between " + r.node1 + " and " + r.node2;

    // Detect short circuit (both nodes are the same)
    if (r.node1 === r.node2) {
      status += " -> SHORT-CIRCUITED (both terminals at the same node)";
    }

    summary += "- " + r.name + ": " + status + "\n";
  }

  // Notes (switches, etc.)
  for (const note of notes) {
    summary += "- NOTE: " + note + "\n";
  }

  // Add modoExperto reasoning (sanitized version is done later)
  return summary;
}

function buildTutorSystemPrompt(ejercicio, lang) {
  lang = lang || "es";
  // Campos base del ejercicio
  const titulo = pickFirstStr(ejercicio, ["titulo", "nombre", "name"]);
  const enunciado = pickFirstStr(ejercicio, ["enunciado", "texto", "statement", "descripcion"]);
  const concepto = pickFirstStr(ejercicio, ["concepto", "tema", "topic"]);
  const asignatura = pickFirstStr(ejercicio, ["asignatura", "subject"]);
  const nivel = ejercicio?.nivel != null ? String(ejercicio.nivel) : "";
  const imagen = pickFirstStr(ejercicio, ["imagen", "image", "imageUrl", "img"]);

  // TutorContext estructurado
  const tc = ejercicio?.tutorContext || {};
  const objetivo = pickFirstStr(tc, ["objetivo"]);
  const netlist = pickFirstStr(tc, ["netlist"]);
  const modoExperto = pickFirstStr(tc, ["modoExperto"]);
  const version = tc?.version != null ? String(tc.version) : "";

  // IDs de AC relevantes (solo IDs, no el objeto entero)
  const acRefs = Array.isArray(tc?.ac_refs) ? tc.ac_refs.map(normId).filter(Boolean) : [];

  // ✅ Respuesta correcta (lista cerrada para este ejercicio)
  const respuestaCorrecta = Array.isArray(tc?.respuestaCorrecta)
    ? tc.respuestaCorrecta.map(normId).filter(Boolean)
    : [];

  // Compact rules (was ~5300 chars before the latency audit, now ~1400).
  // Each rule has been deduplicated and normalised against what the
  // PedagogicalReviewerAgent and the safety guardrails already enforce
  // downstream — no need to repeat instructions the LLM gets pushed back
  // on anyway. The dataset's [REFERENCE EXAMPLES] supply tone/style.
  const rules = `
You are a Socratic tutor for electric circuits (Ohm's law). Help the student reason GLOBALLY: trace the current path through nodes, do not inspect resistors one by one.

RULES:
${getLanguageRules(lang)}
- Reply in the student's language. ONE single question at the end. 1-3 short sentences. No markdown, no lists, no analogies, no filler ("Let's see", "Interesting").
- NEVER reveal the answer, element states (short-circuited, open), switch positions, or topology. NEVER name a specific element in your question — ask about CONCEPTS (current path, series, parallel, short, open).
- NEVER confirm a wrong answer ("Perfect", "Correct"). For partially correct answers (right elements, no justification), acknowledge progress and ask WHY.
- TUTOR AUTHORITY: the "CORRECT ANSWER (ELEMENTS)" below is your ground truth. If the student denies a correct element or affirms a wrong one, do NOT agree — ask a Socratic question to reconsider.
- A bare "yes/no" must be evaluated against the CORRECT ANSWER, not accepted at face value.
- Do NOT lecture or define concepts. If the student says "no sé" or stalls, scaffold with a simpler, concrete question about a visible feature.
- NEVER repeat a question already answered correctly. Evaluate using the FULL conversation history.
- NETLIST, EXPERT REASONING and CORRECT ANSWER are INTERNAL — never quote them.
- Close ONLY when elements are correct AND justified — then append ${FIN_TOKEN}.
`.trim();

  // Sanitize modoExperto: remove sentences that directly reveal the answer
  let modoExpertoSafe = modoExperto;
  if (modoExpertoSafe && respuestaCorrecta.length > 0) {
    // Remove sentences that list the correct answer explicitly
    const sentences = modoExpertoSafe.split(/(?<=[.!?])\s+/);
    const filtered = [];
    for (const s of sentences) {
      const mentioned = (s.match(/R\d+/gi) || []).map(r => r.toUpperCase());
      // Skip sentence if it contains ALL correct resistances (likely reveals the answer)
      const hasAll = respuestaCorrecta.every(r => mentioned.includes(r));
      if (hasAll && mentioned.length >= respuestaCorrecta.length) {
        continue; // skip this sentence
      }
      filtered.push(s);
    }
    modoExpertoSafe = filtered.join(" ");
  }

  const resistanceSummary = buildResistanceSummary(netlist);

  const contexto = `
OBJECTIVE:
${objetivo || "(not defined)"}

${resistanceSummary}
EXPERT REASONING (how a professional thinks — use this as an internal guide, NEVER reveal it):
${modoExpertoSafe || "(not defined)"}

IMPORTANT: Use the topology and the expert reasoning to VERIFY internally what the student says. If they say something incorrect, do not correct them directly: ask them a question about the underlying concept that forces them to reconsider. Always think in terms of the GLOBAL path of the current.

RELEVANT ACs (IDs):
${acRefs.length ? formatList(acRefs) : "(none)"}

CORRECT ANSWER (ELEMENTS):
${respuestaCorrecta.length ? formatList(respuestaCorrecta) : "(not defined)"}

CONTEXT VERSION:
${version || "(not defined)"}
`.trim();

  const ejercicioInfo = `
CURRENT EXERCISE:
${titulo ? `Title: ${titulo}` : ""}
${asignatura ? `Subject: ${asignatura}` : ""}
${concepto ? `Concept: ${concepto}` : ""}
${nivel ? `Level: ${nivel}` : ""}
${enunciado ? `Statement: ${enunciado}` : ""}
${imagen ? `Associated image (reference): ${imagen}` : ""}
`.trim();

  return [rules, ejercicioInfo, contexto].filter(Boolean).join("\n\n");
}

module.exports = { buildTutorSystemPrompt };
