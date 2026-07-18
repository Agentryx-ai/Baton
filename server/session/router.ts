import express, { Router } from 'express'
import type { NextFunction, Request, Response } from 'express'

import type {
  CanonicalItemKind,
  CanonicalProvider,
  CanonicalStreamEvent,
  CreateSessionInput,
  NewCanonicalItem,
} from './domain.ts'
import type { ConversationService, StartTurnInput } from './service.ts'
import { SessionStoreError } from './store.ts'

const PROVIDERS = new Set<CanonicalProvider>(['claude', 'codex', 'gemini'])
const ITEM_KINDS = new Set<CanonicalItemKind>([
  'user_message',
  'assistant_message',
  'reasoning_summary',
  'tool_call',
  'tool_result',
  'file_change',
  'approval',
  'plan',
  'task',
  'usage',
  'error',
  'summary',
  'provider_event',
])
const SSE_HEARTBEAT_MS = 15_000
const VISIBILITIES = new Set(['portable', 'provider_private', 'baton_private'])

export interface ConversationRouter extends Router {
  closeStreams(): void
}

export interface ConversationRouterOptions {
  listModels?: (provider: CanonicalProvider) => Promise<{
    models: string[]
    defaultModel: string | null
  }>
}

class RequestValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RequestValidationError'
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function bodyRecord(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new RequestValidationError('request body must be a JSON object')
  return value
}

function optionalNullableString(
  body: Record<string, unknown>,
  key: string,
): string | null | undefined {
  const value = body[key]
  if (value === undefined) return undefined
  if (value === null || typeof value === 'string') return value
  throw new RequestValidationError(`${key} must be a string or null`)
}

function requiredNonEmptyString(body: Record<string, unknown>, key: string): string {
  const value = body[key]
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new RequestValidationError(`${key} must be a non-empty string`)
  }
  return value
}

function optionalRecord(
  body: Record<string, unknown>,
  key: string,
): Record<string, unknown> | undefined {
  const value = body[key]
  if (value === undefined) return undefined
  if (!isRecord(value)) throw new RequestValidationError(`${key} must be a JSON object`)
  return value
}

function parseCreateSessionInput(value: unknown): CreateSessionInput {
  const body = bodyRecord(value)
  return {
    title: optionalNullableString(body, 'title'),
    projectKey: optionalNullableString(body, 'projectKey'),
    cwd: optionalNullableString(body, 'cwd'),
    instructionSnapshot: optionalRecord(body, 'instructionSnapshot'),
  }
}

function parseNewItem(value: unknown, index: number): NewCanonicalItem {
  if (!isRecord(value)) throw new RequestValidationError(`input[${index}] must be a JSON object`)
  if (typeof value.kind !== 'string' || !ITEM_KINDS.has(value.kind as CanonicalItemKind)) {
    throw new RequestValidationError(`input[${index}].kind is not supported`)
  }
  if (!isRecord(value.payload)) {
    throw new RequestValidationError(`input[${index}].payload must be a JSON object`)
  }
  if (
    value.visibility !== undefined &&
    (typeof value.visibility !== 'string' || !VISIBILITIES.has(value.visibility))
  ) {
    throw new RequestValidationError(`input[${index}].visibility is not supported`)
  }
  if (
    value.provider !== undefined &&
    value.provider !== null &&
    (typeof value.provider !== 'string' || !PROVIDERS.has(value.provider as CanonicalProvider))
  ) {
    throw new RequestValidationError(`input[${index}].provider is not supported`)
  }
  if (
    value.nativeId !== undefined &&
    value.nativeId !== null &&
    typeof value.nativeId !== 'string'
  ) {
    throw new RequestValidationError(`input[${index}].nativeId must be a string or null`)
  }
  return {
    kind: value.kind as CanonicalItemKind,
    visibility: value.visibility as NewCanonicalItem['visibility'],
    payload: value.payload,
    provider: value.provider as CanonicalProvider | null | undefined,
    nativeId: value.nativeId as string | null | undefined,
  }
}

