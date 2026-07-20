# Work-Centric Orchestration Design V4

Status: accepted target design after independent adversarial review, not an implementation claim

Version: 4

Date: 2026-07-20

Supersedes: `WORK_CENTRIC_ORCHESTRATION_DESIGN_V3.md`

## 1. Decision summary

Baton uses a work-centric orchestration model. User work is stable. Agents, providers, models, and
accounts are replaceable executors.

The authority model is single-writer, multi-proposer, and multi-verifier:

- agents and plugins submit semantic proposals;
- reviewers submit verdict receipts;
- machine gates submit deterministic evidence;
- the Baton control plane is the only canonical state writer;
- the control plane applies frozen policies but does not invent semantic judgments;
- provider-native subagent or team state is not canonical in Baton-managed mode.

The design begins with a flat WorkSet and durable execution. A versioned WorkGraph is activated only
when finite dependencies, decisions, integration, validation, or replanning require it.

No child execution may be enabled until Goal completion ownership, result acceptance, event
projection, launch uncertainty, and stale revision fencing are implemented fail-closed.

## 2. Corrected conceptual model

```text
Conversation and Goal
  -> Objective Binding
  -> Requirement Ledger
  -> Run
  -> Proposal Journal
  -> WorkSet or WorkGraph Revision
  -> Assignment and Attempt
  -> Result Candidate
  -> Verification and Acceptance
  -> Accepted Artifact
  -> Integration
  -> Completion Proposal
  -> Completion Attestation
```

The following identities are deliberately separate:

- `Conversation` is the user-visible canonical history;
- `Goal` is an optional persistent objective across turns;
- `Run` is one bounded automation attempt for an exact objective binding;
- `WorkItem` is semantic work;
- `Assignment` binds an execution to a frozen subject and policy;
- `Execution` is a provider or host invocation;
- `Attempt` records a retry, continuation, or reroute without overwriting history;
- `ResultCandidate` is unaccepted output;
- `AcceptedArtifact` is output approved for downstream use.

## 3. Core invariants

1. Conversation, Goal, Run, graph revision, and canonical events are Baton-owned.
2. A semantic proposal is not a state transition.
3. A provider response is not acceptance.
4. Execution termination is not WorkItem completion.
5. WorkItem acceptance is not Goal completion.
6. Only accepted artifacts satisfy normal downstream input dependencies.
7. Reviewers consume frozen candidates, not accepted artifacts they are supposed to approve.
8. Work dependency, execution lineage, retry relation, review relation, and resource exclusion are
   different edges.
9. External launch is never described as atomically committed with SQLite. Baton linearizes launch
   authority and represents unresolved outcomes honestly.
10. No prose, plugin process, adapter, or reviewer writes canonical state directly.
11. A manual account pause is never overridden by orchestration in a routing mode that provides the
    required pause epoch and one-shot dispatch grant. Weaker gateway routing is labeled explicitly
    and cannot claim exact-account enforcement.
12. UI status is rebuilt from versioned canonical events and projections, not agent prose.

## 4. Authority and roles

### 4.1 User

The user owns Goal revisions, preference and value judgments, permission expansion, irreversible
effect approval, steering, pause, resume, and cancellation.

### 4.2 Coordinator

The Coordinator is a leased planning role for an exact objective and graph revision. It is not a
permanent root process and need not remain on one provider.

It may propose decomposition, dependencies, integration, review, rework, and completion. It cannot
commit a graph, select credentials, issue a canonical acceptance receipt, or terminalize a Goal.

Coordinator failover is allowed only at a portable checkpoint. An open provider-private tool loop or
incompatible continuation pins the current provider until it is completed or cancelled.

### 4.3 Worker

A Worker executes one immutable assignment. It may submit checkpoints, result candidates, blockers,
decision proposals, and follow-up work proposals. It cannot mutate the graph, approve its own result,
expand permission, or directly create provider-native child execution.

### 4.4 Reviewer and verifier

A Reviewer produces a semantic verdict over an exact subject digest. A machine verifier produces a
deterministic receipt. Neither writes acceptance state directly.

The control plane issues an `AcceptanceReceipt` only by evaluating an immutable
`AcceptancePolicySnapshot` against the required verifier receipts.

### 4.5 Baton control plane

The control plane owns revisions, CAS, event append, policy evaluation, graph validation, dispatch
authority, budget reservation, leases, fencing, cancellation ordering, reconciliation gates,
acceptance issuance, and completion attestation.

Logical single-writer means transaction and CAS authority. It does not require one permanent backend
process or one LLM.

### 4.6 Scheduler

