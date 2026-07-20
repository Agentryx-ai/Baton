import type {
  NativeGoalReconcileResult, NativeImportStore, NativeSessionCandidate,
  NativeSourceClient, NativeSourceReader,
} from './contracts.ts'

export interface NativeGoalRestorationResult extends NativeGoalReconcileResult {
  sourceClient: NativeSourceClient
  sourceAlias: string
  objective: string | null
}

export async function restoreImportedNativeGoals(
  store: NativeImportStore,
  readers: NativeSourceReader[],
  options: { apply?: boolean; sources?: NativeSourceClient[] } = {},
): Promise<NativeGoalRestorationResult[]> {
  const apply = options.apply === true
  const sources = options.sources ?? ['codex_local', 'claude_desktop', 'claude_code']
  const results: NativeGoalRestorationResult[] = []
  for (const reader of readers) {
    if (!(reader.sourceClients ?? [reader.sourceClient]).some((source) => sources.includes(source))) continue
    const candidates = await reader.scan({
      includeRecords: false,
      sources,
      codex: {
        origins: ['cli', 'ide_app', 'exec', 'other'], includeArchived: true, includeSubagents: false,
      },
    })
    for (const candidate of candidates) {
      const state = store.getNativeImportState(candidate)
      if (!state) continue
      let materialized: NativeSessionCandidate
      try {
        materialized = await reader.materialize(candidate)
      } catch (error) {
        results.push(result(candidate, {
          candidateId: candidate.candidateId, status: 'invalid_goal', sessionId: state.sessionId,
          error: error instanceof Error ? error.message : String(error),
        }))
        continue
      }
      if (state.contentDigest !== materialized.contentDigest) {
        results.push(result(materialized, {
          candidateId: materialized.candidateId, status: 'source_update_required', sessionId: state.sessionId,
          error: 'source_update_required: import the native transcript delta before restoring its Goal',
        }))
        continue
      }
      results.push(result(materialized, store.reconcileNativeGoal(materialized, apply)))
    }
  }
  return results
}

function result(
  candidate: NativeSessionCandidate,
  reconcile: NativeGoalReconcileResult,
): NativeGoalRestorationResult {
  return {
    ...reconcile,
    sourceClient: candidate.sourceClient,
    sourceAlias: candidate.sourceAlias,
    objective: candidate.goal?.objective ?? null,
  }
}
