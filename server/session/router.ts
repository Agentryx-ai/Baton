import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import express, { Router } from 'express'
import type { NextFunction, Request, Response } from 'express'

import type {
  CanonicalItemKind,
  CanonicalProvider,
  CanonicalStreamEvent,
  CreateSessionInput,
  GoalObservation,
  NewCanonicalItem,
} from './domain.ts'
import { normalizeInstructionSnapshot } from './instruction-snapshot.ts'
import { WorkspaceRootError } from './workspace-root.ts'
import { ProviderReadinessError } from './service.ts'
import type { ConversationService, StartSessionInput, StartTurnInput, SubmitFollowUpInput } from './service.ts'
import { FollowUpStoreError, GoalStoreError, SessionStoreError } from './store.ts'
import type { CreateGoalInput, EditGoalInput, ReconcileToolInput } from './store.ts'
import type { ProviderModelDescriptor } from './model-catalog.ts'
import type { NativeSessionImportService } from './native-import/service.ts'
import { NativeImportError } from './native-import/service.ts'
import type { CodexNativeScanFilter, NativeSourceClient } from './native-import/contracts.ts'

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
    models: ProviderModelDescriptor[]
    defaultModel: string | null
  }>
  nativeImport?: NativeSessionImportService
}

class RequestValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RequestValidationError'
  }
}

