[CmdletBinding()]
param(
  [ValidateRange(1, 65535)]
  [int]$Port = 4400,

  [ValidateRange(1, 120)]
  [int]$HealthTimeoutSeconds = 30
)

$ErrorActionPreference = 'Stop'

$workspace = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$tsx = Join-Path $workspace 'node_modules\tsx\dist\cli.mjs'
$serverEntry = Join-Path $workspace 'server\index.ts'
$logStamp = [DateTime]::UtcNow.ToString('yyyyMMdd-HHmmssfff')
$stdoutLog = Join-Path $workspace ".baton-server-$logStamp.out.log"
$stderrLog = Join-Path $workspace ".baton-server-$logStamp.err.log"

if (-not (Test-Path -LiteralPath $tsx -PathType Leaf)) {
  throw "tsx entry point was not found: $tsx"
}
if (-not (Test-Path -LiteralPath $serverEntry -PathType Leaf)) {
  throw "Baton server entry point was not found: $serverEntry"
}

$listeners = @(Get-NetTCPConnection -LocalPort $Port -State Listen)
if ($listeners.Count -ne 1) {
  throw "Expected exactly one listener on port $Port, found $($listeners.Count)."
}

$oldPid = $listeners[0].OwningProcess
$oldProcess = Get-CimInstance Win32_Process -Filter "ProcessId=$oldPid"
if (-not $oldProcess) {
  throw "Listener process $oldPid no longer exists. Run the script again."
}

$normalizedCommand = ($oldProcess.CommandLine ?? '').Replace('/', '\').ToLowerInvariant()
$normalizedWorkspace = $workspace.Replace('/', '\').ToLowerInvariant()
if (
  -not $normalizedCommand.Contains($normalizedWorkspace) -or
  -not $normalizedCommand.Contains('server\index.ts')
) {
  throw "Refusing to stop PID $oldPid because it is not the Baton server for $workspace."
}

$node = (Get-Command node -ErrorAction Stop).Source

# Stop and start stay in this single script invocation so control is never
# returned while Baton is intentionally offline.
Stop-Process -Id $oldPid -Force
Wait-Process -Id $oldPid -Timeout 10 -ErrorAction SilentlyContinue

$newProcess = Start-Process `
  -FilePath $node `
  -ArgumentList @($tsx, 'server/index.ts') `
  -WorkingDirectory $workspace `
  -WindowStyle Hidden `
  -RedirectStandardOutput $stdoutLog `
  -RedirectStandardError $stderrLog `
  -PassThru

$deadline = [DateTime]::UtcNow.AddSeconds($HealthTimeoutSeconds)
$healthUri = "http://127.0.0.1:$Port/baton/health"
$healthy = $false
while ([DateTime]::UtcNow -lt $deadline) {
  if ($newProcess.HasExited) {
    break
  }
  try {
    $health = Invoke-RestMethod -Uri $healthUri -TimeoutSec 2
    if ($health.ok -eq $true) {
      $healthy = $true
      break
    }
  } catch {
    # The listener may not be ready yet.
  }
  Start-Sleep -Milliseconds 250
}

if (-not $healthy) {
  $stderrTail = if (Test-Path -LiteralPath $stderrLog) {
    (Get-Content -LiteralPath $stderrLog -Tail 80) -join [Environment]::NewLine
  } else {
    '(stderr log was not created)'
  }
  throw "Replacement Baton server did not become healthy. New PID: $($newProcess.Id)`n$stderrTail"
}

$newListener = Get-NetTCPConnection -LocalPort $Port -State Listen | Select-Object -First 1
[pscustomobject]@{
  OldPid = $oldPid
  NewPid = $newProcess.Id
  ListenerPid = $newListener.OwningProcess
  Health = 'ok'
  StdoutLog = $stdoutLog
  StderrLog = $stderrLog
} | Format-List
