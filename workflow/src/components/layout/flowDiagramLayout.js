// UML-like flow diagram layout showing all pipeline decision paths
// Vertical top-to-bottom flow with diamond decision nodes

var S = 90; // vertical spacing unit
var CX = 480; // center X for main flow column
var LX = 50; // left branches X
var RX = 850; // right branches X

export var flowNodes = [
  // ── Main flow (center column) ──
  { id: "f-start", position: { x: CX - 60, y: 0 }, type: "flowProcess", data: { label: "Student Message", rounded: true, nodeId: "frontend" } },
  { id: "f-middleware", position: { x: CX - 60, y: S }, type: "flowProcess", data: { label: "RAG Middleware", nodeId: "middleware" } },
  { id: "f-load-exercise", position: { x: CX - 80, y: S * 2 }, type: "flowProcess", data: { label: "Load Exercise (MongoDB)", nodeId: "mongodb" } },
  { id: "f-classifier", position: { x: CX - 60, y: S * 3 }, type: "flowProcess", data: { label: "Query Classifier", nodeId: "classifier" } },

  // Main decision diamond
  { id: "f-classify-decision", position: { x: CX - 60, y: S * 4 + 20 }, type: "flowDecision", data: { label: "Classification?", size: 120, nodeId: "classifier" } },

  // ── Left branches ──
  { id: "f-greeting", position: { x: LX, y: S * 4 - 30 }, type: "flowProcess", data: { label: "greeting", width: "100px", nodeId: "orchestrator", handleTargetRight: true, handleLeft: true } },
  { id: "f-no-rag", position: { x: LX - 200, y: S * 4 -30 }, type: "flowProcess", data: { label: "No RAG (pass-through)", nodeId: "orchestrator", handleTargetRight: true } },

  { id: "f-dont-know", position: { x: LX, y: S * 5 }, type: "flowProcess", data: { label: "dont_know", width: "100px", nodeId: "orchestrator", handleTargetRight: true, handleLeft: true } },
  { id: "f-kg-scaffold", position: { x: LX - 200, y: S * 5  }, type: "flowProcess", data: { label: "KG Search (scaffold)", nodeId: "knowledge-graph", handleTargetRight: true } },

  { id: "f-single-word", position: { x: LX, y: S * 7}, type: "flowProcess", data: { label: "single_word", width: "100px", nodeId: "orchestrator", handleTargetRight: true } },

  // ── Right branches ──
  { id: "f-wrong-answer", position: { x: RX, y: S * 4 - 30 }, type: "flowProcess", data: { label: "wrong_answer", width: "110px", nodeId: "orchestrator", handleTargetLeft: true, handleRight: true } },
  { id: "f-hybrid-wrong", position: { x: RX + 200, y: S * 4 - 30 }, type: "flowProcess", data: { label: "Hybrid Search", nodeId: "hybrid-search", handleRight: true, handleTargetLeft: true } },
  { id: "f-crag-decision", position: { x: RX + 400, y: S * 4-56 }, type: "flowDecision", data: { label: "CRAG score < threshold?", size: 95, nodeId: "crag", handleTargetLeft: true } },
  { id: "f-crag-reform", position: { x: RX + 380, y: S * 3 - 60 }, type: "flowProcess", data: { label: "CRAG Reformulate + Retry", nodeId: "crag", handleLeft: true, handleTargetRight: true } },

  { id: "f-correct-no", position: { x: RX, y: S * 5 }, type: "flowProcess", data: { label: "correct_no_reasoning", width: "145px", nodeId: "orchestrator", handleTargetLeft: true, handleRight: true } },
  { id: "f-hybrid-correct-no", position: { x: RX + 200, y: S * 5 }, type: "flowProcess", data: { label: "Hybrid Search", nodeId: "hybrid-search", handleTargetLeft: true } },

  { id: "f-correct-wrong", position: { x: RX, y: S * 6.5 }, type: "flowProcess", data: { label: "correct_wrong_reasoning", width: "160px", nodeId: "orchestrator", handleTargetLeft: true, handleRight: true } },
  { id: "f-hybrid-correct-wrong", position: { x: RX +200, y: S * 6.5 }, type: "flowProcess", data: { label: "Hybrid + KG Search", width: "135px", nodeId: "hybrid-search", handleTargetLeft: true } },

  { id: "f-correct-good", position: { x: RX, y: S * 8 }, type: "flowProcess", data: { label: "correct_good_reasoning", width: "155px", nodeId: "orchestrator", handleTargetLeft: true, handleRight: true } },
  { id: "f-hybrid-correct-good", position: { x: RX + 200, y: S *8 }, type: "flowProcess", data: { label: "Hybrid Search", nodeId: "hybrid-search", handleTargetLeft: true } },

  { id: "f-wrong-concept", position: { x: RX, y: S * 9.5 }, type: "flowProcess", data: { label: "wrong_concept", width: "115px", nodeId: "orchestrator", handleTargetLeft: true, handleRight: true } },
  { id: "f-kg-concept", position: { x: RX +200, y: S * 9.5 }, type: "flowProcess", data: { label: "KG + Hybrid Search", width: "135px", nodeId: "knowledge-graph", handleTargetLeft: true } },

  // ── Converge: all branches → student history → augmentation ──
  { id: "f-student-history", position: { x: CX - 75, y: S * 8 + 80 }, type: "flowProcess", data: { label: "Student History Lookup", nodeId: "student-history", handleTargetRight: true } },
  { id: "f-build-augmentation", position: { x: CX - 80, y: S * 9 + 100 }, type: "flowProcess", data: { label: "Build Final Augmentation", nodeId: "orchestrator" } },

  // ── Deterministic finish check ──
  { id: "f-deterministic-decision", position: { x: CX - 60, y: S * 11 }, type: "flowDecision", data: { label: "Deterministic Finish?", size: 120, nodeId: "deterministic" } },
  { id: "f-finish-msg", position: { x: LX + 20, y: S * 11 +50 }, type: "flowProcess", data: { label: "Send finish message", nodeId: "deterministic" } },

  // ── LLM call ──
  { id: "f-build-prompt", position: { x: CX - 70, y: S * 12 + 60 }, type: "flowProcess", data: { label: "Build System Prompt", nodeId: "middleware" } },
  { id: "f-load-history", position: { x: CX - 85, y: S * 13 + 60 }, type: "flowProcess", data: { label: "Load Conversation History", nodeId: "mongodb" } },
  { id: "f-call-llm", position: { x: CX - 95, y: S * 14 + 60 }, type: "flowProcess", data: { label: "Call PoliGPT (Ollama qwen2.5)", width: "185px", nodeId: "poligpt", handleTargetRight: true } },

  // ── Guardrail checks (diamonds + retry nodes) ──
  { id: "f-guardrail-leak", position: { x: CX - 50, y: S * 15 + 90 }, type: "flowDecision", data: { label: "Solution Leak?", size: 100, nodeId: "guardrail-leak" } },
  { id: "f-retry-leak", position: { x: CX + 160, y: S * 15 + 115 }, type: "flowProcess", data: { label: "Retry (stronger prompt)", nodeId: "poligpt", handleRight: true, handleTargetLeft: true } },

  { id: "f-guardrail-confirm", position: { x: CX - 50, y: S * 17 + 30 }, type: "flowDecision", data: { label: "False Confirm?", size: 100, nodeId: "guardrail-confirm" } },
  { id: "f-retry-confirm", position: { x: CX + 199, y: S * 17 + 55 }, type: "flowProcess", data: { label: "Retry (anti-confirm)", nodeId: "poligpt", handleRight: true, handleTargetLeft: true } },

  { id: "f-guardrail-state", position: { x: CX - 50, y: S * 19 - 30 }, type: "flowDecision", data: { label: "State Reveal?", size: 100, nodeId: "guardrail-state" } },
  { id: "f-retry-state", position: { x: CX + 240, y: S * 19 -5 }, type: "flowProcess", data: { label: "Retry (anti-state)", nodeId: "poligpt", handleRight: true, handleTargetLeft: true } },

  // ── Output ──
  { id: "f-send-response", position: { x: CX - 70, y: S * 20 + 30 }, type: "flowProcess", data: { label: "Send Response (SSE)", nodeId: "response" } },
  { id: "f-save-mongodb", position: { x: CX - 62, y: S * 21 + 30 }, type: "flowProcess", data: { label: "Save to MongoDB", nodeId: "mongodb" } },
  { id: "f-log", position: { x: CX - 60, y: S * 22 + 30 }, type: "flowProcess", data: { label: "Log to JSONL", nodeId: "logger" } },
  { id: "f-end", position: { x: CX - 58, y: S * 23 + 30 }, type: "flowProcess", data: { label: "End", rounded: true, nodeId: "middleware", handleTargetLeft: true } },

  // ── Hybrid Search subprocess detail (far left, beside LLM flow) ──
  { id: "f-embed", position: { x: LX + 20, y: S * 13 - 10 }, type: "flowProcess", data: { label: "Generate Embedding", nodeId: "embedding", width: "135px" } },
  { id: "f-bm25", position: { x: LX - 20, y: S * 14 - 10 }, type: "flowProcess", data: { label: "BM25 Search", nodeId: "bm25" } },
  { id: "f-semantic", position: { x: LX + 150, y: S * 14 - 10 }, type: "flowProcess", data: { label: "Semantic (ChromaDB)", nodeId: "chromadb", width: "135px" } },
  { id: "f-rrf", position: { x: LX + 50, y: S * 15 - 10 }, type: "flowProcess", data: { label: "RRF Fusion", nodeId: "rrf" } },
];

