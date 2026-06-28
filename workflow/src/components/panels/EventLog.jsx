// Scrollable event log panel (right sidebar) with expandable event detail

import { useEffect, useRef, useState } from "react";
import { eventLabels } from "../../hooks/useWorkflowSocket.js";

var statusBadge = {
  start: { bg: "#1e3a5f", color: "#93c5fd", label: "START" },
  end: { bg: "#14532d", color: "#86efac", label: "END" },
  skip: { bg: "#1e293b", color: "#64748b", label: "SKIP" },
};

export default function EventLog({ eventLog, selectedEvent, onSelectEvent }) {
  var scrollRef = useRef(null);
  var [filter, setFilter] = useState("");

  useEffect(function () {
    if (scrollRef.current && !selectedEvent) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [eventLog.length, selectedEvent]);

  var baseTime = eventLog.length > 0 ? eventLog[0].timestamp : 0;

  var filtered = filter
    ? eventLog.filter(function (ev) { return ev.event.includes(filter) || (ev.status && ev.status.includes(filter)); })
    : eventLog;

  return (
    <div style={{
      width: "100%",
      height: "100%",
      background: "#1e293b",
      borderLeft: "1px solid #334155",
      display: "flex",
      flexDirection: "column",
    }}>
      <div style={{
        padding: "8px 12px",
        borderBottom: "1px solid #334155",
        fontSize: "12px",
        fontWeight: 600,
        color: "#e2e8f0",
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center",
      }}>
        <span>Event Log</span>
        <span style={{ color: "#64748b" }}>{filtered.length}/{eventLog.length}</span>
      </div>

      {/* Filter bar */}
      <div style={{ padding: "4px 8px", borderBottom: "1px solid #334155" }}>
        <input
          type="text"
          placeholder="Filter events..."
          value={filter}
          onChange={function (e) { setFilter(e.target.value); }}
          style={{
            width: "100%",
            background: "#0f172a",
            border: "1px solid #334155",
            borderRadius: "4px",
            padding: "4px 8px",
            color: "#e2e8f0",
            fontSize: "10px",
            outline: "none",
            boxSizing: "border-box",
          }}
        />
      </div>

      <div ref={scrollRef} style={{ flex: 1, overflowY: "auto", padding: "2px" }}>
        {filtered.map(function (ev, i) {
          var badge = statusBadge[ev.status] || statusBadge.end;
          var relTime = ev.timestamp - baseTime;
          var isSelected = selectedEvent === ev;
          var label = eventLabels[ev.event] || ev.event;

          return (
            <div key={i}>
              <div
                onClick={function () { onSelectEvent(isSelected ? null : ev); }}
                style={{
                  padding: "5px 8px",
                  borderBottom: "1px solid #0f172a",
                  cursor: "pointer",
                  fontSize: "10px",
                  display: "flex",
                  alignItems: "center",
                  gap: "6px",
                  background: isSelected ? "#0f172a" : "transparent",
                  borderLeft: isSelected ? "2px solid #3b82f6" : "2px solid transparent",
                }}
              >
                <span style={{ color: "#64748b", fontFamily: "monospace", minWidth: "50px", fontSize: "9px" }}>
                  +{relTime}ms
                </span>
                <span style={{
                  background: badge.bg,
                  color: badge.color,
                  padding: "1px 4px",
                  borderRadius: "3px",
                  fontSize: "9px",
                  fontWeight: 600,
                  minWidth: "34px",
                  textAlign: "center",
                }}>
                  {badge.label}
                </span>
                <span style={{ color: "#e2e8f0", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {label}
                </span>
                {renderQuickData(ev)}
              </div>

              {/* Expanded detail view */}
              {isSelected && (
                <div style={{
                  padding: "8px 12px",
                  background: "#0f172a",
                  borderBottom: "1px solid #1e293b",
                  fontSize: "10px",
                }}>
                  <div style={{ marginBottom: "6px", color: "#94a3b8" }}>
                    <span style={{ color: "#64748b" }}>Event: </span>
                    <span style={{ color: "#e2e8f0", fontWeight: 600 }}>{ev.event}</span>
                    <span style={{ color: "#64748b" }}> | Status: </span>
                    <span style={{ color: badge.color, fontWeight: 600 }}>{ev.status}</span>
                    <span style={{ color: "#64748b" }}> | Request: </span>
                    <span style={{ color: "#94a3b8" }}>{ev.requestId}</span>
                  </div>
                  <div style={{ marginBottom: "4px", color: "#64748b", fontSize: "9px" }}>
                    Timestamp: {new Date(ev.timestamp).toISOString()}
                  </div>
                  <div style={{ color: "#64748b", marginBottom: "4px", fontWeight: 600 }}>Parameters:</div>
                  <pre style={{
                    color: "#94a3b8",
                    fontSize: "9px",
                    lineHeight: "1.5",
                    margin: 0,
                    whiteSpace: "pre-wrap",
                    wordBreak: "break-all",
                    background: "#1e293b",
                    padding: "6px",
                    borderRadius: "4px",
                    maxHeight: "200px",
                    overflowY: "auto",
                  }}>
                    {JSON.stringify(ev.data, null, 2)}
                  </pre>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function renderQuickData(ev) {
  var d = ev.data;
  var text = "";

  if (d.type) text = d.type;
  else if (d.decision) text = d.decision;
  else if (d.path) text = d.path;
  else if (d.resultCount != null) text = d.resultCount + " res";
  else if (d.responseLength) text = d.responseLength + " ch";
  else if (d.totalTimeMs) text = d.totalTimeMs + "ms";
  else if (d.durationMs) text = d.durationMs + "ms";
  else if (d.result && d.result.leaked) text = "LEAKED";
  else if (d.result && d.result.confirmed) text = "CONFIRMED";
  else if (d.result && d.result.revealed) text = "REVEALED";
  else if (d.error) text = "ERROR";
  else if (d.vectorDimensions) text = d.vectorDimensions + "d";
  else if (d.topScore != null) text = "top=" + (typeof d.topScore === "number" ? d.topScore.toFixed(3) : d.topScore);

  if (!text) return null;

  return (
    <span style={{ color: "#94a3b8", fontSize: "9px", flexShrink: 0 }}>
      {text}
    </span>
  );
}
