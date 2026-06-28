// Bottom panel showing full parameter detail for the selected node with structured sections

import { useState } from "react";

// Organized parameter display per node type
var nodeParamSections = {
  "middleware": ["exerciseNum", "correctAnswer", "systemPromptLength", "ragAugmentationLength", "totalPromptLength", "totalTimeMs", "pipelineTimeMs", "guardrailTriggered", "augmentationPreview"],
  "classifier": ["userMessage", "correctAnswer", "type", "resistances", "hasReasoning", "concepts", "isCorrectAnswer", "resistanceCount", "conceptCount", "messageLength"],
  "orchestrator": ["classification", "decision", "path", "augmentationLength", "sourcesCount", "pipelineTimeMs", "sections", "augmentationPreview"],
  "knowledge-graph": ["concepts", "resultCount", "entries"],
  "embedding": ["query", "model", "ollamaUrl", "vectorDimensions", "durationMs", "sampleValues", "norm"],
  "bm25": ["query", "queryTokens", "tokenCount", "exerciseNum", "topK", "k1", "b", "formula", "resultCount", "topScore", "results"],
  "chromadb": ["collectionName", "topK", "embeddingDim", "distanceMetric", "scoreFormula", "resultCount", "topScore", "results"],
  "rrf": ["bm25Count", "semanticCount", "RRF_K", "TOP_K_FINAL", "formula", "resultCount", "totalCandidates", "topScore", "results"],
  "crag": ["originalQuery", "topScore", "threshold", "reason", "reformulatedQuery", "extractedEntities"],
  "student-history": ["userId", "hasHistory", "historyLength", "historyPreview"],
  "poligpt": ["model", "temperature", "num_ctx", "num_predict", "keep_alive", "ollamaUrl", "messageCount", "responseLength", "responsePreview", "durationMs", "reason"],
  "guardrail-leak": ["check", "passed", "responsePreview", "correctAnswer", "result"],
  "guardrail-confirm": ["check", "passed", "responsePreview", "classification", "result"],
  "guardrail-state": ["check", "passed", "responsePreview", "result"],
  "response": ["responseLength", "responsePreview", "containsFIN", "guardrailTriggered"],
  "logger": ["logPath", "fields"],
  "mongodb": ["exerciseNum", "titulo", "correctAnswer", "canonicalExercise", "datasetFile", "interaccionId", "messageCount", "maxMessages", "messagesAdded", "messages"],
  "frontend": ["userMessage", "userId", "exerciseId", "interaccionId"],
  "deterministic": ["classification", "historyLength", "finished"],
  "hybrid-search": ["query", "exerciseNum", "topK", "resultCount", "topScore", "results"],
};

