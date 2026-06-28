/*------------------------------------------------------------------------------
            _________________________________________________________
            |                     PROMPT BUILDER                    |
            |  Module of functions that build the tutor system      |
            |  prompt from an exercise, plus lightweight language   |
            |  detection used to make the tutor reply in the        |
            |  student's language.                                  |
        ____|________________________                               |
   Obj -> | buildTutorSystemPrompt() | -> Txt                       |
          ----------------------------                              |
        ____|_______________________                                |
   Txt -> | getLanguageInstruction() | -> Txt                       |
          ----------------------------                              |
        ____|________________                                       |
   Txt -> | detectLanguage() | -> Txt                               |
          --------------------                                      |
            |                                                       |
            |_______________________________________________________|
------------------------------------------------------------------------------*/

const { detect } = require("tinyld");

const FIN_TOKEN = "<END_EXERCISE>";

/*
   Obj -> ____|__________
         | safeStr() | -> Txt
          -----------
      Returns the trimmed string, or "" when the value is not a string.
*/
function safeStr(x) {
  if (typeof x !== "string") return "";
  return x.trim();
}

/*
   Obj,[Txt] -> ____|_______________
               | pickFirstStr() | -> Txt
                ----------------
      Returns the first non-empty trimmed string found among the given
      object keys, or "" when none match.
*/
function pickFirstStr(obj, keys) {
  for (const k of keys) {
    const v = safeStr(obj?.[k]);
    if (v) return v;
  }
  return "";
}

/*
   Obj -> ____|_________
         | normId() | -> Txt
          ----------
      Normalizes an identifier to uppercase with all whitespace removed.
*/
function normId(s) {
  return String(s || "")
    .toUpperCase()
    .replace(/\s+/g, "")
    .trim();
}

/*
   [Txt] -> ____|_____________
           | formatList() | -> Txt
            --------------
      Joins the truthy array entries into a comma-separated string, or ""
      when the input is empty or not an array.
*/
function formatList(arr) {
  if (!Array.isArray(arr) || arr.length === 0) return "";
  return arr.filter(Boolean).join(", ");
}

/*
   Txt -> ____|________________________
         | buildResistanceSummary() | -> Txt
          --------------------------
      Parses the netlist into an explicit per-resistance topology summary
      (components, connections, detected short circuits, notes) so the LLM
      does not have to reason about circuit topology itself.
*/
function buildResistanceSummary(netlist) {
  if (!netlist) return "";

  const lines = netlist.split("\n").map(l => l.trim()).filter(Boolean);
  const resistances = [];
  const otherComponents = [];
  const notes = [];

  for (const line of lines) {
    const rMatch = line.match(/^(R\d+)\s+(\S+)\s+(\S+)/i);
    if (rMatch) {
      resistances.push({ name: rMatch[1].toUpperCase(), node1: rMatch[2], node2: rMatch[3] });
      continue;
    }
    const vMatch = line.match(/^(V\d+)\s+(\S+)\s+(\S+)/i);
    if (vMatch) {
      otherComponents.push(vMatch[1] + ": fuente de tensión entre " + vMatch[2] + " y " + vMatch[3]);
      continue;
    }
    if (line.length > 5) {
      notes.push(line);
    }
  }

  if (resistances.length === 0) return "";

  let summary = "TOPOLOGÍA DEL CIRCUITO (información interna, NO revelar al alumno):\n";

  for (const c of otherComponents) {
    summary += "- " + c + "\n";
  }

  for (const r of resistances) {
    let status = "Conectada entre " + r.node1 + " y " + r.node2;

    if (r.node1 === r.node2) {
      status += " → CORTOCIRCUITADA (ambos terminales en el mismo nudo)";
    }

    summary += "- " + r.name + ": " + status + "\n";
  }

  for (const note of notes) {
    summary += "- NOTA: " + note + "\n";
  }

  return summary;
}

