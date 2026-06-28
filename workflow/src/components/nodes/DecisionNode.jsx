// Diamond-shaped decision node for the flow diagram (UML-style)

import { Handle, Position } from "@xyflow/react";

export default function DecisionNode({ data, selected }) {
  var status = data.nodeState ? data.nodeState.status : "idle";
  var isActive = status === "active" || status === "completed";
  var activePath = data.activePath || null;

  var borderColor = "#475569";
  var bgColor = "#1e293b";
  var textColor = "#94a3b8";

  if (status === "active") {
    borderColor = "#3b82f6";
    bgColor = "#1e3a5f";
    textColor = "#93c5fd";
  } else if (status === "completed") {
    borderColor = "#22c55e";
    bgColor = "#14532d";
    textColor = "#86efac";
  } else if (status === "error") {
    borderColor = "#ef4444";
    bgColor = "#450a0a";
    textColor = "#fca5a5";
  }

  var size = data.size || 100;
  var half = size / 2;

  return (
    <div style={{ width: size + "px", height: size + "px", position: "relative" }}>
      <Handle type="target" position={Position.Top} style={{ background: borderColor, top: -4 }} />
      <svg width={size} height={size} style={{ position: "absolute", top: 0, left: 0 }}>
        <polygon
          points={half + ",2 " + (size - 2) + "," + half + " " + half + "," + (size - 2) + " 2," + half}
          fill={bgColor}
          stroke={borderColor}
          strokeWidth={selected ? 3 : 2}
          style={{ filter: status === "active" ? "drop-shadow(0 0 8px " + borderColor + ")" : "none" }}
        />
      </svg>
      <div style={{
        position: "absolute",
        top: 0,
        left: 0,
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        pointerEvents: "none",
      }}>
        <span style={{ color: textColor, fontSize: "9px", fontWeight: 600, textAlign: "center", lineHeight: "1.2", maxWidth: size * 0.6 + "px" }}>
          {data.label}
        </span>
        {activePath && (
          <span style={{ color: "#fcd34d", fontSize: "8px", fontWeight: 600, marginTop: "2px" }}>
            {activePath}
          </span>
        )}
      </div>
      <Handle type="source" position={Position.Bottom} style={{ background: borderColor, bottom: -4 }} />
      <Handle type="source" position={Position.Right} id="right" style={{ background: borderColor, right: -4 }} />
      <Handle type="source" position={Position.Left} id="left" style={{ background: borderColor, left: -4 }} />
      {data.handleTargetLeft && <Handle type="target" position={Position.Left} id="target-left" style={{ background: borderColor, left: -4 }} />}
      {data.handleTargetRight && <Handle type="target" position={Position.Right} id="target-right" style={{ background: borderColor, right: -4 }} />}
    </div>
  );
}
