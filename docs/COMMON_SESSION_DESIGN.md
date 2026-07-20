# Baton canonical conversation runtime

> Status: approved contract; Phase 0 core/persistence implemented, Phase 1 partially implemented as a Codex Preview
> Reference baseline: `openai/codex` main at `5c0e582c59892dbec89af78ae62c784d3da6c9cb` (2026-07-18)

## 1. Product identity and goal

This is one of Baton's two core product pillars:

1. a multi-provider, multi-account control plane for usage, quota, account state, and routing;
2. a canonical conversation runtime that passes one durable conversation between providers.

**Baton owns the conversation. Claude, Codex, and Gemini are adapters that execute the current turn.** A provider account supplies credentials and quota; it does not own conversation identity. A provider-native session is an execution optimization or import source; it is not canonical state.

Baton therefore owns one durable conversation that can continue with Claude, Codex, or Gemini without treating any provider's native session file or remote conversation ID as the source of truth.

The feature must support:

- resuming a Baton conversation after a process or BFF restart;
- choosing a provider and model independently for every new turn;
- switching provider at a safe turn boundary while preserving portable history;
- forking a conversation without copying or mutating its existing history;
- streaming messages, tool activity, file changes, usage, and errors through one event contract;
- adding Gemini later without changing the common domain or database schema;
- importing native sessions as a migration/compatibility feature.

The following are not the same concept and must remain separate:

| Existing concept | Purpose | Common conversation identity? |
|---|---|---|
| Gateway login session | Baton BFF authentication/cookie | No |
| CLIProxy session affinity | Pin requests to an account for a TTL | No |
| Provider account | Authentication and quota routing | No |
| Baton session | Durable user task/conversation tree | **Yes** |

### 1.1 Current implementation boundary

The design in this document remains the target contract. Current conformance and defects are tracked in
[`IMPLEMENTATION_STATUS.md`](IMPLEMENTATION_STATUS.md); implementation gaps do not implicitly narrow this design.

Native Codex CLI/Desktop가 대화 UI와 SSOT를 계속 소유하고 Baton이 투명 프록시로만 동작하는 별도 모드는
canonical runtime과 ownership 계약이 다르다. 해당 모드에서 발견된 provider namespace 결함과
`model_provider=openai` + `openai_base_url=<Baton>` 제안은
[`CODEX_NATIVE_PROXY_SSOT_DECISION.md`](CODEX_NATIVE_PROXY_SSOT_DECISION.md)에 기록한다.

At the current Preview boundary:

- the canonical domain, SQLite/WAL store, fork/replay/idempotency, REST/SSE surface, cancellation, and startup
  interruption recovery are implemented;
- a hardened Codex app-server adapter executes turns by injecting portable Baton history into a transient persisted
  native thread, allowing provider-native collaboration and archiving its parent/child threads at disposal;
- the minimal session UI is mounted, but only Codex has a registered adapter;
- Claude/Gemini adapters, cross-provider continuation, general tool execution, native import/bridges, and
  Baton-managed child execution remain incomplete;
- the UI currently exposes unsupported Claude/Gemini selections. This is an implementation defect to fix with
  capability-driven provider availability, not an intended part of the design.

## 2. Key decision

**Baton is the canonical conversation owner. Providers are turn-execution adapters.**

A transparent inference proxy is insufficient as the canonical layer. Native clients do not reliably expose a common session ID in requests, and provider payloads do not contain all local tool, approval, filesystem, and UI state. Native session files are also private, versioned implementation details with incompatible schemas.

Therefore:

1. Baton stores provider-neutral semantic history and execution events.
2. A provider adapter renders that history into a native request.
3. The adapter normalizes the native stream back into Baton events.
4. Provider-specific continuation data is stored as opaque binding data and is never interpreted by the common core.
5. Native session import/export and proxy capture are compatibility bridges, not the source of truth.
6. Provider-native child agents may run only when declared by the adapter; their lifecycle is private audit data,
   not Baton-owned canonical child lineage.

This follows the useful boundaries in Codex: conversation `Thread`, user operation `Turn`, structured `Item`, a storage-neutral `ThreadStore`, and explicit start/resume/fork operations. Codex's app-server is also designed as a product-integration boundary rather than a terminal-only protocol.