The Scheduler computes semantic readiness, admission eligibility, and dispatchability separately. It
assigns eligible work to adapters and account routes without changing the WorkItem objective.

### 4.7 Plugins

Plugins are proposers, not alternate control planes.

Two trust classes are allowed:

- restricted proposal plugins run in an isolated host and receive only bounded snapshots and a typed
  proposal output channel;
- trusted built-in modules may run in-process but are part of the Baton trusted computing base and
  must use the same proposal and event APIs.

Third-party plugins do not receive `SessionStore`, provider adapters, credential brokers, raw process
environment, unrestricted filesystem, unrestricted process execution, or direct provider network
access. Plugin identity, version, input digest, timeout, capability grant, and proposal schema are
recorded. Upgrade or revoke invalidates uncommitted proposals from the retired plugin epoch.

A committed graph fully materializes provider-neutral semantics and frozen policies. A plugin never
owns leases, outbox rows, scheduler cursors, credentials, lifecycle, cancellation, or reconciliation.
Baton core can inspect, cancel, reconcile, and project a committed Run after the creating plugin is
removed. If new semantic work requires an unavailable plugin, Baton opens a `PLUGIN_UNAVAILABLE`
gate instead of silently substituting another plugin.

## 5. Objective, Run, and ownership

### 5.1 ObjectiveBindingSnapshot

```text
binding_id
conversation_id
thread_id
goal_id?
goal_revision?
goal_status_epoch?
turn_objective_revision?
objective_digest
explicit_requirement_baseline_digest
authorization_scope_digest
created_at
```

A Goal-owned Run binds the exact Goal identity, revision, status epoch, and requirement ledger. A
normal turn does not create a fake Goal and instead binds a `TurnObjectiveRevision`.

### 5.2 Run

```text
run_id
profile
objective_binding_id
lifecycle_status
lifecycle_epoch
graph_revision
run_policy_epoch
automation_owner_lease
budget_policy_snapshot
permission_policy_snapshot
created_at
settled_at?
```

Minimum Run lifecycle:

```text
DRAFT
ACTIVE
PAUSED
SETTLING
CANCEL_REQUESTED
CANCELLING
COMPLETED
FAILED
CANCELLED
```

Waiting and blocked are projections from open gates, not independently writable lifecycle states.
Run gates are append-only records and several may be open at once:

```text
WAITING_USER
WAITING_RESOURCE_POLICY
RECONCILIATION_REQUIRED
COMPLETION_REVIEW_REQUIRED
PLUGIN_UNAVAILABLE
```

Each gate has `gate_id`, `kind`, `scope`, `subject_digest`, `generation`, `opened_sequence`, status,
and a closing receipt. A versioned projection selects one sidebar `primary_status` by a deterministic
priority while detail views show every open gate.

Every graph mutation, dispatch, result, decision application, acceptance, and completion operation
compares the objective binding, Run lifecycle epoch, graph revision where applicable, and applicable
scope fence generation. A Run-wide authorization or policy steer advances `run_policy_epoch`; scoped
steering fences only its validated impact closure.

Authorization or policy steering advances `run_policy_epoch`. Objective or acceptance steering first
appends a new GoalRevision or TurnObjectiveRevision and creates a new ObjectiveBindingSnapshot. The
old binding is fenced. Baton then creates a successor Run or performs an explicit portable-boundary
rebind transaction that replans every affected WorkItem. Old results retain provenance but cannot
satisfy the new binding without explicit revalidation.

### 5.3 Automation ownership

A Goal revision has at most one active automation ownership lease. Existing `update_goal(complete)`
becomes a completion proposal while a WorkSet or WorkGraph owns automation. The legacy direct Goal
terminalization path is fail-closed for that binding.

No Goal-owned work starts before this ownership migration and completion gate are active.

## 6. Requirement ledger

```text
RequirementLedgerRevision
- objective_binding_id
- ledger_revision
- ledger_epoch
- parent_revision
- entry_versions
- authority_receipts
- ledger_digest

RequirementEntryVersion
- requirement_id
- version
- source_kind
- source_message_id?
- description
- acceptance_contract
- required_evidence_classes
- semantic_digest

RequirementEntryState
- requirement_id
- version
- state_epoch
- coverage_work_item_ids
- status
```

`source_kind` distinguishes explicit user requirements, policy-derived requirements, and
agent-proposed derived criteria. Derived criteria cannot silently narrow or replace explicit user
requirements. A material new success condition requires user confirmation or an applicable frozen
policy.

Requirement status is satisfied only by accepted evidence or a valid not-applicable receipt. Graph
node completion alone does not satisfy the ledger.