/*
   Obj -> ____|________________________
         | buildTutorSystemPrompt() | -> Txt
          --------------------------
      Assembles the full Socratic-tutor system prompt: fixed pedagogical
      rules, the current exercise info, and the structured (sanitized)
      tutor context derived from the exercise.
*/
function buildTutorSystemPrompt(ejercicio) {
  const titulo = pickFirstStr(ejercicio, ["titulo", "nombre", "name"]);
  const enunciado = pickFirstStr(ejercicio, ["enunciado", "texto", "statement", "descripcion"]);
  const concepto = pickFirstStr(ejercicio, ["concepto", "tema", "topic"]);
  const asignatura = pickFirstStr(ejercicio, ["asignatura", "subject"]);
  const nivel = ejercicio?.nivel != null ? String(ejercicio.nivel) : "";
  const imagen = pickFirstStr(ejercicio, ["imagen", "image", "imageUrl", "img"]);

  const tc = ejercicio?.tutorContext || {};
  const objetivo = pickFirstStr(tc, ["objetivo"]);
  const netlist = pickFirstStr(tc, ["netlist"]);
  const modoExperto = pickFirstStr(tc, ["modoExperto"]);
  const version = tc?.version != null ? String(tc.version) : "";

  const acRefs = Array.isArray(tc?.ac_refs) ? tc.ac_refs.map(normId).filter(Boolean) : [];

  const respuestaCorrecta = Array.isArray(tc?.respuestaCorrecta)
    ? tc.respuestaCorrecta.map(normId).filter(Boolean)
    : [];

  const rules = `
Eres un tutor socrático para ayudar al estudiante a razonar sobre circuitos (Ley de Ohm).

ENFOQUE PEDAGÓGICO (cómo piensa un experto):
- Un experto analiza el circuito GLOBALMENTE: traza el camino de la corriente desde la fuente, por los nudos, y de vuelta. No mira resistencias una a una.
- Tu objetivo es que el alumno aprenda esta forma de pensar global. Haz preguntas que le lleven a trazar el recorrido de la corriente por todo el circuito.
- Usa el RAZONAMIENTO EXPERTO como guía interna: haz preguntas que lleven al alumno a descubrir ese razonamiento por sí mismo.
- Si detectas una CONCEPCIÓN ALTERNATIVA (AC) en lo que dice el alumno, céntrate en hacerle cuestionar esa creencia errónea con una pregunta sobre el CONCEPTO.
- Haz UNA sola pregunta por turno. Que sea sobre el recorrido de la corriente o sobre un concepto (serie, paralelo, cortocircuito, circuito abierto), NUNCA sobre una resistencia concreta.
- Ejemplos de buenas preguntas: "¿Por dónde crees que circula la corriente en este circuito?", "¿Qué condición debe cumplirse para que circule corriente por una rama?", "¿Qué ocurre con la corriente cuando dos puntos de un componente están al mismo potencial?".
- Ejemplos de MALAS preguntas/afirmaciones: "¿Qué pasa con R5?", "Analiza R3", "¿Cómo se relaciona R4 con N2?", "Considera R1", "¿Por qué no consideraste R4?", "No olvides R1", "¿Has pensado en R1?".

REGLAS ESTRICTAS:
- Si el alumno escribe en un idioma distinto al español, responde en ESE idioma. Si escribe en español, responde en español.
- NO des la solución final directamente.
- No uses analogías.
- Mantén un tono claro, paciente y técnico.
- Usa terminología correcta en español: di "tierra" (no "suelo"), "nudo" (no "nodo"), "condensador" (no "capacitor").
- NUNCA atribuyas a una resistencia una propiedad que no le corresponde. Antes de afirmar algo sobre una resistencia, verifica en la NETLIST.
- NUNCA confirmes como correcto algo que es incorrecto. Si el alumno dice algo erróneo, NO digas "Perfecto", "Correcto", "Muy bien", "Exacto" ni nada similar.
- NUNCA reinterpretes lo que el alumno ha dicho.
- NUNCA nombres una resistencia que el alumno NO haya mencionado antes. Si el alumno solo ha dicho R1 y R2, NO puedes decir R3, R4, R5, etc. El alumno debe descubrir qué resistencias faltan POR SÍ MISMO a través de tus preguntas conceptuales.
- NUNCA señales un elemento concreto de la respuesta para que el alumno lo analice. Esto incluye CUALQUIER forma: preguntas ("¿Y qué pasa con R5?", "¿Por qué no consideraste R4?", "¿Has pensado en R1?"), afirmaciones ("No olvides R1", "Considera R3", "Fíjate en R4"), o insinuaciones ("También hay que tener en cuenta R1").
- NUNCA reveles el estado de una resistencia (cortocircuitada, abierto, etc.), la posición de un interruptor, ni información de la topología del circuito. El alumno debe descubrirlo analizando el circuito.
- Si el alumno da una respuesta sin razonamiento, pídele que explique POR QUÉ antes de guiarle.
- La NETLIST, el RAZONAMIENTO EXPERTO, la RESPUESTA CORRECTA, los nudos y las conexiones son información INTERNA. NUNCA muestres ni cites esta información al alumno.

CRITERIO DE FIN:
- Solo puedes dar por finalizado el ejercicio cuando el estudiante haya dicho EXACTAMENTE las resistencias correctas (TODAS y sin extras) Y haya explicado POR QUÉ con razonamiento correcto.
- Si el estudiante da las resistencias correctas pero NO ha razonado por qué, pídele que explique su razonamiento antes de cerrar.
- La respuesta correcta se define por "RESPUESTA CORRECTA (RESISTENCIAS)".
- Al finalizar, añade el token ${FIN_TOKEN} al final.
`.trim();

  let modoExpertoSafe = modoExperto;
  if (modoExpertoSafe && respuestaCorrecta.length > 0) {
    const sentences = modoExpertoSafe.split(/(?<=[.!?])\s+/);
    const filtered = [];
    for (const s of sentences) {
      const mentioned = (s.match(/R\d+/gi) || []).map(r => r.toUpperCase());
      const hasAll = respuestaCorrecta.every(r => mentioned.includes(r));
      if (hasAll && mentioned.length >= respuestaCorrecta.length) {
        continue;
      }
      filtered.push(s);
    }
    modoExpertoSafe = filtered.join(" ");
  }

  const resistanceSummary = buildResistanceSummary(netlist);

  const contexto = `
OBJETIVO:
${objetivo || "(no definido)"}

${resistanceSummary}
RAZONAMIENTO EXPERTO (así piensa un profesional — usa esto como guía interna, NUNCA lo reveles):
${modoExpertoSafe || "(no definido)"}

IMPORTANTE: Usa la topología y el razonamiento experto para VERIFICAR internamente lo que dice el alumno. Si dice algo incorrecto, no le corrijas directamente: hazle una pregunta sobre el concepto que le lleve a reconsiderar. Piensa siempre en el RECORRIDO GLOBAL de la corriente.

ACs RELEVANTES (IDs):
${acRefs.length ? formatList(acRefs) : "(ninguna)"}

RESPUESTA CORRECTA (RESISTENCIAS):
${respuestaCorrecta.length ? formatList(respuestaCorrecta) : "(no definida)"}

VERSIÓN CONTEXTO:
${version || "(no definida)"}
`.trim();

  const ejercicioInfo = `
EJERCICIO ACTUAL:
${titulo ? `Título: ${titulo}` : ""}
${asignatura ? `Asignatura: ${asignatura}` : ""}
${concepto ? `Concepto: ${concepto}` : ""}
${nivel ? `Nivel: ${nivel}` : ""}
${enunciado ? `Enunciado: ${enunciado}` : ""}
${imagen ? `Imagen asociada (referencia): ${imagen}` : ""}
`.trim();

  return [rules, ejercicioInfo, contexto].filter(Boolean).join("\n\n");
}

