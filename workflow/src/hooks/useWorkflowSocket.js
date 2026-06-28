// WebSocket hook for connecting to the RAG workflow event bus
// Manages node states, event log, current request, and request history

import { useState, useEffect, useRef, useCallback } from "react";

// Maps event names to node IDs in the React Flow graph
var eventToNode = {
  request_start: "middleware",
  exercise_loaded: "mongodb",
  pipeline_start: "orchestrator",
  pipeline_end: "orchestrator",
  no_rag: "orchestrator",
  classify_start: "classifier",
  classify_end: "classifier",
  routing_decision: "orchestrator",
  kg_search_start: "knowledge-graph",
  kg_search_end: "knowledge-graph",
  hybrid_search_start: "hybrid-search",
  hybrid_search_end: "hybrid-search",
  embedding_start: "embedding",
  embedding_end: "embedding",
  bm25_search_start: "bm25",
  bm25_search_end: "bm25",
  semantic_search_start: "chromadb",
  semantic_search_end: "chromadb",
  rrf_fusion_start: "rrf",
  rrf_fusion_end: "rrf",
  crag_reformulate: "crag",
  student_history_start: "student-history",
  student_history_end: "student-history",
  augmentation_built: "orchestrator",
  deterministic_finish: "deterministic",
  prompt_built: "middleware",
  history_loaded: "mongodb",
  ollama_call_start: "poligpt",
  ollama_call_end: "poligpt",
  guardrail_leak: "guardrail-leak",
  guardrail_false_confirm: "guardrail-confirm",
  guardrail_state_reveal: "guardrail-state",
  ollama_retry: "poligpt",
  response_sent: "response",
  mongodb_save: "mongodb",
  log_written: "logger",
  request_end: "middleware",
  request_error: "middleware",
};

// Human-readable labels for event names
export var eventLabels = {
  request_start: "Request Start",
  exercise_loaded: "Exercise Loaded (MongoDB)",
  pipeline_start: "Pipeline Start",
  pipeline_end: "Pipeline End",
  no_rag: "No RAG (Pass-through)",
  classify_start: "Query Classifier (start)",
  classify_end: "Query Classifier (result)",
  routing_decision: "Routing Decision",
  kg_search_start: "Knowledge Graph Search (start)",
  kg_search_end: "Knowledge Graph Search (result)",
  hybrid_search_start: "Hybrid Search (start)",
  hybrid_search_end: "Hybrid Search (result)",
  embedding_start: "Embedding Generation (start)",
  embedding_end: "Embedding Generation (result)",
  bm25_search_start: "BM25 Search (start)",
  bm25_search_end: "BM25 Search (result)",
  semantic_search_start: "Semantic Search (start)",
  semantic_search_end: "Semantic Search (result)",
  rrf_fusion_start: "RRF Fusion (start)",
  rrf_fusion_end: "RRF Fusion (result)",
  crag_reformulate: "CRAG Reformulation",
  student_history_start: "Student History (start)",
  student_history_end: "Student History (result)",
  augmentation_built: "Augmentation Built",
  deterministic_finish: "Deterministic Finish Check",
  prompt_built: "Prompt Built",
  history_loaded: "Conversation History Loaded",
  ollama_call_start: "PoliGPT LLM Call (start)",
  ollama_call_end: "PoliGPT LLM Call (result)",
  guardrail_leak: "Guardrail: Solution Leak",
  guardrail_false_confirm: "Guardrail: False Confirmation",
  guardrail_state_reveal: "Guardrail: State Reveal",
  ollama_retry: "PoliGPT Retry (guardrail)",
  response_sent: "Response Sent (SSE)",
  mongodb_save: "MongoDB Save",
  log_written: "JSONL Log Written",
  request_end: "Request End",
  request_error: "Request Error",
};

// All node IDs used in the graph
var ALL_NODE_IDS = [
  "frontend", "middleware", "mongodb", "classifier", "orchestrator",
  "knowledge-graph", "hybrid-search", "embedding", "bm25", "chromadb",
  "rrf", "crag", "student-history", "deterministic", "poligpt",
  "guardrail-leak", "guardrail-confirm", "guardrail-state",
  "response", "logger", "datasets", "kg-data",
];

function buildIdleStates() {
  var states = {};
  for (var i = 0; i < ALL_NODE_IDS.length; i++) {
    states[ALL_NODE_IDS[i]] = { status: "idle", data: null, startTime: null, endTime: null };
  }
  return states;
}

