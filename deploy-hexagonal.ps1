# ================================================================
#  Tutor Virtual - Despliegue Arquitectura Hexagonal (Windows)
#  Backend Irene en 127.0.0.1:3001  (nginx lo expone en /v2/)
#
#  Uso:   .\deploy-hexagonal.ps1
#         .\deploy-hexagonal.ps1 -BuildFrontend
#         .\deploy-hexagonal.ps1 -SkipEnvPatch
#         .\deploy-hexagonal.ps1 -StopAll
#         .\deploy-hexagonal.ps1 -DebugPipeline   (activa logs [DEBUG_PIPELINE])
# ================================================================

[CmdletBinding()]
param(
    [switch]$BuildFrontend,
    [switch]$SkipEnvPatch,
    [switch]$SkipHealthChecks,
    [switch]$StopAll,
    [switch]$DebugPipeline,

    # --- Rutas / servicios (editar si cambian en el servidor) ---
    [string]$ProjectRoot   = "C:\Users\admin\TutorVirtual_Irene",
    [string]$NginxDir      = "C:\nginx-1.28.1",
    [string]$PgServiceName = "postgresql-x64-18",
    [int]   $BackendPort   = 3001,
    [int]   $ChromaPort    = 8000,
    [int]   $PgPort        = 5432,

    # Chroma launcher (se autodetecta si se deja vacio).
    # Ejemplos validos:
    #   "chroma"                                          (si esta en PATH)
    #   "py -3.12 -m chromadb.cli.cli"                    (via py launcher)
    #   "C:\Users\admin\AppData\Roaming\Python\Python312\Scripts\chroma.exe"
    [string]$ChromaCmd = "",

    # Conexion Postgres que se escribira en .env si falta.
    # Cambia el password y el nombre de la BD segun tu instalacion.
    [string]$PgConnectionString = "postgresql://postgres:CHANGEME@127.0.0.1:5432/tutorvirtual"
)

$ErrorActionPreference = "Stop"

# ---------------- helpers de log ----------------
function Info($m) { Write-Host "[INFO] $m" -ForegroundColor Cyan }
function Ok  ($m) { Write-Host "[ OK ] $m" -ForegroundColor Green }
function Warn($m) { Write-Host "[WARN] $m" -ForegroundColor Yellow }
function Err ($m) { Write-Host "[FAIL] $m" -ForegroundColor Red }

function Test-Port([string]$TargetHost, [int]$Port, [int]$TimeoutMs = 1500) {
    try {
        $client = New-Object System.Net.Sockets.TcpClient
        $ar = $client.BeginConnect($TargetHost, $Port, $null, $null)
        $ok = $ar.AsyncWaitHandle.WaitOne($TimeoutMs, $false)
        if ($ok -and $client.Connected) { $client.EndConnect($ar); $client.Close(); return $true }
        $client.Close(); return $false
    } catch { return $false }
}

function Wait-Port([string]$Name, [string]$TargetHost, [int]$Port, [int]$MaxSeconds = 60) {
    Info "Esperando a que $Name escuche en ${TargetHost}:${Port} (max ${MaxSeconds}s)..."
    $deadline = (Get-Date).AddSeconds($MaxSeconds)
    while ((Get-Date) -lt $deadline) {
        if (Test-Port $TargetHost $Port) { Ok "$Name disponible en ${TargetHost}:${Port}"; return $true }
        Start-Sleep -Seconds 2
    }
    Err "$Name NO responde en ${TargetHost}:${Port} tras ${MaxSeconds}s"
    return $false
}

# ---------------- rutas derivadas ----------------
$BackendDir   = Join-Path $ProjectRoot "backend"
$FrontendDir  = Join-Path $ProjectRoot "frontend"
$FrontendDist = Join-Path $FrontendDir "dist"
$ChromaDir    = Join-Path $ProjectRoot "chroma"
$EnvFile      = Join-Path $BackendDir ".env"
$NginxExe     = Join-Path $NginxDir "nginx.exe"

