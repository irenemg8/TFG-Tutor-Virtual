// Node for guardrail checks (pass/fail indicator)

import { Handle, Position } from "@xyflow/react";

var statusColors = {
  idle: { border: "#475569", bg: "#1e293b", text: "#94a3b8", icon: "\u{1F6E1}" },
  active: { border: "#3b82f6", bg: "#1e3a5f", text: "#93c5fd", icon: "\u{1F6E1}" },
  completed: { border: "#22c55e", bg: "#14532d", text: "#86efac", icon: "\u2705" },
  error: { border: "#ef4444", bg: "#450a0a", text: "#fca5a5", icon: "\u{1F6A8}" },
  skipped: { border: "#64748b", bg: "#1e293b", text: "#64748b", icon: "\u{1F6E1}" },
};

export default function GuardrailNode({ data, selected }) {
  var status = data.nodeState ? data.nodeState.status : "idle";
  var colors = statusColors[status] || statusColors.idle;
  var nodeData = data.nodeState ? data.nodeState.data : null;

  var style = {
    border: "2px solid " + colors.border,
    borderRadius: "8px",
    padding: "8px 10px",
    background: colors.bg,
    minWidth: "120px",
    fontSize: "11px",
    cursor: "pointer",
    boxShadow: selected ? "0 0 0 2px " + colors.border : status === "error" ? "0 0 16px rgba(239, 68, 68, 0.4)" : status === "completed" ? "0 0 8px rgba(34, 197, 94, 0.3)" : "none",
    transition: "all 0.3s ease",
  };

  var triggered = false;
  if (nodeData && nodeData.result) {
    triggered = nodeData.result.leaked || nodeData.result.confirmed || nodeData.result.revealed;
  }

  var sideH = { width: "6px", height: "6px", minWidth: "6px", minHeight: "6px", background: colors.border, opacity: 0.3 };

  return (
    <div style={style}>
      <Handle type="target" position={Position.Top} id="top" style={{ background: colors.border }} />
      <Handle type="source" position={Position.Top} id="top-source" style={sideH} />
      <Handle type="target" position={Position.Left} id="left" style={sideH} />
      <Handle type="source" position={Position.Left} id="left-source" style={sideH} />
      <Handle type="target" position={Position.Right} id="right" style={sideH} />
      <Handle type="source" position={Position.Right} id="right-source" style={sideH} />
      <div style={{ display: "flex", alignItems: "center", gap: "4px", marginBottom: "2px" }}>
        <span style={{ fontSize: "12px" }}>{colors.icon}</span>
        <span style={{ fontWeight: 600, color: colors.text }}>{data.label}</span>
      </div>
      {status !== "idle" && (
        <div style={{ color: colors.text, fontSize: "10px", fontWeight: 600 }}>
          {triggered ? "TRIGGERED" : status === "completed" ? "PASS" : "..."}
        </div>
      )}
      {triggered && nodeData && nodeData.result && nodeData.result.details && (
        <div style={{ color: "#fca5a5", fontSize: "9px", marginTop: "2px", maxWidth: "120px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {nodeData.result.details}
        </div>
      )}
      <Handle type="source" position={Position.Bottom} id="bottom" style={{ background: colors.border }} />
      <Handle type="target" position={Position.Bottom} id="bottom-target" style={sideH} />
    </div>
  );
}
