# Work-Centric Orchestration Design V2

Status: accepted target design after independent adversarial review, not an implementation claim

Version: 2

Date: 2026-07-20

Supersedes: `WORK_CENTRIC_ORCHESTRATION_DESIGN_V1.md`

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
11. A manual account pause is never overridden by orchestration.
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
requirement_ledger_digest
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
steer_epoch
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
WAITING
PAUSED
SETTLING
COMPLETED
FAILED
CANCELLED
BLOCKED
```

Run gates are separate from lifecycle status:

```text
NONE
WAITING_USER
WAITING_RESOURCE_POLICY
RECONCILIATION_REQUIRED
COMPLETION_REVIEW_REQUIRED
```

Every graph mutation, dispatch, result, decision application, acceptance, and completion operation
compares the objective binding, Run lifecycle epoch, graph revision where applicable, and steer
epoch. User steering fences new effect admission before replanning.

### 5.3 Automation ownership

A Goal revision has at most one active automation ownership lease. Existing `update_goal(complete)`
becomes a completion proposal while a WorkSet or WorkGraph owns automation. The legacy direct Goal
terminalization path is fail-closed for that binding.

No Goal-owned work starts before this ownership migration and completion gate are active.

## 6. Requirement ledger

```text
requirement_id
objective_binding_id
source_kind
source_message_id?
description
acceptance_contract
required_evidence_classes
coverage_work_item_ids
status
```

`source_kind` distinguishes explicit user requirements, policy-derived requirements, and
agent-proposed derived criteria. Derived criteria cannot silently narrow or replace explicit user
requirements. A material new success condition requires user confirmation or an applicable frozen
policy.

Requirement status is satisfied only by accepted evidence or a valid not-applicable receipt. Graph
node completion alone does not satisfy the ledger.

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

| Edge | Source required before consumer is ready |
|---|---|
| `consumes_accepted` | Exact `AcceptedArtifact` |
| `integration_after` | All named accepted artifacts or a frozen join set |
| `validates_candidate` | Exact `ResultCandidate` or frozen subject packet |
| `validation_prerequisite` | Accepted artifact needed by the reviewer, but not the candidate it validates |
| `decision_input` | Compatible decision answer receipt |
| `condition` | Active branch evaluation receipt |

A reviewer that validates candidate A is ready when A has a frozen candidate. A does not wait for an
accepted A artifact to start its own review. This removes the V1 validation cycle.

Execution lineage, requested-by relation, retry relation, continuation relation, review relation, and
resource wait relation are stored outside semantic dependency edges.

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
provider
requested_model
requested_effort
policy_snapshot
context_manifest_digest
portable_item_cut
provider_binding_compatibility
open_call_manifest
budget_reservation
fence_token
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
```

`parent_execution_id` means actual execution creation lineage only. A retry is not a child, and a
review relation is not a parent edge. UI projections must not merge these meanings.

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

The transaction that changes `PREPARED` to `STARTING` also claims the outbox record and launch lease.
This is the linearization point for canonical launch authority, not an atomic external process start.

Adapter dispatch capability is classified:

- `probeable_mutating`: stable start identity, probe, cancel, and effect reconciliation are required;
- `idempotent_mutating`: a provider-supported idempotency contract may replace exact start probing;
- `recomputable_read_only`: a lost attempt remains unknown or interrupted, but policy may start a new
  attempt because duplicate external mutation is impossible;
- `unverifiable_mutating`: managed child dispatch is fail-closed.

An adapter need not implement the strongest launch contract for read-only recomputable work. It may
not execute mutating managed child work without the required effect capability.

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
criterion coverage, and issuing canonical transaction. It is one-shot for that subject and policy.

Only an accepted candidate becomes an `AcceptedArtifact` and satisfies `consumes_accepted`.

## 17. Account routing truth

Baton distinguishes requested policy target from observed effective account.

- If Baton owns exact credential routing, assignment records the account lease and account epoch.
- If CLIProxy or another gateway selects the upstream account, Baton records only the eligible pool
  and policy target until an authoritative route receipt or usage event identifies the actual account.
- UI and logs must not present policy rank as proof of effective account use.
- Manual pause and account eligibility are rechecked before every new provider round or retry.
- An already transmitted request cannot be recalled merely because the account pauses later.

Requested and effective provider, model, effort, and account evidence are stored separately.

## 18. Event journal and projections

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

## 19. Completion ownership

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

## 20. Run profiles

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

## 21. Revised implementation sequence

### Phase 0. Authority and event foundation

- Run, objective binding, lifecycle epoch, steer epoch, and automation ownership;
- requirement ledger and explicit versus derived requirement authority;
- WorkItem semantic and lifecycle separation;
- orchestration event schema and projection rebuild;
- completion proposal conversion and legacy Goal completion bypass closure;
- execution launch, outcome, Run gate, `UNKNOWN`, and reconciliation separation;
- adapter dispatch capability classification.

### Phase 1. Acceptance-safe flat WorkSet

- host-created independent WorkItems;
- ResultCandidate, AcceptancePolicySnapshot, verifier receipts, AcceptanceReceipt, and promotion;
- required join and completion gate;
- depth one read-only or capability-proven execution;
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

## 22. Required verification

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
20. Provider-native child execution remains absent from canonical adapter capability handshakes.

## 23. Known irreducible limits

- Schema and deterministic gates cannot prove semantic decomposition or completion correct.
- Exactly-once external mutation is impossible without provider idempotency, a stable identity probe,
  or an equivalent local supervisor contract.
- Cancellation cannot prove that an already transmitted provider request performed no work.
- Gateway account selection cannot be attributed to an exact account without authoritative evidence.
- Provider-private continuation may prevent cross-provider failover until a portable checkpoint.

The required response is review, explicit user authority, capability gating, and honest uncertainty,
not silent retry or optimistic completion.

## 24. V1 adversarial review adjudication

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

## 25. Related documents

- `WORK_CENTRIC_ORCHESTRATION_DESIGN_V1.md`
- `COMMON_SESSION_DESIGN.md`
- `CANONICAL_AGENT_RUNTIME.md`
- `PERSISTENT_GOAL_RUNTIME.md`
- `PARETO_ORCHESTRATION_PLUGIN_AND_EVOLVING_WORK_GRAPH.md`
- `HOST_AUTOMATION.md`
- `../../ParetoPilot/docs/nonblocking-user-decisions-and-dag.ko.md`