Derived criteria update an append-only ledger revision under the same objective binding when they do
not change the material objective. Material objective or acceptance changes require a new objective
binding. Ledger revision changes fence only assignments and completion coverage that consume changed
entry versions.

## 7. Work, state, and graph records

### 7.1 WorkItemVersion

Semantic version and lifecycle state are separate.

```text
work_item_id
version
run_id
objective
accepted_input_contracts
acceptance_contract
required_capabilities
completion_policy
created_by_proposal_id
semantic_digest
```

### 7.2 WorkItemState

```text
work_item_id
work_item_version
state_epoch
status
reason_code?
current_assignment_id?
accepted_artifact_id?
updated_at
```

Minimum statuses:

```text
PROPOSED
SEMANTIC_READY
QUEUED_ADMISSION
QUEUED_RESOURCE
RUNNING
WAITING_DECISION
CANDIDATE_READY
REVIEWING
REWORK_REQUIRED
ACCEPTED
FAILED
CANCELLED
SUPERSEDED
SKIPPED_BY_CONDITION
```

`SKIPPED_BY_CONDITION` is terminal for the current condition generation and requires a branch
evaluation receipt. If the condition changes, the old receipt is fenced.

### 7.3 WorkGraphRevision

```text
run_id
revision
parent_revision
objective_binding_id
node_versions
edges
committed_proposal_id
impact_index_digest
committed_at
```

A flat WorkSet is a degenerate graph with independent nodes and bounded joins. Simple conversations
may have no materialized WorkGraph.

## 8. Corrected edge semantics

Each edge names the exact source readiness level it consumes.

| Edge | Graph-time source contract | Dispatch-time resolution |
|---|---|---|
| `consumes_accepted` | Producer WorkItem version, output slot, artifact contract, acceptance policy | Current valid accepted artifact and receipt generation |
| `integration_after` | Frozen producer slot set and join policy | Exact accepted artifact set and receipt generations |
| `validates_candidate` | Producer candidate slot and review subject contract | Exact `ResultCandidate` or frozen subject packet |
| `validation_prerequisite` | Accepted artifact contract needed by the reviewer | Exact accepted prerequisite, excluding the candidate under review |
| `decision_input` | Decision subject and consumer contract | Compatible decision answer receipt generation |
| `condition` | Branch condition and generation | Active branch evaluation receipt |

A reviewer that validates candidate A is ready when A has a frozen candidate. A does not wait for an
accepted A artifact to start its own review. This removes the V1 validation cycle.

Execution lineage, requested-by relation, retry relation, continuation relation, review relation, and
resource wait relation are stored outside semantic dependency edges.

Graph edges do not name future artifact IDs. The dispatch transaction resolves a graph-time output
contract into an immutable input manifest containing exact artifact IDs, artifact digests,
acceptance receipt IDs and generations, and a resolution epoch. A rejected candidate never satisfies
that manifest.

## 9. Assignment and execution identity

### 9.1 ExecutionAssignment

```text
assignment_id
run_id
subject_kind
subject_id
subject_version
subject_digest
work_item_id?
work_item_version?
goal_binding_digest
graph_revision
assignment_epoch
requested_by_execution_id?
policy_snapshot
context_manifest_digest
portable_item_cut
provider_binding_compatibility
open_call_manifest
budget_reservation
fence_token
adapter_capability_snapshot_id
```

Minimum `subject_kind` values:

```text
work_item
proposal_validation
candidate_review
promotion_review
decision_probe
goal_review
integration
```

### 9.2 Attempt and lineage

```text
attempt_id
assignment_id
execution_id
parent_execution_id?
retry_of_attempt_id?
continuation_of_attempt_id?
reviews_subject_id?
terminal_outcome?
result_candidate_id?
dispatch_spec_id
```

`parent_execution_id` means actual execution creation lineage only. A retry is not a child, and a
review relation is not a parent edge. UI projections must not merge these meanings.

Assignments are provider-neutral subject, context, policy, and budget envelopes. Every retry or
reroute creates a new Attempt and immutable `ExecutionDispatchSpec`:

```text
dispatch_spec_id
attempt_id
requested_provider
requested_model
requested_effort
requested_account_binding
model_fallback_policy
account_switch_policy
adapter_id
adapter_version
adapter_capability_snapshot_id
route_receipt_ref?
```

Effective provider, model, effort, and account evidence are recorded per provider round. A reroute
does not reuse an execution identity. If route changes invalidate context, policy, or capability
compatibility, Baton creates a new assignment epoch or assignment.

## 10. Execution lifecycle and external launch

Launch lifecycle and outcome are separate:

