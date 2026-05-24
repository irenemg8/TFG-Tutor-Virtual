"use strict";

class ErrorEntry {
  /**
   * Value object for an Alternative Conception (AC) error detected in a student's interaction.
   * Replaces the embedded errores[] array in MongoDB's Resultado.
   *
   * @param {object} props
   * @param {string} [props.id]
   * @param {string}  props.label  - AC identifier (e.g. "AC13", "AC_UNK")
   * @param {string}  props.text   - Human-readable error description
   */
  constructor(props) {
    this.id = props.id || null;
    this.label = props.label;
    this.text = props.text;
  }

  /** Legacy Mongo JSON shape for frontend compat (Resultado.errores items). */
  toJSON() {
    return {
      id: this.id,
      etiqueta: this.label,
      texto: this.text,
    };
  }
}

module.exports = ErrorEntry;
