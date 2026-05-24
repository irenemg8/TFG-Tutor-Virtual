"use strict";

const ISecurityService = require("../../domain/ports/services/ISecurityService");
const debugLogger = require("../events/pipelineDebugLogger");

/**
 * Deterministic first-line defense against prompt injection and off-topic
 * requests. Regex + keyword based. No LLM calls, runs in <1 ms.
 *
 * Tuned for the electric-circuits tutoring domain (es/en/val).
 */

// --- Prompt injection patterns (role rewrite / instruction override) ---
const INJECTION_PATTERNS = [
  // "ignore previous instructions", "disregard", "override", "forget rules"
  { id: "ignore_rules",     re: /\b(ignor[ea]|disregard|forget|olvida|ignora|oblida)\b.{0,40}\b(previous|all|any|your|the|tus|tu|todas|totes|el|los|les)?.{0,15}\b(instruct|rules|rul|prompt|system|reglas|normas|instrucciones|instruccions|regles)/i },

  // "change your prompt / role / system / context"
  { id: "change_role",      re: /\b(change|cambia|canvia|modifica|reset[ea]?)\b.{0,25}\b(prompt|rol|role|system|sistema|contexto|context|behavior|comportamiento|comportament|personality|personalidad|personalitat)/i },

  // "now you are / act as / pretend to be / eres X / ets X"
  { id: "reassign_role",    re: /\b(now you are|pretend (to be|you are)|act as|you are now|a partir de ahora|desde ahora|now act|ara ets|ara actues)\b/i },
  { id: "reassign_role_es", re: /\b(ahora\s+(eres|actuas|actúas|vas a ser|ser[aá]s)|olvida tu rol|eres un [a-z])/i },

  // Fake system / developer turns
  { id: "fake_system",      re: /(^|\n)\s*(system|sistema|usuario|user|assistant|asistente|developer)\s*[:>]/i },

  // "reveal your prompt/instructions"
  { id: "reveal_prompt",    re: /\b(reveal|show|print|dime|muestrame|muéstrame|mostra|enseñame|enséñame)\b.{0,25}\b(system prompt|your prompt|the prompt|instructions|rules|tu prompt|tus instrucciones|les instruccions)/i },

  // "jailbreak / DAN / developer mode"
  { id: "jailbreak",        re: /\b(jailbreak|dan mode|developer mode|modo desarrollador|modo dev|sin restricciones|without restrictions|sense restriccions)\b/i },

  // Classic delimiter injection
  { id: "delimiter_inject", re: /(<\|[a-z_]+\|>|\[\[system\]\]|###\s*system|<system>|<\/?instructions>)/i },
];

// --- Off-topic patterns (things that are clearly NOT circuits) ---
// These trigger ONLY IF the message has no domain keyword.
const OFF_TOPIC_PATTERNS = [
  { id: "sports",   re: /\b(f[uú]tbol|soccer|basket(ball)?|baloncesto|tenis|golf|liga|champions|levante|barça|madrid|valencia cf|real madrid|atletico|atl[eé]tico|jugador(es)?|entrenador|equipo de f[uú]tbol|fifa|uefa|mundial)\b/i },
  { id: "politics", re: /\b(presidente|pol[ií]tica|gobierno|elecciones|partido pol[ií]tico|pp|psoe|vox|sumar|podemos|socialista|conservador|rajoy|s[aá]nchez|feij[oó]o|abascal)\b/i },
  { id: "cooking",  re: /\b(receta|cocina[rs]?|ingrediente|plato|cena|comida|pasta|paella|tortilla|paella valenciana)\b/i },
  { id: "media",    re: /\b(pel[ií]cul[ae]s?|pelis?|serie de tv|netflix|hbo|disney\+|youtube|tiktok|instagram|reel|sagas?|anime|manga)\b/i },
  { id: "coding",   re: /\b(programa(r|ci[oó]n)?|c[oó]digo|python|javascript|typescript|react|nodejs?|docker|kubernetes|sql|html|css)\b/i },
  { id: "chitchat", re: /\b(qu[eé]\s+tal\s+tu\s+d[ií]a|cu[eé]ntame un chiste|dime un chiste|tell me a joke|fes.?me un acudit|chistes?)\b/i },
];

// --- Domain keywords (circuits / electronics) ---
// If a message contains any of these, off-topic heuristics are suppressed.
const DOMAIN_KEYWORDS = /\b(circuit(o|os|s)?|resisten(te|cia|cies)|tensi[oó]n|voltaj(e|es)?|corriente|intensidad|amp?erio|amperaje|vol?tio|ohm(io|ios|s)?|nud(o|os|es)|nod(o|os|e|es)|rama(l|les)|mall[ae]s?|kirchhoff|ohm|cortocircuit(o|s)?|circuito abierto|circuit obert|paralel[oa]|serie|ley de ohm|ley de kirchhoff|r[1-9][0-9]?|n[1-9]|v[1-9]|i[1-9]|fuente|tierra|gnd|potencial|divisor|thevenin|norton|condensador|capacitor|inductor|impedancia|diodo|transistor|amplificador|operacional|filtr[oa]|pasa ?(bajos|altos|banda)|ca\b|cc\b|ac\b|dc\b|rms|pico|frecuencia|hercio|hertz|hz\b|watio|vatio|potencia|energ[ií]a|el[eé]ctric[oa]|electr[oó]nic[oa])/i;

// --- Redirect messages ---
const REDIRECT = {
  injection: {
    es:  "Centrémonos en el ejercicio de circuitos. Soy tu tutor y no puedo cambiar de rol ni de tema. ¿Seguimos con la pregunta anterior?",
    en:  "Let's stay focused on the circuit exercise. I'm your tutor and I can't switch role or topic. Shall we continue with the previous question?",
    val: "Centrem-nos en l'exercici de circuits. Soc el teu tutor i no puc canviar de rol ni de tema. Continuem amb la pregunta anterior?",
  },
  off_topic: {
    es:  "Este chat es solo para el ejercicio de circuitos. Si tienes una duda sobre el circuito o los conceptos (tensión, corriente, resistencia, nudos…), dímela.",
    en:  "This chat is only for the circuit exercise. If you have a question about the circuit or its concepts (voltage, current, resistance, nodes…), go ahead.",
    val: "Aquest xat és només per a l'exercici de circuits. Si tens un dubte sobre el circuit o els conceptes (tensió, corrent, resistència, nusos…), digues-m'ho.",
  },
};

class HeuristicSecurityAdapter extends ISecurityService {
  /**
   * @param {object} [deps]
   * @param {Function} [deps.logger] - optional (event, payload) logger
   */
  constructor(deps = {}) {
    super();
    this.logger = deps.logger || (() => {});
  }

  analyzeInput(userMessage, ctx = {}) {
    const lang = (ctx.lang || "es").toLowerCase();
    const text = (userMessage || "").trim();

    if (!text) {
      const safeResult = { safe: true, category: "safe" };
      debugLogger.logSecurity(userMessage, safeResult);
      return safeResult;
    }

    // 1) Prompt injection (highest priority)
    for (const p of INJECTION_PATTERNS) {
      if (p.re.test(text)) {
        const msg = REDIRECT.injection[lang] || REDIRECT.injection.es;
        this.logger("security.block", { category: "injection", patternId: p.id });
        const blockedResult = {
          safe: false,
          category: "injection",
          matchedPattern: p.id,
          redirectMessage: msg,
        };
        debugLogger.logSecurity(userMessage, blockedResult);
        return blockedResult;
      }
    }

    // 2) Off-topic: only if no domain keyword appears.
    const hasDomain = DOMAIN_KEYWORDS.test(text);
    if (!hasDomain) {
      for (const p of OFF_TOPIC_PATTERNS) {
        if (p.re.test(text)) {
          const msg = REDIRECT.off_topic[lang] || REDIRECT.off_topic.es;
          this.logger("security.block", { category: "off_topic", patternId: p.id });
          const blockedResult = {
            safe: false,
            category: "off_topic",
            matchedPattern: p.id,
            redirectMessage: msg,
          };
          debugLogger.logSecurity(userMessage, blockedResult);
          return blockedResult;
        }
      }
    }

    const safeResult = { safe: true, category: "safe" };
    debugLogger.logSecurity(userMessage, safeResult);
    return safeResult;
  }
}

module.exports = HeuristicSecurityAdapter;
