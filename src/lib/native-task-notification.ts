export type NativeTaskNotificationSource = 'claude' | 'codex'

export interface NativeTaskNotification {
  version: 1
  source: NativeTaskNotificationSource
  status: string
  summary: string
  result: string
  taskId: string | null
  toolUseId: string | null
  messageType: string | null
}

const CLAUDE_OPEN = '<task-notification>'
const CLAUDE_CLOSE = '</task-notification>'

export function parseClaudeTaskNotification(text: string): NativeTaskNotification | null {
  const trimmed = text.trim()
  if (!new RegExp(`^${CLAUDE_OPEN}\\r?\\n`).test(trimmed) || !trimmed.endsWith(CLAUDE_CLOSE)) return null
  const body = trimmed.slice(CLAUDE_OPEN.length, -CLAUDE_CLOSE.length).trim()
  const taskId = singleLineTag(body, 'task-id')
  const toolUseId = singleLineTag(body, 'tool-use-id')
  const status = singleLineTag(body, 'status')
  const summary = singleLineTag(body, 'summary')
  const result = multilineTag(body, 'result')
  if (!taskId || !toolUseId || !status || !summary || result === null) return null
  return {
    version: 1,
    source: 'claude',
    status,
    summary,
    result: result.trim(),
    taskId,
    toolUseId,
    messageType: null,
  }
}

export function parseCodexTaskNotification(text: string): NativeTaskNotification | null {
  const match = /^Message Type: (MESSAGE|FINAL_ANSWER)\r?\nTask name: ([^\r\n]+)\r?\nSender: ([^\r\n]+)\r?\nPayload:\r?\n([\s\S]+)$/.exec(text.trim())
  if (!match) return null
  const [, messageType, taskName, sender, result] = match
  if (!messageType || !taskName || !sender || !result?.trim()) return null
  return {
    version: 1,
    source: 'codex',
    status: messageType === 'FINAL_ANSWER' ? 'completed' : 'updated',
    summary: messageType === 'FINAL_ANSWER'
      ? `${taskName} finished`
      : `${sender} updated ${taskName}`,
    result: result.trim(),
    taskId: taskName,
    toolUseId: null,
    messageType,
  }
}

export function taskNotificationFromPayload(payload: Record<string, unknown>): NativeTaskNotification | null {
  const payloadText = typeof payload.text === 'string' ? payload.text : null
  const structured = notificationObject(payload.nativeTaskNotification, payloadText)
  if (structured) return structured
  const text = payloadText
  const sourceClient = typeof payload.nativeSourceClient === 'string' ? payload.nativeSourceClient : null
  if (!text || !sourceClient) return null
  if (sourceClient === 'claude_code' || sourceClient === 'claude_desktop') {
    const notification = parseClaudeTaskNotification(text)
    return notification && isLegacyClaudeTaskNotification(text, notification) ? notification : null
  }
  if (sourceClient === 'codex_local') {
    const notification = parseCodexTaskNotification(text)
    return notification?.taskId?.startsWith('/root') ? notification : null
  }
  return null
}

function isLegacyClaudeTaskNotification(text: string, notification: NativeTaskNotification): boolean {
  return /^[A-Za-z0-9_-]{8,64}$/.test(notification.taskId ?? '')
    && /^toolu_[A-Za-z0-9]+$/.test(notification.toolUseId ?? '')
    && /(?:^|\r?\n)<output-file>[^\r\n<]+<\/output-file>(?:\r?\n|$)/.test(text)
    && /<note>A task-notification fires each time this agent stops/.test(text)
}

export function taskNotificationPayload(notification: NativeTaskNotification): Record<string, unknown> {
  const { result, ...metadata } = notification
  return {
    text: result,
    nativeTaskNotification: metadata,
  }
}

export function taskNotificationContextText(notification: NativeTaskNotification): string {
  const heading = `[Background agent ${notification.status}: ${notification.summary}]`
  return notification.result ? `${heading}\n${notification.result}` : heading
}

function notificationObject(value: unknown, payloadText: string | null): NativeTaskNotification | null {
  if (!value || Array.isArray(value) || typeof value !== 'object') return null
  const item = value as Record<string, unknown>
  if (item.version !== 1 || (item.source !== 'claude' && item.source !== 'codex')
    || typeof item.status !== 'string' || typeof item.summary !== 'string'
    || (typeof item.result !== 'string' && payloadText === null)) return null
  return {
    version: 1,
    source: item.source,
    status: item.status,
    summary: item.summary,
    result: typeof item.result === 'string' ? item.result : payloadText as string,
    taskId: nullableString(item.taskId),
    toolUseId: nullableString(item.toolUseId),
    messageType: nullableString(item.messageType),
  }
}

function nullableString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function singleLineTag(body: string, tag: string): string | null {
  const match = new RegExp(`(?:^|\\r?\\n)<${tag}>([^\\r\\n]*)<\\/${tag}>(?:\\r?\\n|$)`).exec(body)
  return match?.[1]?.trim() || null
}

function multilineTag(body: string, tag: string): string | null {
  const open = `<${tag}>`
  const close = `</${tag}>`
  const start = body.indexOf(open)
  const end = body.lastIndexOf(close)
  if (start < 0 || end < start + open.length) return null
  return body.slice(start + open.length, end)
}
