import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { open, stat } from 'node:fs/promises'
import { homedir, userInfo } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import {
  hasBootstrapLifecycleMetadata,
  verifyActiveBootstrapForLifecycle,
  withBootstrapLock,
} from './bootstrap-contract.ts'

const execFileAsync = promisify(execFile)

export const RESTART_COUNT = 3
export const RESTART_INTERVAL_MINUTES = 1
/**
 * The task also fires on this cadence via a repeating time trigger. With
 * MultipleInstances=IgnoreNew it is a no-op while the supervisor is alive and
 * relaunches it only once it (or its whole process tree) is dead — closing the
 * "supervisor killed → stays down until next logon" gap without a second
 * watchdog process (Task Scheduler is the always-running OS root).
 */
export const HEAL_INTERVAL_MINUTES = 1

export interface LifecyclePlan {
  taskName: string
  taskPath: string
  root: string
  /** Scheduled Task action executable (bootstrap after P2). */
  executable: string
  /** Expected executable for the process that owns the Worker listener. */
  workerExecutable: string
  arguments: string
  workingDirectory: string
  userId: string
  port: number
  restartCount: number
  restartIntervalMinutes: number
  ownershipMarker: string
}

export interface ScheduledTaskSnapshot {
  exists: boolean
  unavailable?: boolean
  error?: string
  enabled?: boolean
  state?: string
  lastRunTime?: string
  lastTaskResult?: number
  nextRunTime?: string
  definitionMatches?: boolean
  ownershipMatches?: boolean
}

export interface LifecycleStatus {
  supported: boolean
  task: ScheduledTaskSnapshot
  plan: Omit<LifecyclePlan, 'arguments'> & { arguments: string }
  lastWorkerEvent?: Record<string, unknown>
  port4400?: { occupied: boolean; pid?: number; processName?: string; ownerKind?: 'expected-baton-worker' | 'foreign' }
}

type PowerShellRunner = (script: string) => Promise<string>

function quoteArgument(value: string): string {
  return `"${value.replaceAll('"', '\\"')}"`
}

function psLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`
}

function lifecycleRoot(): string {
  return process.env.BATON_RECOVERY_ROOT
    ?? path.join(process.env.LOCALAPPDATA ?? homedir(), 'Baton')
}

export function createLifecyclePlan(options: {
  root?: string
  executable?: string
  workerExecutable?: string
  useBootstrap?: boolean
  userId?: string
  taskName?: string
  port?: number
} = {}): LifecyclePlan {
  const moduleRoot = process.env.BATON_RELEASE_ROOT
    ?? fileURLToPath(new URL('..', import.meta.url))
  const root = path.resolve(options.root ?? moduleRoot)
  const hash = createHash('sha256').update(root.toLowerCase()).digest('hex').slice(0, 12)
  const runner = path.join(root, 'scripts', 'baton-worker-runner.mjs')
  const bootstrapExecutable = process.env.BATON_BOOTSTRAP_EXECUTABLE
  const useBootstrap = options.useBootstrap ?? (!options.executable && Boolean(bootstrapExecutable))
  const launchTarget = options.executable ?? bootstrapExecutable ?? process.execPath
  const workerExecutable = options.workerExecutable ?? process.env.BATON_WORKER_EXECUTABLE ?? process.execPath
  const port = lifecyclePort(options.port)
  const launchArguments = useBootstrap
    ? `worker-runner --root ${quoteArgument(root)} --port ${port}`
    : `${quoteArgument(runner)} --root ${quoteArgument(root)} --port ${port}`
  // Task Scheduler shows a console window for interactively-launched console
  // executables. Routing the launch through wscript (window style 0) keeps the
  // supervisor invisible; the real target and its arguments ride behind the
  // shuttle script and validation stays coherent because it derives from this
  // same plan.
  const hiddenLauncher = path.join(root, 'scripts', 'baton-hidden-launch.vbs')
  const executable = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'wscript.exe')
  const argumentsValue = `${quoteArgument(hiddenLauncher)} ${quoteArgument(launchTarget)} ${launchArguments}`
  return {
    taskName: options.taskName ?? process.env.BATON_TASK_NAME ?? `Baton-Worker-${hash}`,
    taskPath: '\\',
    root,
    executable,
    workerExecutable,
    arguments: argumentsValue,
    workingDirectory: root,
    userId: options.userId ?? (process.env.USERDOMAIN
      ? `${process.env.USERDOMAIN}\\${process.env.USERNAME}`
      : userInfo().username),
    port,
    restartCount: RESTART_COUNT,
    restartIntervalMinutes: RESTART_INTERVAL_MINUTES,
    ownershipMarker: `Baton CurrentUser worker lifecycle (${root})`,
  }
}

export async function resolveLifecyclePlan(options: {
  userId?: string
  taskName?: string
  port?: number
} = {}): Promise<LifecyclePlan> {
  return withBootstrapLock(async () => {
    if (!(await hasBootstrapLifecycleMetadata())) {
      return createLifecyclePlan({
        ...options,
        executable: process.execPath,
        workerExecutable: process.execPath,
        useBootstrap: false,
      })
    }
    // Metadata presence is a one-way trust boundary: once P2 has written any
    // fixed entry/manifest, corruption or policy failure must not silently
    // downgrade lifecycle mutations to the checkout's Node runner.
    const verified = await verifyActiveBootstrapForLifecycle()
    if (!verified.stableEntry) throw new Error('Verified bootstrap has no stable lifecycle entry')
    return createLifecyclePlan({
      ...options,
      root: verified.manifest.workerRoot,
      executable: verified.stableEntry,
      workerExecutable: verified.manifest.workerNode,
      useBootstrap: true,
    })
  })
}

async function defaultPowerShell(script: string): Promise<string> {
  const encoded = Buffer.from(script, 'utf16le').toString('base64')
  const { stdout } = await execFileAsync(process.env.BATON_LIFECYCLE_POWERSHELL ?? 'powershell.exe', [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded,
  ], { windowsHide: true, maxBuffer: 1024 * 1024 })
  return stdout.trim()
}

export function registrationScript(plan: LifecyclePlan): string {
  return [
    "$ErrorActionPreference = 'Stop'",
    `$action = New-ScheduledTaskAction -Execute ${psLiteral(plan.executable)} -Argument ${psLiteral(plan.arguments)} -WorkingDirectory ${psLiteral(plan.workingDirectory)}`,
    `$logonTrigger = New-ScheduledTaskTrigger -AtLogOn -User ${psLiteral(plan.userId)}`,
    // Self-heal: a repeating time trigger lets Task Scheduler (the always-running
    // OS root) relaunch a dead supervisor; MultipleInstances=IgnoreNew keeps it a
    // no-op while one is alive. A past -StartBoundary -Once trigger is NOT auto-run
    // immediately by StartWhenAvailable (verified on Win11) — it fires on the
    // ~1-min repetition cadence — so repair's brief register→disable window never
    // leaves a worker running under a disabled task. On an enabled task it does
    // bring the worker up within ~1 min (the intended autostart behavior).
    `$healTrigger = New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Minutes ${HEAL_INTERVAL_MINUTES})`,
    `$principal = New-ScheduledTaskPrincipal -UserId ${psLiteral(plan.userId)} -LogonType Interactive -RunLevel Limited`,
    `$settings = New-ScheduledTaskSettingsSet -RestartCount ${plan.restartCount} -RestartInterval (New-TimeSpan -Minutes ${plan.restartIntervalMinutes}) -MultipleInstances IgnoreNew -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero)`,
    `Register-ScheduledTask -TaskPath ${psLiteral(plan.taskPath)} -TaskName ${psLiteral(plan.taskName)} -Description ${psLiteral(plan.ownershipMarker)} -Action $action -Trigger @($logonTrigger, $healTrigger) -Principal $principal -Settings $settings | Out-Null`,
  ].join('\n')
}

function validationScript(plan: LifecyclePlan): string[] {
  return [
    `$action = @($task.Actions)[0]`,
    `$logonTrigger = @($task.Triggers | Where-Object { $_.CimClass.CimClassName -eq 'MSFT_TaskLogonTrigger' })`,
    `$healTrigger = @($task.Triggers | Where-Object { $_.CimClass.CimClassName -eq 'MSFT_TaskTimeTrigger' })`,
    `function Resolve-Sid([string]$name) { try { return ([System.Security.Principal.NTAccount]$name).Translate([System.Security.Principal.SecurityIdentifier]).Value } catch { return $null } }`,
    `$expectedSid = Resolve-Sid ${psLiteral(plan.userId)}`,
    `$actualSid = Resolve-Sid $task.Principal.UserId`,
    `$triggerSid = if ($logonTrigger.Count -eq 1) { Resolve-Sid $logonTrigger[0].UserId } else { $null }`,
    `$userMatches = ($null -ne $expectedSid) -and ($null -ne $actualSid) -and ($expectedSid -eq $actualSid)`,
    `$forbiddenSid = @('S-1-5-18','S-1-5-19','S-1-5-20') -contains $actualSid`,
    `$ownershipMatches = ($task.TaskPath -eq ${psLiteral(plan.taskPath)}) -and ($task.Description -eq ${psLiteral(plan.ownershipMarker)}) -and $userMatches -and (-not $forbiddenSid)`,
    `$triggerMatches = (@($task.Triggers).Count -eq 2) -and ($logonTrigger.Count -eq 1) -and ($healTrigger.Count -eq 1) -and ($null -ne $triggerSid) -and ($triggerSid -eq $expectedSid) -and ([string]$healTrigger[0].Repetition.Interval -eq 'PT${HEAL_INTERVAL_MINUTES}M')`,
    `$matches = $ownershipMatches -and (@($task.Actions).Count -eq 1) -and ($action.Execute -eq ${psLiteral(plan.executable)}) -and ($action.Arguments -eq ${psLiteral(plan.arguments)}) -and ($action.WorkingDirectory -eq ${psLiteral(plan.workingDirectory)}) -and $triggerMatches -and ($task.Principal.LogonType -eq 'Interactive') -and ($task.Principal.RunLevel -eq 'Limited') -and ([string]$task.Settings.MultipleInstances -eq 'IgnoreNew') -and $task.Settings.StartWhenAvailable -and ([string]$task.Settings.ExecutionTimeLimit -eq 'PT0S') -and ($task.Settings.RestartCount -eq ${plan.restartCount}) -and ([string]$task.Settings.RestartInterval -eq 'PT${plan.restartIntervalMinutes}M') -and (-not $task.Settings.DisallowStartIfOnBatteries) -and (-not $task.Settings.StopIfGoingOnBatteries)`,
  ]
}

function emitSnapshotScript(plan: LifecyclePlan): string[] {
  return [
    `$info = Get-ScheduledTaskInfo -TaskPath ${psLiteral(plan.taskPath)} -TaskName ${psLiteral(plan.taskName)}`,
    `$lastRun = if ($info.LastRunTime -gt [datetime]'2000-01-01') { $info.LastRunTime.ToString('o') } else { $null }`,
    `$nextRun = if ($info.NextRunTime -gt [datetime]'2000-01-01') { $info.NextRunTime.ToString('o') } else { $null }`,
    `[pscustomobject]@{ exists=$true; enabled=($task.State -ne 'Disabled'); state=[string]$task.State; lastRunTime=$lastRun; lastTaskResult=$info.LastTaskResult; nextRunTime=$nextRun; ownershipMatches=$ownershipMatches; definitionMatches=$matches } | ConvertTo-Json -Compress`,
  ]
}

function snapshotScript(plan: LifecyclePlan): string {
  return [
    "$ErrorActionPreference = 'Stop'",
    `$task = Get-ScheduledTask -TaskPath ${psLiteral(plan.taskPath)} -TaskName ${psLiteral(plan.taskName)} -ErrorAction SilentlyContinue`,
    `if ($null -eq $task) { '{"exists":false}'; exit 0 }`,
    ...validationScript(plan),
    ...emitSnapshotScript(plan),
  ].join('\n')
}

export async function scheduledTaskStatus(plan = createLifecyclePlan(), run: PowerShellRunner = defaultPowerShell): Promise<ScheduledTaskSnapshot> {
  if (process.platform !== 'win32') return { exists: false }
  try {
    return JSON.parse(await run(snapshotScript(plan))) as ScheduledTaskSnapshot
  } catch (error) {
    return { exists: false, unavailable: true, error: terminalError(error) }
  }
}

function terminalError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return Array.from(String(redact(message)), (character) => {
    const code = character.charCodeAt(0)
    return code <= 31 || (code >= 127 && code <= 159) ? ' ' : character
  }).join('').slice(0, 300)
}

function assertOwnedDefinitionScript(): string[] {
  return [
    `if (-not $ownershipMatches) { throw 'Scheduled Task ownership mismatch' }`,
    `if (-not $matches) { throw 'Scheduled Task definition mismatch; run autostart repair' }`,
  ]
}

function currentUserGuardScript(plan: LifecyclePlan): string[] {
  return [
    `function Resolve-CurrentSid([string]$name) { try { return ([System.Security.Principal.NTAccount]$name).Translate([System.Security.Principal.SecurityIdentifier]).Value } catch { return $null } }`,
    `$currentSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value`,
    `$plannedSid = Resolve-CurrentSid ${psLiteral(plan.userId)}`,
    `if (@('S-1-5-18','S-1-5-19','S-1-5-20') -contains $currentSid) { throw 'Service-account lifecycle mutation is forbidden' }`,
    `if (($null -eq $plannedSid) -or ($plannedSid -ne $currentSid)) { throw 'Lifecycle task user does not match CurrentUser' }`,
  ]
}

export async function installScheduledTask(confirm: boolean, plan = createLifecyclePlan(), run: PowerShellRunner = defaultPowerShell): Promise<ScheduledTaskSnapshot> {
  if (!confirm) throw new Error('Autostart registration requires explicit --confirm consent')
  const script = [
    "$ErrorActionPreference = 'Stop'",
    ...currentUserGuardScript(plan),
    `$task = Get-ScheduledTask -TaskPath ${psLiteral(plan.taskPath)} -TaskName ${psLiteral(plan.taskName)} -ErrorAction SilentlyContinue`,
    `if ($null -ne $task) {`,
    ...validationScript(plan).map((line) => `  ${line}`),
    ...assertOwnedDefinitionScript().map((line) => `  ${line}`),
    ...emitSnapshotScript(plan).map((line) => `  ${line}`),
    `  exit 0`,
    `}`,
    registrationScript(plan),
    `$task = Get-ScheduledTask -TaskPath ${psLiteral(plan.taskPath)} -TaskName ${psLiteral(plan.taskName)}`,
    ...validationScript(plan),
    ...assertOwnedDefinitionScript(),
    ...emitSnapshotScript(plan),
  ].join('\n')
  return JSON.parse(await run(script)) as ScheduledTaskSnapshot
}

export async function repairScheduledTask(plan = createLifecyclePlan(), run: PowerShellRunner = defaultPowerShell): Promise<ScheduledTaskSnapshot> {
  const script = [
    "$ErrorActionPreference = 'Stop'",
    ...currentUserGuardScript(plan),
    `$task = Get-ScheduledTask -TaskPath ${psLiteral(plan.taskPath)} -TaskName ${psLiteral(plan.taskName)} -ErrorAction SilentlyContinue`,
    `if ($null -eq $task) { throw 'Autostart is not registered; use autostart install --confirm' }`,
    ...validationScript(plan),
    `if (-not $ownershipMatches) { throw 'Scheduled Task ownership mismatch' }`,
    `$wasDisabled = $task.State -eq 'Disabled'`,
    `Disable-ScheduledTask -TaskPath ${psLiteral(plan.taskPath)} -TaskName ${psLiteral(plan.taskName)} | Out-Null`,
    `Stop-ScheduledTask -TaskPath ${psLiteral(plan.taskPath)} -TaskName ${psLiteral(plan.taskName)} -ErrorAction SilentlyContinue`,
    // Last-moment ownership recheck narrows, but cannot eliminate, the gap
    // before Task Scheduler's non-conditional unregister operation.
    `$task = Get-ScheduledTask -TaskPath ${psLiteral(plan.taskPath)} -TaskName ${psLiteral(plan.taskName)}`,
    ...validationScript(plan),
    `if (-not $ownershipMatches) { throw 'Scheduled Task ownership changed during repair' }`,
    `Unregister-ScheduledTask -TaskPath ${psLiteral(plan.taskPath)} -TaskName ${psLiteral(plan.taskName)} -Confirm:$false`,
    registrationScript(plan),
    `if ($wasDisabled) { Disable-ScheduledTask -TaskPath ${psLiteral(plan.taskPath)} -TaskName ${psLiteral(plan.taskName)} | Out-Null }`,
    `$task = Get-ScheduledTask -TaskPath ${psLiteral(plan.taskPath)} -TaskName ${psLiteral(plan.taskName)}`,
    ...validationScript(plan),
    ...assertOwnedDefinitionScript(),
    ...emitSnapshotScript(plan),
  ].join('\n')
  return JSON.parse(await run(script)) as ScheduledTaskSnapshot
}

export async function uninstallScheduledTask(plan = createLifecyclePlan(), run: PowerShellRunner = defaultPowerShell): Promise<void> {
  const script = [
    "$ErrorActionPreference = 'Stop'",
    ...currentUserGuardScript(plan),
    `$task = Get-ScheduledTask -TaskPath ${psLiteral(plan.taskPath)} -TaskName ${psLiteral(plan.taskName)} -ErrorAction SilentlyContinue`,
    `if ($null -eq $task) { exit 0 }`,
    ...validationScript(plan),
    ...assertOwnedDefinitionScript(),
    `Disable-ScheduledTask -TaskPath ${psLiteral(plan.taskPath)} -TaskName ${psLiteral(plan.taskName)} | Out-Null`,
    `Stop-ScheduledTask -TaskPath ${psLiteral(plan.taskPath)} -TaskName ${psLiteral(plan.taskName)} -ErrorAction SilentlyContinue`,
    `$task = Get-ScheduledTask -TaskPath ${psLiteral(plan.taskPath)} -TaskName ${psLiteral(plan.taskName)}`,
    ...validationScript(plan),
    ...assertOwnedDefinitionScript(),
    `Unregister-ScheduledTask -TaskPath ${psLiteral(plan.taskPath)} -TaskName ${psLiteral(plan.taskName)} -Confirm:$false`,
  ].join('\n')
  await run(script)
}

export async function startWorker(plan = createLifecyclePlan(), run: PowerShellRunner = defaultPowerShell): Promise<void> {
  await run(lifecycleMutationScript(plan, 'start'))
}

export async function stopWorker(plan = createLifecyclePlan(), run: PowerShellRunner = defaultPowerShell): Promise<void> {
  await run(lifecycleMutationScript(plan, 'stop'))
}

export async function restartWorker(plan = createLifecyclePlan(), run: PowerShellRunner = defaultPowerShell): Promise<void> {
  await run(lifecycleMutationScript(plan, 'restart'))
}

function portInspectionScript(plan: LifecyclePlan): string[] {
  return [
    `$connection = Get-NetTCPConnection -LocalAddress 127.0.0.1 -LocalPort ${plan.port} -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1`,
    `$portOccupied = $null -ne $connection`,
    `$portProcess = if ($portOccupied) { Get-CimInstance Win32_Process -Filter ("ProcessId=" + $connection.OwningProcess) -ErrorAction SilentlyContinue } else { $null }`,
    `$expectedCommand = ($null -ne $portProcess) -and ($null -ne $portProcess.CommandLine) -and ($portProcess.CommandLine.IndexOf(${psLiteral(plan.root)}, [StringComparison]::OrdinalIgnoreCase) -ge 0) -and ($portProcess.CommandLine.IndexOf('server/index.ts', [StringComparison]::OrdinalIgnoreCase) -ge 0)`,
    `$expectedExecutable = ($null -ne $portProcess) -and ($null -ne $portProcess.ExecutablePath) -and ($portProcess.ExecutablePath -eq ${psLiteral(plan.workerExecutable)})`,
    `$portOwnerKind = if ($portOccupied -and $expectedCommand -and $expectedExecutable) { 'expected-baton-worker' } elseif ($portOccupied) { 'foreign' } else { $null }`,
  ]
}

function portDiagnosticScript(plan: LifecyclePlan): string {
  return [
    ...portInspectionScript(plan),
    `if (-not $portOccupied) { '{"occupied":false}'; exit 0 }`,
    `[pscustomobject]@{ occupied=$true; pid=$connection.OwningProcess; processName=$portProcess.Name; ownerKind=$portOwnerKind } | ConvertTo-Json -Compress`,
  ].join('\n')
}

function lifecycleMutationScript(plan: LifecyclePlan, operation: 'start' | 'stop' | 'restart'): string {
  const lines = [
    "$ErrorActionPreference = 'Stop'",
    ...currentUserGuardScript(plan),
    `$task = Get-ScheduledTask -TaskPath ${psLiteral(plan.taskPath)} -TaskName ${psLiteral(plan.taskName)} -ErrorAction SilentlyContinue`,
    `if ($null -eq $task) { throw 'Autostart is not registered' }`,
    ...validationScript(plan),
    ...assertOwnedDefinitionScript(),
  ]
  if (operation === 'start' || operation === 'restart') {
    lines.push(...portInspectionScript(plan))
    if (operation === 'start') {
      lines.push(
        `if ($task.State -eq 'Running') {`,
        `  if ($portOccupied -and $portOwnerKind -ne 'expected-baton-worker') { throw 'Port ${plan.port} is owned by a foreign process; no process was stopped' }`,
        `  exit 0`,
        `}`,
        `if ($portOccupied) { throw 'Port ${plan.port} is already occupied; no process was stopped' }`,
      )
    } else {
      lines.push(`if ($portOccupied -and $portOwnerKind -ne 'expected-baton-worker') { throw 'Port ${plan.port} is owned by a foreign process; no process was stopped' }`)
    }
  }
  if (operation === 'stop' || operation === 'restart') {
    // Disable first: an explicit stop must never qualify for failure restart.
    lines.push(
      `Disable-ScheduledTask -TaskPath ${psLiteral(plan.taskPath)} -TaskName ${psLiteral(plan.taskName)} | Out-Null`,
      `Stop-ScheduledTask -TaskPath ${psLiteral(plan.taskPath)} -TaskName ${psLiteral(plan.taskName)} -ErrorAction SilentlyContinue`,
    )
  }
  if (operation === 'restart') {
    lines.push(
      `for ($attempt = 0; $attempt -lt 20; $attempt++) {`,
      `  $connection = Get-NetTCPConnection -LocalAddress 127.0.0.1 -LocalPort ${plan.port} -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1`,
      `  if ($null -eq $connection) { break }`,
      `  Start-Sleep -Milliseconds 250`,
      `}`,
      `if ($null -ne $connection) { throw 'Port ${plan.port} did not become available after stopping the owned task' }`,
    )
  }
  if (operation === 'start' || operation === 'restart') {
    lines.push(
      `Enable-ScheduledTask -TaskPath ${psLiteral(plan.taskPath)} -TaskName ${psLiteral(plan.taskName)} | Out-Null`,
      `Start-ScheduledTask -TaskPath ${psLiteral(plan.taskPath)} -TaskName ${psLiteral(plan.taskName)}`,
    )
  }
  return lines.join('\n')
}

function lifecyclePort(value = Number(process.env.BATON_PORT ?? 4400)): number {
  if (!Number.isInteger(value) || value < 1 || value > 65_535) {
    throw new Error('BATON_PORT must be an integer between 1 and 65535')
  }
  return value
}

async function portStatus(plan: LifecyclePlan, run: PowerShellRunner): Promise<NonNullable<LifecycleStatus['port4400']>> {
  if (process.platform !== 'win32') return { occupied: false }
  return JSON.parse(await run(portDiagnosticScript(plan))) as NonNullable<LifecycleStatus['port4400']>
}

function redact(value: unknown): unknown {
  if (typeof value !== 'string') return value
  return value
    .replace(/("(?:access_token|refresh_token|api_key|token|authorization)"\s*:\s*")((?:\\.|[^"\\])*)(")/gi, '$1[REDACTED]$3')
    .replace(/(authorization\s*:\s*)(?:Bearer\s+)?[^\r\n]+/gi, '$1[REDACTED]')
    .replace(/((?:access_token|refresh_token|api_key|api-key|token|authorization)\s*[=:]\s*)(["'])((?:\\.|(?!\2).)*)(\2)/gi, '$1$2[REDACTED]$4')
    .replace(/((?:access_token|refresh_token|api_key|api-key|token|authorization)\s*[=:]\s*)[^&\s"']+/gi, '$1[REDACTED]')
    .replace(/([?&](?:access_token|refresh_token|api_key|api-key|token|authorization)=)[^&#\s]+/gi, '$1[REDACTED]')
    .replace(/Bearer\s+[^\s"']+/gi, 'Bearer [REDACTED]')
    .replace(/\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\b/g, '[REDACTED]')
}

const LOG_TAIL_BYTES = 64 * 1024

async function readBoundedTail(filePath: string, maxBytes = LOG_TAIL_BYTES): Promise<string> {
  const size = (await stat(filePath)).size
  const length = Math.min(size, maxBytes)
  const handle = await open(filePath, 'r')
  try {
    const buffer = Buffer.alloc(length)
    const { bytesRead } = await handle.read(buffer, 0, length, size - length)
    let value = buffer.subarray(0, bytesRead).toString('utf8')
    if (size > length) {
      const newline = value.indexOf('\n')
      value = newline >= 0 ? value.slice(newline + 1) : ''
    }
    return value
  } finally {
    await handle.close()
  }
}

export async function lifecycleStatus(plan = createLifecyclePlan(), run: PowerShellRunner = defaultPowerShell): Promise<LifecycleStatus> {
  let lastWorkerEvent: Record<string, unknown> | undefined
  try {
    const lines = (await readBoundedTail(path.join(lifecycleRoot(), 'lifecycle', 'events.jsonl'))).trim().split(/\r?\n/)
    const parsed = JSON.parse(lines.at(-1) ?? '{}') as Record<string, unknown>
    lastWorkerEvent = Object.fromEntries(Object.entries(parsed).map(([key, value]) => [key, redact(value)]))
  } catch { /* no runner event yet */ }
  let port4400: LifecycleStatus['port4400']
  if (process.platform === 'win32') {
    try {
      const parsed = await portStatus(plan, run)
      port4400 = Object.fromEntries(Object.entries(parsed).map(([key, value]) => [key, redact(value)])) as NonNullable<LifecycleStatus['port4400']>
    } catch { /* diagnostic is best effort */ }
  }
  return {
    supported: process.platform === 'win32',
    task: await scheduledTaskStatus(plan, run),
    plan: { ...plan, arguments: '[configured runner arguments]' },
    lastWorkerEvent,
    port4400,
  }
}

export async function lifecycleLogs(limit = 20): Promise<{ events: Record<string, unknown>[]; worker: string }> {
  let events: Record<string, unknown>[] = []
  try {
    const lines = (await readBoundedTail(path.join(lifecycleRoot(), 'lifecycle', 'events.jsonl')))
      .trim().split(/\r?\n/).filter(Boolean).slice(-Math.max(1, Math.min(limit, 100)))
    events = lines.map((line) => {
      try {
        const parsed = JSON.parse(line) as Record<string, unknown>
        return Object.fromEntries(Object.entries(parsed).map(([key, value]) => [key, redact(value)]))
      } catch {
        return { event: 'unreadable-log-entry' }
      }
    })
  } catch { /* no event log */ }
  let worker = ''
  try { worker = String(redact(await readBoundedTail(path.join(lifecycleRoot(), 'lifecycle', 'worker.log')))) } catch { /* no worker log */ }
  return { events, worker }
}
