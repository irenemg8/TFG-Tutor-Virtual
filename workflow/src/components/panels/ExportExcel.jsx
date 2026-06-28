// Excel export utility: exports full chat workflow data to .xlsx files
// Each export creates a file with all request rows, events, and parameters

import * as XLSX from "xlsx";
import { eventLabels } from "../../hooks/useWorkflowSocket.js";

// Export all requests in history to a single Excel file with multiple sheets
export function exportToExcel(requestHistory) {
  if (requestHistory.length === 0) return;

  var wb = XLSX.utils.book_new();

  // Sheet 1: Summary (one row per request/message exchange)
  var summaryRows = requestHistory.map(function (req, i) {
    return {
      "#": i + 1,
      "Timestamp": new Date(req.startTime).toISOString(),
      "Request ID": req.requestId || "",
      "User ID": req.userId || "",
      "Exercise ID": req.exerciseId || "",
      "Exercise Num": req.exerciseNum || "",
      "Student Message": req.userMessage || "",
      "Classification": req.classification || "",
      "Resistances": (req.resistances || []).join(", "),
      "Has Reasoning": req.hasReasoning != null ? String(req.hasReasoning) : "",
      "Concepts": (req.concepts || []).join(", "),
      "Decision": req.decision || "",
      "Path": req.path || "",
      "Tutor Response": req.responsePreview || req.llmResponse || "",
      "Contains FIN": req.containsFIN != null ? String(req.containsFIN) : "",
      "Guardrail Triggered": req.guardrailTriggered != null ? String(req.guardrailTriggered) : "",
      "LLM Duration (ms)": req.llmDurationMs || "",
      "Total Time (ms)": req.totalTimeMs || "",
      "Event Count": (req.events || []).length,
    };
  });
  var summarySheet = XLSX.utils.json_to_sheet(summaryRows);
  autoWidth(summarySheet, summaryRows);
  XLSX.utils.book_append_sheet(wb, summarySheet, "Summary");

  // Sheet 2: All events (one row per event across all requests)
  var eventRows = [];
  for (var r = 0; r < requestHistory.length; r++) {
    var req = requestHistory[r];
    var events = req.events || [];
    var baseTime = events.length > 0 ? events[0].timestamp : 0;

    for (var e = 0; e < events.length; e++) {
      var ev = events[e];
      eventRows.push({
        "Request #": r + 1,
        "Request ID": ev.requestId || "",
        "Relative Time (ms)": ev.timestamp - baseTime,
        "Event": ev.event,
        "Event Label": eventLabels[ev.event] || ev.event,
        "Status": ev.status,
        "Data": JSON.stringify(ev.data),
      });
    }
  }
  var eventsSheet = XLSX.utils.json_to_sheet(eventRows);
  autoWidth(eventsSheet, eventRows);
  XLSX.utils.book_append_sheet(wb, eventsSheet, "Events");

  // Sheet 3: Component Timing (one row per active component per request)
  var timingRows = [];
  for (var r2 = 0; r2 < requestHistory.length; r2++) {
    var req2 = requestHistory[r2];
    var events2 = req2.events || [];

    // Group events by component
    var components = {};
    for (var e2 = 0; e2 < events2.length; e2++) {
      var ev2 = events2[e2];
      var component = ev2.event.replace(/_start$/, "").replace(/_end$/, "");

      if (!components[component]) {
        components[component] = { startTime: null, endTime: null, data: {} };
      }
      if (ev2.status === "start") {
        components[component].startTime = ev2.timestamp;
      }
      if (ev2.status === "end") {
        components[component].endTime = ev2.timestamp;
      }
      Object.assign(components[component].data, ev2.data);
    }

    var compNames = Object.keys(components);
    for (var c = 0; c < compNames.length; c++) {
      var comp = components[compNames[c]];
      var duration = comp.startTime && comp.endTime ? comp.endTime - comp.startTime : null;
      timingRows.push({
        "Request #": r2 + 1,
        "Student Message": req2.userMessage || "",
        "Component": compNames[c],
        "Component Label": eventLabels[compNames[c]] || compNames[c],
        "Duration (ms)": duration || "",
        "Key Data": summarizeData(comp.data),
      });
    }
  }
  var timingSheet = XLSX.utils.json_to_sheet(timingRows);
  autoWidth(timingSheet, timingRows);
  XLSX.utils.book_append_sheet(wb, timingSheet, "Component Timing");

  // Sheet 4: Algorithm Parameters (detailed params per algorithm per request)
  var algoRows = [];
  var algoEvents = ["classify_end", "routing_decision", "embedding_start", "embedding_end", "bm25_search_start", "bm25_search_end", "semantic_search_start", "semantic_search_end", "rrf_fusion_start", "rrf_fusion_end", "crag_reformulate", "kg_search_end", "hybrid_search_end", "student_history_end", "augmentation_built", "prompt_built", "ollama_call_start", "ollama_call_end", "guardrail_leak", "guardrail_false_confirm", "guardrail_state_reveal", "deterministic_finish", "ollama_retry"];

  for (var r3 = 0; r3 < requestHistory.length; r3++) {
    var req3 = requestHistory[r3];
    var events3 = req3.events || [];
    var baseTime3 = events3.length > 0 ? events3[0].timestamp : 0;

    for (var e3 = 0; e3 < events3.length; e3++) {
      var ev3 = events3[e3];
      if (algoEvents.indexOf(ev3.event) === -1) continue;

      var row = {
        "Request #": r3 + 1,
        "Student Message": req3.userMessage || "",
        "Algorithm/Function": eventLabels[ev3.event] || ev3.event,
        "Time Offset (ms)": ev3.timestamp - baseTime3,
      };

      // Flatten data keys as columns
      var dKeys = Object.keys(ev3.data);
      for (var dk = 0; dk < dKeys.length; dk++) {
        var val = ev3.data[dKeys[dk]];
        row[dKeys[dk]] = typeof val === "object" ? JSON.stringify(val) : val;
      }
      algoRows.push(row);
    }
  }
  if (algoRows.length > 0) {
    var algoSheet = XLSX.utils.json_to_sheet(algoRows);
    autoWidth(algoSheet, algoRows);
    XLSX.utils.book_append_sheet(wb, algoSheet, "Algorithm Params");
  }

  // Sheet 5: Ranking Results (one row per ranked document per search per request)
  var rankRows = [];
  var rankEvents = ["bm25_search_end", "semantic_search_end", "rrf_fusion_end", "hybrid_search_end", "kg_search_end"];
  for (var r4 = 0; r4 < requestHistory.length; r4++) {
    var req4 = requestHistory[r4];
    var events4 = req4.events || [];
    for (var e4 = 0; e4 < events4.length; e4++) {
      var ev4 = events4[e4];
      if (rankEvents.indexOf(ev4.event) === -1) continue;
      var items = ev4.data.results || ev4.data.entries || [];
      for (var ri = 0; ri < items.length; ri++) {
        var item = items[ri];
        var rankRow = {
          "Request #": r4 + 1,
          "Student Message": req4.userMessage || "",
          "Search Type": eventLabels[ev4.event] || ev4.event,
        };
        var itemKeys = Object.keys(item);
        for (var ik = 0; ik < itemKeys.length; ik++) {
          var iv = item[itemKeys[ik]];
          rankRow[itemKeys[ik]] = typeof iv === "object" ? JSON.stringify(iv) : iv;
        }
        rankRows.push(rankRow);
      }
    }
  }
  if (rankRows.length > 0) {
    var rankSheet = XLSX.utils.json_to_sheet(rankRows);
    autoWidth(rankSheet, rankRows);
    XLSX.utils.book_append_sheet(wb, rankSheet, "Ranking Results");
  }

  // Sheet 6: Flow Path (decision path taken per request)
  var flowRows = [];
  var decisionEvents = { classify_end: "Classification", routing_decision: "Routing Decision", crag_reformulate: "CRAG Triggered", deterministic_finish: "Deterministic Finish", guardrail_leak: "Guardrail: Leak", guardrail_false_confirm: "Guardrail: False Confirm", guardrail_state_reveal: "Guardrail: State Reveal", ollama_retry: "LLM Retry" };
  for (var r5 = 0; r5 < requestHistory.length; r5++) {
    var req5 = requestHistory[r5];
    var events5 = req5.events || [];
    var stepNum = 1;
    for (var e5 = 0; e5 < events5.length; e5++) {
      var ev5 = events5[e5];
      var decisionLabel = decisionEvents[ev5.event];
      if (!decisionLabel) continue;
      var outcome = "";
      if (ev5.event === "classify_end") outcome = "type=" + (ev5.data.type || "") + ", resistances=[" + (ev5.data.resistances || []).join(",") + "], isCorrect=" + ev5.data.isCorrectAnswer;
      else if (ev5.event === "routing_decision") outcome = ev5.data.path || ev5.data.decision || "";
      else if (ev5.event === "crag_reformulate") outcome = "topScore=" + ev5.data.topScore + " < " + ev5.data.threshold + ", reformulated=\"" + ev5.data.reformulatedQuery + "\"";
      else if (ev5.event === "deterministic_finish") outcome = ev5.data.finished ? "YES (finish)" : "NO (continue to LLM)";
      else if (ev5.event === "guardrail_leak") outcome = ev5.data.passed ? "PASS" : "TRIGGERED: " + JSON.stringify(ev5.data.result);
      else if (ev5.event === "guardrail_false_confirm") outcome = ev5.data.passed ? "PASS" : "TRIGGERED: " + JSON.stringify(ev5.data.result);
      else if (ev5.event === "guardrail_state_reveal") outcome = ev5.data.passed ? "PASS" : "TRIGGERED: " + JSON.stringify(ev5.data.result);
      else if (ev5.event === "ollama_retry") outcome = "reason=" + (ev5.data.reason || "");
      flowRows.push({
        "Request #": r5 + 1,
        "Student Message": req5.userMessage || "",
        "Step": stepNum++,
        "Decision Point": decisionLabel,
        "Outcome": outcome,
      });
    }
  }
  if (flowRows.length > 0) {
    var flowSheet = XLSX.utils.json_to_sheet(flowRows);
    autoWidth(flowSheet, flowRows);
    XLSX.utils.book_append_sheet(wb, flowSheet, "Flow Path");
  }

  // Generate filename with date
  var now = new Date();
  var dateStr = now.getFullYear() + "-"
    + pad2(now.getMonth() + 1) + "-"
    + pad2(now.getDate()) + "_"
    + pad2(now.getHours()) + "-"
    + pad2(now.getMinutes()) + "-"
    + pad2(now.getSeconds());
  var fileName = "workflow_export_" + dateStr + ".xlsx";

  // Download
  XLSX.writeFile(wb, fileName);
  return fileName;
}

