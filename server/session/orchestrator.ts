import { createHash } from 'node:crypto'
import { AdapterRegistry } from './adapter-registry.ts'
import type { ProviderBindingPatch, ProviderTurnExecution } from './adapter.ts'
import { ContextInputTooLargeError, type CanonicalContextRuntimeContract } from './canonical-context-runtime.ts'
import { DEFAULT_AGENT_LOOP_LIMITS } from './domain.ts'
import type {
  AgentToolDefinition,
  AgentToolInvocation,
  AgentToolResult,
  BeginSessionResult,
  BeginTurnResult,
  CanonicalGoal,
  GoalCompletionProposal,
  GoalEvidenceBundle,
  GoalFrozenEvidence,
  GoalVerificationDecision,
  CanonicalFollowUp,
  CanonicalExecution,
  CanonicalItem,
  NewCanonicalItem,
  CanonicalSession,
  CanonicalStreamEvent,
  CanonicalThread,
  CanonicalTurn,
  CreateSessionInput,
  FinishTurnInput,
  GlobalPermissionSettings,
  PermissionProfile,
  SessionId,
  ThreadId,
  ThreadSnapshot,
  TurnId,
} from './domain.ts'
import { ConversationEventHub } from './event-hub.ts'
import { GoalRuntime, type GoalContinuationRequest } from './goal-runtime.ts'
import { goalContinuationPrompt } from './goal-prompts.ts'
import { ProviderReadinessError } from './service.ts'
import type { ConversationService, StartSessionInput, StartTurnInput, SubmitFollowUpInput, UserGoalStatusInput, WorkspaceMutationInput } from './service.ts'
import { normalizeInstructionSnapshot } from './instruction-snapshot.ts'
import type {
  ClearGoalInput,
  CreateGoalInput,
  EditGoalInput,
  ForkThreadInput,
  GoalCasResult,
  GoalTurnContext,
  ReconcileToolInput,
  ReconcileToolResult,
  SessionListScope,
  SessionStore,
  BeginTurnFromFollowUpInput,
} from './store.ts'
import { GoalStoreError, SessionStoreError } from './store.ts'
import {
  GOAL_TOOL_DEFINITIONS,
  ToolCoordinator,
  type GoalCompletionProposalIntent,
  type ToolRuntime,
} from './tool-coordinator.ts'
import { ProviderGoalVerifier, type GoalVerifier } from './goal-verifier.ts'
import { goalEvidenceHash } from './goal-evidence.ts'
import {
  FullAccessCommandRunner,
  HostCommandToolRuntime,
  LocalWorkspaceToolRuntime,
} from './tools/local-workspace-runtime.ts'
import { CompositeToolRuntime, SkillResourceToolRuntime } from './tools/skill-resource-runtime.ts'
import type { LocalImageArtifactStore } from './image-artifacts.ts'
import { hasPortableUserContent, imageAttachments } from './image-artifacts.ts'
import { assertWorkspaceRoot, resolveWorkspaceRoot } from './workspace-root.ts'

interface ActiveTurn {
  controller: AbortController
  completion: Promise<void>
  turn: CanonicalTurn
  latestTokensUsed: number
  execution: ProviderTurnExecution | null
  pump: Promise<void>
  closing: boolean
}

const NO_WORKSPACE_RUNTIME: ToolRuntime = Object.freeze({
  definitions: Object.freeze([]),
  async execute(_invocation: AgentToolInvocation): Promise<AgentToolResult> {
    return {
      success: false,
      content: null,
      error: { code: 'tool_unavailable', message: 'This session has no verified workspace', retryable: false },
    }
  },
})

export class TurnOrchestrator implements ConversationService {
  private readonly store: SessionStore
  private readonly adapters: AdapterRegistry
  private readonly events: ConversationEventHub
  private readonly cancellationTimeoutMs: number
  private readonly contextRuntime: CanonicalContextRuntimeContract | null
  private readonly hostRuntime: { artifacts: LocalImageArtifactStore } | null
  private readonly goalRuntime: GoalRuntime
  private readonly goalVerifier: GoalVerifier
  private readonly goalVerificationRetryMs: number
  private readonly goalVerifications = new Map<string, Promise<void>>()
  private readonly goalVerificationRetryTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly goalVerifierOwner = `goal-verifier-${process.pid}-${Date.now()}`
  private readonly active = new Map<TurnId, ActiveTurn>()
  private closed = false
  private readonly followUpOwner = `follow-up-${process.pid}-${Date.now()}`
  private readonly followUpRetryCounts = new Map<ThreadId, number>()
  private readonly followUpRetryTimers = new Map<ThreadId, ReturnType<typeof setTimeout>>()
  private readonly followUpDrains = new Map<ThreadId, Promise<boolean>>()
  private readonly shutdownController = new AbortController()

  constructor(
    store: SessionStore,
    adapters: AdapterRegistry,
    events: ConversationEventHub,
    cancellationTimeoutMs = 10_000,
    contextRuntime: CanonicalContextRuntimeContract | null = null,
    hostRuntime: { artifacts: LocalImageArtifactStore } | null = null,
    goalVerifier: GoalVerifier = new ProviderGoalVerifier(),
    goalVerificationRetryMs = 10_000,
  ) {
    this.store = store
    this.adapters = adapters
    this.events = events
    this.cancellationTimeoutMs = cancellationTimeoutMs
    this.contextRuntime = contextRuntime
    this.hostRuntime = hostRuntime
    this.goalVerifier = goalVerifier
    if (!Number.isSafeInteger(goalVerificationRetryMs) || goalVerificationRetryMs < 1) {
      throw new TypeError('Goal verification retry interval must be a positive integer')
    }
    this.goalVerificationRetryMs = goalVerificationRetryMs
    this.goalRuntime = new GoalRuntime(store, {
      ownerId: `baton-${process.pid}-${Date.now()}`,
      launchContinuation: (request) => this.launchGoalContinuation(request),
      onGoalChanged: (goal) => this.events.publish(goal.threadId),
    })
  }

  createSession(input: CreateSessionInput): CanonicalSession {
    const session = this.store.createSession({
      ...input,
      cwd: input.cwd == null ? null : resolveWorkspaceRoot(input.cwd),
    })
    this.events.publish(session.activeThreadId)
    return session
  }

  async startSession(input: StartSessionInput): Promise<BeginSessionResult> {
    if (this.closed) throw new Error('Canonical conversation runtime is closed')
    const normalized = normalizeStartSessionInput(input)
    this.validateImageInputs(normalized.input)
    const requestHash = hashSessionStartRequest(normalized)
    const replay = this.store.getInitialSessionResult({
      sessionId: normalized.sessionId,
      clientRequestId: normalized.clientRequestId,
      requestHash,
    })
    if (replay) return replay

    const workspaceCwd = normalized.cwd === null ? null : resolveWorkspaceRoot(normalized.cwd)
    let ready: Awaited<ReturnType<AdapterRegistry['getReady']>>
    try {
      ready = await this.adapters.getReady(normalized.provider)
    } catch (error) {
      throw new ProviderReadinessError(normalized.provider, { cause: error })
    }
    const permissionProfile = this.store.getPermissionSettings().defaultProfile
    const workspaceRuntime = this.sessionToolRuntime(workspaceCwd, permissionProfile, ready.adapter)
    const toolDefinitions: readonly AgentToolDefinition[] = [
      ...workspaceRuntime.definitions,
      ...GOAL_TOOL_DEFINITIONS.filter((tool) => tool.name !== 'create_goal'),
    ]
    this.contextRuntime?.assertUpcomingInputFits({
      ready,
      provider: normalized.provider,
      model: normalized.model,
      instructionSnapshot: normalized.instructionSnapshot,
      upcomingInput: normalized.input,
      toolDefinitions,
    })
    const result = this.store.beginSession({
      sessionId: normalized.sessionId,
      clientRequestId: normalized.clientRequestId,
      requestHash,
      cwd: workspaceCwd,
      instructionSnapshot: normalized.instructionSnapshot,
      provider: normalized.provider,
      model: normalized.model,
      effort: normalized.effort,
      input: normalized.input,
      adapterVersion: ready.handshake.adapterVersion,
      policySnapshot: {
        delegationMode: ready.handshake.capabilities.nativeChildExecution === 'exposed'
          ? 'provider-native'
          : 'disabled',
        allowedTools: toolDefinitions.map((tool) => tool.name),
        approvalPolicy: 'never',
        cwd: workspaceCwd,
        maxDepth: 0,
        capabilityGrant: null,
        permissionProfile,
        permissionProfileSource: 'global',
      },
      budget: {
        ...(normalized.effort ? { effort: normalized.effort } : {}),
        agentLoopLimits: DEFAULT_AGENT_LOOP_LIMITS,
        goalAutomatic: false,
      },
      leaseExpiresAt: null,
    })
    this.events.publish(result.thread.id)
    if (result.duplicate) return result

    const turnInput: StartTurnInput = {
      threadId: result.thread.id,
      provider: normalized.provider,
      model: normalized.model,
      effort: normalized.effort,
      clientRequestId: normalized.clientRequestId,
      expectedRevision: 0,
      input: normalized.input,
    }
    this.launchPersistedTurnSafely(result, turnInput, ready, workspaceRuntime)
    return result
  }

