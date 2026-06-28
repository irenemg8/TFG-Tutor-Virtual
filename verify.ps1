# Virtual Tutor - RAG System Verification Script
# Run: .\verify.ps1

$passed = 0
$failed = 0
$skipped = 0

function Pass($step, $msg) {
    Write-Host "[PASS] $step - $msg" -ForegroundColor Green
    $script:passed++
}

function Fail($step, $msg) {
    Write-Host "[FAIL] $step - $msg" -ForegroundColor Red
    $script:failed++
}

function Skip($step, $msg) {
    Write-Host "[SKIP] $step - $msg" -ForegroundColor Yellow
    $script:skipped++
}

function Summary() {
    Write-Host ""
    Write-Host "========================================" -ForegroundColor Cyan
    Write-Host "PASSED: $passed  FAILED: $failed  SKIPPED: $skipped" -ForegroundColor Cyan
    Write-Host "========================================" -ForegroundColor Cyan
}

$projectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$backendDir = Join-Path $projectRoot "backend"
$evaluationDir = Join-Path $projectRoot "evaluation"
$datasetsDir = Join-Path (Join-Path (Join-Path $projectRoot "material-complementario") "llm") "datasets"
$kgDir = Join-Path (Join-Path (Join-Path $projectRoot "material-complementario") "llm") "knowledge-graph"
$kgPath = Join-Path $kgDir "knowledge-graph-with-interactions-and-rewards.json"

$ollamaOk = $false
$chromaOk = $false
$filesOk = $false
$serverOk = $false

# =============================================
Write-Host ""
Write-Host "=== PHASE 0: Prerequisites ===" -ForegroundColor Cyan
Write-Host ""

# --- 0.1: Node.js ---
try {
    $nodeVersion = node --version 2>$null
    if ($nodeVersion) {
        Pass "0.1" "Node.js installed: $nodeVersion"
    } else {
        Fail "0.1" "Node.js not found. Install from https://nodejs.org"
    }
} catch {
    Fail "0.1" "Node.js not found. Install from https://nodejs.org"
}

# --- 0.2: npm dependencies ---
$nodeModulesDir = Join-Path $backendDir "node_modules"
if (Test-Path $nodeModulesDir) {
    $hasChroma = Test-Path (Join-Path $nodeModulesDir "chromadb")
    $hasAxios = Test-Path (Join-Path $nodeModulesDir "axios")
    $hasMongoose = Test-Path (Join-Path $nodeModulesDir "mongoose")
    if ($hasChroma -and $hasAxios -and $hasMongoose) {
        Pass "0.2" "npm dependencies installed (chromadb, axios, mongoose)"
    } else {
        $missing = @()
        if (-not $hasChroma) { $missing += "chromadb" }
        if (-not $hasAxios) { $missing += "axios" }
        if (-not $hasMongoose) { $missing += "mongoose" }
        Fail "0.2" "Missing npm packages: $($missing -join ', '). Run: cd backend && npm install"
    }
} else {
    Fail "0.2" "node_modules not found. Run: cd backend && npm install"
}

# --- 0.3: Python ---
try {
    $pyVersion = python --version 2>&1
    if ($pyVersion -match "Python 3") {
        Pass "0.3" "Python installed: $pyVersion"
    } else {
        Fail "0.3" "Python 3 not found. Install from https://python.org"
    }
} catch {
    Fail "0.3" "Python not found. Install from https://python.org"
}

# --- 0.4: Ollama available ---
$envFile = Join-Path $backendDir ".env"
$ollamaUrl = "http://127.0.0.1:11434"
if (Test-Path $envFile) {
    $envContent = Get-Content $envFile -Raw
    if ($envContent -match "OLLAMA_API_URL_UPV=(.+)") {
        $ollamaUrl = $Matches[1].Trim()
    } elseif ($envContent -match "OLLAMA_BASE_URL=(.+)") {
        $ollamaUrl = $Matches[1].Trim()
    }
}
$ollamaUrl = $ollamaUrl.TrimEnd("/")