```text
LaunchState:
PREPARED
STARTING
STARTED
CLOSED_NO_START

ExecutionState:
QUEUED
RUNNING
WAITING_DEPENDENCY
WAITING_DECISION
TERMINAL

ExecutionOutcome:
COMPLETED
FAILED
CANCELLED
INTERRUPTED
UNKNOWN
```

`RECONCILIATION_REQUIRED` is a Run gate, not an execution outcome.

Every launch uses a canonical `LaunchClaim`:

```text
launch_claim_id
execution_id
launch_claim_epoch
dispatch_idempotency_key
adapter_id
adapter_version
adapter_capability_epoch
immutable_start_spec_digest
launch_state
external_identity?
event_high_watermark?
lease_owner
lease_expiry
terminal_attestation?
```

The transaction that changes `PREPARED` to `STARTING` also claims the outbox record and launch lease.
This is the linearization point for canonical launch authority, not an atomic external process start.
Recovery uses the stable claim identity and adapter capability. `STARTING` cannot become a clean
interruption or retry merely because the acknowledgement is missing.

Adapter dispatch capability is classified:

- `probeable_mutating`: stable start identity, probe, cancel, and effect reconciliation are required;
- `idempotent_mutating`: a provider-supported idempotency contract may replace exact start probing;
- `recomputable_read_only`: a lost attempt remains unknown or interrupted, but policy may start a new
  attempt because duplicate external mutation is impossible;
- `unverifiable_mutating`: managed child dispatch is fail-closed.

An adapter need not implement the strongest launch contract for read-only recomputable work. It may
not execute mutating managed child work without the required effect capability.

### 10.1 AdapterCapabilitySnapshot

Each assignment and launch fence binds an immutable capability snapshot:

```text
adapter_id
adapter_version
capability_epoch
structured_control
cancellation_contract
stable_start_probe
idempotency_contract
portable_checkpoint
continuation_compatibility
runtime_identity_evidence
managed_mutation_classes
native_child_observability
```

The epoch is rechecked before each attempt starts. Mismatch requires re-admission. Providers without
reliable structured control can remain leaf workers. Adapters without the required mutation or
native-child observability contract cannot execute that assignment class.

### 10.2 Cancellation and settlement

Cancellation is a durable intent, not an immediate terminal fact:

```text
CANCEL_REQUESTED
  -> CANCELLING
  -> CANCELLED
  -> or SETTLING with RECONCILIATION_REQUIRED
```

The cancellation transaction first fences Run, assignment, execution, dispatch, steer, and unused
effect-grant generations, then writes cancel and probe outbox records. Any execution at `STARTING` or
later requires `CLOSED_NO_START` or a stable started identity plus terminal and effect attestation
before the Run can be cleanly `CANCELLED`. Late launch or unknown cancel acknowledgement keeps the
Run in `SETTLING` with a reconciliation gate. UI must not show cancellation complete earlier.

## 11. Context portability and failover

Every assignment freezes:

- the exact canonical context manifest;
- the portable item cut and digests;
- provider-private binding compatibility;
- open tool and dynamic call state;
- information class and provenance closure where policy requires it.

Coordinator or Worker failover to another provider occurs only at a portable checkpoint. An open
tool loop, unresolved native call, or incompatible provider-private continuation is completed,
cancelled, or reconciled before switching providers.

## 12. Proposal and mutation authority

All proposal paths enter one append-only proposal journal:

```text
mid-turn typed tool proposal
turn-boundary structured proposal
user or UI proposal
host workflow proposal
restricted or trusted plugin proposal
worker follow-up proposal
```

Natural language is never parsed as an execution command.

Graph mutation commits compare exact objective binding, Run lifecycle epoch, graph revision, steer
epoch, and planning authority epoch. Mutation validation includes cycle, reference, graph growth,
scope, permission, budget, active assignment disposition, and acceptance coverage checks.

Unaffected assignments may survive a graph revision only when their WorkItem version, accepted input
contracts, context base, permission, and objective coverage remain identical. Invalidated assignments
are fenced. Late results remain diagnostic and cannot be promoted.

### 12.1 Scoped steering

Every user steer is stored before provider delivery:

```text
steer_request_id
received_sequence
scope_kind
scope_id
canonical_user_item_id
status
impact_class
affected_closure_digest
fence_generation
delivery_correlation?
```

Minimum statuses are `RECEIVED`, `CLASSIFIED`, `APPLIED`, `DELIVERY_UNKNOWN`, and `TERMINAL`.
Objective, authorization, or policy changes advance the Run-wide policy epoch. WorkItem, assignment,
or execution steering fences only the validated impact closure. Delivery uncertainty is not retried
by guessing; the affected execution enters effect-class-appropriate retry or reconciliation. Unrelated
read-only branches may continue.

