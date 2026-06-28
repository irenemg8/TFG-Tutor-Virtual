"use strict";

/*------------------------------------------------------------------------------
            _________________________________________________________
            |                      INTERACCION                      |
            |  Represents a tutoring session (conversation) between  |
            |  a student and the tutor for a specific exercise.      |
            |  Messages are stored separately via IMessageRepository.|
        ____|________________                                       |
   Obj -> | constructor() | -> Interaccion          (writes attrs)  |
          -----------------                                         |
            |                                                       |
            |   id: Txt            userId: Txt                      |
            |   exerciseId: Txt    createdAt: Date | null           |
            |   startTime: Date    endTime: Date                    |
        ____|________________                                       |
   Txt -> | belongsToUser() | -> T/F                (reads attrs)   |
          -----------------                                         |
        ____|___________                                            |
        | toJSON() | -> Obj                          (reads attrs)  |
        ------------                                                |
            |                                                       |
            |_______________________________________________________|
------------------------------------------------------------------------------*/
class Interaccion {
  /*
   Obj -> ____|________________
         | constructor() | -> Interaccion    (writes attributes id (Txt),
          -----------------                   userId (Txt), exerciseId (Txt),
                                              startTime (Date), endTime (Date),
                                              createdAt (Date|null))
      Builds the session entity from a plain props object, defaulting the
      timestamps when absent.
  */
  constructor(props) {
    this.id = props.id;
    this.userId = props.userId;
    this.exerciseId = props.exerciseId;
    this.startTime = props.startTime || new Date();
    this.endTime = props.endTime || new Date();
    this.createdAt = props.createdAt || null;
  }

  /*
   Txt -> ____|________________
         | belongsToUser() | -> T/F    (reads attribute userId (Txt))
          -----------------
      True when the given userId owns this session (string-compared).
  */
  belongsToUser(userId) {
    return String(this.userId) === String(userId);
  }

  /*
       ____|___________
      | toJSON() | -> Obj    (reads attributes id (Txt), userId (Txt),
       ------------          exerciseId (Txt), startTime (Date),
                             endTime (Date), createdAt (Date|null))
      Serializes to the legacy Mongo shape (`_id`, snake_case foreign keys)
      consumed by the frontend.
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
