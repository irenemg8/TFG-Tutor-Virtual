"use strict";

/*------------------------------------------------------------------------------
            _________________________________________________________
            |                       ERRORENTRY                      |
            |  Value object for an Alternative Conception (AC) error |
            |  detected in a student interaction. Replaces the       |
            |  embedded errores[] array of the legacy Mongo Resultado.|
        ____|________________                                       |
   Obj -> | constructor() | -> ErrorEntry           (writes attrs)  |
          -----------------                                         |
            |                                                       |
            |   id: Txt | null                                      |
            |   label: Txt                                          |
            |   text: Txt                                           |
        ____|___________                                            |
        | toJSON() | -> Obj                          (reads attrs)  |
        ------------                                                |
            |                                                       |
            |_______________________________________________________|
------------------------------------------------------------------------------*/
class ErrorEntry {
  /*
   Obj -> ____|________________
         | constructor() | -> ErrorEntry    (writes attributes id (Txt|null),
          -----------------                  label (Txt), text (Txt))
      Builds the value object from a plain props object. `label` is the AC
      identifier (e.g. "AC13", "AC_UNK") and `text` its readable description.
  */
  constructor(props) {
    this.id = props.id || null;
    this.label = props.label;
    this.text = props.text;
  }

  /*
       ____|___________
      | toJSON() | -> Obj    (reads attributes id (Txt|null), label (Txt), text (Txt))
       ------------
      Serializes to the legacy Mongo shape used inside Resultado.errores[].
  */
  toJSON() {
    return {
      id: this.id,
      etiqueta: this.label,
      texto: this.text,
    };
  }
}

module.exports = ErrorEntry;
