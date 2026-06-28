// Node for RAG pipeline steps (classifier, orchestrator, search, etc.)

import { Handle, Position } from "@xyflow/react";

var statusColors = {
  idle: { border: "#475569", bg: "#1e293b", text: "#94a3b8" },
  active: { border: "#3b82f6", bg: "#1e3a5f", text: "#93c5fd" },
  completed: { border: "#22c55e", bg: "#14532d", text: "#86efac" },
  error: { border: "#ef4444", bg: "#450a0a", text: "#fca5a5" },
  skipped: { border: "#64748b", bg: "#1e293b", text: "#64748b" },
};

export default function PipelineStepNode({ data, selected }) {
  var status = data.nodeState ? data.nodeState.status : "idle";
  var colors = statusColors[status] || statusColors.idle;
  var nodeData = data.nodeState ? data.nodeState.data : null;

  var style = {
    borderWidth: "2px",
    borderColor: colors.border,
    borderStyle: status === "skipped" ? "dashed" : "solid",
    borderRadius: "8px",
    padding: "8px 12px",
    background: colors.bg,
    minWidth: "140px",
    fontSize: "11px",
    cursor: "pointer",
    boxShadow: selected ? "0 0 0 2px #3b82f6" : status === "active" ? "0 0 12px " + colors.border : "none",
    transition: "all 0.3s ease",
  };

  var animation = status === "active" ? "pulse 1.5s ease-in-out infinite" : "none";

  var sideH = { width: "6px", height: "6px", minWidth: "6px", minHeight: "6px", background: colors.border, opacity: 0.3 };

  return (
    <div style={{ ...style, animation: animation }}>
      <Handle type="target" position={Position.Top} id="top" style={{ background: colors.border }} />
      <Handle type="source" position={Position.Top} id="top-source" style={sideH} />
      <Handle type="target" position={Position.Left} id="left" style={sideH} />
      <Handle type="source" position={Position.Left} id="left-source" style={sideH} />
      <Handle type="target" position={Position.Right} id="right" style={sideH} />
      <Handle type="source" position={Position.Right} id="right-source" style={sideH} />
      <div style={{ fontWeight: 600, color: colors.text, marginBottom: "4px" }}>
        {data.label}
      </div>
      {nodeData && status !== "idle" && (
        <div style={{ color: "#94a3b8", fontSize: "10px", maxWidth: "160px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {renderPreview(data.label, nodeData)}
        </div>
      )}
      <div style={{ position: "absolute", top: "4px", right: "6px", width: "6px", height: "6px", borderRadius: "50%", background: colors.border }} />
      <Handle type="source" position={Position.Bottom} id="bottom" style={{ background: colors.border }} />
      <Handle type="target" position={Position.Bottom} id="bottom-target" style={sideH} />
    </div>
  );
}

function renderPreview(label, d) {
  if (d.type) return d.type;
  if (d.decision) return d.decision;
  if (d.resultCount != null) return d.resultCount + " results";
  if (d.augmentationLength) return d.augmentationLength + " chars";
  if (d.responseLength) return d.responseLength + " chars";
  if (d.hasHistory != null) return d.hasHistory ? "has history" : "no history";
  if (d.logPath) return "logged";
  if (d.finished != null) return d.finished ? "FINISH" : "continue";
  return "";
}