## 3. Domain model

### 3.1 Session and thread

```text
Session (one user task / conversation tree)
├─ Thread A (linear branch)
│  ├─ Turn 1: Claude
│  ├─ Turn 2: Codex
│  └─ Turn 3: Gemini
└─ Thread B (forked from A at Turn 1)
   └─ Turn 2b: Codex
```

- A **session** groups a logical conversation tree.
- A **thread** is one linear semantic branch.
- A **turn** selects its own provider/model. Provider is deliberately not a session identity.
- A **fork** creates a new thread with a parent thread and fork-point reference.
- Switching provider continues the same thread; comparing alternatives creates a fork.

### 3.2 Durable records

All IDs use UUIDv7 so they are globally unique and approximately time ordered.

#### `sessions`

| Field | Meaning |
|---|---|
| `id` | Canonical session ID |
| `title`, `preview` | User-facing derived metadata |
| `active_thread_id` | Current branch |
| `project_key`, `cwd` | Optional project context; cwd is not identity |
| `created_at`, `updated_at`, `archived_at` | Lifecycle |
| `schema_version` | Migration boundary |
| `metadata_json` | Small extension data only |

#### `threads`

| Field | Meaning |
|---|---|
| `id`, `session_id` | Branch identity and owner |
| `parent_thread_id` | Source branch for a fork |
| `fork_turn_id`, `fork_item_id` | Exact history cut |
| `revision` | Optimistic concurrency token |
| `status` | `idle`, `running`, `blocked`, `failed`, `archived` |
| `instruction_snapshot_json` | Canonical instruction/policy snapshot |
| `created_at`, `updated_at` | Lifecycle |

#### `turns`

| Field | Meaning |
|---|---|
| `id`, `thread_id`, `sequence` | Stable ordered operation |
| `provider`, `model` | Executor selected for this turn |
| `status` | `queued`, `running`, `waiting_tool`, `completed`, `cancelled`, `failed` |
| `client_request_id` | Idempotency key |
| `started_at`, `completed_at` | Lifecycle |
| `usage_json`, `error_json` | Normalized accounting/failure |

#### `items`

Append-only event log with a unique `(thread_id, sequence)` constraint.

| Field | Meaning |
|---|---|
| `id`, `thread_id`, `turn_id`, `sequence` | Stable order |
| `type` | Provider-neutral item type |
| `role` | `user`, `assistant`, `system`, `tool`, or null |
| `content_json` | Normalized portable content |
| `provider`, `native_id` | Provenance, not identity |
| `visibility` | `user`, `internal`, `provider-private` |
| `created_at` | Timestamp |

Initial item types:

- `message` with ordered content parts (`text`, `image_ref`, `file_ref`, `citation`);
- `reasoning_summary` (only provider-exposed summaries, never reconstructed hidden reasoning);
- `plan`;
- `tool_call` and `tool_result` with canonical call ID plus native ID;
- `command_execution`;
- `file_change`;
- `web_search`;
- `approval_request` and `approval_response`;
- `compaction`;
- `error` and `diagnostic`.

Large media and tool output live in an artifact store and are referenced by digest. They are not duplicated into every event.

#### `provider_bindings`

| Field | Meaning |
|---|---|
| `thread_id`, `provider` | Binding owner |
| `native_thread_id`, `native_response_id` | Optional remote/native continuation IDs |
| `synced_revision`, `context_digest` | Exact canonical context freshness and compatibility |
| `model_family` | Compatibility check |
| `opaque_state_encrypted` | Signatures, response IDs, and other provider-private data |
| `capabilities_json` | Snapshot used when the turn ran |
| `updated_at`, `invalidated_at` | Lifecycle |

An account ID may be recorded in execution telemetry, but never in the binding key. Account rotation must not split a conversation.
Until at-rest encryption is configured, the implementation must reject non-null opaque state rather than storing it
in plaintext. Native IDs and non-secret compatibility metadata may still be stored.

## 4. Portable vs provider-private state

