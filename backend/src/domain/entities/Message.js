"use strict";

const MessageMetadata = require("./MessageMetadata");

/*------------------------------------------------------------------------------
            _________________________________________________________
            |                        MESSAGE                        |
            |  Value object representing a single message in a       |
            |  conversation. Replaces the embedded conversacion[]    |
            |  elements of the legacy Mongo document.                |
        ____|________________                                       |
   Obj -> | constructor() | -> Message              (writes attrs)  |
          -----------------                                         |
            |                                                       |
            |   id: Txt | null         interactionId: Txt           |
            |   sequenceNum: Z | null  role: Txt                    |
            |   content: Txt           timestamp: Date              |
            |   metadata: MessageMetadata | null                    |
        ____|___________                                            |
        | isUser() | -> T/F                          (reads attrs)  |
        -----------                                                 |
        ____|________________                                       |
        | isAssistant() | -> T/F                     (reads attrs)  |
        ----------------                                            |
        ____|____________________                                   |
        | toOllamaFormat() | -> Obj                  (reads attrs)  |
        --------------------                                        |
        ____|___________                                            |
        | toJSON() | -> Obj                          (reads attrs)  |
        ------------                                                |
            |                                                       |
            |_______________________________________________________|
------------------------------------------------------------------------------*/
class Message {
  /*
   Obj -> ____|________________
         | constructor() | -> Message    (writes attributes id (Txt|null),
          -----------------               interactionId (Txt), sequenceNum (Z|null),
                                          role (Txt), content (Txt), timestamp (Date),
                                          metadata (MessageMetadata|null))
      Builds the message from a plain props object. `role` is "user" or
      "assistant"; metadata is wrapped into a MessageMetadata when present.
  */
  constructor(props) {
    this.id = props.id || null;
    this.interactionId = props.interactionId;
    this.sequenceNum = props.sequenceNum ?? null;
    this.role = props.role;
    this.content = props.content;
    this.timestamp = props.timestamp || new Date();
    this.metadata = props.metadata ? new MessageMetadata(props.metadata) : null;
  }

  /*
       ____|___________
      | isUser() | -> T/F    (reads attribute role (Txt))
       -----------
      True when this message was authored by the student.
  */
  isUser() {
    return this.role === "user";
  }

  /*
       ____|________________
      | isAssistant() | -> T/F    (reads attribute role (Txt))
       ----------------
      True when this message was authored by the tutor.
  */
  isAssistant() {
    return this.role === "assistant";
  }

  /*
       ____|____________________
      | toOllamaFormat() | -> Obj    (reads attributes role (Txt), content (Txt))
       --------------------
      Returns the {role, content} shape consumed by the LLM chat API.
  */
  toOllamaFormat() {
    return { role: this.role, content: this.content };
  }

  /*
       ____|___________
      | toJSON() | -> Obj    (reads attributes id (Txt|null), role (Txt),
       ------------          content (Txt), timestamp (Date),
                             metadata (MessageMetadata|null))
      Serializes to the legacy Mongo shape used inside conversacion[].
  */
  toJSON() {
    return {
      _id: this.id,
      id: this.id,
      role: this.role,
      content: this.content,
      timestamp: this.timestamp,
      metadata: this.metadata,
    };
  }
}

module.exports = Message;
