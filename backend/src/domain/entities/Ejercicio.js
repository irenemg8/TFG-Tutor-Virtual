"use strict";

const TutorContext = require("./TutorContext");

/*------------------------------------------------------------------------------
            _________________________________________________________
            |                        EJERCICIO                      |
            |  Domain entity. Holds the statement, metadata and the |
            |  tutor context of a single exercise, and exposes the  |
            |  derived values the tutoring pipeline needs.          |
        ____|________________                                       |
   Obj -> | constructor() | -> Ejercicio        (writes attrs)      |
          -----------------                                         |
            |                                                       |
            |   id: Txt            title: Txt        statement: Txt |
            |   image: Txt         subject: Txt      concept: Txt   |
            |   level: Z           ac: Txt                          |
            |   tutorContext: TutorContext | null                   |
            |   createdAt: Date    updatedAt: Date                  |
        ____|_____________________                                  |
        | getCorrectAnswer() | -> [Txt]          (reads attrs)      |
        ----------------------                                      |
        ____|_________________________                              |
        | getEvaluableElements() | -> [Txt]      (reads attrs)      |
        --------------------------                                  |
        ____|_______________________                                |
        | getExerciseNumber() | -> Z | null      (reads attrs)      |
        -----------------------                                     |
        ____|__________________________                             |
        | hasValidTutorContext() | -> T/F        (reads attrs)      |
        --------------------------                                  |
        ____|___________                                            |
        | toJSON() | -> Obj                       (reads attrs)     |
        ------------                                                |
            |                                                       |
            |_______________________________________________________|
------------------------------------------------------------------------------*/
class Ejercicio {
  /*
   Obj -> ____|________________
         | constructor() | -> Ejercicio    (writes attributes id (Txt), title (Txt),
          -----------------                 statement (Txt), image (Txt), subject (Txt),
                                            concept (Txt), level (Z), ac (Txt),
                                            tutorContext (Obj), createdAt (Date), updatedAt (Date))
      Builds the entity from a plain props object. Wraps the raw
      tutorContext into a TutorContext, and defaults image/ac/dates.
  */
  constructor(props) {
    this.id = props.id;
    this.title = props.title;
    this.statement = props.statement;
    this.image = props.image || "";
    this.subject = props.subject;
    this.concept = props.concept;
    this.level = props.level;
    this.ac = props.ac || "";
    this.tutorContext = props.tutorContext
      ? new TutorContext(props.tutorContext)
      : null;
    this.createdAt = props.createdAt || new Date();
    this.updatedAt = props.updatedAt || new Date();
  }

  /*
       ____|_____________________
      | getCorrectAnswer() | -> [Txt]    (reads attribute tutorContext (Obj))
       ----------------------
      Returns the configured correct-answer list, or [] when there
      is no tutor context.
  */
  getCorrectAnswer() {
    return this.tutorContext?.correctAnswer || [];
  }

  /*
       ____|_________________________
      | getEvaluableElements() | -> [Txt]    (reads attribute tutorContext (Obj))
       --------------------------
      Returns the list of evaluable elements. When the stored list is
      empty (legacy rows), it derives the set from the netlist and
      unions it with the correct answer so the pipeline never sees [].
  */
  getEvaluableElements() {
    const explicit = this.tutorContext?.evaluableElements || [];
    if (explicit.length > 0) return explicit;
    const netlist = this.tutorContext?.netlist || "";
    const out = [];
    const push = (x) => { const u = String(x).toUpperCase(); if (u && out.indexOf(u) < 0) out.push(u); };
    (netlist.match(/R\d+/gi) || []).forEach(push);
    (this.getCorrectAnswer() || []).forEach(push);
    return out;
  }

  /*
       ____|_______________________
      | getExerciseNumber() | -> Z | null    (reads attributes title (Txt) and image (Txt))
       -----------------------
      Extracts the exercise number from the title, falling back to the
      image path convention "EjercicioN.jpg". Returns null when absent.
  */
  getExerciseNumber() {
    const fromTitle = this.title?.match(/\d+/);
    if (fromTitle) return parseInt(fromTitle[0], 10);
    const fromImage = this.image?.match(/Ejercicio(\d+)/i);
    if (fromImage) return parseInt(fromImage[1], 10);
    return null;
  }

  /*
       ____|__________________________
      | hasValidTutorContext() | -> T/F      (reads attribute tutorContext (Obj))
       --------------------------
      True only when the tutor context is present and its objective,
      netlist and expertMode pass the minimum-length thresholds that
      guard against historic empty-seed data poisoning.
  */
  hasValidTutorContext() {
    if (this.tutorContext === null) return false;
    if (this.getCorrectAnswer().length === 0) return false;
    const objective = (this.tutorContext.objective || "").trim();
    const netlist = (this.tutorContext.netlist || "").trim();
    const expertMode = (this.tutorContext.expertMode || "").trim();
    if (objective.length < 30) return false;
    if (netlist.length < 10) return false;
    if (expertMode.length < 50) return false;
    return true;
  }

  /*
       ____|___________
      | toJSON() | -> Obj    (reads attributes id (Txt), title (Txt), statement (Txt),
       ------------          image (Txt), subject (Txt), concept (Txt), level (Z),
                             ac (Txt), tutorContext (Obj), createdAt (Date), updatedAt (Date))
      Serializes to the legacy Mongo-compatible shape consumed by the
      frontend: emits `_id` and keeps `tutorContext` in camelCase.
  */
  toJSON() {
    return {
      _id: this.id,
      id: this.id,
      titulo: this.title,
      enunciado: this.statement,
      imagen: this.image,
      asignatura: this.subject,
      concepto: this.concept,
      nivel: this.level,
      CA: this.ac,
      tutorContext: this.tutorContext,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
    };
  }
}

module.exports = Ejercicio;
