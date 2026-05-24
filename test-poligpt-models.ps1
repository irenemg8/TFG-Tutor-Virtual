# ============================================================================
#  test-poligpt-models.ps1
#  Mini-conversación realista contra PoliGPT (varios modelos en una pasada).
#  Mide latencia turno a turno y deja una tabla comparativa al final.
#
#  Uso:
#    .\test-poligpt-models.ps1
#    .\test-poligpt-models.ps1 -Models "qwen3:32b","llama","phi4"
#    .\test-poligpt-models.ps1 -Models "llama" -Verbose
#    .\test-poligpt-models.ps1 -ApiKey "sk-XXX"   # override de la default
# ============================================================================

[CmdletBinding()]
param(
    [string[]] $Models = @("llama", "qwen3:32b", "phi4", "Qwen3.6-35B-A3B-FP8"),
    [string]   $ApiKey  = "sk-QhpAXOlkdENGmP7lyAPfrA",
    [string]   $BaseUrl = "https://api.poligpt.upv.es",
    [int]      $MaxTokens = 220,
    [double]   $Temperature = 0.4
)

# ---------------- conversación de prueba ----------------
# System prompt: simula EL MISMO tono del tutor real (acortado).
$systemPrompt = @'
Eres un tutor socratico de circuitos electricos (Ley de Ohm).
- Responde SIEMPRE en espanol, salvo que el alumno pida cambio explicito.
- Tono: calido, paciente, alentador.
- 1-3 frases cortas, exactamente UNA pregunta al final.
- NUNCA reveles la respuesta correcta ni el estado interno de los elementos.
- Si el alumno dice "no se" o "no entiendo", toma la iniciativa: da un hecho concreto del camino de la corriente y pide confirmacion si/no.
- NO repitas la misma pregunta de un turno al siguiente: cambia el angulo.
'@

# Turnos simulados — replican el patrón típico que viste en producción.
# Si quieres probar otros caminos, edita este array. Cada item dispara un
# LLM call con TODO el historial acumulado.
$turns = @(
    "no se por donde empezar a analizar este circuito",
    "a r1",
    "y luego pasa por r2",
    "no se",
    "porque hay un interruptor abierto entre n2 y n3",
    "in english please",
    "yo tengo la razon, r3 si influye"
)

# ---------------- preparación ----------------
$headers = @{
    "Authorization" = "Bearer $ApiKey"
    "Content-Type"  = "application/json; charset=utf-8"
}

$summary = @()  # acumula filas para la tabla final