| State | Portable between providers | Handling |
|---|---|---|
| User/assistant visible text | Yes | Normalize as message parts |
| Images/files | Conditional | Artifact reference + adapter capability check |
| Completed tool call/result | Yes, semantically | Preserve canonical and native call IDs |
| Open tool loop | **No** | Pin provider until resolved or cancel it |
| System/developer instructions | Yes, with role mapping | Canonical instruction stack, adapter renderer |
| Visible reasoning summary | Yes | Mark provenance; treat as untrusted context |
| Hidden reasoning/signature | **No** | Encrypted opaque binding only |
| Remote response/conversation ID | **No** | Same-provider optimization only |
| Native compact checkpoint | **No** | Same-provider execution view only; keep the full visible ledger |
| Approval/process/UI state | Usually no | Store Baton approval event; native UI state is not imported |

Provider switching is allowed only when the current turn is terminal and has no unresolved tool call. On a switch, Baton materializes context from portable items. It never sends Claude thinking signatures to Gemini, Gemini thought signatures to OpenAI, or any provider's opaque continuation token to another provider.

## 5. Provider adapter contract

```ts
interface SessionProviderAdapter {
  readonly provider: 'claude' | 'codex' | 'gemini'

  capabilities(model: string): Promise<ProviderCapabilities>
  validate(request: CanonicalTurnRequest, snapshot: ThreadSnapshot): ValidationResult
  materialize(request: CanonicalTurnRequest, snapshot: ThreadSnapshot): NativeTurnRequest
  execute(request: NativeTurnRequest, signal: AbortSignal): AsyncIterable<NativeEvent>
  normalize(event: NativeEvent, context: NormalizationContext): CanonicalItem[]
  extractBinding(event: NativeEvent): ProviderBindingPatch | null
  estimateContext(snapshot: ThreadSnapshot, model: string): Promise<ContextEstimate>
}
```

The core never switches on native JSON field names. Provider-specific parsing lives entirely inside the adapter package. Every adapter must publish a capability descriptor for roles, content types, tool calling, parallel tools, context size, continuation mode, and reasoning state.

### Codex adapter

- Use Codex app-server as the native execution boundary. The current Preview creates a transient persisted `thread/start`,
  replays portable Baton history with `thread/inject_items`, starts the turn with `turn/start`, and uses
  `turn/interrupt` for cancellation, and archives provider parent/child threads after completion. Baton, not the
  native thread, implements durable resume and fork.
- Map Codex Thread/Turn/Item into the canonical domain, retaining raw rollout/native IDs only in provenance or opaque binding state.
- The latest Codex source separates storage behind `ThreadStore`, loads replay history for resume/fork, and keeps a fresh `ModelClientSession` per turn. Baton should copy these boundaries, not Codex's exact Rust schema.
- `model_provider` and remote response IDs are execution details; Baton history remains reconstructable without them.
- The Preview deliberately disables approval, shell, MCP, and plugin surfaces. Native multi-agent collaboration is
  exposed as provider-managed execution and normalized into Baton-private audit events; it is not canonical child lineage.
  The adapter also normalizes text, plan, reasoning summary, usage, and error events.

### Claude adapter

- Render the canonical history into the stateless Messages API message array.
- Preserve native `tool_use`/`tool_result` IDs for a live Claude tool loop.
- Preserve `thinking`, `redacted_thinking`, and signatures exactly in the Claude binding when required. They are opaque and not portable.
- On provider switch, use only visible output and portable completed tool results.

### Gemini adapter

Gemini is included in the interface, schema enum, fixtures, and contract tests from phase 1 even before an account/provider route is enabled.

- Support both server-side continuation (`previous_interaction_id`) and stateless full-history materialization, with Baton remaining canonical in both modes.
- Preserve thought/tool signatures and native call IDs exactly for same-provider continuation.
- Never merge or reorder signed parts.
- Store signatures as provider-private encrypted binding state; portable visible summaries remain normal items.
- Prefer the current Interactions API for a new adapter, but keep transport-specific rendering behind the adapter so Generate Content compatibility can be added without domain changes.

## 6. Child execution ownership

