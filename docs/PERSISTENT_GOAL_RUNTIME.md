# Persistent Goal runtime

> Status: **V1 IMPLEMENTED (2026-07-19).** SQLite projection/events, revision CAS, leases,
> automatic continuation, limits, recovery, Goal tools, REST API, `/goal` commands, and UI controls
> are active. Claude and Codex have deterministic mock/integration coverage; Gemini live execution
> remains unverified while its proxy authentication is unavailable.

## 1. Purpose and separation

A Goal keeps one canonical conversation working toward an explicit user objective across multiple
turns. It is separate from the agent loop: each Goal turn first runs the normal model/tool loop, then
the Goal runtime decides whether another turn may start.

There is at most one current Goal per canonical thread. Goal state belongs to Baton and works with
every provider adapter.

## 2. Data contract

`ConversationGoal` contains:

- stable Goal ID and canonical thread ID;
- objective, limited to 1..4,000 Unicode characters;
- status and status reason;
- monotonically increasing revision;
- selected provider, model, and optional effort for the next continuation;
- optional token budget, tokens used, elapsed active seconds;
- maximum automatic turns and active wall-clock duration;
- automatic turns used and consecutive no-progress count;
- created, updated, started, and completed timestamps.

`statusReason` is null or `{ code, source, message, at }`. `source` is one of `user`, `host`,
`provider`, or `model`; `code` is a stable snake-case identifier; `message` is optional sanitized
display text. A transition always replaces the entire reason. Entering `active` by create, edit, or
resume clears it. A duplicate idempotent event does not change it.

Statuses are:

- `active`: eligible for automatic continuation;
- `paused`: stopped by the user and resumable;
- `blocked`: external change or user input is required;
- `usage_limited`: provider/account availability prevents progress;
- `budget_limited`: a configured Baton limit was reached;
- `complete`: the entire objective is proven complete.

Clearing removes the current projection but appends a durable `goal_cleared` event. Historical Goal
events and turns are never rewritten.

## 3. Commands and UI

The composer recognizes commands only at the beginning of the submitted text:

- exact `/goal`: open Goal entry/status UI and do not send a chat message;
- `/goal` followed by Unicode whitespace and an objective: create or replace a Goal;
- `/goal edit`: open the editor;
- `/goal pause`: pause;
- `/goal resume`: resume;
- `/goal clear`: clear after confirmation.

`/goalx` and other names are ordinary input. Multiline objectives are allowed. Creating a Goal while
an unfinished Goal exists requires explicit replacement confirmation and creates a new Goal ID with
fresh counters. Editing keeps the Goal ID and counters.

The Goal chip/panel shows objective, status, active duration, automatic turns, tokens, remaining
budget, and the latest reason. It offers edit, pause, resume, and clear actions. A completed Goal stays
visible in the transcript/status history until a new Goal replaces the current projection.

## 4. Mutation semantics

All user mutations require the expected Goal revision.

Every canonical turn captures its initial Goal observation before provider execution as either
`(goalId, revision)` or the explicit sentinel `no_goal`. Every Goal-owned turn and scheduler lease
captures `(goalId, revision)`. `create_goal` and
`update_goal` side effects compare that pair transactionally. A stale call returns the typed
`stale_goal_revision` result and MUST NOT mutate the current Goal. Reading the Goal refreshes the
revision observed by that tool context.

- Editing an idle active Goal updates the objective and schedules continuation immediately.
- Editing during a provider round updates the Goal projection immediately. The runtime injects an
  objective-updated steering item when the adapter supports safe steering; otherwise the new revision
  applies at the next model-sampling boundary. A completion produced for an older revision cannot
  complete the newer Goal.
- Pause is committed before interruption so a late terminal event cannot restart work. Cancelling or
  interrupting a Goal-owned turn MUST first compare-and-swap `active -> paused` for the captured
  revision, revoke its scheduler lease, and then interrupt the provider. It MUST NOT auto-resume.
- Resume starts a fresh blocked/no-progress audit and schedules continuation if the thread is idle.
- Clear prevents any pending scheduler lease from starting another turn.