const LANG_NAMES = {
  af: "Afrikaans", ar: "Arabic", bg: "Bulgarian", bn: "Bengali",
  ca: "Catalan", cs: "Czech", cy: "Welsh", da: "Danish",
  de: "German", el: "Greek", en: "English", es: "Spanish",
  et: "Estonian", eu: "Basque", fa: "Persian", fi: "Finnish",
  fr: "French", ga: "Irish", gl: "Galician", gu: "Gujarati",
  he: "Hebrew", hi: "Hindi", hr: "Croatian", hu: "Hungarian",
  hy: "Armenian", id: "Indonesian", is: "Icelandic", it: "Italian",
  ja: "Japanese", ka: "Georgian", kn: "Kannada", ko: "Korean",
  lt: "Lithuanian", lv: "Latvian", mk: "Macedonian", ml: "Malayalam",
  mr: "Marathi", ms: "Malay", nl: "Dutch", no: "Norwegian",
  pa: "Punjabi", pl: "Polish", pt: "Portuguese", ro: "Romanian",
  ru: "Russian", sk: "Slovak", sl: "Slovenian", sq: "Albanian",
  sr: "Serbian", sv: "Swedish", ta: "Tamil", te: "Telugu",
  th: "Thai", tl: "Tagalog", tr: "Turkish", uk: "Ukrainian",
  ur: "Urdu", vi: "Vietnamese", zh: "Chinese",
};

