// Custom edge with smooth step routing (orthogonal paths avoid crossing nodes)
// Conditional flowing dot: only animates when data is actively flowing

import { BaseEdge, getSmoothStepPath, EdgeLabelRenderer } from "@xyflow/react";

export default function AnimatedEdge({ id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, label, style, data }) {
  var [edgePath, labelX, labelY] = getSmoothStepPath({
    sourceX: sourceX,
    sourceY: sourceY,
    targetX: targetX,
    targetY: targetY,
    sourcePosition: sourcePosition,
    targetPosition: targetPosition,
    borderRadius: 18,
    offset: 25,
  });

  var isActive = data && data.isActive;
  var isUsed = data && data.isUsed;
  var idle = !isActive && !isUsed;

  var baseStroke = (style && style.stroke) || "#475569";
  var baseWidth = (style && style.strokeWidth) || 1.5;
  var baseDash = (style && style.strokeDasharray) || undefined;

  // Compute visual state
  var edgeStroke = idle ? "#1e293b" : baseStroke;
  var edgeWidth = isActive ? baseWidth + 0.5 : idle ? 0.8 : baseWidth;
  var edgeOpacity = isActive ? 1 : isUsed ? 0.75 : 0.15;

  return (
    <>
      <BaseEdge
        id={id}
        path={edgePath}
        style={{
          stroke: edgeStroke,
          strokeWidth: edgeWidth,
          opacity: edgeOpacity,
          strokeLinecap: "round",
          strokeDasharray: baseDash,
          transition: "opacity 0.4s ease, stroke 0.4s ease, stroke-width 0.3s ease",
        }}
      />
      {/* Animated flowing dot -- only when edge is active */}
      {isActive && (
        <circle r="3" fill={baseStroke} opacity="0.9">
          <animateMotion dur="1.5s" repeatCount="indefinite" path={edgePath} />
        </circle>
      )}
      {/* Label */}
      {label && (
        <EdgeLabelRenderer>
          <div
            style={{
              position: "absolute",
              transform: "translate(-50%, -50%) translate(" + labelX + "px," + labelY + "px)",
              fontSize: "9px",
              fontWeight: 600,
              color: idle ? "#334155" : isActive ? "#e2e8f0" : "#94a3b8",
              background: "#0f172a",
              padding: "2px 6px",
              borderRadius: "4px",
              border: "1px solid " + (isActive ? baseStroke : idle ? "#0f172a" : "#1e293b"),
              pointerEvents: "none",
              whiteSpace: "nowrap",
              opacity: idle ? 0.2 : 1,
              transition: "opacity 0.4s ease, color 0.4s ease",
            }}
          >
            {label}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
}
