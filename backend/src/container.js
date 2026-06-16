"use strict";

const config = require("./config/environment");

/*------------------------------------------------------------------------------
            _________________________________________________________
            |                        CONTAINER                      |
            |  Dependency Injection Container (PostgreSQL only).     |
            |  After the final Mongo->Pg migration (2026-04-21) it  |
            |  only supports DATABASE_TYPE="postgresql"; the         |
            |  "mongodb" and "dual-write" modes were removed with   |
            |  all Mongoose code. Wires the repositories, the LLM   |
            |  adapter, the guardrail pipeline, the history          |
            |  summariser, the agents and the orchestrator.         |
            |  Usage: require it, await initialize(), then read the |
            |  exposed fields (usuarioRepo, messageRepo,             |
            |  orchestrator, ...).                                   |
        ____|________________                                       |
   IN -> | initialize() | -> Promise<void>                          |
          --------------                                            |
        ____|___________________                                    |
        | _initPostgreSQL() | -> Promise<void>                      |
        ---------------------                                       |
            |                                                       |
            |_______________________________________________________|
------------------------------------------------------------------------------*/

const container = {
  _initialized: false,

  usuarioRepo: null,
  ejercicioRepo: null,
  interaccionRepo: null,
  messageRepo: null,
  resultadoRepo: null,

  securityService: null,
  llmService: null,
  guardrailPipeline: null,
  kgConceptPatterns: [],

  orchestrator: null,
  agents: null,

  /*
       ____|________
      | initialize() | -> Promise<void>
       -------------
      Builds the whole container: opens the DB, instantiates the
      DB-independent adapters, loads the KG and BM25 indices, runs the
      Chroma health check, assembles the guardrail pipeline, the history
      summariser, the agents and the orchestrator.
  */
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

    const HeuristicSecurityAdapter = require("./infrastructure/security/HeuristicSecurityAdapter");
    const { emitEvent } = require("./infrastructure/events/ragEventBus");
    this.securityService = new HeuristicSecurityAdapter({
      logger: function (event, payload) { emitEvent(event, "end", payload); },
    });

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
    try {
      const _orch = require("./domain/agents/orchestrator");
      const _tutor = require("./domain/agents/tutorAgent");
      const _qc = require("./domain/services/rag/queryClassifier");
      const _cumOk = (function () {
        try { return typeof require("./domain/services/rag/cumulativeAnswer").computeCumulativeAnswer === "function"; }
        catch (_) { return false; }
      })();
      const _closureOk = /closureReady/.test(String(_orch.prototype._shouldFinishDeterministically));
      const _bannerOk = typeof _tutor.prototype._buildCumulativeBanner === "function";
      const _classifierOk = (function () {
        try {
          const c = _qc.classifyQuery("no pasa la corriente por r5", ["R1"], ["R1", "R5"]);
          return c.negated.indexOf("R5") >= 0;
        } catch (_) { return false; }
      })();
      const _semanticsOk = (function () {
        try {
          const { computeCumulativeAnswer } = require("./domain/services/rag/cumulativeAnswer");
          const cum = computeCumulativeAnswer([
            { role: "user", content: "r1 r2 r4" },
            { role: "assistant", content: "¿Por qué crees que R3 y R5 no influyen?" },
            { role: "user", content: "r3 está en un interruptor abierto y r5 en corto" },
          ], ["R1", "R2", "R4"], ["R1", "R2", "R3", "R4", "R5"]);
          return cum.closureReady === true;
        } catch (_) { return false; }
      })();
      console.log(
        "[Container] Loop-fix deploy check: cumulativeAnswer=" + (_cumOk ? "ON" : "OFF") +
        " closure=" + (_closureOk ? "ON" : "OFF") +
        " progressBanner=" + (_bannerOk ? "ON" : "OFF") +
        " classifierFlowNeg=" + (_classifierOk ? "ON" : "OFF") +
        " closureSemantics=" + (_semanticsOk ? "ON" : "OFF") +
        ((_cumOk && _closureOk && _bannerOk && _classifierOk && _semanticsOk) ? "" : "  ⚠ STALE FILES — sync backend/src COMPLETO and restart")
      );
    } catch (e) {
      console.log("[Container] Loop-fix deploy check FAILED: " + e.message);
    }
    this.guardrailPipeline = new GuardrailPipeline({
      guardrails: guardrailList,
      llmService: this.llmService,
      budgetMs: Number(process.env.GUARDRAIL_BUDGET_MS || 20000),
      minRetryBudgetMs: Number(process.env.GUARDRAIL_MIN_RETRY_BUDGET_MS || 8000),
      logger: trace,
      emitEvent: emitEvent,
    });

    const HistorySummarizer = require("./domain/services/historySummarizer");
    this.historySummarizer = new HistorySummarizer({
      llmService: this.llmService,
      logger: { log: function (msg) { console.warn(msg); } },
    });

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
      debugLogger: trace,
      config: ragConfig,
    });
    this.orchestrator = new TutoringOrchestrator(this.agents, { emitEvent: emitEvent });

    this._initialized = true;
    console.log("[Container] Initialization complete");
  },

  /*
       ____|___________________
      | _initPostgreSQL() | -> Promise<void>
       -------------------
      Creates the pg pool, runs the migrations and instantiates the Pg*
      repositories (usuario, ejercicio, interaccion, message, resultado).
  */
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
