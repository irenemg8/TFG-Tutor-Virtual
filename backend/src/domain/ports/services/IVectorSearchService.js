"use strict";

/**
 * Port interface for vector similarity search.
 * Implementations: ChromaVectorSearchService (current)
 */
class IVectorSearchService {
  /**
   * Search for similar documents in a collection.
   * @param {number[]} queryEmbedding
   * @param {string} collectionName
   * @param {number} [topK]
   * @returns {Promise<Array<{id: string, content: string, score: number, metadata: object}>>}
   */
  async search(queryEmbedding, collectionName, topK) {
    throw new Error("Not implemented");
  }

  /**
   * Add documents to a collection.
   * @param {string} collectionName
   * @param {Array<{id: string, content: string, embedding: number[], metadata: object}>} data
   * @returns {Promise<void>}
   */
  async addDocuments(collectionName, data) {
    throw new Error("Not implemented");
  }
}

module.exports = IVectorSearchService;
