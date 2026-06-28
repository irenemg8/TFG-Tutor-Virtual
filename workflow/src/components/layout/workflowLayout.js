// Component Graph layout: UML deployment-style diagram
// Vertical main spine · orthogonal edge routing · clear corridors between sections
//
// Corridor map (vertical gaps where long edges route without crossing nodes):
//   x ≈ 310-340  left corridor  (between Knowledge Base and Hybrid Search)
//   x ≈ 810-860  right corridor (between Hybrid Search and Student Context)
//   y ≈ 390-420  horizontal gap (between Pipeline Core and Retrieval)
//   y ≈ 760-795  horizontal gap (between Retrieval and Generation)
//   y ≈ 890-920  horizontal gap (between Generation and Safety)
//   y ≈ 1035-1065 horizontal gap (between Safety and Output)

// ── Grid constants ──
var W = 1200;
var X0 = 30;
var CX = 420; // center X for main vertical spine

// Row Y positions
var R0 = 0;
var R1 = 115;
var R2 = 420;
var R3 = 795;
var R4 = 920;
var R5 = 1065;

// ── SECTION BACKGROUND NODES ──
var sections = [
  { id: "sec-external", position: { x: X0, y: R0 }, type: "sectionGroup",
    data: { label: "External Services", borderColor: "#7c3aed", labelColor: "#c4b5fd", bgColor: "rgba(124, 58, 237, 0.06)" },
    style: { width: W, height: 85 }, zIndex: -1 },

  { id: "sec-pipeline", position: { x: CX - 140, y: R1 }, type: "sectionGroup",
    data: { label: "Pipeline Core", subtitle: "Request processing, classification & orchestration", borderColor: "#0d9488", labelColor: "#5eead4", bgColor: "rgba(13, 148, 136, 0.07)" },
    style: { width: 340, height: 270 }, zIndex: -1 },

  { id: "sec-knowledge", position: { x: 45, y: R2 }, type: "sectionGroup",
    data: { label: "Knowledge Base", subtitle: "Graph-based concept retrieval", borderColor: "#7c3aed", labelColor: "#c4b5fd", bgColor: "rgba(124, 58, 237, 0.05)" },
    style: { width: 260, height: 330 }, zIndex: -1 },

  { id: "sec-hybrid", position: { x: 345, y: R2 }, type: "sectionGroup",
    data: { label: "Hybrid Search Engine", subtitle: "BM25 + Semantic + RRF fusion + CRAG reformulation", borderColor: "#d97706", labelColor: "#fcd34d", bgColor: "rgba(217, 119, 6, 0.05)" },
    style: { width: 465, height: 330 }, zIndex: -1 },

  { id: "sec-context", position: { x: 860, y: R2 }, type: "sectionGroup",
    data: { label: "Student Context", subtitle: "Conversation history & personalization", borderColor: "#0369a1", labelColor: "#7dd3fc", bgColor: "rgba(3, 105, 161, 0.05)" },
    style: { width: 310, height: 330 }, zIndex: -1 },

  { id: "sec-generation", position: { x: X0, y: R3 }, type: "sectionGroup",
    data: { label: "Generation", subtitle: "Deterministic check + LLM inference (Ollama qwen2.5)", borderColor: "#2563eb", labelColor: "#93c5fd", bgColor: "rgba(37, 99, 235, 0.06)" },
    style: { width: W, height: 90 }, zIndex: -1 },

  { id: "sec-safety", position: { x: X0, y: R4 }, type: "sectionGroup",
    data: { label: "Safety Guardrails", subtitle: "Sequential triple-check: leak \u2192 confirm \u2192 state", borderColor: "#dc2626", labelColor: "#fca5a5", bgColor: "rgba(220, 38, 38, 0.05)" },
    style: { width: W, height: 110 }, zIndex: -1 },

  { id: "sec-output", position: { x: X0, y: R5 }, type: "sectionGroup",
    data: { label: "Output", subtitle: "Response delivery & interaction logging", borderColor: "#16a34a", labelColor: "#86efac", bgColor: "rgba(22, 163, 74, 0.05)" },
    style: { width: W, height: 85 }, zIndex: -1 },
];

