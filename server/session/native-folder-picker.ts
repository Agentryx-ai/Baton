import { type ChildProcess, spawn } from 'node:child_process'
import { realpath, stat } from 'node:fs/promises'
import path from 'node:path'

/**
 * pwsh (PowerShell 7 / .NET 5+) renders FolderBrowserDialog as the modern
 * resizable IFileDialog folder picker; Windows PowerShell (.NET Framework)
 * falls back to the legacy cramped tree dialog. Prefer pwsh when installed.
 */
const POWERSHELL_CANDIDATES = Object.freeze(['pwsh.exe', 'powershell.exe'])
const DEFAULT_TIMEOUT_MS = 5 * 60_000
const DEFAULT_MAX_OUTPUT_BYTES = 256 * 1024
const TERMINATION_GRACE_MS = 2_000

const WINDOWS_PICKER_SCRIPT = String.raw`$ErrorActionPreference = 'Stop'
$dialog = $null
$owner = $null
try {
  Add-Type -AssemblyName System.Windows.Forms
  Add-Type -AssemblyName System.Drawing
  [System.Windows.Forms.Application]::EnableVisualStyles()
  # A background process cannot steal foreground, so an ownerless dialog opens
  # behind the browser and looks like a hang. Owning it with an invisible
  # top-most form forces the dialog above other windows.
  $owner = New-Object System.Windows.Forms.Form
  $owner.TopMost = $true
  $owner.ShowInTaskbar = $false
  $owner.FormBorderStyle = [System.Windows.Forms.FormBorderStyle]::None
  $owner.StartPosition = [System.Windows.Forms.FormStartPosition]::Manual
  $owner.Size = New-Object System.Drawing.Size(1, 1)
  $owner.Location = New-Object System.Drawing.Point(-32000, -32000)
  $owner.Opacity = 0
  $owner.Show()
  $owner.Activate()
  $dialog = New-Object System.Windows.Forms.FolderBrowserDialog
  $dialog.Description = 'Select a folder for Baton'
  $dialog.ShowNewFolderButton = $true
  if ($null -ne $dialog.PSObject.Properties['UseDescriptionForTitle']) {
    $dialog.UseDescriptionForTitle = $true
  }
  $initialBase64 = $env:BATON_PICKER_INITIAL_DIR
  if (-not [string]::IsNullOrEmpty($initialBase64)) {
    try {
      $initial = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String($initialBase64))
      if (Test-Path -LiteralPath $initial -PathType Container) {
        $dialog.SelectedPath = $initial
        if ($null -ne $dialog.PSObject.Properties['InitialDirectory']) {
          $dialog.InitialDirectory = $initial
        }
      }
    } catch { }
  }
  $result = $dialog.ShowDialog($owner)
  if ($result -eq [System.Windows.Forms.DialogResult]::OK) {
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($dialog.SelectedPath)
    $encoded = [System.Convert]::ToBase64String($bytes)
    [Console]::Out.WriteLine('{"status":"selected","pathBase64":"' + $encoded + '"}')
  } else {
    [Console]::Out.WriteLine('{"status":"cancelled"}')
  }
} catch {
  [Console]::Out.WriteLine('{"status":"error","code":"picker_unavailable"}')
} finally {
  if ($null -ne $dialog) { $dialog.Dispose() }
  if ($null -ne $owner) { $owner.Dispose() }
}`

const WINDOWS_PICKER_ARGS = Object.freeze([
  '-NoLogo',
  '-NoProfile',
  '-STA',
  '-WindowStyle',
  'Hidden',
  '-EncodedCommand',
  Buffer.from(WINDOWS_PICKER_SCRIPT, 'utf16le').toString('base64'),
])

export type NativeFolderPickerErrorCode =
  | 'unsupported_os'
  | 'picker_unavailable'
  | 'picker_timeout'
  | 'picker_failed'
  | 'invalid_picker_response'

export class NativeFolderPickerError extends Error {
  readonly code: NativeFolderPickerErrorCode

