import type { CanonicalItemDto, CanonicalTurnDto, JsonObject, JsonValue } from './types.ts'

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
  return items.filter((item) => item.kind !== 'usage')
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