try {
    $response = Invoke-RestMethod -Uri "$ollamaUrl/api/tags" -TimeoutSec 10 -ErrorAction Stop
    $modelNames = $response.models | ForEach-Object { $_.name }
    $hasQwen = ($modelNames | Where-Object { $_ -match "qwen2.5" }).Count -gt 0
    $hasNomic = ($modelNames | Where-Object { $_ -match "nomic-embed-text" }).Count -gt 0

    if ($hasQwen -and $hasNomic) {
        Pass "0.4" "Ollama available at $ollamaUrl (qwen2.5 + nomic-embed-text)"
        $ollamaOk = $true
    } else {
        $missing = @()
        if (-not $hasQwen) { $missing += "qwen2.5" }
        if (-not $hasNomic) { $missing += "nomic-embed-text" }
        Fail "0.4" "Ollama responds but missing models: $($missing -join ', ')"
    }
} catch {
    Fail "0.4" "Ollama not available at $ollamaUrl - Check .env or run: ollama serve"
}

# --- 0.5: ChromaDB available ---
try {
    $chromaResponse = Invoke-RestMethod -Uri "http://localhost:8000/api/v2/heartbeat" -TimeoutSec 5 -ErrorAction Stop
    Pass "0.5" "ChromaDB available at http://localhost:8000"
    $chromaOk = $true
} catch {
    Fail "0.5" "ChromaDB not available. Run: chroma run --host localhost --port 8000"
}

# --- 0.6: Data files ---
$datasetFiles = @(
    "dataset_exercise_1.json",
    "dataset_exercise_3.json",
    "dataset_exercise_4.json",
    "dataset_exercise_5.json",
    "dataset_exercise_6.json",
    "dataset_exercise_7.json"
)
$allExist = $true
foreach ($file in $datasetFiles) {
    $filePath = Join-Path $datasetsDir $file
    if (-not (Test-Path $filePath)) {
        Fail "0.6" "Dataset not found: $file"
        $allExist = $false
    }
}
if (-not (Test-Path $kgPath)) {
    Fail "0.6" "Knowledge graph not found"
    $allExist = $false
}
if ($allExist) {
    Pass "0.6" "All 6 datasets + knowledge graph exist"
    $filesOk = $true
}

# --- 0.7: .env files ---
$backendEnv = Join-Path $backendDir ".env"
$frontendDir = Join-Path $projectRoot "frontend"
$frontendEnv = Join-Path $frontendDir ".env"
$envOk = $true
if (-not (Test-Path $backendEnv)) {
    Fail "0.7" "backend/.env not found"
    $envOk = $false
}
if (-not (Test-Path $frontendEnv)) {
    Fail "0.7" "frontend/.env not found"
    $envOk = $false
}
if ($envOk) {
    Pass "0.7" "Environment files exist (backend/.env, frontend/.env)"
}

# =============================================
Write-Host ""
Write-Host "=== PHASE 1: RAG Modules ===" -ForegroundColor Cyan
Write-Host ""

$ragDir = Join-Path (Join-Path $backendDir "src") "rag"
$ragModules = @(
    "config.js",
    "embeddings.js",
    "chromaClient.js",
    "bm25.js",
    "hybridSearch.js",
    "queryClassifier.js",
    "knowledgeGraph.js",
    "ingest.js",
    "guardrails.js",
    "ragPipeline.js",
    "logger.js",
    "ragMiddleware.js"
)

$allModulesExist = $true
foreach ($module in $ragModules) {
    $modulePath = Join-Path $ragDir $module
    if (-not (Test-Path $modulePath)) {
        Fail "1.1" "RAG module not found: $module"
        $allModulesExist = $false
    }
}
if ($allModulesExist) {
    Pass "1.1" "All 12 RAG modules exist in backend/src/rag/"
}

# --- 1.2: Run verifyRag.js (FASE 0-4) ---
if ($ollamaOk -and $chromaOk -and $filesOk) {
    Write-Host ""
    Write-Host "Running verifyRag.js (modules + ingestion + pipeline)..." -ForegroundColor Gray
    $verifyScript = Join-Path (Join-Path $backendDir "tests") "verifyRag.js"
    if (Test-Path $verifyScript) {
        $verifyOutput = & node $verifyScript 2>$null
        $verifyText = $verifyOutput -join "`n"

        # Count PASS/FAIL from the script output
        $scriptPass = ([regex]::Matches($verifyText, "\[PASS\]")).Count
        $scriptFail = ([regex]::Matches($verifyText, "\[FAIL\]")).Count
        $scriptSkip = ([regex]::Matches($verifyText, "\[SKIP\]")).Count

        if ($scriptFail -eq 0) {
            Pass "1.2" "verifyRag.js: $scriptPass passed, $scriptFail failed, $scriptSkip skipped"
        } else {
            Fail "1.2" "verifyRag.js: $scriptPass passed, $scriptFail failed, $scriptSkip skipped"
            # Show failed lines
            $failLines = $verifyOutput | Where-Object { $_ -match "\[FAIL\]" }
            foreach ($line in $failLines) {
                Write-Host "       $line" -ForegroundColor Red
            }
        }
    } else {
        Fail "1.2" "verifyRag.js not found at backend/tests/verifyRag.js"
    }
} else {
    Skip "1.2" "Ollama, ChromaDB, or data files not available"
}

