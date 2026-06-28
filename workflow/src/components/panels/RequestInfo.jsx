// Top bar showing current request metadata and connection status

import { useState, useEffect } from "react";

export default function RequestInfo({ currentRequest, connected }) {
  var [elapsed, setElapsed] = useState(0);

  useEffect(function () {
    if (!currentRequest || currentRequest.totalTimeMs) {
      return;
    }
    var interval = setInterval(function () {
      setElapsed(Date.now() - currentRequest.startTime);
    }, 100);
    return function () { clearInterval(interval); };
  }, [currentRequest]);

  var displayTime = currentRequest && currentRequest.totalTimeMs
    ? currentRequest.totalTimeMs
    : elapsed;

  return (
    <div style={{
      display: "flex",
      alignItems: "center",
      gap: "16px",
      padding: "8px 16px",
      background: "#1e293b",
      fontSize: "12px",
      flexShrink: 0,
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
        <div style={{
          width: "8px",
          height: "8px",
          borderRadius: "50%",
          background: connected ? "#22c55e" : "#ef4444",
          boxShadow: connected ? "0 0 6px #22c55e" : "0 0 6px #ef4444",
        }} />
        <span style={{ color: "#94a3b8" }}>{connected ? "Connected" : "Disconnected"}</span>
      </div>

      {currentRequest && (
        <>
          <div style={{ color: "#64748b" }}>|</div>
          <div>
            <span style={{ color: "#64748b" }}>Exercise: </span>
            <span style={{ color: "#e2e8f0" }}>{currentRequest.exerciseId ? currentRequest.exerciseId.substring(0, 8) + "..." : "—"}</span>
          </div>
          <div>
            <span style={{ color: "#64748b" }}>Message: </span>
            <span style={{ color: "#e2e8f0" }}>{currentRequest.userMessage ? "\"" + currentRequest.userMessage.substring(0, 40) + (currentRequest.userMessage.length > 40 ? "..." : "") + "\"" : "—"}</span>
          </div>
          {currentRequest.classification && (
            <div>
              <span style={{ color: "#64748b" }}>Classification: </span>
              <span style={{ color: "#fcd34d", fontWeight: 600 }}>{currentRequest.classification}</span>
            </div>
          )}
          {currentRequest.decision && (
            <div>
              <span style={{ color: "#64748b" }}>Decision: </span>
              <span style={{ color: "#93c5fd", fontWeight: 600 }}>{currentRequest.decision}</span>
            </div>
          )}
          <div style={{ marginLeft: "auto" }}>
            <span style={{ color: "#64748b" }}>Time: </span>
            <span style={{ color: currentRequest.totalTimeMs ? "#22c55e" : "#3b82f6", fontWeight: 600, fontFamily: "monospace" }}>
              {displayTime}ms
            </span>
          </div>
        </>
      )}

      {!currentRequest && (
        <span style={{ color: "#64748b", fontStyle: "italic" }}>Waiting for requests...</span>
      )}
    </div>
  );
}