# ================================================================
#                          STOP ALL
# ================================================================
if ($StopAll) {
    Info "Parando todos los servicios del despliegue..."

    # Nginx (usa -s quit/stop; si no responde, kill)
    try {
        if (Test-Path $NginxExe) {
            Push-Location $NginxDir
            & $NginxExe -s quit 2>$null
            Pop-Location
            Start-Sleep 2
        }
        Get-Process nginx -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
        Ok "Nginx parado"
    } catch { Warn "No se pudo parar nginx limpiamente: $($_.Exception.Message)" }

    # Backend Node en 3001 + Chroma en 8000: matar por puerto
    foreach ($p in @($BackendPort, $ChromaPort)) {
        try {
            $pids = (Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction SilentlyContinue).OwningProcess | Select-Object -Unique
            foreach ($procId in $pids) {
                if ($procId) {
                    Stop-Process -Id $procId -Force -ErrorAction SilentlyContinue
                    Ok "Proceso PID $procId (puerto $p) detenido"
                }
            }
        } catch { Warn "No se pudo liberar puerto ${p}: $($_.Exception.Message)" }
    }

    Info "PostgreSQL NO se detiene automaticamente (servicio Windows compartido). Si quieres pararlo: Stop-Service $PgServiceName"
    exit 0
}

# ================================================================
#                        CHECKS PREVIOS
# ================================================================
Info "=== CHECKS PREVIOS ==="

if (-not (Test-Path $BackendDir))  { Err "No existe $BackendDir"; exit 1 }
if (-not (Test-Path $EnvFile))     { Err "No existe $EnvFile"; exit 1 }
if (-not (Test-Path $ChromaDir))   { Err "No existe carpeta chroma en $ChromaDir"; exit 1 }
if (-not (Test-Path $NginxExe))    { Err "No existe $NginxExe"; exit 1 }
Ok "Estructura de carpetas correcta"

# Node
try {
    $nodeV = node --version 2>$null
    if (-not $nodeV) { throw "sin respuesta" }
    Ok "Node.js $nodeV"
} catch { Err "Node.js no encontrado en PATH"; exit 1 }

# Chroma launcher (autodetect si no se paso -ChromaCmd)
function Resolve-ChromaLauncher {
    # 1) Parametro explicito
    if ($ChromaCmd) { return $ChromaCmd }

    # 2) chroma en PATH
    $g = Get-Command chroma -ErrorAction SilentlyContinue
    if ($g) { return $g.Source }

    # 3) Rutas tipicas de pip install --user para varias versiones de Python
    $candidates = @(
        "$env:APPDATA\Python\Python312\Scripts\chroma.exe",
        "$env:APPDATA\Python\Python313\Scripts\chroma.exe",
        "$env:APPDATA\Python\Python311\Scripts\chroma.exe",
        "$env:LOCALAPPDATA\Programs\Python\Python312\Scripts\chroma.exe",
        "$env:LOCALAPPDATA\Programs\Python\Python311\Scripts\chroma.exe"
    )
    foreach ($c in $candidates) {
        if (Test-Path $c) { return $c }
    }

    # 4) py launcher + modulo chromadb en 3.12
    $py = Get-Command py -ErrorAction SilentlyContinue
    if ($py) {
        $check = & py -3.12 -c "import chromadb; print('ok')" 2>$null
        if ($check -eq "ok") { return "py -3.12 -m chromadb.cli.cli" }
        $check = & py -3 -c "import chromadb; print('ok')" 2>$null
        if ($check -eq "ok") { return "py -3 -m chromadb.cli.cli" }
    }

    return $null
}

$chromaLauncher = Resolve-ChromaLauncher
if (-not $chromaLauncher) {
    Err "No se pudo encontrar chroma. Instala con: py -3.12 -m pip install chromadb"
    Err "O pasa el launcher con -ChromaCmd 'C:\ruta\a\chroma.exe'"
    exit 1
}
Ok "Chroma launcher: $chromaLauncher"

# Servicio Postgres
$pgSvc = Get-Service -Name $PgServiceName -ErrorAction SilentlyContinue
if (-not $pgSvc) {
    Err "Servicio Windows '$PgServiceName' no existe. Ajusta -PgServiceName."
    Warn "Servicios Postgres detectados:"
    Get-Service -Name "postgresql*" -ErrorAction SilentlyContinue | Format-Table -AutoSize
    exit 1
}
Ok "Servicio Postgres encontrado: $($pgSvc.Name) ($($pgSvc.Status))"

