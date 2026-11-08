param()
$ErrorActionPreference = 'Stop'
$gameRoot = Split-Path -Parent $PSScriptRoot
$aiRoot = Join-Path $gameRoot '.local-ai'
$aiDownloads = Join-Path $aiRoot 'downloads'
$aiRuntime = Join-Path $aiRoot 'runtime'
$aiModels = Join-Path $aiRoot 'models'
New-Item -ItemType Directory -Force -Path $aiDownloads,$aiRuntime,$aiModels | Out-Null
function Get-VerifiedAsset($Url, $Target, $Sha256) {
    if ((Test-Path -LiteralPath $Target) -and (Get-FileHash -LiteralPath $Target -Algorithm SHA256).Hash.ToLowerInvariant() -eq $Sha256) { return }
    $partial = "$Target.partial"
    & curl.exe --fail --location --retry 4 --connect-timeout 25 --continue-at - --output $partial $Url
    if ($LASTEXITCODE -ne 0) { throw "Download failed: $Url" }
    if ((Get-FileHash -LiteralPath $partial -Algorithm SHA256).Hash.ToLowerInvariant() -ne $Sha256) { throw "SHA256 mismatch: $partial" }
    Move-Item -LiteralPath $partial -Destination $Target -Force
}
$aiArchive = Join-Path $aiDownloads 'llama-b12189-bin-win-vulkan-x64.zip'
Get-VerifiedAsset 'https://github.com/ggml-org/llama.cpp/releases/download/b12189/llama-b12189-bin-win-vulkan-x64.zip' $aiArchive '9d56405579492423833cdde94cf46cae15d38333f585f3957cafebfc6fb0e182'
$aiInstalledVersion = ''
if (Test-Path -LiteralPath (Join-Path $aiRuntime 'llama-server.exe')) {
    Push-Location $aiRuntime
    try {
        $ErrorActionPreference = 'Continue'
        $aiInstalledVersion = ((& .\llama-server.exe --version 2>&1) | ForEach-Object { $_.ToString() }) -join ' '
    } finally { $ErrorActionPreference = 'Stop'; Pop-Location }
}
if ($aiInstalledVersion -notmatch 'build 12189') { Expand-Archive -LiteralPath $aiArchive -DestinationPath $aiRuntime -Force }
Get-VerifiedAsset 'https://huggingface.co/unsloth/Qwen3.5-2B-GGUF/resolve/f6d5376be1edb4d416d56da11e5397a961aca8ae/Qwen3.5-2B-Q4_K_M.gguf' (Join-Path $aiModels 'Qwen3.5-2B-Q4_K_M.gguf') 'aaf42c8b7c3cab2bf3d69c355048d4a0ee9973d48f16c731c0520ee914699223'
& curl.exe --fail --location --retry 2 --output (Join-Path $aiRuntime 'LICENSE-llama.cpp') 'https://raw.githubusercontent.com/ggml-org/llama.cpp/b12189/LICENSE'
if ($LASTEXITCODE -ne 0) { throw 'Could not download llama.cpp license.' }
& curl.exe --fail --location --retry 2 --output (Join-Path $aiModels 'LICENSE-Qwen') 'https://huggingface.co/Qwen/Qwen3.5-2B/resolve/main/LICENSE'
if ($LASTEXITCODE -ne 0) { throw 'Could not download Qwen model license.' }
Write-Output 'Local AI assets ready: Qwen3.5-2B Q4_K_M + llama.cpp b12189 Vulkan.'
