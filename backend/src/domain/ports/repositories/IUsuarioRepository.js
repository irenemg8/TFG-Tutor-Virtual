"use strict";

/**
 * Port interface for Usuario persistence.
 * Implementations: MongoUsuarioRepository, PgUsuarioRepository
 */
class IUsuarioRepository {
  /** @returns {Promise<import('../../entities/Usuario')>} */
  async findById(id) {
    throw new Error("Not implemented");
  }

  /** @returns {Promise<import('../../entities/Usuario')|null>} */
  async findByUpvLogin(upvLogin) {
    throw new Error("Not implemented");
  }

  /**
   * Create or update a user by upvLogin (used by CAS authentication).
   * @param {string} upvLogin
   * @param {object} updateFields  - Fields to update if user exists
   * @param {object} insertFields  - Additional fields to set only on insert
   * @returns {Promise<import('../../entities/Usuario')>}
   */
  async upsertByUpvLogin(upvLogin, updateFields, insertFields) {
    throw new Error("Not implemented");
  }

  /** @returns {Promise<import('../../entities/Usuario')>} */
  async create(userData) {
    throw new Error("Not implemented");
  }

  /** @returns {Promise<import('../../entities/Usuario')>} */
  async updateById(id, fields) {
    throw new Error("Not implemented");
  }

  /** @returns {Promise<import('../../entities/Usuario')[]>} */
  async findAll() {
    throw new Error("Not implemented");
  }

  /** @returns {Promise<import('../../entities/Usuario')[]>} */
  async findByIds(ids) {
    throw new Error("Not implemented");
  }
}

module.exports = IUsuarioRepository;