# ================================================================
#                        PARCHE .ENV
# ================================================================
function Set-EnvValue([string]$Path, [string]$Key, [string]$Value) {
    $raw = Get-Content $Path -Raw
    $escapedKey = [regex]::Escape($Key)
    $pattern = "(?m)^\s*$escapedKey\s*=.*$"
    $newLine = "$Key=$Value"
    if ([regex]::IsMatch($raw, $pattern)) {
        $raw = [regex]::Replace($raw, $pattern, $newLine)
    } else {
        if ($raw -and -not $raw.EndsWith("`n")) { $raw += "`r`n" }
        $raw += "$newLine`r`n"
    }
    Set-Content -Path $Path -Value $raw -NoNewline -Encoding UTF8
}

function Get-EnvValue([string]$Path, [string]$Key) {
    $raw = Get-Content $Path -Raw
    $escapedKey = [regex]::Escape($Key)
    $m = [regex]::Match($raw, "(?m)^\s*$escapedKey\s*=\s*(.+?)\s*(#.*)?$")
    if ($m.Success) { return $m.Groups[1].Value } else { return $null }
}

# Set a key only if it doesn't already exist; returns $true if it wrote.
function Set-EnvValueIfMissing([string]$Path, [string]$Key, [string]$Value) {
    $existing = Get-EnvValue $Path $Key
    if ([string]::IsNullOrEmpty($existing)) {
        Set-EnvValue $Path $Key $Value
        return $true
    }
    return $false
}

if (-not $SkipEnvPatch) {
    Info "=== AJUSTANDO .env PARA PRODUCCION ==="

    # Backup
    $backup = "$EnvFile.bak.$((Get-Date).ToString('yyyyMMdd-HHmmss'))"
    Copy-Item $EnvFile $backup
    Ok "Backup creado: $backup"

    Set-EnvValue $EnvFile "NODE_ENV"        "production"
    Set-EnvValue $EnvFile "DEV_BYPASS_AUTH" "false"
    Set-EnvValue $EnvFile "DATABASE_TYPE"   "postgresql"
    Set-EnvValue $EnvFile "PORT"            "$BackendPort"
    Set-EnvValue $EnvFile "CHROMA_URL"      "http://127.0.0.1:$ChromaPort"

    # PG_CONNECTION_STRING: solo escribir si no existe ya
    $existingPg = Get-EnvValue $EnvFile "PG_CONNECTION_STRING"
    if (-not $existingPg) {
        Set-EnvValue $EnvFile "PG_CONNECTION_STRING" $PgConnectionString
        if ($PgConnectionString -match "CHANGEME") {
            Warn "PG_CONNECTION_STRING escrita con password CHANGEME. Edita .env antes de continuar en produccion real."
        }
    } else {
        Ok "PG_CONNECTION_STRING ya existe en .env (no se sobrescribe)"
    }

    Ok ".env actualizado (NODE_ENV, DEV_BYPASS_AUTH, DATABASE_TYPE, PORT, CHROMA_URL)"

    # --- Variables del refactor hexagonal (Phase 5) ---
    # Solo se escriben si faltan, para respetar ajustes manuales del usuario.
    $refactorVars = [ordered]@{
        "USE_ORCHESTRATOR"              = "1"
        "AUDIT_LOG"                     = "1"
        "GUARDRAIL_BUDGET_MS"           = "45000"
        "GUARDRAIL_MIN_RETRY_BUDGET_MS" = "10000"
        "ORCHESTRATOR_BUDGET_MS"        = "45000"
    }
    $added = @()
    foreach ($k in $refactorVars.Keys) {
        if (Set-EnvValueIfMissing $EnvFile $k $refactorVars[$k]) {
            $added += $k
        }
    }
    if ($added.Count -gt 0) {
        Ok "Vars del refactor hexagonal añadidas al .env: $($added -join ', ')"
    } else {
        Ok "Vars del refactor hexagonal ya presentes en .env"
    }
} else {
    Warn "-SkipEnvPatch: se respeta el .env tal cual"
}

# ================================================================
#                        1) POSTGRESQL
# ================================================================
Info "=== 1/4 PostgreSQL ==="