Canonical ownership is broken if an adapter silently treats provider-native children as Baton-owned work. An adapter may
instead declare **provider-native mode**: Codex manages the child sessions, Baton audits collaboration lifecycle events,
and no canonical lineage, budget, replay, or join guarantee is claimed.

### 6.1 Task taxonomy

The word "task" is overloaded and must not drive policy by name alone.

| Kind | Examples | Policy |
|---|---|---|
| Plan/progress metadata | Claude `TaskCreate`/`TaskUpdate`, Gemini tracker/todo tools | Allowed; normalize as canonical plan/task items |
| Ordinary tool execution | Shell command, file edit, MCP read | Allowed by the turn's tool and approval policy; record as items |
| Child model execution | Codex subagent, Claude `Agent`, Gemini agent, agent team, remote agent task | Codex may declare provider-native audit mode; otherwise denied until Baton-managed execution exists |
| Background process | Compiler/server launched by a shell tool | Track as a leased tool process; it is not a conversation, but it may not launch an AI agent CLI |

### 6.2 Provider enforcement

Prompt instructions are not an enforcement boundary. Each adapter must either remove native child capability or explicitly
declare and audit provider-native delegation before the turn starts.

| Adapter | Required managed-mode configuration | Evidence/notes |
|---|---|---|
| Codex | Enable supported multi-agent features, declare exposed collaboration tools in the handshake, use a non-ephemeral parent thread, audit collaboration items, and archive parent/child threads at disposal | Native children remain provider-managed and must not be represented as Baton child executions. |
| Claude | With Agent SDK, exclude or disallow `Agent`; with managed CLI, deny the `Agent` tool. Do not enable experimental agent teams. Disable background tasks when the adapter does not support their lifecycle. | `Agent` (formerly `Task`) creates a separate subagent; `TaskCreate` and related task-list tools do not. |
| Gemini | Set `experimental.enableAgents = false`; optionally add policy-engine denies for agent virtual tools as defense in depth | Gemini CLI agents are enabled by default in preview and run with separate context. |

The adapter startup handshake records a capability snapshot. Disabled adapters must expose no native agent tools;
provider-native adapters must declare a non-empty tool set. Inconsistent declarations fail closed before user input is sent.

Native-tool removal alone is insufficient because a model with shell access could run `codex`, `claude`, `gemini`, or an equivalent script. Baton therefore owns a **Child Execution Gate**:

1. shell/process policy blocks known AI-agent CLIs and agent-starting commands in managed turns;
2. MCP/app tools declare `spawns_execution`; those tools are denied unless Baton grants a scoped capability;
3. only Baton-issued child-execution capabilities may cross the gate;
4. every allowed child receives a canonical ID, parent edge, provider/model, budget, permissions, working directory, and cancellation lease before it starts;
5. every child event is appended to the same canonical session tree and its terminal result is explicitly joined into the parent.

### 6.3 Baton-managed delegation

Controlled delegation is a later execution mode, not a provider escape hatch. The provider sees provider-neutral Baton tools:

```text
baton.spawn_child
baton.send_child
baton.wait_child
baton.cancel_child
baton.list_children
```

`baton.spawn_child` creates a child thread/execution through the same `SessionStore` and adapter contracts as a root turn. The request declares purpose, history cut, provider/model preference, allowed tools, token/time budget, and maximum depth. Baton may reject it because of policy, quota, concurrency, or unsupported capabilities. Providers never receive credentials or native IDs with which to resume the child outside Baton.

The Codex implementation uses `delegation_mode: 'provider-native'`; other adapters remain `disabled`. A future
`baton-managed` mode may enable canonical child tools. Provider-native execution is deliberately opaque beyond its audit trail.

### 6.4 Durable child execution records

Add an `executions` record separate from semantic `turns`:

| Field | Meaning |
|---|---|
| `id`, `session_id`, `thread_id`, `turn_id` | Canonical execution identity |
| `parent_execution_id`, `spawn_item_id` | Exact parent and delegation edge |
| `kind` | `root_turn` or `child_turn` |
| `provider`, `model`, `adapter_version` | Executor provenance |
| `status` | `queued`, `running`, `waiting`, `completed`, `cancelled`, `failed`, `interrupted` |
| `policy_snapshot_json` | Tools, approvals, cwd, environment, depth, and capability grant |
| `budget_json`, `usage_json` | Token, time, cost, and concurrency limits/consumption |
| `lease_expires_at`, `started_at`, `completed_at` | Recovery and lifecycle |

