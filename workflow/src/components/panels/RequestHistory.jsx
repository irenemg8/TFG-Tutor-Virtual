// Request history panel: shows past requests with timing stats

export default function RequestHistory({ requestHistory, onSelectRequest }) {
  if (requestHistory.length === 0) return null;

  // Calculate stats
  var totalRequests = requestHistory.length;
  var avgTime = 0;
  var classificationCounts = {};
  var decisionCounts = {};
  var guardrailCount = 0;

  for (var i = 0; i < requestHistory.length; i++) {
    var req = requestHistory[i];
    avgTime += req.totalTimeMs || 0;
    if (req.classification) {
      classificationCounts[req.classification] = (classificationCounts[req.classification] || 0) + 1;
    }
    if (req.decision) {
      decisionCounts[req.decision] = (decisionCounts[req.decision] || 0) + 1;
    }
    if (req.guardrailTriggered) guardrailCount++;
  }
  avgTime = Math.round(avgTime / totalRequests);

  return (
    <div style={{
      width: "100%",
      height: "100%",
      background: "#1e293b",
      borderRight: "1px solid #334155",
      display: "flex",
      flexDirection: "column",
      fontSize: "10px",
    }}>
      {/* Stats header */}
      <div style={{ padding: "8px 10px", borderBottom: "1px solid #334155" }}>
        <div style={{ fontWeight: 600, color: "#e2e8f0", fontSize: "12px", marginBottom: "6px" }}>
          History ({totalRequests})
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: "3px" }}>
          <StatRow label="Avg time" value={avgTime + "ms"} color="#f59e0b" />
          <StatRow label="Guardrails" value={guardrailCount + "/" + totalRequests} color={guardrailCount > 0 ? "#ef4444" : "#22c55e"} />
        </div>

        {/* Classification distribution */}
        <div style={{ marginTop: "8px", color: "#64748b", fontWeight: 600, marginBottom: "4px" }}>Classifications</div>
        {Object.keys(classificationCounts).map(function (type) {
          var pct = Math.round((classificationCounts[type] / totalRequests) * 100);
          return (
            <div key={type} style={{ display: "flex", alignItems: "center", gap: "4px", marginBottom: "2px" }}>
              <div style={{ flex: 1, background: "#0f172a", borderRadius: "2px", height: "10px", overflow: "hidden" }}>
                <div style={{ width: pct + "%", height: "100%", background: "#f59e0b", borderRadius: "2px" }} />
              </div>
              <span style={{ color: "#94a3b8", minWidth: "80px", fontSize: "9px" }}>{type}</span>
              <span style={{ color: "#64748b", fontSize: "9px" }}>{classificationCounts[type]}</span>
            </div>
          );
        })}
      </div>

      {/* Request list */}
      <div style={{ flex: 1, overflowY: "auto" }}>
        {requestHistory.slice().reverse().map(function (req, idx) {
          var num = requestHistory.length - idx;
          return (
            <div
              key={idx}
              onClick={function () { if (onSelectRequest) onSelectRequest(req); }}
              style={{
                padding: "6px 10px",
                borderBottom: "1px solid #0f172a",
                cursor: "pointer",
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: "4px", marginBottom: "2px" }}>
                <span style={{ color: "#64748b", fontWeight: 600 }}>#{num}</span>
                <span style={{
                  background: getDecisionColor(req.decision).bg,
                  color: getDecisionColor(req.decision).text,
                  padding: "1px 4px",
                  borderRadius: "3px",
                  fontSize: "8px",
                  fontWeight: 600,
                }}>
                  {req.classification || "—"}
                </span>
                <span style={{ color: "#64748b", marginLeft: "auto", fontFamily: "monospace", fontSize: "9px" }}>
                  {req.totalTimeMs || 0}ms
                </span>
              </div>
              <div style={{ color: "#94a3b8", fontSize: "9px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {req.userMessage ? "\"" + req.userMessage.substring(0, 35) + "\"" : "—"}
              </div>
              <div style={{ color: "#64748b", fontSize: "8px", marginTop: "2px" }}>
                {req.decision || "—"} | {(req.events || []).length} events
                {req.guardrailTriggered ? " | GUARDRAIL" : ""}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function StatRow({ label, value, color }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between" }}>
      <span style={{ color: "#64748b" }}>{label}</span>
      <span style={{ color: color, fontFamily: "monospace", fontWeight: 600 }}>{value}</span>
    </div>
  );
}

function getDecisionColor(decision) {
  var colors = {
    "rag_examples": { bg: "#1e3a5f", text: "#93c5fd" },
    "scaffold": { bg: "#1e1b4b", text: "#c4b5fd" },
    "demand_reasoning": { bg: "#422006", text: "#fcd34d" },
    "correct_concept": { bg: "#14532d", text: "#86efac" },
    "concept_correction": { bg: "#450a0a", text: "#fca5a5" },
    "deterministic_finish": { bg: "#14532d", text: "#86efac" },
    "no_rag": { bg: "#334155", text: "#94a3b8" },
  };
  return colors[decision] || { bg: "#334155", text: "#94a3b8" };
}