function parseStartTurnInput(threadId: string, value: unknown): StartTurnInput {
  const body = bodyRecord(value)
  const provider = requiredNonEmptyString(body, 'provider')
  if (!PROVIDERS.has(provider as CanonicalProvider)) {
    throw new RequestValidationError('provider must be claude, codex, or gemini')
  }
  if (!Number.isInteger(body.expectedRevision) || (body.expectedRevision as number) < 0) {
    throw new RequestValidationError('expectedRevision must be a non-negative integer')
  }
  if (!Array.isArray(body.input) || body.input.length === 0) {
    throw new RequestValidationError('input must be a non-empty array')
  }
  return {
    threadId,
    provider: provider as CanonicalProvider,
    model: requiredNonEmptyString(body, 'model'),
    clientRequestId: requiredNonEmptyString(body, 'clientRequestId'),
    expectedRevision: body.expectedRevision as number,
    input: body.input.map(parseNewItem),
  }
}

function parseOptionalCursor(value: unknown, label: string): number | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || !/^\d+$/.test(value)) {
    throw new RequestValidationError(`${label} must be a non-negative integer`)
  }
  const cursor = Number(value)
  if (!Number.isSafeInteger(cursor)) {
    throw new RequestValidationError(`${label} must be a safe non-negative integer`)
  }
  return cursor
}

function requestCursor(req: Request): number {
  const query = parseOptionalCursor(req.query.after, 'after')
  const headerValue = req.get('Last-Event-ID')
  const header = parseOptionalCursor(headerValue, 'Last-Event-ID')
  return Math.max(query ?? 0, header ?? 0)
}

function pathParam(req: Request, key: string): string {
  const value = req.params[key]
  if (typeof value !== 'string' || value.length === 0) {
    throw new RequestValidationError(`${key} must be a non-empty path parameter`)
  }
  return value
}

function sendEvent(res: Response, event: CanonicalStreamEvent): void {
  res.write(`id: ${event.sequence}\n`)
  res.write(`event: ${event.type}\n`)
  res.write(`data: ${JSON.stringify(event)}\n\n`)
}

function route(
  handler: (req: Request, res: Response) => void | Promise<void>,
): (req: Request, res: Response, next: NextFunction) => void {
  return (req, res, next) => {
    Promise.resolve(handler(req, res)).catch(next)
  }
}