export default function NodeDetail({ selectedNode, nodeStates }) {
  var [collapsed, setCollapsed] = useState({});

  if (!selectedNode) {
    return (
      <div style={{
        height: "100%",
        background: "#1e293b",
        borderTop: "1px solid #334155",
        padding: "12px 16px",
        fontSize: "12px",
        color: "#64748b",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}>
        Click on a node to inspect its parameters
      </div>
    );
  }

  var state = nodeStates[selectedNode];
  if (!state) return null;

  var duration = state.startTime && state.endTime ? state.endTime - state.startTime : null;
  var data = state.data || {};
  var sections = nodeParamSections[selectedNode] || [];

  // Separate params into "known" (structured) and "other" (rest)
  var knownKeys = {};
  for (var i = 0; i < sections.length; i++) {
    knownKeys[sections[i]] = true;
  }
  var otherKeys = Object.keys(data).filter(function (k) { return !knownKeys[k]; });

  function toggleSection(name) {
    setCollapsed(function (prev) {
      var next = Object.assign({}, prev);
      next[name] = !next[name];
      return next;
    });
  }

  return (
    <div style={{
      height: "100%",
      background: "#1e293b",
      borderTop: "1px solid #334155",
      padding: "8px 16px",
      fontSize: "11px",
      overflowY: "auto",
    }}>
      {/* Header */}
      <div style={{
        display: "flex",
        alignItems: "center",
        gap: "10px",
        marginBottom: "8px",
      }}>
        <span style={{ fontWeight: 600, color: "#e2e8f0", fontSize: "13px" }}>
          {selectedNode}
        </span>
        <StatusBadge status={state.status} />
        {duration != null && (
          <span style={{ color: "#f59e0b", fontFamily: "monospace", fontWeight: 600 }}>
            {duration}ms
          </span>
        )}
        {state.startTime && (
          <span style={{ color: "#64748b", fontSize: "9px", marginLeft: "auto" }}>
            {new Date(state.startTime).toLocaleTimeString()}
          </span>
        )}
      </div>

      {/* Structured parameters */}
      <div style={{ display: "flex", gap: "16px", flexWrap: "wrap" }}>
        <div style={{ flex: 1, minWidth: "300px" }}>
          {/* Key params as table */}
          <SectionHeader title="Parameters" collapsed={collapsed.params} onClick={function () { toggleSection("params"); }} />
          {!collapsed.params && (
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "10px" }}>
              <tbody>
                {sections.map(function (key) {
                  var val = data[key];
                  if (val === undefined) return null;
                  return (
                    <tr key={key} style={{ borderBottom: "1px solid #0f172a" }}>
                      <td style={{ padding: "3px 8px 3px 0", color: "#64748b", whiteSpace: "nowrap", verticalAlign: "top", width: "120px" }}>
                        {key}
                      </td>
                      <td style={{ padding: "3px 0", color: "#e2e8f0", wordBreak: "break-all" }}>
                        {renderValue(key, val)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>

        {/* Other/raw params */}
        {otherKeys.length > 0 && (
          <div style={{ flex: 1, minWidth: "200px" }}>
            <SectionHeader title="Additional Data" collapsed={collapsed.other} onClick={function () { toggleSection("other"); }} />
            {!collapsed.other && (
              <pre style={{
                color: "#94a3b8",
                fontSize: "9px",
                lineHeight: "1.4",
                margin: 0,
                whiteSpace: "pre-wrap",
                wordBreak: "break-all",
                background: "#0f172a",
                padding: "6px",
                borderRadius: "4px",
                maxHeight: "100px",
                overflowY: "auto",
              }}>
                {JSON.stringify(
                  otherKeys.reduce(function (acc, k) { acc[k] = data[k]; return acc; }, {}),
                  null, 2
                )}
              </pre>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function SectionHeader({ title, collapsed, onClick }) {
  return (
    <div
      onClick={onClick}
      style={{
        cursor: "pointer",
        color: "#94a3b8",
        fontSize: "10px",
        fontWeight: 600,
        marginBottom: "4px",
        display: "flex",
        alignItems: "center",
        gap: "4px",
      }}
    >
      <span style={{ fontSize: "8px" }}>{collapsed ? "\u25B6" : "\u25BC"}</span>
      {title}
    </div>
  );
}

function StatusBadge({ status }) {
  var colors = {
    idle: { bg: "#334155", color: "#94a3b8" },
    active: { bg: "#1e3a5f", color: "#93c5fd" },
    completed: { bg: "#14532d", color: "#86efac" },
    error: { bg: "#450a0a", color: "#fca5a5" },
    skipped: { bg: "#334155", color: "#64748b" },
  };
  var c = colors[status] || colors.idle;

  return (
    <span style={{
      background: c.bg,
      color: c.color,
      padding: "2px 6px",
      borderRadius: "4px",
      fontSize: "10px",
      fontWeight: 600,
      textTransform: "uppercase",
    }}>
      {status}
    </span>
  );
}

function renderValue(key, val) {
  if (val === null || val === undefined) return <span style={{ color: "#64748b" }}>null</span>;
  if (typeof val === "boolean") return <span style={{ color: val ? "#22c55e" : "#ef4444" }}>{String(val)}</span>;
  if (typeof val === "number") return <span style={{ color: "#f59e0b", fontFamily: "monospace" }}>{val}</span>;
  if (Array.isArray(val)) {
    if (val.length === 0) return <span style={{ color: "#64748b" }}>[]</span>;
    // For arrays of ranked results (with rank/score), render as a table
    if (typeof val[0] === "object" && (val[0].rank != null || val[0].score != null || val[0].node1 != null)) {
      return <ResultsTable items={val} />;
    }
    // For arrays of objects, show compact JSON
    if (typeof val[0] === "object") {
      return (
        <pre style={{ color: "#94a3b8", fontSize: "9px", margin: 0, whiteSpace: "pre-wrap", wordBreak: "break-all", maxHeight: "80px", overflowY: "auto" }}>
          {JSON.stringify(val, null, 1)}
        </pre>
      );
    }
    return <span style={{ color: "#c4b5fd" }}>[{val.join(", ")}]</span>;
  }
  if (typeof val === "object") {
    // For result objects (guardrail results etc.), show formatted
    return (
      <pre style={{ color: "#94a3b8", fontSize: "9px", margin: 0, whiteSpace: "pre-wrap", wordBreak: "break-all" }}>
        {JSON.stringify(val, null, 1)}
      </pre>
    );
  }
  // Strings - expandable for long text
  var str = String(val);
  if (str.length > 150) {
    return <ExpandableText text={str} />;
  }
  return <span style={{ color: "#e2e8f0" }}>{str}</span>;
}

function ExpandableText({ text }) {
  var [expanded, setExpanded] = useState(false);
  var preview = text.substring(0, 150);

  return (
    <div style={{ color: "#e2e8f0", fontSize: "10px" }}>
      <span style={{ whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
        {expanded ? text : preview + "..."}
      </span>
      <button
        onClick={function () { setExpanded(!expanded); }}
        style={{
          background: "none",
          border: "none",
          color: "#60a5fa",
          cursor: "pointer",
          fontSize: "9px",
          fontWeight: 600,
          marginLeft: "4px",
          padding: 0,
        }}
      >
        {expanded ? "[collapse]" : "[show all " + text.length + " chars]"}
      </button>
    </div>
  );
}

function ResultsTable({ items }) {
  if (items.length === 0) return null;
  var keys = Object.keys(items[0]);

  // Separate short keys (numbers, ids) from long text keys (student, tutor, document, etc.)
  var shortKeys = [];
  var textKeys = [];
  for (var ki = 0; ki < keys.length; ki++) {
    var k = keys[ki];
    var isText = k === "student" || k === "tutor" || k === "document" || k === "tutorResponse" || k === "studentPreview" || k === "tutorPreview" || k === "documentPreview" || k === "expertReasoning" || k === "socraticQuestions" || k === "acDescription";
    if (isText) {
      textKeys.push(k);
    } else {
      shortKeys.push(k);
    }
  }

  return (
    <div style={{ maxHeight: "160px", overflowY: "auto", fontSize: "9px" }}>
      {items.map(function (item, idx) {
        return (
          <div key={idx} style={{ borderBottom: "1px solid #334155", padding: "4px 0", marginBottom: "2px" }}>
            {/* Short fields as inline badges */}
            <div style={{ display: "flex", flexWrap: "wrap", gap: "6px", marginBottom: textKeys.length > 0 ? "3px" : 0 }}>
              {shortKeys.map(function (sk) {
                var v = item[sk];
                if (v === null || v === undefined) return null;
                var color = typeof v === "number" ? "#f59e0b" : "#e2e8f0";
                var display = typeof v === "object" ? JSON.stringify(v) : String(v);
                return (
                  <span key={sk} style={{ color: "#64748b" }}>
                    {sk}: <span style={{ color: color, fontFamily: typeof v === "number" ? "monospace" : "inherit" }}>{display}</span>
                  </span>
                );
              })}
            </div>
            {/* Full text fields displayed as blocks */}
            {textKeys.map(function (tk) {
              var tv = item[tk];
              if (!tv) return null;
              var label = tk;
              var labelColor = "#94a3b8";
              if (tk === "student" || tk === "studentPreview" || tk === "document" || tk === "documentPreview") labelColor = "#60a5fa";
              if (tk === "tutor" || tk === "tutorPreview" || tk === "tutorResponse") labelColor = "#4ade80";
              if (tk === "expertReasoning") labelColor = "#c084fc";
              if (tk === "socraticQuestions") labelColor = "#fb923c";
              var textStr = String(tv);
              return (
                <div key={tk} style={{ marginTop: "2px" }}>
                  <span style={{ color: labelColor, fontSize: "8px", fontWeight: 600 }}>{label}: </span>
                  {textStr.length > 150 ? (
                    <ExpandableText text={textStr} />
                  ) : (
                    <span style={{ color: "#e2e8f0", fontSize: "9px", lineHeight: "1.3" }}>{textStr}</span>
                  )}
                </div>
              );
            })}
          </div>
        );
      })}
    </div>
  );
}