A child execution cannot outlive its lease without renewal. Cancellation propagates down the canonical execution tree. Crash recovery marks orphaned running executions `interrupted` before any retry, and retries receive new execution IDs linked to the original.

## 7. Context construction and compaction

The append-only canonical history is never destructively shortened. Before each turn, a context builder creates a provider/model-specific view:

1. resolve the thread lineage and fork cut;
2. collect canonical instructions and portable items;
3. include same-provider opaque blocks only when the binding is compatible;
4. estimate tokens with the selected adapter;
5. if necessary, select the newest valid `compaction` item and uncovered suffix;
6. render roles, tools, content, and attachments into the native request;
7. record a hash of the materialized input for audit/replay tests.

A compaction item records its covered item range, generating provider/model, prompt version, visible summary, and source hash. It is a derived view, not a replacement for history.

The implemented V1 keeps this boundary deterministic:

- the canonical source items remain append-only; compaction never edits or deletes them;
- each artifact binds the exact source prefix, prior artifact, portable delta, terminal turn receipts, prompt version, generator identity, and hashes;
- the provider receives the newest valid artifact plus the uncovered suffix, while covered provider-private continuation is retired rather than summarized or replayed;
- one authoritative head per thread advances by compare-and-set;
- reservation, orphan recovery, and lease acquisition occur in one `BEGIN IMMEDIATE` transaction before provider generation;
- a queued orphan or expired competing lease becomes a durable failed receipt before another generation contract can own the same frontier;
- an intact competing lease is never preempted, and incomplete/cyclic artifact chains fail closed;
- first-turn oversize and post-compaction oversize are rejected before an unsafe provider request.

Imported native sessions use the same display/execution separation. Codex `compacted.replacement_history`
and Claude `compact_boundary` + `isCompactSummary` are retained as hidden provider-private checkpoint
items at their native frontier. The transcript continues to render the complete portable import, while
same-provider execution starts at the newest compatible checkpoint and appends only its uncovered suffix.
A checkpoint is never replayed to a different provider. If no compatible native checkpoint exists, Baton
uses its own derived compaction path; safe leading import items with `turn_id = NULL` are valid compaction
sources as long as their tool state is resolved.

Cache identity is separate from compaction identity. Baton derives a stable, non-reversible cache key from the installation secret and canonical thread ID. The same conversation reuses it across turns; different Baton conversations cannot alias it. Provider-private credentials and continuation bytes are not inputs to that key.

### 7.1 Model changes and context downshifts

A model change never creates a second conversation owner. The canonical thread and its append-only ledger remain the only SSOT; each provider/model receives a derived execution view sized for the model selected for that turn.

- Resolve the target model's advertised context window first, then its maintained provider/model default, and use the conservative fallback only for an unknown model.
- If the current materialized view fits the target budget, execute from the same canonical thread without rewriting history.
- If a smaller target model cannot accept that view, compact before creating the turn. Large first-time summaries are folded through bounded chronological chunks rather than sent as one oversized summarization request.
- Compaction artifacts remain derived and reproducible. Their source frontier, hashes, generator provider/model/version, and prior artifact are recorded; changing models does not mutate or fork the source history.
- If compaction cannot produce a view that fits, do not issue the provider request. Persist a structured `context_input_too_large` blocked reason and show the required and usable token estimates in the conversation UI.

Derived context is an artifact pool, not a thread-global replacement head. Each artifact branch is keyed by a versioned provider/budget contract (`provider`, usable input budget, summary budget, estimator version, and summary-prompt version). The exact target model is recorded as generator provenance, but compatible models may reuse a branch when their effective contract is identical.

