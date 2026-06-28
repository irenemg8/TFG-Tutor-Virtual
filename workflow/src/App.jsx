// Main workflow monitor app: React Flow graph + flow diagram + panels + export

import { useState, useMemo, useCallback, useRef } from "react";
import { ReactFlow, Background, Controls, MiniMap } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import "./App.css";

import useWorkflowSocket from "./hooks/useWorkflowSocket.js";
import { initialNodes, initialEdges } from "./components/layout/workflowLayout.js";
import PipelineStepNode from "./components/nodes/PipelineStepNode.jsx";
import ExternalServiceNode from "./components/nodes/ExternalServiceNode.jsx";
import AlgorithmNode from "./components/nodes/AlgorithmNode.jsx";
import GuardrailNode from "./components/nodes/GuardrailNode.jsx";
import SectionGroupNode from "./components/nodes/SectionGroupNode.jsx";
import DocumentNode from "./components/nodes/DocumentNode.jsx";
import AnimatedEdge from "./components/edges/AnimatedEdge.jsx";
import RequestInfo from "./components/panels/RequestInfo.jsx";
import EventLog from "./components/panels/EventLog.jsx";
import NodeDetail from "./components/panels/NodeDetail.jsx";
import TimingBar from "./components/panels/TimingBar.jsx";
import RequestHistory from "./components/panels/RequestHistory.jsx";
import ExportButton from "./components/panels/ExportExcel.jsx";
import FlowDiagram from "./components/panels/FlowDiagram.jsx";

// WS endpoint del backend. Configurable via VITE_BACKEND_WS_URL.
// Default :3030 porque es donde corre el backend en dev local (PORT=3030 en
// backend/.env). Producción/Windows usa otro puerto, por eso es env var.
var WS_URL = import.meta.env.VITE_BACKEND_WS_URL || "ws://localhost:3030/ws/workflow";

var nodeTypes = {
  pipelineStep: PipelineStepNode,
  externalService: ExternalServiceNode,
  algorithmNode: AlgorithmNode,
  guardrailNode: GuardrailNode,
  sectionGroup: SectionGroupNode,
  documentNode: DocumentNode,
};

var edgeTypes = {
  animated: AnimatedEdge,
};

// Drag handle for resizing panels
function ResizeHandle({ direction, onMouseDown }) {
  var isHorizontal = direction === "left" || direction === "right";
  var cursor = isHorizontal ? "col-resize" : "row-resize";

  var style = {
    position: "absolute",
    zIndex: 10,
    background: "transparent",
  };

  if (direction === "left") {
    Object.assign(style, { top: 0, left: -3, width: "6px", height: "100%", cursor: cursor });
  } else if (direction === "right") {
    Object.assign(style, { top: 0, right: -3, width: "6px", height: "100%", cursor: cursor });
  } else if (direction === "top") {
    Object.assign(style, { top: -3, left: 0, width: "100%", height: "6px", cursor: cursor });
  }

  return (
    <div
      onMouseDown={onMouseDown}
      style={style}
      onMouseEnter={function (e) { e.target.style.background = "#3b82f6"; }}
      onMouseLeave={function (e) { e.target.style.background = "transparent"; }}
    />
  );
}

