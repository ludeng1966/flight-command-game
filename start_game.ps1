param([switch]$NoBrowser, [switch]$Restart, [int]$Port = 0)
$ErrorActionPreference = 'Stop'
$gameRoot = $PSScriptRoot
$gameNodeCommand = Get-Command node -ErrorAction SilentlyContinue
$gameNode = if ($gameNodeCommand) { $gameNodeCommand.Source } else { Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe' }
if (-not (Test-Path -LiteralPath $gameNode)) { throw 'Node.js 22.12+ is required.' }
$gameEnvFile = Join-Path $gameRoot '.env'
if (-not (Test-Path -LiteralPath $gameEnvFile)) { Copy-Item -LiteralPath (Join-Path $gameRoot '.env.example') -Destination $gameEnvFile }
if ($Port -eq 0) {
    if ($env:GAME_PORT) { $Port = [int]$env:GAME_PORT }
    else {
        $gamePortLine = Get-Content -LiteralPath $gameEnvFile -Encoding UTF8 | Where-Object { $_ -match '^\s*GAME_PORT\s*=\s*(\d+)\s*$' } | Select-Object -Last 1
        $Port = if ($gamePortLine -and $gamePortLine -match '=\s*(\d+)') { [int]$Matches[1] } else { 8000 }
    }
}
if ($Port -lt 1 -or $Port -gt 65535) { throw 'Invalid game port.' }
$gameUrl = "http://127.0.0.1:$Port/game/"
$gameHealthUrl = "http://127.0.0.1:$Port/api/health"
$gameLogDir = Join-Path $gameRoot '.game-server'
$gamePidFile = Join-Path $gameLogDir 'server.pid'
$gameScript = Join-Path $gameRoot 'server\game-server.mjs'
$gameRunning = $false
try { $gameHealth = Invoke-RestMethod -Uri $gameHealthUrl -TimeoutSec 2; $gameRunning = $gameHealth.service -eq 'tactical-voice' } catch { }
if ($Restart -or -not $gameRunning) {
    # Only stop the recorded process serving this port and matching our server command.
    if (Test-Path -LiteralPath $gamePidFile) {
        $gameRecordedPid = 0
        if ([int]::TryParse((Get-Content -LiteralPath $gamePidFile -Raw).Trim(), [ref]$gameRecordedPid)) {
            $gameOldProcess = Get-CimInstance Win32_Process -Filter "ProcessId=$gameRecordedPid" -ErrorAction SilentlyContinue
            $gamePortOwner = Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue | Where-Object OwningProcess -eq $gameRecordedPid
            $gameIsNode = $gameOldProcess -and $gameOldProcess.CommandLine.Contains($gameScript)
            $gameIsLegacy = $gameOldProcess -and $gameOldProcess.CommandLine -match "-m\s+http\.server\s+$Port\s+--bind\s+127\.0\.0\.1"
            if ($gamePortOwner -and ($gameIsNode -or $gameIsLegacy)) { Stop-Process -Id $gameRecordedPid -ErrorAction Stop; $gameRunning = $false }
        }
    }
}
if (-not $gameRunning) {
    if (Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue) { throw "Port $Port is in use by another service. Use -Port 8001 or stop that service." }
    New-Item -ItemType Directory -Force -Path $gameLogDir | Out-Null
    $gamePreviousPort = $env:GAME_PORT
    try {
        $env:GAME_PORT = [string]$Port
        $gameServer = Start-Process -FilePath $gameNode -ArgumentList @(('"' + $gameScript + '"')) -WorkingDirectory $gameRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $gameLogDir 'stdout.log') -RedirectStandardError (Join-Path $gameLogDir 'stderr.log')
    } finally { $env:GAME_PORT = $gamePreviousPort }
    $gameServer.Id | Set-Content -LiteralPath $gamePidFile
    for ($gameAttempt = 0; $gameAttempt -lt 30; $gameAttempt++) {
        Start-Sleep -Milliseconds 200
        try { $gameHealth = Invoke-RestMethod -Uri $gameHealthUrl -TimeoutSec 1; if ($gameHealth.service -eq 'tactical-voice') { $gameRunning = $true; break } } catch { }
        if ($gameServer.HasExited) { break }
    }
    if (-not $gameRunning) { throw "Server failed to start. See $gameLogDir\stderr.log" }
}
Write-Output "Game: $gameUrl"
if ($gameHealth.provider -eq 'local') { Write-Output 'Local 2B AI loads automatically. See the in-game connection status for readiness and VRAM.' }
elseif (-not $gameHealth.commandReady) { Write-Output "Set DASHSCOPE_API_KEY in .env, then run start_game.ps1 -Restart. Flight controls remain available." }
if (-not $NoBrowser) { Start-Process $gameUrl }
