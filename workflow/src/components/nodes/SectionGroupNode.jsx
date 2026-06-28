// Background section node for grouping related components
// Renders a labeled container box (UML-style package/subsystem)

export default function SectionGroupNode({ data }) {
  var borderColor = data.borderColor || "#334155";
  var labelColor = data.labelColor || "#64748b";
  var bgColor = data.bgColor || "rgba(15, 23, 42, 0.5)";

  return (
    <div style={{
      width: "100%",
      height: "100%",
      borderRadius: "10px",
      border: "1.5px solid " + borderColor,
      background: bgColor,
      pointerEvents: "none",
    }}>
      {/* UML-style tab label */}
      <div style={{
        position: "absolute",
        top: "-1px",
        left: "12px",
        background: borderColor,
        padding: "3px 12px",
        borderRadius: "0 0 6px 6px",
        fontSize: "9px",
        fontWeight: 700,
        color: labelColor,
        textTransform: "uppercase",
        letterSpacing: "1.2px",
        pointerEvents: "none",
      }}>
        {data.icon ? data.icon + "  " : ""}{data.label}
      </div>
      {/* Optional subtitle */}
      {data.subtitle && (
        <div style={{
          position: "absolute",
          top: "18px",
          left: "14px",
          fontSize: "8px",
          color: "#475569",
          fontStyle: "italic",
          pointerEvents: "none",
        }}>
          {data.subtitle}
        </div>
      )}
    </div>
  );
}