const SHORT_LANG_MAP = {
  "hello": "en", "hi": "en", "hey": "en", "yes": "en", "no": "en", "sure": "en",
  "ok": "en", "thanks": "en", "thank you": "en", "of course": "en", "okay": "en",
  "please": "en", "help": "en", "right": "en", "good": "en", "great": "en",
  "i think": "en", "i believe": "en", "i understand": "en",
  "i don't know": "en", "no idea": "en", "what": "en", "why": "en", "how": "en",
  "can you help": "en", "let me think": "en", "not sure": "en",
  "got it": "en", "i see": "en", "go on": "en", "go ahead": "en",
  "bonjour": "fr", "salut": "fr", "oui": "fr", "merci": "fr",
  "bien sûr": "fr", "pourquoi": "fr", "d'accord": "fr", "bonsoir": "fr",
  "je pense": "fr", "je crois": "fr", "je ne sais pas": "fr",
  "s'il vous plaît": "fr", "au revoir": "fr", "comment": "fr",
  "exactement": "fr", "je comprends": "fr", "très bien": "fr",
  "hola": "es", "sí": "es", "si": "es", "gracias": "es", "vale": "es",
  "bueno": "es", "claro": "es", "por qué": "es", "cómo": "es",
  "de acuerdo": "es", "no sé": "es", "creo que": "es", "entiendo": "es",
  "por favor": "es", "buenos días": "es", "buenas tardes": "es",
  "no lo sé": "es", "adelante": "es", "correcto": "es",
  "hallo": "de", "guten tag": "de", "ja": "de", "nein": "de", "danke": "de",
  "natürlich": "de", "warum": "de", "bitte": "de", "gut": "de",
  "ich denke": "de", "ich glaube": "de", "ich verstehe": "de",
  "guten morgen": "de", "guten abend": "de", "genau": "de",
  "ciao": "it", "buongiorno": "it", "grazie": "it", "perché": "it",
  "certo": "it", "capisco": "it", "per favore": "it", "esatto": "it",
  "buonasera": "it", "arrivederci": "it", "penso": "it", "va bene": "it",
  "olá": "pt", "obrigado": "pt", "obrigada": "pt", "sim": "pt",
  "por quê": "pt", "bom dia": "pt", "boa tarde": "pt", "entendo": "pt",
  "bon dia": "ca", "gràcies": "ca", "si us plau": "ca", "bona tarda": "ca",
  "adéu": "ca", "d'acord": "ca", "entenc": "ca",
};

/*
   Txt -> ____|__________________
         | stripDiacritics() | -> Txt
          -------------------
      Removes accents and apostrophes from a string so near-misses like
      "i dont know" match "i don't know" and "ola" matches "ol\u00e1".
*/
function stripDiacritics(s) {
  return s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/['']/g, "");
}
var SHORT_LANG_MAP_NORM = {};
for (var _k in SHORT_LANG_MAP) {
  SHORT_LANG_MAP_NORM[stripDiacritics(_k)] = SHORT_LANG_MAP[_k];
}

/*
   Txt -> ____|________________
         | detectLanguage() | -> Txt
          --------------------
      Returns the detected language code, preferring the curated short-text
      maps over tinyld, or "" for inputs shorter than two characters.
*/
function detectLanguage(text) {
  if (typeof text !== "string" || text.trim().length < 2) {
    return "";
  }
  var trimmed = text.trim();
  var lower = trimmed.toLowerCase();
  var normalized = stripDiacritics(lower);
  return SHORT_LANG_MAP[lower] || SHORT_LANG_MAP_NORM[normalized] || detect(trimmed) || "";
}

/*
   Txt -> ____|________________________
         | getLanguageInstruction() | -> Txt
          --------------------------
      Builds the system-prompt snippet telling the tutor to reply in the
      student's detected language, or "" when no language is recognized.
*/
function getLanguageInstruction(text) {
  var code = detectLanguage(text);
  if (!code) {
    return "";
  }
  var langName = LANG_NAMES[code];
  if (!langName) {
    return "";
  }
  return "\n\n[LANGUAGE INSTRUCTION]\nThe student is writing in " + langName +
    ". You MUST respond ONLY in " + langName + ".";
}

module.exports = { buildTutorSystemPrompt, getLanguageInstruction, detectLanguage };
