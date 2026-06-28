// Node for external services (MongoDB, ChromaDB, PoliGPT, Frontend)

import { Handle, Position } from "@xyflow/react";

var statusColors = {
  idle: { border: "#475569", bg: "#1e293b", text: "#94a3b8", accent: "#64748b" },
  active: { border: "#8b5cf6", bg: "#2e1065", text: "#c4b5fd", accent: "#8b5cf6" },
  completed: { border: "#8b5cf6", bg: "#1e1b4b", text: "#c4b5fd", accent: "#8b5cf6" },
  error: { border: "#ef4444", bg: "#450a0a", text: "#fca5a5", accent: "#ef4444" },
  skipped: { border: "#64748b", bg: "#1e293b", text: "#64748b", accent: "#475569" },
};

var icons = {
  user: "\u{1F464}",
  database: "\u{1F4BE}",
  vector: "\u{1F50D}",
  llm: "\u{1F916}",
  data: "\u{1F4C1}",
};

export default function ExternalServiceNode({ data, selected }) {
  var status = data.nodeState ? data.nodeState.status : "idle";
  var colors = statusColors[status] || statusColors.idle;
  var nodeData = data.nodeState ? data.nodeState.data : null;
  var icon = icons[data.icon] || "\u{2699}";

  var style = {
    border: "2px solid " + colors.border,
    borderRadius: "10px",
    padding: "8px 12px",
    background: colors.bg,
    minWidth: "130px",
    fontSize: "11px",
    cursor: "pointer",
    boxShadow: selected ? "0 0 0 2px #8b5cf6" : status === "active" ? "0 0 12px " + colors.accent : "none",
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
      <div style={{ display: "flex", alignItems: "center", gap: "6px", marginBottom: "4px" }}>
        <span style={{ fontSize: "14px" }}>{icon}</span>
        <span style={{ fontWeight: 600, color: colors.text }}>{data.label}</span>
      </div>
      {nodeData && status !== "idle" && (
        <div style={{ color: "#94a3b8", fontSize: "10px", maxWidth: "160px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {renderServicePreview(data.icon, nodeData)}
        </div>
      )}
      <Handle type="source" position={Position.Bottom} id="bottom" style={{ background: colors.border }} />
      <Handle type="target" position={Position.Bottom} id="bottom-target" style={sideH} />
    </div>
  );
}

function renderServicePreview(icon, d) {
  if (icon === "user" && d.userMessage) return d.userMessage.substring(0, 30);
  if (icon === "database" && d.exerciseNum) return "Ex " + d.exerciseNum;
  if (icon === "database" && d.interaccionId) return "saved";
  if (icon === "database" && d.messageCount != null) return d.messageCount + " msgs";
  if (icon === "vector" && d.resultCount != null) return d.resultCount + " results";
  if (icon === "llm" && d.responseLength) return d.responseLength + " chars";
  if (icon === "llm" && d.model) return d.model;
  if (icon === "data" && d.collectionName) return d.collectionName;
  if (d.resultCount != null) return d.resultCount + " results";
  return "";
}
