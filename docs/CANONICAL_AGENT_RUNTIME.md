# Canonical agent runtime

> Status: **V1 PARTIALLY IMPLEMENTED (2026-07-19).** The provider-neutral model/tool loop,
> durable tool coordinator, bounded execution, cancellation precedence, and crash recovery are
> active. Approval/user-input waits, context compaction, and a verified workspace-only command
> sandbox remain outside the implemented subset.

## 1. Purpose

Baton owns the canonical conversation, work state, tool audit trail, and termination decision.
A provider adapter executes the current model round; it does not own the conversation or create
untracked child work.

One user request creates one canonical turn. A turn may contain many model rounds and tool calls:

```text
canonical turn
  -> model round
  -> zero or more tool calls
  -> Baton records calls before execution
  -> Baton executes tools and records results
  -> provider receives the results
  -> next model round
  -> final assistant response
```

A final assistant response ends the turn only when the provider has no pending client tool call,
server continuation, approval, or required user input. A long-running Goal may enqueue another
canonical turn after this boundary; it never changes what a turn means.

Provider readiness is bounded before turn creation (30 seconds by default). Codex also bounds its
individual app-server `initialize` and `config/read` preflight requests and terminates a stalled
preflight process; shutdown never waits on an unresolved initialization promise.

## 2. Ownership boundaries

### Baton owns

- canonical sessions, threads, turns, items, tool calls, tool results, and usage;
- tool policy, workspace roots, approvals, timeouts, idempotency, and output limits;
- work and Goal status, budgets, cancellation, crash recovery, and automatic continuation;
- provider selection at a safe turn boundary;
- every provider-private identifier required to continue an in-flight tool exchange.

### A provider adapter owns

- translating canonical history and tool schemas into the provider wire format;
- preserving provider-private continuation blocks and identifiers without rewriting them;
- translating provider stop reasons and events into the canonical contract;
- repeating model rounds inside the current turn until a valid terminal boundary.

### A provider adapter must not

- create an untracked native child task or subagent;
- execute an unregistered native shell, plugin, app, MCP server, or tool;
- silently continue after a Baton limit, cancellation, or policy denial;
- claim completion for truncation, refusal, malformed output, or a pending tool exchange.

Codex currently exposes `update_plan` unconditionally and provides no supported switch to remove it.
Baton permits this one provider-local metadata tool because it has no external side effect or child
execution and normalizes its output into canonical `plan` items. It is recorded in adapter
enforcement evidence. This exception does not permit native shell, web search, MCP, plugin, app, or
subagent tools; those remain disabled and fail-closed.

## 3. Tool contract

Every exposed tool has a stable name, description, JSON input schema, side-effect class, timeout,
and output cap. The same definitions are exposed through each provider protocol.

External side effects cannot be part of a database transaction. Baton therefore uses a durable
write-before-execute state machine for each invocation:

1. validate the canonical turn and capability grant;
2. append a `tool_call` item with a Baton call ID and provider call ID;
3. move the turn to `waiting_tool`;
4. execute the tool once;
5. append one `tool_result`, including denials and failures;
6. return the result through the same provider tool-call ID;
7. move the turn back to `running` when no tool remains active.

Read-only independent calls may run in parallel. Mutating calls and calls with data dependencies run
in canonical order. A provider response containing multiple client tool calls is one batch: Baton
preserves the assistant response and call order, executes according to side-effect dependencies, and
returns exactly one result for every call through the original provider IDs. Protocols that require
one user-side result message receive all results in that one message and in original call order.

A call left without a result after a crash or result-persistence failure is `interrupted`. If its side effect may have happened,
Baton marks the turn interrupted and blocks any owning Goal with
`reason=unknown_mutation_outcome`; automatic continuation is forbidden until explicit user
reconciliation and resume. Read-only or explicitly idempotent calls may be retried only under a new
call ID and a documented replay policy.

Provider-native tool IDs and structured continuation blocks are stored as provider-private data when
the adapter protocol exposes them durably.
The UI consumes a normalized projection and never reconstructs wire history from the projection.
Portable user/assistant messages, summaries, reasoning summaries, plans, and tasks use the same
ordered textual projection for every adapter; switching provider cannot silently discard those work
state items.
Provider assistant blocks that precede a tool call, including hidden/reasoning blocks, are replayed
without structural edits. A server-requested continuation replays the exact assistant content and
the same tool schema; it is bounded by the host's model-round limit.