  constructor(code: NativeFolderPickerErrorCode, message: string) {
    super(message)
    this.name = 'NativeFolderPickerError'
    this.code = code
  }
}

export interface NativeFolderPickerProcessRequest {
  executable: string
  args: readonly string[]
  timeoutMs: number
  maxOutputBytes: number
  /** Extra environment variables for the picker process. */
  env?: Readonly<Record<string, string>>
}

export interface NativeFolderPickerProcessResult {
  exitCode: number | null
  stdout: Uint8Array
  timedOut: boolean
  outputLimitExceeded?: boolean
}

export interface NativeFolderPickerRunner {
  run(request: NativeFolderPickerProcessRequest): Promise<NativeFolderPickerProcessResult>
}

export interface NativeFolderPickerOptions {
  platform?: NodeJS.Platform
  timeoutMs?: number
  maxOutputBytes?: number
  runner?: NativeFolderPickerRunner
  /** Directory the dialog starts in; ignored when missing or not a directory. */
  initialDirectory?: string | null
}

/**
 * Open the host OS directory chooser after an explicit user action.
 * Returns a canonical, existing absolute directory or null when the user cancels.
 */
export async function pickNativeFolder(options: NativeFolderPickerOptions = {}): Promise<string | null> {
  const platform = options.platform ?? process.platform
  if (platform !== 'win32') {
    throw new NativeFolderPickerError('unsupported_os', 'Native folder selection is not supported on this OS')
  }

  const timeoutMs = positiveInteger(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, 'timeoutMs')
  const maxOutputBytes = positiveInteger(options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES, 'maxOutputBytes')
  const runner = options.runner ?? new SpawnNativeFolderPickerRunner()
  const initialDirectory = await usableInitialDirectory(options.initialDirectory)

  let result: NativeFolderPickerProcessResult | null = null
  for (const executable of POWERSHELL_CANDIDATES) {
    try {
      result = await runner.run({
        executable,
        args: WINDOWS_PICKER_ARGS,
        timeoutMs,
        maxOutputBytes,
        ...(initialDirectory
          ? { env: { BATON_PICKER_INITIAL_DIR: Buffer.from(initialDirectory, 'utf8').toString('base64') } }
          : {}),
      })
      break
    } catch (error) {
      if (isMissingExecutable(error)) continue
      throw new NativeFolderPickerError('picker_failed', 'The native folder picker could not be started')
    }
  }
  if (result === null) {
    throw new NativeFolderPickerError('picker_unavailable', 'The native folder picker is unavailable')
  }

  if (result.timedOut) {
    throw new NativeFolderPickerError('picker_timeout', 'The native folder picker timed out and was terminated')
  }
  if (result.outputLimitExceeded) {
    throw new NativeFolderPickerError('invalid_picker_response', 'The native folder picker returned too much data')
  }
  if (result.exitCode !== 0) {
    throw new NativeFolderPickerError('picker_failed', 'The native folder picker exited unsuccessfully')
  }

  return parsePickerResponse(result.stdout)
}

/** Best-effort: use the suggestion only when it is an absolute, existing directory. */
async function usableInitialDirectory(value: string | null | undefined): Promise<string | null> {
  const trimmed = value?.trim()
  if (!trimmed || !path.isAbsolute(trimmed) || trimmed.includes('\0')) return null
  try {
    return (await stat(trimmed)).isDirectory() ? trimmed : null
  } catch {
    return null
  }
}

