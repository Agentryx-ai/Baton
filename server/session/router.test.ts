import assert from 'node:assert/strict'
import type { AddressInfo } from 'node:net'
import test from 'node:test'

import express from 'express'

import type {
  BeginTurnResult,
  CanonicalExecution,
  CanonicalItem,
  CanonicalSession,
  CanonicalStreamEvent,
  CanonicalThread,
  CanonicalTurn,
  CreateSessionInput,
  ThreadSnapshot,
} from './domain.ts'
import {
  createConversationRouter,
  type ConversationRouter,
  type ConversationRouterOptions,
} from './router.ts'
import type { ConversationService, StartTurnInput } from './service.ts'
import { SessionStoreError } from './store.ts'
import type { ForkThreadInput } from './store.ts'

const now = '2026-07-18T00:00:00.000Z'

const thread: CanonicalThread = {
  id: 'thread-1',
  sessionId: 'session-1',
  parentThreadId: null,
  forkTurnId: null,
  forkItemId: null,
  revision: 0,
  status: 'idle',
  instructionSnapshot: {},
  createdAt: now,
  updatedAt: now,
}

const session: CanonicalSession = {
  id: 'session-1',
  title: 'Session',
  preview: null,
  activeThreadId: thread.id,
  projectKey: null,
  cwd: null,
  schemaVersion: 1,
  createdAt: now,
  updatedAt: now,
  archivedAt: null,
}

const turn: CanonicalTurn = {
  id: 'turn-1',
  threadId: thread.id,
  sequence: 1,
  provider: 'codex',
  model: 'gpt-5',
  status: 'queued',
  clientRequestId: 'request-1',
  startedAt: null,
  completedAt: null,
  usage: null,
  error: null,
}

const execution: CanonicalExecution = {
  id: 'execution-1',
  sessionId: session.id,
  threadId: thread.id,
  turnId: turn.id,
  parentExecutionId: null,
  spawnItemId: null,
  kind: 'root_turn',
  provider: 'codex',
  model: 'gpt-5',
  adapterVersion: 'test',
  status: 'queued',
  policySnapshot: {
    delegationMode: 'disabled',
    allowedTools: [],
    approvalPolicy: 'never',
    cwd: null,
    maxDepth: 0,
    capabilityGrant: null,
  },
  budget: {},
  usage: {},
  leaseExpiresAt: null,
  startedAt: null,
  completedAt: null,
}

const item: CanonicalItem = {
  id: 'item-1',
  sessionId: session.id,
  threadId: thread.id,
  turnId: turn.id,
  sequence: 1,
  kind: 'user_message',
  visibility: 'portable',
  payload: { text: 'hello' },
  provider: null,
  nativeId: null,
  createdAt: now,
}

const beginResult: BeginTurnResult = {
  turn,
  execution,
  initialItems: [item],
  duplicate: false,
}

function streamEvent(sequence: number): CanonicalStreamEvent {
  return {
    sequence,
    sessionId: session.id,
    threadId: thread.id,
    turnId: turn.id,
    type: 'items_appended',
    payload: { sequence },
    createdAt: now,
  }
}

class TestConversationService implements ConversationService {
  readonly calls: string[] = []
  readonly listeners = new Set<() => void>()
  sessions = [session]
  items = [item]
  events: CanonicalStreamEvent[] = []
  createdInput: CreateSessionInput | null = null
  forkInput: ForkThreadInput | null = null
  startInput: StartTurnInput | null = null
  cancelledTurnId: string | null = null

  createSession(input: CreateSessionInput): CanonicalSession {
    this.createdInput = input
    return session
  }

  listSessions(): CanonicalSession[] {
    return this.sessions
  }

  getSession(sessionId: string): CanonicalSession | null {
    return this.sessions.find((candidate) => candidate.id === sessionId) ?? null
  }

  getSnapshot(threadId: string): ThreadSnapshot | null {
    if (threadId !== thread.id) return null
    return { session, thread, turns: [turn], items: this.items, bindings: [] }
  }

  forkThread(input: ForkThreadInput): CanonicalThread {
    this.forkInput = input
    return { ...thread, id: 'thread-2', parentThreadId: input.threadId, forkItemId: input.forkItemId }
  }

  listItems(_threadId: string, afterSequence = 0): CanonicalItem[] {
    this.calls.push(`items:${afterSequence}`)
    return this.items.filter((candidate) => candidate.sequence > afterSequence)
  }