  listSessions(scope: SessionListScope = 'active'): CanonicalSession[] { return this.store.listSessions(scope) }
  getSession(sessionId: SessionId): CanonicalSession | null { return this.store.getSession(sessionId) }
  getPermissionSettings(): GlobalPermissionSettings { return this.store.getPermissionSettings() }
  updateDefaultPermissionProfile(profile: PermissionProfile): GlobalPermissionSettings {
    return this.store.updateDefaultPermissionProfile(profile)
  }
  updateSessionPermissionProfile(sessionId: SessionId, profile: PermissionProfile | null): CanonicalSession {
    const session = this.store.updateSessionPermissionProfile({ sessionId, profile })
    this.events.publish(session.activeThreadId)
    return session
  }
  archiveSession(sessionId: SessionId): CanonicalSession { return this.store.archiveSession(sessionId) }
  restoreSession(sessionId: SessionId): CanonicalSession { return this.store.restoreSession(sessionId) }
  connectWorkspace(input: WorkspaceMutationInput): CanonicalSession {
    const session = this.store.updateWorkspace({
      sessionId: input.sessionId,
      expectedThreadRevision: input.expectedRevision,
      cwd: resolveWorkspaceRoot(input.cwd),
    })
    this.events.publish(session.activeThreadId)
    return session
  }

  disconnectWorkspace(sessionId: SessionId, expectedRevision: number): CanonicalSession {
    const session = this.store.updateWorkspace({
      sessionId,
      expectedThreadRevision: expectedRevision,
      cwd: null,
    })
    this.events.publish(session.activeThreadId)
    return session
  }
  getSnapshot(threadId: ThreadId): ThreadSnapshot | null { return this.store.getSnapshot(threadId) }

  forkThread(input: ForkThreadInput): CanonicalThread {
    const thread = this.store.forkThread(input)
    this.events.publish(thread.id)
    return thread
  }

  listItems(threadId: ThreadId, afterSequence = 0): CanonicalItem[] {
    return this.store.listItems(threadId, afterSequence)
  }

  listEvents(threadId: ThreadId, afterSequence = 0): CanonicalStreamEvent[] {
    return this.store.listEvents(threadId, afterSequence)
  }

  getGoal(threadId: ThreadId): CanonicalGoal | null { return this.store.getGoal(threadId) }
  getGoalVerificationHistory(goalId: string) { return this.store.getGoalVerificationHistory(goalId) }

  async createGoal(input: CreateGoalInput): Promise<CanonicalGoal> {
    const previous = this.store.getGoal(input.threadId)
    if (previous) this.flushActiveGoalTurns(previous.id)
    const goal = this.store.createGoal(input)
    this.events.publish(goal.threadId)
    if (previous && previous.id !== goal.id) await this.interruptGoalTurns(previous.id)
    void this.goalRuntime.notifyThreadIdle(goal.threadId)
    return goal
  }

  async editGoal(input: EditGoalInput): Promise<CanonicalGoal> {
    this.flushActiveGoalTurns(input.goalId)
    const goal = this.store.editGoal(input)
    this.events.publish(goal.threadId)
    await this.interruptGoalTurns(goal.id)
    if (goal.status === 'active') void this.goalRuntime.notifyThreadIdle(goal.threadId)
    return goal
  }

  async updateGoalStatus(input: UserGoalStatusInput): Promise<GoalCasResult> {
    const before = this.store.getGoalById(input.goalId)
    this.flushActiveGoalTurns(input.goalId)
    const result = this.store.updateGoalStatus({
      ...input,
      ...(input.status === 'paused' ? {
        reason: { code: 'user_paused', source: 'user' as const, message: null, at: new Date().toISOString() },
      } : {}),
    })
    const threadId = result.goal?.threadId ?? before?.threadId
    if (threadId) {
      this.events.publish(threadId)
      if (result.status === 'applied' && result.goal?.status === 'active') {
        void this.goalRuntime.notifyThreadIdle(threadId)
      } else if (result.status === 'applied' && result.goal?.status === 'paused') {
        const pausedGoalId = result.goal.id
        await this.goalRuntime.interruptAfterPause(
          pausedGoalId,
          () => this.interruptGoalTurns(pausedGoalId),
        )
      }
    }
    return result
  }

  async clearGoal(input: ClearGoalInput): Promise<void> {
    const goal = this.store.getGoalById(input.goalId)
    this.flushActiveGoalTurns(input.goalId)
    this.store.clearGoal(input)
    if (goal) {
      this.events.publish(goal.threadId)
      await this.interruptGoalTurns(goal.id)
    }
  }

  subscribe(threadId: ThreadId, listener: () => void): () => void {
    return this.events.subscribe(threadId, listener)
  }

  async startTurn(input: StartTurnInput): Promise<BeginTurnResult> {
    return this.startTurnInternal(input, null, false)
  }

  async submitFollowUp(input: SubmitFollowUpInput): Promise<{ followUp: CanonicalFollowUp; duplicate: boolean }> {
    const requestHash = createHash('sha256').update(stableJson({
      expectedTurnId: input.expectedTurnId, delivery: input.delivery, input: input.input,
    })).digest('hex')
    const existing = this.store.getFollowUpByClientRequest(input.threadId, input.clientRequestId)
    if (existing) {
      const replay = this.store.enqueueFollowUp({
        threadId: input.threadId, clientRequestId: input.clientRequestId, requestHash,
        delivery: input.delivery, targetTurnId: input.delivery === 'steer_or_queue' ? input.expectedTurnId : null,
        scope: existing.scope, input: input.input,
      })
      return replay
    }
    const turn = this.store.getTurn(input.expectedTurnId)
    if (!turn || turn.threadId !== input.threadId || isTerminal(turn.status)) {
      throw new SessionStoreError('turn_not_running', 'Expected turn is not active in this thread')
    }
    const goal = this.store.getGoal(input.threadId)
    const goalMatchesTarget = goal?.status === 'active'
      ? turn.goalId === goal.id && turn.goalRevision === goal.revision
      : turn.goalId === null && turn.goalRevision === null
    const targetTurnId = input.delivery === 'steer_or_queue' && goalMatchesTarget
      ? input.expectedTurnId
      : null
    const result = this.store.enqueueFollowUp({
      threadId: input.threadId,
      clientRequestId: input.clientRequestId,
      requestHash,
      delivery: input.delivery,
      targetTurnId,
      scope: goal?.status === 'active'
        ? { kind: 'goal', goalId: goal.id, revision: goal.revision }
        : { kind: 'conversation' },
      input: input.input,
    })
    this.events.publish(input.threadId)
    const active = this.active.get(input.expectedTurnId)
    if (active) this.pumpActiveFollowUps(active)
    return result
  }

  cancelFollowUp(followUpId: string, expectedRevision: number): CanonicalFollowUp {
    const followUp = this.store.cancelFollowUp(followUpId, expectedRevision)
    this.events.publish(followUp.threadId)
    return followUp
  }

  private pumpActiveFollowUps(active: ActiveTurn): void {
    active.pump = active.pump.then(async () => {
      while (!active.closing && active.execution) {
        const claimed = this.store.claimFollowUp({
          threadId: active.turn.threadId,
          ownerId: this.followUpOwner,
          purpose: 'steer',
          targetTurnId: active.turn.id,
        })
        if (!claimed) return
        try {
          const outcome = active.execution.steer
            ? await active.execution.steer({
                followUpId: claimed.id,
                text: followUpText(claimed),
                expectedTurnId: active.turn.id,
              })
            : { status: 'unsupported' as const }
          if (outcome.status === 'accepted') {
            try {
              const consumed = this.store.consumeFollowUp({
                followUpId: claimed.id, ownerId: this.followUpOwner, turnId: active.turn.id,
              })
              if (consumed.status !== 'consumed') {
                this.store.markFollowUpDeliveryUnknown(claimed.id, this.followUpOwner)
                active.controller.abort(new Error('Accepted follow-up could not be committed canonically'))
                return
              }
            } catch (error) {
              this.store.markFollowUpDeliveryUnknown(claimed.id, this.followUpOwner)
              active.controller.abort(error)
              return
            }
          } else {
            this.store.requeueFollowUp({ followUpId: claimed.id, ownerId: this.followUpOwner, targetTurnId: null })
          }
        } catch (error) {
          try { this.store.markFollowUpDeliveryUnknown(claimed.id, this.followUpOwner) } catch { /* preserve first failure */ }
          active.controller.abort(error)
          return
        } finally {
          this.events.publish(active.turn.threadId)
        }
      }
    })
    void active.pump.catch(() => undefined)
  }

