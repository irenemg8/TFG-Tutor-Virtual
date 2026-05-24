# Workflow Monitor

The workflow monitor is a standalone React application that provides real-time visualization of the RAG pipeline as it processes student messages. It connects to the backend via WebSocket and displays every step, decision, and parameter in an interactive graph.

This is a **developer and debugging tool** — not part of the student-facing interface. It allows developers to observe exactly what the RAG system does internally for each request.

---

## Table of Contents

1. [Architecture](#architecture)
2. [Technology Stack](#technology-stack)
3. [Component Graph View](#component-graph-view)
4. [Flow Diagram View](#flow-diagram-view)
5. [Panels](#panels)
6. [WebSocket Hook](#websocket-hook)
7. [Node Types](#node-types)
8. [Edge System](#edge-system)
9. [Layout Design](#layout-design)
10. [File Structure](#file-structure)

---

## Architecture

```
Backend (port 3000)                    Workflow Monitor (port 5174)
┌─────────────────────┐               ┌─────────────────────────────┐
│  RAG Middleware     │               │  React App                  │
│  RAG Pipeline       │──emit──►      │                             │
│  Hybrid Search      │    │          │  ┌────────────────────────┐ │
│         │           │    │          │  │ Component Graph (React │ │
│    ragEventBus.js   │    │          │  │ Flow) with animated    │ │
│         │           │    │          │  │ nodes and edges        │ │
│  workflowSocket.js ─│── ws ──────►  │  └────────────────────────┘ │
│  (WebSocket server) │               │  ┌────────────────────────┐ │
│  /ws/workflow       │               │  │ Event Log, Node Detail,│ │
└─────────────────────┘               │  │ Timing, History panels │ │
                                      │  └────────────────────────┘ │
                                      │                             │
                                      │  useWorkflowSocket.js       │
                                      │  (WebSocket client)         │
                                      └─────────────────────────────┘
```

The data flow:

1. RAG modules (`ragMiddleware.js`, `ragPipeline.js`, `hybridSearch.js`) call `emitEvent()` at every significant step
2. `ragEventBus.js` broadcasts each event on a Node.js `EventEmitter`
3. `workflowSocket.js` listens to the event bus and forwards all events to connected WebSocket clients
4. The workflow monitor's `useWorkflowSocket` hook receives events and updates the React state
5. React components re-render to show the current pipeline state

---

## Technology Stack

| Technology | Version | Purpose |
|---|---|---|
| React | 19 | UI framework |
| Vite | 6 | Build tool and dev server |
| @xyflow/react | 12 (React Flow) | Node-based graph visualization |
| WebSocket (native) | — | Real-time event streaming from backend |

The workflow monitor is a separate Vite project in the `workflow/` directory, completely independent from the main frontend. It runs on port 5174.

---

## Component Graph View

The primary visualization is an interactive node graph built with React Flow. It displays every RAG component as a node, connected by edges that represent data flow.

### What You See

When a student sends a message, nodes light up in sequence as the pipeline progresses:

1. **Student (Frontend)** node activates → the request has arrived
2. **RAG Middleware** activates → request validation and exercise loading
3. **Query Classifier** activates → message classification
4. **Pipeline Orchestrator** activates → routing decision made
5. Depending on the route, retrieval nodes activate:
   - **Knowledge Graph** (for scaffold/concept routes)
   - **Hybrid Search** → **Embedding Generator** → **BM25 Search** + **ChromaDB Semantic** → **RRF Fusion**
   - **CRAG Reformulation** (only if retrieval quality is low)
   - **Student History** (loads past errors)
6. **Deterministic Finish** checks if the exercise can end
7. **PoliGPT (Ollama)** activates → LLM generates a response
8. **Guardrails** activate sequentially: Solution Leak → False Confirmation → Premature Confirmation → State Reveal → Element Naming
9. **Response (SSE)** activates → response sent to student
10. **JSONL Logger** activates → interaction logged

Each node shows real-time parameter data — scores, result counts, durations, classification types, and more. Clicking a node shows its full parameter detail in the bottom panel.

### Node Visual States

| State | Appearance | Meaning |
|---|---|---|
| **Idle** | Gray border, dim background | Not yet activated in the current request |
| **Active** | Blue/amber border, pulse animation, glow | Currently processing |
| **Completed** | Green border, bright background | Finished successfully |
| **Error** | Red border, red glow | Error occurred or guardrail triggered |
| **Skipped** | Dashed border, muted colors | Not used in the current routing path |

---

## Flow Diagram View

The secondary visualization shows the pipeline as a sequential flowchart. It dynamically builds a vertical list of steps based on the events received for the current request.

The flow diagram displays:
- Each pipeline step with its classification and routing decision
- Branch paths showing which retrieval strategy was chosen
- Active highlighting for the currently executing step
- Node selection (click a step to see details in the bottom panel)

Switch between Component Graph and Flow Diagram using the tabs in the top bar.

---

## Panels

### RequestInfo (Top Bar)

Displays the current request's metadata:

- **Connection status**: Green dot when connected, red when disconnected
- **Request ID**: Unique identifier for the current request
- **User message**: What the student said
- **Exercise number**: Which exercise is being worked on
- **Classification**: How the message was classified (e.g., "wrong_answer")
- **Routing decision**: Which retrieval path was chosen (e.g., "rag_examples")
- **Elapsed time**: Live timer showing how long the current request has been processing (updates every 100ms)

### RequestHistory (Left Sidebar)

A scrollable list of all past requests in the current session. Each entry shows the request ID, user message preview, classification, and timing. This allows reviewing past requests without losing the current state.

### EventLog (Right Sidebar)

A chronological list of all events emitted by the backend for the current request. Each event shows:

- **Timestamp**: Relative time since request start (e.g., "+342ms")
- **Event name**: e.g., "bm25_search_end"
- **Status badge**: Color-coded (blue for start, green for end, red for error)
- **Data preview**: Key parameters (e.g., "3 results, top=0.423")

Events are expandable — click an event to see its full data payload in JSON format. The log supports filtering by event type.

### NodeDetail (Bottom Panel)

When a node is clicked in the graph, the bottom panel shows its complete parameter detail:

- **Input parameters**: Everything passed to the function (query, exercise number, thresholds, etc.)
- **Output results**: Everything returned (result count, top score, classification type, etc.)
- **Timing**: Duration in milliseconds
- **Additional data**: Config values, formulas used, intermediate calculations

The panel displays data in structured tables with labeled key-value pairs. Complex data (arrays of results, breakdown tables) are shown in scrollable sub-sections.

### TimingBar (Above NodeDetail)

A horizontal stacked bar showing the time breakdown of the current request. Each segment represents a pipeline stage:

| Segment | Color | What It Measures |
|---|---|---|
| Classification | Teal | Time spent classifying the query |
| Retrieval | Amber | Time for hybrid search + CRAG |
| Augmentation | Purple | Time building the augmentation context |
| LLM Call | Blue | Time waiting for Ollama to respond |
| Guardrails | Red | Time running the five guardrail checks |
| Other | Gray | Overhead (MongoDB queries, SSE, etc.) |

Each segment shows its duration in milliseconds. The total request time is displayed at the end.

### ExportExcel (Top Bar Button)

Exports the request history to a spreadsheet file. Each row contains the request metadata, classification, routing decision, timing breakdown, and response preview. Useful for collecting data for analysis.

---

## WebSocket Hook

**File:** `workflow/src/hooks/useWorkflowSocket.js`

The `useWorkflowSocket` hook manages the entire WebSocket lifecycle and application state.

### State Shape

```javascript
{
  connected: boolean,           // WebSocket connection status
  nodeStates: {                 // Per-node state map
    "middleware": {
      status: "completed",      // idle | active | completed | error | skipped
      data: { ... },            // Latest event data for this node
      startTime: 1710000000000, // When the node became active
      endTime: 1710000342000,   // When the node completed
    },
    "classifier": { status: "active", data: { type: "wrong_answer", ... } },
    "bm25": { status: "idle", data: null },
    // ... one entry per node
  },
  eventLog: [                   // Chronological event stream
    { timestamp: 1710000000000, event: "request_start", status: "start", data: { ... } },
    ...
  ],
  currentRequest: {             // Metadata for the active request
    requestId: "req_42_1710000000000",
    userId: "...",
    userMessage: "R5 porque está conectada",
    exerciseId: "...",
    startTime: 1710000000000,
  },
  requestHistory: [...],        // Array of past requests
  selectedNode: "classifier",   // Currently selected node for detail panel
  selectedEvent: null,          // Currently selected event for detail view
}
```

### Event-to-Node Mapping

The hook contains a mapping of 46 event types to node IDs. When an event arrives:

1. Look up which node the event corresponds to (e.g., `bm25_search_start` → node `bm25`)
2. Update the node's status based on the event status:
   - `"start"` → node becomes `"active"`
   - `"end"` → node becomes `"completed"`
   - `"skip"` → node becomes `"skipped"`
3. Store the event data in the node's state
4. Append the event to the event log

### Special Events

- `request_start`: Resets all nodes to `"idle"`, clears the event log, stores the new request metadata
- `request_end`: Archives the current request to history
- `request_error`: Sets the relevant node to `"error"` status
- `ollama_retry`: Sets the relevant guardrail node to `"error"` (indicating it triggered)

### Reconnection

The hook implements exponential backoff reconnection:

- On disconnect: wait 1 second, then reconnect
- On repeated failures: double the wait time (1s → 2s → 4s → 8s → ...)
- Maximum wait: 30 seconds
- On successful reconnection: reset the wait time to 1 second

### Event Buffering

Events arriving in rapid succession are buffered and processed in batches using `requestAnimationFrame`. This prevents React from re-rendering on every individual event (which could be dozens per second during the retrieval phase) and instead batches updates into a single render per animation frame.

---

## Node Types

The graph uses 6 custom node types, each with distinct styling:

### PipelineStepNode

For core pipeline components (Middleware, Classifier, Orchestrator, Knowledge Graph, Student History, Response, Logger, Deterministic Finish).

- **Styling**: Rounded rectangle with status-colored border
- **Active state**: Blue border with pulse animation and glow
- **Displays**: Label, status badge, and a preview of key data from the latest event

### ExternalServiceNode

For external dependencies (Student Frontend, MongoDB Atlas, ChromaDB Semantic, PoliGPT/Ollama).

- **Styling**: Rounded rectangle with an icon (user, database, vector, LLM)
- **Color scheme**: Purple-tinted when idle, status-colored when active

### AlgorithmNode

For algorithm steps (BM25 Search, Embedding Generator, RRF Fusion, CRAG Reformulation).

- **Styling**: Rounded rectangle with gear icon
- **Color scheme**: Amber/warm tones
- **Displays**: Algorithm-specific preview (e.g., "768d, 45ms" for embedding, "3 results, top=0.423" for BM25)

### GuardrailNode

For safety checks (Solution Leak, False Confirmation, Premature Confirmation, State Reveal, Element Naming).

- **Styling**: Rounded rectangle with shield icon
- **Pass state**: Green border
- **Fail/trigger state**: Red border with glow
- **Displays**: Pass/fail status and trigger details

### DocumentNode

For data sources (Datasets CSV, KG Data JSON).

- **Styling**: Warm amber/paper color with a dog-ear fold in the top-right corner
- **Icon**: Document emoji
- **Displays**: Label and subtitle (e.g., "pre-indexed exercises")

### SectionGroupNode

Background rectangles that group related nodes into labeled sections:

- External Services (purple)
- Pipeline Core (teal)
- Knowledge Base (purple)
- Hybrid Search Engine (amber)
- Student Context (blue)
- Generation (blue)
- Safety Guardrails (red)
- Output (green)

These are purely visual — they have no interaction behavior and sit at `zIndex: -1` behind the component nodes.

### Handle System

Every node has 8 handles (connection points):

| Position | Source ID | Target ID |
|---|---|---|
| Top | `top-source` | `top` |
| Bottom | `bottom` | `bottom-target` |
| Left | `left-source` | `left` |
| Right | `right-source` | `right` |

The main handles (top target, bottom source) are prominently styled. Side handles are smaller and semi-transparent (6px, opacity 0.3). This handle system allows edges to route from any direction, enabling the orthogonal routing layout.

---

## Edge System

**File:** `workflow/src/components/edges/AnimatedEdge.jsx`

All edges use the custom `AnimatedEdge` component with smooth step (orthogonal) routing.

### Routing

Edges use `getSmoothStepPath` from React Flow with:
- `borderRadius: 18` — rounded corners at turns
- `offset: 25` — clearance from nodes to prevent overlapping

This produces clean right-angle paths that follow horizontal and vertical corridors between section groups, avoiding crossing through nodes.

### Conditional Animation

Edges are not always visible at full brightness. Their appearance depends on the pipeline state:

| State | Stroke Color | Width | Opacity | Animation |
|---|---|---|---|---|
| **Idle** | `#1e293b` (dark) | 0.8 | 0.15 | None |
| **Used** | Original color | Original | 0.75 | None |
| **Active** | Original color | +0.5 | 1.0 | Flowing dot along the path |

- **Idle**: Both source and target nodes are idle. The edge is barely visible.
- **Used**: Both nodes have been activated at some point during the request. The edge is visible but static.
- **Active**: The source is completed and the target is currently active (or the source itself is active). A small colored circle animates along the edge path using SVG `animateMotion`.

This dynamic computation happens in `App.jsx`:

```javascript
var isUsed = sourceStatus !== "idle" && targetStatus !== "idle";
var isActive = sourceStatus === "active" || (sourceStatus === "completed" && targetStatus === "active");
```

### Special Edge Styles

- **Retry edges** (guardrails → PoliGPT): Dashed red (`#ef4444`, dasharray `6 3`)
- **Return edge** (Response → Frontend): Dashed green (`#22c55e`, dasharray `6 3`)
- **Pre-indexed edges** (Datasets → BM25/ChromaDB): Dashed amber (`#92400e`, dasharray `4 4`)
- **CRAG retry edge** (CRAG → Hybrid Search): Dashed amber (`#f59e0b`, dasharray `6 3`)
- **Deterministic finish edge** (Deterministic → Response): Dashed green shortcut

---

## Layout Design

**File:** `workflow/src/components/layout/workflowLayout.js`

The graph layout follows a **UML deployment diagram** style with a vertical main spine and clearly separated sections.

### Grid System

- **Canvas width**: 1200px
- **Center spine X**: 420px (where the main pipeline flows vertically)
- **Left corridor**: x ≈ 310-340 (gap between Knowledge Base and Hybrid Search sections)
- **Right corridor**: x ≈ 810-860 (gap between Hybrid Search and Student Context sections)

### Vertical Layout (top to bottom)

| Y Position | Section | Nodes |
|---|---|---|
| 0 | External Services | Student (Frontend), MongoDB Atlas |
| 115 | Pipeline Core | RAG Middleware → Query Classifier → Pipeline Orchestrator |
| 420 | Knowledge Base | KG Data (JSON), Knowledge Graph |
| 420 | Hybrid Search Engine | Hybrid Search, Datasets (CSV), Embedding, BM25, ChromaDB, RRF, CRAG |
| 420 | Student Context | Student History |
| 795 | Generation | Deterministic Finish, PoliGPT (Ollama) |
| 920 | Safety Guardrails | Solution Leak → False Confirmation → State Reveal |
| 1065 | Output | Response (SSE), JSONL Logger |

### Corridor-Based Edge Routing

Edges between distant sections route through designated corridors — vertical gaps between section groups. This prevents edges from crossing through nodes:

- The left corridor (x ≈ 320) carries edges from the Pipeline Core down to the Knowledge Base and from the Middleware down to Deterministic Finish
- The right corridor (x ≈ 850) carries edges from the Orchestrator to Student History and from Student History up to MongoDB

Horizontal corridors at each section boundary (y ≈ 390, 760, 890, 1035) allow edges to cross between sections without overlapping nodes.

---

## File Structure

```
workflow/
├── package.json
├── vite.config.js                          # Vite config with WebSocket proxy
├── index.html
├── src/
│   ├── main.jsx                            # React entry point
│   ├── App.jsx                             # Main app: React Flow + panels + tabs
│   ├── App.css                             # Global styles + animations
│   ├── index.css                           # Base styles
│   ├── hooks/
│   │   └── useWorkflowSocket.js            # WebSocket connection + state management
│   ├── components/
│   │   ├── nodes/
│   │   │   ├── PipelineStepNode.jsx        # Core pipeline component nodes
│   │   │   ├── ExternalServiceNode.jsx     # External service nodes (MongoDB, Ollama, etc.)
│   │   │   ├── AlgorithmNode.jsx           # Algorithm nodes (BM25, RRF, CRAG, etc.)
│   │   │   ├── GuardrailNode.jsx           # Safety guardrail nodes
│   │   │   ├── DocumentNode.jsx            # Data source nodes (datasets, KG)
│   │   │   └── SectionGroupNode.jsx        # Background section grouping
│   │   ├── edges/
│   │   │   └── AnimatedEdge.jsx            # Custom edge with conditional animation
│   │   ├── panels/
│   │   │   ├── RequestInfo.jsx             # Top bar: request metadata + timer
│   │   │   ├── RequestHistory.jsx          # Left sidebar: past requests
│   │   │   ├── EventLog.jsx               # Right sidebar: event stream
│   │   │   ├── NodeDetail.jsx             # Bottom panel: selected node parameters
│   │   │   ├── TimingBar.jsx              # Timing breakdown bar
│   │   │   ├── FlowDiagram.jsx            # Alternative flow diagram view
│   │   │   └── ExportExcel.jsx            # Export button component
│   │   └── layout/
│   │       └── workflowLayout.js          # Static node positions + edge definitions
```

### Key File Roles

| File | Role |
|---|---|
| `App.jsx` | Orchestrates the entire UI: mounts React Flow with custom node/edge types, computes dynamic edge states, manages panel layout with resizable handles, switches between graph and flow views |
| `useWorkflowSocket.js` | All WebSocket and state logic. Every other component reads from this hook's state |
| `workflowLayout.js` | Defines all 22 component nodes, 8 section groups, and 30 edges with their positions, types, handles, labels, and styles |
| `AnimatedEdge.jsx` | Custom React Flow edge component with conditional opacity, width, color, and flowing dot animation |
