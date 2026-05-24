"use strict";

/**
 * Base interface for all specialized agents in the tutoring pipeline.
 * Each agent processes a specific phase of the tutoring interaction.
 *
 * Agents communicate through a shared AgentContext (blackboard pattern).
 */
class AgentInterface {
  /**
   * @param {string} name - Unique agent name for logging/monitoring
   */
  constructor(name) {
    this.name = name;
  }

  /**
   * Execute the agent's logic, reading from and writing to the context.
   * @param {import('./AgentContext')} context - Shared mutable context
   * @returns {Promise<void>}
   */
  async execute(context) {
    throw new Error(`${this.name}.execute() not implemented`);
  }

  /**
   * Determine whether this agent can be skipped for the current context.
   * @param {import('./AgentContext')} context
   * @returns {boolean}
   */
  canSkip(context) {
    return false;
  }
}

module.exports = AgentInterface;
