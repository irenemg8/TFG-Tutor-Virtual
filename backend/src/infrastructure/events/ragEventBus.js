/*------------------------------------------------------------------------------
            _________________________________________________________
            |                       RAGEVENTBUS                     |
            |  Singleton EventEmitter that broadcasts RAG pipeline   |
            |  events to the workflow monitor. Each event uses the   |
            |  envelope { requestId, timestamp, event, status, data }|
            |  and a module-level current request id correlates them.|
            |                                                       |
            |   Txt -> | setRequestId() | -> void                   |
            |          | getRequestId() | -> Txt | null             |
            |   Txt, Txt, Obj -> | emitEvent() | -> void            |
            |                                                       |
            |_______________________________________________________|
------------------------------------------------------------------------------*/

const { EventEmitter } = require("events");

const ragBus = new EventEmitter();
ragBus.setMaxListeners(20);

let currentRequestId = null;

/*
   Txt -> ____|_______________
         | setRequestId() | -> void
          ----------------
      Stores the current request id used to correlate emitted events.
      Safe because Node.js is single-threaded and each request is fully awaited.
*/
function setRequestId(id) {
  currentRequestId = id;
}

/*
       ____|_______________
      | getRequestId() | -> Txt | null
       ----------------
      Returns the current request id, or null when none is set.
*/
function getRequestId() {
  return currentRequestId;
}

/*
   Txt, Txt, Obj -> ____|____________
                   | emitEvent() | -> void
                    -------------
      Emits a "rag" event wrapped in the standard envelope, stamping it
      with the current request id and timestamp.
*/
function emitEvent(event, status, data) {
  ragBus.emit("rag", {
    requestId: currentRequestId,
    timestamp: Date.now(),
    event: event,
    status: status,
    data: data || {},
  });
}

module.exports = ragBus;
module.exports.setRequestId = setRequestId;
module.exports.getRequestId = getRequestId;
module.exports.emitEvent = emitEvent;
