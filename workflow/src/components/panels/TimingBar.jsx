// Horizontal stacked bar showing time breakdown per pipeline stage

export default function TimingBar({ nodeStates, currentRequest }) {
  if (!currentRequest || !currentRequest.totalTimeMs) return null;

  var total = currentRequest.totalTimeMs;

  // Calculate durations from node states
  var segments = [];

  addSegment(segments, "Classification", nodeStates["classifier"], "#f59e0b");
  addSegment(segments, "KG Search", nodeStates["knowledge-graph"], "#8b5cf6");
  addSegment(segments, "Embedding", nodeStates["embedding"], "#06b6d4");
  addSegment(segments, "BM25", nodeStates["bm25"], "#f97316");
  addSegment(segments, "Semantic", nodeStates["chromadb"], "#a855f7");
  addSegment(segments, "RRF", nodeStates["rrf"], "#eab308");
  addSegment(segments, "PoliGPT", nodeStates["poligpt"], "#3b82f6");
  addSegment(segments, "Guardrails", nodeStates["guardrail-leak"], "#22c55e");

  // Filter out zero-duration segments
  segments = segments.filter(function (s) { return s.duration > 0; });

  if (segments.length === 0) return null;

  return (
    <div style={{
      padding: "6px 16px",
      background: "#0f172a",
      borderTop: "1px solid #334155",
      fontSize: "10px",
      flexShrink: 0,
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "4px" }}>
        <span style={{ color: "#64748b" }}>Timing breakdown</span>
        <span style={{ color: "#94a3b8", fontFamily: "monospace", marginLeft: "auto" }}>{total}ms total</span>
      </div>
      <div style={{ display: "flex", height: "14px", borderRadius: "4px", overflow: "hidden", background: "#1e293b" }}>
        {segments.map(function (seg, i) {
          var pct = Math.max((seg.duration / total) * 100, 2);
          return (
            <div
              key={i}
              title={seg.label + ": " + seg.duration + "ms"}
              style={{
                width: pct + "%",
                background: seg.color,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                color: "#0f172a",
                fontSize: "8px",
                fontWeight: 600,
                overflow: "hidden",
                whiteSpace: "nowrap",
              }}
            >
              {pct > 8 ? seg.label : ""}
            </div>
          );
        })}
      </div>
      <div style={{ display: "flex", gap: "12px", marginTop: "4px", flexWrap: "wrap" }}>
        {segments.map(function (seg, i) {
          return (
            <div key={i} style={{ display: "flex", alignItems: "center", gap: "4px" }}>
              <div style={{ width: "8px", height: "8px", borderRadius: "2px", background: seg.color }} />
              <span style={{ color: "#94a3b8" }}>{seg.label}: {seg.duration}ms</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function addSegment(segments, label, state, color) {
  if (!state || !state.startTime || !state.endTime) return;
  var duration = state.endTime - state.startTime;
  segments.push({ label: label, duration: duration, color: color });
}