  private drainNextFollowUp(threadId: ThreadId): Promise<boolean> {
    if (this.closed) return Promise.resolve(false)
    const existing = this.followUpDrains.get(threadId)
    if (existing) return existing
    const drain = this.runNextFollowUpDrain(threadId)
    this.followUpDrains.set(threadId, drain)
    void drain.finally(() => {
      if (this.followUpDrains.get(threadId) === drain) this.followUpDrains.delete(threadId)
    }).catch(() => undefined)
    return drain
  }

  private async runNextFollowUpDrain(threadId: ThreadId): Promise<boolean> {
    const claimed = this.store.claimFollowUp({
      threadId, ownerId: this.followUpOwner, purpose: 'next_turn',
    })
    if (!claimed) { this.clearFollowUpRetry(threadId); return false }
    try {
      const snapshot = this.store.getSnapshot(threadId)
      const prior = snapshot?.turns.at(-1)
      if (!snapshot || !prior) throw new Error('Follow-up route has no prior canonical turn')
      const ready = await resolveUnlessAborted(
        this.adapters.getReady(prior.provider),
        this.shutdownController.signal,
      )
      if (ready === null || this.closed) {
        try { this.store.requeueFollowUp({ followUpId: claimed.id, ownerId: this.followUpOwner, targetTurnId: null }) } catch { /* state may be stale */ }
        this.events.publish(threadId)
        return false
      }
      const workspaceCwd = snapshot.session.cwd ? assertWorkspaceRoot(snapshot.session.cwd) : null
      const workspaceRuntime = this.sessionToolRuntime(
        workspaceCwd,
        snapshot.session.permissions.effectiveProfile,
        ready.adapter,
      )
      const toolDefinitions = [
        ...workspaceRuntime.definitions,
        ...GOAL_TOOL_DEFINITIONS.filter((tool) => tool.name !== 'create_goal'),
      ]
      const result = this.store.beginTurnFromFollowUp({
        followUpId: claimed.id,
        ownerId: this.followUpOwner,
        threadId,
        provider: prior.provider,
        model: prior.model,
        effort: prior.effort,
        adapterVersion: ready.handshake.adapterVersion,
        policySnapshot: {
          delegationMode: ready.handshake.capabilities.nativeChildExecution === 'exposed'
            ? 'provider-native'
            : 'disabled',
          allowedTools: toolDefinitions.map((tool) => tool.name),
          approvalPolicy: 'never', cwd: workspaceCwd, maxDepth: 0,
          capabilityGrant: null,
          permissionProfile: snapshot.session.permissions.effectiveProfile,
          permissionProfileSource: snapshot.session.permissions.source,
        },
        budget: { ...(prior.effort ? { effort: prior.effort } : {}), agentLoopLimits: DEFAULT_AGENT_LOOP_LIMITS, goalAutomatic: false },
      } as BeginTurnFromFollowUpInput)
      const turnInput: StartTurnInput = {
        threadId, provider: prior.provider, model: prior.model, effort: prior.effort,
        clientRequestId: `follow-up:${claimed.id}`,
        expectedRevision: snapshot.thread.revision,
        input: claimed.input,
      }
      this.events.publish(threadId)
      this.launchPersistedTurn(result, turnInput, ready, workspaceRuntime, false)
      this.clearFollowUpRetry(threadId)
      return true
    } catch {
      try { this.store.requeueFollowUp({ followUpId: claimed.id, ownerId: this.followUpOwner, targetTurnId: null }) } catch { /* state may be stale */ }
      this.events.publish(threadId)
      const attempts = (this.followUpRetryCounts.get(threadId) ?? 0) + 1
      this.followUpRetryCounts.set(threadId, attempts)
      if (!this.closed && attempts < 3) {
        this.clearFollowUpRetryTimer(threadId)
        const timer = setTimeout(() => {
          this.followUpRetryTimers.delete(threadId)
          if (this.closed) return
          void this.drainNextFollowUp(threadId).catch(() => undefined)
        }, attempts * 250)
        this.followUpRetryTimers.set(threadId, timer)
        timer.unref?.()
      }
      return false
    }
  }

  private clearFollowUpRetryTimer(threadId: ThreadId): void {
    const timer = this.followUpRetryTimers.get(threadId)
    if (timer) clearTimeout(timer)
    this.followUpRetryTimers.delete(threadId)
  }

  private clearFollowUpRetry(threadId: ThreadId): void {
    this.clearFollowUpRetryTimer(threadId)
    this.followUpRetryCounts.delete(threadId)
  }

  private hasPendingUserIntent(threadId: ThreadId): boolean {
    return this.store.listFollowUps(threadId).some((followUp) =>
      followUp.status === 'queued' || followUp.status === 'dispatching')
  }

  private async startTurnInternal(
    input: StartTurnInput,
    goalContext: GoalTurnContext | null,
    automatic: boolean,
    startSignal?: AbortSignal,
  ): Promise<BeginTurnResult> {
    if (this.closed) throw new Error('Canonical conversation runtime is closed')
    validateTurnInput(input, automatic)
    this.validateImageInputs(input.input)

    const ready = await this.adapters.getReady(input.provider)
    if (startSignal?.aborted) throw startSignal.reason ?? new Error('Goal continuation start was cancelled')
    const beforeTurn = this.store.getSnapshot(input.threadId)
    const workspaceCwd = beforeTurn?.session.cwd
      ? assertWorkspaceRoot(beforeTurn.session.cwd)
      : null
    const permissionProfile = beforeTurn?.session.permissions.effectiveProfile
      ?? this.store.getPermissionSettings().defaultProfile
    const permissionProfileSource = beforeTurn?.session.permissions.source ?? 'global'
    const workspaceRuntime = this.sessionToolRuntime(
      workspaceCwd,
      permissionProfile,
      ready.adapter,
    )
    const goalToolDefinitions = GOAL_TOOL_DEFINITIONS.filter((tool) => tool.name !== 'create_goal')
    const toolDefinitions: readonly AgentToolDefinition[] = [
      ...workspaceRuntime.definitions,
      ...goalToolDefinitions,
    ]
    const compaction = beforeTurn && beforeTurn.thread.revision === input.expectedRevision && this.contextRuntime
      ? await this.contextRuntime.compactBeforeTurn({
          snapshot: beforeTurn,
          ready,
          provider: input.provider,
          model: input.model,
          effort: input.effort ?? null,
          upcomingInput: input.input,
          toolDefinitions,
        })
      : null
    if (startSignal?.aborted) throw startSignal.reason ?? new Error('Goal continuation start was cancelled')
    // Close imported (turnless) orphan tool calls before this turn's items are
    // appended, so on a freshly imported session the synthetic results stay
    // inside the leading turnless block and the transcript remains compactable.
    this.store.repairOrphanImportedToolCalls(input.threadId)
    const result = this.store.beginTurn({
      threadId: input.threadId,
      provider: input.provider,
      model: input.model,
      effort: input.effort ?? null,
      clientRequestId: input.clientRequestId,
      requestHash: hashTurnRequest(input),
      expectedRevision: input.expectedRevision,
      input: input.input,
      adapterVersion: ready.handshake.adapterVersion,
      policySnapshot: {
        delegationMode: ready.handshake.capabilities.nativeChildExecution === 'exposed'
          ? 'provider-native'
          : 'disabled',
        allowedTools: toolDefinitions.map((tool) => tool.name),
        approvalPolicy: 'never',
        cwd: workspaceCwd,
        maxDepth: 0,
        capabilityGrant: null,
        permissionProfile,
        permissionProfileSource,
      },
      budget: {
        ...(input.effort ? { effort: input.effort } : {}),
        agentLoopLimits: DEFAULT_AGENT_LOOP_LIMITS,
        goalAutomatic: automatic,
        ...(compaction ? {
          contextCompaction: {
            viewKey: compaction.viewKey,
            reason: compaction.reason,
            artifactId: compaction.artifact?.id ?? null,
            estimatedTokensBefore: compaction.estimatedTokensBefore,
            estimatedTokensAfter: compaction.estimatedTokensAfter,
            triggerTokens: compaction.triggerTokens,
          },
        } : {}),
      },
      leaseExpiresAt: null,
      goalContext,
    })
    this.events.publish(input.threadId)
    if (result.duplicate) return result

    this.launchPersistedTurn(result, input, ready, workspaceRuntime, automatic)
    return result
  }

