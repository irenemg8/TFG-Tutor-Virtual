"use strict";

/**
 * Port interface for Resultado persistence.
 * Implementations: MongoResultadoRepository, PgResultadoRepository
 */
class IResultadoRepository {
  /** @returns {Promise<import('../../entities/Resultado')>} */
  async create(data) {
    throw new Error("Not implemented");
  }

  /**
   * Find all results for a user, sorted by date DESC.
   * @returns {Promise<import('../../entities/Resultado')[]>}
   */
  async findByUserId(userId) {
    throw new Error("Not implemented");
  }

  /**
   * Find results with joined exercise data (replaces .populate()).
   * Used by ProgresoService for dashboard.
   * @returns {Promise<Array<{resultado: import('../../entities/Resultado'), ejercicio: import('../../entities/Ejercicio')}>>}
   */
  async findByUserIdWithExercise(userId) {
    throw new Error("Not implemented");
  }

  /**
   * Get the list of exercise IDs that a user has completed.
   * @param {string} userId
   * @returns {Promise<string[]>}
   */
  async findCompletedExerciseIds(userId) {
    throw new Error("Not implemented");
  }

  /**
   * Find by filter (for export).
   * @returns {Promise<import('../../entities/Resultado')[]>}
   */
  async findByFilter(filter) {
    throw new Error("Not implemented");
  }

  /**
   * Get distinct error tags (labels) for a user's past interactions.
   * Used by RAG pipeline for student history.
   * @param {string} userId
   * @returns {Promise<string[]>}
   */
  async getErrorTagsByUserId(userId) {
    throw new Error("Not implemented");
  }
}

module.exports = IResultadoRepository;
