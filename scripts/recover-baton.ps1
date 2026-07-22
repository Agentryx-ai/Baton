<#
.SYNOPSIS
  Herd-aware, memory-pressure-safe recovery + restart for the Baton worker.

.DESCRIPTION
  Tears down every Baton process (including a duplicate-supervisor herd or a
  wedged "zombie" holding the port) and brings up exactly one instance, by
  default under the scheduled-task supervisor so auto-restart is preserved.

  Design notes learned from the 2026-07-22 incident:
   * Uses netstat (not Get-CimInstance Win32_Process) to find the port owner —
     WMI queries hang under the memory pressure a herd creates.
   * Uses in-process Stop-Process (no child process spawned) for the critical
     kills, so teardown works even when taskkill fails with "Out of memory".
   * Freezes the Task Scheduler self-heal trigger before cleanup so it cannot
     spawn fresh supervisors mid-teardown.

.PARAMETER Unsupervised
  Start a bare `tsx server/index.ts` instead of going through the scheduled
  task (no auto-restart). Falls back to this automatically if no task is found.
#>
[CmdletBinding()]
param(
  [ValidateRange(1, 65535)][int]$Port = 4400,
  [string]$TaskName,
  [ValidateRange(5, 180)][int]$HealthTimeoutSeconds = 90,
  [switch]$Unsupervised
)

$ErrorActionPreference = 'Stop'
$workspace = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path

function Get-PortListenerPids([int]$p) {
  $out = cmd /c "netstat -ano -p tcp | findstr :$p | findstr LISTENING"
  if (-not $out) { return @() }
  @($out | ForEach-Object { ($_ -split '\s+')[-1] } |
    Where-Object { $_ -match '^\d+$' } | Select-Object -Unique | ForEach-Object { [int]$_ })
}

function Resolve-BatonTask([string]$Name, [string]$Root) {
  if ($Name) { return $Name }
  $tasks = @(Get-ScheduledTask -ErrorAction SilentlyContinue | Where-Object { $_.TaskName -like 'Baton-Worker-*' })
  if ($tasks.Count -eq 0) { return $null }
  $rootLower = $Root.ToLowerInvariant()
  $match = $tasks | Where-Object { ([string]$_.Description).ToLowerInvariant().Contains($rootLower) } | Select-Object -First 1
  if ($match) { return $match.TaskName }
  return $tasks[0].TaskName
}

Write-Host "Baton recovery for $workspace (port $Port)"
$taskName = Resolve-BatonTask $TaskName $workspace

# 1) Freeze the self-heal engine so it cannot spawn supervisors during cleanup.
if ($taskName) {
  cmd /c "schtasks /change /tn `"$taskName`" /disable" | Out-Null
  cmd /c "schtasks /end /tn `"$taskName`" 2>&1" | Out-Null
  Write-Host "  Task '$taskName' disabled + ended."
} else {
  Write-Host "  No Baton-Worker scheduled task found; will start unsupervised."
}

# 2) Tear down every Baton process. Stop-Process is in-process (no spawn), so it
#    works even under the memory pressure that makes taskkill fail.
for ($round = 0; $round -lt 5; $round++) {
  Get-Process -Name baton-bootstrap -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
  foreach ($listenerPid in (Get-PortListenerPids $Port)) {
    Stop-Process -Id $listenerPid -Force -ErrorAction SilentlyContinue
  }
  # Best-effort worker/runner sweep by command line. CIM can stall under load,
  # so bound it in try/catch and never let a failure abort recovery.
  try {
    $escaped = [regex]::Escape($workspace)
    Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction Stop |
      Where-Object {
        $_.CommandLine -and (
          $_.CommandLine -match 'baton-worker-runner' -or
          ($_.CommandLine -match 'server[\\/]index\.ts' -and $_.CommandLine -match $escaped)
        )
      } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  } catch { }
  Start-Sleep -Milliseconds 400
}

# 3) Wait for the port to actually free before restarting.
$freed = $false
for ($i = 0; $i -lt 40; $i++) {
  if ((Get-PortListenerPids $Port).Count -eq 0) { $freed = $true; break }
  Start-Sleep -Milliseconds 250
}
if (-not $freed) { throw "Port $Port is still held after teardown; aborting." }
Write-Host "  Port $Port is free; Baton processes cleared."

# 4) Bring up exactly one instance.
$supervised = -not ($Unsupervised -or -not $taskName)
if ($supervised) {
  cmd /c "schtasks /change /tn `"$taskName`" /enable" | Out-Null
  cmd /c "schtasks /run /tn `"$taskName`"" | Out-Null
  Write-Host "  Task '$taskName' enabled + started (supervised)."
} else {
  $node = (Get-Command node -ErrorAction Stop).Source
  $tsx = Join-Path $workspace 'node_modules\tsx\dist\cli.mjs'
  $stamp = [DateTime]::UtcNow.ToString('yyyyMMdd-HHmmssfff')
  $out = Join-Path $workspace ".baton-server-$stamp.out.log"
  $err = Join-Path $workspace ".baton-server-$stamp.err.log"
  Start-Process -FilePath $node -ArgumentList @($tsx, 'server/index.ts') -WorkingDirectory $workspace `
    -WindowStyle Hidden -RedirectStandardOutput $out -RedirectStandardError $err | Out-Null
  Write-Host "  Started unsupervised worker (stderr: $err)."
}

# 5) Poll until the new worker is healthy, then assert a single listener.
$deadline = [DateTime]::UtcNow.AddSeconds($HealthTimeoutSeconds)
$healthy = $false
while ([DateTime]::UtcNow -lt $deadline) {
  try {
    $h = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/baton/health" -TimeoutSec 3
    if ($h.ok -eq $true) { $healthy = $true; break }
  } catch { }
  Start-Sleep -Milliseconds 500
}

$listeners = Get-PortListenerPids $Port
[pscustomobject]@{
  Task          = $taskName
  Supervised    = $supervised
  ListenerPids  = ($listeners -join ',')
  ListenerCount = $listeners.Count
  Health        = if ($healthy) { 'ok' } else { 'NOT-healthy' }
} | Format-List

if (-not $healthy) { throw "Baton did not become healthy within $HealthTimeoutSeconds s." }
if ($listeners.Count -ne 1) { throw "Expected exactly one listener on $Port, found $($listeners.Count)." }
Write-Host "Baton recovery complete."
