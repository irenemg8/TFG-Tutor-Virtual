"use strict";

/*------------------------------------------------------------------------------
            _________________________________________________________
            |                  ISECURITYSERVICE                     |
            |  Port/interface defining the contract for screening   |
            |  the student's raw input before the tutoring pipeline |
            |  processes it. Guards against two threats: prompt     |
            |  injection (rewriting/overriding the tutor's role)    |
            |  and off-topic requests (unrelated to electric        |
            |  circuits). Adapters: HeuristicSecurityAdapter        |
            |  (regex + keyword, deterministic) and a future        |
            |  LlmSecurityAdapter. The method here just throws.     |
            |                                                       |
        ____|_____________________                                 |
   Txt, Obj -> | analyzeInput() | -> Obj                          |
              ----------------                                     |
            |                                                       |
            |_______________________________________________________|
------------------------------------------------------------------------------*/
class ISecurityService {
  /*
   Txt, Obj -> ____|_____________________
              | analyzeInput() | -> Obj
               ----------------
      Contract: analyze the raw student input against ctx (lang,
      optional exercise, optional evaluableElements) and return a
      SecurityAnalysis object: { safe (T/F), category
      ("safe"|"injection"|"off_topic"), matchedPattern? (Txt, for
      debug/logging), redirectMessage? (Txt, localized student
      message) }. Abstract here.
  */
  analyzeInput(userMessage, ctx) {
    throw new Error("ISecurityService.analyzeInput not implemented");
  }
}

module.exports = ISecurityService;
