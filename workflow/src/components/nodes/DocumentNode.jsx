// Node for data sources / documents (datasets, KG data, config files)
// Distinct warm-paper styling with dog-ear fold

import { Handle, Position } from "@xyflow/react";

var statusColors = {
  idle: { border: "#92400e", bg: "#1c1407", text: "#d97706", accent: "#b45309" },
  active: { border: "#f59e0b", bg: "#451a03", text: "#fcd34d", accent: "#f59e0b" },
  completed: { border: "#d97706", bg: "#2a1800", text: "#fbbf24", accent: "#d97706" },
  error: { border: "#ef4444", bg: "#450a0a", text: "#fca5a5", accent: "#ef4444" },
  skipped: { border: "#64748b", bg: "#1e293b", text: "#64748b", accent: "#475569" },
};

export default function DocumentNode({ data, selected }) {
  var status = data.nodeState ? data.nodeState.status : "idle";
  var colors = statusColors[status] || statusColors.idle;

  var style = {
    border: "2px solid " + colors.border,
    borderRadius: "3px",
    padding: "8px 14px 8px 10px",
    background: colors.bg,
    minWidth: "120px",
    fontSize: "11px",
    cursor: "pointer",
    position: "relative",
    boxShadow: selected ? "0 0 0 2px " + colors.accent : "none",
    transition: "all 0.3s ease",
  };

  var sideH = { width: "6px", height: "6px", minWidth: "6px", minHeight: "6px", background: colors.border, opacity: 0.3 };

  return (
    <div style={style}>
      {/* Dog-ear fold corner */}
      <div style={{
        position: "absolute",
        top: 0,
        right: 0,
        width: 0,
        height: 0,
        borderStyle: "solid",
        borderWidth: "0 14px 14px 0",
        borderColor: "transparent #0f172a transparent transparent",
      }} />
      <div style={{
        position: "absolute",
        top: 0,
        right: 0,
        width: 0,
        height: 0,
        borderStyle: "solid",
        borderWidth: "14px 0 0 14px",
        borderColor: colors.border + " transparent transparent transparent",
        opacity: 0.5,
      }} />
      <Handle type="target" position={Position.Top} id="top" style={{ background: colors.border }} />
      <Handle type="source" position={Position.Top} id="top-source" style={sideH} />
      <Handle type="target" position={Position.Left} id="left" style={sideH} />
      <Handle type="source" position={Position.Left} id="left-source" style={sideH} />
      <Handle type="target" position={Position.Right} id="right" style={sideH} />
      <Handle type="source" position={Position.Right} id="right-source" style={sideH} />
      <div style={{ display: "flex", alignItems: "center", gap: "5px" }}>
        <span style={{ fontSize: "13px" }}>{"\u{1F4C4}"}</span>
        <span style={{ fontWeight: 600, color: colors.text }}>{data.label}</span>
      </div>
      {data.subtitle && (
        <div style={{ color: colors.text, opacity: 0.6, fontSize: "9px", marginTop: "2px" }}>
          {data.subtitle}
        </div>
      )}
      <Handle type="source" position={Position.Bottom} id="bottom" style={{ background: colors.border }} />
      <Handle type="target" position={Position.Bottom} id="bottom-target" style={sideH} />
    </div>
  );
}
