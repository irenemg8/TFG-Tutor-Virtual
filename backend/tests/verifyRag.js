var path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });
var fs = require("fs");
var axios = require("axios");

/*------------------------------------------------------------------------------
            _________________________________________________________
            |                       VERIFY RAG                      |
            |  End-to-end verification script for the Agentic RAG    |
            |  system. Runs phased checks over prerequisites, each   |
            |  module, ingestion, hybrid search and the full pipeline,|
            |  tallying pass/fail/skip results.                      |
        ____|________________                                       |
   Txt -> | pass() | -> void                                        |
          -----------------                                         |
        ____|________________                                       |
   Txt -> | fail() | -> void                                        |
          -----------------                                         |
        ____|________________                                       |
   Txt -> | skip() | -> void                                        |
          -----------------                                         |
        ____|________________                                       |
   void -> | summary() | -> void                                    |
          -----------------                                         |
        ____|________________                                       |
   void -> | main() | -> Promise<Obj>                               |
          -----------------                                         |
            |                                                       |
            |_______________________________________________________|
------------------------------------------------------------------------------*/

var passed = 0;
var failed = 0;
var skipped = 0;

var ollamaOk = false;
var chromaOk = false;
var filesOk = false;

/*
   IN -> ____|________
        | pass() | -> void
         ----------
      Logs a passing step and increments the pass counter (Txt, Txt).
   */
function pass(step, msg) {
  console.log("[PASS] " + step + " — " + msg);
  passed = passed + 1;
}

/*
   IN -> ____|________
        | fail() | -> void
         ----------
      Logs a failing step and increments the fail counter (Txt, Txt).
   */
function fail(step, msg) {
  console.log("[FAIL] " + step + " — " + msg);
  failed = failed + 1;
}

/*
   IN -> ____|________
        | skip() | -> void
         ----------
      Logs a skipped step and increments the skip counter (Txt, Txt).
   */
function skip(step, msg) {
  console.log("[SKIP] " + step + " — " + msg);
  skipped = skipped + 1;
}

/*
   IN -> ____|___________
        | summary() | -> void
         -------------
      Prints the final pass/fail/skip tally.
   */
function summary() {
  console.log("\n========================================");
  console.log("PASSED: " + passed + "  FAILED: " + failed + "  SKIPPED: " + skipped);
  console.log("========================================");
}

/*
   IN -> ____|________
        | main() | -> Promise<Obj>
         ----------
      Runs all verification phases and returns the prerequisite flags.
   */