function pad2(n) {
  return n < 10 ? "0" + n : String(n);
}

function autoWidth(sheet, rows) {
  if (rows.length === 0) return;
  var keys = Object.keys(rows[0]);
  var colWidths = keys.map(function (k) {
    var maxLen = k.length;
    for (var i = 0; i < Math.min(rows.length, 50); i++) {
      var val = String(rows[i][k] || "");
      if (val.length > maxLen) maxLen = val.length;
    }
    return { wch: Math.min(maxLen + 2, 60) };
  });
  sheet["!cols"] = colWidths;
}

function summarizeData(data) {
  var parts = [];
  var keys = Object.keys(data);
  for (var i = 0; i < keys.length; i++) {
    var val = data[keys[i]];
    if (val === null || val === undefined) continue;
    if (typeof val === "object") continue;
    parts.push(keys[i] + "=" + val);
    if (parts.length >= 5) break;
  }
  return parts.join(", ");
}

// Export button component
export default function ExportButton({ requestHistory }) {
  var count = requestHistory.length;

  function handleExport() {
    if (count === 0) return;
    var fileName = exportToExcel(requestHistory);
    if (fileName) {
      console.log("[Workflow] Exported to " + fileName);
    }
  }

  return (
    <button
      onClick={handleExport}
      disabled={count === 0}
      style={{
        background: count > 0 ? "#1e40af" : "#334155",
        color: count > 0 ? "#e2e8f0" : "#64748b",
        border: "1px solid " + (count > 0 ? "#3b82f6" : "#475569"),
        borderRadius: "4px",
        padding: "4px 10px",
        fontSize: "10px",
        fontWeight: 600,
        cursor: count > 0 ? "pointer" : "default",
        display: "flex",
        alignItems: "center",
        gap: "4px",
      }}
      title={"Export " + count + " requests to Excel"}
    >
      {"\u{1F4E5}"} Export ({count})
    </button>
  );
}
