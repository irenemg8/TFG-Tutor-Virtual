"use strict";

class Resultado {
  /**
   * @param {object} props
   * @param {string}    props.id
   * @param {string}    props.usuarioId
   * @param {string}    props.ejercicioId
   * @param {string}    props.interaccionId
   * @param {number}   [props.numMensajes]
   * @param {boolean}  [props.resueltoALaPrimera]
   * @param {string}   [props.analisisIA]
   * @param {string}   [props.consejoIA]
   * @param {Date}     [props.fecha]
   * @param {Array}    [props.errores]
   */
  constructor(props) {
    this.id = props.id;
    this.usuarioId = props.usuarioId;
    this.ejercicioId = props.ejercicioId;
    this.interaccionId = props.interaccionId;
    this.numMensajes = props.numMensajes || 0;
    this.resueltoALaPrimera = props.resueltoALaPrimera || false;
    this.analisisIA = props.analisisIA || null;
    this.consejoIA = props.consejoIA || null;
    this.fecha = props.fecha || new Date();
    this.errores = (props.errores || []).map(
      (e) => new (require("./ErrorEntry"))(e)
    );
  }

  /** Legacy Mongo JSON shape for frontend compat. */
  toJSON() {
    return {
      _id: this.id,
      id: this.id,
      usuario_id: this.usuarioId,
      ejercicio_id: this.ejercicioId,
      interaccion_id: this.interaccionId,
      numMensajes: this.numMensajes,
      resueltoALaPrimera: this.resueltoALaPrimera,
      analisisIA: this.analisisIA,
      consejoIA: this.consejoIA,
      fecha: this.fecha,
      errores: this.errores,
    };
  }
}

module.exports = Resultado;