async function main() {
  console.log("=== FASE 0: Prerrequisitos ===\n");

  var depsOk = true;
  var depNames = ["chromadb", "axios", "mongoose"];
  for (var i = 0; i < depNames.length; i++) {
    try {
      require(depNames[i]);
    } catch (e) {
      fail("0.1", "No se pudo cargar " + depNames[i] + ": " + e.message);
      depsOk = false;
    }
  }
  if (depsOk) {
    pass("0.1", "Dependencias npm (chromadb, axios, mongoose) cargadas");
  }

  var config = require("../src/rag/config");
  var ollamaUrl = config.OLLAMA_EMBED_URL.replace(/\/$/, "");
  try {
    var r = await axios.get(ollamaUrl + "/api/tags", { timeout: 10000 });
    var models = r.data.models;
    var modelNames = [];
    for (var i = 0; i < models.length; i++) {
      modelNames.push(models[i].name);
    }

    var hasQwen = false;
    var hasNomic = false;
    for (var i = 0; i < modelNames.length; i++) {
      if (modelNames[i].indexOf("qwen2.5") >= 0) {
        hasQwen = true;
      }
      if (modelNames[i].indexOf("nomic-embed-text") >= 0) {
        hasNomic = true;
      }
    }

    if (hasQwen && hasNomic) {
      pass("0.2", "Ollama available at " + ollamaUrl + " with qwen2.5 and nomic-embed-text");
      ollamaOk = true;
    } else {
      var missing = [];
      if (!hasQwen) { missing.push("qwen2.5"); }
      if (!hasNomic) { missing.push("nomic-embed-text"); }
      fail("0.2", "Ollama responds but missing models: " + missing.join(", ") + ". Available: " + modelNames.join(", "));
    }
  } catch (e) {
    fail("0.2", "Ollama not available at " + ollamaUrl + " — " + e.message);
  }

  try {
    var chromaUrl = config.CHROMA_URL.replace(/\/$/, "");
    var r = await axios.get(chromaUrl + "/api/v2/heartbeat", { timeout: 5000 });
    if (r.status === 200) {
      pass("0.3", "ChromaDB disponible en http://localhost:8000");
      chromaOk = true;
    } else {
      fail("0.3", "ChromaDB respondio con status " + r.status);
    }
  } catch (e) {
    fail("0.3", "ChromaDB no disponible en http://localhost:8000 — " + e.message);
  }

  var allFilesExist = true;

  var exerciseNums = Object.keys(config.EXERCISE_DATASET_MAP);
  var checkedFiles = {};
  for (var i = 0; i < exerciseNums.length; i++) {
    var fileName = config.EXERCISE_DATASET_MAP[exerciseNums[i]];
    if (checkedFiles[fileName] != null) {
      continue;
    }
    checkedFiles[fileName] = true;
    var filePath = path.join(config.DATASETS_DIR, fileName);
    if (!fs.existsSync(filePath)) {
      fail("0.4", "Dataset no encontrado: " + filePath);
      allFilesExist = false;
    }
  }

  if (!fs.existsSync(config.KG_PATH)) {
    fail("0.4", "Knowledge graph no encontrado: " + config.KG_PATH);
    allFilesExist = false;
  }

  if (allFilesExist) {
    pass("0.4", "Todos los datasets (" + Object.keys(checkedFiles).length + ") y knowledge graph existen");
    filesOk = true;
  }

  console.log("\n=== FASE 1: Individual modules ===\n");

  try {
    var requiredKeys = [
      "CHROMA_URL", "EMBEDDING_MODEL", "OLLAMA_EMBED_URL", "OLLAMA_CHAT_URL",
      "OLLAMA_MODEL", "HIGH_THRESHOLD", "MED_THRESHOLD", "TOP_K_RETRIEVAL",
      "TOP_K_FINAL", "RRF_K", "BM25_K1", "BM25_B", "DATASETS_DIR", "KG_PATH",
      "LOG_DIR", "EXERCISE_DATASET_MAP", "RAG_ENABLED"
    ];
    var missingKeys = [];
    for (var i = 0; i < requiredKeys.length; i++) {
      if (config[requiredKeys[i]] == null) {
        missingKeys.push(requiredKeys[i]);
      }
    }
    if (missingKeys.length === 0) {
      pass("1.1", "config.js exports all " + requiredKeys.length + " required keys");
    } else {
      fail("1.1", "config.js missing keys: " + missingKeys.join(", "));
    }
  } catch (e) {
    fail("1.1", "config.js error: " + e.message);
  }

  if (ollamaOk) {
    try {
      var embeddings = require("../src/rag/embeddings");
      var vec = await embeddings.generateEmbedding("circuito en serie");
      if (Array.isArray(vec) && vec.length === 768) {
        var allNumbers = true;
        for (var i = 0; i < vec.length; i++) {
          if (typeof vec[i] !== "number") {
            allNumbers = false;
            break;
          }
        }
        if (allNumbers) {
          pass("1.2", "embeddings.generateEmbedding returns array of 768 numbers");
        } else {
          fail("1.2", "Embedding array contains non-number values");
        }
      } else {
        fail("1.2", "Expected array of 768, got " + (Array.isArray(vec) ? "array of " + vec.length : typeof vec));
      }
    } catch (e) {
      fail("1.2", "embeddings.js error: " + e.message);
    }
  } else {
    skip("1.2", "Ollama not available, cannot test embeddings");
  }

  if (chromaOk && ollamaOk) {
    try {
      var chroma = require("../src/rag/chromaClient");
      var client = await chroma.getClient();
      var testCollection = await chroma.getCollection("test_verify_temp");

      var embModule = require("../src/rag/embeddings");
      var testEmb = await embModule.generateEmbedding("test document for verification");
      await testCollection.add({
        ids: ["test_doc_1"],
        embeddings: [testEmb],
        documents: ["test document for verification"],
        metadatas: [{ source: "verify" }],
      });

      var queryEmb = await embModule.generateEmbedding("test document");
      var results = await testCollection.query({
        queryEmbeddings: [queryEmb],
        nResults: 1,
      });

      if (results.documents && results.documents[0] && results.documents[0].length > 0) {
        pass("1.3", "chromaClient.js: add + search works (found: " + results.documents[0][0].substring(0, 30) + "...)");
      } else {
        fail("1.3", "chromaClient.js: search returned no results after adding document");
      }

      await client.deleteCollection({ name: "test_verify_temp" });
    } catch (e) {
      fail("1.3", "chromaClient.js error: " + e.message);
    }
  } else {
    skip("1.3", "ChromaDB or Ollama not available, cannot test chromaClient");
  }

  try {
    var bm25 = require("../src/rag/bm25");
    var testPairs = [
      { student: "R1 y R2 están en serie", tutor: "Correcto, forman un divisor" },
      { student: "Las resistencias en paralelo", tutor: "¿Cuáles exactamente?" },
      { student: "El cortocircuito anula R5", tutor: "Bien, R5 no conduce" },
    ];
    bm25.loadIndex(99, testPairs);
    var bm25Results = bm25.searchBM25("resistencia serie", 99, 2);
    if (Array.isArray(bm25Results) && bm25Results.length > 0 && bm25Results[0].score > 0) {
      pass("1.4", "bm25.js: loadIndex + searchBM25 works (" + bm25Results.length + " results, top score: " + bm25Results[0].score.toFixed(3) + ")");
    } else {
      fail("1.4", "bm25.js: search returned no results or zero scores");
    }
  } catch (e) {
    fail("1.4", "bm25.js error: " + e.message);
  }

  if (filesOk) {
    try {
      var kg = require("../src/rag/knowledgeGraph");
      kg.loadKG();
      var allEntries = kg.getAllEntries();
      if (allEntries.length > 0) {
        var kgResults = kg.searchKG(["cortocircuito"]);
        pass("1.5", "knowledgeGraph.js: loaded " + allEntries.length + " entries, searchKG('cortocircuito') found " + kgResults.length + " results");
      } else {
        fail("1.5", "knowledgeGraph.js: loadKG returned 0 entries");
      }
    } catch (e) {
      fail("1.5", "knowledgeGraph.js error: " + e.message);
    }
  } else {
    skip("1.5", "Data files not available, cannot test knowledgeGraph");
  }

  try {
    var classifier = require("../src/rag/queryClassifier");

    var testCases = [
      { msg: "hola", correctAnswer: ["R1"], expected: "greeting" },
      { msg: "no sé", correctAnswer: ["R1"], expected: "dont_know" },
      { msg: "todas", correctAnswer: ["R1", "R2", "R4"], expected: "wrong_answer" },
    ];

    var classifierOk = true;
    for (var i = 0; i < testCases.length; i++) {
      var tc = testCases[i];
      var result = classifier.classifyQuery(tc.msg, tc.correctAnswer);
      if (result.type !== tc.expected) {
        fail("1.6", "classifyQuery('" + tc.msg + "') = " + result.type + ", expected " + tc.expected);
        classifierOk = false;
      }
    }

    var resistances = classifier.extractResistances("R1, R2 y R4");
    var expectedR = ["R1", "R2", "R4"];
    var resistOk = resistances.length === expectedR.length;
    if (resistOk) {
      for (var i = 0; i < expectedR.length; i++) {
        if (resistances.indexOf(expectedR[i]) < 0) {
          resistOk = false;
        }
      }
    }
    if (!resistOk) {
      fail("1.6", "extractResistances('R1, R2 y R4') = [" + resistances.join(", ") + "], expected [R1, R2, R4]");
      classifierOk = false;
    }

    if (classifierOk) {
      pass("1.6", "queryClassifier.js: 3 classifications + extractResistances correct");
    }
  } catch (e) {
    fail("1.6", "queryClassifier.js error: " + e.message);
  }

  try {
    var guardrails = require("../src/rag/guardrails");
    var correctAnswer = ["R1", "R2", "R4"];

    var safeCheck = guardrails.checkSolutionLeak("¿Por qué crees que R1 está en serie?", correctAnswer);

    var leakCheck = guardrails.checkSolutionLeak("Las resistencias son R1, R2 y R4, la respuesta correcta es esa", correctAnswer);

    var strongerInst = guardrails.getStrongerInstruction();

    if (safeCheck.leaked === false && leakCheck.leaked === true && strongerInst.length > 0) {
      pass("1.7", "guardrails.js: safe=false, leak=true, strongerInstruction has " + strongerInst.length + " chars");
    } else {
      fail("1.7", "guardrails.js: safe.leaked=" + safeCheck.leaked + " (expected false), leak.leaked=" + leakCheck.leaked + " (expected true)");
    }
  } catch (e) {
    fail("1.7", "guardrails.js error: " + e.message);
  }

  try {
    var logger = require("../src/rag/logger");
    logger.logInteraction({
      exerciseNum: 99,
      userId: "test_verify",
      classification: "test",
      decision: "test",
      query: "verification test query",
      retrievedDocs: [],
      augmentation: "",
      response: "test response",
      guardrailTriggered: false,
      timing: { total: 0 },
    });

    var today = new Date().toISOString().split("T")[0];
    var logPath = path.join(config.LOG_DIR, today + ".jsonl");
    if (fs.existsSync(logPath)) {
      var logContent = fs.readFileSync(logPath, "utf-8").trim();
      var lastLine = logContent.split("\n").pop();
      var parsed = JSON.parse(lastLine);
      if (parsed.userId === "test_verify") {
        pass("1.8", "logger.js: wrote to " + today + ".jsonl, last entry is valid JSON");
      } else {
        fail("1.8", "logger.js: log file exists but last entry doesn't match test data");
      }
    } else {
      fail("1.8", "logger.js: log file not created at " + logPath);
    }
  } catch (e) {
    fail("1.8", "logger.js error: " + e.message);
  }

  console.log("\n=== FASE 2: Ingestion verification ===\n");

  var ingestOk = false;

  if (chromaOk && ollamaOk) {
    try {
      var chroma = require("../src/rag/chromaClient");
      var chromaClient = chroma.getClient();
      var collections = await chromaClient.listCollections();

      var expectedCollections = [
        "exercise_1", "exercise_3", "exercise_4",
        "exercise_5", "exercise_6", "exercise_7", "knowledge_graph"
      ];

      var collectionNames = [];
      for (var i = 0; i < collections.length; i++) {
        collectionNames.push(collections[i].name || collections[i]._name);
      }

      var allFound = true;
      var missingCols = [];
      for (var i = 0; i < expectedCollections.length; i++) {
        var found = false;
        for (var j = 0; j < collectionNames.length; j++) {
          if (collectionNames[j] === expectedCollections[i]) {
            found = true;
            break;
          }
        }
        if (!found) {
          allFound = false;
          missingCols.push(expectedCollections[i]);
        }
      }

      if (allFound) {
        var emptyCols = [];
        for (var i = 0; i < expectedCollections.length; i++) {
          var col = await chroma.getCollection(expectedCollections[i]);
          var count = await col.count();
          if (count === 0) {
            emptyCols.push(expectedCollections[i]);
          }
        }

        if (emptyCols.length === 0) {
          pass("2.2", "All 7 ChromaDB collections exist with documents");
          ingestOk = true;
        } else {
          fail("2.2", "Empty collections: " + emptyCols.join(", ") + ". Re-run: node src/rag/ingest.js");
        }
      } else {
        fail("2.2", "Missing collections: " + missingCols.join(", ") + ". Run: node src/rag/ingest.js");
      }
    } catch (e) {
      fail("2.2", "ChromaDB collection check error: " + e.message);
    }
  } else {
    skip("2.2", "ChromaDB or Ollama not available");
  }

  if (filesOk) {
    try {
      var bm25 = require("../src/rag/bm25");
      var datasetPath = path.join(config.DATASETS_DIR, "dataset_exercise_1.json");
      var rawData = fs.readFileSync(datasetPath, "utf-8");
      var pairs = JSON.parse(rawData);
      bm25.loadIndex(1, pairs);
      var bm25Check = bm25.searchBM25("resistencia en serie", 1, 3);
      if (Array.isArray(bm25Check) && bm25Check.length > 0 && bm25Check[0].score > 0) {
        pass("2.3", "BM25 index for exercise 1: " + pairs.length + " pairs loaded, search returns " + bm25Check.length + " results");
      } else {
        fail("2.3", "BM25 search returned no results after loading dataset");
      }
    } catch (e) {
      fail("2.3", "BM25 index verification error: " + e.message);
    }
  } else {
    skip("2.3", "Data files not available");
  }

  console.log("\n=== FASE 3: Hybrid search ===\n");

  if (ingestOk && ollamaOk) {
    try {
      var hybridSearch = require("../src/rag/hybridSearch");
      var bm25 = require("../src/rag/bm25");
      var datasetPath = path.join(config.DATASETS_DIR, "dataset_exercise_1.json");
      var rawData = fs.readFileSync(datasetPath, "utf-8");
      var pairs = JSON.parse(rawData);
      bm25.loadIndex(1, pairs);

      var hsResults = await hybridSearch.hybridSearch("resistencia en serie", 1, 3);

      if (Array.isArray(hsResults) && hsResults.length > 0) {
        var first = hsResults[0];
        var hasFields = first.student != null && first.tutor != null && first.score != null;

        var sorted = true;
        for (var i = 1; i < hsResults.length; i++) {
          if (hsResults[i].score > hsResults[i - 1].score) {
            sorted = false;
            break;
          }
        }

        if (hasFields && sorted) {
          pass("3.1", "hybridSearch: " + hsResults.length + " results, top score: " + hsResults[0].score.toFixed(4) + ", sorted descending");
        } else if (!hasFields) {
          fail("3.1", "hybridSearch: results missing student/tutor/score fields");
        } else {
          fail("3.1", "hybridSearch: results not sorted by score descending");
        }
      } else {
        fail("3.1", "hybridSearch returned no results");
      }
    } catch (e) {
      fail("3.1", "hybridSearch error: " + e.message);
    }
  } else {
    skip("3.1", "Ingestion or Ollama not available");
  }

  console.log("\n=== FASE 4: Full pipeline ===\n");

  if (ingestOk && ollamaOk) {
    try {
      var pipeline = require("../src/rag/ragPipeline");

      var bm25 = require("../src/rag/bm25");
      var kg = require("../src/rag/knowledgeGraph");
      kg.loadKG();

      var exerciseKeys = Object.keys(config.EXERCISE_DATASET_MAP);
      var loaded = {};
      for (var i = 0; i < exerciseKeys.length; i++) {
        var fileName = config.EXERCISE_DATASET_MAP[exerciseKeys[i]];
        if (loaded[fileName] != null) {
          continue;
        }
        loaded[fileName] = true;
        var dPath = path.join(config.DATASETS_DIR, fileName);
        var dRaw = fs.readFileSync(dPath, "utf-8");
        var dPairs = JSON.parse(dRaw);
        bm25.loadIndex(Number(exerciseKeys[i]), dPairs);
      }

      var pResult = await pipeline.runFullPipeline(
        "R1, R2 y R4 porque están en serie",
        1,
        ["R1", "R2", "R4"],
        null
      );

      var hasDecision = pResult.decision != null;
      var hasClassification = pResult.classification != null;
      var hasAugmentation = typeof pResult.augmentation === "string";

      if (hasDecision && hasClassification && hasAugmentation) {
        pass("4.1", "ragPipeline: decision=" + pResult.decision + ", classification=" + pResult.classification + ", augmentation=" + pResult.augmentation.length + " chars");
      } else {
        fail("4.1", "ragPipeline: missing fields (decision=" + hasDecision + ", classification=" + hasClassification + ", augmentation=" + hasAugmentation + ")");
      }
    } catch (e) {
      fail("4.1", "ragPipeline error: " + e.message);
    }
  } else {
    skip("4.1", "Ingestion or Ollama not available");
  }

  if (ingestOk && ollamaOk) {
    try {
      var pipeline = require("../src/rag/ragPipeline");
      var routesOk = true;

      var greetResult = await pipeline.runFullPipeline("hola", 1, ["R1", "R2", "R4"], null);
      if (greetResult.decision !== "no_rag") {
        fail("4.2", "greeting should produce no_rag, got: " + greetResult.decision);
        routesOk = false;
      }

      var dkResult = await pipeline.runFullPipeline("no sé", 1, ["R1", "R2", "R4"], null);
      if (dkResult.decision !== "scaffold") {
        fail("4.2", "dont_know should produce scaffold, got: " + dkResult.decision);
        routesOk = false;
      }
      if (dkResult.augmentation.length === 0) {
        fail("4.2", "dont_know should produce augmentation, got empty string");
        routesOk = false;
      }

      var waResult = await pipeline.runFullPipeline("R1 y R5", 1, ["R1", "R2", "R4"], null);
      if (waResult.decision !== "rag_examples") {
        fail("4.2", "wrong_answer should produce rag_examples, got: " + waResult.decision);
        routesOk = false;
      }
      if (waResult.sources.length === 0) {
        fail("4.2", "wrong_answer should have sources, got 0");
        routesOk = false;
      }

      if (routesOk) {
        pass("4.2", "Classification routing: greeting->no_rag, dont_know->scaffold(" + dkResult.augmentation.length + " chars), wrong_answer->rag_examples(" + waResult.sources.length + " sources)");
      }
    } catch (e) {
      fail("4.2", "Classification routing error: " + e.message);
    }
  } else {
    skip("4.2", "Ingestion or Ollama not available");
  }

  summary();

  return { ollamaOk: ollamaOk, chromaOk: chromaOk, filesOk: filesOk, ingestOk: ingestOk };
}

main().catch(function (err) {
  console.error("Error fatal:", err);
  process.exit(1);
});
