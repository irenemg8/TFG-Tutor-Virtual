"use strict";

class Interaccion {
  /**
   * Represents a tutoring session (conversation) between a student and the tutor
   * for a specific exercise. Messages are stored separately via IMessageRepository.
   *
   * @param {object} props
   * @param {string}  props.id
   * @param {string}  props.usuarioId
   * @param {string}  props.ejercicioId
   * @param {Date}   [props.inicio]
   * @param {Date}   [props.fin]
   * @param {Date}   [props.createdAt]
   */
  constructor(props) {
    this.id = props.id;
    this.usuarioId = props.usuarioId;
    this.ejercicioId = props.ejercicioId;
    this.inicio = props.inicio || new Date();
    this.fin = props.fin || new Date();
    this.createdAt = props.createdAt || null;
  }

  belongsTo(userId) {
    return String(this.usuarioId) === String(userId);
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
      usuario_id: this.usuarioId,
      ejercicio_id: this.ejercicioId,
      inicio: this.inicio,
      fin: this.fin,
      createdAt: this.createdAt,
    };
  }
}

module.exports = Interaccion;
