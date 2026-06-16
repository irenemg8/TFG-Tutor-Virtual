"use strict";

/*------------------------------------------------------------------------------
            _________________________________________________________
            |                     AGENTINTERFACE                    |
            |  Base interface for every specialized agent in the    |
            |  tutoring pipeline. Each agent handles one phase and  |
            |  communicates through a shared AgentContext           |
            |  (blackboard pattern).                                |
        ____|________________                                       |
   Txt -> | constructor() | -> AgentInterface        (writes attrs) |
          -----------------                                         |
            |                                                       |
            |   name: Txt                                           |
        ____|_____________________________                          |
 AgentContext -> | execute() | -> Promise<void>      (reads attrs)  |
                 ------------                                        |
        ____|_____________________________                          |
 AgentContext -> | canSkip() | -> T/F                (reads attrs)  |
                 ------------                                        |
            |                                                       |
            |_______________________________________________________|
------------------------------------------------------------------------------*/
class AgentInterface {
  /*
   Txt -> ____|________________
         | constructor() | -> AgentInterface    (writes attribute name (Txt))
          -----------------
      Stores the unique agent name used for logging and monitoring.
  */
  constructor(name) {
    this.name = name;
  }

  /*
 AgentContext -> ____|___________
                | execute() | -> Promise<void>    (reads attribute name (Txt))
                 -----------
      Runs the agent's logic, reading from and writing to the context.
      Must be overridden by subclasses; throws here as a contract guard.
  */
  async execute(context) {
    throw new Error(`${this.name}.execute() not implemented`);
  }

  /*
 AgentContext -> ____|___________
                | canSkip() | -> T/F
                 -----------
      True when this agent can be skipped for the current context.
      Defaults to false; subclasses override with their own gate.
  */
  canSkip(context) {
    return false;
  }
}

module.exports = AgentInterface;
