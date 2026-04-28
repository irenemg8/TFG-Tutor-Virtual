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

    // LLM adapter (port: ILlmService)
    const OllamaLlmAdapter = require("./infrastructure/llm/OllamaLlmAdapter");
    this.llmService = new OllamaLlmAdapter();

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

    // Health check: verify Chroma collections are populated. Non-fatal —
    // the system can still serve traffic with BM25 in-memory only, but we
    // log a clear warning so a forgotten ingestion is visible at boot.
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
        console.warn("[Container] WARNING: ChromaDB collections look empty. " +
          "Run 'node src/infrastructure/vectordb/ingest.js' to populate them. " +
          "Status: " + JSON.stringify(counts));
      } else {
        console.log("[Container] Chroma collections: " + JSON.stringify(counts));
      }
    } catch (err) {
      console.warn("[Container] Chroma health check skipped: " + err.message +
        " (BM25 in-memory will still work, semantic search disabled)");
    }

    // Guardrail pipeline (parallel + surgical-first + consolidated retry + budget)
    const { createDefaultGuardrails } = require("./infrastructure/guardrails");
    const GuardrailPipeline = require("./domain/services/GuardrailPipeline");
    const trace = require("./infrastructure/events/pipelineDebugLogger");
    this.guardrailPipeline = new GuardrailPipeline({
      guardrails: createDefaultGuardrails(),
      llmService: this.llmService,
      budgetMs: Number(process.env.GUARDRAIL_BUDGET_MS || 45000),
      minRetryBudgetMs: Number(process.env.GUARDRAIL_MIN_RETRY_BUDGET_MS || 10000),
      logger: trace,
    });

    // Build agent registry + orchestrator
    const { createAgentRegistry } = require("./domain/agents/agentRegistry");
    const TutoringOrchestrator = require("./domain/agents/orchestrator");
    const { classifyQuery } = require("./domain/services/rag/queryClassifier");
    const { runFullPipeline } = require("./domain/services/rag/ragPipeline");
    const { buildTutorSystemPrompt } = require("./domain/services/promptBuilder");
    const { logInteraction } = require("./infrastructure/llm/logger");
    const ragConfig = require("./infrastructure/llm/config");

    this.agents = createAgentRegistry({
      ejercicioRepo: this.ejercicioRepo,
      interaccionRepo: this.interaccionRepo,
      messageRepo: this.messageRepo,
      llmService: this.llmService,
      guardrailPipeline: this.guardrailPipeline,
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
