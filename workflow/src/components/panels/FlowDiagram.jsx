// Flow Diagram view: UML-like decision flowchart showing all pipeline paths
// Highlights the active path in real-time as events arrive

import { useMemo, useCallback } from "react";
import { ReactFlow, Background, Controls, MiniMap } from "@xyflow/react";
import DecisionNode from "../nodes/DecisionNode.jsx";
import FlowProcessNode from "../nodes/FlowProcessNode.jsx";
import { flowNodes, flowEdges, classificationToFlowNode, classificationBranchNodes, allBranchNodeIds } from "../layout/flowDiagramLayout.js";

var flowNodeTypes = {
  flowDecision: DecisionNode,
  flowProcess: FlowProcessNode,
};

// Maps each flow node ID to the specific event(s) that should trigger it.
// Flow nodes sharing a pipeline nodeId need separate triggering events.
var flowNodeTriggerEvents = {
  "f-start": ["request_start"],
  "f-middleware": ["request_start"],
  "f-load-exercise": ["exercise_loaded"],
  "f-classifier": ["classify_start", "classify_end"],
  "f-classify-decision": ["classify_end"],
  // Left branches
  "f-greeting": ["routing_decision"],
  "f-no-rag": ["no_rag", "routing_decision"],
  "f-dont-know": ["routing_decision"],
  "f-kg-scaffold": ["kg_search_start", "kg_search_end"],
  "f-single-word": ["routing_decision"],
  // Right branches
  "f-wrong-answer": ["routing_decision"],
  "f-hybrid-wrong": ["hybrid_search_start", "hybrid_search_end"],
  "f-crag-decision": ["crag_reformulate", "hybrid_search_end"],
  "f-crag-reform": ["crag_reformulate"],
  "f-correct-no": ["routing_decision"],
  "f-hybrid-correct-no": ["hybrid_search_start", "hybrid_search_end"],
  "f-correct-wrong": ["routing_decision"],
  "f-hybrid-correct-wrong": ["hybrid_search_start", "hybrid_search_end"],
  "f-correct-good": ["routing_decision"],
  "f-hybrid-correct-good": ["hybrid_search_start", "hybrid_search_end"],
  "f-wrong-concept": ["routing_decision"],
  "f-kg-concept": ["kg_search_start", "kg_search_end"],
  // Converge
  "f-student-history": ["student_history_start", "student_history_end"],
  "f-build-augmentation": ["augmentation_built"],
  // Deterministic
  "f-deterministic-decision": ["deterministic_finish"],
  "f-finish-msg": ["deterministic_finish"],
  // LLM path
  "f-build-prompt": ["prompt_built"],
  "f-load-history": ["history_loaded"],
  "f-call-llm": ["ollama_call_start", "ollama_call_end"],
  // Guardrails
  "f-guardrail-leak": ["guardrail_leak"],
  "f-retry-leak": ["ollama_retry"],
  "f-guardrail-confirm": ["guardrail_false_confirm"],
  "f-retry-confirm": ["ollama_retry"],
  "f-guardrail-state": ["guardrail_state_reveal"],
  "f-retry-state": ["ollama_retry"],
  // Output
  "f-send-response": ["response_sent"],
  "f-save-mongodb": ["mongodb_save"],
  "f-log": ["log_written"],
  "f-end": ["request_end"],
  // Hybrid subprocess
  "f-embed": ["embedding_start", "embedding_end"],
  "f-bm25": ["bm25_search_start", "bm25_search_end"],
  "f-semantic": ["semantic_search_start", "semantic_search_end"],
  "f-rrf": ["rrf_fusion_start", "rrf_fusion_end"],
};

