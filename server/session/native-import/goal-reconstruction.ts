import type { CanonicalProvider } from '../domain.ts'
import type { NativeGoalSnapshot } from './contracts.ts'

type GoalEvidence = NativeGoalSnapshot['evidence']

export type ExplicitGoalCommand =
  | { kind: 'set'; objective: string }
  | { kind: 'clear' | 'complete' | 'pause' | 'resume' }

export type CodexGoalToolAction =
  | { kind: 'set'; objective: string }
  | { kind: 'clear' | 'complete' }

export class NativeGoalReconstructor {
  #current: { objective: string; detectedAt: string | null; evidence: GoalEvidence } | null = null

  set(objective: string, detectedAt: string | null, evidence: GoalEvidence): void {
    const normalized = objective.trim()
    if (normalized) this.#current = { objective: normalized, detectedAt, evidence }
  }

  clear(): void { this.#current = null }

  snapshot(provider: CanonicalProvider, model: string | null, effort: string | null): NativeGoalSnapshot | null {
    if (!this.#current) return null
    return {
      ...this.#current,
      model: model?.trim() || defaultNativeGoalModel(provider),
      effort: effort?.trim() || null,
    }
  }
}

export function parseExplicitGoalCommand(text: string): ExplicitGoalCommand | null {
  const match = /^\s*\/goal(?:\s+([\s\S]*?))?\s*$/.exec(text)
  if (!match?.[1]?.trim()) return null
  const argument = match[1].trim()
  const control = argument.toLocaleLowerCase('en-US')
  if (control === 'clear' || control === 'complete' || control === 'pause' || control === 'resume') {
    return { kind: control }
  }
  return { kind: 'set', objective: argument }
}

export function parseClaudeGoalCommand(text: string): ExplicitGoalCommand | null {
  if (!/<command-name>\s*\/goal\s*<\/command-name>/i.test(text)) return null
  const argument = decodeXml(text.match(/<command-args>([\s\S]*?)<\/command-args>/i)?.[1] ?? '').trim()
  if (!argument) return null
  const control = argument.toLocaleLowerCase('en-US')
  if (control === 'clear' || control === 'complete' || control === 'pause' || control === 'resume') {
    return { kind: control }
  }
  return { kind: 'set', objective: argument }
}

export function parseClaudeGoalConfirmation(text: string): { kind: 'set'; objective: string } | { kind: 'clear' } | null {
  const wrapper = text.match(/<local-command-stdout>([\s\S]*?)<\/local-command-stdout>/i)?.[1] ?? text
  const cleared = /^\s*Goal cleared(?::[\s\S]*)?\s*$/i.test(wrapper)
  if (cleared) return { kind: 'clear' }
  const set = /^\s*Goal set:\s*([\s\S]+?)\s*$/i.exec(wrapper)
  return set?.[1]?.trim() ? { kind: 'set', objective: decodeXml(set[1]).trim() } : null
}

export function parseCodexGoalToolAction(source: string): CodexGoalToolAction | null {
  const create = /tools\.create_goal\s*\(/.exec(source)
  if (create?.index !== undefined) {
    const objective = parseJavascriptPropertyString(source.slice(create.index), 'objective')
    return objective ? { kind: 'set', objective } : null
  }
  const update = /tools\.update_goal\s*\(/.exec(source)
  if (update?.index !== undefined) {
    const status = parseJavascriptPropertyString(source.slice(update.index), 'status')?.toLocaleLowerCase('en-US')
    if (status === 'complete') return { kind: 'complete' }
  }
  return null
}

export function codexToolCallSucceeded(output: unknown): boolean {
  const text = flattenText(output).join('\n')
  return !/Script failed|Script error|cannot create a new goal|\b(?:error|failed)\s*:/i.test(text)
}

export function applyGoalCommand(
  tracker: NativeGoalReconstructor,
  command: ExplicitGoalCommand | CodexGoalToolAction | null,
  detectedAt: string | null,
  evidence: GoalEvidence,
): void {
  if (!command) return
  if (command.kind === 'set') tracker.set(command.objective, detectedAt, evidence)
  else if (command.kind === 'clear' || command.kind === 'complete') tracker.clear()
}

function parseJavascriptPropertyString(source: string, property: string): string | null {
  const match = new RegExp(`\\b${property}\\s*:\\s*(["'\\x60])`).exec(source)
  if (!match?.[1] || match.index === undefined) return null
  const quote = match[1]
  const start = match.index + match[0].length
  let escaped = false
  for (let index = start; index < source.length; index += 1) {
    const character = source[index]
    if (escaped) { escaped = false; continue }
    if (character === '\\') { escaped = true; continue }
    if (character !== quote) continue
    const literal = source.slice(start, index)
    if (quote === '"') {
      try { return JSON.parse(`"${literal}"`) as string } catch { return null }
    }
    if (quote === '`' && literal.includes('${')) return null
    return literal.replace(/\\(['`\\])/g, '$1').replace(/\\n/g, '\n').replace(/\\r/g, '\r').replace(/\\t/g, '\t')
  }
  return null
}

function flattenText(value: unknown): string[] {
  if (typeof value === 'string') return [value]
  if (Array.isArray(value)) return value.flatMap(flattenText)
  if (!value || typeof value !== 'object') return []
  const record = value as Record<string, unknown>
  return ['text', 'output', 'content', 'message'].flatMap((key) => flattenText(record[key]))
}

function decodeXml(value: string): string {
  return value
    .replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'").replaceAll('&amp;', '&')
}

function defaultNativeGoalModel(provider: CanonicalProvider): string {
  if (provider === 'codex') return 'gpt-5.6-sol'
  if (provider === 'claude') return 'claude-sonnet-4-6'
  return 'gemini-3.1-pro-preview'
}