## 13. Decision validity

A decision is not invalidated merely because an unrelated graph revision changes.

```text
decision_id
decision_generation
decision_subject_digest
consumer_contract_digest
effect_manifest_digest
objective_binding_id
status
answer_receipt
```

An answer remains usable when the subject, choices, consumers, effect manifest, permission, cost, and
objective policy are compatible. If any of those change materially, Baton supersedes the generation
and asks again.

The blocked set is the smallest validated closure of direct consumers, affected descendants, and
in-flight assignments invalidated by the answer. If the semantic impact is uncertain, policy uses a
conservative scope or requires plan review rather than pretending independence.

## 14. Readiness, admission, dispatch, and fairness

These states are separate:

- `semantic_ready`: accepted dependencies and decisions are satisfied;
- `admission_eligible`: permission, capability, budget, Goal, and policy checks pass;
- `dispatchable`: required provider and resource capacity is currently available.

Temporary resource scarcity produces `QUEUED_RESOURCE`, not dependency blocking. Permanent or
user-changeable policy failure produces a distinct blocked or decision reason. Queue entry time,
priority policy, and fairness epoch are retained to detect starvation.

## 15. Resource waiting

Token-consuming agent execution does not remain alive while waiting for a user or dependency.

The default is to release exclusive execution resources at a portable checkpoint. Stateful resources
that must preserve external state, such as a specific emulator instance, use a separate bounded
durable reservation profile with:

- explicit resource identity;
- idle timeout and maximum reservation duration;
- user-visible occupancy and cost;
- checkpoint, preemption, or invalidation policy;
- no indefinite hidden lock.

Resource constraints remain Scheduler state and do not become fake semantic dependencies.

## 16. Acceptance authority

### 16.1 AcceptancePolicySnapshot

```text
policy_id
policy_version
subject_kind
subject_digest
criterion_ids
required_machine_verifiers
required_reviewer_classes
reviewer_independence_rules
quorum
conflict_rule
escalation_rule
risk_class
```

Reviewer disagreement is resolved by this frozen policy, not by backend prose judgment. Conflict may
require another independent review, rework, or user decision. High-risk policies can require producer,
reviewer, and approver separation.

### 16.2 AcceptanceReceipt

The receipt binds the exact subject digest, policy snapshot, consumed verifier receipts, verdict set,
criterion coverage, generation, validity state, provenance closure, and issuing canonical transaction.
Validity is `VALID`, `CHALLENGED`, or `SUPERSEDED`. It is one-shot for that subject, policy, and
generation.

Only an accepted candidate becomes an `AcceptedArtifact` and satisfies `consumes_accepted`.

Every downstream input manifest records the exact receipt generation it consumed. Identity-valid
contradictory evidence challenges the affected receipt and fences its downstream impact closure in
one canonical transaction. New effects cannot be admitted from challenged evidence.

A historical terminal Goal event is not silently erased. If contradictory evidence arrives after
Goal completion, Baton creates a `CompletionChallenge`, marks the current user-facing completion
projection as disputed, and blocks new automation or effects for that binding. Reopening work requires
an explicit user or frozen policy decision and creates a new Goal or completion generation. This
preserves history while avoiding an unannounced terminal-state rollback.

## 17. Account routing truth

Baton distinguishes requested policy target from observed effective account.

- If Baton owns exact credential routing, assignment records the account lease and account epoch.
- If CLIProxy or another gateway selects the upstream account, Baton records only the eligible pool
  and policy target until an authoritative route receipt or usage event identifies the actual account.
- UI and logs must not present policy rank as proof of effective account use.
- Manual pause and account eligibility are rechecked before every new provider round or retry.
- An already transmitted request cannot be recalled merely because the account pauses later.

Requested and effective provider, model, effort, and account evidence are stored separately.

Every provider round records `RoundRouteEvidence`. Account binding is one of `exact_account`,
`eligible_pool`, or `external_unknown`. Account switching is one of `per_request`,
`portable_checkpoint_only`, or `pinned_execution`. Model and effort policy is either
`exact_required` or `fallback_allowed`.

An exact request without authoritative effective metadata, or with mismatched metadata, cannot be
reported as successful under `exact_required`. A paused account bound to a pinned execution is not
silently replaced. Baton waits, blocks, or starts a new attempt from a portable checkpoint according
to policy.

For Baton-owned exact routing, a one-shot dispatch grant binds account eligibility, pause epoch, and
credential lease. Pause revokes unconsumed grants and outbox rows. Grant consumption records the
linearization point after which a transmitted request cannot be recalled.