# =============================================
Write-Host ""
Write-Host "=== PHASE 2: Server ===" -ForegroundColor Cyan
Write-Host ""

# --- 2.1: Server running ---
try {
    $healthResponse = Invoke-RestMethod -Uri "http://localhost:3000/api/health" -TimeoutSec 5 -ErrorAction Stop
    if ($healthResponse.ok -eq $true) {
        Pass "2.1" "Backend server running at http://localhost:3000"
        $serverOk = $true
    } else {
        Fail "2.1" "Server health check failed. Run: cd backend && npm start"
    }
} catch {
    Fail "2.1" "Server not running. Start with: cd backend && npm start"
}

# --- 2.2: RAG endpoint ---
if ($serverOk) {
    try {
        # Get an exercise ID from the API
        $exercises = Invoke-RestMethod -Uri "http://localhost:3000/api/ejercicios" -TimeoutSec 10 -ErrorAction Stop
        if ($exercises.Count -gt 0) {
            $exerciseId = $exercises[0]._id
            $bodyJson = '{"userId":"000000000000000000000001","exerciseId":"' + $exerciseId + '","userMessage":"R1 y R5"}'

            # Use curl.exe for SSE (PowerShell aliases curl to Invoke-WebRequest)
            # Write body to temp file to avoid PowerShell escaping issues
            $tempBody = Join-Path $env:TEMP "rag_test_body.json"
            $bodyJson | Out-File -FilePath $tempBody -Encoding utf8 -NoNewline
            $curlOutput = & curl.exe -s -X POST "http://localhost:3000/api/ollama/chat/stream" -H "Content-Type: application/json" -d "@$tempBody" --max-time 120 2>&1
            Remove-Item $tempBody -ErrorAction SilentlyContinue
            $curlText = ($curlOutput | Out-String)
            $hasDone = $curlText.Contains("[DONE]")
            $hasChunk = $curlText.Contains('"chunk"')

            if ($hasDone -and $hasChunk) {
                Pass "2.2" "RAG SSE endpoint works (received response chunks + [DONE])"
            } else {
                Fail "2.2" "SSE response incomplete (chunk=$hasChunk, done=$hasDone)"
            }
        } else {
            Skip "2.2" "No exercises found in database"
        }
    } catch {
        Fail "2.2" "RAG endpoint error: $($_.Exception.Message)"
    }
} else {
    Skip "2.2" "Server not running"
}

# --- 2.3: RAG logging ---
$logDir = Join-Path (Join-Path $backendDir "logs") "rag"
$today = (Get-Date).ToString("yyyy-MM-dd")
$logFile = Join-Path $logDir "$today.jsonl"
if (Test-Path $logFile) {
    $lastLine = Get-Content $logFile -Tail 1
    try {
        $parsed = $lastLine | ConvertFrom-Json
        if ($parsed.classification) {
            Pass "2.3" "RAG logging active ($today.jsonl, last entry: $($parsed.classification))"
        } else {
            Fail "2.3" "Log file exists but entries are malformed"
        }
    } catch {
        Fail "2.3" "Log file exists but last line is not valid JSON"
    }
} else {
    Skip "2.3" "No log file for today. Run an interaction first"
}

# =============================================
Write-Host ""
Write-Host "=== PHASE 3: Evaluation Scripts ===" -ForegroundColor Cyan
Write-Host ""

# --- 3.1: evaluation/config.py ---
$configPy = Join-Path $evaluationDir "config.py"
if (Test-Path $configPy) {
    try {
        $pyOutput = & python -c "import sys; sys.path.insert(0, '$($evaluationDir -replace '\\','/')'); import config; print(len(config.DATASET_MAP))" 2>&1
        if ($pyOutput -match "7") {
            Pass "3.1" "evaluation/config.py loads correctly (7 datasets)"
        } else {
            Fail "3.1" "evaluation/config.py error: $pyOutput"
        }
    } catch {
        Fail "3.1" "evaluation/config.py error: $($_.Exception.Message)"
    }
} else {
    Fail "3.1" "evaluation/config.py not found"
}

