"use strict";

/*------------------------------------------------------------------------------
            _________________________________________________________
            |                       RESULTADO                       |
            |  Domain entity holding the outcome of a finished       |
            |  tutoring session: counters, the AI analysis/advice    |
            |  and the list of detected AC errors.                   |
        ____|________________                                       |
   Obj -> | constructor() | -> Resultado            (writes attrs)  |
          -----------------                                         |
            |                                                       |
            |   id: Txt              userId: Txt                    |
            |   exerciseId: Txt      interactionId: Txt             |
            |   messageCount: Z      solvedOnFirstAttempt: T/F      |
            |   aiAnalysis: Txt|null aiAdvice: Txt | null           |
            |   date: Date           errors: [ErrorEntry]           |
        ____|___________                                            |
        | toJSON() | -> Obj                          (reads attrs)  |
        ------------                                                |
            |                                                       |
            |_______________________________________________________|
------------------------------------------------------------------------------*/
class Resultado {
  /*
   Obj -> ____|________________
         | constructor() | -> Resultado    (writes attributes id (Txt),
          -----------------                 userId (Txt), exerciseId (Txt),
                                            interactionId (Txt), messageCount (Z),
                                            solvedOnFirstAttempt (T/F), aiAnalysis (Txt|null),
                                            aiAdvice (Txt|null), date (Date), errors ([ErrorEntry]))
      Builds the result from a plain props object, wrapping each raw error
      into an ErrorEntry and defaulting counters and date.
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

  /*
       ____|___________
      | toJSON() | -> Obj    (reads attributes id (Txt), userId (Txt),
       ------------          exerciseId (Txt), interactionId (Txt),
                             messageCount (Z), solvedOnFirstAttempt (T/F),
                             aiAnalysis (Txt|null), aiAdvice (Txt|null),
                             date (Date), errors ([ErrorEntry]))
      Serializes to the legacy Mongo shape consumed by the frontend.
  */
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
