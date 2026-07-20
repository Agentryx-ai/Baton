import assert from 'node:assert/strict'
import test from 'node:test'

import type { ProviderExecutionContext, SessionProviderAdapter } from './adapter.ts'
import type { GoalEvidenceBundle, ThreadSnapshot } from './domain.ts'
import { parseGoalVerificationDecision, ProviderGoalVerifier } from './goal-verifier.ts'
import { goalEvidenceHash } from './goal-evidence.ts'

function bundle(): GoalEvidenceBundle {
  const content = {
    goalId: 'goal-1',
    goalRevision: 3,
    objective: 'deliver the result',
    proposalSummary: 'delivered',
    requirements: [{
      id: 'requirement-1',
      requirement: 'deliver the result',
      evidence: [{ kind: 'current_turn' as const, reference: null, claim: 'result exists' }],
    }],
    evidence: [{
      id: 'evidence-1-1',
      kind: 'current_turn' as const,
      reference: 'turn-1',
      claim: 'result exists',
      authoritative: true,
      payload: { requirementId: 'requirement-1', assistantItems: [{ text: 'result' }] },
    }],
    terminalTurn: {
      id: 'turn-1', status: 'completed' as const, provider: 'codex' as const, model: 'gpt-test',
    },
    omissions: [] as string[],
  }
  return { ...content, hash: goalEvidenceHash(content) }
}

test('strict Goal verifier parser accepts the complete contract and rejects prose or unknown fields', () => {
  const decision = parseGoalVerificationDecision(JSON.stringify({
    outcome: 'complete',
    reason: 'all requirements are proven',
    requirements: [{
      requirementId: 'requirement-1', result: 'satisfied', evidenceIds: ['evidence-1-1'], reason: 'proof',
    }],
    missingEvidence: [],
    impossibleEvidenceIds: [],
  }))
  assert.equal(decision.outcome, 'complete')
  assert.throws(() => parseGoalVerificationDecision('```json\n{}\n```'), /strict JSON/)
  assert.throws(() => parseGoalVerificationDecision(JSON.stringify({
    outcome: 'complete', reason: 'x', requirements: [], missingEvidence: [], impossibleEvidenceIds: [], ok: true,
  })), /unsupported properties/)
})

test('provider Goal verifier runs an isolated no-tool model call and parses only assistant JSON', async () => {
  let observedContext: ProviderExecutionContext | null = null
  let observedSnapshot: ThreadSnapshot | null = null
  const response = JSON.stringify({
    outcome: 'complete',
    reason: 'frozen evidence is sufficient',
    requirements: [{
      requirementId: 'requirement-1', result: 'satisfied', evidenceIds: ['evidence-1-1'], reason: 'proof',
    }],
    missingEvidence: [],
    impossibleEvidenceIds: [],
  })
  const adapter: SessionProviderAdapter = {
    provider: 'codex',
    async initialize() { throw new Error('not used') },
    validate(_request, snapshot) { observedSnapshot = snapshot },
    materialize() { return { body: {} } },
    async execute(_request, context) {
      observedContext = context
      return {
        events: (async function* () {
          yield { eventId: 'verifier-result', type: 'completed', payload: { text: response }, durability: 'durable' as const }
        })(),
        terminal: Promise.resolve({ status: 'completed', usage: { outputTokens: 7 } }),
        async cancel() {},
        async dispose() {},
      }
    },
    normalize(event) { return [{ kind: 'assistant_message', payload: event.payload as Record<string, unknown> }] },
    extractBinding() { return null },
    async shutdown() {},
  }
  const sourceSnapshot = {
    thread: { id: 'thread-1', instructionSnapshot: { secret: 'not forwarded' } },
    turns: [{ id: 'turn-1' }],
    items: [{ id: 'item-1' }],
    bindings: [{ provider: 'codex' }],
    followUps: [{ id: 'follow-up-1' }],
    goal: { id: 'goal-1' },
  } as unknown as ThreadSnapshot
  const result = await new ProviderGoalVerifier().verify({
    bundle: bundle(), adapter, snapshot: sourceSnapshot, model: 'gpt-test', effort: null,
  })
  assert.equal(result.decision.outcome, 'complete')
  assert.deepEqual(result.usage, { outputTokens: 7 })
  const verifierContext = observedContext as ProviderExecutionContext | null
  const verifierSnapshot = observedSnapshot as ThreadSnapshot | null
  assert.ok(verifierContext)
  assert.ok(verifierSnapshot)
  assert.equal(verifierContext.toolDefinitions.length, 0)
  assert.deepEqual(verifierSnapshot.turns, [])
  assert.deepEqual(verifierSnapshot.items, [])
  assert.deepEqual(verifierSnapshot.bindings, [])
  assert.equal(verifierSnapshot.goal, null)
  await assert.rejects(
    () => verifierContext.executeTool({ callId: 'x', providerCallId: 'x', name: 'x', input: {} }),
    /exposes no tools/,
  )
})

test('provider Goal verifier cancels an execution when its parent aborts during adapter startup', async () => {
  const parent = new AbortController()
  let cancelled = false
  let disposed = false
  const adapter: SessionProviderAdapter = {
    provider: 'codex',
    async initialize() { throw new Error('not used') },
    validate() {},
    materialize() { return { body: {} } },
    async execute() {
      parent.abort(new Error('verifier lease lost'))
      return {
        events: (async function* () {})(),
        terminal: Promise.resolve({ status: 'completed' }),
        async cancel() { cancelled = true },
        async dispose() { disposed = true },
      }
    },
    normalize() { return [] },
    extractBinding() { return null },
    async shutdown() {},
  }

  await assert.rejects(() => new ProviderGoalVerifier().verify({
    bundle: bundle(), adapter, snapshot: {
      thread: { id: 'thread-1', instructionSnapshot: {} },
      turns: [], items: [], bindings: [], followUps: [], goal: null,
    } as unknown as ThreadSnapshot,
    model: 'gpt-test', effort: null, signal: parent.signal,
  }), /verifier lease lost/)
  assert.equal(cancelled, true)
  assert.equal(disposed, true)
})
