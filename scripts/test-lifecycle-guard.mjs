import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const LIVE_PORT = 4400

export function assertLiveBatonUnchanged(before, after) {
  if (before.listenerPid !== after.listenerPid) {
    throw new Error(`Live Baton listener PID changed: ${before.listenerPid ?? 'absent'} -> ${after.listenerPid ?? 'absent'}`)
  }
  if (JSON.stringify(before.health) !== JSON.stringify(after.health)) {
    throw new Error('Live Baton health changed during the test run')
  }
  if (JSON.stringify(before.tasks) !== JSON.stringify(after.tasks)) {
    throw new Error('Live Baton Scheduled Task definitions changed during the test run')
  }
}

export async function snapshotLiveBaton() {
  if (process.platform !== 'win32') return { listenerPid: null, health: null, tasks: [] }
  const script = liveSnapshotScript()
  const encoded = Buffer.from(script, 'utf16le').toString('base64')
  const { stdout } = await execFileAsync('powershell.exe', [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded,
  ], { windowsHide: true, maxBuffer: 4 * 1024 * 1024 })
  const snapshot = JSON.parse(stdout.trim())
  const tasks = Array.isArray(snapshot.tasks)
    ? snapshot.tasks
    : snapshot.tasks ? [snapshot.tasks] : []
  let health = null
  if (snapshot.listenerPid !== null) {
    const response = await fetch(`http://127.0.0.1:${LIVE_PORT}/baton/health`, {
      signal: AbortSignal.timeout(3_000),
    })
    if (!response.ok) throw new Error(`Cannot verify live Baton health: HTTP ${response.status}`)
    const body = await response.json()
    health = { status: response.status, ok: body?.ok === true }
  }
  return { listenerPid: snapshot.listenerPid ?? null, health, tasks }
}

export function liveSnapshotScript() {
  const script = [
    "$ErrorActionPreference = 'Stop'",
    `$connections = @(Get-NetTCPConnection -ErrorAction Stop)`,
    `$connection = $connections | Where-Object { $_.State -eq 'Listen' -and $_.LocalAddress -eq '127.0.0.1' -and $_.LocalPort -eq ${LIVE_PORT} } | Select-Object -First 1`,
    `$tasks = @(Get-ScheduledTask -ErrorAction Stop | Where-Object { $_.TaskName -like 'Baton-*' -or $_.Description -like 'Baton CurrentUser worker lifecycle*' } | Sort-Object TaskPath, TaskName | ForEach-Object { [pscustomobject]@{ path=$_.TaskPath; name=$_.TaskName; xml=(Export-ScheduledTask -TaskPath $_.TaskPath -TaskName $_.TaskName) } })`,
    `[pscustomobject]@{ listenerPid=if ($null -eq $connection) { $null } else { $connection.OwningProcess }; tasks=$tasks } | ConvertTo-Json -Compress -Depth 5`,
  ].join('\n')
  return script
}