export default function FlowDiagram({ nodeStates, currentRequest, onSelectNode, eventLog }) {
  // Determine which classification branch is active
  var activeClassification = currentRequest ? currentRequest.classification : null;
  var activeBranchNode = activeClassification ? classificationToFlowNode[activeClassification] : null;

  // Build the set of allowed branch nodes for the current classification
  var allowedBranchNodes = useMemo(function () {
    if (!activeClassification || !classificationBranchNodes[activeClassification]) return {};
    var allowed = {};
    var nodes = classificationBranchNodes[activeClassification];
    for (var i = 0; i < nodes.length; i++) {
      allowed[nodes[i]] = true;
    }
    return allowed;
  }, [activeClassification]);

  // Build set of events seen in the current request + extract deterministic result
  var seenEventsResult = useMemo(function () {
    var seen = {};
    var detFinished = null; // null = not seen, true = finished, false = continue
    if (!eventLog || !currentRequest || !currentRequest.requestId) return { seen: seen, detFinished: detFinished };
    var reqId = currentRequest.requestId;
    for (var i = 0; i < eventLog.length; i++) {
      var ev = eventLog[i];
      if (ev.requestId !== reqId) continue;
      seen[ev.event] = true;
      // Extract deterministic finish result directly from the event
      if (ev.event === "deterministic_finish" && ev.data) {
        detFinished = ev.data.finished === true;
      }
    }
    return { seen: seen, detFinished: detFinished };
  }, [eventLog, currentRequest]);
  var seenEvents = seenEventsResult.seen;
  var deterministicFinished = seenEventsResult.detFinished;

  // Build set of active flow node IDs based on events actually received
  var activeFlowNodes = useMemo(function () {
    var active = {};
    if (!nodeStates) return active;

    for (var i = 0; i < flowNodes.length; i++) {
      var fNode = flowNodes[i];
      var pipelineNodeId = fNode.data.nodeId;
      if (!pipelineNodeId) continue;

      // Classification branch filtering
      if (allBranchNodeIds[fNode.id]) {
        if (!allowedBranchNodes[fNode.id]) continue;
      }

      // Deterministic branch filtering
      if (deterministicFinished !== null) {
        if (fNode.id === "f-finish-msg" && !deterministicFinished) continue;
        if (fNode.id === "f-build-prompt" && deterministicFinished) continue;
      }

      // Retry node filtering: only light up if corresponding guardrail triggered
      if (fNode.id === "f-retry-leak" && nodeStates["guardrail-leak"] && nodeStates["guardrail-leak"].status !== "error") continue;
      if (fNode.id === "f-retry-confirm" && nodeStates["guardrail-confirm"] && nodeStates["guardrail-confirm"].status !== "error") continue;
      if (fNode.id === "f-retry-state" && nodeStates["guardrail-state"] && nodeStates["guardrail-state"].status !== "error") continue;

      // Check if this flow node's triggering event has been seen
      var triggers = flowNodeTriggerEvents[fNode.id];
      if (triggers) {
        var triggered = false;
        for (var t = 0; t < triggers.length; t++) {
          if (seenEvents[triggers[t]]) {
            triggered = true;
            break;
          }
        }
        if (!triggered) continue;
      }

      var pipelineState = nodeStates[pipelineNodeId];
      if (pipelineState && pipelineState.status !== "idle") {
        active[fNode.id] = pipelineState.status;
      }
    }

    // Highlight classification branch node
    if (activeBranchNode) {
      active[activeBranchNode] = "completed";
    }

    return active;
  }, [nodeStates, activeBranchNode, allowedBranchNodes, seenEventsResult]);

  // Merge flow node states into node data
  var nodes = useMemo(function () {
    return flowNodes.map(function (node) {
      var pipelineNodeId = node.data.nodeId;
      var pipelineState = pipelineNodeId ? nodeStates[pipelineNodeId] : null;
      var flowStatus = activeFlowNodes[node.id] || "idle";

      // For decision nodes, show the active path
      var activePath = null;
      if (node.id === "f-classify-decision" && activeClassification) {
        activePath = activeClassification;
      }
      if (node.id === "f-deterministic-decision" && pipelineState && pipelineState.data) {
        activePath = pipelineState.data.finished ? "FINISH" : "continue";
      }
      if (node.id === "f-guardrail-leak" && pipelineState && pipelineState.data) {
        activePath = pipelineState.data.passed ? "PASS" : "TRIGGERED";
      }
      if (node.id === "f-guardrail-confirm" && pipelineState && pipelineState.data) {
        activePath = pipelineState.data.passed ? "PASS" : "TRIGGERED";
      }
      if (node.id === "f-guardrail-state" && pipelineState && pipelineState.data) {
        activePath = pipelineState.data.passed ? "PASS" : "TRIGGERED";
      }
      if (node.id === "f-crag-decision" && pipelineState && pipelineState.data) {
        activePath = pipelineState.data.reformulatedQuery ? "Yes" : "No";
      }

      return Object.assign({}, node, {
        data: Object.assign({}, node.data, {
          nodeState: pipelineState ? { status: flowStatus, data: pipelineState.data } : null,
          activePath: activePath,
        }),
      });
    });
  }, [nodeStates, activeFlowNodes, activeClassification]);

  // Highlight edges along the active path
  var edges = useMemo(function () {
    return flowEdges.map(function (edge) {
      var sourceActive = activeFlowNodes[edge.source];
      var targetActive = activeFlowNodes[edge.target];
      var isActive = sourceActive && sourceActive !== "idle" && targetActive && targetActive !== "idle";

      if (isActive) {
        return Object.assign({}, edge, {
          style: { stroke: "#22c55e", strokeWidth: 2.5 },
          animated: true,
          labelStyle: { fill: "#22c55e", fontSize: 9, fontWeight: 600 },
        });
      }
      return edge;
    });
  }, [activeFlowNodes]);

  var handleNodeClick = useCallback(function (_event, node) {
    // Select the linked pipeline node for detail inspection
    var pipelineNodeId = node.data.nodeId;
    if (pipelineNodeId && onSelectNode) {
      onSelectNode(pipelineNodeId);
    }
  }, [onSelectNode]);

  var handlePaneClick = useCallback(function () {
    if (onSelectNode) onSelectNode(null);
  }, [onSelectNode]);

  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      nodeTypes={flowNodeTypes}
      onNodeClick={handleNodeClick}
      onPaneClick={handlePaneClick}
      fitView
      fitViewOptions={{ padding: 0.15 }}
      minZoom={0.2}
      maxZoom={2}
      proOptions={{ hideAttribution: true }}
    >
      <Background color="#334155" gap={20} size={1} />
      <Controls
        style={{ background: "#ffffff", border: "1px solid #d1d5db", borderRadius: "6px" }}
        buttonStyle={{ color: "#000000", background: "#ffffff", border: "1px solid #e5e7eb" }}
      />
   { /*  <MiniMap
        style={{ background: "#1e293b", border: "1px solid #334155" }}
        nodeColor={function (node) {
          var status = activeFlowNodes[node.id];
          if (!status) return "#475569";
          var colors = { idle: "#475569", active: "#3b82f6", completed: "#22c55e", error: "#ef4444", skipped: "#64748b" };
          return colors[status] || "#475569";
        }}
      />*/}
    </ReactFlow>
  );
}
