$ErrorActionPreference = 'Stop'
$gameRoot = $PSScriptRoot
$gamePidFile = Join-Path $gameRoot '.game-server\server.pid'
if (-not (Test-Path -LiteralPath $gamePidFile)) { Write-Output 'Game server is not recorded.'; exit 0 }
$gameRecordedPid = [int](Get-Content -LiteralPath $gamePidFile -Raw).Trim()
$gameProcess = Get-CimInstance Win32_Process -Filter "ProcessId=$gameRecordedPid" -ErrorAction SilentlyContinue
$gameScript = Join-Path $gameRoot 'server\game-server.mjs'
if (-not $gameProcess) { Write-Output 'Game server is already stopped.'; exit 0 }
if (-not $gameProcess.CommandLine.Contains($gameScript)) { throw 'Recorded PID belongs to another process. Nothing was stopped.' }
Stop-Process -Id $gameRecordedPid -ErrorAction Stop
# The independent AI watcher notices the parent exit and releases the model.
Start-Sleep -Milliseconds 1500
Write-Output 'Game server stopped; its local model is being released.'
