param([Parameter(Mandatory=$true)][int]$ParentId,[Parameter(Mandatory=$true)][int]$AiId)
$ErrorActionPreference = 'Stop'
# This independent watcher also releases the model if the launcher forcibly stops Node.
$aiProcess = Get-Process -Id $AiId -ErrorAction Stop
$aiStartTime = $aiProcess.StartTime
$parentProcess = Get-Process -Id $ParentId -ErrorAction Stop
$parentStartTime = $parentProcess.StartTime
try {
    while ($true) {
        $aiCurrent = Get-Process -Id $AiId -ErrorAction SilentlyContinue
        if (-not $aiCurrent -or $aiCurrent.StartTime -ne $aiStartTime) { break }
        $parentCurrent = Get-Process -Id $ParentId -ErrorAction SilentlyContinue
        if (-not $parentCurrent -or $parentCurrent.StartTime -ne $parentStartTime) { break }
        $samples = @(Get-CimInstance Win32_PerfFormattedData_GPUPerformanceCounters_GPUProcessMemory -Filter "Name LIKE 'pid_${AiId}_%'" -ErrorAction Stop)
        if ($samples.Count -gt 0) {
            $dedicated = ($samples | Measure-Object -Property DedicatedUsage -Sum).Sum
            $shared = ($samples | Measure-Object -Property SharedUsage -Sum).Sum
            @{dedicatedBytes=$dedicated;sharedBytes=$shared} | ConvertTo-Json -Compress
        }
        Start-Sleep -Milliseconds 500
    }
} catch { @{error='GPU process counters unavailable'} | ConvertTo-Json -Compress }
finally {
    $aiCurrent = Get-Process -Id $AiId -ErrorAction SilentlyContinue
    if ($aiCurrent -and $aiCurrent.StartTime -eq $aiStartTime) { Stop-Process -Id $AiId -ErrorAction SilentlyContinue }
}