if ($pgSvc.Status -ne "Running") {
    Info "Iniciando servicio $PgServiceName..."
    Start-Service $PgServiceName
    Start-Sleep 2
}
if (-not (Wait-Port "PostgreSQL" "127.0.0.1" $PgPort 30)) {
    Err "PostgreSQL no esta escuchando en $PgPort. Aborto."
    exit 1
}

# ================================================================
#                        2) CHROMADB
# ================================================================
Info "=== 2/4 ChromaDB ==="

if (Test-Port "127.0.0.1" $ChromaPort) {
    Warn "Puerto $ChromaPort ya en uso. Asumo que Chroma ya esta corriendo."
} else {
    # Si el launcher contiene un .exe con espacios o es un comando compuesto,
    # respetamos el string tal cual. Si es una ruta a exe, la envolvemos en comillas.
    if ($chromaLauncher -match '\.exe$' -and $chromaLauncher -notmatch '^".*"$') {
        $launcherPart = "& `"$chromaLauncher`""
    } else {
        $launcherPart = $chromaLauncher
    }
    $chromaCmdLine = "$launcherPart run --host 127.0.0.1 --port $ChromaPort --path `"$ChromaDir`""
    Info "Lanzando en ventana nueva: $chromaCmdLine"
    Start-Process -FilePath "powershell.exe" `
        -ArgumentList "-NoExit", "-Command", "`$Host.UI.RawUI.WindowTitle='ChromaDB :$ChromaPort'; Set-Location `"$ProjectRoot`"; $chromaCmdLine" `
        -WindowStyle Normal | Out-Null

    if (-not (Wait-Port "ChromaDB" "127.0.0.1" $ChromaPort 60)) {
        Err "ChromaDB no arranco. Revisa la ventana de Chroma."
        exit 1
    }
}

# ================================================================
#                        3) BACKEND NODE (hexagonal, :3001)
# ================================================================
Info "=== 3/4 Backend Node hexagonal ==="

if (Test-Port "127.0.0.1" $BackendPort) {
    Warn "Puerto $BackendPort ya en uso. Asumo que el backend ya esta corriendo."
} else {
    # Ejecutar npm install si node_modules no existe O si package.json es mas nuevo
    # que el lockfile interno (indica que deps cambiaron tras un git pull).
    $nodeModulesDir = Join-Path $BackendDir "node_modules"
    $pkgJson        = Join-Path $BackendDir "package.json"
    $internalLock   = Join-Path $nodeModulesDir ".package-lock.json"

    $needsInstall = $false
    $reason = ""
    if (-not (Test-Path $nodeModulesDir)) {
        $needsInstall = $true
        $reason = "node_modules no existe"
    } elseif (-not (Test-Path $internalLock)) {
        $needsInstall = $true
        $reason = "node_modules/.package-lock.json no existe"
    } elseif ((Get-Item $pkgJson).LastWriteTime -gt (Get-Item $internalLock).LastWriteTime) {
        $needsInstall = $true
        $reason = "package.json mas nuevo que node_modules/.package-lock.json"
    }

    if ($needsInstall) {
        Info "Instalando dependencias backend (npm install) - motivo: $reason"
        Push-Location $BackendDir
        & npm install
        Pop-Location
        Ok "Dependencias backend instaladas"
    } else {
        Ok "Dependencias backend al dia (skip npm install)"
    }

    if ($BuildFrontend) {
        Info "Compilando frontend (vite build)..."
        Push-Location $FrontendDir
        if (-not (Test-Path (Join-Path $FrontendDir "node_modules"))) { & npm install }
        & npm run build
        Pop-Location
        Ok "Frontend build generado en $FrontendDist"
    }

    $backendCmd = "node src/index.js"
    $debugPrefix = ""
    if ($DebugPipeline) {
        $debugPrefix = "`$env:DEBUG_PIPELINE='1'; Write-Host '[DEBUG_PIPELINE enabled]' -ForegroundColor Yellow; "
        Info "DebugPipeline activado: la ventana del backend correra con DEBUG_PIPELINE=1"
    }
    Info "Lanzando en ventana nueva: $backendCmd (cwd=$BackendDir)"
    Start-Process -FilePath "powershell.exe" `
        -ArgumentList "-NoExit", "-Command", "`$Host.UI.RawUI.WindowTitle='Backend hexagonal :$BackendPort'; Set-Location `"$BackendDir`"; $debugPrefix$backendCmd" `
        -WindowStyle Normal | Out-Null

    if (-not (Wait-Port "Backend Node" "127.0.0.1" $BackendPort 60)) {
        Err "Backend Node no arranco en $BackendPort. Revisa su ventana."
        exit 1
    }
}

# ================================================================
#                        4) NGINX
# ================================================================
Info "=== 4/4 Nginx ==="

$nginxRunning = Get-Process nginx -ErrorAction SilentlyContinue
if ($nginxRunning) {
    Info "Nginx ya estaba corriendo. Recargando config (-s reload)..."
    Push-Location $NginxDir
    & $NginxExe -t
    if ($LASTEXITCODE -ne 0) { Err "Config de nginx invalida"; Pop-Location; exit 1 }
    & $NginxExe -s reload
    Pop-Location
    Ok "Nginx recargado"
} else {
    Info "Validando config nginx..."
    Push-Location $NginxDir
    & $NginxExe -t
    if ($LASTEXITCODE -ne 0) { Err "Config de nginx invalida"; Pop-Location; exit 1 }
    Pop-Location

    Info "Lanzando nginx en ventana nueva..."
    Start-Process -FilePath "powershell.exe" `
        -ArgumentList "-NoExit", "-Command", "`$Host.UI.RawUI.WindowTitle='Nginx'; Set-Location `"$NginxDir`"; .\nginx.exe; Write-Host 'Nginx salio'" `
        -WindowStyle Normal | Out-Null

    Start-Sleep 3
    if (-not (Get-Process nginx -ErrorAction SilentlyContinue)) {
        Err "Nginx no esta corriendo tras el arranque. Revisa su ventana / logs en $NginxDir\logs"
        exit 1
    }
    Ok "Nginx arrancado"
}