export default function App() {
  var ws = useWorkflowSocket(WS_URL);
  var [activeTab, setActiveTab] = useState("graph"); // "graph" or "flow"

  // Resizable panel sizes
  var [eventLogWidth, setEventLogWidth] = useState(340);
  var [historyWidth, setHistoryWidth] = useState(220);
  var [detailHeight, setDetailHeight] = useState(240);
  var dragRef = useRef(null);

  // Generic drag handler
  var startDrag = useCallback(function (type, startPos, startSize) {
    dragRef.current = { type: type, startPos: startPos, startSize: startSize };

    function onMouseMove(e) {
      if (!dragRef.current) return;
      var d = dragRef.current;
      if (d.type === "eventLog") {
        var newW = d.startSize - (e.clientX - d.startPos);
        setEventLogWidth(Math.max(200, Math.min(600, newW)));
      } else if (d.type === "history") {
        var newW2 = d.startSize + (e.clientX - d.startPos);
        setHistoryWidth(Math.max(150, Math.min(400, newW2)));
      } else if (d.type === "detail") {
        var newH = d.startSize - (e.clientY - d.startPos);
        setDetailHeight(Math.max(100, Math.min(500, newH)));
      }
    }

    function onMouseUp() {
      dragRef.current = null;
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    }

    document.body.style.cursor = (type === "detail") ? "row-resize" : "col-resize";
    document.body.style.userSelect = "none";
    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
  }, []);

  // Merge node states into node data for rendering
  var nodes = useMemo(function () {
    return initialNodes.map(function (node) {
      return Object.assign({}, node, {
        data: Object.assign({}, node.data, {
          nodeState: ws.nodeStates[node.id] || null,
        }),
        selected: ws.selectedNode === node.id,
      });
    });
  }, [ws.nodeStates, ws.selectedNode]);

  // Compute dynamic edges with active/used state for conditional animation
  var edges = useMemo(function () {
    return initialEdges.map(function (e) {
      var sourceState = ws.nodeStates[e.source];
      var targetState = ws.nodeStates[e.target];
      var ss = sourceState ? sourceState.status : "idle";
      var ts = targetState ? targetState.status : "idle";

      var isUsed = ss !== "idle" && ts !== "idle";
      var isActive = ss === "active" || (ss === "completed" && ts === "active");

      return Object.assign({}, e, {
        data: Object.assign({}, e.data, { isActive: isActive, isUsed: isUsed }),
      });
    });
  }, [ws.nodeStates]);

  var onNodeClick = useCallback(function (_event, node) {
    if (node.type === "sectionGroup") return;
    ws.selectNode(node.id);
  }, [ws.selectNode]);

  var onPaneClick = useCallback(function () {
    ws.selectNode(null);
  }, [ws.selectNode]);

  var tabStyle = function (tab) {
    return {
      padding: "4px 14px",
      fontSize: "11px",
      fontWeight: 600,
      cursor: "pointer",
      background: activeTab === tab ? "#1e40af" : "transparent",
      color: activeTab === tab ? "#e2e8f0" : "#64748b",
      border: "1px solid " + (activeTab === tab ? "#3b82f6" : "#475569"),
      borderRadius: "4px",
      transition: "all 0.2s",
    };
  };

  return (
    <div style={{ width: "100%", height: "100vh", display: "flex", flexDirection: "column", background: "#0f172a" }}>
      {/* Top bar: request info + tabs + export button */}
      <div style={{ display: "flex", alignItems: "center", borderBottom: "1px solid #334155", background: "#1e293b", flexShrink: 0 }}>
        <div style={{ flex: 1 }}>
          <RequestInfo currentRequest={ws.currentRequest} connected={ws.connected} />
        </div>
        <div style={{ display: "flex", gap: "6px", padding: "0 12px" }}>
          <button onClick={function () { setActiveTab("graph"); }} style={tabStyle("graph")}>
            Component Graph
          </button>
          <button onClick={function () { setActiveTab("flow"); }} style={tabStyle("flow")}>
            Flow Diagram
          </button>
        </div>
        <div style={{ padding: "0 12px" }}>
          <ExportButton requestHistory={ws.requestHistory} />
        </div>
      </div>

      {/* Main area: history + center view + event log */}
      <div style={{ flex: 1, display: "flex", overflow: "hidden" }}>
        {/* Left: Request History (resizable) */}
        {ws.requestHistory.length > 0 && (
          <div style={{ width: historyWidth + "px", position: "relative", flexShrink: 0 }}>
            <RequestHistory requestHistory={ws.requestHistory} />
            <ResizeHandle direction="right" onMouseDown={function (e) { startDrag("history", e.clientX, historyWidth); }} />
          </div>
        )}

        {/* Center: Graph or Flow Diagram */}
        <div style={{ flex: 1, position: "relative" }}>
          {activeTab === "graph" ? (
            <ReactFlow
              nodes={nodes}
              edges={edges}
              nodeTypes={nodeTypes}
              edgeTypes={edgeTypes}
              onNodeClick={onNodeClick}
              onPaneClick={onPaneClick}
              fitView
              fitViewOptions={{ padding: 0.2 }}
              minZoom={0.3}
              maxZoom={2}
              proOptions={{ hideAttribution: true }}
            >
              <Background color="#334155" gap={20} size={1} />
              <Controls
                style={{ background: "#ffffff", border: "1px solid #d1d5db", borderRadius: "6px" }}
                buttonStyle={{ color: "#000000", background: "#ffffff", border: "1px solid #e5e7eb" }}
              />
            {/*  <MiniMap
                style={{ background: "#1e293b", border: "1px solid #334155" }}
                nodeColor={function (node) {
                  var state = ws.nodeStates[node.id];
                  if (!state) return "#475569";
                  var colors = { idle: "#475569", active: "#3b82f6", completed: "#22c55e", error: "#ef4444", skipped: "#64748b" };
                  return colors[state.status] || "#475569";
                }}
              />*/}
            </ReactFlow>
          ) : (
            <FlowDiagram
              nodeStates={ws.nodeStates}
              currentRequest={ws.currentRequest}
              onSelectNode={ws.selectNode}
              eventLog={ws.eventLog}
            />
          )}
        </div>

        {/* Right: Event Log (resizable) */}
        <div style={{ width: eventLogWidth + "px", position: "relative", flexShrink: 0 }}>
          <ResizeHandle direction="left" onMouseDown={function (e) { startDrag("eventLog", e.clientX, eventLogWidth); }} />
          <EventLog
            eventLog={ws.eventLog}
            selectedEvent={ws.selectedEvent}
            onSelectEvent={ws.selectEvent}
          />
        </div>
      </div>

      {/* Bottom: Timing + Node detail (resizable) */}
      <TimingBar nodeStates={ws.nodeStates} currentRequest={ws.currentRequest} />
      <div style={{ height: detailHeight + "px", position: "relative", flexShrink: 0 }}>
        <ResizeHandle direction="top" onMouseDown={function (e) { startDrag("detail", e.clientY, detailHeight); }} />
        <NodeDetail selectedNode={ws.selectedNode} nodeStates={ws.nodeStates} />
      </div>
    </div>
  );
}
