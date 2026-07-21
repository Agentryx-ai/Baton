import type { CanonicalItemDto, CanonicalTurnDto, JsonObject, JsonValue } from './types.ts'
import {
  taskNotificationFromPayload,
  type NativeTaskNotification,
} from '../../lib/native-task-notification.ts'

export const PROVIDER_LABEL = {
  claude: 'Claude',
  codex: 'Codex',
  gemini: 'Gemini',
} as const

export const ITEM_LABEL: Record<CanonicalItemDto['kind'], string> = {
  user_message: '사용자',
  assistant_message: '어시스턴트',
  reasoning_summary: '추론 요약',
  tool_call: '도구 호출',
  tool_result: '도구 결과',
  file_change: '파일 변경',
  approval: '승인',
  plan: '계획',
  task: '작업',
  usage: '사용량',
  error: '오류',
  summary: '요약',
  provider_event: 'Provider 이벤트',
}

function record(value: JsonValue | undefined): JsonObject | null {
  return value && !Array.isArray(value) && typeof value === 'object' ? value : null
}

function textParts(value: JsonValue | undefined): string[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((part) => {
    if (typeof part === 'string') return [part]
    const object = record(part)
    return typeof object?.text === 'string' ? [object.text] : []
  })
}

export function payloadText(item: CanonicalItemDto): string {
  const taskNotification = itemTaskNotification(item)
  if (taskNotification) return taskNotification.result
  if (typeof item.payload.text === 'string') return item.payload.text
  if (typeof item.payload.content === 'string') return item.payload.content
  const content = textParts(item.payload.content)
  if (content.length > 0) return content.join('\n')
  if (typeof item.payload.message === 'string') return item.payload.message
  if (typeof item.payload.summary === 'string') return item.payload.summary
  const summary = textParts(item.payload.summary)
  if (summary.length > 0) return summary.join('\n\n')
  return JSON.stringify(item.payload, null, 2)
}

export function itemTaskNotification(item: CanonicalItemDto): NativeTaskNotification | null {
  return item.kind === 'user_message' ? taskNotificationFromPayload(item.payload) : null
}

function numberValue(object: JsonObject, camel: string, snake: string): number {
  const value = object[camel] ?? object[snake]
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, value) : 0
}

function usageRecord(payload: JsonObject): JsonObject {
  const tokenUsage = record(payload.tokenUsage) ?? payload
  return record(tokenUsage.last) ?? tokenUsage
}

const tokenFormatter = new Intl.NumberFormat('ko-KR')

export function usageSummary(payload: JsonObject): string {
  const usage = usageRecord(payload)
  const input = numberValue(usage, 'inputTokens', 'input_tokens')
  const cached = numberValue(usage, 'cachedInputTokens', 'cached_input_tokens')
  const output = numberValue(usage, 'outputTokens', 'output_tokens')
  const reasoning = numberValue(usage, 'reasoningOutputTokens', 'reasoning_output_tokens')
  const nonCachedInput = Math.max(0, input - cached)
  const parts = [
    `합계 ${tokenFormatter.format(nonCachedInput + output)}`,
    `입력 ${tokenFormatter.format(nonCachedInput)}`,
  ]
  if (cached > 0) parts.push(`캐시 ${tokenFormatter.format(cached)}`)
  parts.push(`출력 ${tokenFormatter.format(output)}`)
  if (reasoning > 0) parts.push(`추론 ${tokenFormatter.format(reasoning)}`)
  return parts.join(' · ')
}

export function transcriptItems(items: CanonicalItemDto[]): CanonicalItemDto[] {
  return items.filter((item) => item.kind !== 'usage' && !isInternalGoalContinuation(item))
}

function isInternalGoalContinuation(item: CanonicalItemDto): boolean {
  return item.kind === 'user_message'
    && item.visibility === 'baton_private'
    && item.payload.goalContinuation === true
}

export interface ConversationDisplayEntry {
  item: CanonicalItemDto
  toolResult: CanonicalItemDto | null
}

export function tailConversationEntries(
  entries: ConversationDisplayEntry[],
  limit: number,
): { entries: ConversationDisplayEntry[]; hiddenCount: number } {
  const visibleCount = Math.max(0, Math.floor(limit))
  const hiddenCount = Math.max(0, entries.length - visibleCount)
  return { entries: entries.slice(hiddenCount), hiddenCount }
}

