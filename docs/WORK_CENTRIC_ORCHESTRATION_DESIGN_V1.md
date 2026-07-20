# Work-Centric Orchestration Design V1

Status: adversarial review baseline, not an implementation claim

Version: 1

Date: 2026-07-20

This document defines a Baton-owned work orchestration model. It is intentionally preserved as the
pre-review baseline. The accepted design after independent review belongs in
`WORK_CENTRIC_ORCHESTRATION_DESIGN_V2.md`.

## 1. Purpose

Baton is the canonical owner of a conversation. Claude, Codex, Gemini, and future providers execute
selected work but do not own the conversation or its work state.

Provider-native products commonly expose agent-centric primitives such as spawning an agent,
waiting for an agent, and sending more input to an agent. Baton instead treats user work as the
stable identity:

- a `WorkItem` owns an objective, accepted inputs, completion conditions, and lifecycle;
- an `Execution` is one attempt to perform that work with a provider, model, account, and policy;
- a retry, provider switch, or independent review does not create a new user task;
- execution lineage records who requested an execution, but it does not define semantic work
  dependencies;
- a simple conversation does not need an explicit graph, while complex finite work may use a
  versioned `WorkGraph`.

This design does not claim that a deterministic backend can understand user intent by itself.
Agents make semantic proposals. Baton validates and commits authoritative state transitions.

## 2. Non-goals

V1 does not define:

- a general distributed workflow service;
- unbounded recursive delegation;
- exactly-once external effects where the provider offers no idempotency or status probe;
- a graph editor as the default conversation UI;
- provider-native subagents as canonical Baton executions;
- a proof that an LLM completion judgment is semantically correct.

## 3. Core model

The control topology is single-writer and multi-proposer.

```text
User Goal
  -> Requirement Ledger
  -> Orchestration Proposals
  -> Baton Control Plane
  -> WorkSet or WorkGraph Revision
  -> Ready Scheduler
  -> Execution Assignments
  -> Result Candidates
  -> Acceptance and Promotion
  -> Integration
  -> Completion Proposal
  -> Completion Attestation
```

Only the Baton control plane commits canonical state. Agents, reviewers, plugins, provider adapters,
and UI clients submit typed proposals or observations.

## 4. Roles and authority

### 4.1 User

The user owns:

- the Goal and its revisions;
- value judgments and preferences;
- permission expansion;
- approval of irreversible or high-impact actions;
- cancellation and steering authority.

### 4.2 Coordinator role

The Coordinator is a replaceable planning role, not a permanent root process or provider identity.
It may:

- interpret the current Goal and requirement ledger;
- propose initial work decomposition;
- propose dependencies, integration, and review strategy;
- assess worker discoveries and propose graph revisions;
- propose Goal completion with requirement-scoped evidence.

It may not directly mutate canonical graph state, select credentials, expand permission, approve its
own results, or terminalize the Goal.

A Coordinator invocation is bound to a Goal revision, graph revision, planning epoch, context
digest, and lease. A later invocation may use a different provider or model.

### 4.3 Worker role

A Worker receives one immutable assignment contract. It may:

- perform the assigned work;
- produce checkpoints and result candidates;
- report a blocker;
- request a user decision;
- propose follow-up work or a local split.

It may not directly spawn a provider-native agent, change another WorkItem, alter the graph, approve
its own result, or complete the Goal.

### 4.4 Reviewer role

A Reviewer receives a frozen subject, acceptance contract, evidence references, and bounded source
context. It returns a typed verdict such as `accept`, `rework`, `reroute`, or `escalate`. The verdict
does not directly write canonical state.

### 4.5 Baton control plane

The deterministic control plane owns:

- canonical IDs and revisions;
- schema and lifecycle validation;
- graph cycle and reference validation;
- compare-and-set state transitions;
- permission, budget, and capability admission;
- account pause and route policy enforcement;
- dispatch outbox, leases, fencing, cancellation, and reconciliation;
- completion gates and canonical projections.

It does not invent semantic work, decide whether prose is good, or silently replace a requested
user objective.

### 4.6 Scheduler

The Scheduler is deterministic backend logic. It computes readiness, obtains resources, chooses an
eligible route and account, creates execution assignments, and resumes suspended work. It does not
change the meaning of a WorkItem.

### 4.7 Plugins

Plugins may propose decomposition, dependencies, routes, review policies, domain workflows, and
graph mutations. They use the same typed proposal boundary as agents and have no direct provider
credential or canonical state mutation authority.

## 5. Canonical records

### 5.1 RequirementLedgerEntry

```text
requirement_id
goal_id
goal_revision
source_message_id
description
acceptance_contract
required_evidence
covered_by_work_item_ids
status
```

The requirement ledger prevents a graph from becoming internally complete while omitting part of
the user request.

### 5.2 WorkItemVersion

```text
work_item_id
version
run_id
objective
accepted_input_refs
acceptance_contract
required_capabilities
completion_policy
status_epoch
created_by_proposal_id
```

Semantic content is immutable within a version. Lifecycle transitions do not rewrite the semantic
version.