  private launchPersistedTurn(
    result: BeginTurnResult,
    input: StartTurnInput,
    ready: Awaited<ReturnType<AdapterRegistry['getReady']>>,
    workspaceRuntime: ToolRuntime,
    automatic: boolean,
  ): void {
    const controller = new AbortController()
    const activeTurn: ActiveTurn = {
      controller,
      completion: Promise.resolve(),
      turn: result.turn,
      latestTokensUsed: 0,
      execution: null,
      pump: Promise.resolve(),
      closing: false,
    }
    const coordinator = new ToolCoordinator({
      store: this.store,
      turnId: result.turn.id,
      threadId: input.threadId,
      provider: input.provider,
      model: input.model,
      effort: input.effort ?? null,
      workspaceRuntime,
      allowWorkspaceCommands: result.execution.policySnapshot.allowedTools.includes('run_command'),
      limits: DEFAULT_AGENT_LOOP_LIMITS,
      initialGoalObservation: result.turn.goalId === null || result.turn.goalRevision === null
        ? { kind: 'none' }
        : { kind: 'goal', goalId: result.turn.goalId, revision: result.turn.goalRevision },
      goalCreationRequested: false,
      flushGoalAccounting: () => { this.checkpointGoalTurn(result.turn, activeTurn.latestTokensUsed) },
      finalTokensUsed: () => activeTurn.latestTokensUsed,
    })
    const completion = this.executeTurn(
      result.turn,
      result.execution,
      input,
      ready.adapter,
      ready.handshake.capabilities,
      controller.signal,
      coordinator,
      automatic,
      (tokens) => { activeTurn.latestTokensUsed = tokens },
      activeTurn,
    ).finally(() => {
      this.active.delete(result.turn.id)
    })
    activeTurn.completion = completion
    this.active.set(result.turn.id, activeTurn)
    void completion.catch(() => {})
  }

  private launchPersistedTurnSafely(
    result: BeginTurnResult,
    input: StartTurnInput,
    ready: Awaited<ReturnType<AdapterRegistry['getReady']>>,
    workspaceRuntime: ToolRuntime,
  ): void {
    try {
      this.launchPersistedTurn(result, input, ready, workspaceRuntime, false)
    } catch (error) {
      try {
        this.store.finishTurn({
          turnId: result.turn.id,
          status: 'failed',
          error: {
            code: 'runtime_start_failed',
            message: error instanceof Error ? error.message : String(error),
          },
        })
      } finally {
        this.events.publish(input.threadId)
      }
    }
  }

  async cancelTurn(turnId: TurnId): Promise<void> {
    const active = this.active.get(turnId)
    if (active) {
      const interrupt = async () => {
        active.controller.abort(new Error('Turn cancelled by user'))
        await withTimeout(active.completion, this.cancellationTimeoutMs, `Turn cancellation ${turnId}`)
      }
      const turn = this.store.getTurn(turnId)
      const goal = turn?.goalId ? this.store.getGoalById(turn.goalId) : null
      if (turn?.goalId && turn.goalRevision !== null && goal?.status === 'active') {
        this.checkpointGoalTurn(turn, active.latestTokensUsed)
        const paused = await this.goalRuntime.pauseBeforeInterrupt({
          goalId: turn.goalId,
          goalRevision: goal.revision,
          interrupt,
        })
        if (paused.status !== 'applied') {
          throw new GoalStoreError('stale_goal_revision', 'Goal changed while the turn was being cancelled')
        }
      } else {
        await interrupt()
      }
      return
    }
    const turn = this.store.getTurn(turnId)
    if (!turn) throw new Error(`Turn not found: ${turnId}`)
    if (isTerminal(turn.status)) return
    throw new Error(`Turn ${turnId} is not owned by this runtime process`)
  }

  reconcileTool(input: ReconcileToolInput): ReconcileToolResult {
    const result = this.store.reconcileTool(input)
    this.events.publish(result.item.threadId)
    return result
  }

  recoverInterruptedTurns(): number {
    return this.store.recoverInterruptedTurns()
  }

  async startGoalRuntime(): Promise<void> {
    for (const session of this.store.listSessions('active')) {
      const thread = this.store.getThread(session.activeThreadId)
      if (thread?.status === 'idle') await this.drainNextFollowUp(thread.id)
    }
    for (const proposal of this.store.listPendingGoalCompletionProposals()) {
      const goal = this.store.getGoalById(proposal.goalId)
      const snapshot = goal ? this.store.getSnapshot(goal.threadId) : null
      if (!goal || !snapshot || goal.status !== 'verifying') continue
      try {
        const ready = await this.adapters.getReady(goal.provider)
        await this.runGoalVerification(proposal, goal, ready.adapter, snapshot)
      } catch (error) {
        const lease = this.store.claimGoalVerifierLease({
          proposalId: proposal.id,
          goalId: proposal.goalId,
          goalRevision: proposal.goalRevision,
          ownerId: this.goalVerifierOwner,
        })
        if (!lease) continue
        this.store.finishGoalVerification({
          proposalId: proposal.id,
          goalId: proposal.goalId,
          goalRevision: proposal.goalRevision,
          evaluatorProvider: goal.provider,
          evaluatorModel: goal.model,
          decision: {
            outcome: 'indeterminate',
            reason: `Verifier recovery failed: ${error instanceof Error ? error.message : String(error)}`,
            requirements: proposal.requirements.map((requirement) => ({
              requirementId: requirement.id,
              result: 'unproven',
              evidenceIds: [],
              reason: 'Recovered verification could not be executed',
            })),
            missingEvidence: ['A successful independent verifier execution is required'],
            impossibleEvidenceIds: [],
          },
          leaseId: lease.leaseId,
          leaseOwner: this.goalVerifierOwner,
        })
        this.events.publish(goal.threadId)
      }
    }
    await this.goalRuntime.start()
  }

  async close(): Promise<void> {
    this.closed = true
    this.shutdownController.abort()
    for (const timer of this.followUpRetryTimers.values()) clearTimeout(timer)
    this.followUpRetryTimers.clear()
    this.followUpRetryCounts.clear()
    for (const timer of this.goalVerificationRetryTimers.values()) clearTimeout(timer)
    this.goalVerificationRetryTimers.clear()
    this.goalRuntime.stop()
    await Promise.allSettled([...this.followUpDrains.values()])
    await Promise.allSettled([...this.goalVerifications.values()])
    const active = [...this.active.values()]
    for (const turn of active) turn.controller.abort(new Error('Baton is shutting down'))
    await this.adapters.shutdownAll()
    const completions = await Promise.allSettled(active.map((turn) => withTimeout(
      turn.completion,
      this.cancellationTimeoutMs,
      'Turn shutdown',
    )))
    const timedOut = completions.find((result) => result.status === 'rejected')
    if (timedOut?.status === 'rejected') throw timedOut.reason
    this.events.clear()
    this.store.close()
  }