// ── COMPONENT NODES ──
// Nodes are placed so edges route through corridors, not through other nodes.
var components = [
  // ─── External Services ───
  { id: "frontend", position: { x: CX - 60, y: R0 + 22 }, type: "externalService",
    data: { label: "Student (Frontend)", icon: "user" } },
  { id: "mongodb", position: { x: 900, y: R0 + 22 }, type: "externalService",
    data: { label: "MongoDB Atlas", icon: "database" } },

  // ─── Pipeline Core (vertical spine) ───
  { id: "middleware", position: { x: CX - 60, y: R1 + 30 }, type: "pipelineStep",
    data: { label: "RAG Middleware" } },
  { id: "classifier", position: { x: CX - 60, y: R1 + 115 }, type: "pipelineStep",
    data: { label: "Query Classifier" } },
  { id: "orchestrator", position: { x: CX - 60, y: R1 + 195 }, type: "pipelineStep",
    data: { label: "Pipeline Orchestrator" } },

  // ─── Knowledge Base (left, x 80–250) ───
  { id: "kg-data", position: { x: 85, y: R2 + 45 }, type: "documentNode",
    data: { label: "KG Data (JSON)", subtitle: "concepts & relations" } },
  { id: "knowledge-graph", position: { x: 85, y: R2 + 190 }, type: "pipelineStep",
    data: { label: "Knowledge Graph" } },

  // ─── Hybrid Search Engine (center, x 380–780) ───
  { id: "hybrid-search", position: { x: 390, y: R2 + 45 }, type: "pipelineStep",
    data: { label: "Hybrid Search" } },
  { id: "datasets", position: { x: 640, y: R2 + 45 }, type: "documentNode",
    data: { label: "Datasets (CSV)", subtitle: "pre-indexed exercises" } },
  { id: "embedding", position: { x: 580, y: R2 + 125 }, type: "algorithmNode",
    data: { label: "Embedding Generator" } },
  { id: "bm25", position: { x: 390, y: R2 + 200 }, type: "algorithmNode",
    data: { label: "BM25 Search" } },
  { id: "chromadb", position: { x: 630, y: R2 + 200 }, type: "externalService",
    data: { label: "ChromaDB Semantic", icon: "vector" } },
  { id: "rrf", position: { x: 530, y: R2 + 275 }, type: "algorithmNode",
    data: { label: "RRF Fusion" } },
  { id: "crag", position: { x: 380, y: R2 + 275 }, type: "algorithmNode",
    data: { label: "CRAG Reformulation" } },

  // ─── Student Context (right, x 910+) ───
  { id: "student-history", position: { x: 910, y: R2 + 115 }, type: "pipelineStep",
    data: { label: "Student History" } },

  // ─── Generation ───
  { id: "deterministic", position: { x: 155, y: R3 + 22 }, type: "pipelineStep",
    data: { label: "Deterministic Finish" } },
  { id: "poligpt", position: { x: 530, y: R3 + 22 }, type: "externalService",
    data: { label: "PoliGPT (Ollama qwen2.5)", icon: "llm" } },

  // ─── Safety Guardrails (centered under PoliGPT, sequential) ───
  { id: "guardrail-leak", position: { x: 340, y: R4 + 30 }, type: "guardrailNode",
    data: { label: "Solution Leak" } },
  { id: "guardrail-confirm", position: { x: 555, y: R4 + 30 }, type: "guardrailNode",
    data: { label: "False Confirmation" } },
  { id: "guardrail-state", position: { x: 770, y: R4 + 30 }, type: "guardrailNode",
    data: { label: "State Reveal" } },

  // ─── Output ───
  { id: "response", position: { x: 380, y: R5 + 20 }, type: "pipelineStep",
    data: { label: "Response (SSE)" } },
  { id: "logger", position: { x: 720, y: R5 + 20 }, type: "pipelineStep",
    data: { label: "JSONL Logger" } },
];

