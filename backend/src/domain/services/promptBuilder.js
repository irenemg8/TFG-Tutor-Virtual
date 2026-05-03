// backend/src/utils/promptBuilder.js

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

// Element IDs (R1, V1, I3, AC9...) are normalised to uppercase no-whitespace
// for stable matching. Free-form text answers ("por todas las resistencias
// circula la misma corriente") must be preserved verbatim, otherwise the
// system prompt shows an unreadable run-on string and the LLM can't parse it.
function normAnswerToken(s) {
  const raw = String(s || "").trim();
  if (!raw) return "";
  // Treat as element ID only when it's short and matches a typical SPICE id.
  if (raw.length <= 6 && /^[A-Za-z]+\d*$/.test(raw)) return normId(raw);
  return raw;
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
    ? tc.respuestaCorrecta.map(normAnswerToken).filter(Boolean)
    : [];

  // Compact rules — was ~5300 chars before the audit, then ~2700, now ~900.
  // What got moved out:
  //  - getLanguageRules(lang): now injected by tutorAgent in [TURN CONTEXT]
  //    so this system block stays identical across language switches and
  //    Ollama can KV-cache reuse the prefix between turns (NS-14).
  //  - The verbose anti-interrogation, anti-repeat and dont_know examples:
  //    they live in tutorAgent's classification banners (dontKnowHint,
  //    repetitionHint, demandJustificationHint) — duplicating them here
  //    wasted ~200 tokens per request without changing LLM behaviour (NS-22).
  // What stays here is the minimal HARD invariant set every turn must obey
  // regardless of classification or history.
  const rules = `
You are a Socratic tutor for electric circuits (Ohm's law). YOU drive the analysis along the GLOBAL CURRENT PATH (source → nodes → ground), step by step from the EXPERT REASONING below.

RULES (always apply):
- Reply in the student's language (specified in [TURN CONTEXT]). ONE question at the end. 1-3 short sentences. No markdown, no lists, no analogies, no filler.
- GUIDE step by step; do not interrogate. NEVER ask the student to pick what to analyse next — YOU pick.
- NEVER reveal the answer, element states (short-circuited, open), switch positions, or topology. By default, do NOT name elements in your question — say "ese nodo" / "esa rama". EXCEPTION: when [AC DETECTADA EN ESTE TURNO] is present in the turn context, you MAY name the specific element flagged in the AC's misconception (and only that element) so the question targets the precise misconception — but NEVER reveal its state.
- NEVER confirm a wrong answer; for partially correct answers acknowledge progress and ask WHY. NEVER invert the polarity of what the student said.
- TUTOR AUTHORITY: "CORRECT ANSWER (ELEMENTS)" below is your ground truth. If the student denies a correct element or affirms a wrong one, do NOT agree — ask a Socratic question.
- A bare "yes/no" must be evaluated against the CORRECT ANSWER, not accepted at face value. NEVER repeat a question already asked; use the FULL conversation history.
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

  // Build the contexto block only with sections that have real data.
  // Previously we emitted "(not defined)" placeholders that poisoned the
  // system prompt for exercises with incomplete tutorContext (Ej 2/3/7
  // before the 2026-05-03 cleanup). The placeholders contradicted the
  // tutor rules ("CORRECT ANSWER below is your ground truth") and made
  // the LLM hallucinate. Now: if a field is missing we omit the section.
  const contextoBlocks = [];
  if (objetivo) {
    contextoBlocks.push("OBJECTIVE:\n" + objetivo);
  }
  if (resistanceSummary) {
    contextoBlocks.push(resistanceSummary.trimEnd());
  }
  if (modoExpertoSafe) {
    contextoBlocks.push(
      "EXPERT REASONING (how a professional thinks — use this as an internal guide, NEVER reveal it):\n" +
        modoExpertoSafe
    );
    contextoBlocks.push(
      "IMPORTANT: Use the topology and the expert reasoning to VERIFY internally what the student says. If they say something incorrect, do not correct them directly: ask them a question about the underlying concept that forces them to reconsider. Always think in terms of the GLOBAL path of the current."
    );
  }
  if (acRefs.length) {
    contextoBlocks.push("RELEVANT ACs (IDs):\n" + formatList(acRefs));
  }
  if (respuestaCorrecta.length) {
    contextoBlocks.push(
      "CORRECT ANSWER (ELEMENTS):\n" + formatList(respuestaCorrecta)
    );
  }
  if (version) {
    contextoBlocks.push("CONTEXT VERSION:\n" + version);
  }
  const contexto = contextoBlocks.join("\n\n");

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