export function createConversationRouter(
  service: ConversationService,
  options: ConversationRouterOptions = {},
): ConversationRouter {
  const router = Router() as ConversationRouter
  const streams = new Map<Response, () => void>()

  router.closeStreams = () => {
    for (const [response, cleanup] of [...streams]) {
      response.end()
      cleanup()
    }
  }

  router.use(express.json({ limit: '2mb' }))

  router.post(
    '/sessions',
    route((req, res) => {
      const session = service.createSession(parseCreateSessionInput(req.body))
      res.status(201).json(session)
    }),
  )

  router.get('/sessions', (_req, res) => {
    res.json({ sessions: service.listSessions() })
  })

  router.get(
    '/providers/:provider/models',
    route(async (req, res) => {
      const provider = pathParam(req, 'provider')
      if (!PROVIDERS.has(provider as CanonicalProvider)) {
        throw new RequestValidationError('provider must be claude, codex, or gemini')
      }
      if (!options.listModels) {
        res.status(503).json({ code: 'model_catalog_unavailable', error: 'model catalog is unavailable' })
        return
      }
      const catalog = await options.listModels(provider as CanonicalProvider)
      res.json({ provider, ...catalog })
    }),
  )

  router.get('/sessions/:sessionId', (req, res) => {
    const session = service.getSession(pathParam(req, 'sessionId'))
    if (!session) {
      res.status(404).json({ code: 'not_found', error: 'session not found' })
      return
    }
    res.json(session)
  })

  router.get('/threads/:threadId', (req, res) => {
    const snapshot = service.getSnapshot(pathParam(req, 'threadId'))
    if (!snapshot) {
      res.status(404).json({ code: 'not_found', error: 'thread not found' })
      return
    }
    res.json(snapshot)
  })

  router.post(
    '/threads/:threadId/fork',
    route((req, res) => {
      const body = bodyRecord(req.body)
      const thread = service.forkThread({
        threadId: pathParam(req, 'threadId'),
        forkItemId: optionalNullableString(body, 'forkItemId') ?? null,
      })
      res.status(201).json(thread)
    }),
  )

  router.post(
    '/threads/:threadId/turns',
    route(async (req, res) => {
      const result = await service.startTurn(parseStartTurnInput(pathParam(req, 'threadId'), req.body))
      res.status(result.duplicate ? 200 : 202).json(result)
    }),
  )

  router.get(
    '/threads/:threadId/items',
    route((req, res) => {
      const after = parseOptionalCursor(req.query.after, 'after')
      res.json({ items: service.listItems(pathParam(req, 'threadId'), after) })
    }),
  )

  router.get(
    '/threads/:threadId/events',
    route((req, res) => {
      let cursor = requestCursor(req)
      const threadId = pathParam(req, 'threadId')
      let closed = false
      let flushing = false
      let pending = false
      let unsubscribe: () => void = () => {}
      let heartbeat: ReturnType<typeof setInterval> | undefined

      const cleanup = (): void => {
        if (closed) return
        closed = true
        if (heartbeat) clearInterval(heartbeat)
        unsubscribe()
        streams.delete(res)
      }

      const flush = (): void => {
        if (closed || flushing) {
          pending = true
          return
        }
        flushing = true
        try {
          do {
            pending = false
            const events = service.listEvents(threadId, cursor)
            for (const event of events) {
              if (event.sequence <= cursor) continue
              sendEvent(res, event)
              cursor = event.sequence
            }
          } while (pending && !closed)
        } catch {
          res.end()
          cleanup()
        } finally {
          flushing = false
        }
      }

      // Subscribe before replay so an append racing with the initial query cannot be lost.
      unsubscribe = service.subscribe(threadId, () => {
        pending = true
        if (res.headersSent) flush()
      })

      let initialEvents: CanonicalStreamEvent[]
      try {
        initialEvents = service.listEvents(threadId, cursor)
      } catch (error) {
        unsubscribe()
        throw error
      }

      res.status(200)
      res.setHeader('Content-Type', 'text/event-stream; charset=utf-8')
      res.setHeader('Cache-Control', 'no-cache, no-transform')
      res.setHeader('Connection', 'keep-alive')
      res.flushHeaders()
      streams.set(res, cleanup)

      for (const event of initialEvents) {
        if (event.sequence <= cursor) continue
        sendEvent(res, event)
        cursor = event.sequence
      }
      if (pending) flush()

      heartbeat = setInterval(() => {
        if (!closed) res.write(': heartbeat\n\n')
      }, SSE_HEARTBEAT_MS)
      heartbeat.unref()

      req.on('close', cleanup)
      res.on('close', cleanup)
    }),
  )

  router.post(
    '/turns/:turnId/cancel',
    route(async (req, res) => {
      await service.cancelTurn(pathParam(req, 'turnId'))
      res.status(204).end()
    }),
  )

  router.use((error: unknown, _req: Request, res: Response, next: NextFunction) => {
    if (res.headersSent) {
      next(error)
      return
    }
    if (error instanceof RequestValidationError) {
      res.status(400).json({ code: 'invalid_request', error: error.message })
      return
    }
    if (error instanceof SyntaxError && 'body' in error) {
      res.status(400).json({ code: 'invalid_json', error: 'request body is not valid JSON' })
      return
    }
    if (error instanceof SessionStoreError) {
      const statusByCode = {
        not_found: 404,
        revision_conflict: 409,
        turn_not_running: 409,
        invalid_fork: 400,
        duplicate_request: 409,
      } as const
      res.status(statusByCode[error.code]).json({ code: error.code, error: error.message })
      return
    }
    res.status(500).json({ code: 'internal_error', error: 'internal server error' })
  })

  return router
}