- Each `(thread_id, view_key)` has an independent compare-and-set head. A 258K view cannot advance or supersede a 1M view.
- Long hierarchical summaries heartbeat their durable generation lease. A crashed worker remains reclaimable after lease expiry, while a healthy multi-chunk generation cannot lose its artifact merely because total provider latency exceeds the initial lease interval.
- Each chronological chunk is retried once, with identical bytes and no tools, for a narrowly classified transient stream disconnect. Permanent provider failures still fail closed; successful earlier chunks remain in the in-memory fold so a last-chunk disconnect does not immediately restart the whole fold.
- Summary-call input is capped independently of the target model window (104K usable, approximately 72K prompt data in V1). A large target model therefore increases the number of bounded folds instead of creating a single prompt that cannot finish inside the summary turn wall-clock limit.
- Each tool-free summary fold has an explicit five-minute wall-clock cap. This accommodates high-effort reasoning on the capped prompt without imposing a wall-clock ceiling on an ordinary agent turn.
- The planner first subtracts instructions, current input, tool schemas, reserved output, and safety headroom. If the immutable full ledger remains below the target model's compaction trigger, it is always preferred over every lossy artifact.
- Otherwise the planner may use or extend only the target view branch. The chosen `full | artifact_id` is frozen in the execution budget receipt before launch and copied into the immutable execution-context manifest; a later concurrent head advance cannot change an in-flight execution.
- Downshift therefore creates or reuses a smaller derived view without deleting canonical items. Upshift re-evaluates the immutable ledger and restores full history whenever it fits, or independently selects/creates the highest-fidelity artifact for the larger budget.
- A single upcoming input that exceeds the usable budget is not compactable and fails before turn creation. A derived-state load failure may fall back to full history only when that full selection still satisfies the already resolved target budget.

Maintaining independent conversations per input size is rejected: it would split Goal state, history, archive state, and continuation provenance into competing SSOTs. An explicit user fork remains valid when the user wants a genuinely independent branch, but it is not an automatic response to model downshift.

## 8. Consistency and failure rules

- SQLite in WAL mode is the first storage implementation, behind a `SessionStore` interface.
- Creating a turn and appending its initial user item is one transaction.
- Item sequence allocation and projection updates happen in the same transaction.
- `client_request_id` makes retries idempotent.
- `expected_revision` prevents two clients from starting conflicting turns.
- At most one active turn lease exists per thread.
- Stream disconnect does not imply provider cancellation; reconnect uses an event cursor.
- Provider events are appended before being exposed to subscribers when durability matters.
- Duplicate native events are ignored using `(provider, native_id, event_kind)` uniqueness.
- A crash leaves a running turn recoverable as `interrupted`; the next startup reconciles or finalizes it.

## 9. API surface

Keep the domain independent of transport. The implemented BFF surface is REST plus SSE:

```text
POST   /baton/v1/sessions
GET    /baton/v1/sessions
GET    /baton/v1/sessions/:sessionId
GET    /baton/v1/threads/:threadId
POST   /baton/v1/threads/:threadId/fork
POST   /baton/v1/threads/:threadId/turns
GET    /baton/v1/threads/:threadId/items?after=<cursor>
GET    /baton/v1/threads/:threadId/events?after=<cursor>   (SSE)
POST   /baton/v1/turns/:turnId/cancel
```

The following target APIs are not implemented yet:

```text
POST   /baton/v1/executions/:executionId/children
GET    /baton/v1/executions/:executionId/children
POST   /baton/v1/executions/:executionId/cancel
POST   /baton/v1/sessions/import
```

Turn creation includes `provider`, `model`, input parts, `client_request_id`, and `expected_revision`. The response returns stable Baton IDs before streaming begins.

An app-server-compatible JSON-RPC bridge may be added for Codex-oriented integrations, but it must translate into this domain service rather than becoming a second session store.

## 10. Native client integration boundary

Automatic base-URL proxy configuration alone does **not** make native sessions shareable.

| Integration | Expected fidelity |
|---|---|
| Baton UI/API uses common session service | Full |
| Codex app-server bridge/sidecar | High; structured Thread/Turn/Item |
| Claude/Gemini CLI wrapper with explicit `BATON_SESSION_ID` | High for portable events |
| Import native session files | Migration only; version-sensitive |
| Transparent provider request capture | Partial/lossy; no reliable local tool/UI state |
| Unmodified native Desktop session UI | No guaranteed shared-session behavior |