# --- 3.2: evaluateRetrieval.py ---
$evalRetrieval = Join-Path $evaluationDir "evaluateRetrieval.py"
if (Test-Path $evalRetrieval) {
    try {
        $pyOutput = & python $evalRetrieval 2>&1
        $pyText = $pyOutput -join " "
        if ($pyText -match "error" -and $pyText -notmatch "No log entries" -and $pyText -notmatch "No evaluable") {
            Fail "3.2" "evaluateRetrieval.py crashed: $pyText"
        } else {
            Pass "3.2" "evaluateRetrieval.py runs without errors"
        }
    } catch {
        Fail "3.2" "evaluateRetrieval.py error: $($_.Exception.Message)"
    }
} else {
    Fail "3.2" "evaluateRetrieval.py not found"
}

# --- 3.3: evaluateGeneration.py ---
$evalGeneration = Join-Path $evaluationDir "evaluateGeneration.py"
if (Test-Path $evalGeneration) {
    try {
        $pyOutput = & python $evalGeneration 2>&1
        $pyText = $pyOutput -join " "
        if ($pyText -match "error" -and $pyText -notmatch "No log entries" -and $pyText -notmatch "No evaluable") {
            Fail "3.3" "evaluateGeneration.py crashed: $pyText"
        } else {
            Pass "3.3" "evaluateGeneration.py runs without errors"
        }
    } catch {
        Fail "3.3" "evaluateGeneration.py error: $($_.Exception.Message)"
    }
} else {
    Fail "3.3" "evaluateGeneration.py not found"
}

# --- 3.4: runBenchmark.py ---
$runBenchmark = Join-Path $evaluationDir "runBenchmark.py"
if (Test-Path $runBenchmark) {
    Pass "3.4" "runBenchmark.py exists"
} else {
    Fail "3.4" "runBenchmark.py not found"
}

# =============================================
Write-Host ""
Write-Host "=== PHASE 4: Integration Check ===" -ForegroundColor Cyan
Write-Host ""

# --- 4.1: RAG middleware registered in index.js ---
$srcDir = Join-Path $backendDir "src"
$indexJs = Join-Path $srcDir "index.js"
if (Test-Path $indexJs) {
    $indexContent = Get-Content $indexJs -Raw
    $hasRequire = $indexContent -match 'require.*rag.*ragMiddleware'
    $hasUse = $indexContent -match 'app\.use.*ragMiddleware'
    if ($hasRequire -and $hasUse) {
        Pass "4.1" "RAG middleware registered in index.js (require + app.use)"
    } else {
        $missing = @()
        if (-not $hasRequire) { $missing += "require" }
        if (-not $hasUse) { $missing += "app.use" }
        Fail "4.1" "index.js missing RAG integration: $($missing -join ', ')"
    }
} else {
    Fail "4.1" "index.js not found"
}

# --- 4.2: ChromaDB collections (if ChromaDB is running) ---
if ($chromaOk) {
    try {
        $colOutput = & curl.exe -s "http://localhost:8000/api/v2/tenants/default_tenant/databases/default_database/collections" 2>&1
        $colText = $colOutput -join ""
        # Count collection entries by counting "name" occurrences
        $colCount = ([regex]::Matches($colText, '"name"')).Count
        if ($colCount -ge 7) {
            Pass "4.2" "ChromaDB has $colCount collections (expected 7+)"
        } else {
            Fail "4.2" "ChromaDB has only $colCount collections. Run: cd backend && node src/rag/ingest.js"
        }
    } catch {
        Skip "4.2" "Could not query ChromaDB collections API"
    }
} else {
    Skip "4.2" "ChromaDB not available"
}

# =============================================
Summary

Write-Host ""
if ($failed -eq 0) {
    Write-Host "All checks passed! The system is ready." -ForegroundColor Green
} else {
    Write-Host "Some checks failed. Review the FAIL items above." -ForegroundColor Red
    Write-Host "See backend/tests/VERIFICATION_REPORT.md for troubleshooting." -ForegroundColor Yellow
}
Write-Host ""
