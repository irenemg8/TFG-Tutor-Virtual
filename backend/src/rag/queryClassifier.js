/*------------------------------------------------------------------------------
            _________________________________________________________
            |                    QUERY CLASSIFIER                    |
            |  Rule-based classifier for student messages (no LLM).  |
            |  Detects greetings, "don't know" answers and resistance |
            |  selections, scoring them as right/wrong with or        |
            |  without reasoning. LEGACY duplicate kept under         |
            |  src/rag/ for A/B testing against the hexagonal version.|
        ____|________________________________                       |
   Txt,[Txt] -> | classifyQuery() | -> Obj                          |
                -------------------                                  |
        ____|_________________________                              |
   Txt -> | extractResistances() | -> [Txt]                         |
          ------------------------                                  |
            |                                                       |
            |_______________________________________________________|
------------------------------------------------------------------------------*/

const types = {
  greeting: "greeting",
  dontKnow: "dont_know",
  singleWord: "single_word",
  wrongAnswer: "wrong_answer",
  correctNoReasoning: "correct_no_reasoning",
  correctWrongReasoning: "correct_wrong_reasoning",
  correctGoodReasoning: "correct_good_reasoning",
  wrongConcept: "wrong_concept",
};

const greetingPatterns = [
  "hola", "buenos días", "buenas tardes", "buenas noches", "qué tal", "buenas",
  "hello", "hi", "hey", "good morning", "good afternoon", "good evening",
  "bonjour", "salut", "bonsoir",
  "bon dia", "bona tarda", "bona nit",
];
const dontKnowPatterns = [
  "no lo sé", "no sé", "ni idea", "no tengo ni idea", "no tengo idea", "yo qué sé",
  "i don't know", "i dont know", "no idea", "no clue", "i have no idea",
  "je ne sais pas", "je sais pas", "aucune idée",
  "no ho sé", "no sé", "ni idea",
];
const reasoningPatterns = ["dado que", "porque", "ya que", "debido a", "puesto que", "por eso", "por lo que"];

const conceptKeywords = [
  "divisor de tensión", "divisor de corriente",
  "serie", "paralelo",
  "cortocircuito", "cortocircuitada", "cortocircuitado", "corto",
  "circuito abierto", "abierto", "abierta",
  "se consume", "se gasta", "atenuación",
  "interruptor cerrado", "interruptor abierto",
];

/*
   Txt -> ____|_____________________
         | extractResistances() | -> [Txt]
          ------------------------
      Extracts resistance names (R1, r2, ...) from a message, uppercased
      and de-duplicated, returning a list like ["R1", "R2", "R4"].
*/
function extractResistances(message) {
  const matches = message.match(/R\d+/gi);

  if (matches == null) {
    return [];
  }

  const unique = [];
  const seen = {};
  for (let i = 0; i < matches.length; i++) {
    const r = matches[i].toUpperCase();
    if (seen[r] == null) {
      seen[r] = true;
      unique.push(r);
    }
  }
  return unique;
}

/*
   [Txt],[Txt] -> ____|__________
                 | sameSet() | -> T/F
                  -----------
      True when both arrays hold the same elements regardless of order.
*/
function sameSet(a, b) {
  if (a.length !== b.length) {
    return false;
  }
  const sorted1 = a.slice().sort();
  const sorted2 = b.slice().sort();
  for (let i = 0; i < sorted1.length; i++) {
    if (sorted1[i] !== sorted2[i]) {
      return false;
    }
  }
  return true;
}

/*
   Txt -> ____|______________
         | hasReasoning() | -> T/F
          ----------------
      True when the message contains any reasoning keyword.
*/
function hasReasoning(message) {
  const lower = message.toLowerCase();
  for (let i = 0; i < reasoningPatterns.length; i++) {
    if (lower.includes(reasoningPatterns[i])) {
      return true;
    }
  }
  return false;
}

/*
   Txt -> ____|______________
         | findConcepts() | -> [Txt]
          ----------------
      Returns the list of concept keywords that appear in the message.
*/
function findConcepts(message) {
  const lower = message.toLowerCase();
  const found = [];
  for (let i = 0; i < conceptKeywords.length; i++) {
    if (lower.includes(conceptKeywords[i])) {
      found.push(conceptKeywords[i]);
    }
  }
  return found;
}

/*
   Txt -> ____|____________
         | isGreeting() | -> T/F
          --------------
      True when the trimmed message starts with a greeting pattern.
*/
function isGreeting(message) {
  const lower = message.toLowerCase().trim();
  for (let i = 0; i < greetingPatterns.length; i++) {
    if (lower.startsWith(greetingPatterns[i])) {
      return true;
    }
  }
  return false;
}

/*
   Txt -> ____|____________
         | isDontKnow() | -> T/F
          --------------
      True when the message expresses an "I don't know" answer.
*/
function isDontKnow(message) {
  const lower = message.toLowerCase();
  for (let i = 0; i < dontKnowPatterns.length; i++) {
    if (lower.includes(dontKnowPatterns[i])) {
      return true;
    }
  }
  return false;
}

/*
   Txt,[Txt] -> ____|_________________
               | classifyQuery() | -> Obj
                -------------------
      Classifies a student message against the correct-answer resistance
      list and returns { type, resistances, hasReasoning, concepts }.
*/
function classifyQuery(userMessage, correctAnswer) {
  const resistances = extractResistances(userMessage);
  const reasoning = hasReasoning(userMessage);
  const concepts = findConcepts(userMessage);

  if (isGreeting(userMessage)) {
    return { type: types.greeting, resistances: resistances, hasReasoning: reasoning, concepts: concepts };
  }

  if (isDontKnow(userMessage)) {
    return { type: types.dontKnow, resistances: resistances, hasReasoning: reasoning, concepts: concepts };
  }

  if (userMessage.trim().length < 15 && resistances.length === 0) {
    return { type: types.singleWord, resistances: resistances, hasReasoning: reasoning, concepts: concepts };
  }

  if (sameSet(resistances, correctAnswer)) {
    if (!reasoning) {
      return { type: types.correctNoReasoning, resistances: resistances, hasReasoning: reasoning, concepts: concepts };
    }
    if (concepts.length > 0) {
      return { type: types.correctWrongReasoning, resistances: resistances, hasReasoning: reasoning, concepts: concepts };
    }
    return { type: types.correctGoodReasoning, resistances: resistances, hasReasoning: reasoning, concepts: concepts };
  }

  if (concepts.length > 0) {
    return { type: types.wrongConcept, resistances: resistances, hasReasoning: reasoning, concepts: concepts };
  }

  return { type: types.wrongAnswer, resistances: resistances, hasReasoning: reasoning, concepts: concepts };
}

module.exports = { classifyQuery, extractResistances, types };