### 5.3 WorkGraphRevision

```text
run_id
revision
parent_revision
goal_revision
node_versions
dependency_edges
decision_consumers
committed_proposal_id
committed_at
```

A flat WorkSet is a graph revision with independent nodes and simple join requirements. A full
dynamic graph is not required for a single task.

### 5.4 ExecutionAssignment and Attempt

```text
assignment_id
work_item_id
work_item_version
goal_revision
graph_revision
execution_id
parent_execution_id
assignment_epoch
provider
requested_model
requested_effort
policy_snapshot
context_snapshot_ref
budget_reservation
fence_token
```

An attempt records dispatch and result lifecycle without overwriting prior attempts.

### 5.5 ResultCandidate and AcceptanceReceipt

Execution termination, result submission, WorkItem acceptance, and artifact promotion are different
events.

```text
Execution terminal
  -> ResultCandidate
  -> Machine gates and review
  -> AcceptanceReceipt
  -> AcceptedArtifact
```

Only accepted artifacts may satisfy downstream dependencies.

### 5.6 DecisionNode

```text
decision_id
decision_key
owner
kind
question
allowed_answers
direct_consumer_ids
goal_revision
graph_revision
status
answer_receipt
```

A decision blocks its direct consumers, affected descendants, and in-flight assignments invalidated
by the answer. It does not automatically block the entire Goal.

## 6. Dependency and resource semantics

Semantic edges are limited to:

- `hard_input`;
- `decision_input`;
- `integration_after`;
- `validation_after`;
- `condition`.

The following are Scheduler constraints, not semantic graph edges:

- provider or account concurrency;
- CPU and memory;
- path and write ownership;
- browser, emulator, device, and process leases;
- quota and rate limits.

An execution must not hold an exclusive resource lease while durably waiting for another execution
or user decision. Resources use deterministic acquisition order, bounded leases, and explicit
release before suspension.

## 7. Proposal and graph mutation

### 7.1 Proposal ingress

All proposal paths normalize into one journal:

```text
mid-turn typed tool proposal
turn-boundary structured proposal
user or UI proposal
host or static workflow proposal
plugin proposal
```

Natural-language assistant output is never parsed as an execution command.

### 7.2 GraphMutationProposal

```text
proposal_id
idempotency_key
base_graph_revision
goal_revision
proposer_execution_id
reason
evidence_refs
operations
affected_running_assignments
budget_delta
```

Before commit Baton validates:

1. exact Goal and graph revision;
2. stable and unique IDs;
3. no cycle or dangling reference;
4. bounded node, depth, and fan-out growth;
5. no unauthorized scope, permission, or budget expansion;
6. explicit disposition for affected active assignments;
7. required review or user decision receipts.

Commit creates a new immutable graph revision and fences invalidated assignments. Late results from
retired epochs remain diagnostic evidence and cannot satisfy current dependencies.

## 8. Scheduling and waiting

### 8.1 Readiness

A WorkItem is ready only when:

- every active semantic dependency has an accepted value;
- required decisions are valid for the current revisions;
- the branch condition is active;
- the WorkItem is not cancelled or superseded;
- required resources are currently acquirable;
- route, permission, capability, and budget admission succeeds.

### 8.2 Spawn and wait semantics

The public abstraction is work-centric. An agent proposes work and receives WorkItem or proposal IDs,
not ownership of a child agent.

Execution creation is asynchronous. Waiting is a durable scheduling intent, not a blocked provider
connection or process:

```text
parent records dependency wait
  -> parent releases resources
  -> provider round ends
  -> child completion event commits
  -> Scheduler rechecks the wait condition
  -> parent resumes in a new provider round
```

Wait registration rechecks the observed child generation to prevent lost wakeups.

### 8.3 Bounded execution

Node count, graph depth, concurrency, provider calls, token use, wall time, active time, retry count,
and review cycles are reserved or checked before new execution admission. Detached execution is
disabled by default.

## 9. Lifecycle and recovery

The execution lifecycle must distinguish uncertainty:

```text
PREPARED
STARTING
RUNNING
WAITING_DEPENDENCY
WAITING_DECISION
COMPLETED
FAILED
CANCELLED
INTERRUPTED
UNKNOWN
RECONCILIATION_REQUIRED
```

The graph, execution reservation, budget reservation, lease, and dispatch outbox are written before
provider dispatch. `STARTING` means an external effect may have begun. A crash in this state cannot
be retried unless a stable idempotency key or authoritative probe proves the safe action.

Cancellation, completion, and user steering are ordered through lifecycle epochs. A late completion
cannot reverse an already committed cancellation or Goal revision fence.

## 10. Security boundaries

- Provider-native subagent and team tools remain disabled in canonical mode.
- Worker permissions are equal to or narrower than the assignment snapshot.
- Permission expansion requires a user decision receipt.
- Account eligibility and manual pause epoch are rechecked before every provider round.
- Child output enters the parent as untrusted data or an artifact reference, never as system or
  control instructions.