For gateway-owned routing, the gateway must provide an equivalent epoch and fencing receipt before
Baton claims exact manual-pause enforcement. Without it Baton can restrict only the eligible pool and
must label exact account use as unknown. Managed mutating dispatch may be fail-closed by policy in
that weaker mode.

## 18. Permission derivation and effect grants

Each assignment receives an immutable permission snapshot computed as:

```text
AssignmentPermission = Run permission scope
  intersect WorkItem required scope
  intersect adapter enforced scope
```

A child cannot exceed the Run or parent authorization. Permission expansion is a typed user decision.
External effect approval binds an exact normalized effect manifest, resource and account identity,
expiry, and generation. Grants are one-shot. Pause, cancellation, authorization change, or expiry
fences unused grants. A consumed grant is never treated as undone; cancellation, probe, or
reconciliation determines the outcome.

Approval requests appear in the root conversation `needs attention` projection even when they
originate from a child execution.

## 19. Event journal and projections

Phase 0 defines append-only orchestration events for:

- Run lifecycle and gates;
- proposal submission and adjudication;
- graph revision commit;
- WorkItem state;
- assignment, launch, attempt, and outcome;
- result candidate, review, acceptance, and promotion;
- decision generation and answer;
- cancellation, steering, fencing, and reconciliation;
- completion proposal and attestation.

Every canonical event has:

```text
event_id
run_id
run_sequence
operation_id
idempotency_key
aggregate_kind
aggregate_id
expected_aggregate_epoch
event_schema_version
payload_digest
committed_at
```

Canonical event append, aggregate head CAS, launch or effect outbox, and operation receipt commit in
one SQLite transaction. `(run_id, run_sequence)` and operation idempotency keys are unique. Retrying
the same operation returns the prior event or receipt and does not create another effect.

Derived projections may update asynchronously. Each projection stores schema version and
`last_event_sequence`, rejects gaps and out-of-order input, and can rebuild from a verified
checkpoint plus journal suffix. A lagging projection is never a second authority. APIs expose its
cursor when freshness matters.

Projection schemas are versioned. Rebuild from the journal and live incremental projection must
produce identical state.

UI presents separate facts:

- execution running or terminal;
- result submitted;
- review pending;
- WorkItem accepted;
- Run blocked or waiting;
- Goal complete.

No single generic `completed` label hides these distinctions.

## 20. Completion ownership

While a Run owns Goal automation, model `update_goal(complete)` is translated into a completion
proposal. It cannot bypass the Run.

Completion attestation requires:

- current objective binding and lifecycle epoch;
- all explicit user requirements covered;
- policy-derived requirements covered;
- derived criteria not used to narrow explicit scope;
- required active WorkItems accepted or validly skipped;
- required joins and integration accepted;
- no unresolved decision, effect, or reconciliation gate;
- applicable acceptance policies satisfied;
- a fresh Goal review or user gate when risk policy requires it.

Semantic completion remains fallible. Baton records evidence and independent judgments instead of
claiming mathematical proof.

## 21. Run profiles

Profiles share the same Run, event, security, assignment, and acceptance foundations.

| Profile | Intended use |
|---|---|
| `single` | One bounded conversational execution |
| `workset` | Independent parallel work with simple joins |
| `dag` | Finite dependency, decision, integration, and validation |
| `batch` | Large homogeneous partitions with bounded reduction |
| `saga` | Approval-gated external effects and compensation where supported |
| `recurring` | A controller that creates a series of finite Runs |

V2 freezes only the common boundary. Batch, saga, and recurring state machines are later profile
specifications and must not be implied by the first child execution implementation.

Loops are bounded new attempts or graph revisions, never cyclic dependency edges.

## 22. Revised implementation sequence

### Phase 0. Authority and event foundation

- Run, objective binding, lifecycle epoch, steer epoch, and automation ownership;
- requirement ledger and explicit versus derived requirement authority;
- WorkItem semantic and lifecycle separation;
- orchestration event schema and projection rebuild;
- completion proposal conversion and legacy Goal completion bypass closure;
- execution launch, outcome, Run gate, `UNKNOWN`, and reconciliation separation;
- adapter capability snapshots, LaunchClaim, and dispatch classification;
- scoped steer records, cancellation settlement, and effect grant fencing;
- shadow-write V3 events beside the existing runtime and compare projections;
- enable `workset_v3` only for new Runs behind a feature flag;
- migrate an active Goal only at a portable idle boundary with an explicit ownership receipt;
- rollback stops new dispatch but preserves inspect, cancel, probe, reconciliation, and journal read.

### Phase 1. Acceptance-safe flat WorkSet