// Edge colors for active/inactive
var defaultEdge = { style: { stroke: "#475569", strokeWidth: 1.5 }, labelStyle: { fill: "#64748b", fontSize: 9 } };
var activeEdge = { style: { stroke: "#22c55e", strokeWidth: 2 }, animated: true };

export var flowEdges = [
  // Main flow
  { id: "fe-start-mid", source: "f-start", target: "f-middleware", ...defaultEdge },
  { id: "fe-mid-load", source: "f-middleware", target: "f-load-exercise", ...defaultEdge },
  { id: "fe-load-class", source: "f-load-exercise", target: "f-classifier", ...defaultEdge },
  { id: "fe-class-decision", source: "f-classifier", target: "f-classify-decision", ...defaultEdge },

  // Decision branches (left side)
  { id: "fe-decision-greeting", source: "f-classify-decision", sourceHandle: "left", target: "f-greeting", targetHandle: "target-right", ...defaultEdge, label: "greeting" },
  { id: "fe-greeting-norag", source: "f-greeting", sourceHandle: "left", target: "f-no-rag", targetHandle: "target-right", ...defaultEdge },

  { id: "fe-decision-dontknow", source: "f-classify-decision", sourceHandle: "left", target: "f-dont-know", targetHandle: "target-right", ...defaultEdge, label: "dont_know" },
  { id: "fe-dontknow-kg", source: "f-dont-know", sourceHandle: "left", target: "f-kg-scaffold", targetHandle: "target-right", ...defaultEdge },

  { id: "fe-decision-single", source: "f-classify-decision", sourceHandle: "left", target: "f-single-word", targetHandle: "target-right", ...defaultEdge, label: "single_word" },

  // Decision branches (right side)
  { id: "fe-decision-wrong", source: "f-classify-decision", sourceHandle: "right", target: "f-wrong-answer", targetHandle: "target-left", ...defaultEdge, label: "wrong_answer" },
  { id: "fe-wrong-hybrid", source: "f-wrong-answer", sourceHandle: "right", target: "f-hybrid-wrong", targetHandle: "target-left", ...defaultEdge },
  { id: "fe-hybrid-crag", source: "f-hybrid-wrong", sourceHandle: "right", target: "f-crag-decision", targetHandle: "target-left", ...defaultEdge },
  { id: "fe-crag-yes", source: "f-crag-decision", sourceHandle: "right", target: "f-crag-reform", targetHandle: "target-right", type: "smoothstep", ...defaultEdge, label: "Yes" },
  { id: "fe-crag-retry", source: "f-crag-reform", sourceHandle: "left", target: "f-hybrid-wrong", type: "smoothstep", ...defaultEdge, label: "retry" },
  { id: "fe-crag-no", source: "f-crag-decision", target: "f-student-history", targetHandle: "target-right", type: "smoothstep", ...defaultEdge, label: "No (score OK)" },

  { id: "fe-decision-correctno", source: "f-classify-decision", sourceHandle: "right", target: "f-correct-no", targetHandle: "target-left", ...defaultEdge, label: "correct_no_reasoning" },
  { id: "fe-correctno-hybrid", source: "f-correct-no", sourceHandle: "right", target: "f-hybrid-correct-no", targetHandle: "target-left", ...defaultEdge },

  { id: "fe-decision-correctwrong", source: "f-classify-decision", sourceHandle: "right", target: "f-correct-wrong", targetHandle: "target-left", ...defaultEdge, label: "correct_wrong_reasoning" },
  { id: "fe-correctwrong-hybrid", source: "f-correct-wrong", sourceHandle: "right", target: "f-hybrid-correct-wrong", targetHandle: "target-left", ...defaultEdge },

  { id: "fe-decision-correctgood", source: "f-classify-decision", sourceHandle: "right", target: "f-correct-good", targetHandle: "target-left", ...defaultEdge, label: "correct_good_reasoning" },
  { id: "fe-correctgood-hybrid", source: "f-correct-good", sourceHandle: "right", target: "f-hybrid-correct-good", targetHandle: "target-left", ...defaultEdge },

  { id: "fe-decision-wrongconcept", source: "f-classify-decision", sourceHandle: "right", target: "f-wrong-concept", targetHandle: "target-left", ...defaultEdge, label: "wrong_concept" },
  { id: "fe-wrongconcept-kg", source: "f-wrong-concept", sourceHandle: "right", target: "f-kg-concept", targetHandle: "target-left", ...defaultEdge },

  // Converge into student history + augmentation
  { id: "fe-decision-history", source: "f-classify-decision", target: "f-student-history", ...defaultEdge },
  { id: "fe-history-augment", source: "f-student-history", target: "f-build-augmentation", ...defaultEdge },

  // Deterministic check
  { id: "fe-augment-deterministic", source: "f-build-augmentation", target: "f-deterministic-decision", ...defaultEdge },
  { id: "fe-deterministic-yes", source: "f-deterministic-decision", sourceHandle: "left", target: "f-finish-msg", ...defaultEdge, label: "Yes (finish)" },
  { id: "fe-finish-end", source: "f-finish-msg", target: "f-end", targetHandle: "target-left", type: "smoothstep", ...defaultEdge },

  // LLM path
  { id: "fe-deterministic-no", source: "f-deterministic-decision", target: "f-build-prompt", ...defaultEdge, label: "No" },
  { id: "fe-prompt-history", source: "f-build-prompt", target: "f-load-history", ...defaultEdge },
  { id: "fe-history-llm", source: "f-load-history", target: "f-call-llm", ...defaultEdge },

  // Guardrails
  { id: "fe-llm-gleak", source: "f-call-llm", target: "f-guardrail-leak", ...defaultEdge },
  { id: "fe-gleak-retry", source: "f-guardrail-leak", sourceHandle: "right", target: "f-retry-leak", targetHandle: "target-left", ...defaultEdge, label: "TRIGGERED" },
  { id: "fe-retryleak-llm", source: "f-retry-leak", sourceHandle: "right", target: "f-call-llm", targetHandle: "target-right", type: "smoothstep", ...defaultEdge, label: "retry" },
  { id: "fe-gleak-pass", source: "f-guardrail-leak", target: "f-guardrail-confirm", ...defaultEdge, label: "PASS" },

  { id: "fe-gconfirm-retry", source: "f-guardrail-confirm", sourceHandle: "right", target: "f-retry-confirm", targetHandle: "target-left", ...defaultEdge, label: "TRIGGERED" },
  { id: "fe-retryconfirm-llm", source: "f-retry-confirm", sourceHandle: "right", target: "f-call-llm", targetHandle: "target-right", type: "smoothstep", ...defaultEdge, label: "retry" },
  { id: "fe-gconfirm-pass", source: "f-guardrail-confirm", target: "f-guardrail-state", ...defaultEdge, label: "PASS" },

  { id: "fe-gstate-retry", source: "f-guardrail-state", sourceHandle: "right", target: "f-retry-state", targetHandle: "target-left", ...defaultEdge, label: "TRIGGERED" },
  { id: "fe-retrystate-llm", source: "f-retry-state", sourceHandle: "right", target: "f-call-llm", targetHandle: "target-right", type: "smoothstep", ...defaultEdge, label: "retry" },
  { id: "fe-gstate-pass", source: "f-guardrail-state", target: "f-send-response", ...defaultEdge, label: "PASS" },

  // Output
  { id: "fe-response-mongo", source: "f-send-response", target: "f-save-mongodb", ...defaultEdge },
  { id: "fe-mongo-log", source: "f-save-mongodb", target: "f-log", ...defaultEdge },
  { id: "fe-log-end", source: "f-log", target: "f-end", ...defaultEdge },

  // Hybrid Search subprocess edges
  { id: "fe-embed-bm25", source: "f-embed", target: "f-bm25", ...defaultEdge },
  { id: "fe-embed-sem", source: "f-embed", target: "f-semantic", ...defaultEdge },
  { id: "fe-bm25-rrf", source: "f-bm25", target: "f-rrf", ...defaultEdge },
  { id: "fe-sem-rrf", source: "f-semantic", target: "f-rrf", ...defaultEdge },
];