- A child result cannot create work, grant permission, approve an effect, or complete a Goal without
  a new typed proposal and gate.
- Mutating effects require one-shot capability grants bound to assignment, epoch, scope, and intent.

## 11. Completion

The Coordinator or another completion agent may propose completion, but cannot terminalize the Goal.

Goal completion requires:

- the proposal targets the current Goal revision;
- every required requirement ledger entry has accepted evidence;
- every required WorkItem is accepted and settled;
- required joins and integration are complete;
- no unresolved decision, unknown effect, or reconciliation blocker remains;
- required machine gates and independent reviews have accepted receipts;
- no requested deliverable remains outside the coverage map.

Semantic quality cannot be proven by deterministic code alone. High-impact or ambiguous completion
uses a fresh independent reviewer or user decision. This reduces correlated error but does not make
semantic judgment infallible.

## 12. Run profiles

A finite WorkGraph is not universal.

| Profile | Purpose |
|---|---|
| `single` | One conversational or local execution |
| `workset` | Independent parallel work with simple joins |
| `dag` | Finite dependencies, decisions, integration, and validation |
| `batch` | Large homogeneous work using bounded partitions and reduction |
| `saga` | Approval-gated external effects with probes and compensation where possible |
| `recurring` | Monitoring or scheduled work represented as a series of finite runs |

Loops are represented as bounded new attempts or graph revisions, not cyclic graph edges.

## 13. UI projection

The conversation sidebar contains root conversations only. The default work UI is a flat WorkItem
list grouped by canonical status. The active provider, model, account disclosure, usage, attempt, and
latest activity are execution metadata.

Execution lineage and WorkGraph dependencies are different advanced views. The UI never derives
running or completed state from agent prose.

## 14. Incremental implementation

### Phase 0. Contract freeze

- requirement, WorkItem, assignment, attempt, candidate result, receipt, and lifecycle contracts;
- stable IDs, revisions, idempotency, fencing, and `UNKNOWN` semantics;
- provider-native child execution remains fail-closed.

### Phase 1. Flat WorkSet and durable child execution

- host-created independent WorkItems;
- depth one execution assignments;
- asynchronous dispatch, join, cancel, lease, and crash tests;
- no agent-driven dynamic mutation.

### Phase 2. Acceptance and turn-boundary proposals

- ResultCandidate and AcceptanceReceipt;
- requirement coverage;
- structured turn-boundary decomposition;
- static workflow profile.

### Phase 3. Scoped decisions and ready-set scheduling

- decision consumers;
- independent branches continue while one branch waits;
- checkpoint and continuation;
- no token-consuming process stays alive while waiting for the user.

### Phase 4. Limited dependencies and mid-turn proposals

- bounded dependency edges;
- work-centric proposal tools;
- durable suspend and resume;
- worker follow-up proposals enter the canonical inbox.

### Phase 5. Dynamic graph revision

- mutation review and CAS;
- impact closure, fencing, and stale result quarantine;
- bounded replan and review cycles;
- replaceable Coordinator leases.

### Phase 6. Additional profiles and plugins

- batch, saga, and recurring profiles;
- orchestration and domain plugins;
- multi-run fairness only after the local single-run contracts are proven.

## 15. Required verification

1. Two independent WorkItems run concurrently and join once.
2. A duplicate proposal or dispatch does not create duplicate canonical work.
3. A lost provider response produces `UNKNOWN`, not guessed failure or success.
4. Manual account pause prevents the next provider round.
5. A user decision blocks only its consumers and affected descendants.
6. A waiting execution holds no exclusive resource lease.
7. A stale Goal or graph result cannot satisfy a current dependency.
8. Child prompt injection cannot create control-plane state or capability.
9. Cancellation wins over late completion according to lifecycle epoch.
10. A Worker result requires acceptance before downstream use.
11. Missing requirement coverage prevents Goal completion.
12. Coordinator provider failure can be resumed by another provider from canonical artifacts.
13. Graph mutation rejects cycles, dangling references, and unbounded fan-out.
14. Batch, saga, and recurring work do not masquerade as ordinary finite DAG nodes.
15. UI status is reproducible from the canonical event journal.

## 16. Known irreducible limits

- Semantic decomposition and completion cannot be proven correct by schema validation alone.
- External effects cannot be exactly once without provider idempotency or an authoritative probe.
- Cancellation cannot prove that an already transmitted provider request performed no work.
- A provider may hide internal fallback or continuation behavior that Baton cannot attest.

The safe response is independent review, explicit user decisions, capability gating, and honest
`UNKNOWN` or `RECONCILIATION_REQUIRED` states, not silent retry or optimistic completion.

## 17. Related documents

- `COMMON_SESSION_DESIGN.md`
- `CANONICAL_AGENT_RUNTIME.md`
- `PARETO_ORCHESTRATION_PLUGIN_AND_EVOLVING_WORK_GRAPH.md`
- `PERSISTENT_GOAL_RUNTIME.md`
- `HOST_AUTOMATION.md`
- `../ParetoPilot/docs/nonblocking-user-decisions-and-dag.ko.md`
