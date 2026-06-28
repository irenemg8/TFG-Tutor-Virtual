// Node for algorithm steps (BM25, RRF, CRAG, Embedding)

import { Handle, Position } from "@xyflow/react";

var statusColors = {
  idle: { border: "#475569", bg: "#1e293b", text: "#94a3b8" },
  active: { border: "#f59e0b", bg: "#451a03", text: "#fcd34d" },
  completed: { border: "#f59e0b", bg: "#422006", text: "#fcd34d" },
  error: { border: "#ef4444", bg: "#450a0a", text: "#fca5a5" },
  skipped: { border: "#64748b", bg: "#1e293b", text: "#64748b" },
};

export default function AlgorithmNode({ data, selected }) {
  var status = data.nodeState ? data.nodeState.status : "idle";
  var colors = statusColors[status] || statusColors.idle;
  var nodeData = data.nodeState ? data.nodeState.data : null;

  var style = {
    borderWidth: "2px",
    borderColor: colors.border,
    borderStyle: status === "skipped" ? "dashed" : "solid",
    borderRadius: "6px",
    padding: "8px 12px",
    background: colors.bg,
    minWidth: "130px",
    fontSize: "11px",
    cursor: "pointer",
    boxShadow: selected ? "0 0 0 2px #f59e0b" : status === "active" ? "0 0 12px " + colors.border : "none",
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
      <div style={{ display: "flex", alignItems: "center", gap: "4px", marginBottom: "4px" }}>
        <span style={{ fontSize: "12px" }}>{"\u{2699}"}</span>
        <span style={{ fontWeight: 600, color: colors.text }}>{data.label}</span>
      </div>
      {nodeData && status !== "idle" && (
        <div style={{ color: "#94a3b8", fontSize: "10px", maxWidth: "160px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {renderAlgoPreview(data.label, nodeData)}
        </div>
      )}
      <Handle type="source" position={Position.Bottom} id="bottom" style={{ background: colors.border }} />
      <Handle type="target" position={Position.Bottom} id="bottom-target" style={sideH} />
    </div>
  );
}

function renderAlgoPreview(label, d) {
  if (d.vectorDimensions) return d.vectorDimensions + "d, " + (d.durationMs || 0) + "ms";
  if (d.topScore != null && d.resultCount != null) return d.resultCount + " results, top=" + d.topScore.toFixed(3);
  if (d.formula) return d.formula.substring(0, 30);
  if (d.reformulatedQuery) return d.reformulatedQuery.substring(0, 30);
  if (d.resultCount != null) return d.resultCount + " results";
  return "";
}
