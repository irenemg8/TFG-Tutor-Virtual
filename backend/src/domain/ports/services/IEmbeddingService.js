"use strict";

/**
 * Port interface for text embedding generation.
 * Implementations: OllamaEmbeddingService (current)
 */
class IEmbeddingService {
  /**
   * Generate an embedding vector for a single text.
   * @param {string} text
   * @returns {Promise<number[]>}
   */
  async generateEmbedding(text) {
    throw new Error("Not implemented");
  }

  /**
   * Generate embedding vectors for multiple texts.
   * @param {string[]} texts
   * @returns {Promise<number[][]>}
   */
  async generateEmbeddings(texts) {
    throw new Error("Not implemented");
  }
}

module.exports = IEmbeddingService;
