// Singleton EventEmitter for broadcasting RAG pipeline events to the workflow monitor
// Each event follows the envelope: { requestId, timestamp, event, status, data }

const { EventEmitter } = require("events");

const ragBus = new EventEmitter();
ragBus.setMaxListeners(20);

// Module-level request ID tracking (safe because Node.js is single-threaded
// and the pipeline is fully awaited within each request)
let currentRequestId = null;

function setRequestId(id) {
  currentRequestId = id;
}

function getRequestId() {
  return currentRequestId;
}

// Helper to emit a pipeline event with the standard envelope
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