  listEvents(_threadId: string, afterSequence = 0): CanonicalStreamEvent[] {
    this.calls.push(`events:${afterSequence}`)
    return this.events.filter((candidate) => candidate.sequence > afterSequence)
  }

  async startTurn(input: StartTurnInput): Promise<BeginTurnResult> {
    this.startInput = input
    return beginResult
  }

  async cancelTurn(turnId: string): Promise<void> {
    this.cancelledTurnId = turnId
  }

  subscribe(_threadId: string, listener: () => void): () => void {
    this.calls.push('subscribe')
    this.listeners.add(listener)
    return () => {
      this.calls.push('unsubscribe')
      this.listeners.delete(listener)
    }
  }

  notify(): void {
    for (const listener of this.listeners) listener()
  }
}

async function withServer(
  service: ConversationService,
  run: (baseUrl: string, router: ConversationRouter) => Promise<void>,
  options: ConversationRouterOptions = {},
): Promise<void> {
  const app = express()
  const router = createConversationRouter(service, options)
  app.use('/baton/v1', router)
  const server = app.listen(0, '127.0.0.1')
  await new Promise<void>((resolve, reject) => {
    server.once('listening', resolve)
    server.once('error', reject)
  })
  const address = server.address() as AddressInfo
  try {
    await run(`http://127.0.0.1:${address.port}/baton/v1`, router)
  } finally {
    const closed = new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()))
    })
    server.closeAllConnections()
    await closed
  }
}

test('provider model route exposes the runtime catalog and rejects unknown providers', async () => {
  const service = new TestConversationService()
  const requested: string[] = []
  await withServer(service, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/providers/codex/models`)
    assert.equal(response.status, 200)
    assert.deepEqual(await json(response), {
      provider: 'codex',
      models: ['gpt-5.6-sol', 'gpt-5.6-terra'],
      defaultModel: 'gpt-5.6-sol',
    })
    assert.deepEqual(requested, ['codex'])

    const invalid = await fetch(`${baseUrl}/providers/other/models`)
    assert.equal(invalid.status, 400)
    assert.equal((await json(invalid)).code, 'invalid_request')
  }, {
    listModels: async (provider) => {
      requested.push(provider)
      return {
        models: ['gpt-5.6-sol', 'gpt-5.6-terra'],
        defaultModel: 'gpt-5.6-sol',
      }
    },
  })
})

async function json(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>
}

test('session routes parse JSON, list sessions, and return deterministic errors', async () => {
  const service = new TestConversationService()
  await withServer(service, async (baseUrl) => {
    const created = await fetch(`${baseUrl}/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Session', cwd: 'C:\\repo', instructionSnapshot: { a: 1 } }),
    })
    assert.equal(created.status, 201)
    assert.equal((await json(created)).id, session.id)
    assert.deepEqual(service.createdInput, {
      title: 'Session',
      projectKey: undefined,
      cwd: 'C:\\repo',
      instructionSnapshot: { a: 1 },
    })

    const listed = await fetch(`${baseUrl}/sessions`)
    assert.equal(listed.status, 200)
    assert.deepEqual((await json(listed)).sessions, [session])

    const missing = await fetch(`${baseUrl}/sessions/missing`)
    assert.equal(missing.status, 404)
    assert.deepEqual(await json(missing), { code: 'not_found', error: 'session not found' })

    const snapshot = await fetch(`${baseUrl}/threads/${thread.id}`)
    assert.equal(snapshot.status, 200)
    assert.equal(((await json(snapshot)).thread as Record<string, unknown>).revision, 0)

    const missingThread = await fetch(`${baseUrl}/threads/missing`)
    assert.equal(missingThread.status, 404)
    assert.deepEqual(await json(missingThread), { code: 'not_found', error: 'thread not found' })

    const invalid = await fetch(`${baseUrl}/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 3 }),
    })
    assert.equal(invalid.status, 400)
    assert.equal((await json(invalid)).code, 'invalid_request')

    const malformed = await fetch(`${baseUrl}/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{',
    })
    assert.equal(malformed.status, 400)
    assert.deepEqual(await json(malformed), {
      code: 'invalid_json',
      error: 'request body is not valid JSON',
    })
  })
})