  private async executeTurn(
    turn: CanonicalTurn,
    canonicalExecution: CanonicalExecution,
    input: StartTurnInput,
    adapter: Awaited<ReturnType<AdapterRegistry['getReady']>>['adapter'],
    capabilities: Awaited<ReturnType<AdapterRegistry['getReady']>>['handshake']['capabilities'],
    signal: AbortSignal,
    coordinator: ToolCoordinator,
    automatic: boolean,
    onTokensUsed: (tokens: number) => void,
    activeTurn: ActiveTurn,
  ): Promise<void> {
    let terminal: FinishTurnInput = { turnId: turn.id, status: 'completed' }
    let tokensUsed = 0
    let goalLimitFailure: GoalExecutionLimitError | null = null
    const toolExecutions = new Set<Promise<AgentToolResult>>()
    const executionController = new AbortController()
    const forwardAbort = () => executionController.abort(signal.reason)
    signal.addEventListener('abort', forwardAbort, { once: true })
    if (signal.aborted) forwardAbort()
    const capturedGoal = turn.goalId === null || turn.goalRevision === null
      ? null
      : this.store.getGoalById(turn.goalId)
    const remainingGoalMs = capturedGoal?.status === 'active'
      && capturedGoal.revision === turn.goalRevision
      ? Math.max(1, (capturedGoal.maxActiveSeconds - capturedGoal.timeUsedSeconds) * 1_000)
      : null
    const goalDeadline = remainingGoalMs === null ? null : setTimeout(() => {
      goalLimitFailure ??= new GoalExecutionLimitError('goal_time_limit')
      executionController.abort(goalLimitFailure)
    }, remainingGoalMs)
    const executionSignal = executionController.signal
    try {
      const persisted = this.store.getSnapshot(input.threadId)
      if (!persisted) throw new Error(`Thread disappeared after turn start: ${input.threadId}`)
      const materialized = this.contextRuntime
        ? await this.contextRuntime.materializeForExecution({
            snapshot: persisted,
            execution: canonicalExecution,
            provider: input.provider,
          })
        : persisted
      const snapshot = adapterSnapshot(materialized, input.provider, turn.id)
      assertNoUnresolvedToolCalls(snapshot)
      const request = {
        turnId: turn.id,
        model: input.model,
        effort: input.effort ?? null,
        input: input.input,
      }
      adapter.validate(request, snapshot)
      const nativeRequest = adapter.materialize(request, snapshot)

      const execution = await adapter.execute(nativeRequest, {
        signal: executionSignal,
        toolDefinitions: coordinator.definitions,
        limits: DEFAULT_AGENT_LOOP_LIMITS,
        executeTool: (invocation) => {
          const execution = (async () => {
            const pending = coordinator.execute(invocation, executionSignal)
            this.events.publish(input.threadId)
            try {
              const result = await pending
              const limited = runningGoalLimit(this.checkpointGoalTurn(turn, tokensUsed, true))
              if (limited) {
                goalLimitFailure = new GoalExecutionLimitError(limited)
                throw goalLimitFailure
              }
              return result
            } finally {
              this.events.publish(input.threadId)
            }
          })()
          toolExecutions.add(execution)
          void execution.finally(() => toolExecutions.delete(execution)).catch(() => undefined)
          return execution
        },
        async denyApproval() { throw new Error('Provider approval requests are disabled in canonical MVP') },
        async denyToolCall() { throw new Error('Provider tool calls are disabled in canonical MVP') },
      })
      activeTurn.execution = execution
      this.pumpActiveFollowUps(activeTurn)
      const cancelOnAbort = () => { void execution.cancel().catch(() => undefined) }
      executionSignal.addEventListener('abort', cancelOnAbort, { once: true })
      try {
        for await (const event of execution.events) {
          const items = adapter.normalize(event)
          if (items.length > 0) {
            if (event.durability !== 'durable' || !event.eventId) {
              throw new Error(`Adapter produced canonical items from non-durable event: ${event.type}`)
            }
            this.store.appendProviderEvent({ turnId: turn.id, eventId: event.eventId, items })
          }
          const patch = adapter.extractBinding(event)
          if (patch) this.persistBinding(input, capabilities, patch)
          tokensUsed = Math.max(tokensUsed, chargeableGoalTokens(event.payload))
          onTokensUsed(tokensUsed)
          const limited = runningGoalLimit(this.checkpointGoalTurn(turn, tokensUsed))
          if (limited) {
            goalLimitFailure = new GoalExecutionLimitError(limited)
            await execution.cancel()
            throw goalLimitFailure
          }
          this.events.publish(input.threadId)
        }
        const result = await execution.terminal
        if (executionSignal.aborted) throw executionSignal.reason ?? new Error('Turn cancelled by user')
        tokensUsed = Math.max(tokensUsed, chargeableGoalTokens(result.usage))
        onTokensUsed(tokensUsed)
        terminal = {
          turnId: turn.id,
          status: result.status,
          usage: result.usage,
          error: result.error,
        }
        const toolLimit = coordinator.terminalFailure
        if (toolLimit) {
          terminal = {
            turnId: turn.id,
            status: 'failed',
            usage: result.usage,
            error: { ...toolLimit },
          }
        }
      } finally {
        executionSignal.removeEventListener('abort', cancelOnAbort)
        await execution.dispose()
      }
    } catch (error) {
      terminal = error instanceof GoalExecutionLimitError
        ? {
            turnId: turn.id,
            status: 'failed',
            error: { code: error.code, message: error.message },
          }
        : signal.aborted
          ? { turnId: turn.id, status: 'cancelled' }
        : {
            turnId: turn.id,
            status: 'failed',
            error: {
              ...(error instanceof GoalExecutionLimitError ? { code: error.code } : {}),
              message: error instanceof Error ? error.message : String(error),
            },
          }
    }
    await Promise.allSettled([...toolExecutions])
    try {
      await coordinator.settle()
    } catch (error) {
      if (coordinator.hasUnknownMutationOutcome) {
        terminal = {
          turnId: turn.id,
          status: 'interrupted',
          error: {
            code: 'unknown_mutation_outcome',
            message: 'A durable workspace mutation has no durable result; reconcile it before continuing',
          },
        }
      } else if (terminal.status !== 'cancelled') {
        terminal = {
          turnId: turn.id,
          status: 'failed',
          error: {
            code: 'tool_durability_failure',
            message: error instanceof Error ? error.message : String(error),
          },
        }
      }
    }
    const finalLimit = runningGoalLimit(this.checkpointGoalTurn(turn, tokensUsed))
    if (finalLimit && terminal.status !== 'cancelled' && terminal.status !== 'interrupted') {
      goalLimitFailure ??= new GoalExecutionLimitError(finalLimit)
      terminal = {
        turnId: turn.id,
        status: 'failed',
        usage: terminal.usage,
        error: { code: goalLimitFailure.code, message: goalLimitFailure.message },
      }
    }
    if (goalDeadline !== null) clearTimeout(goalDeadline)
    signal.removeEventListener('abort', forwardAbort)
    activeTurn.closing = true
    await activeTurn.pump.catch(() => undefined)
    const closeResult = this.store.closeFollowUpWindow(turn.id)
    if (closeResult.inFlight !== 0) {
      this.store.markTurnFollowUpsDeliveryUnknown(turn.id)
      terminal = { turnId: turn.id, status: 'interrupted', error: { code: 'follow_up_barrier_failed' } }
    }
    this.store.finishTurn(terminal)
    this.events.publish(input.threadId)
    const drained = await this.drainNextFollowUp(turn.threadId)
    const preserveGoalForUser = drained || this.hasPendingUserIntent(turn.threadId)
    await this.finishGoalTurn(
      turn, terminal, tokensUsed, automatic,
      preserveGoalForUser ? null : coordinator.goalCompletionProposalIntent,
      !preserveGoalForUser,
      preserveGoalForUser,
      adapter,
    )
  }

  private flushActiveGoalTurns(goalId: string): void {
    for (const active of this.active.values()) {
      if (active.turn.goalId !== goalId) continue
      this.checkpointGoalTurn(active.turn, active.latestTokensUsed, true)
    }
  }

  private sessionToolRuntime(
    cwd: string | null,
    profile: PermissionProfile,
    adapter: import('./adapter.ts').SessionProviderAdapter,
  ): ToolRuntime {
    const workspace: ToolRuntime = cwd
      ? new LocalWorkspaceToolRuntime({
        cwd,
        access: profile === 'read_only' ? 'read_only' : 'workspace',
        enableCommands: profile !== 'read_only',
        ...(profile === 'full_access' ? { commandRunner: new FullAccessCommandRunner() } : {}),
      })
      : profile === 'full_access' ? new HostCommandToolRuntime() : NO_WORKSPACE_RUNTIME
    const skills = adapter.skillResources?.() ?? []
    return skills.length > 0
      ? new CompositeToolRuntime([workspace, new SkillResourceToolRuntime(skills)])
      : workspace
  }

  private validateImageInputs(items: readonly NewCanonicalItem[]): void {
    for (const item of items) {
      for (const attachment of imageAttachments(item.payload)) {
        if (!this.hostRuntime) throw new Error('Image attachments are unavailable')
        this.hostRuntime.artifacts.pathFor(attachment)
      }
    }
  }

  private checkpointGoalTurn(
    turn: CanonicalTurn,
    tokensUsed: number,
    includeProgress = false,
  ): CanonicalGoal | null {
    if (turn.goalId === null || turn.goalRevision === null) return null
    return this.store.checkpointGoalTurn({
      turnId: turn.id,
      goalId: turn.goalId,
      goalRevision: turn.goalRevision,
      tokensUsed,
      timeUsedSeconds: elapsedTurnSeconds(turn, new Date().toISOString()),
      ...(includeProgress ? {
        progressDigest: goalProgressDigest(this.store.getSnapshot(turn.threadId), turn.goalRevision, turn.id),
      } : {}),
    }).goal
  }

  private async finishGoalTurn(
    turn: CanonicalTurn,
    terminal: FinishTurnInput,
    tokensUsed: number,
    automatic: boolean,
    goalIntent: GoalCompletionProposalIntent | null,
    notifyIdle = true,
    preserveGoalForUser = false,
    adapter?: import('./adapter.ts').SessionProviderAdapter,
  ): Promise<void> {
    if (turn.goalId === null || turn.goalRevision === null) return
    const progressDigest = goalProgressDigest(this.store.getSnapshot(turn.threadId), turn.goalRevision, turn.id)
    const accounted = this.store.recordGoalTurn({
      turnId: turn.id,
      goalId: turn.goalId,
      goalRevision: turn.goalRevision,
      tokensUsed,
      timeUsedSeconds: elapsedTurnSeconds(turn, new Date().toISOString()),
      automatic,
      progressDigest,
    })
    if (accounted.status === 'stale' || !accounted.goal) return
    if (preserveGoalForUser) return
    if (terminal.status !== 'completed') {
      const stoppingError = terminal.status === 'cancelled' || terminal.status === 'interrupted'
        ? { ...(terminal.error ?? {}), code: terminal.error?.code ?? 'runtime_interrupted' }
        : terminal.error
      if (automatic && stoppingError?.code === 'provider_retry_exhausted') {
        await delay(transientGoalRetryDelay(accounted.goal.automaticTurnsUsed))
        await this.goalRuntime.notifyThreadIdle(turn.threadId)
        this.events.publish(turn.threadId)
        return
      }
      this.stopGoalForTerminal(accounted.goal, stoppingError)
      this.events.publish(turn.threadId)
      return
    }
    if (goalIntent) {
      if (goalIntent.goalId !== accounted.goal.id
        || goalIntent.expectedRevision !== accounted.goal.revision) return
      if (!adapter) throw new Error('Goal completion verification requires the worker adapter')
      const snapshot = this.store.getSnapshot(turn.threadId)
      if (!snapshot) throw new Error('Goal completion verification lost its thread snapshot')
      const bundle = freezeGoalEvidence(accounted.goal, turn, goalIntent, snapshot)
      const proposal = this.store.beginGoalVerification({
        goalId: accounted.goal.id,
        goalRevision: accounted.goal.revision,
        turnId: turn.id,
        summary: goalIntent.summary,
        requirements: [...goalIntent.requirements],
        evidenceBundle: bundle,
      })
      this.events.publish(turn.threadId)
      if (proposal) await this.runGoalVerification(proposal, accounted.goal, adapter, snapshot)
      return
    }
    if (notifyIdle) await this.goalRuntime.notifyThreadIdle(turn.threadId)
    this.events.publish(turn.threadId)
  }