Native bridges must be optional. Unsupported native fields are stored only as versioned opaque import data and cannot leak into the common core schema.

## 11. Delivery plan

### Phase 0 — contract and persistence — **core implemented; Claude/Gemini fixtures pending**

- Add common IDs, domain types, `SessionStore`, SQLite migrations, and repository tests.
- Add Claude/Codex/Gemini adapter interfaces and capability fixtures.
- Add execution records, delegation-disabled policy, and adapter startup capability checks.
- No change to existing account rotation, proxy routing, or client auto-configuration.

Exit: create/read/resume/fork/replay produces deterministic canonical history after restart.

### Phase 1 — Codex vertical slice — **Preview implemented; live exit test pending**

- Implement the Codex adapter through app-server.
- Launch it with provider-native multi-agent enabled and declare collaboration tools.
- Audit collaboration events and retain shell/MCP execution-gate tests.
- Persist streamed items and reconnect by cursor.
- Add one minimal Baton session UI flow.

Exit: a Codex conversation survives BFF restart and resumes from Baton storage.

Current evidence covers store reopen/replay, orchestrator behavior, router/SSE contracts, adapter hardening and
normalization, and a live app-server handshake smoke test. A real model turn followed by BFF restart and continued
execution is still required to close this phase completely.

### Phase 2 — Claude and provider switching — **not implemented**

- Implement Messages rendering, tool loops, thinking-block binding, and context estimation.
- Remove Claude `Agent`/team execution from the managed tool surface while preserving plan tasks.
- Enable provider selection per new turn and explicit switch warnings.

Exit: a completed Claude turn can continue in Codex and vice versa with identical portable history.

### Phase 3 — Gemini-ready adapter — **not implemented**

- Implement Interactions transport, thought-signature handling, function calls, and golden fixtures.
- Keep Gemini native agents disabled in managed mode while preserving tracker/task metadata.
- Keep live enablement behind provider/account availability.

Exit: offline contract tests cover Gemini switching, tools, signed parts, compaction, and replay; enabling an account requires configuration only.

### Phase 4 — native bridges and migration — **not implemented**

- Follow the normative migration/recovery boundary in
  [`NATIVE_SESSION_CONTINUITY_BRIDGE.md`](NATIVE_SESSION_CONTINUITY_BRIDGE.md).
- The experimental [`../tools/native-session-handoff/`](../tools/native-session-handoff/) package provides a
  one-shot operator workflow only; it is not the canonical import API and does not close this phase.
- Add explicit CLI session wrappers/sidecars.
- Add versioned, read-only importers for supported native session formats.
- Show provenance and portability loss before import/switch.

Exit: native imports never mutate originals and produce a validation report.

The exit also requires mutually exclusive canonical/native authority epochs, one steady-state writer per logical
work, durable authority-transition/quiescence handling, canonical source-cut replay, approval-bound native mutation,
manual-package evidence separation, stale-approval rejection, and uncertain/diverged-apply reconciliation.

### Phase 5 — Baton-managed delegation — **foundation only; execution disabled**

- Implement provider-neutral child tools and bounded execution trees.
- Add budget, depth, concurrency, approval, lease, join, and cancellation policies.
- Keep provider-native execution distinct; Baton-managed child turns use ordinary Baton adapters.

Exit: every child action replays from Baton storage, no provider-native child session is required, and killing Baton cannot leave an unowned agent running.

## 12. Verification matrix

Current automated coverage includes SQLite reopen/replay, exact fork cuts, transactional rollback, idempotent turns
and provider events, startup interruption recovery, binding invalidation, router validation/status mapping, resumable
SSE cursors, orchestrator retry deduplication, Codex JSONL framing/normalization/hardening/cancellation, and native
child-capability rejection.

The full target matrix below contains both covered and pending cases; per-item status is tracked in
[`IMPLEMENTATION_STATUS.md`](IMPLEMENTATION_STATUS.md):