// Maps flow node IDs to their linked pipeline node IDs (for state lookup)
export var flowNodeToNodeId = {};
for (var i = 0; i < flowNodes.length; i++) {
  if (flowNodes[i].data.nodeId) {
    flowNodeToNodeId[flowNodes[i].id] = flowNodes[i].data.nodeId;
  }
}

// Maps pipeline events to flow nodes that should be highlighted
export var eventToFlowNodes = {
  request_start: ["f-start", "f-middleware"],
  exercise_loaded: ["f-load-exercise"],
  classify_start: ["f-classifier"],
  classify_end: ["f-classifier"],
  routing_decision: [], // handled specially based on path
  pipeline_start: [],
  pipeline_end: [],
  no_rag: ["f-no-rag"],
  kg_search_start: ["f-kg-scaffold", "f-kg-concept"],
  kg_search_end: ["f-kg-scaffold", "f-kg-concept"],
  hybrid_search_start: ["f-hybrid-wrong", "f-hybrid-correct-no", "f-hybrid-correct-wrong", "f-hybrid-correct-good"],
  hybrid_search_end: ["f-hybrid-wrong", "f-hybrid-correct-no", "f-hybrid-correct-wrong", "f-hybrid-correct-good"],
  embedding_start: ["f-embed"],
  embedding_end: ["f-embed"],
  bm25_search_start: ["f-bm25"],
  bm25_search_end: ["f-bm25"],
  semantic_search_start: ["f-semantic"],
  semantic_search_end: ["f-semantic"],
  rrf_fusion_start: ["f-rrf"],
  rrf_fusion_end: ["f-rrf"],
  crag_reformulate: ["f-crag-reform", "f-crag-decision"],
  student_history_start: ["f-student-history"],
  student_history_end: ["f-student-history"],
  augmentation_built: ["f-build-augmentation"],
  deterministic_finish: ["f-deterministic-decision"],
  prompt_built: ["f-build-prompt"],
  history_loaded: ["f-load-history"],
  ollama_call_start: ["f-call-llm"],
  ollama_call_end: ["f-call-llm"],
  guardrail_leak: ["f-guardrail-leak"],
  guardrail_false_confirm: ["f-guardrail-confirm"],
  guardrail_state_reveal: ["f-guardrail-state"],
  ollama_retry: ["f-retry-leak", "f-retry-confirm", "f-retry-state"],
  response_sent: ["f-send-response"],
  mongodb_save: ["f-save-mongodb"],
  log_written: ["f-log"],
  request_end: ["f-end"],
};