User cancellation follows the pause rule above. Runtime/process loss is different: recovery flushes
durable accounting, marks the turn `interrupted`, and compare-and-swaps the captured active Goal to
`blocked/runtime_interrupted`; it never auto-continues. If an unknown mutating-tool outcome exists,
the more specific `blocked/unknown_mutation_outcome` reason wins. Explicit resume is required in both
cases and starts a new turn without replaying the interrupted call.

Invalid transitions return `invalid_goal_transition` without changing revision or accounting:

| Current | Action | Next | Counter/timestamp behavior |
| --- | --- | --- | --- |
| none | create | active | new ID; counters zero; start time now |
| complete | create | active | new ID; counters zero; no confirmation |
| unfinished | replace (confirmed) | active | new ID; counters zero; old event history retained |
| active | edit | active | same ID; revision +1; usage/turns retained; no-progress zero |
| paused/blocked/usage_limited | edit | same stopped status | same ID; revision +1; counters retained; no-progress zero |
| budget_limited | edit with larger relevant limit | active | same ID; revision +1; counters retained; reason cleared |
| complete | edit | active | same ID; revision +1; counters retained; completion time cleared |
| active | pause or user cancel | paused | revision +1; active time flushed; reason set |
| paused/blocked/usage_limited/budget_limited | resume | active | revision +1; start segment now; no-progress zero; reason cleared |
| active | model complete | complete | captured revision CAS; completion time now |
| active | model blocked after audit | blocked | captured revision CAS; active time flushed |
| active | host usage limit | usage_limited | captured revision CAS; active time flushed |
| active | host budget/turn/time limit | budget_limited | captured revision CAS; active time flushed |
| any existing | clear | none | projection removed; revisioned clear event retained |

Resume from `budget_limited` requires a larger relevant limit or explicit counter reset. Pause of a
non-active Goal, resume of an active/complete Goal, model completion/block from a stopped Goal, and
create while an unfinished Goal exists are invalid.

## 5. Model tools

The provider-neutral tool set includes:

- `get_goal`: read current status, budgets, usage, and remaining budget;
- `create_goal`: create only when the user or higher-level instruction explicitly requested a Goal;
- `update_goal`: the model may set only `complete` or `blocked`.

The model cannot pause, resume, clear, or mark usage/budget limits. Those are user/host mutations.
`complete` is valid only after a requirement-by-requirement evidence audit proves that no requested
work remains. `blocked` is valid only after the same external blocker has prevented meaningful
progress for three consecutive Goal turns. Hard work, uncertainty, or partial progress is not a
blocker.

Exact schemas and results are:

- `get_goal` input: `{}`. Result: `{ goal: ConversationGoal|null, remainingTokens: integer|null }`.
  It refreshes the calling context's observed `(goalId, revision)`.
- `create_goal` input: `{ objective: string, tokenBudget?: integer>=1 }`. It succeeds only when no
  Goal exists or the current Goal is `complete`, and returns `{ goal }`. An unfinished Goal returns
  `unfinished_goal_exists`; a turn-start or `get_goal` observation of `no_goal`/complete is the CAS
  precondition, and a changed observation returns `stale_goal_revision`.
- `update_goal` input: `{ status: "complete"|"blocked" }`. It compares the calling context's last
  observed `(goalId, revision)` and returns `{ goal, finalTokensUsed }`. Missing Goal returns
  `goal_not_found`; stopped Goal returns `invalid_goal_transition`; changed ID/revision returns
  `stale_goal_revision` with the current Goal projection and performs no mutation.

The tools reject unknown properties. Tool errors use the canonical `{code,message,retryable:false}`
shape. Only `get_goal` may refresh a stale observation; `update_goal` never retries implicitly.

## 6. Automatic continuation

An `active` Goal on an idle thread acquires one scheduler lease and starts an internal continuation
turn. The internal context:

- treats the objective as user-provided task data, not higher-priority instructions;
- preserves the full objective rather than shrinking it to the current turn;
- requires current worktree/external evidence to be rechecked;
- requires explicit evidence for every named deliverable before completion;
- reports used and remaining budgets;
- instructs the model to keep the Goal active when incomplete.

