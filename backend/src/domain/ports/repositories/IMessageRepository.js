"use strict";

/*------------------------------------------------------------------------------
            _________________________________________________________
            |                  IMESSAGEREPOSITORY                   |
            |  Port/interface defining the persistence contract for |
            |  conversation Messages. It is the KEY abstraction     |
            |  that decouples business logic from MongoDB's         |
            |  embedded conversacion[] array, letting a normalized   |
            |  Postgres messages table back the same contract.      |
            |  Adapters implement it; the methods here just throw.  |
            |                                                       |
        ____|____________________                                  |
   Txt, Message -> | appendMessage() | -> Promise<void>           |
                   -----------------                               |
        ____|______________________                                |
   Txt, N -> | getLastMessages() | -> Promise<[Message]>          |
             -------------------                                   |
        ____|_____________________                                 |
   Txt -> | getAllMessages() | -> Promise<[Message]>               |
          ------------------                                       |
        ____|______________________________                        |
   Txt, [Txt] -> | countConsecutiveFromEnd() | -> Promise<N>      |
                 ---------------------------                       |
        ____|____________________________                          |
   Txt -> | countAssistantMessages() | -> Promise<N>               |
          --------------------------                               |
        ____|______________________________                        |
   Txt, N -> | getLastAssistantMessages() | -> Promise<[Message]> |
             ----------------------------                          |
        ____|_____________________                                 |
   Txt -> | getLastMessage() | -> Promise<Message | null>          |
          ------------------                                       |
        ____|___________________________                           |
   Txt -> | getAcEvidenceByUserId() | -> Promise<Obj>              |
          -------------------------                                |
            |                                                       |
            |_______________________________________________________|
------------------------------------------------------------------------------*/
class IMessageRepository {
  /*
   Txt, Message -> ____|____________________
                  | appendMessage() | -> Promise<void>
                   -----------------
      Contract: append a message to a conversation. Mongo adapter does
      $push to conversacion[] plus $set fin; Postgres adapter INSERTs
      into messages with the next sequence_num. Abstract here.
  */
  async appendMessage(interaccionId, message) {
    throw new Error("Not implemented");
  }

  /*
   Txt, N -> ____|______________________
            | getLastMessages() | -> Promise<[Message]>
             -------------------
      Contract: load the last N messages for an interaccion. Mongo uses
      .slice("conversacion", -N); Postgres orders by sequence_num DESC,
      limits N, then reverses. Abstract here.
  */
  async getLastMessages(interaccionId, count) {
    throw new Error("Not implemented");
  }

  /*
   Txt -> ____|_____________________
         | getAllMessages() | -> Promise<[Message]>
          ------------------
      Contract: resolve every message for an interaccion (for export
      and finalize). Abstract here.
  */
  async getAllMessages(interaccionId) {
    throw new Error("Not implemented");
  }

  /*
   Txt, [Txt] -> ____|______________________________
                | countConsecutiveFromEnd() | -> Promise<N>
                 ---------------------------
      Contract: count consecutive messages from the end whose
      classification matches the given types. Used for wrong-streak
      detection (loop breaking). Abstract here.
  */
  async countConsecutiveFromEnd(interaccionId, classificationTypes) {
    throw new Error("Not implemented");
  }

  /*
   Txt -> ____|____________________________
         | countAssistantMessages() | -> Promise<N>
          --------------------------
      Contract: count the total assistant messages. Abstract here.
  */
  async countAssistantMessages(interaccionId) {
    throw new Error("Not implemented");
  }

  /*
   Txt, N -> ____|______________________________
            | getLastAssistantMessages() | -> Promise<[Message]>
             ----------------------------
      Contract: resolve the last N assistant messages (for tutor
      repetition detection). Abstract here.
  */
  async getLastAssistantMessages(interaccionId, count) {
    throw new Error("Not implemented");
  }

  /*
   Txt -> ____|_____________________
         | getLastMessage() | -> Promise<Message | null>
          ------------------
      Contract: resolve the last message of any role (for student
      response-time calculation), or null. Abstract here.
  */
  async getLastMessage(interaccionId) {
    throw new Error("Not implemented");
  }

  /*
   Txt -> ____|___________________________
         | getAcEvidenceByUserId() | -> Promise<Obj>
          -------------------------
      Contract: aggregate AC evidence (concept counts plus
      classification counts) across ALL of a user's interactions —
      open, closed or abandoned — so AcTrackerAgent can surface
      recurring misconceptions even when no final Resultado was
      persisted. Resolves { concepts, classifications }. Abstract here.
  */
  async getAcEvidenceByUserId(userId) {
    throw new Error("Not implemented");
  }
}

module.exports = IMessageRepository;
