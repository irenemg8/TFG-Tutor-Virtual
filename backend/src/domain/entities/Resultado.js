"use strict";

class Resultado {
  /**
   * @param {object} props
   * @param {string}    props.id
   * @param {string}    props.userId
   * @param {string}    props.exerciseId
   * @param {string}    props.interactionId
   * @param {number}   [props.messageCount]
   * @param {boolean}  [props.solvedOnFirstAttempt]
   * @param {string}   [props.aiAnalysis]
   * @param {string}   [props.aiAdvice]
   * @param {Date}     [props.date]
   * @param {Array}    [props.errors]
   */
  constructor(props) {
    this.id = props.id;
    this.userId = props.userId;
    this.exerciseId = props.exerciseId;
    this.interactionId = props.interactionId;
    this.messageCount = props.messageCount || 0;
    this.solvedOnFirstAttempt = props.solvedOnFirstAttempt || false;
    this.aiAnalysis = props.aiAnalysis || null;
    this.aiAdvice = props.aiAdvice || null;
    this.date = props.date || new Date();
    this.errors = (props.errors || []).map(
      (e) => new (require("./ErrorEntry"))(e)
    );
  }

  /** Legacy Mongo JSON shape for frontend compat. */
  toJSON() {
    return {
      _id: this.id,
      id: this.id,
      usuario_id: this.userId,
      ejercicio_id: this.exerciseId,
      interaccion_id: this.interactionId,
      numMensajes: this.messageCount,
      resueltoALaPrimera: this.solvedOnFirstAttempt,
      analisisIA: this.aiAnalysis,
      consejoIA: this.aiAdvice,
      fecha: this.date,
      errores: this.errors,
    };
  }
}

module.exports = Resultado;
