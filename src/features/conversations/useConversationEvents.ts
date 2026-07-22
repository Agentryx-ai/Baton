import { useEffect, useRef, useState } from 'react'

import { conversationApi } from './api.ts'
import type { CanonicalStreamEventDto, CanonicalStreamEventType } from './types.ts'

const EVENT_TYPES: CanonicalStreamEventType[] = [
  'session_created',
  'thread_forked',
  'turn_started',
  'items_appended',
  'turn_completed',
  'turn_cancelled',
  'turn_failed',
  'turn_interrupted',
  'goal_changed',
]

const REPLAY_QUIET_WINDOW_MS = 75
const threadCursors = new Map<string, number>()
type TimerHandle = ReturnType<typeof setTimeout>

export interface ConversationEventBatcher {
  push(event: CanonicalStreamEventDto, cursor: number): void
  cancel(): void
}

export function createConversationEventBatcher(
  threadId: string,
  onFlush: (event: CanonicalStreamEventDto, cursor: number) => boolean | Promise<boolean>,
  quietWindowMs = REPLAY_QUIET_WINDOW_MS,
  schedule: (callback: () => void, delayMs: number) => TimerHandle = setTimeout,
  cancelScheduled: (handle: TimerHandle) => void = clearTimeout,
): ConversationEventBatcher {
  let cursor = threadCursors.get(threadId) ?? 0
  let pendingEvent: CanonicalStreamEventDto | null = null
  let timer: TimerHandle | null = null
  let flushing = false
  let cancelled = false
  const schedulePending = (): void => {
    if (cancelled || flushing || timer || !pendingEvent) return
    timer = schedule(flush, quietWindowMs)
  }
  const finishFlush = (): void => {
    flushing = false
    schedulePending()
  }
  const flush = (): void => {
    timer = null
    if (cancelled || flushing) return
    const event = pendingEvent
    pendingEvent = null
    if (!event) return
    flushing = true
    const flushedCursor = cursor
    const remember = (refreshed: boolean): void => {
      if (cancelled || !refreshed) return
      threadCursors.set(threadId, Math.max(threadCursors.get(threadId) ?? 0, flushedCursor))
    }
    try {
      const refreshed = onFlush(event, flushedCursor)
      if (typeof refreshed === 'boolean') {
        remember(refreshed)
        finishFlush()
      } else {
        void refreshed.then(remember, () => undefined).finally(finishFlush)
      }
    } catch {
      // A failed projection refresh must not advance the durable cursor cache.
      finishFlush()
    }
  }
  return {
    push(event, nextCursor) {
      if (cancelled || nextCursor <= cursor) return
      cursor = nextCursor
      pendingEvent = event
      if (flushing) return
      if (timer) cancelScheduled(timer)
      timer = schedule(flush, quietWindowMs)
    },
    cancel() {
      cancelled = true
      if (timer) cancelScheduled(timer)
      timer = null
      pendingEvent = null
    },
  }
}

export type ConversationStreamStatus = 'idle' | 'connecting' | 'open' | 'retrying'

export interface ConversationEventsState {
  status: ConversationStreamStatus
  lastSequence: number
  error: string | null
}

function parseEvent(raw: string): CanonicalStreamEventDto | null {
  try {
    const value = JSON.parse(raw) as Partial<CanonicalStreamEventDto>
    if (
      !Number.isSafeInteger(value.sequence) ||
      typeof value.threadId !== 'string' ||
      typeof value.type !== 'string' ||
      value.payload === null ||
      typeof value.payload !== 'object' ||
      Array.isArray(value.payload)
    ) {
      return null
    }
    return value as CanonicalStreamEventDto
  } catch {
    return null
  }
}

export function useConversationEvents(
  threadId: string | null,
  onEvent: (event: CanonicalStreamEventDto) => boolean | Promise<boolean>,
): ConversationEventsState {
  const callbackRef = useRef(onEvent)
  callbackRef.current = onEvent
  const [state, setState] = useState<ConversationEventsState>({
    status: 'idle',
    lastSequence: 0,
    error: null,
  })

  useEffect(() => {
    if (!threadId) {
      setState({ status: 'idle', lastSequence: 0, error: null })
      return
    }

    let cursor = threadCursors.get(threadId) ?? 0
    let active = true
    let source: EventSource | null = null
    let retryTimer: number | undefined
    setState({ status: 'connecting', lastSequence: cursor, error: null })
    const batcher = createConversationEventBatcher(threadId, (event, flushedCursor) => {
      cursor = flushedCursor
      setState({ status: 'open', lastSequence: cursor, error: null })
      return callbackRef.current(event)
    })

    const handleEvent = (event: Event): void => {
      const message = event as Event & { data: string; lastEventId: string }
      const parsed = parseEvent(message.data)
      if (!parsed || parsed.threadId !== threadId) return
      const eventCursor = message.lastEventId.trim() ? Number(message.lastEventId) : Number.NaN
      const nextCursor = Number.isSafeInteger(eventCursor)
        ? Math.max(eventCursor, parsed.sequence)
        : parsed.sequence
      // Durable replay can contain thousands of events. Refresh the canonical snapshot only once
      // after the replay/live burst becomes quiet instead of once per event.
      batcher.push(parsed, nextCursor)
    }

    const disposeSource = (): void => {
      if (!source) return
      for (const type of EVENT_TYPES) source.removeEventListener(type, handleEvent)
      source.close()
      source = null
    }

    const connect = (): void => {
      if (!active) return
      const next = new EventSource(conversationApi.eventsUrl(threadId, cursor))
      source = next
      next.onopen = () => {
        setState((current) => ({ ...current, status: 'open', error: null }))
      }
      next.onerror = () => {
        setState((current) => ({
          ...current,
          status: 'retrying',
          error: '실시간 연결이 끊겨 재연결 중입니다.',
        }))
        // Browsers retry network drops on their own, but an HTTP error (e.g. a
        // 503 while the server restarts) fails the EventSource permanently.
        // Recreate it from the last flushed cursor so the live view recovers.
        if (next.readyState === EventSource.CLOSED && active) {
          disposeSource()
          retryTimer = window.setTimeout(connect, 3_000)
        }
      }
      for (const type of EVENT_TYPES) next.addEventListener(type, handleEvent)
    }

    connect()
    return () => {
      active = false
      if (retryTimer !== undefined) window.clearTimeout(retryTimer)
      batcher.cancel()
      disposeSource()
    }
  }, [threadId])

  return state
}

export function rememberedConversationEventCursor(threadId: string): number {
  return threadCursors.get(threadId) ?? 0
}

export function resetConversationEventCursorsForTest(): void {
  threadCursors.clear()
}
