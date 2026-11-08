param(
    [ValidateSet('Init', 'Start', 'Stop', 'Status', 'Once')]
    [string]$Action = 'Status',
    [string]$Member = '',
    [string]$Remote = 'private',
    [string]$Email = ''
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$syncRoot = $PSScriptRoot
$syncNode = Get-Command node -ErrorAction SilentlyContinue | Select-Object -First 1
$syncGit = Get-Command git -ErrorAction SilentlyContinue | Select-Object -First 1
$syncNodePath = if ($syncNode) { $syncNode.Source } else { Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe' }
$syncGitPath = if ($syncGit) { $syncGit.Source } else { Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\native\git\cmd\git.exe' }
if (-not (Test-Path -LiteralPath $syncNodePath)) { throw 'Node.js was not found. Install Node.js before starting local sync.' }
if (-not (Test-Path -LiteralPath $syncGitPath)) { throw 'Git was not found. Install Git before starting local sync.' }
$env:FLIGHT_SYNC_GIT = $syncGitPath
$syncScript = Join-Path $syncRoot 'tools\local-sync.mjs'
if ($Action -eq 'Init') {
    if (-not $Member) { throw 'Provide -Member with your GitHub username.' }
    $syncInitArgs = @($syncScript, 'init', '--root', $syncRoot, '--member', $Member, '--remote', $Remote)
    if ($Email) { $syncInitArgs += @('--email', $Email) }
    & $syncNodePath @syncInitArgs
    if ($LASTEXITCODE -ne 0) { throw 'Local sync initialization failed.' }
} elseif ($Action -eq 'Start') {
    $syncStateText = & $syncNodePath $syncScript status --root $syncRoot
    if ($LASTEXITCODE -ne 0) { throw 'Initialize local sync first.' }
    $syncStatus = $syncStateText | ConvertFrom-Json
    if (-not $syncStatus.running) {
        $syncGitDir = (& $syncGitPath -C $syncRoot rev-parse --git-common-dir).Trim()
        $syncDirectory = if ([System.IO.Path]::IsPathRooted($syncGitDir)) { [System.IO.Path]::GetFullPath($syncGitDir) } else { [System.IO.Path]::GetFullPath((Join-Path $syncRoot $syncGitDir)) }
        $syncLogDirectory = Join-Path $syncDirectory 'flight-local-sync'
        $syncLaunchArgs = '"' + $syncScript + '" watch --root "' + $syncRoot + '"'
        Start-Process -FilePath $syncNodePath -ArgumentList $syncLaunchArgs -WorkingDirectory $syncRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $syncLogDirectory 'stdout.log') -RedirectStandardError (Join-Path $syncLogDirectory 'stderr.log') | Out-Null
        Start-Sleep -Milliseconds 700
    }
    & $syncNodePath $syncScript status --root $syncRoot
} else {
    $syncCommand = $Action.ToLowerInvariant()
    & $syncNodePath $syncScript $syncCommand --root $syncRoot
    if ($LASTEXITCODE -ne 0) { throw 'Local sync command failed. See the reported status.' }
}