export default function useWorkflowSocket(url) {
  var [connected, setConnected] = useState(false);
  var [nodeStates, setNodeStates] = useState(buildIdleStates);
  var [eventLog, setEventLog] = useState([]);
  var [currentRequest, setCurrentRequest] = useState(null);
  var [selectedNode, setSelectedNode] = useState(null);
  var [selectedEvent, setSelectedEvent] = useState(null);
  // Request history: array of completed requests with all their events
  var [requestHistory, setRequestHistory] = useState([]);
  // Events buffer for current request (to save into history on request_end)
  var currentEventsRef = useRef([]);
  var wsRef = useRef(null);
  var retryRef = useRef(0);

  var connect = useCallback(function () {
    if (wsRef.current && wsRef.current.readyState < 2) return;

    var ws = new WebSocket(url);
    wsRef.current = ws;

    ws.onopen = function () {
      setConnected(true);
      retryRef.current = 0;
    };

    ws.onclose = function () {
      setConnected(false);
      var delay = Math.min(1000 * Math.pow(2, retryRef.current), 10000);
      retryRef.current++;
      setTimeout(connect, delay);
    };

    ws.onerror = function () {
      ws.close();
    };

    ws.onmessage = function (msg) {
      var event;
      try {
        event = JSON.parse(msg.data);
      } catch (e) {
        return;
      }

      // Buffer event for current request
      currentEventsRef.current.push(event);

      // Add to global event log
      setEventLog(function (prev) {
        var next = prev.concat(event);
        if (next.length > 1000) next = next.slice(-1000);
        return next;
      });

      // Handle request_start: reset all nodes, start new request
      if (event.event === "request_start") {
        currentEventsRef.current = [event];
        setNodeStates(buildIdleStates());
        setCurrentRequest({
          requestId: event.requestId,
          userId: event.data.userId,
          userMessage: event.data.userMessage,
          exerciseId: event.data.exerciseId,
          interaccionId: event.data.interaccionId,
          startTime: event.timestamp,
        });
        setNodeStates(function (prev) {
          return Object.assign({}, prev, {
            frontend: { status: "completed", data: event.data, startTime: event.timestamp, endTime: event.timestamp },
          });
        });
      }

      // Update current request metadata
      if (event.event === "exercise_loaded") {
        setCurrentRequest(function (prev) {
          if (!prev) return prev;
          return Object.assign({}, prev, { exerciseNum: event.data.exerciseNum, correctAnswer: event.data.correctAnswer });
        });
      }
      if (event.event === "classify_end") {
        setCurrentRequest(function (prev) {
          if (!prev) return prev;
          return Object.assign({}, prev, {
            classification: event.data.type,
            resistances: event.data.resistances,
            hasReasoning: event.data.hasReasoning,
            concepts: event.data.concepts,
          });
        });
      }
      if (event.event === "routing_decision") {
        setCurrentRequest(function (prev) {
          if (!prev) return prev;
          return Object.assign({}, prev, { decision: event.data.decision, path: event.data.path });
        });
      }
      if (event.event === "ollama_call_end") {
        setCurrentRequest(function (prev) {
          if (!prev) return prev;
          return Object.assign({}, prev, { llmResponse: event.data.responsePreview, llmDurationMs: event.data.durationMs });
        });
      }
      if (event.event === "response_sent") {
        setCurrentRequest(function (prev) {
          if (!prev) return prev;
          return Object.assign({}, prev, { responsePreview: event.data.responsePreview, containsFIN: event.data.containsFIN });
        });
      }

      // Handle request_end: save completed request to history
      if (event.event === "request_end" || event.event === "request_error") {
        var finalEvents = currentEventsRef.current.slice();
        setCurrentRequest(function (prev) {
          if (!prev) return prev;
          return Object.assign({}, prev, {
            totalTimeMs: event.data.totalTimeMs || (event.timestamp - prev.startTime),
            endTime: event.timestamp,
            guardrailTriggered: event.data.guardrailTriggered || false,
          });
        });
        // Save to history outside of setCurrentRequest to avoid StrictMode double-invoke
        setRequestHistory(function (hist) {
          // Deduplicate by requestId
          var reqId = event.requestId;
          for (var h = 0; h < hist.length; h++) {
            if (hist[h].requestId === reqId) return hist;
          }
          var entry = {
            requestId: reqId,
            totalTimeMs: event.data.totalTimeMs,
            endTime: event.timestamp,
            guardrailTriggered: event.data.guardrailTriggered || false,
            events: finalEvents,
          };
          // Merge metadata from buffered events
          for (var ei = 0; ei < finalEvents.length; ei++) {
            var ev = finalEvents[ei];
            if (ev.event === "request_start") {
              entry.userId = ev.data.userId;
              entry.userMessage = ev.data.userMessage;
              entry.exerciseId = ev.data.exerciseId;
              entry.interaccionId = ev.data.interaccionId;
              entry.startTime = ev.timestamp;
            }
            if (ev.event === "exercise_loaded") {
              entry.exerciseNum = ev.data.exerciseNum;
              entry.correctAnswer = ev.data.correctAnswer;
            }
            if (ev.event === "classify_end") {
              entry.classification = ev.data.type;
              entry.resistances = ev.data.resistances;
              entry.hasReasoning = ev.data.hasReasoning;
              entry.concepts = ev.data.concepts;
            }
            if (ev.event === "routing_decision") {
              entry.decision = ev.data.decision;
              entry.path = ev.data.path;
            }
            if (ev.event === "ollama_call_end") {
              entry.llmResponse = ev.data.responsePreview;
              entry.llmDurationMs = ev.data.durationMs;
            }
            if (ev.event === "response_sent") {
              entry.responsePreview = ev.data.responsePreview;
              entry.containsFIN = ev.data.containsFIN;
            }
          }
          var next = hist.concat(entry);
          if (next.length > 100) next = next.slice(-100);
          return next;
        });
      }

      // Map event to node and update its state
      var nodeId = eventToNode[event.event];
      if (!nodeId) return;

      setNodeStates(function (prev) {
        var current = prev[nodeId] || { status: "idle", data: null };
        var newStatus = current.status;
        var newData = Object.assign({}, current.data || {}, event.data);

        if (event.status === "start") {
          newStatus = "active";
        } else if (event.status === "end") {
          if (event.event === "guardrail_leak" && event.data.result && event.data.result.leaked) {
            newStatus = "error";
          } else if (event.event === "guardrail_false_confirm" && event.data.result && event.data.result.confirmed) {
            newStatus = "error";
          } else if (event.event === "guardrail_state_reveal" && event.data.result && event.data.result.revealed) {
            newStatus = "error";
          } else if (event.event === "request_error") {
            newStatus = "error";
          } else {
            newStatus = "completed";
          }
        } else if (event.status === "skip") {
          newStatus = "skipped";
        }

        var updated = {};
        updated[nodeId] = {
          status: newStatus,
          data: newData,
          startTime: event.status === "start" ? event.timestamp : current.startTime,
          endTime: event.status === "end" ? event.timestamp : current.endTime,
        };
        return Object.assign({}, prev, updated);
      });

      // Data source nodes
      if (event.event === "kg_search_start") {
        setNodeStates(function (prev) {
          var u = {};
          u["kg-data"] = { status: "active", data: {}, startTime: event.timestamp, endTime: null };
          return Object.assign({}, prev, u);
        });
      }
      if (event.event === "kg_search_end") {
        setNodeStates(function (prev) {
          var u = {};
          u["kg-data"] = { status: "completed", data: event.data, startTime: prev["kg-data"].startTime, endTime: event.timestamp };
          return Object.assign({}, prev, u);
        });
      }
      if (event.event === "bm25_search_start" || event.event === "semantic_search_start") {
        setNodeStates(function (prev) {
          var u = {};
          u["datasets"] = { status: "active", data: event.data, startTime: event.timestamp, endTime: null };
          return Object.assign({}, prev, u);
        });
      }
      if (event.event === "bm25_search_end" || event.event === "semantic_search_end") {
        setNodeStates(function (prev) {
          var u = {};
          u["datasets"] = { status: "completed", data: event.data, startTime: prev["datasets"].startTime, endTime: event.timestamp };
          return Object.assign({}, prev, u);
        });
      }
    };
  }, [url]);

  useEffect(function () {
    connect();
    return function () {
      if (wsRef.current) wsRef.current.close();
    };
  }, [connect]);

  return {
    connected: connected,
    nodeStates: nodeStates,
    eventLog: eventLog,
    currentRequest: currentRequest,
    selectedNode: selectedNode,
    selectedEvent: selectedEvent,
    requestHistory: requestHistory,
    selectNode: setSelectedNode,
    selectEvent: setSelectedEvent,
  };
}