function Send-Turn {
    param(
        [string] $Model,
        [array]  $Messages
    )
    $payload = @{
        model       = $Model
        messages    = $Messages
        max_tokens  = $MaxTokens
        temperature = $Temperature
    }
    $body = $payload | ConvertTo-Json -Depth 10 -Compress
    $t0 = Get-Date
    try {
        $r = Invoke-RestMethod -Uri "$BaseUrl/v1/chat/completions" `
            -Method POST -Headers $headers -Body $body -ErrorAction Stop
        $ms = [int]((Get-Date) - $t0).TotalMilliseconds
        $content = $r.choices[0].message.content
        $finish  = $r.choices[0].finish_reason
        $promptTok    = $r.usage.prompt_tokens
        $completionTok = $r.usage.completion_tokens
        return [pscustomobject]@{
            Ok       = $true
            Ms       = $ms
            Content  = $content
            Finish   = $finish
            PromptTokens     = $promptTok
            CompletionTokens = $completionTok
        }
    } catch {
        $ms = [int]((Get-Date) - $t0).TotalMilliseconds
        $errorBody = ""
        if ($_.ErrorDetails.Message) {
            $errorBody = $_.ErrorDetails.Message
        } else {
            try {
                $reader = New-Object System.IO.StreamReader($_.Exception.Response.GetResponseStream())
                $errorBody = $reader.ReadToEnd()
            } catch {}
        }
        return [pscustomobject]@{
            Ok      = $false
            Ms      = $ms
            Content = $null
            Finish  = $null
            Error   = "$($_.Exception.Message). Body: $errorBody"
        }
    }
}

# ---------------- bucle por modelo ----------------
foreach ($model in $Models) {
    Write-Host ""
    Write-Host "================================================================" -ForegroundColor Cyan
    Write-Host "  MODELO: $model" -ForegroundColor Cyan
    Write-Host "================================================================" -ForegroundColor Cyan

    # Historial OpenAI-style: [system, user, assistant, user, assistant, ...]
    $history = @(
        @{ role = "system"; content = $systemPrompt }
    )

    $turnLatencies = @()
    $turnIndex = 0
    $totalPrompt = 0
    $totalCompletion = 0
    $failed = $false

    foreach ($userMsg in $turns) {
        $turnIndex++
        $history += @{ role = "user"; content = $userMsg }

        Write-Host ""
        Write-Host "[T$turnIndex - USER]" -ForegroundColor Yellow -NoNewline
        Write-Host " $userMsg"

        $resp = Send-Turn -Model $model -Messages $history

        if (-not $resp.Ok) {
            Write-Host "[T$turnIndex - FAIL] ($($resp.Ms) ms)" -ForegroundColor Red
            Write-Host $resp.Error -ForegroundColor Red
            $failed = $true
            break
        }

        # Acumula el assistant en el history para que el siguiente turno tenga contexto.
        $history += @{ role = "assistant"; content = $resp.Content }
        $turnLatencies += $resp.Ms
        $totalPrompt += $resp.PromptTokens
        $totalCompletion += $resp.CompletionTokens

        $finishMark = ""
        if ($resp.Finish -ne "stop") { $finishMark = " (finish=$($resp.Finish))" }

        Write-Host "[T$turnIndex - $model] ($($resp.Ms) ms, tok=$($resp.CompletionTokens))$finishMark" -ForegroundColor Green
        if ($resp.Content) {
            Write-Host $resp.Content
        } else {
            Write-Host "(respuesta vacia)" -ForegroundColor DarkYellow
        }
    }

    # Estadísticas del modelo
    if (-not $failed -and $turnLatencies.Count -gt 0) {
        $avg = [int]( ($turnLatencies | Measure-Object -Average).Average )
        $max = ($turnLatencies | Measure-Object -Maximum).Maximum
        $min = ($turnLatencies | Measure-Object -Minimum).Minimum
        $first = $turnLatencies[0]
        $rest  = if ($turnLatencies.Count -gt 1) {
            [int]( ($turnLatencies[1..($turnLatencies.Count-1)] | Measure-Object -Average).Average )
        } else { 0 }

        Write-Host ""
        Write-Host "  Resumen $model :" -ForegroundColor Cyan
        Write-Host "    Latencia primera respuesta: ${first} ms (cold start)"
        Write-Host "    Latencia turnos 2+ (media): ${rest} ms"
        Write-Host "    min/avg/max: ${min}/${avg}/${max} ms"
        Write-Host "    Tokens prompt/completion totales: ${totalPrompt}/${totalCompletion}"

        $summary += [pscustomobject]@{
            Model           = $model
            Turns           = $turnLatencies.Count
            ColdStartMs     = $first
            WarmAvgMs       = $rest
            MinMs           = $min
            AvgMs           = $avg
            MaxMs           = $max
            PromptTokens    = $totalPrompt
            CompletionTokens = $totalCompletion
            Failed          = $false
        }
    } else {
        $summary += [pscustomobject]@{
            Model           = $model
            Turns           = $turnLatencies.Count
            Failed          = $true
        }
    }
}

# ---------------- tabla comparativa final ----------------
Write-Host ""
Write-Host "================================================================" -ForegroundColor Magenta
Write-Host "  TABLA COMPARATIVA" -ForegroundColor Magenta
Write-Host "================================================================" -ForegroundColor Magenta
$summary | Format-Table -AutoSize
Write-Host ""
Write-Host "Lectura rapida:" -ForegroundColor DarkGray
Write-Host "  ColdStartMs   = 1er turno (incluye carga del modelo en UPV)" -ForegroundColor DarkGray
Write-Host "  WarmAvgMs     = media de los siguientes turnos (lo que vera el alumno)" -ForegroundColor DarkGray
Write-Host "  CompletionTok = tokens generados; alto -> respuestas largas o reasoning model" -ForegroundColor DarkGray