  private async runGoalVerification(
    proposal: GoalCompletionProposal,
    goal: CanonicalGoal,
    adapter: import('./adapter.ts').SessionProviderAdapter,
    snapshot: ThreadSnapshot,
  ): Promise<void> {
    const existing = this.goalVerifications.get(proposal.id)
    if (existing) return existing
    const execution = (async () => {
      const lease = this.store.claimGoalVerifierLease({
        proposalId: proposal.id,
        goalId: proposal.goalId,
        goalRevision: proposal.goalRevision,
        ownerId: this.goalVerifierOwner,
      })
      if (!lease) {
        this.scheduleGoalVerificationRetry(proposal.id)
        return
      }
      const controller = new AbortController()
      const abortForShutdown = () => controller.abort(this.shutdownController.signal.reason)
      this.shutdownController.signal.addEventListener('abort', abortForShutdown, { once: true })
      if (this.shutdownController.signal.aborted) abortForShutdown()
      const heartbeat = setInterval(() => {
        try {
          const renewed = this.store.heartbeatGoalVerifierLease({
            proposalId: proposal.id,
            goalId: proposal.goalId,
            goalRevision: proposal.goalRevision,
            ownerId: this.goalVerifierOwner,
            leaseId: lease.leaseId,
          })
          if (!renewed) controller.abort(new Error('Goal verifier lease was lost'))
        } catch (error) {
          controller.abort(error)
        }
      }, 10_000)
      heartbeat.unref?.()
      try {
        let decision: GoalVerificationDecision
        let usage: Record<string, unknown> | null = null
        try {
          const result = await this.goalVerifier.verify({
            bundle: proposal.evidenceBundle,
            adapter,
            snapshot,
            model: goal.model,
            effort: goal.effort,
            signal: controller.signal,
          })
          decision = result.decision
          usage = result.usage
        } catch (error) {
          decision = {
            outcome: 'indeterminate',
            reason: `Independent verifier failed: ${error instanceof Error ? error.message : String(error)}`,
            requirements: proposal.requirements.map((requirement) => ({
              requirementId: requirement.id,
              result: 'unproven',
              evidenceIds: [],
              reason: 'Verifier execution did not produce a valid decision',
            })),
            missingEvidence: ['A valid independent verifier result is required'],
            impossibleEvidenceIds: [],
          }
        }
        const result = this.store.finishGoalVerification({
          proposalId: proposal.id,
          goalId: proposal.goalId,
          goalRevision: proposal.goalRevision,
          evaluatorProvider: adapter.provider,
          evaluatorModel: goal.model,
          decision,
          usage,
          leaseId: lease.leaseId,
          leaseOwner: this.goalVerifierOwner,
        })
        if (result.goal) {
          this.events.publish(result.goal.threadId)
          if (result.status === 'applied' && result.goal.status === 'active') {
            await this.goalRuntime.notifyThreadIdle(result.goal.threadId)
          }
        }
      } finally {
        clearInterval(heartbeat)
        this.shutdownController.signal.removeEventListener('abort', abortForShutdown)
        this.store.releaseGoalVerifierLease({
          proposalId: proposal.id,
          leaseId: lease.leaseId,
          ownerId: this.goalVerifierOwner,
        })
      }
    })().finally(() => this.goalVerifications.delete(proposal.id))
    this.goalVerifications.set(proposal.id, execution)
    return execution
  }

  private scheduleGoalVerificationRetry(proposalId: string): void {
    if (this.closed || this.goalVerificationRetryTimers.has(proposalId)) return
    const timer = setTimeout(() => {
      this.goalVerificationRetryTimers.delete(proposalId)
      void this.retryGoalVerification(proposalId)
    }, this.goalVerificationRetryMs)
    timer.unref?.()
    this.goalVerificationRetryTimers.set(proposalId, timer)
  }

  private async retryGoalVerification(proposalId: string): Promise<void> {
    if (this.closed) return
    const proposal = this.store.listPendingGoalCompletionProposals()
      .find((candidate) => candidate.id === proposalId)
    if (!proposal) return
    const goal = this.store.getGoalById(proposal.goalId)
    const snapshot = goal ? this.store.getSnapshot(goal.threadId) : null
    if (!goal || !snapshot || goal.status !== 'verifying') return
    try {
      const ready = await this.adapters.getReady(goal.provider)
      await this.runGoalVerification(proposal, goal, ready.adapter, snapshot)
    } catch {
      this.scheduleGoalVerificationRetry(proposalId)
    }
  }

  private stopGoalForTerminal(goal: CanonicalGoal, error: Record<string, unknown> | null | undefined): void {
    const code = typeof error?.code === 'string' ? error.code : 'provider_failure'
    if (code === 'provider_usage_limit') {
      this.goalRuntime.stopForProviderFailure({
        goalId: goal.id,
        goalRevision: goal.revision,
        category: 'provider_usage_limit',
        message: typeof error?.message === 'string' ? error.message : undefined,
      })
      return
    }
    const budgetReason = budgetLimitReason(code)
    if (budgetReason) {
      this.store.updateGoalStatus({
        goalId: goal.id,
        expectedRevision: goal.revision,
        status: 'budget_limited',
        reason: { code: budgetReason, source: 'host', message: null, at: new Date().toISOString() },
      })
      return
    }
    if (code === 'runtime_interrupted') {
      this.store.updateGoalStatus({
        goalId: goal.id,
        expectedRevision: goal.revision,
        status: 'blocked',
        reason: {
          code: 'runtime_interrupted',
          source: 'host',
          message: typeof error?.message === 'string' ? error.message : null,
          at: new Date().toISOString(),
        },
      })
      return
    }
    if (code === 'unknown_mutation_outcome') {
      this.store.updateGoalStatus({
        goalId: goal.id,
        expectedRevision: goal.revision,
        status: 'blocked',
        reason: {
          code: 'unknown_mutation_outcome',
          source: 'host',
          message: typeof error?.message === 'string' ? error.message : null,
          at: new Date().toISOString(),
        },
      })
      return
    }
    this.goalRuntime.stopForProviderFailure({
      goalId: goal.id,
      goalRevision: goal.revision,
      category: 'provider_failure',
      message: typeof error?.message === 'string' ? error.message : undefined,
    })
  }

  private async launchGoalContinuation(request: GoalContinuationRequest) {
    if (request.signal.aborted) return { status: 'not_started' as const, reason: 'cancelled' as const }
    const thread = this.store.getThread(request.goal.threadId)
    if (!thread || thread.status !== 'idle') return { status: 'not_started' as const, reason: 'busy' as const }
    const pendingUserIntent = this.hasPendingUserIntent(thread.id)
    if (pendingUserIntent) {
      void this.drainNextFollowUp(thread.id)
      return { status: 'not_started' as const, reason: 'busy' as const }
    }
    try {
      const started = await resolveUnlessAborted(this.startTurnInternal({
        threadId: request.goal.threadId,
        provider: request.goal.provider,
        model: request.goal.model,
        effort: request.goal.effort,
        clientRequestId: request.clientRequestId,
        expectedRevision: thread.revision,
        input: [{
          kind: 'user_message',
          visibility: 'baton_private',
          payload: { text: goalContinuationPrompt(request.goal), goalContinuation: true },
        }],
      }, request.goalContext, true, request.signal), request.signal)
      if (started === null) return { status: 'not_started' as const, reason: 'cancelled' as const }
      return { status: 'started' as const, turnId: started.turn.id }
    } catch (error) {
      if (error instanceof GoalStoreError && error.code === 'goal_lease_lost') {
        return { status: 'not_started' as const, reason: 'lease_lost' as const }
      }
      if (error instanceof SessionStoreError
        && (error.code === 'revision_conflict' || error.code === 'duplicate_request')) {
        return { status: 'not_started' as const, reason: 'stale' as const }
      }
      if (error instanceof SessionStoreError && error.code === 'turn_not_running') {
        return { status: 'not_started' as const, reason: 'busy' as const }
      }
      if (error instanceof ContextInputTooLargeError) {
        return {
          status: 'failed' as const,
          category: 'context_input_too_large' as const,
          message: error.message,
        }
      }
      return {
        status: 'failed' as const,
        category: 'provider_failure' as const,
        message: error instanceof Error ? error.message : String(error),
      }
    }
  }