// Classification type → flow node for that branch
export var classificationToFlowNode = {
  greeting: "f-greeting",
  dont_know: "f-dont-know",
  single_word: "f-single-word",
  wrong_answer: "f-wrong-answer",
  correct_no_reasoning: "f-correct-no",
  correct_wrong_reasoning: "f-correct-wrong",
  correct_good_reasoning: "f-correct-good",
  wrong_concept: "f-wrong-concept",
};

// Branch-specific flow nodes per classification type
// Only these nodes should light up for the given classification
export var classificationBranchNodes = {
  greeting: ["f-greeting", "f-no-rag"],
  dont_know: ["f-dont-know", "f-kg-scaffold"],
  single_word: ["f-single-word"],
  wrong_answer: ["f-wrong-answer", "f-hybrid-wrong", "f-crag-decision", "f-crag-reform"],
  correct_no_reasoning: ["f-correct-no", "f-hybrid-correct-no"],
  correct_wrong_reasoning: ["f-correct-wrong", "f-hybrid-correct-wrong"],
  correct_good_reasoning: ["f-correct-good", "f-hybrid-correct-good"],
  wrong_concept: ["f-wrong-concept", "f-kg-concept"],
};

// Set of ALL branch-specific node IDs (nodes that should only highlight on their branch)
export var allBranchNodeIds = {};
var branchKeys = Object.keys(classificationBranchNodes);
for (var bi = 0; bi < branchKeys.length; bi++) {
  var branchList = classificationBranchNodes[branchKeys[bi]];
  for (var bj = 0; bj < branchList.length; bj++) {
    allBranchNodeIds[branchList[bj]] = true;
  }
}