export var initialNodes = sections.concat(components);

// ── EDGES ──
// Smooth-step orthogonal routing with lateral handles.
// Edges route through the designated corridors (see top comment).

function edge(id, source, target, label, extra) {
  var e = {
    id: id,
    source: source,
    target: target,
    type: "animated",
    style: { stroke: "#475569", strokeWidth: 1.5 },
  };
  if (label) e.label = label;
  if (extra) Object.assign(e, extra);
  return e;
}

export var initialEdges = [
  // ═══════════════════════════════════════
  // MAIN VERTICAL SPINE (straight down)
  // ═══════════════════════════════════════
  edge("e-frontend-middleware", "frontend", "middleware", null,
    { sourceHandle: "bottom", targetHandle: "top" }),
  edge("e-middleware-classifier", "middleware", "classifier", null,
    { sourceHandle: "bottom", targetHandle: "top" }),
  edge("e-classifier-orchestrator", "classifier", "orchestrator", null,
    { sourceHandle: "bottom", targetHandle: "top" }),

  // ═══════════════════════════════════════
  // MIDDLEWARE → MONGODB (horizontal right, above Pipeline Core)
  // Route: right from MW → up through gap → left into MongoDB
  // ═══════════════════════════════════════
  edge("e-middleware-mongodb", "middleware", "mongodb", "load / save",
    { sourceHandle: "right-source", targetHandle: "left" }),

  // ═══════════════════════════════════════
  // ORCHESTRATOR FAN-OUT → RETRIEVAL
  // ═══════════════════════════════════════
  // Left: through left corridor (x ≈ 320) down to KG
  edge("e-orchestrator-kg", "orchestrator", "knowledge-graph", "scaffold / concept",
    { sourceHandle: "left-source", targetHandle: "top" }),
  // Center: straight down into Hybrid Search
  edge("e-orchestrator-hybrid", "orchestrator", "hybrid-search", "rag_examples",
    { sourceHandle: "bottom", targetHandle: "top" }),
  // Right: horizontal right at y ≈ 335 (above retrieval zone), then down
  edge("e-orchestrator-history", "orchestrator", "student-history", null,
    { sourceHandle: "right-source", targetHandle: "top" }),

  // ═══════════════════════════════════════
  // KNOWLEDGE BASE (vertical, left column)
  // ═══════════════════════════════════════
  edge("e-kgdata-kg", "kg-data", "knowledge-graph", null,
    { sourceHandle: "bottom", targetHandle: "top" }),

  // ═══════════════════════════════════════
  // HYBRID SEARCH ENGINE (internal routing)
  // ═══════════════════════════════════════
  // Runtime query flow
  edge("e-hybrid-embedding", "hybrid-search", "embedding", null,
    { sourceHandle: "right-source", targetHandle: "left" }),
  edge("e-hybrid-bm25", "hybrid-search", "bm25", null,
    { sourceHandle: "bottom", targetHandle: "top" }),
  edge("e-embedding-chromadb", "embedding", "chromadb", null,
    { sourceHandle: "bottom", targetHandle: "top" }),

  // Pre-indexed data (offline ingest, dashed)
  edge("e-datasets-bm25", "datasets", "bm25", "pre-indexed",
    { sourceHandle: "left-source", targetHandle: "right",
      style: { stroke: "#92400e", strokeWidth: 1, strokeDasharray: "4 4" } }),
  edge("e-datasets-chromadb", "datasets", "chromadb", "pre-indexed",
    { sourceHandle: "bottom", targetHandle: "top",
      style: { stroke: "#92400e", strokeWidth: 1, strokeDasharray: "4 4" } }),

  // Fusion: BM25 and ChromaDB feed into RRF from opposite sides
  edge("e-bm25-rrf", "bm25", "rrf", null,
    { sourceHandle: "right-source", targetHandle: "left" }),
  edge("e-chromadb-rrf", "chromadb", "rrf", null,
    { sourceHandle: "left-source", targetHandle: "right" }),

  // CRAG reformulation (conditional low score)
  edge("e-rrf-crag", "rrf", "crag", "low score",
    { sourceHandle: "left-source", targetHandle: "right" }),
  edge("e-crag-hybrid", "crag", "hybrid-search", "retry",
    { sourceHandle: "left-source", targetHandle: "left",
      style: { stroke: "#f59e0b", strokeWidth: 1.2, strokeDasharray: "6 3" } }),

  // ═══════════════════════════════════════
  // STUDENT CONTEXT → MONGODB (right corridor, up)
  // ═══════════════════════════════════════
  edge("e-history-mongodb", "student-history", "mongodb", "load history",
    { sourceHandle: "right-source", targetHandle: "right" }),

  // ═══════════════════════════════════════
  // GENERATION
  // Left corridor (x ≈ 320) carries MW → Deterministic
  // ═══════════════════════════════════════
  edge("e-middleware-deterministic", "middleware", "deterministic", null,
    { sourceHandle: "left-source", targetHandle: "top" }),
  edge("e-deterministic-poligpt", "deterministic", "poligpt", "build prompt",
    { sourceHandle: "right-source", targetHandle: "left" }),
  // Direct finish shortcut (routes along far-left margin)
  edge("e-deterministic-response", "deterministic", "response", "finished",
    { sourceHandle: "left-source", targetHandle: "left",
      style: { stroke: "#22c55e", strokeWidth: 1.2, strokeDasharray: "6 3" } }),

  // ═══════════════════════════════════════
  // GUARDRAILS (sequential left → right)
  // Centered under PoliGPT so forward edges are short
  // ═══════════════════════════════════════
  edge("e-poligpt-gleak", "poligpt", "guardrail-leak", null,
    { sourceHandle: "bottom", targetHandle: "top" }),
  edge("e-gleak-gconfirm", "guardrail-leak", "guardrail-confirm", "pass",
    { sourceHandle: "right-source", targetHandle: "left" }),
  edge("e-gconfirm-gstate", "guardrail-confirm", "guardrail-state", "pass",
    { sourceHandle: "right-source", targetHandle: "left" }),

  // Retry loops (dashed red, back up to PoliGPT)
  edge("e-gleak-retry", "guardrail-leak", "poligpt", "retry",
    { sourceHandle: "top-source", targetHandle: "bottom-target",
      style: { stroke: "#ef4444", strokeWidth: 1.2, strokeDasharray: "6 3" } }),
  edge("e-gconfirm-retry", "guardrail-confirm", "poligpt", "retry",
    { sourceHandle: "top-source", targetHandle: "bottom-target",
      style: { stroke: "#ef4444", strokeWidth: 1.2, strokeDasharray: "6 3" } }),
  edge("e-gstate-retry", "guardrail-state", "poligpt", "retry",
    { sourceHandle: "top-source", targetHandle: "right",
      style: { stroke: "#ef4444", strokeWidth: 1.2, strokeDasharray: "6 3" } }),

  // ═══════════════════════════════════════
  // OUTPUT
  // ═══════════════════════════════════════
  edge("e-gstate-response", "guardrail-state", "response", "all pass",
    { sourceHandle: "bottom", targetHandle: "top" }),
  edge("e-response-logger", "response", "logger", null,
    { sourceHandle: "right-source", targetHandle: "left" }),
  // Return to frontend (routes up through left corridor x ≈ 310)
  edge("e-response-frontend", "response", "frontend", "SSE stream",
    { sourceHandle: "left-source", targetHandle: "left",
      style: { stroke: "#22c55e", strokeWidth: 1.2, strokeDasharray: "6 3" } }),
];