  private async interruptGoalTurns(goalId: string): Promise<void> {
    const matching = [...this.active.entries()].filter(([turnId]) => this.store.getTurn(turnId)?.goalId === goalId)
    for (const [turnId, active] of matching) {
      active.controller.abort(new Error('Goal paused by user'))
      await withTimeout(active.completion, this.cancellationTimeoutMs, `Goal pause ${turnId}`)
    }
  }

  private persistBinding(
    input: StartTurnInput,
    capabilities: Awaited<ReturnType<AdapterRegistry['getReady']>>['handshake']['capabilities'],
    patch: ProviderBindingPatch,
  ): void {
    if (patch.opaqueState && patch.opaqueState.byteLength > 0) {
      throw new Error('Opaque provider state cannot be persisted before encryption is configured')
    }
    this.store.upsertProviderBinding({
      threadId: input.threadId,
      provider: input.provider,
      modelFamily: patch.modelFamily ?? input.model,
      nativeThreadId: patch.nativeThreadId,
      nativeResponseId: patch.nativeResponseId,
      opaqueStateEncrypted: null,
      capabilities,
      syncedRevision: this.store.getThread(input.threadId)?.revision ?? input.expectedRevision,
      contextDigest: hashSnapshot(this.store.getSnapshot(input.threadId)),
    })
  }
}

export function hashTurnRequest(input: StartTurnInput): string {
  return createHash('sha256').update(stableJson({
    threadId: input.threadId,
    provider: input.provider,
    model: input.model,
    effort: input.effort ?? null,
    clientRequestId: input.clientRequestId,
    input: input.input,
  })).digest('hex')
}

interface NormalizedStartSessionInput extends Omit<StartSessionInput, 'effort' | 'instructionSnapshot'> {
  effort: string | null
  instructionSnapshot: ReturnType<typeof normalizeInstructionSnapshot>
}

export function hashSessionStartRequest(input: NormalizedStartSessionInput): string {
  return createHash('sha256').update(stableJson({
    sessionId: input.sessionId,
    clientRequestId: input.clientRequestId,
    cwd: input.cwd,
    instructionSnapshot: input.instructionSnapshot,
    provider: input.provider,
    model: input.model,
    effort: input.effort,
    input: input.input,
  })).digest('hex')
}

function normalizeStartSessionInput(input: StartSessionInput): NormalizedStartSessionInput {
  const sessionId = input.sessionId.trim()
  const clientRequestId = input.clientRequestId.trim()
  const model = input.model.trim()
  const effort = input.effort == null ? null : input.effort.trim()
  const cwd = input.cwd === null ? null : input.cwd.trim()
  if (!sessionId) throw new Error('sessionId is required')
  if (!clientRequestId) throw new Error('clientRequestId is required')
  if (!model) throw new Error('model is required')
  if (input.effort != null && !effort) throw new Error('effort must be null or a non-empty string')
  if (input.cwd !== null && !cwd) throw new Error('cwd must be null or a non-empty string')
  if (input.provider !== 'claude' && input.provider !== 'codex' && input.provider !== 'gemini') {
    throw new Error('provider must be claude, codex, or gemini')
  }
  if (input.input.length === 0) throw new Error('at least one input item is required')
  const normalizedInput = input.input.map((item) => {
    const visibility = item.visibility ?? 'portable'
    if (item.kind !== 'user_message'
      || visibility !== 'portable'
      || (item.provider !== undefined && item.provider !== null)
      || (item.nativeId !== undefined && item.nativeId !== null)
      || !hasPortableUserContent(item.payload)) {
      throw new Error('initial input accepts non-empty portable provider-neutral user messages only')
    }
    if (item.payload.attachments !== undefined && !Array.isArray(item.payload.attachments)) {
      throw new Error('initial input attachments must be an array')
    }
    return {
      kind: 'user_message' as const,
      visibility: 'portable' as const,
      payload: canonicalJsonObject(item.payload, 'initial input payload'),
      provider: null,
      nativeId: null,
    }
  })
  return {
    sessionId,
    clientRequestId,
    cwd,
    instructionSnapshot: normalizeInstructionSnapshot(input.instructionSnapshot ?? {}),
    provider: input.provider,
    model,
    effort,
    input: normalizedInput,
  }
}

function canonicalJsonObject(value: Record<string, unknown>, label: string): Record<string, unknown> {
  const active = new Set<object>()
  const visit = (current: unknown): unknown => {
    if (current === null || typeof current === 'string' || typeof current === 'boolean') return current
    if (typeof current === 'number') {
      if (!Number.isFinite(current)) throw new TypeError(`${label} contains a non-finite number`)
      return Object.is(current, -0) ? 0 : current
    }
    if (Array.isArray(current)) {
      if (active.has(current)) throw new TypeError(`${label} contains a cycle`)
      active.add(current)
      try {
        for (let index = 0; index < current.length; index += 1) {
          if (!(index in current)) throw new TypeError(`${label} contains a sparse array`)
        }
        return current.map(visit)
      } finally { active.delete(current) }
    }
    if (typeof current === 'object') {
      const prototype = Object.getPrototypeOf(current)
      if (prototype !== Object.prototype && prototype !== null) {
        throw new TypeError(`${label} contains a non-JSON object`)
      }
      if (active.has(current)) throw new TypeError(`${label} contains a cycle`)
      active.add(current)
      try {
        const result: Record<string, unknown> = {}
        for (const key of Object.keys(current as Record<string, unknown>).sort()) {
          const child = (current as Record<string, unknown>)[key]
          if (child === undefined) throw new TypeError(`${label} contains undefined`)
          result[key] = visit(child)
        }
        return result
      } finally {
        active.delete(current)
      }
    }
    throw new TypeError(`${label} contains a non-JSON ${typeof current}`)
  }
  return visit(value) as Record<string, unknown>
}

function hashSnapshot(snapshot: ThreadSnapshot | null): string {
  if (!snapshot) throw new Error('Cannot bind a missing canonical thread')
  return createHash('sha256').update(stableJson({
    threadId: snapshot.thread.id,
    revision: snapshot.thread.revision,
    items: snapshot.items.map((item) => ({ id: item.id, sequence: item.sequence })),
  })).digest('hex')
}

function stableJson(value: unknown): string {
  if (value === undefined) return 'null'
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  const object = value as Record<string, unknown>
  return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${stableJson(object[key])}`).join(',')}}`
}

