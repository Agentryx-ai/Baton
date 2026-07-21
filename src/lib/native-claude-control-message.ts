export type NativeClaudeControlMessageKind = 'command' | 'command_output' | 'stop_hook'

export interface NativeClaudeControlMessage {
  version: 1
  source: 'claude'
  kind: NativeClaudeControlMessageKind
  summary: string
  content: string
  commandName: string | null
}

const STOP_HOOK_PREFIX = 'A session-scoped Stop hook is now active with condition:'
const STOP_HOOK_BLOCKING_NOTE = 'The hook will block stopping until the condition holds.'
const STOP_HOOK_AUTO_CLEAR_NOTE = 'It auto-clears once the condition is met'

export function parseClaudeControlMessage(text: string): NativeClaudeControlMessage | null {
  const trimmed = text.trim()
  const commandName = tag(trimmed, 'command-name')
  if (commandName && /^<command-name>[\s\S]*<\/command-name>\s*(?:<command-message>[\s\S]*<\/command-message>\s*)?(?:<command-args>[\s\S]*<\/command-args>)?$/i.test(trimmed)) {
    const args = tag(trimmed, 'command-args') ?? ''
    return {
      version: 1,
      source: 'claude',
      kind: 'command',
      summary: `Claude 명령 · ${commandName}`,
      content: decodeXml(args).trim(),
      commandName,
    }
  }

  const output = wholeTag(trimmed, 'local-command-stdout')
  if (output !== null) {
    const content = decodeXml(output).trim()
    return {
      version: 1,
      source: 'claude',
      kind: 'command_output',
      summary: /^Goal set:/i.test(content)
        ? '목표 설정 완료'
        : /^Goal cleared(?::|$)/i.test(content)
          ? '목표 해제 완료'
          : 'Claude 명령 결과',
      content,
      commandName: null,
    }
  }

  if (trimmed.startsWith(STOP_HOOK_PREFIX)
    && trimmed.includes(STOP_HOOK_BLOCKING_NOTE)
    && trimmed.includes(STOP_HOOK_AUTO_CLEAR_NOTE)) {
    return {
      version: 1,
      source: 'claude',
      kind: 'stop_hook',
      summary: '목표 Stop hook 활성화',
      content: '',
      commandName: '/goal',
    }
  }
  return null
}

export function claudeControlMessageFromPayload(payload: Record<string, unknown>): NativeClaudeControlMessage | null {
  const payloadText = typeof payload.text === 'string' ? payload.text : null
  const structured = controlObject(payload.nativeClaudeControlMessage, payloadText)
  if (structured) return structured
  const sourceClient = typeof payload.nativeSourceClient === 'string' ? payload.nativeSourceClient : null
  if (!payloadText || (sourceClient !== 'claude_code' && sourceClient !== 'claude_desktop')) return null
  return parseClaudeControlMessage(payloadText)
}

export function claudeControlMessagePayload(message: NativeClaudeControlMessage): Record<string, unknown> {
  const { content, ...metadata } = message
  return { text: content, nativeClaudeControlMessage: metadata }
}

export function claudeControlMessageContextText(message: NativeClaudeControlMessage): string {
  if (message.kind === 'command') {
    return message.content ? `[Claude command ${message.commandName ?? ''}]\n${message.content}` : `[${message.summary}]`
  }
  if (message.kind === 'command_output') {
    return message.content ? `[${message.summary}]\n${message.content}` : `[${message.summary}]`
  }
  return '[Claude Goal Stop hook active]'
}

function controlObject(value: unknown, payloadText: string | null): NativeClaudeControlMessage | null {
  if (!value || Array.isArray(value) || typeof value !== 'object') return null
  const item = value as Record<string, unknown>
  if (item.version !== 1 || item.source !== 'claude'
    || (item.kind !== 'command' && item.kind !== 'command_output' && item.kind !== 'stop_hook')
    || typeof item.summary !== 'string') return null
  return {
    version: 1,
    source: 'claude',
    kind: item.kind,
    summary: item.summary,
    content: typeof item.content === 'string' ? item.content : payloadText ?? '',
    commandName: nullableString(item.commandName),
  }
}

function tag(text: string, name: string): string | null {
  return new RegExp(`<${name}>([\\s\\S]*?)<\\/${name}>`, 'i').exec(text)?.[1]?.trim() || null
}

function wholeTag(text: string, name: string): string | null {
  const match = new RegExp(`^<${name}>([\\s\\S]*?)<\\/${name}>$`, 'i').exec(text)
  return match?.[1] ?? null
}

function nullableString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function decodeXml(value: string): string {
  return value
    .replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'").replaceAll('&amp;', '&')
}