## 4. Terminal mapping

| Provider outcome | Canonical result |
| --- | --- |
| final assistant output with no pending continuation | `completed` |
| client tool request | execute tool and continue the same turn |
| server-requested continuation | preserve the response and continue the same turn |
| output/context truncation | `failed` or explicit limited state; never `completed` |
| refusal | `failed` with the refusal category |
| provider hard account/usage limit | `failed/provider_usage_limit`; owning Goal becomes `usage_limited` |
| user cancellation | `cancelled` |
| process/runtime loss | `interrupted` |
| non-retryable provider error | `failed` |

Provider switching is forbidden while a tool result, server continuation, or provider-private state
is pending. It is permitted only after a terminal turn boundary.

For the app-server adapter, provider-internal request and stream retries are forced to zero. Baton is
the only retry authority. After the configured number of completed model rounds is observed, a new
dynamic tool-call ID is rejected before execution; exact replay of an already recorded call ID remains
idempotent.

Output truncation is not automatically retried as if it were a tool continuation. Context exhaustion
may compact only portable history under a versioned compaction policy; provider-private pending
blocks cannot be compacted or moved across providers. A compacted retry consumes the same turn
budget and is recorded as a canonical compaction boundary.

## 5. Minimum tool catalog

Every tool is registered as the provider protocol's ordinary function tool with the same name,
description, and `inputSchema`. Provider call IDs are copied into the canonical call and returned
unchanged. Tool responses are exactly one of
`{ success: true, content: object, metadata?: object, error: null }` or
`{ success: false, content: null, metadata?: object, error: { code, message, retryable } }`.
Unknown input properties are rejected.

All paths are UTF-8 workspace-relative paths. Baton resolves them against the execution snapshot's
`cwd`, checks lexical containment, resolves the existing target or nearest existing ancestor, checks
real-path containment, and rejects symlink/junction escape. Files are limited to 2 MiB unless a tool
states a lower limit.

| Tool | Side effect | Input schema | Successful content |
| --- | --- | --- | --- |
| `read_file` | read-only | `{path: string, offset?: integer>=0, limit?: integer 1..1048576}` | `{path, sha256, text, truncated, nextOffset}` |
| `list_files` | read-only | `{path?: string=".", maxEntries?: integer 1..500}` | `{path, entries: [{path,type,size}], truncated}` |
| `search_text` | read-only | `{query: string 1..4096, path?: string=".", glob?: string, maxResults?: integer 1..500}` | `{matches: [{path,line,column,text}], truncated}` |
| `write_file` | workspace mutation | `{path: string, content: string, expectedSha256: string|null}` | `{path, sha256, bytes, created}` |
| `replace_text` | workspace mutation | `{path: string, oldText: string, newText: string, expectedSha256: string, expectedOccurrences?: integer 1..1000}` | `{path, sha256, bytes, replacements}` |
| `run_command` | workspace command (reserved; not advertised by default) | `{argv: string[1..128], timeoutMs?: integer 1..120000}` | `{exitCode: integer|null, stdout: string, stderr: string, timedOut: boolean, truncated: boolean}` |

`read_file` offsets and limits count UTF-8 bytes and never split an invalid sequence. `write_file`
requires `expectedSha256=null` for creation and rejects an existing target; overwrite requires the
exact current digest. `replace_text` rejects a digest or occurrence-count mismatch. Both write through
a same-directory temporary file, flush it, revalidate the expected digest, and replace atomically at
the filesystem boundary.

The default `workspace_agent` capability allows only the five file tools above and only when the
session has an explicit, verified `cwd`. A session without one receives no workspace tools.
`run_command` remains unadvertised on this Windows host because termination-safe process control and
workspace-only external reads have not both been verified. Any path outside `cwd`, network request,
permission expansion, or unregistered tool is denied rather than prompted. Other capability profiles may turn a mutation into
a durable `waiting_approval` request, but can never broaden the immutable execution snapshot.
Each argv element is 1..32,768 UTF-8 bytes and the array's total is at most 128 KiB. When timeout
occurs before a process exit is observed, `timedOut=true` and `exitCode=null`; partial output is still
returned subject to the cap.

## 6. Deterministic limits

