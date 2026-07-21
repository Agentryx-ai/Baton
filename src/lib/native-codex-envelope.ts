export type NativeCodexEnvelopeKind =
  | 'internal_context'
  | 'delegation'
  | 'turn_aborted'
  | 'user_shell_command'
  | 'ambient_request'
  | 'subagent_shutdown'

export interface NativeCodexEnvelope {
  version: 1
  source: 'codex'
  kind: NativeCodexEnvelopeKind
  presentation: 'hidden' | 'card' | 'message'
  summary: string
  content: string
  sourceThreadId: string | null
}

const INTERNAL_TAGS = ['codex_internal_context', 'environment_context', 'user_instructions'] as const
const REQUEST_MARKER = '## My request for Codex:'

export function parseCodexEnvelope(text: string): NativeCodexEnvelope | null {
  const trimmed = text.trim()
  for (const tagName of INTERNAL_TAGS) {
    if (wholeTag(trimmed, tagName) !== null) return internalEnvelope('Codex 내부 컨텍스트')
  }
  if (trimmed.startsWith('<recommended_plugins>')) return internalEnvelope('Codex 플러그인 컨텍스트')

  if (trimmed.startsWith('<in-app-browser-context')) {
    const request = textAfterMarker(trimmed, REQUEST_MARKER)
    return request
      ? envelope('ambient_request', 'message', '사용자', request, null)
      : internalEnvelope('Codex 브라우저 컨텍스트')
  }

  const delegation = wholeTag(trimmed, 'codex_delegation')
  if (delegation !== null) {
    const input = tag(delegation, 'input')
    if (input === null) return null
    return envelope(
      'delegation', 'card', '하위 작업 배정', decodeXml(input).trim(),
      nullable(tag(delegation, 'source_thread_id')),
    )
  }

  const aborted = wholeTag(trimmed, 'turn_aborted')
  if (aborted !== null) {
    return envelope('turn_aborted', 'card', '이전 턴 중단됨', decodeXml(aborted).trim(), null)
  }

  const shell = wholeTag(trimmed, 'user_shell_command')
  if (shell !== null) {
    const command = tag(shell, 'command')?.trim() ?? ''
    const result = tag(shell, 'result')?.trim() ?? ''
    const content = [command && `$ ${decodeXml(command)}`, result && decodeXml(result)].filter(Boolean).join('\n\n')
    return envelope('user_shell_command', 'card', '사용자 셸 명령', content, null)
  }

  const subagent = wholeTag(trimmed, 'subagent_notification')
  if (subagent !== null) {
    try {
      const value = JSON.parse(subagent) as unknown
      if (record(value)?.status === 'shutdown') {
        return envelope('subagent_shutdown', 'hidden', '하위 에이전트 종료', '', null)
      }
    } catch { /* malformed envelopes remain ordinary text */ }
  }
  return null
}

export function codexEnvelopeFromPayload(payload: Record<string, unknown>): NativeCodexEnvelope | null {
  const payloadText = typeof payload.text === 'string' ? payload.text : null
  const structured = envelopeObject(payload.nativeCodexEnvelope, payloadText)
  if (structured) return structured
  if (payload.nativeSourceClient !== 'codex_local' || !payloadText) return null
  return parseCodexEnvelope(payloadText)
}

export function codexEnvelopePayload(message: NativeCodexEnvelope): Record<string, unknown> {
  const { content, ...metadata } = message
  return { text: content, nativeCodexEnvelope: metadata }
}

export function codexEnvelopeContextText(message: NativeCodexEnvelope): string | null {
  if (message.presentation === 'hidden') return null
  if (message.kind === 'ambient_request') return message.content
  const source = message.sourceThreadId ? ` from ${message.sourceThreadId}` : ''
  return message.content ? `[${message.summary}${source}]\n${message.content}` : `[${message.summary}${source}]`
}

function internalEnvelope(summary: string): NativeCodexEnvelope {
  return envelope('internal_context', 'hidden', summary, '', null)
}

function envelope(
  kind: NativeCodexEnvelopeKind,
  presentation: NativeCodexEnvelope['presentation'],
  summary: string,
  content: string,
  sourceThreadId: string | null,
): NativeCodexEnvelope {
  return { version: 1, source: 'codex', kind, presentation, summary, content, sourceThreadId }
}

function envelopeObject(value: unknown, payloadText: string | null): NativeCodexEnvelope | null {
  const item = record(value)
  if (!item || item.version !== 1 || item.source !== 'codex'
    || !isKind(item.kind) || !isPresentation(item.presentation) || typeof item.summary !== 'string') return null
  return envelope(
    item.kind,
    item.presentation,
    item.summary,
    typeof item.content === 'string' ? item.content : payloadText ?? '',
    nullable(item.sourceThreadId),
  )
}

function wholeTag(text: string, name: string): string | null {
  const match = new RegExp(`^<${name}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${name}>$`, 'i').exec(text)
  return match?.[1] ?? null
}

function tag(text: string, name: string): string | null {
  return new RegExp(`<${name}>([\\s\\S]*?)<\\/${name}>`, 'i').exec(text)?.[1] ?? null
}

function textAfterMarker(text: string, marker: string): string | null {
  const index = text.indexOf(marker)
  if (index < 0) return null
  return text.slice(index + marker.length).trim() || null
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function nullable(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function isKind(value: unknown): value is NativeCodexEnvelopeKind {
  return value === 'internal_context' || value === 'delegation' || value === 'turn_aborted'
    || value === 'user_shell_command' || value === 'ambient_request' || value === 'subagent_shutdown'
}

function isPresentation(value: unknown): value is NativeCodexEnvelope['presentation'] {
  return value === 'hidden' || value === 'card' || value === 'message'
}

function decodeXml(value: string): string {
  return value
    .replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'").replaceAll('&amp;', '&')
}
