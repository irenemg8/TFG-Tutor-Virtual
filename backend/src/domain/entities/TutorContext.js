"use strict";

class TutorContext {
  /**
   * Value object representing the pedagogical context of an exercise.
   * @param {object} props
   * @param {string}   [props.objective]
   * @param {string}   [props.netlist]
   * @param {string}   [props.expertMode]
   * @param {string[]} [props.acRefs]
   * @param {string[]} [props.correctAnswer]
   * @param {string[]} [props.evaluableElements]
   * @param {number}   [props.version]
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