- host-created independent WorkItems;
- ResultCandidate, AcceptancePolicySnapshot, verifier receipts, AcceptanceReceipt, and promotion;
- required join and completion gate;
- depth one read-only or capability-proven execution;
- assignment permission derivation and one-shot effect grants;
- a frozen low-risk read-only acceptance policy that can accept deterministic evidence without a
  mandatory semantic reviewer;
- asynchronous dispatch, lease, wait, cancel, late result, and crash tests;
- no agent-driven graph mutation.

### Phase 2. Turn-boundary proposals and static workflow

- structured decomposition at a provider round boundary;
- proposal review and exact base revision;
- requirement coverage planning;
- no natural-language execution parsing.

### Phase 3. Scoped decisions and checkpoints

- decision generation and consumer digest;
- bounded resource reservation profiles;
- portable checkpoint and provider failover rules;
- independent branches continue while consumers wait.

### Phase 4. Limited dependencies and mid-turn proposals

- corrected candidate and accepted edge semantics;
- semantic readiness, admission, and dispatchability queues;
- work-centric proposal, steer, wait, cancel, and list tools;
- worker follow-up proposal inbox.

### Phase 5. Dynamic graph revision

- mutation review, impact index, CAS, and fencing;
- stale result quarantine;
- bounded replan and review cycles;
- replaceable Coordinator planning leases.

### Phase 6. Plugins and additional profiles

- restricted plugin host and trusted built-in module policy;
- batch, saga, and recurring profile specifications;
- multi-run fairness after single-run recovery is proven.

## 23. Required verification

1. A candidate reviewer starts from the frozen candidate without waiting for candidate acceptance.
2. Goal-owned work cannot start until legacy direct completion is fenced.
3. Goal edit fences stale dispatch, result, decision, acceptance, and completion operations.
4. Rebuild and live event projections are identical.
5. WorkItem status, execution status, Run gate, and Goal status remain distinct in API and UI.
6. Reviewer conflict follows a frozen acceptance policy and cannot be selected ad hoc.
7. Proposal review and Goal review assignments work without fake WorkItems.
8. Retry, continuation, review, and execution parent edges produce different projections.
9. An unrelated graph revision does not invalidate a compatible decision answer.
10. An inactive branch receives a fenced skip receipt and does not block completion.
11. Untrusted plugin code cannot access adapters, credentials, raw environment, or canonical stores.
12. Temporary account or resource scarcity does not appear as semantic dependency blocking.
13. A stateful resource reservation is bounded, visible, and recoverable.
14. A lost read-only response may create a new attempt under policy without claiming the old outcome.
15. A possibly mutating unknown effect opens reconciliation and blocks unsafe follow-up effects.
16. Provider failover occurs only from a portable checkpoint with no unresolved open call.
17. CLIProxy policy rank is not shown as the effective account without a route receipt.
18. Duplicate proposal, dispatch, verifier receipt, and acceptance issuance remain idempotent.
19. Required joins and requirement coverage prevent premature Goal completion.
20. Exact adapter tool manifests omit native spawn, team, and task tools; observable native child
    events fail closed; no externally addressable child session appears without a Baton assignment.
21. Cancellation races are tested at `PREPARED`, `STARTING`, and `STARTED`, including late launch and
    lost cancel acknowledgement.
22. A challenged acceptance receipt fences its exact downstream closure without erasing history.
23. A post-completion contradiction creates a disputed projection and requires explicit reopen.
24. Graph-time output slots resolve to exact accepted artifacts and receipt generations at dispatch.
25. Crash injection at event, aggregate head, outbox, and operation receipt boundaries preserves one
    canonical sequence and idempotent replay.
26. Scoped steering does not fence unrelated branches and unknown delivery is not resent blindly.
27. Adapter capability epoch changes force re-admission before attempt start.
28. Exact model and account routing policies reject missing or mismatched runtime evidence.
29. Permission grants are derived by intersection, consumed once, and revoked before use on pause or
    cancellation.
30. Shadow migration and rollback preserve active Goal history and recovery operations.
31. Removing a plugin after graph commit does not prevent inspect, cancel, reconciliation, or final
    projection.

## 24. Known irreducible limits

- Schema and deterministic gates cannot prove semantic decomposition or completion correct.
- Exactly-once external mutation is impossible without provider idempotency, a stable identity probe,
  or an equivalent local supervisor contract.
- Cancellation cannot prove that an already transmitted provider request performed no work.
- Gateway account selection cannot be attributed to an exact account without authoritative evidence.
- Provider-private continuation may prevent cross-provider failover until a portable checkpoint.

The required response is review, explicit user authority, capability gating, and honest uncertainty,
not silent retry or optimistic completion.

