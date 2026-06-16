const { WebSocketServer } = require("ws");
const ragBus = require("../../infrastructure/events/ragEventBus");

/*------------------------------------------------------------------------------
            _________________________________________________________
            |                     WORKFLOW SOCKET                   |
            |  WebSocket module that broadcasts RAG pipeline events |
            |  to the workflow-monitor clients. Subscribes to the   |
            |  ragEventBus and forwards every event to all sockets  |
            |  connected on /ws/workflow.                           |
        ____|________________________                               |
   Obj -> | setupWorkflowSocket() | -> void          (attaches wss)  |
          -------------------------                                  |
            |                                                       |
            |_______________________________________________________|
------------------------------------------------------------------------------*/

/*
 Obj -> ____|________________________
       | setupWorkflowSocket() | -> void
        -------------------------
    Attaches a WebSocketServer at /ws/workflow on the given HTTP server,
    relaying every ragEventBus "rag" event as JSON to all open clients.
*/
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
