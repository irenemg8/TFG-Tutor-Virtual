// Hybrid search: BM25 (keyword) + semantic (ChromaDB) combined with Reciprocal Rank Fusion (RRF)

const config = require("../llm/config");
const { generateEmbedding } = require("../vectordb/embeddings");
const { searchSemantic } = require("../vectordb/chromaClient");
const { searchBM25, tokenize } = require("./bm25");
const { emitEvent } = require("../events/ragEventBus");

/*----------------------------------------------------------------------------------------------
  Reciprocal Rank Fusion (RRF):
    score(doc) = 1/(K + rank_bm25) + 1/(K + rank_semantic)
  Combines two ranked lists into one, giving weight to documents that appear high in both lists
-----------------------------------------------------------------------------------------------*/

// Hybrid search for an exercise -> Returns top results sorted by combined score (highest first)
// `options.signal` propagates an AbortSignal to embedding + Chroma so the
// retrieval pipeline can be cut short when the per-stage budget elapses.
async function hybridSearch(query, exerciseNum, topK = config.TOP_K_FINAL, options) {
  options = options || {};
  const signal = options.signal || null;

  // 1. Generate query embedding for semantic search
  emitEvent("embedding_start", "start", { query: query, model: config.EMBEDDING_MODEL, ollamaUrl: config.OLLAMA_EMBED_URL });
  var embedStart = Date.now();
  const queryEmbedding = await generateEmbedding(query, signal ? { signal: signal } : undefined);
  emitEvent("embedding_end", "end", {
    vectorDimensions: queryEmbedding.length,
    durationMs: Date.now() - embedStart,
    sampleValues: queryEmbedding.slice(0, 5).map(function (v) { return Math.round(v * 10000) / 10000; }),
    norm: Math.round(Math.sqrt(queryEmbedding.reduce(function (s, v) { return s + v * v; }, 0)) * 10000) / 10000,
  });

  // 2. Run both searches
  const collectionName = "exercise_" + exerciseNum;
  var queryTokens = tokenize(query);
  emitEvent("bm25_search_start", "start", { query: query, exerciseNum: exerciseNum, topK: config.TOP_K_RETRIEVAL, k1: config.BM25_K1, b: config.BM25_B, formula: "IDF(t) × (tf×(k1+1)) / (tf + k1×(1-b+b×dl/avgDl))", queryTokens: queryTokens, tokenCount: queryTokens.length });
  const bm25Results = searchBM25(query, exerciseNum);
  emitEvent("bm25_search_end", "end", {
    resultCount: bm25Results.length,
    topScore: bm25Results.length > 0 ? Math.round(bm25Results[0].score * 10000) / 10000 : 0,
    queryTokens: queryTokens,
    results: bm25Results.map(function (r, i) {
      return {
        rank: i + 1,
        index: r.index,
        score: Math.round(r.score * 10000) / 10000,
        student: r.student || "",
        tutor: r.tutor || "",
      };
    }),
  });

  emitEvent("semantic_search_start", "start", { collectionName: collectionName, topK: config.TOP_K_RETRIEVAL, embeddingDim: queryEmbedding.length, distanceMetric: "cosine", scoreFormula: "1 - cosine_distance" });
  const semanticResults = await searchSemantic(
    queryEmbedding,
    collectionName,
    config.TOP_K_RETRIEVAL,
    signal ? { signal: signal } : undefined
  );
  emitEvent("semantic_search_end", "end", {
    resultCount: semanticResults.length,
    topScore: semanticResults.length > 0 ? Math.round(semanticResults[0].score * 10000) / 10000 : 0,
    results: semanticResults.map(function (r, i) {
      return {
        rank: i + 1,
        id: r.id,
        score: Math.round(r.score * 10000) / 10000,
        document: r.document || "",
        tutorResponse: (r.metadata && r.metadata.tutor_response) || "",
      };
    }),
  });

  // 3. Build RRF score map using document index as key
  emitEvent("rrf_fusion_start", "start", { bm25Count: bm25Results.length, semanticCount: semanticResults.length, RRF_K: config.RRF_K, TOP_K_FINAL: topK, formula: "score(doc) = 1/(K+rank_bm25) + 1/(K+rank_semantic)" });
  const rrfScores = {};
  const rrfBreakdown = {}; // Track per-document RRF components

  // Add BM25 ranks
  for (let i = 0; i < bm25Results.length; i++) {
    const key = bm25Results[i].index;
    if (rrfScores[key] == null) {
      rrfScores[key] = {
        student: bm25Results[i].student,
        tutor: bm25Results[i].tutor,
        index: key,
        score: 0,
      };
      rrfBreakdown[key] = { bm25Rank: null, semanticRank: null, bm25Component: 0, semanticComponent: 0, bm25Score: 0, semanticScore: 0 };
    }
    var bm25Component = 1 / (config.RRF_K + i + 1);
    rrfScores[key].score += bm25Component;
    rrfBreakdown[key].bm25Rank = i + 1;
    rrfBreakdown[key].bm25Component = Math.round(bm25Component * 10000) / 10000;
    rrfBreakdown[key].bm25Score = Math.round(bm25Results[i].score * 10000) / 10000;
  }

  // Add semantic ranks
  for (let i = 0; i < semanticResults.length; i++) {
    // The semantic result id format is "ex{num}_{index}"
    const parts = semanticResults[i].id.split("_");
    const key = Number(parts[1]);
    if (rrfScores[key] == null) {
      rrfScores[key] = {
        student: semanticResults[i].document,
        tutor: semanticResults[i].metadata.tutor_response,
        index: key,
        score: 0,
      };
      rrfBreakdown[key] = { bm25Rank: null, semanticRank: null, bm25Component: 0, semanticComponent: 0, bm25Score: 0, semanticScore: 0 };
    }
    var semComponent = 1 / (config.RRF_K + i + 1);
    rrfScores[key].score += semComponent;
    rrfBreakdown[key].semanticRank = i + 1;
    rrfBreakdown[key].semanticComponent = Math.round(semComponent * 10000) / 10000;
    rrfBreakdown[key].semanticScore = Math.round(semanticResults[i].score * 10000) / 10000;
  }

  // 4. Sort by the combined score and return top results
  const keys = Object.keys(rrfScores);
  const results = [];
  for (let i = 0; i < keys.length; i++) {
    results.push(rrfScores[keys[i]]);
  }

  results.sort((a, b) => b.score - a.score);
  var finalResults = results.slice(0, topK);
  emitEvent("rrf_fusion_end", "end", {
    resultCount: finalResults.length,
    totalCandidates: results.length,
    topScore: finalResults.length > 0 ? Math.round(finalResults[0].score * 10000) / 10000 : 0,
    formula: "score(doc) = 1/(K+rank_bm25) + 1/(K+rank_semantic), K=" + config.RRF_K,
    results: finalResults.map(function (r, i) {
      var bd = rrfBreakdown[r.index] || {};
      return {
        rank: i + 1,
        index: r.index,
        combinedScore: Math.round(r.score * 10000) / 10000,
        bm25Rank: bd.bm25Rank,
        bm25OriginalScore: bd.bm25Score,
        bm25RRFComponent: bd.bm25Component,
        semanticRank: bd.semanticRank,
        semanticOriginalScore: bd.semanticScore,
        semanticRRFComponent: bd.semanticComponent,
        student: r.student || "",
        tutor: r.tutor || "",
      };
    }),
  });
  return finalResults;
}

module.exports = { hybridSearch };
