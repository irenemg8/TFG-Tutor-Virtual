// Rectangular process node for the flow diagram (UML-style)

import { Handle, Position } from "@xyflow/react";

export default function FlowProcessNode({ data, selected }) {
  var status = data.nodeState ? data.nodeState.status : "idle";
  var nodeData = data.nodeState ? data.nodeState.data : null;

  var borderColor = "#475569";
  var bgColor = "#1e293b";
  var textColor = "#94a3b8";
  var subtitleColor = "#64748b";

  if (status === "active") {
    borderColor = "#3b82f6";
    bgColor = "#1e3a5f";
    textColor = "#93c5fd";
    subtitleColor = "#60a5fa";
  } else if (status === "completed") {
    borderColor = "#22c55e";
    bgColor = "#14532d";
    textColor = "#86efac";
    subtitleColor = "#4ade80";
  } else if (status === "error") {
    borderColor = "#ef4444";
    bgColor = "#450a0a";
    textColor = "#fca5a5";
    subtitleColor = "#f87171";
  } else if (status === "skipped") {
    borderColor = "#64748b";
    subtitleColor = "#475569";
  }

  var animation = status === "active" ? "pulse 1.5s ease-in-out infinite" : "none";

  // Build subtitle from data
  var subtitle = "";
  if (nodeData) {
    if (nodeData.type) subtitle = nodeData.type;
    else if (nodeData.decision) subtitle = nodeData.decision;
    else if (nodeData.resultCount != null) subtitle = nodeData.resultCount + " results";
    else if (nodeData.durationMs != null) subtitle = nodeData.durationMs + "ms";
    else if (nodeData.responseLength) subtitle = nodeData.responseLength + " chars";
    else if (nodeData.passed != null) subtitle = nodeData.passed ? "PASS" : "TRIGGERED";
    else if (nodeData.finished != null) subtitle = nodeData.finished ? "FINISH" : "continue";
    else if (nodeData.topScore != null) subtitle = "top=" + nodeData.topScore;
  }

  return (
    <div style={{
      borderWidth: "2px",
      borderColor: borderColor,
      borderStyle: status === "skipped" ? "dashed" : "solid",
      borderRadius: data.rounded ? "20px" : "6px",
      padding: "6px 14px",
      background: bgColor,
      minWidth: data.width || "120px",
      fontSize: "10px",
      cursor: "pointer",
      boxShadow: selected ? "0 0 0 2px #3b82f6" : status === "active" ? "0 0 10px " + borderColor : "none",
      transition: "all 0.3s ease",
      animation: animation,
      textAlign: "center",
    }}>
      <Handle type="target" position={Position.Top} style={{ background: borderColor }} />
      <div style={{ fontWeight: 600, color: textColor, whiteSpace: "nowrap" }}>
        {data.label}
      </div>
      {subtitle && (
        <div style={{ color: subtitleColor, fontSize: "9px", marginTop: "2px", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", maxWidth: "160px" }}>
          {subtitle}
        </div>
      )}
      <Handle type="source" position={Position.Bottom} style={{ background: borderColor }} />
      {data.handleRight && <Handle type="source" position={Position.Right} id="right" style={{ background: borderColor }} />}
      {data.handleLeft && <Handle type="source" position={Position.Left} id="left" style={{ background: borderColor }} />}
      {data.handleTargetLeft && <Handle type="target" position={Position.Left} id="target-left" style={{ background: borderColor }} />}
      {data.handleTargetRight && <Handle type="target" position={Position.Right} id="target-right" style={{ background: borderColor }} />}
    </div>
  );
}