test('fork, turn, item cursor, and cancellation routes pass validated contracts', async () => {
  const service = new TestConversationService()
  await withServer(service, async (baseUrl) => {
    const forked = await fetch(`${baseUrl}/threads/${thread.id}/fork`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ forkItemId: item.id }),
    })
    assert.equal(forked.status, 201)
    assert.deepEqual(service.forkInput, { threadId: thread.id, forkItemId: item.id })

    const started = await fetch(`${baseUrl}/threads/${thread.id}/turns`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        provider: 'codex',
        model: 'gpt-5',
        clientRequestId: 'request-1',
        expectedRevision: 0,
        input: [
          {
            kind: 'user_message',
            visibility: 'portable',
            payload: { text: 'hello' },
          },
        ],
      }),
    })
    assert.equal(started.status, 202)
    assert.equal((await json(started)).duplicate, false)
    assert.deepEqual(service.startInput, {
      threadId: thread.id,
      provider: 'codex',
      model: 'gpt-5',
      clientRequestId: 'request-1',
      expectedRevision: 0,
      input: [
        {
          kind: 'user_message',
          visibility: 'portable',
          payload: { text: 'hello' },
          provider: undefined,
          nativeId: undefined,
        },
      ],
    })

    const listed = await fetch(`${baseUrl}/threads/${thread.id}/items?after=0`)
    assert.equal(listed.status, 200)
    assert.deepEqual((await json(listed)).items, [item])
    assert.ok(service.calls.includes('items:0'))

    const cancelled = await fetch(`${baseUrl}/turns/${turn.id}/cancel`, { method: 'POST' })
    assert.equal(cancelled.status, 204)
    assert.equal(service.cancelledTurnId, turn.id)

    const invalid = await fetch(`${baseUrl}/threads/${thread.id}/turns`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        provider: 'other',
        model: 'x',
        clientRequestId: 'request-2',
        expectedRevision: 0,
        input: [{ kind: 'user_message', payload: {} }],
      }),
    })
    assert.equal(invalid.status, 400)
    assert.equal((await json(invalid)).code, 'invalid_request')
  })
})

test('SessionStoreError codes map to stable HTTP statuses', async () => {
  const cases = [
    ['not_found', 404],
    ['revision_conflict', 409],
    ['turn_not_running', 409],
    ['invalid_fork', 400],
    ['duplicate_request', 409],
  ] as const

  for (const [code, status] of cases) {
    const service = new TestConversationService()
    service.forkThread = () => {
      throw new SessionStoreError(code, code)
    }
    await withServer(service, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/threads/${thread.id}/fork`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      })
      assert.equal(response.status, status)
      assert.deepEqual(await json(response), { code, error: code })
    })
  }
})

test('SSE subscribes before replay and resumes from the greatest durable cursor', async () => {
  const service = new TestConversationService()
  service.events = [streamEvent(2), streamEvent(3)]

  await withServer(service, async (baseUrl) => {
    const controller = new AbortController()
    const response = await fetch(`${baseUrl}/threads/${thread.id}/events?after=1`, {
      headers: { 'Last-Event-ID': '2' },
      signal: controller.signal,
    })
    assert.equal(response.status, 200)
    assert.match(response.headers.get('content-type') ?? '', /^text\/event-stream/)
    assert.deepEqual(service.calls.slice(0, 2), ['subscribe', 'events:2'])

    const reader = response.body!.getReader()
    const decoder = new TextDecoder()
    const first = decoder.decode((await reader.read()).value)
    assert.match(first, /id: 3\n/)
    assert.doesNotMatch(first, /id: 2\n/)

    service.events.push(streamEvent(4))
    service.notify()
    const second = decoder.decode((await reader.read()).value)
    assert.match(second, /id: 4\n/)

    controller.abort()
    await reader.cancel().catch(() => {})
    await new Promise((resolve) => setTimeout(resolve, 20))
  })
  assert.ok(service.calls.includes('unsubscribe'))
})

test('SSE rejects malformed cursors before subscribing', async () => {
  const service = new TestConversationService()
  await withServer(service, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/threads/${thread.id}/events?after=nope`)
    assert.equal(response.status, 400)
    assert.equal((await json(response)).code, 'invalid_request')
  })
  assert.deepEqual(service.calls, [])
})

test('router shutdown closes open SSE streams and unsubscribes them', async () => {
  const service = new TestConversationService()
  await withServer(service, async (baseUrl, router) => {
    const response = await fetch(`${baseUrl}/threads/${thread.id}/events`)
    assert.equal(response.status, 200)
    const reader = response.body!.getReader()
    router.closeStreams()
    assert.equal((await reader.read()).done, true)
  })
  assert.ok(service.calls.includes('unsubscribe'))
})