async function withTimeout<T>(promise: Promise<T>, milliseconds: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${milliseconds}ms`)), milliseconds)
        timer.unref()
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

function validateTurnInput(input: StartTurnInput, internalGoalTurn = false): void {
  if (!input.model.trim()) throw new Error('model is required')
  if (input.effort !== undefined && input.effort !== null && !input.effort.trim()) {
    throw new Error('effort must be null or a non-empty string')
  }
  if (!input.clientRequestId.trim()) throw new Error('clientRequestId is required')
  if (input.input.length === 0) throw new Error('at least one input item is required')
  for (const item of input.input) {
    const visibility = item.visibility ?? 'portable'
    if (item.kind !== 'user_message'
      || (visibility !== 'portable' && !(internalGoalTurn && visibility === 'baton_private'))) {
      throw new Error('turn input accepts portable user messages and internal Goal continuations only')
    }
    if (visibility === 'portable' && !hasPortableUserContent(item.payload)) {
      throw new Error('portable user messages require text or image attachments')
    }
  }
}

export function chargeableGoalTokens(value: unknown): number {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return 0
  const object = value as Record<string, unknown>
  if (object.usage && typeof object.usage === 'object') return chargeableGoalTokens(object.usage)
  if ('cache_read_input_tokens' in object || 'cache_creation_input_tokens' in object) {
    const uncachedInput = firstFinite(object, ['input_tokens'])
    const cacheCreation = firstFinite(object, ['cache_creation_input_tokens'])
    const output = firstFinite(object, ['output_tokens'])
    return uncachedInput + cacheCreation + output
  }
  const input = firstFinite(object, ['inputTokens', 'input_tokens', 'input'])
  const cached = firstFinite(object, [
    'cachedInputTokens', 'cached_input_tokens', 'cacheReadInputTokens', 'cache_read_input_tokens',
  ])
  const output = firstFinite(object, ['outputTokens', 'output_tokens', 'output'])
  if (input > 0 || output > 0 || cached > 0) return Math.max(0, input - cached) + Math.max(0, output)
  return Math.max(0, firstFinite(object, ['totalTokens', 'total_tokens', 'total']))
}

function firstFinite(object: Record<string, unknown>, keys: readonly string[]): number {
  for (const key of keys) {
    const value = object[key]
    if (typeof value === 'number' && Number.isFinite(value)) return Math.max(0, Math.floor(value))
  }
  return 0
}

function elapsedTurnSeconds(turn: CanonicalTurn, endIso: string): number {
  if (!turn.startedAt) return 0
  return Math.max(0, Math.ceil((Date.parse(endIso) - Date.parse(turn.startedAt)) / 1_000))
}

function goalProgressDigest(snapshot: ThreadSnapshot | null, goalRevision: number, turnId: TurnId): string | null {
  const turnItems = snapshot?.items.filter((item) => item.turnId === turnId) ?? []
  const mutatingCalls = new Set(turnItems.flatMap((item) => {
    if (item.kind !== 'tool_call'
      || (item.payload.sideEffect !== 'workspace_mutation' && item.payload.sideEffect !== 'host_mutation')) return []
    return typeof item.payload.callId === 'string' ? [item.payload.callId] : []
  }))
  const evidence = turnItems
    .filter((item) => {
      if (item.kind === 'file_change' || item.kind === 'plan' || item.kind === 'task') return true
      if (item.kind !== 'tool_result') return false
      const callId = typeof item.payload.callId === 'string' ? item.payload.callId : null
      const result = item.payload.result
      return callId !== null && mutatingCalls.has(callId)
        && typeof result === 'object' && result !== null && (result as { success?: unknown }).success === true
    })
    .map((item) => stableProgressEvidence(item.kind, item.payload))
  if (evidence.length === 0) return null
  return createHash('sha256').update(stableJson({
    goalRevision,
    evidence: [...new Set(evidence)].sort(),
  })).digest('hex')
}

function freezeGoalEvidence(
  goal: CanonicalGoal,
  turn: CanonicalTurn,
  intent: GoalCompletionProposalIntent,
  snapshot: ThreadSnapshot,
): GoalEvidenceBundle {
  const evidence: GoalFrozenEvidence[] = []
  const omissions: string[] = []
  const turnItems = snapshot.items.filter((item) => item.turnId === turn.id)
  const assistantItems = turnItems.filter((item) => item.kind === 'assistant_message')
  for (let requirementIndex = 0; requirementIndex < intent.requirements.length; requirementIndex += 1) {
    const requirement = intent.requirements[requirementIndex]!
    for (let evidenceIndex = 0; evidenceIndex < requirement.evidence.length; evidenceIndex += 1) {
      const reference = requirement.evidence[evidenceIndex]!
      const id = `evidence-${requirementIndex + 1}-${evidenceIndex + 1}`
      if (reference.kind === 'tool_result') {
        const item = turnItems.find((candidate) => candidate.kind === 'tool_result'
          && (candidate.payload.callId === reference.reference
            || candidate.payload.providerCallId === reference.reference
            || candidate.nativeId === reference.reference))
        const bounded = item ? boundedGoalEvidencePayload(item.payload) : null
        const result = item && typeof item.payload.result === 'object' && item.payload.result !== null
          ? item.payload.result as Record<string, unknown>
          : null
        const authoritative = result?.success === true && bounded?.truncated === false
        if (!item) omissions.push(`${id}: referenced tool result was not found`)
        else if (bounded?.truncated) omissions.push(`${id}: tool result exceeded the verifier evidence limit`)
        else if (!authoritative) omissions.push(`${id}: referenced tool result was not successful`)
        evidence.push({
          id,
          kind: reference.kind,
          reference: reference.reference ?? '',
          claim: reference.claim,
          authoritative,
          payload: {
            requirementId: requirement.id,
            itemId: item?.id ?? null,
            value: bounded?.value ?? null,
          },
        })
        continue
      }
      const bounded = boundedGoalEvidencePayload(assistantItems.map((item) => ({ id: item.id, payload: item.payload })))
      const authoritative = assistantItems.length > 0 && !bounded.truncated
      if (assistantItems.length === 0) omissions.push(`${id}: the terminal turn has no assistant deliverable`)
      if (bounded.truncated) omissions.push(`${id}: terminal deliverable exceeded the verifier evidence limit`)
      evidence.push({
        id,
        kind: reference.kind,
        reference: turn.id,
        claim: reference.claim,
        authoritative,
        payload: {
          requirementId: requirement.id,
          terminalStatus: 'completed',
          assistantItems: bounded.value,
        },
      })
    }
  }
  const content = {
    goalId: goal.id,
    goalRevision: goal.revision,
    objective: goal.objective,
    proposalSummary: intent.summary,
    requirements: intent.requirements.map((requirement) => ({
      ...requirement,
      evidence: requirement.evidence.map((entry) => ({ ...entry })),
    })),
    evidence,
    terminalTurn: {
      id: turn.id,
      status: 'completed' as const,
      provider: turn.provider,
      model: turn.model,
    },
    omissions,
  }
  return { ...content, hash: goalEvidenceHash(content) }
}

function boundedGoalEvidencePayload(value: unknown): { value: unknown; truncated: boolean } {
  const serialized = JSON.stringify(value)
  const maximum = 40_000
  if (serialized.length <= maximum) return { value, truncated: false }
  return {
    value: { truncated: true, preview: serialized.slice(0, maximum) },
    truncated: true,
  }
}


function stableProgressEvidence(kind: string, payload: Record<string, unknown>): string {
  if (kind === 'tool_result') {
    return stableJson({
      kind,
      toolName: payload.toolName ?? null,
      result: payload.result ?? null,
    })
  }
  return stableJson({ kind, payload })
}

function budgetLimitReason(code: string): string | null {
  if (code === 'model_round_limit') return 'model_round_limit'
  if (code === 'tool_call_limit') return 'tool_call_limit'
  if (code === 'tool_repetition_limit') return 'tool_repetition_limit'
  if (code === 'turn_time_limit') return 'turn_time_limit'
  if (code === 'turn_budget_limit') return 'turn_budget_limit'
  if (code === 'goal_token_limit') return 'goal_token_limit'
  if (code === 'goal_time_limit') return 'goal_time_limit'
  return null
}

function transientGoalRetryDelay(automaticTurnsUsed: number): number {
  return Math.min(5_000, 250 * (2 ** Math.min(automaticTurnsUsed, 4)))
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

class GoalExecutionLimitError extends Error {
  readonly code: 'goal_token_limit' | 'goal_time_limit'

  constructor(code: 'goal_token_limit' | 'goal_time_limit') {
    super(code === 'goal_token_limit'
      ? 'Goal token budget was reached during this turn'
      : 'Goal active-time budget was reached during this turn')
    this.code = code
  }
}

function runningGoalLimit(goal: CanonicalGoal | null): 'goal_token_limit' | 'goal_time_limit' | null {
  if (!goal || goal.status !== 'active') return null
  if (goal.tokenBudget !== null && goal.tokensUsed >= goal.tokenBudget) return 'goal_token_limit'
  if (goal.timeUsedSeconds >= goal.maxActiveSeconds) return 'goal_time_limit'
  return null
}

function adapterSnapshot(
  snapshot: ThreadSnapshot,
  provider: StartTurnInput['provider'],
  currentTurnId: TurnId,
): ThreadSnapshot {
  return {
    ...snapshot,
    items: snapshot.items.filter((item) =>
      item.turnId !== currentTurnId
      && (item.visibility === 'portable'
        || (item.visibility === 'provider_private' && item.provider === provider)),
    ),
    bindings: snapshot.bindings.filter((binding) => binding.provider === provider),
  }
}

/**
 * Only unresolved calls belonging to a live turn block execution: their
 * outcome is unknown — most importantly a mutating tool call that must go
 * through user reconciliation rather than being silently re-run. Turnless
 * (imported) orphans are tolerated: their results can never arrive, they are
 * durably repaired on the leaf thread, and appends can never reach into a
 * fork's inherited parent slice — while providers drop tool items from
 * portable history entirely, so nothing malformed is ever sent.
 */
function assertNoUnresolvedToolCalls(snapshot: ThreadSnapshot): void {
  const open = new Map<string, ThreadSnapshot['items'][number]>()
  for (const item of snapshot.items) {
    const callId = typeof item.payload.callId === 'string' ? item.payload.callId : null
    if (!callId) continue
    if (item.kind === 'tool_call') open.set(callId, item)
    if (item.kind === 'tool_result') open.delete(callId)
  }
  const liveOrphans = [...open.entries()].filter(([, item]) => item.turnId !== null)
  if (liveOrphans.length > 0) {
    throw new Error(`Unresolved tool calls require reconciliation before continuing: ${liveOrphans.map(([callId]) => callId).join(', ')}`)
  }
}

function isTerminal(status: CanonicalTurn['status']): boolean {
  return status === 'completed'
    || status === 'cancelled'
    || status === 'failed'
    || status === 'interrupted'
}

function resolveUnlessAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T | null> {
  if (signal.aborted) return Promise.resolve(null)
  return new Promise<T | null>((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener('abort', abort)
      resolve(null)
    }
    signal.addEventListener('abort', abort, { once: true })
    promise.then(
      (value) => {
        signal.removeEventListener('abort', abort)
        resolve(value)
      },
      (error) => {
        signal.removeEventListener('abort', abort)
        reject(error)
      },
    )
  })
}

function followUpText(followUp: CanonicalFollowUp): string {
  return followUp.input.map((item) => {
    const text = item.payload.text
    if (typeof text !== 'string') throw new Error('Follow-up user message omitted text')
    return text
  }).join('\n')
}