class NativeImportSecurityError extends Error {
  constructor(message = 'native import request was rejected') {
    super(message)
    this.name = 'NativeImportSecurityError'
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function bodyRecord(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new RequestValidationError('request body must be a JSON object')
  return value
}

function requireOnlyKeys(body: Record<string, unknown>, keys: readonly string[]): void {
  const allowed = new Set(keys)
  if (Object.keys(body).some((key) => !allowed.has(key))) throw new RequestValidationError('request contains unsupported fields')
}

function nativeImportPrincipal(req: Request, requireOrigin: boolean): string {
  const remoteAddress = req.socket.remoteAddress ?? ''
  if (remoteAddress !== '127.0.0.1' && remoteAddress !== '::1' && remoteAddress !== '::ffff:127.0.0.1') {
    throw new NativeImportSecurityError()
  }
  const host = req.get('host') ?? ''
  if (!/^(?:127\.0\.0\.1|localhost|\[::1\])(?::(?:[1-9]\d{0,4}))?$/.test(host)) {
    throw new NativeImportSecurityError()
  }
  try { new URL(`http://${host}`) } catch { throw new NativeImportSecurityError() }
  if (req.get('sec-fetch-site') !== 'same-origin') throw new NativeImportSecurityError()
  const origin = req.get('origin')
  if (requireOrigin && !origin) throw new NativeImportSecurityError()
  if (origin) {
    let parsed: URL
    try { parsed = new URL(origin) } catch { throw new NativeImportSecurityError() }
    if (parsed.protocol !== 'http:' || parsed.host !== host || parsed.origin !== origin) throw new NativeImportSecurityError()
  }
  return createHash('sha256').update(`${host}\0${origin ?? `http://${host}`}`).digest('hex')
}

function requireCsrf(req: Request, expected: string): string {
  const principal = nativeImportPrincipal(req, true)
  const supplied = req.get('x-baton-csrf-token') ?? ''
  const left = Buffer.from(supplied); const right = Buffer.from(expected)
  if (left.length !== right.length || !timingSafeEqual(left, right)) throw new NativeImportSecurityError()
  return principal
}

function safeDisplayAlias(value: string | null): string | null {
  if (!value) return null
  const trimmed = value.trim().slice(0, 240)
  if (!trimmed) return null
  if (/^(?:[a-zA-Z]:[\\/]|\\\\|\/)/.test(trimmed)) {
    return trimmed.split(/[\\/]+/).filter(Boolean).at(-1) ?? null
  }
  return trimmed
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

function requiredPositiveInteger(body: Record<string, unknown>, key: string): number {
  const value = body[key]
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    throw new RequestValidationError(`${key} must be a positive integer`)
  }
  return Number(value)
}

function requiredNonNegativeInteger(body: Record<string, unknown>, key: string): number {
  const value = body[key]
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new RequestValidationError(`${key} must be a non-negative integer`)
  }
  return Number(value)
}

function optionalPositiveInteger(body: Record<string, unknown>, key: string): number | undefined {
  if (body[key] === undefined) return undefined
  return requiredPositiveInteger(body, key)
}

function requiredProvider(body: Record<string, unknown>, key = 'provider'): CanonicalProvider {
  const value = body[key]
  if (typeof value !== 'string' || !PROVIDERS.has(value as CanonicalProvider)) {
    throw new RequestValidationError(`${key} must be claude, codex, or gemini`)
  }
  return value as CanonicalProvider
}

function parseGoalObservation(value: unknown): GoalObservation {
  const expected = bodyRecord(value)
  if (expected.kind === 'none') {
    requireOnlyKeys(expected, ['kind'])
    return { kind: 'none' }
  }
  if (expected.kind === 'goal') {
    requireOnlyKeys(expected, ['kind', 'goalId', 'revision'])
    return {
      kind: 'goal',
      goalId: requiredNonEmptyString(expected, 'goalId'),
      revision: requiredPositiveInteger(expected, 'revision'),
    }
  }
  throw new RequestValidationError('expected.kind must be none or goal')
}

function parseCreateGoalInput(threadId: string, value: unknown): CreateGoalInput {
  const body = bodyRecord(value)
  requireOnlyKeys(body, [
    'expected', 'objective', 'provider', 'model', 'effort', 'tokenBudget',
    'maxAutomaticTurns', 'maxActiveSeconds', 'replaceExisting',
  ])
  if (body.tokenBudget !== undefined && body.tokenBudget !== null) requiredPositiveInteger(body, 'tokenBudget')
  if (body.replaceExisting !== undefined && typeof body.replaceExisting !== 'boolean') {
    throw new RequestValidationError('replaceExisting must be a boolean')
  }
  return {
    threadId,
    expected: parseGoalObservation(body.expected),
    objective: requiredNonEmptyString(body, 'objective'),
    provider: requiredProvider(body),
    model: requiredNonEmptyString(body, 'model'),
    effort: optionalNullableString(body, 'effort'),
    tokenBudget: body.tokenBudget === null ? null : optionalPositiveInteger(body, 'tokenBudget'),
    maxAutomaticTurns: optionalPositiveInteger(body, 'maxAutomaticTurns'),
    maxActiveSeconds: optionalPositiveInteger(body, 'maxActiveSeconds'),
    replaceExisting: body.replaceExisting as boolean | undefined,
  }
}

function parseEditGoalInput(goalId: string, value: unknown): EditGoalInput {
  const body = bodyRecord(value)
  requireOnlyKeys(body, [
    'expectedRevision', 'objective', 'provider', 'model', 'effort', 'tokenBudget',
    'maxAutomaticTurns', 'maxActiveSeconds', 'resetLimitCounters',
  ])
  if (body.tokenBudget !== undefined && body.tokenBudget !== null) requiredPositiveInteger(body, 'tokenBudget')
  if (body.resetLimitCounters !== undefined && typeof body.resetLimitCounters !== 'boolean') {
    throw new RequestValidationError('resetLimitCounters must be a boolean')
  }
  return {
    goalId,
    expectedRevision: requiredPositiveInteger(body, 'expectedRevision'),
    ...(body.objective === undefined ? {} : { objective: requiredNonEmptyString(body, 'objective') }),
    ...(body.provider === undefined ? {} : { provider: requiredProvider(body) }),
    ...(body.model === undefined ? {} : { model: requiredNonEmptyString(body, 'model') }),
    ...(body.effort === undefined ? {} : { effort: optionalNullableString(body, 'effort') }),
    ...(body.tokenBudget === undefined ? {} : {
      tokenBudget: body.tokenBudget === null ? null : requiredPositiveInteger(body, 'tokenBudget'),
    }),
    ...(body.maxAutomaticTurns === undefined ? {} : {
      maxAutomaticTurns: requiredPositiveInteger(body, 'maxAutomaticTurns'),
    }),
    ...(body.maxActiveSeconds === undefined ? {} : {
      maxActiveSeconds: requiredPositiveInteger(body, 'maxActiveSeconds'),
    }),
    ...(body.resetLimitCounters === undefined ? {} : { resetLimitCounters: body.resetLimitCounters }),
  }
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
  const instructionSnapshot = optionalRecord(body, 'instructionSnapshot')
  let normalizedInstructions: ReturnType<typeof normalizeInstructionSnapshot> | undefined
  try {
    normalizedInstructions = instructionSnapshot === undefined
      ? undefined
      : normalizeInstructionSnapshot(instructionSnapshot)
  } catch (error) {
    throw new RequestValidationError(error instanceof Error ? error.message : String(error))
  }
  return {
    title: optionalNullableString(body, 'title'),
    projectKey: optionalNullableString(body, 'projectKey'),
    cwd: optionalNullableString(body, 'cwd'),
    ...(normalizedInstructions === undefined ? {} : { instructionSnapshot: normalizedInstructions }),
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
  const effort = optionalNullableString(body, 'effort')
  if (!PROVIDERS.has(provider as CanonicalProvider)) {
    throw new RequestValidationError('provider must be claude, codex, or gemini')
  }
  if (!Number.isInteger(body.expectedRevision) || (body.expectedRevision as number) < 0) {
    throw new RequestValidationError('expectedRevision must be a non-negative integer')
  }
  if (!Array.isArray(body.input) || body.input.length === 0) {
    throw new RequestValidationError('input must be a non-empty array')
  }
  if (effort !== undefined && effort !== null && effort.trim().length === 0) {
    throw new RequestValidationError('effort must be null or a non-empty string')
  }
  return {
    threadId,
    provider: provider as CanonicalProvider,
    model: requiredNonEmptyString(body, 'model'),
    effort,
    clientRequestId: requiredNonEmptyString(body, 'clientRequestId'),
    expectedRevision: body.expectedRevision as number,
    input: body.input.map(parseNewItem),
  }
}

function parseStartSessionInput(sessionId: string, value: unknown): StartSessionInput {
  const body = bodyRecord(value)
  requireOnlyKeys(body, [
    'clientRequestId',
    'cwd',
    'instructionSnapshot',
    'provider',
    'model',
    'effort',
    'input',
  ])
  const provider = requiredNonEmptyString(body, 'provider')
  if (!PROVIDERS.has(provider as CanonicalProvider)) {
    throw new RequestValidationError('provider must be claude, codex, or gemini')
  }
  const cwd = optionalNullableString(body, 'cwd')
  if (cwd === undefined || (cwd !== null && cwd.trim().length === 0)) {
    throw new RequestValidationError('cwd must be null or a non-empty string')
  }
  const effort = optionalNullableString(body, 'effort')
  if (effort !== undefined && effort !== null && effort.trim().length === 0) {
    throw new RequestValidationError('effort must be null or a non-empty string')
  }
  const instructionSnapshot = optionalRecord(body, 'instructionSnapshot')
  let normalizedInstructions: ReturnType<typeof normalizeInstructionSnapshot> | undefined
  try {
    normalizedInstructions = instructionSnapshot === undefined
      ? undefined
      : normalizeInstructionSnapshot(instructionSnapshot)
  } catch (error) {
    throw new RequestValidationError(error instanceof Error ? error.message : String(error))
  }
  if (!Array.isArray(body.input) || body.input.length === 0) {
    throw new RequestValidationError('input must be a non-empty array')
  }
  const input = body.input.map(parseNewItem)
  if (input.some((item) => item.kind !== 'user_message'
    || (item.visibility !== undefined && item.visibility !== 'portable')
    || (item.provider !== undefined && item.provider !== null)
    || (item.nativeId !== undefined && item.nativeId !== null)
    || typeof item.payload.text !== 'string'
    || !item.payload.text.trim())) {
    throw new RequestValidationError('input must contain non-empty portable provider-neutral user messages')
  }
  return {
    sessionId,
    clientRequestId: requiredNonEmptyString(body, 'clientRequestId'),
    cwd,
    ...(normalizedInstructions === undefined ? {} : { instructionSnapshot: normalizedInstructions }),
    provider: provider as CanonicalProvider,
    model: requiredNonEmptyString(body, 'model'),
    effort,
    input,
  }
}

function parseFollowUpInput(threadId: string, value: unknown): SubmitFollowUpInput {
  const body = bodyRecord(value)
  requireOnlyKeys(body, ['clientRequestId', 'expectedTurnId', 'delivery', 'input'])
  if (body.delivery !== 'steer_or_queue' && body.delivery !== 'next_turn') {
    throw new RequestValidationError('delivery must be steer_or_queue or next_turn')
  }
  if (!Array.isArray(body.input) || body.input.length === 0) {
    throw new RequestValidationError('input must be a non-empty array')
  }
  const input = body.input.map(parseNewItem)
  if (input.some((item) => item.kind !== 'user_message'
    || (item.visibility !== undefined && item.visibility !== 'portable')
    || (item.provider !== undefined && item.provider !== null)
    || (item.nativeId !== undefined && item.nativeId !== null))) {
    throw new RequestValidationError('follow-up input must contain only portable provider-neutral user messages')
  }
  return {
    threadId,
    clientRequestId: requiredNonEmptyString(body, 'clientRequestId'),
    expectedTurnId: requiredNonEmptyString(body, 'expectedTurnId'),
    delivery: body.delivery,
    input,
  }
}

function parseReconcileToolInput(turnId: string, value: unknown): ReconcileToolInput {
  const body = bodyRecord(value)
  requireOnlyKeys(body, ['callId', 'resolution', 'note'])
  const resolution = requiredNonEmptyString(body, 'resolution')
  if (resolution !== 'succeeded' && resolution !== 'failed' && resolution !== 'unknown_acknowledged') {
    throw new RequestValidationError('resolution must be succeeded, failed, or unknown_acknowledged')
  }
  if (body.note !== undefined && typeof body.note !== 'string') {
    throw new RequestValidationError('note must be a string')
  }
  if (typeof body.note === 'string' && [...body.note].length > 500) {
    throw new RequestValidationError('note must not exceed 500 Unicode characters')
  }
  return {
    turnId,
    callId: requiredNonEmptyString(body, 'callId'),
    resolution,
    ...(typeof body.note === 'string' ? { note: body.note } : {}),
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

function parseRequiredQueryInteger(value: unknown, label: string): number {
  if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value)) {
    throw new RequestValidationError(`${label} must be a positive integer`)
  }
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed)) throw new RequestValidationError(`${label} must be a safe positive integer`)
  return parsed
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
  const nativeImportCsrfToken = randomBytes(32).toString('base64url')

  router.closeStreams = () => {
    for (const [response, cleanup] of [...streams]) {
      response.end()
      cleanup()
    }
  }

  router.use('/native-import', (req, _res, next) => {
    try {
      if (req.method === 'GET') nativeImportPrincipal(req, false)
      else requireCsrf(req, nativeImportCsrfToken)
      next()
    } catch (error) { next(error) }
  })
  router.use('/native-import', express.json({ limit: '8mb' }))
  router.use(express.json({ limit: '2mb' }))

  router.post(
    '/sessions',
    route((req, res) => {
      const session = service.createSession(parseCreateSessionInput(req.body))
      res.status(201).json(session)
    }),
  )

  router.put('/sessions/:sessionId/first-turn', route(async (req, res) => {
    const result = await service.startSession(parseStartSessionInput(
      pathParam(req, 'sessionId'),
      req.body,
    ))
    res.location(`/baton/v1/sessions/${encodeURIComponent(result.session.id)}`)
    res.status(result.duplicate ? 200 : 202).json(result)
  }))

  router.get('/sessions', route((req, res) => {
    const value = req.query.scope
    const scope = value === undefined ? 'active' : value
    if (scope !== 'active' && scope !== 'trash' && scope !== 'all') {
      throw new RequestValidationError('scope must be active, trash, or all')
    }
    res.json({ sessions: service.listSessions(scope) })
  }))

  router.delete('/sessions/:sessionId', route((req, res) => {
    res.json(service.archiveSession(pathParam(req, 'sessionId')))
  }))

  router.post('/sessions/:sessionId/restore', route((req, res) => {
    res.json(service.restoreSession(pathParam(req, 'sessionId')))
  }))

  router.put('/sessions/:sessionId/workspace', route((req, res) => {
    const body = bodyRecord(req.body)
    requireOnlyKeys(body, ['cwd', 'expectedRevision'])
    res.json(service.connectWorkspace({
      sessionId: pathParam(req, 'sessionId'),
      cwd: requiredNonEmptyString(body, 'cwd'),
      expectedRevision: requiredNonNegativeInteger(body, 'expectedRevision'),
    }))
  }))

  router.delete('/sessions/:sessionId/workspace', route((req, res) => {
    const body = bodyRecord(req.body)
    requireOnlyKeys(body, ['expectedRevision'])
    res.json(service.disconnectWorkspace(
      pathParam(req, 'sessionId'),
      requiredNonNegativeInteger(body, 'expectedRevision'),
    ))
  }))

  router.get(
    '/native-import/csrf',
    route((req, res) => {
      nativeImportPrincipal(req, false)
      if (!options.nativeImport) {
        res.status(503).json({ code: 'native_import_unavailable', error: 'native import is unavailable' })
        return
      }
      res.setHeader('cache-control', 'no-store')
      res.json({ token: nativeImportCsrfToken })
    }),
  )

  router.post(
    '/native-import/preview',
    route(async (req, res) => {
      const principal = requireCsrf(req, nativeImportCsrfToken)
      if (!options.nativeImport) {
        res.status(503).json({ code: 'native_import_unavailable', error: 'native import is unavailable' })
        return
      }
      const body = bodyRecord(req.body)
      requireOnlyKeys(body, ['sources', 'codex'])
      let sources: NativeSourceClient[] | undefined
      if (body.sources !== undefined) {
        if (!Array.isArray(body.sources) || body.sources.length === 0 || body.sources.length > 3 || body.sources.some((source) =>
          source !== 'codex_local' && source !== 'claude_desktop' && source !== 'claude_code')) {
          throw new RequestValidationError('sources contains an unsupported native source')
        }
        sources = body.sources as NativeSourceClient[]
      }
      let codex: CodexNativeScanFilter | undefined
      if (body.codex !== undefined) {
        const value = bodyRecord(body.codex)
        requireOnlyKeys(value, ['origins', 'includeSubagents', 'includeArchived'])
        if (value.origins !== undefined && (!Array.isArray(value.origins) || value.origins.length === 0
          || value.origins.length > 4 || value.origins.some((origin) =>
            origin !== 'cli' && origin !== 'ide_app' && origin !== 'exec' && origin !== 'other'))) {
          throw new RequestValidationError('codex.origins contains an unsupported origin')
        }
        if ((value.includeSubagents !== undefined && typeof value.includeSubagents !== 'boolean')
          || (value.includeArchived !== undefined && typeof value.includeArchived !== 'boolean')) {
          throw new RequestValidationError('codex filter flags must be boolean')
        }
        codex = value as CodexNativeScanFilter
      }
      const preview = await options.nativeImport.preview({ sources, codex }, principal)
      res.json({
        token: preview.token,
        expiresAt: preview.expiresAt,
        summary: preview.summary,
        warnings: preview.warnings.length > 0 ? ['일부 원본을 읽지 못했습니다. 세부 정보는 서버 로그를 확인하세요.'] : [],
        candidates: preview.candidates.map((candidate) => ({
          id: candidate.candidateId,
          sourceClient: candidate.sourceClient,
          provider: candidate.provider,
          sourceAlias: safeDisplayAlias(candidate.sourceAlias),
          aliasSource: candidate.aliasSource,
          titleSource: candidate.titleSource ?? null,
          projectAlias: safeDisplayAlias(candidate.projectAlias),
          createdAt: candidate.createdAt,
          updatedAt: candidate.updatedAt,
          nativeOrigin: candidate.nativeOrigin ?? null,
          nativeArchived: candidate.nativeArchived ?? false,
          portableItemCount: candidate.portableItemCount,
          skippedItemCount: candidate.skippedItemCount,
          messageCount: candidate.portableItemCount + candidate.skippedItemCount,
          status: candidate.status,
          warningCount: candidate.warnings.length,
          analysisPending: !candidate.materialized,
        })),
      })
    }),
  )

  router.post(
    '/native-import/commit',
    route(async (req, res) => {
      const principal = requireCsrf(req, nativeImportCsrfToken)
      if (!options.nativeImport) {
        res.status(503).json({ code: 'native_import_unavailable', error: 'native import is unavailable' })
        return
      }
      const body = bodyRecord(req.body)
      requireOnlyKeys(body, ['token', 'candidateIds'])
      if (!Array.isArray(body.candidateIds) || body.candidateIds.length === 0 || body.candidateIds.length > 10_000
        || body.candidateIds.some((id) => typeof id !== 'string' || !id || id.length > 256)) {
        throw new RequestValidationError('candidateIds must be a non-empty string array')
      }
      const token = requiredNonEmptyString(body, 'token')
      if (token.length > 7_000_000) throw new RequestValidationError('token is too large')
      const receipt = await options.nativeImport.commit({
        token,
        candidateIds: body.candidateIds as string[],
      }, principal)
      res.json(receipt)
    }),
  )

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

  router.get('/threads/:threadId/goal', (req, res) => {
    const threadId = pathParam(req, 'threadId')
    if (!service.getSnapshot(threadId)) {
      res.status(404).json({ code: 'not_found', error: 'thread not found' })
      return
    }
    res.json({ goal: service.getGoal(threadId) })
  })

  router.post('/threads/:threadId/goal', route(async (req, res) => {
    const goal = await service.createGoal(parseCreateGoalInput(pathParam(req, 'threadId'), req.body))
    res.status(201).json(goal)
  }))

  router.patch('/goals/:goalId', route(async (req, res) => {
    res.json(await service.editGoal(parseEditGoalInput(pathParam(req, 'goalId'), req.body)))
  }))

  router.post('/goals/:goalId/status', route(async (req, res) => {
    const body = bodyRecord(req.body)
    requireOnlyKeys(body, ['expectedRevision', 'status', 'resetLimitCounters'])
    if (body.status !== 'active' && body.status !== 'paused') {
      throw new RequestValidationError('status must be active or paused')
    }
    if (body.resetLimitCounters !== undefined && typeof body.resetLimitCounters !== 'boolean') {
      throw new RequestValidationError('resetLimitCounters must be a boolean')
    }
    res.json(await service.updateGoalStatus({
      goalId: pathParam(req, 'goalId'),
      expectedRevision: requiredPositiveInteger(body, 'expectedRevision'),
      status: body.status,
      ...(body.resetLimitCounters === undefined ? {} : { resetLimitCounters: body.resetLimitCounters }),
    }))
  }))

  router.delete('/goals/:goalId', route(async (req, res) => {
    const expectedRevision = parseRequiredQueryInteger(req.query.expectedRevision, 'expectedRevision')
    await service.clearGoal({ goalId: pathParam(req, 'goalId'), expectedRevision })
    res.status(204).end()
  }))

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

  router.post('/threads/:threadId/follow-ups', route(async (req, res) => {
    const followUp = await service.submitFollowUp(parseFollowUpInput(pathParam(req, 'threadId'), req.body))
    res.status(202).json(followUp)
  }))

  router.delete('/follow-ups/:followUpId', route((req, res) => {
    const body = bodyRecord(req.body)
    requireOnlyKeys(body, ['expectedRevision'])
    res.json(service.cancelFollowUp(
      pathParam(req, 'followUpId'),
      requiredPositiveInteger(body, 'expectedRevision'),
    ))
  }))

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
    '/turns/:turnId/reconcile-tool',
    route((req, res) => {
      const result = service.reconcileTool(parseReconcileToolInput(pathParam(req, 'turnId'), req.body))
      res.status(result.duplicate ? 200 : 201).json(result)
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
    if (error instanceof WorkspaceRootError) {
      res.status(error.code === 'workspace_disconnected' ? 409 : 400).json({ code: error.code, error: error.message })
      return
    }
    if (error instanceof ProviderReadinessError) {
      res.status(503).json({ code: error.code, error: error.message })
      return
    }
    if (error instanceof FollowUpStoreError) {
      res.status(error.code === 'follow_up_lease_lost' ? 409 : 400).json({ code: error.code, error: error.message })
      return
    }
    if (error instanceof NativeImportSecurityError) {
      res.status(403).json({ code: 'native_import_forbidden', error: error.message })
      return
    }
    if (error instanceof NativeImportError) {
      const status = error.code === 'stale_preview' || error.code === 'commit_in_progress' ? 409 : 400
      res.status(status).json({ code: error.code, error: error.message })
      return
    }
    if (error instanceof SyntaxError && 'body' in error) {
      res.status(400).json({ code: 'invalid_json', error: 'request body is not valid JSON' })
      return
    }
    if (isRecord(error) && error.type === 'entity.too.large') {
      res.status(413).json({ code: 'request_too_large', error: 'request body is too large' })
      return
    }
    if (error instanceof SessionStoreError) {
      const statusByCode = {
        not_found: 404,
        revision_conflict: 409,
        turn_not_running: 409,
        invalid_fork: 400,
        duplicate_request: 409,
        initial_session_conflict: 409,
        session_busy: 409,
        session_archived: 409,
        invalid_reconciliation: 409,
        reconciliation_conflict: 409,
      } as const
      res.status(statusByCode[error.code]).json({ code: error.code, error: error.message })
      return
    }
    if (error instanceof GoalStoreError) {
      const conflict = error.code === 'stale_goal_revision'
        || error.code === 'invalid_goal_transition'
        || error.code === 'goal_lease_lost'
        || error.code === 'unfinished_goal_exists'
      const status = error.code === 'goal_not_found' ? 404 : conflict ? 409 : 400
      res.status(status).json({ code: error.code, error: error.message })
      return
    }
    res.status(500).json({ code: 'internal_error', error: 'internal server error' })
  })

  return router
}
