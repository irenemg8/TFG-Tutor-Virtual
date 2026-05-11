"use strict";

/**
 * Port interface for Ejercicio persistence.
 * Implementations: MongoEjercicioRepository, PgEjercicioRepository
 */
class IEjercicioRepository {
  /** @returns {Promise<import('../../entities/Ejercicio')>} */
  async findById(id) {
    throw new Error("Not implemented");
  }

  /** @returns {Promise<import('../../entities/Ejercicio')[]>} */
  async findAll() {
    throw new Error("Not implemented");
  }

  /** @returns {Promise<import('../../entities/Ejercicio')>} */
  async create(data) {
    throw new Error("Not implemented");
  }

  /** @returns {Promise<import('../../entities/Ejercicio')>} */
  async updateById(id, fields) {
    throw new Error("Not implemented");
  }

  /** @returns {Promise<void>} */
  async deleteById(id) {
    throw new Error("Not implemented");
  }

  /**
   * Find one exercise by concept (used for recommendations).
   * @returns {Promise<import('../../entities/Ejercicio')|null>}
   */
  async findOneByConcept(concept) {
    throw new Error("Not implemented");
  }

  /** @returns {Promise<import('../../entities/Ejercicio')[]>} */
  async findByIds(ids) {
    throw new Error("Not implemented");
  }
}

module.exports = IEjercicioRepository;