1. canonical append/replay is byte-stable after restart;
2. fork lineage stops at the exact item cut;
3. duplicate turn and provider events remain idempotent;
4. one provider's opaque state never reaches another adapter;
5. completed tool calls switch providers; unresolved tool calls are rejected;
6. Claude/Codex/Gemini golden histories render without role/order loss;
7. Gemini signed parts and Claude thinking blocks round-trip unchanged on same-provider continuation;
8. compaction covers an exact immutable range and can be regenerated;
9. cancellation, stream disconnect, crash recovery, and concurrent turn conflicts are deterministic;
10. account rotation changes do not change Baton session identity;
11. provider-native adapters declare and audit child-agent tools while disabled adapters expose none;
12. shell and MCP escape attempts fail without a Baton capability;
13. plan/task metadata remains usable without spawning a child model;
14. child cancellation, budget exhaustion, crash recovery, and parent join replay deterministically.

End-to-end acceptance scenario:

1. start a session with Claude and complete a tool call;
2. continue the same thread with Codex and verify it sees the portable result;
3. fork before the Codex turn and run Gemini;
4. restart Baton;
5. resume both branches and compare stored event hashes and visible transcript.

## 13. Material risks

- Native Desktop applications may not expose a supported external session protocol; base-URL configuration cannot solve that.
- Provider role and tool semantics will never be perfectly identical. Capability negotiation must fail explicitly rather than silently dropping content.
- Opaque reasoning signatures can be large and sensitive. Encrypt them at rest, exclude them from logs/search, and delete them with the session.
- Importers track native format versions and must fail closed on unknown versions.
- Cross-provider continuation preserves semantic conversation, not hidden reasoning or native UI/process state.
- Provider updates may rename or add agent-spawning tools. Capability snapshots and fail-closed adapter conformance tests must detect unknown execution surfaces.
- Shell policies cannot classify every wrapper script statically. The production boundary should prefer Baton-owned tool execution with explicit process capabilities over unrestricted inherited shell access.

## 14. Decisions

The design fixes these implementation choices:

1. Canonical mode: Baton owns sessions; transparent capture remains a compatibility feature.
2. Storage: local SQLite/WAL behind `SessionStore`.
3. Provider selection: per turn; switching only at terminal turn boundaries.
4. First vertical slice: Codex app-server, then Claude, with Gemini contracts present from phase 0.
5. Native Desktop support: import/bridge on a best-effort basis, not promised as transparent session sharing.
6. Codex delegation: provider-native with private audit/archive and no canonical child guarantees.
7. Future delegation: Baton-managed child executions with canonical lineage and policy.

## References

- [Codex app-server integration guide](https://learn.chatgpt.com/docs/app-server.md)
- [Codex `ThreadStore` at the reviewed commit](https://github.com/openai/codex/blob/5c0e582c59892dbec89af78ae62c784d3da6c9cb/codex-rs/thread-store/src/store.rs)
- [Codex app-server Thread/Turn data at the reviewed commit](https://github.com/openai/codex/blob/5c0e582c59892dbec89af78ae62c784d3da6c9cb/codex-rs/app-server-protocol/src/protocol/v2/thread_data.rs)
- [Codex subagents](https://learn.chatgpt.com/docs/agent-configuration/subagents.md)
- [Codex collaboration tool registration at the reviewed commit](https://github.com/openai/codex/blob/5c0e582c59892dbec89af78ae62c784d3da6c9cb/codex-rs/core/src/tools/spec_plan.rs)
- [Claude Messages API](https://platform.claude.com/docs/en/api/messages/create)
- [Claude extended thinking and opaque signatures](https://platform.claude.com/docs/en/docs/build-with-claude/extended-thinking)
- [Claude Code subagents](https://code.claude.com/docs/en/sub-agents)
- [Claude Code tools reference](https://code.claude.com/docs/en/tools-reference)
- [Claude Code agent teams](https://code.claude.com/docs/en/agent-teams)
- [Gemini Interactions API](https://ai.google.dev/gemini-api/docs/interactions-overview)
- [Gemini thought signatures](https://ai.google.dev/gemini-api/docs/thought-signatures)
- [Gemini CLI subagents](https://geminicli.com/docs/core/subagents/)
