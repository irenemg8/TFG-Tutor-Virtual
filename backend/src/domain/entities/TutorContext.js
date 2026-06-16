"use strict";

/*------------------------------------------------------------------------------
            _________________________________________________________
            |                     TUTORCONTEXT                      |
            |  Value object representing the pedagogical context of  |
            |  an exercise: objective, netlist, expert solution and  |
            |  the AC / correct-answer / evaluable-element sets.     |
        ____|________________                                       |
   Obj -> | constructor() | -> TutorContext          (writes attrs) |
          -----------------                                         |
            |                                                       |
            |   objective: Txt        netlist: Txt                  |
            |   expertMode: Txt       acRefs: [Txt]                 |
            |   correctAnswer: [Txt]  evaluableElements: [Txt]      |
            |   version: Z                                          |
            |                                                       |
            |_______________________________________________________|
------------------------------------------------------------------------------*/
class TutorContext {
  /*
   Obj -> ____|________________
         | constructor() | -> TutorContext    (writes attributes objective (Txt),
          -----------------                    netlist (Txt), expertMode (Txt),
                                               acRefs ([Txt]), correctAnswer ([Txt]),
                                               evaluableElements ([Txt]), version (Z))
      Builds the context from a plain props object, defaulting every field
      so the tutor system prompt never receives undefined values.
  */
  constructor(props) {
    this.objective = props.objective || "";
    this.netlist = props.netlist || "";
    this.expertMode = props.expertMode || "";
    this.acRefs = props.acRefs || [];
    this.correctAnswer = props.correctAnswer || [];
    this.evaluableElements = props.evaluableElements || [];
    this.version = props.version || 1;
  }
}

module.exports = TutorContext;
