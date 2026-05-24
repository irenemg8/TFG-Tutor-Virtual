// In-memory BM25 keyword search over exercise datasets

const config = require("../llm/config");

// In-memory index: { exerciseNum: { docs, avgDl, idf } }
const indices = {};

// Tokenize text into lowercase words 
// example: "R1 y R2 dado que forman un divisor de tensión" 
// result: ["r1", "r2", "dado", "que", "forman", "un", "divisor", "de", "tensión"]
function tokenize(text) {
  return text
    .toLowerCase()                   // R1 -> r1
    .split(/[\s,;.!?()¿¡"]+/)        // [r1, y, r2, ...]
    .filter((t) => t.length > 1);    // deletes words of one character (y, a, e, i, o, u, ...)
}

// Build BM25 index for an exercise from its student-tutor pairs
function loadIndex(exerciseNum, pairs) {
  const docs = pairs.map((pair, i) => ({
    tokens: tokenize(pair.student),
    student: pair.student,
    tutor: pair.tutor,
    index: i,
  }));

/*------------------------------------------------------
  BM25 algorithm:
    IDF(t) = log((N - df + 0.5) / (df + 0.5) + 1)
    score(q, d) = Σ IDF(t) × (tf × (k1+1)) / (tf + k1 × (1 - b + b × dl/avgDl))
--------------------------------------------------------*/

  // Average document length (avgDl)
  let totalLen = 0;
  for (let i = 0; i < docs.length; i++) {
    totalLen += docs[i].tokens.length;
  }
  const avgDl = totalLen / docs.length;

  // IDF: log((N - df + 0.5) / (df + 0.5) + 1)
  const df = {};
  for (let i = 0; i < docs.length; i++) {
    const seen = new Set(docs[i].tokens);  // deletes duplicate tokens
    const unique = Array.from(seen);
    for (let j = 0; j < unique.length; j++) {
      df[unique[j]] = (df[unique[j]] || 0) + 1;
    }
  }

  const N = docs.length;
  const idf = {};
  const tokens = Object.keys(df);  // array of tokens
  for (let i = 0; i < tokens.length; i++) {
    const freq = df[tokens[i]];
    idf[tokens[i]] = Math.log((N - freq + 0.5) / (freq + 0.5) + 1);
  }
  indices[exerciseNum] = {docs, avgDl, idf}; 
}

// Score a single document against a query using BM25 -> Returns the score of the document
function scoreBM25(queryTokens, doc, avgDl, idf) {
  const {k1, b} = { k1: config.BM25_K1, b: config.BM25_B};
  let score = 0;

  // Term frequency map for the document
  const tf = {};
  for (let i = 0; i < doc.tokens.length; i++) {
    tf[doc.tokens[i]] = (tf[doc.tokens[i]] || 0) + 1;
  }

  for (let i = 0; i < queryTokens.length; i++) {
    if (tf[queryTokens[i]] != null) {
      const termIdf = idf[queryTokens[i]] || 0;
      const termTf = tf[queryTokens[i]];
      const dl = doc.tokens.length;
      const num = termTf * (k1 + 1);
      const den = termTf + k1 * (1 - b + b * (dl / avgDl));
      score += termIdf * (num / den);
    }
  }
  return score;
}

// Search an exercise index with BM25 -> Returns top results sorted by score (highest first)
function searchBM25(query, exerciseNum, topK = config.TOP_K_RETRIEVAL) {
  const index = indices[exerciseNum];
  if (index == null) {
    return [];
  }

  const queryTokens = tokenize(query);
  const scored = [];
  for (let i = 0; i < index.docs.length; i++) {
    scored.push({
      student: index.docs[i].student,
      tutor: index.docs[i].tutor,
      index: index.docs[i].index,
      score: scoreBM25(queryTokens, index.docs[i], index.avgDl, index.idf),
    });
  }

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, topK);
}

module.exports = { loadIndex, searchBM25, tokenize };
