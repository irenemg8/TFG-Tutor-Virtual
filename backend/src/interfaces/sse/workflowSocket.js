// WebSocket server that broadcasts RAG pipeline events to workflow monitor clients
// Listens to ragEventBus and forwards all events to connected clients on /ws/workflow

const { WebSocketServer } = require("ws");
const ragBus = require("../../infrastructure/events/ragEventBus");

function setupWorkflowSocket(server) {
  const wss = new WebSocketServer({ server: server, path: "/ws/workflow" });

  ragBus.on("rag", function (event) {
    var msg = JSON.stringify(event);
    wss.clients.forEach(function (client) {
      if (client.readyState === 1) {
        client.send(msg);
      }
    });
  });

  wss.on("connection", function () {
    console.log("[Workflow] Monitor client connected");
  });

  console.log("[Workflow] WebSocket server ready on /ws/workflow");
}

module.exports = { setupWorkflowSocket };