export class SpawnNativeFolderPickerRunner implements NativeFolderPickerRunner {
  async run(request: NativeFolderPickerProcessRequest): Promise<NativeFolderPickerProcessResult> {
    return await new Promise((resolve, reject) => {
      const child = spawn(request.executable, [...request.args], {
        windowsHide: true,
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
        ...(request.env ? { env: { ...process.env, ...request.env } } : {}),
      })
      const stdout: Buffer[] = []
      let stdoutBytes = 0
      let stderrBytes = 0
      let timedOut = false
      let outputLimitExceeded = false
      let settled = false
      let terminationTimer: NodeJS.Timeout | undefined

      const processResult = (exitCode: number | null): NativeFolderPickerProcessResult => ({
        exitCode,
        stdout: Buffer.concat(stdout, Math.min(stdoutBytes, request.maxOutputBytes)),
        timedOut,
        ...(outputLimitExceeded ? { outputLimitExceeded: true } : {}),
      })
      const finish = (callback: () => void): void => {
        if (settled) return
        settled = true
        clearTimeout(timeoutTimer)
        if (terminationTimer) clearTimeout(terminationTimer)
        callback()
      }
      const terminate = (): void => {
        if (terminationTimer) return
        terminateProcessTree(child)
        terminationTimer = setTimeout(() => {
          if (child.exitCode === null) child.kill('SIGKILL')
          finish(() => resolve(processResult(null)))
        }, TERMINATION_GRACE_MS)
        terminationTimer.unref()
      }
      const timeoutTimer = setTimeout(() => {
        timedOut = true
        terminate()
      }, request.timeoutMs)
      timeoutTimer.unref()

      child.stdout.on('data', (chunk: Buffer) => {
        stdoutBytes += chunk.byteLength
        if (stdoutBytes + stderrBytes > request.maxOutputBytes) {
          outputLimitExceeded = true
          terminate()
          return
        }
        stdout.push(chunk)
      })
      child.stderr.on('data', (chunk: Buffer) => {
        stderrBytes += chunk.byteLength
        if (stdoutBytes + stderrBytes > request.maxOutputBytes) {
          outputLimitExceeded = true
          terminate()
        }
      })
      child.once('error', (error) => finish(() => reject(error)))
      child.once('close', (exitCode) => finish(() => resolve(processResult(exitCode))))
    })
  }
}

async function parsePickerResponse(bytes: Uint8Array): Promise<string | null> {
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes).trim()
  } catch {
    throw invalidResponse()
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw invalidResponse()
  }
  if (!isRecord(parsed) || typeof parsed.status !== 'string') throw invalidResponse()

  if (parsed.status === 'cancelled' && Object.keys(parsed).length === 1) return null
  if (parsed.status === 'error' && parsed.code === 'picker_unavailable' && Object.keys(parsed).length === 2) {
    throw new NativeFolderPickerError('picker_unavailable', 'The native folder picker is unavailable')
  }
  if (parsed.status !== 'selected'
    || typeof parsed.pathBase64 !== 'string'
    || Object.keys(parsed).length !== 2) {
    throw invalidResponse()
  }

  const selected = decodeCanonicalBase64Utf8(parsed.pathBase64)
  if (!selected || selected.includes('\0') || !path.win32.isAbsolute(selected)) throw invalidResponse()

  try {
    const canonical = await realpath(selected)
    if (!(await stat(canonical)).isDirectory() || !path.isAbsolute(canonical)) throw invalidResponse()
    return canonical
  } catch (error) {
    if (error instanceof NativeFolderPickerError) throw error
    throw invalidResponse()
  }
}

function decodeCanonicalBase64Utf8(value: string): string {
  if (value.length === 0 || value.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw invalidResponse()
  }
  const bytes = Buffer.from(value, 'base64')
  if (bytes.toString('base64') !== value) throw invalidResponse()
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    throw invalidResponse()
  }
}

function terminateProcessTree(child: ChildProcess): void {
  if (process.platform === 'win32' && child.pid) {
    const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
      windowsHide: true,
      shell: false,
      stdio: 'ignore',
    })
    killer.once('error', () => child.kill('SIGKILL'))
    return
  }
  child.kill('SIGKILL')
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new RangeError(`${name} must be a positive integer`)
  return value
}

function isMissingExecutable(error: unknown): boolean {
  return isRecord(error) && error.code === 'ENOENT'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function invalidResponse(): NativeFolderPickerError {
  return new NativeFolderPickerError('invalid_picker_response', 'The native folder picker returned an invalid response')
}