Only one lease may exist for a Goal revision. A provider failure makes the Goal `blocked`; a hard
account limit makes it `usage_limited`; a Baton budget makes it `budget_limited`. A normal final
assistant response does not complete an active Goal by itself.

A durable scheduler lease is `{ leaseId, goalId, goalRevision, ownerId, acquiredAt, heartbeatAt,
expiresAt }`. Claim is one immediate transaction that requires an active Goal revision, idle thread,
and no unexpired lease. Version 1 heartbeat is every 10 seconds and expiry is 30 seconds. Reclaim of
an expired lease requires the same checks and no active canonical turn. Starting the turn verifies
the lease tuple transactionally, stores `goalId` and `goalRevision` on the turn, then releases the
lease; the active-turn uniqueness constraint prevents another claim. Terminal accounting and model
Goal mutations compare the turn's captured tuple, so stale completion cannot affect a newer Goal.

If recovery finds a mutating tool with unknown outcome, it marks the call and turn `interrupted` and
compare-and-swaps the captured active Goal to `blocked` with
`reason=unknown_mutation_outcome`. No continuation is scheduled until the user reconciles the side
effect and explicitly resumes.

## 7. Runaway prevention

Compatibility behavior is bounded by Baton-owned safeguards:

- optional token budget;
- mandatory maximum automatic Goal turns;
- mandatory active wall-clock limit;
- per-turn model/tool limits from the canonical agent runtime;
- deterministic no-progress fingerprints and a consecutive threshold;
- bounded retry budgets;
- user pause/cancel available during every turn.

Version 1 defaults are `24` automatic Goal turns, `2 hours` of active wall-clock time, and `3`
consecutive no-progress turns. These are mandatory even when no token budget is supplied. Limit
precedence follows the canonical agent runtime; the first committed higher-precedence terminal reason
wins. A user may resume a limited Goal only after explicitly accepting a reset or larger relevant
limit, which increments the Goal revision and restarts its audit counters.

The no-progress fingerprint uses canonical evidence available after a turn: repository state digest
when available, completed tool-result digests, plan/task state, test/verification evidence, and Goal
revision. Provider prose alone is not progress. Reaching a limit records the exact reason and stops;
it never marks the Goal complete.

Goal limit mapping is deterministic: automatic-turn and active-time exhaustion produce
`budget_limited` with `goal_turn_limit` or `goal_time_limit`; token exhaustion produces
`budget_limited/goal_token_limit`; three unchanged progress fingerprints produce
`blocked/no_progress`; provider/account hard limits produce `usage_limited/provider_usage_limit`;
non-retryable provider failure produces `blocked/provider_failure`; unknown mutation recovery
produces `blocked/unknown_mutation_outcome`.

## 8. Accounting

Goal tokens count uncached input plus output; cached input is not charged when the provider reports it
separately. Active elapsed time is accumulated only while an active Goal turn or idle-continuation
lease is running. Accounting is committed before an external Goal mutation and at every terminal turn
boundary.

Provider usage is flushed whenever a durable usage update is received, and elapsed/tool progress is
flushed after every tool completion. Replayed duplicate events are idempotent. A crash may
under-count only the interval after the last durable flush; it must never double-count a replay.

Token budget crossing does not pretend the current work succeeded. Baton marks `budget_limited`,
stops scheduling substantive continuation, and asks the current turn to summarize progress when a
safe steering boundary remains.

## 9. Provider neutrality and switching

The Goal never belongs to a provider. The selected provider/model is an execution preference for the
next safe turn. A user may change it between turns. Baton must not switch provider while an in-flight
tool call or provider-private continuation is pending.

All Goal tools, statuses, accounting, revisions, and events have identical semantics regardless of
which adapter executes the turn.

## 10. Verification matrix

Conformance requires tests for create/read/edit/replace, pause/resume/clear, completion and three-turn
blocked audit, stale revision rejection, one lease per revision, pause-before-cancel, restart during
idle scheduling, provider failure and usage limits, token/turn/time/no-progress limits, accounting
idempotency, unknown mutation recovery, provider switching only at a safe boundary, and automatic
continuation through every supported provider adapter.