The host enforces separate counters so similarly named provider limits cannot be confused. Version 1
defaults are `32` model round trips, `128` total tool calls, `3` identical invocations, `120 seconds`
per tool, `256 KiB` tool output, `30 minutes` per turn, and `3` transient provider retries:

- maximum model round trips per turn;
- maximum total tool calls per turn;
- maximum identical tool invocations per turn;
- per-tool timeout and output-byte cap;
- turn wall-clock limit;
- bounded transient provider retries;
- optional turn token/cost budget;
- user cancellation at every wait boundary.

Limit exhaustion is a typed failure or limited state. Tool total/repetition limits are latched by the
host and cannot be converted to a successful final
assistant message. Default limits are versioned server policy and are copied into each execution's
immutable policy/budget snapshot.

Precedence is: user cancellation; unknown mutating-tool outcome; approval/user-input wait; hard
usage limit; token/cost/wall-clock/tool/model limit; non-retryable provider error; valid completion.
A higher-precedence result cannot be overwritten by a late lower-precedence event.

Within the limit class Baton gives Goal token/time boundaries and the first latched host tool limit
priority over a provider final response. Exact Codex sampling-round and combined internal retry
counts are not exposed by the current app-server protocol; the 30-minute host turn timeout and tool
limits remain authoritative, while exact `maxModelRoundTrips` and combined retry enforcement are a
documented Codex protocol gap. Claude and Gemini expose their round boundaries to Baton directly.

| Exhausted condition | Turn result | Owning Goal result | Reason code |
| --- | --- | --- | --- |
| model round trips | `failed` | `budget_limited` | `model_round_limit` |
| total/identical tool calls | `failed` | `budget_limited` | `tool_call_limit` / `tool_repetition_limit` |
| per-tool timeout | failed tool result; turn may recover | unchanged unless turn ultimately fails | `tool_timeout` |
| turn wall clock | `failed` or provider `cancelled` with typed error | `budget_limited` | `turn_time_limit` |
| turn token/cost budget | `cancelled` after safe wrap-up/interrupt | `budget_limited` | `turn_budget_limit` |
| provider retry budget | `failed` | `blocked` | `provider_retry_exhausted` |
| hard account usage limit | `failed` | `usage_limited` | `provider_usage_limit` |

## 7. Status projection

Thread status answers whether a new turn may start; it is not sufficient as the session's visible
work result. The session list derives its status from the active thread, latest turn, unresolved tool
state, and current Goal:

`queued`, `running`, `waiting_tool`, `waiting_approval`, `waiting_user`, `paused`, `blocked`,
`usage_limited`, `budget_limited`, `completed`, `failed`, `cancelled`, or `interrupted`.

Imported conversations without a Baton execution are shown as imported history, not falsely marked
completed.

The visible session state is the first matching state in this precedence list: `archived`,
`waiting_user`, `waiting_approval`, `waiting_tool`, `running`, `queued`, Goal `usage_limited`, Goal
`budget_limited`, Goal `blocked`, Goal `paused`, latest turn `failed`, latest turn `interrupted`, latest
turn `cancelled`, Goal `complete`, latest turn `completed`, imported history, then `idle`.

Approval and user-input requests are durable work states. They include a request ID, revision,
prompt, allowed response schema, expiry, and resume token. Resolving one uses compare-and-swap;
expiry or process restart does not busy-loop or silently approve it.

## 8. Recovery invariants

- Starting a turn and recording its user input is transactional and idempotent by client request ID.
- Provider events and tool events are idempotent by durable event/call ID.
- Restart recovery marks unfinished turns and calls `interrupted` before accepting new work.
- Restart recovery fail-closes a terminal turn whose Goal accounting transaction did not finish as
  `blocked/goal_accounting_interrupted`; explicit resume creates a fresh revision.
- Recovery retains the durable `goalAutomatic` execution flag and charges that turn to the automatic
  turn counter even when terminal accounting was interrupted.
- A mutating tool result is recorded before the result is returned to the provider.
- Cancellation wins over late provider completion.
- Status and Goal mutations use revisions so stale completions cannot overwrite newer user intent.

## 9. Verification matrix

Conformance requires tests for single and parallel tool batches, provider-ID round trips, tool denial
and failure, write-before-execute ordering, crash before/after mutation, cancellation races, approval
and user-input waits, server continuation, truncation, compaction, refusal, malformed results, every
limit, restart recovery, and the absence of native unregistered tools or child execution.