export function conversationEntries(items: CanonicalItemDto[]): ConversationDisplayEntry[] {
  const entries: ConversationDisplayEntry[] = []
  const toolCalls = new Map<string, number>()
  for (const item of transcriptItems(items)) {
    const callId = typeof item.payload.callId === 'string' ? item.payload.callId : null
    if (item.kind === 'tool_result' && callId && toolCalls.has(callId)) {
      const entry = entries[toolCalls.get(callId)!]
      if (entry) entry.toolResult = item
      continue
    }
    const index = entries.push({ item, toolResult: null }) - 1
    if (item.kind === 'tool_call' && callId) toolCalls.set(callId, index)
  }
  return entries
}

export function isLongConversationText(text: string): boolean {
  return text.length > 2_400 || text.split('\n', 25).length > 24
}

export function activitySummary(item: CanonicalItemDto, result: CanonicalItemDto | null = null): string {
  if (item.kind === 'tool_result') return toolResultFailed(item) ? '도구 실행 실패' : '도구 실행 완료'
  if (item.kind === 'file_change') {
    const path = payloadValue(item.payload, ['path', 'filePath', 'file_path'])
    return path ? `파일 변경 · ${path}` : '파일 변경'
  }
  if (item.kind !== 'tool_call') return ITEM_LABEL[item.kind]

  const name = payloadValue(item.payload, ['name', 'toolName', 'tool']) ?? '도구'
  const input = nestedPayload(item.payload)
  const lower = name.toLocaleLowerCase()
  const state = result && toolResultFailed(result) ? '실패' : result ? '완료' : '실행 중'
  if (/read|open/.test(lower)) return semanticActivity('읽기', input, ['path', 'filePath', 'file_path'], state)
  if (/edit|write|patch/.test(lower)) return semanticActivity('편집', input, ['path', 'filePath', 'file_path'], state)
  if (/search|grep|find/.test(lower)) return semanticActivity('검색', input, ['query', 'pattern', 'path'], state)
  if (/shell|bash|exec|command|run/.test(lower)) return semanticActivity('명령', input, ['command', 'cmd'], state)
  return `${name} · ${state}`
}

function semanticActivity(label: string, payload: JsonObject, keys: string[], state: string): string {
  const detail = payloadValue(payload, keys)
  return detail ? `${label} · ${detail} · ${state}` : `${label} · ${state}`
}

export function activityFailed(item: CanonicalItemDto): boolean {
  const payload = item.kind === 'tool_result'
    ? record(item.payload.result) ?? item.payload
    : item.payload
  return payload.isError === true
    || payload.success === false
    || payload.status === 'failed'
    || payload.status === 'error'
    || (payload.error !== undefined && payload.error !== null)
}

const toolResultFailed = activityFailed

function nestedPayload(payload: JsonObject): JsonObject {
  const direct = record(payload.arguments) ?? record(payload.input)
  if (direct) return direct
  const encoded = typeof payload.arguments === 'string' ? payload.arguments : null
  if (encoded) {
    try {
      const parsed: unknown = JSON.parse(encoded)
      if (parsed && !Array.isArray(parsed) && typeof parsed === 'object') return parsed as JsonObject
    } catch {
      // Non-JSON tool arguments remain available in the raw detail disclosure.
    }
  }
  return payload
}

function payloadValue(payload: JsonObject, keys: string[]): string | null {
  for (const key of keys) {
    const value = payload[key]
    if (typeof value === 'string' && value.trim()) return value.trim().replace(/\s+/g, ' ').slice(0, 180)
  }
  return null
}

export function latestUsageSummary(turns: CanonicalTurnDto[]): string | null {
  const turn = [...turns].reverse().find((item) => item.usage !== null)
  return turn?.usage ? usageSummary(turn.usage) : null
}

export function payloadDetail(item: CanonicalItemDto): string {
  return JSON.stringify({
    sequence: item.sequence,
    provider: item.provider,
    visibility: item.visibility,
    payload: item.payload,
  }, null, 2)
}