## 25. V1 adversarial review adjudication

The independent reviewer returned `REJECT`. Findings were not applied automatically.

| Finding | Decision | V2 action |
|---|---|---|
| Validation and acceptance cycle | Accepted | Candidate and accepted edge semantics separated |
| Child activation before completion gate | Accepted | Ownership and completion fencing moved to Phase 0 |
| Missing Run canonical record | Accepted | Run, objective binding, epochs, and lease added |
| External launch atomicity overclaim | Partially accepted | Launch authority linearization added; strongest adapter contract limited by effect class |
| Missing acceptance authority | Accepted | Frozen policy, quorum, conflict, and receipt issuance added |
| Assignment cannot represent control work | Accepted | Subject kinds added |
| Lineage, retry, and review confused | Accepted | Relations separated |
| Decision tied to whole graph revision | Accepted | Subject and consumer digests replace global invalidation |
| Inactive branch has no terminal meaning | Accepted | Fenced skip state and receipt added |
| Plugin isolation only declarative | Partially accepted | Restricted host required for third party; trusted built-ins remain explicit TCB members |
| Missing event and UI projection contract | Accepted | Phase 0 event schema and distinct projections added |
| Readiness and dispatchability merged | Accepted | Three-stage readiness model added |
| All resource leases released on wait | Partially accepted | Execution lease release remains default; bounded stateful reservation profile added |
| All lost responses treated alike | Partially accepted | Outcome and Run gate separated by effect class |
| Provider failover ignores private context | Accepted | Context manifest and safe checkpoint requirements added |

Additional root review corrections:

- exact account assignment claims now require an authoritative route receipt;
- semantic WorkItem versions and lifecycle state are separate;
- explicit user requirements cannot be silently replaced by agent-derived criteria;
- future Run profiles no longer imply that their full state machines are already specified.

## 26. V2 adversarial review adjudication

Two independent reviewers returned `REJECT` and `APPROVE_WITH_CHANGES`. Findings were deduplicated
and adjudicated rather than copied automatically.

| Finding | Decision | V3 action |
|---|---|---|
| Lifecycle waiting and blocked duplicate gate truth | Accepted | Waiting and blocked are gate-derived projections |
| Run-wide steering is too coarse | Accepted | Scoped SteerRequest and impact fences added |
| Adapter capability is not assignment-bound | Accepted | Versioned capability snapshot added |
| Requested and effective route behavior is unclear | Accepted | Round evidence and exact versus fallback policy added |
| Child permission and grant revocation are missing | Accepted | Permission intersection and one-shot grants added |
| No shadow migration or rollback gate | Accepted | Feature flag, shadow projection, idle migration, and rollback rules added |
| Committed Run depends on plugin availability | Accepted | Graph semantics are materialized and core remains recovery owner |
| Native child check is only a handshake assertion | Accepted | Exact manifest, event violation, and external child checks added |
| Cancellation has no settlement state machine | Accepted | Cancel request, fencing, probe, and settlement rules added |
| Acceptance and completion cannot be challenged | Partially accepted | Receipt challenge added; historical terminal Goal is disputed, not silently rolled back |
| Launch claim has no durable identity | Accepted | LaunchClaim record and recovery contract added |
| Provider identity is mixed across assignment and attempt | Accepted | Provider-neutral assignment and per-attempt dispatch spec added |
| Graph edges refer to future artifact identity | Accepted | Output contracts resolve to exact artifacts at dispatch |
| Event and projection atomicity is underspecified | Partially accepted | Event, head, outbox, and receipt are atomic; derived projections use gap-safe cursors |
| Manual pause has gateway TOCTOU | Partially accepted | Exact guarantee requires one-shot grant or gateway fencing; weaker mode is labeled |

No reviewer proposal was accepted merely because of severity. Direct rollback of a historical Goal
terminal event was rejected because it would rewrite user-visible history. Requiring every derived
projection to update in the canonical mutation transaction was rejected because projections are
rebuildable views; sequence and gap safety provide the authority boundary without coupling every view
to the write path.

## 27. Related documents

- `WORK_CENTRIC_ORCHESTRATION_DESIGN_V1.md`
- `WORK_CENTRIC_ORCHESTRATION_DESIGN_V2.md`
- `COMMON_SESSION_DESIGN.md`
- `CANONICAL_AGENT_RUNTIME.md`
- `PERSISTENT_GOAL_RUNTIME.md`
- `PARETO_ORCHESTRATION_PLUGIN_AND_EVOLVING_WORK_GRAPH.md`
- `HOST_AUTOMATION.md`
- `../../ParetoPilot/docs/nonblocking-user-decisions-and-dag.ko.md`