# ================================================================
#                        HEALTH CHECKS
# ================================================================
if (-not $SkipHealthChecks) {
    Info "=== HEALTH CHECKS ==="

    # Chroma heartbeat
    try {
        Invoke-RestMethod -Uri "http://127.0.0.1:$ChromaPort/api/v2/heartbeat" -TimeoutSec 5 | Out-Null
        Ok "ChromaDB heartbeat OK"
    } catch { Warn "ChromaDB heartbeat fallo: $($_.Exception.Message)" }

    # Backend /api/health directo
    try {
        $h = Invoke-RestMethod -Uri "http://127.0.0.1:$BackendPort/api/health" -TimeoutSec 5
        if ($h.ok) { Ok "Backend /api/health OK (directo :$BackendPort)" }
        else       { Warn "Backend /api/health devolvio: $($h | ConvertTo-Json -Compress)" }
    } catch { Warn "Backend /api/health fallo: $($_.Exception.Message)" }

    # Nginx -> backend via /v2/api/health (HTTPS)
    try {
        # -k acepta el cert del servidor (selfsigned si aplica)
        $curlOut = & curl.exe -sk "https://tutor-virtual.dsic.upv.es/v2/api/health" --max-time 10 2>&1
        if ($curlOut -match '"ok"\s*:\s*true') {
            Ok "Nginx -> backend_irene OK (https /v2/api/health)"
        } else {
            Warn "Nginx /v2/api/health respuesta inesperada: $curlOut"
        }
    } catch { Warn "Nginx check fallo: $($_.Exception.Message)" }
}

# ================================================================
Write-Host ""
Write-Host "=============================================" -ForegroundColor Green
Write-Host " DESPLIEGUE HEXAGONAL LISTO" -ForegroundColor Green
Write-Host "=============================================" -ForegroundColor Green
Write-Host " Frontend:   https://tutor-virtual.dsic.upv.es/v2/"
Write-Host " API:        https://tutor-virtual.dsic.upv.es/v2/api/health"
Write-Host " Backend:    http://127.0.0.1:$BackendPort  (interno)"
Write-Host " ChromaDB:   http://127.0.0.1:$ChromaPort   (interno)"
Write-Host " Postgres:   127.0.0.1:$PgPort              (servicio $PgServiceName)"
Write-Host ""
Write-Host " Para parar todo:   .\deploy-hexagonal.ps1 -StopAll"
Write-Host "=============================================" -ForegroundColor Green
