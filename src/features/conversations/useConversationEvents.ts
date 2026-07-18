import { useEffect, useRef, useState } from 'react'

import { conversationApi } from './api'
import type { CanonicalStreamEventDto, CanonicalStreamEventType } from './types'

const EVENT_TYPES: CanonicalStreamEventType[] = [
  'session_created',
  'thread_forked',
  'turn_started',
  'items_appended',
  'turn_completed',
  'turn_cancelled',
  'turn_failed',
  'turn_interrupted',
]

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
  onEvent: (event: CanonicalStreamEventDto) => void,
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

    let cursor = 0
    setState({ status: 'connecting', lastSequence: 0, error: null })
    const source = new EventSource(conversationApi.eventsUrl(threadId, cursor))

    source.onopen = () => {
      setState((current) => ({ ...current, status: 'open', error: null }))
    }
    source.onerror = () => {
      setState((current) => ({
        ...current,
        status: 'retrying',
        error: '실시간 연결이 끊겨 재연결 중입니다.',
      }))
    }

    const handleEvent = (event: Event): void => {
      const message = event as MessageEvent<string>
      const parsed = parseEvent(message.data)
      if (!parsed || parsed.threadId !== threadId) return
      const eventCursor = Number(message.lastEventId)
      cursor = Number.isSafeInteger(eventCursor) ? Math.max(cursor, eventCursor) : parsed.sequence
      setState({ status: 'open', lastSequence: cursor, error: null })
      callbackRef.current(parsed)
    }

    for (const type of EVENT_TYPES) source.addEventListener(type, handleEvent)
    return () => {
      for (const type of EVENT_TYPES) source.removeEventListener(type, handleEvent)
      source.close()
    }
  }, [threadId])

  return state
}
