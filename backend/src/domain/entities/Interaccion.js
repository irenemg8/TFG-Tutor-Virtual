"use strict";

class Interaccion {
  /**
   * Represents a tutoring session (conversation) between a student and the tutor
   * for a specific exercise. Messages are stored separately via IMessageRepository.
   *
   * @param {object} props
   * @param {string}  props.id
   * @param {string}  props.userId
   * @param {string}  props.exerciseId
   * @param {Date}   [props.startTime]
   * @param {Date}   [props.endTime]
   * @param {Date}   [props.createdAt]
   */
  constructor(props) {
    this.id = props.id;
    this.userId = props.userId;
    this.exerciseId = props.exerciseId;
    this.startTime = props.startTime || new Date();
    this.endTime = props.endTime || new Date();
    this.createdAt = props.createdAt || null;
  }

  belongsToUser(userId) {
    return String(this.userId) === String(userId);
  }

  /**
   * JSON shape compatible with the legacy Mongo API consumed by the frontend
   * (`_id`, snake_case foreign keys). Domain code uses the class fields
   * directly; only serialization via res.json() uses this form.
   */
  toJSON() {
    return {
      _id: this.id,
      id: this.id,
      usuario_id: this.userId,
      ejercicio_id: this.exerciseId,
      inicio: this.startTime,
      fin: this.endTime,
      createdAt: this.createdAt,
    };
  }
}

module.exports = Interaccion;
