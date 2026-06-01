"use strict";

const config = require("./config/environment");

/**
 * Dependency Injection Container (PostgreSQL only).
 *
 * Tras la migración final Mongo→Pg (2026-04-21), este container solo soporta
 * DATABASE_TYPE="postgresql". Los modos "mongodb" y "dual-write" fueron
 * eliminados junto con todo el código de Mongoose.
 *
 * Usage:
 *   const container = require('./container');
 *   await container.initialize();
 *   const { usuarioRepo, messageRepo, orchestrator, ... } = container;
 */

const container = {
  _initialized: false,

  // Repositories (ports)
  usuarioRepo: null,
  ejercicioRepo: null,
  interaccionRepo: null,
  messageRepo: null,
  resultadoRepo: null,

  // Domain services (ports)
  securityService: null,
  llmService: null,
  guardrailPipeline: null,
  kgConceptPatterns: [],

  // Agent system
  orchestrator: null,
  agents: null,

  async initialize() {
    if (this._initialized) return;

    const dbType = config.DATABASE_TYPE;
    console.log(`[Container] Initializing with DATABASE_TYPE=${dbType}`);

    if (dbType !== "postgresql") {
      throw new Error(
        `Unsupported DATABASE_TYPE="${dbType}". After the MongoDB→Postgres ` +
        `migration the only supported value is "postgresql". Set it in backend/.env.`
      );
    }

    await this._initPostgreSQL();

    // DB-independent adapters
    const HeuristicSecurityAdapter = require("./infrastructure/security/HeuristicSecurityAdapter");
    const { emitEvent } = require("./infrastructure/events/ragEventBus");
    this.securityService = new HeuristicSecurityAdapter({
      logger: function (event, payload) { emitEvent(event, "end", payload); },
    });

    // LLM adapter (port: ILlmService) — selected by LLM_PROVIDER env var.
    //   - "poligpt" → PoliGptLlmAdapter (OpenAI-compatible LiteLLM proxy at UPV)
    //   - "ollama"  → OllamaLlmAdapter (legacy direct Ollama; default)
    const llmCfg = require("./infrastructure/llm/config");
    if (llmCfg.LLM_PROVIDER === "poligpt") {
      const PoliGptLlmAdapter = require("./infrastructure/llm/PoliGptLlmAdapter");
      this.llmService = new PoliGptLlmAdapter();
      console.log("[Container] LLM provider: poligpt (model=" + llmCfg.POLIGPT_MODEL + ")");
    } else {
      const OllamaLlmAdapter = require("./infrastructure/llm/OllamaLlmAdapter");
      this.llmService = new OllamaLlmAdapter();
      console.log("[Container] LLM provider: ollama (model=" + llmCfg.OLLAMA_MODEL + ")");
    }

    // Load KG concept patterns (used by the StateRevealGuardrail)
    const { loadKG, getAllEntries } = require("./infrastructure/search/knowledgeGraph");
    const { loadConceptPatternsFromKG } = require("./domain/services/rag/guardrails");
    try {
      loadKG();
      const kgEntries = getAllEntries();
      this.kgConceptPatterns = loadConceptPatternsFromKG(kgEntries);
      const acsPrimary = kgEntries.filter(e => e.AC).length;
      const acsSecondary = kgEntries.filter(e => e["AC.1"]).length;
      const noAc = kgEntries.length - acsPrimary;
      console.log("[Container] KG: " + kgEntries.length + " entries, " +
        acsPrimary + " w/ primary AC, " + acsSecondary + " w/ secondary AC, " +
        noAc + " w/o AC, " + this.kgConceptPatterns.length + " concept patterns");
    } catch (err) {
      console.warn("[Container] KG concept patterns not available:", err.message);
    }

    // Load BM25 indices for every exercise dataset. Previously only the legacy
    // ragMiddleware loaded these; with USE_ORCHESTRATOR=1 the new pipeline ran
    // without BM25 (semantic-only fallback), silently degrading retrieval.
    try {
      const fs = require("fs");
      const path = require("path");
      const ragConfig = require("./infrastructure/llm/config");
      const { loadIndex } = require("./infrastructure/search/bm25");
      const seenFiles = new Set();
      const exerciseNums = Object.keys(ragConfig.EXERCISE_DATASET_MAP);
      for (let i = 0; i < exerciseNums.length; i++) {
        const num = Number(exerciseNums[i]);
        const fileName = ragConfig.EXERCISE_DATASET_MAP[num];
        const filePath = path.join(ragConfig.DATASETS_DIR, fileName);
        const pairs = JSON.parse(fs.readFileSync(filePath, "utf-8"));
        loadIndex(num, pairs);
        seenFiles.add(fileName);
      }
      console.log("[Container] BM25 indices loaded for " +
        exerciseNums.length + " exercises (" + seenFiles.size + " unique datasets)");
    } catch (err) {
      console.warn("[Container] BM25 indices not loaded:", err.message);
    }

    // Health check: verify Chroma collections are populated.
    // In production (CHROMA_REQUIRED !== "false") an empty ChromaDB is FATAL —
    // the system would silently serve degraded responses without semantic search.
    // Set CHROMA_REQUIRED=false in development environments that run without ChromaDB.
    const chromaRequired = (process.env.CHROMA_REQUIRED || "true").toLowerCase() !== "false";
    try {
      const { getCollection } = require("./infrastructure/vectordb/chromaClient");
      const expectedCollections = ["exercise_1", "exercise_3", "exercise_4",
        "exercise_5", "exercise_6", "exercise_7", "knowledge_graph"];
      const counts = {};
      let totalDocs = 0;
      for (const name of expectedCollections) {
        try {
          const col = await getCollection(name);
          const c = await col.count();
          counts[name] = c;
          totalDocs += c;
        } catch (e) {
          counts[name] = "ERR(" + (e.code || e.message || "unknown") + ")";
        }
      }
      if (totalDocs === 0) {
        const msg = "[Container] ChromaDB collections are empty. " +
          "Run 'node src/infrastructure/vectordb/ingest.js' to populate them. " +
          "Status: " + JSON.stringify(counts);
        if (chromaRequired) {
          throw new Error(msg + " Set CHROMA_REQUIRED=false to start in BM25-only mode.");
        }
        console.warn("[Container] WARNING (CHROMA_REQUIRED=false): " + msg);
      } else {
        console.log("[Container] Chroma collections: " + JSON.stringify(counts));
      }
    } catch (err) {
      if (chromaRequired && err.message.includes("ChromaDB collections are empty")) {
        throw err;
      }
      console.warn("[Container] Chroma health check skipped: " + err.message +
        " (BM25 in-memory will still work, semantic search disabled)");
    }

    // Guardrail pipeline (parallel + surgical-first + consolidated retry + budget)
    // Profile selection: GUARDRAIL_PROFILE=legacy keeps the pre-hexagonal set
    // (premature/didactic/dataset_style still inside the safety pipeline).
    // Default profile delegates those three to the PedagogicalReviewerAgent.
    const { createGuardrailsForProfile } = require("./infrastructure/guardrails");
    const GuardrailPipeline = require("./domain/services/GuardrailPipeline");
    const trace = require("./infrastructure/events/pipelineDebugLogger");
    const guardrailProfile = process.env.GUARDRAIL_PROFILE || "default";
    const guardrailList = createGuardrailsForProfile(guardrailProfile);
    console.log(
      "[Container] GuardrailPipeline profile=" + guardrailProfile +
      " (" + guardrailList.length + " guardrails: " +
      guardrailList.map(function (g) { return g.id; }).join(", ") + ")"
    );
    this.guardrailPipeline = new GuardrailPipeline({
      guardrails: guardrailList,
      llmService: this.llmService,
      budgetMs: Number(process.env.GUARDRAIL_BUDGET_MS || 20000),
      minRetryBudgetMs: Number(process.env.GUARDRAIL_MIN_RETRY_BUDGET_MS || 8000),
      logger: trace,
      // Lets the pipeline notify the SSE layer (via ragBus) right before an
      // LLM rewrite so the frontend can show a placeholder instead of the
      // leaked draft. See GuardrailPipeline.emitEvent for details.
      emitEvent: emitEvent,
    });

    // History summariser: keeps an in-memory rolling summary of conversation
    // turns that have fallen out of the HISTORY_MAX_MESSAGES window. The
    // TutorAgent injects this summary as a second system message so the LLM
    // doesn't lose memory of confirmations or concepts the student
    // established earlier in a long session.
    const HistorySummarizer = require("./domain/services/historySummarizer");
    this.historySummarizer = new HistorySummarizer({
      llmService: this.llmService,
      logger: { log: function (msg) { console.warn(msg); } },
    });

    // Build agent registry + orchestrator
    const { createAgentRegistry } = require("./domain/agents/agentRegistry");
    const TutoringOrchestrator = require("./domain/agents/orchestrator");
    const { classifyQuery } = require("./domain/services/rag/queryClassifier");
    const { createRagPipeline } = require("./domain/services/rag/ragPipeline");
    const { hybridSearch } = require("./infrastructure/search/hybridSearch");
    const { searchKG } = require("./infrastructure/search/knowledgeGraph");
    const ragConfig = require("./infrastructure/llm/config");
    const { runFullPipeline } = createRagPipeline({ hybridSearch, searchKG, emitEvent, config: ragConfig });
    const { buildTutorSystemPrompt } = require("./domain/services/promptBuilder");
    const { logInteraction } = require("./infrastructure/llm/logger");

    this.agents = createAgentRegistry({
      ejercicioRepo: this.ejercicioRepo,
      interaccionRepo: this.interaccionRepo,
      messageRepo: this.messageRepo,
      resultadoRepo: this.resultadoRepo,
      llmService: this.llmService,
      guardrailPipeline: this.guardrailPipeline,
      historySummarizer: this.historySummarizer,
      kgConceptPatterns: this.kgConceptPatterns,
      classifyQuery: classifyQuery,
      runFullPipeline: runFullPipeline,
      securityService: this.securityService,
      buildSystemPrompt: buildTutorSystemPrompt,
      logInteraction: logInteraction,
      emitEvent: emitEvent,
      // Hex compliance: inject the pipeline logger so domain agents don't
      // require("../../infrastructure/...") at module top-level.
      debugLogger: trace,
      config: ragConfig,
    });
    this.orchestrator = new TutoringOrchestrator(this.agents, { emitEvent: emitEvent });

    this._initialized = true;
    console.log("[Container] Initialization complete");
  },

  async _initPostgreSQL() {
    const { createPool, runMigrations } = require("./infrastructure/persistence/postgresql/PgConnection");
    const pool = createPool(config.PG_CONNECTION_STRING);
    await pool.query("SELECT 1");
    await runMigrations(pool);

    const PgUsuarioRepository = require("./infrastructure/persistence/postgresql/PgUsuarioRepository");
    const PgEjercicioRepository = require("./infrastructure/persistence/postgresql/PgEjercicioRepository");
    const PgInteraccionRepository = require("./infrastructure/persistence/postgresql/PgInteraccionRepository");
    const PgMessageRepository = require("./infrastructure/persistence/postgresql/PgMessageRepository");
    const PgResultadoRepository = require("./infrastructure/persistence/postgresql/PgResultadoRepository");

    this.usuarioRepo = new PgUsuarioRepository(pool);
    this.ejercicioRepo = new PgEjercicioRepository(pool);
    this.interaccionRepo = new PgInteraccionRepository(pool);
    this.messageRepo = new PgMessageRepository(pool);
    this.resultadoRepo = new PgResultadoRepository(pool);
  },
};

module.exports = container;
