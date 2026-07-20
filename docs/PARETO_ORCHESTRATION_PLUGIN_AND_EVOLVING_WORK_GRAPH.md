# Pareto Orchestration Plugin과 동적 작업 그래프 설계

> 상태: 설계 revision 24, 23차 독립 적대적 검수에서 APPROVE. 앞선 1~22차 REJECT의 유효 지적을 반영했다.
> 검수 판정은 설계 품질의 독립 evidence이며 정확성의 절대적 증명은 아니다. 구현은 본문의 migration과
> fail-closed 선행조건을 충족해야 한다.
> 기준일: 2026-07-20

## 1. 목적과 최종 결정

Pareto는 Baton의 canonical session/runtime을 대체하거나 별도 세션 정본을 만드는 기능이 아니라,
Baton 위에서 계획·분해·병렬 실행·검수·재작업·재계획을 수행하는 선택 가능한 orchestration plugin으로
연결한다.

한 Run은 하나의 트리 또는 하나의 고정 DAG로 표현하지 않는다. 서로 다른 사실을 다음 구조로 분리한다.

```text
Baton Thread
└─ Run
   ├─ GoalBindingSnapshot
   ├─ AgentInvocationTree
   ├─ WorkGraphRevision[]
   ├─ ExecutionAssignment / TaskAttempt[]
   ├─ Decision / Approval / ExternalAction[]
   └─ EventTimeline
```

- Baton은 대화, 실행, 계획 revision, 이벤트, 질문, 결과와 provider provenance의 SSOT다.
- Pareto는 교체 가능한 planning/orchestration policy다.
- Agent Invocation Tree는 실제로 누가 누구를 호출했는지 나타내는 안정적인 실행 계보다.
- Work Graph는 현재 해야 할 일과 실제 hard dependency를 나타내며 실행 중 revision 단위로 바뀐다.
- 모든 에이전트는 내부적으로 first-class invocation이지만 일반 세션 목록에는 자동으로 평면화하지 않는다.
- 모델은 graph mutation을 제안할 수 있지만 canonical graph를 직접 쓰거나 상태를 확정하지 못한다.
- 질문은 Run 전체를 멈추는 함수 호출이 아니라 영향을 받는 subgraph의 미해결 입력이다.

## 2. 기존 Baton 계약과의 관계

Baton의 canonical runtime은 provider-native subagent가 정본 밖 실행을 만들지 못하게 하고, 모든 child
execution을 Baton ID, parent edge, provider/model, budget, permission, working directory와 cancellation lease에
결박한다. 이 설계는 그 경계를 약화하지 않는다.

Pareto plugin은 provider-neutral Baton orchestration API만 사용한다. Codex, Claude, Gemini의 native agent
tool을 다시 활성화하거나 native child session을 정본으로 삼지 않는다. plugin이 비활성화되거나 제거되어도
Baton은 기존 Run과 모든 실행 이력을 읽고 복구할 수 있어야 한다. Pareto가 Baton DB를 직접 수정하거나
provider credential, native session ID 또는 비공개 gateway 관리 API를 소유해서는 안 된다.

이 문서는 동적 endpoint discovery나 Baton gateway preset을 설계하지 않는다. 그 문제는
`PARETO_DYNAMIC_GATEWAY_CONNECTOR_TODO.md`의 별도 선행 계약 범위다.

## 3. 서로 다른 세 구조

### 3.1 Agent Invocation Tree

Agent tree는 spawn lineage의 역사적 사실이다.

```text
Root Orchestrator
├─ Research Agent
├─ Implementation Agent
│  └─ Review Agent
└─ UI Agent
```

각 execution은 root를 제외하면 정확히 하나의 `parent_execution_id`를 가진다. 공동 요청, handoff,
review 같은 관계는 별도 typed relation으로 남길 수 있지만 실제 생성 부모를 바꾸지는 않는다. 이미 시작된
invocation을 다른 부모 아래로 옮겨 과거를 다시 쓰지 않는다.

### 3.2 Decomposition lineage

작업 분해 이력은 agent tree와 다르다. `A`가 `A1`, `A2`로 분해됐다는 사실, 여러 작업이 하나로
합쳐졌다는 사실, 새 작업이 기존 작업을 대체했다는 사실을 표현한다.

- `decomposed_into`: 부모 의미를 자식들이 나누어 충족한다.
- `merged_into`: 여러 작업을 하나의 새 작업으로 통합한다.
- `superseded_by`: 기존 작업의 의미나 접근법을 새 작업이 대체한다.
- `refined_by`: 논리적 목표는 유지하면서 계약을 더 구체화한다.

이 lineage는 감사·설명용이며 그 자체가 실행 순서를 의미하지 않는다.

### 3.3 Work dependency DAG

Work DAG의 edge는 후속 작업이 선행 결과를 실제 입력으로 소비하거나 control condition을 필요로 할 때만
존재한다. 같은 사람이 수행한다는 이유, 보기 좋은 순서 또는 write/resource 충돌만으로 semantic dependency를
만들지 않는다. resource 충돌은 별도 resource claim과 scheduler exclusion으로 처리한다.

각 committed revision의 active work graph는 DAG여야 한다. 시간에 따른 재작업은 기존 노드로 되돌아가는
cycle 대신 새 task version 또는 attempt를 만든다.

```text
implementation-v1 → review-v1 → implementation-v2 → review-v2
```

## 4. Canonical 데이터 모델

### 4.1 Run과 canonical Goal binding

`Run`은 한 사용자 요청을 승인 가능한 결과까지 처리하는 실행 경계다. 별도 Pareto `GoalRevision` 정본을
만들지 않는다. 각 Run은 다음 중 하나의 Baton canonical objective에 결박된 immutable
`GoalBindingSnapshot`을 가진다.

```text
GoalBindingSnapshot
- binding_kind: conversation_goal | turn_objective
- conversation_goal_id / goal_revision / goal_status_epoch?  # Goal-owned Run
- turn_objective_id / turn_objective_revision?                # 단일 turn 요청
- base_turn_id / amendment_chain_head_item_id?
- objective / acceptance / policy snapshot refs
- binding_hash
```

Persistent Goal 아래서 시작한 Run은 Baton `ConversationGoal`의 exact `(goal_id, revision, status/status_epoch)`를
foreign key로 사용한다. 일반 단일 요청은 별도 goal을 위조하지 않고 Baton-owned canonical
`TurnObjectiveRevision`에 결박한다.

여기서 FK 대상은 현재 Baton의 제자리 갱신되는 `goals` head row나 중복 가능한 event가 아니다. Baton-owned
append-only 정본을 다음처럼 migration한다. 이는 Pareto 전용 Goal 정본을 만드는 것이 아니라 기존
ConversationGoal의 revision/status history를 정상화하는 것이다.

```text
ConversationGoalRevision
- goal_id / goal_revision                         # unique
- objective / limits / policy snapshot
- parent_revision / revision_hash / created_at

ConversationGoalStatusEpoch
- goal_id / goal_revision / goal_status_epoch     # unique
- status / reason / created_at
- supersedes_status_epoch?
```

live `goals` row는 exact revision/status epoch head pointer와 편의 projection일 뿐 과거 정본을 덮어쓰거나 clear 때
삭제하지 않는다. Goal clear도 append-only cleared/tombstone status epoch를 만들며 기존 Run FK와
RecoveryAuthoritySnapshot을 보존한다. `GoalBindingSnapshot`은 위 unique tuple을 참조한다. 이 migration 전에는
Goal-owned Pareto Run을 feature gate로 시작하지 않는다.

Goal-owned Pareto Run은 기존 `GoalRuntime`과 별도 자동화 주체가 아니다. Run 생성 transaction은 현재
`GoalSchedulerLease`를 확장한 canonical `GoalAutomationOwnershipLease`를 exact goal ID/revision/status epoch에
대해 claim하거나 기존 Baton scheduler로부터 transfer한다.

```text
GoalAutomationOwnershipLease
- lease_id / ownership_epoch
- goal_id / goal_revision / goal_status_epoch
- owner_kind: standard_goal_runtime | pareto_run
- owner_id / pareto_run_id?
- owner_execution_ids[] / ownership_state: OWNED | TRANSFER_REQUESTED | RECONCILING
- acquired_at / heartbeat_at / expires_at
```

같은 Goal revision에는 한 owner만 존재한다. `owner_kind=pareto_run`인 동안 표준 GoalRuntime의 scan/claim과
continuation launch는 해당 Goal을 제외하며, 모든 Pareto execution/assignment/outbox/grant/result/completion은
exact ownership lease ID/epoch와 Run binding을 CAS한다. Run 취소·terminal·plugin loss 때 lease를 단순 만료로
재사용하지 않고 child/effect reconciliation과 recovery policy가 끝난 뒤 명시적으로 release/transfer한다. Run
생성과 lease claim/transfer, 표준 scheduler exclusion을 한 canonical transaction으로 제공하는 migration 전에는
Goal-owned Pareto Run을 시작하지 않는다.

표준 GoalRuntime도 continuation 시작 때 lease를 삭제·소비하고 권위를 잃어서는 안 된다. standard automatic turn과
그 child/tool/effect/completion 전체가 같은 ownership epoch와 owner execution 집합에 결박되고 terminal/reconciliation
때까지 heartbeat한다. 만료는 새 owner의 claim 근거가 아니라 기존 owner의 effect admission을 막고 recovery를
시작하는 신호다. active standard/Pareto owner 사이 직접 transfer는 금지한다. transfer transaction은 먼저
`TRANSFER_REQUESTED`로 epoch를 전진시켜 기존 execution/assignment/outbox/grant를 fence하고 cancel/probe하며,
모든 started effect가 known terminal 또는 ReconciliationGate로 포획된 뒤에만 새 owner/epoch를 commit한다. 새
owner의 Run/execution/outbox 생성과 old owner settlement/authority revoke는 같은 canonical transfer bundle에
들어가며 그 전에는 어느 쪽도 새 effect를 시작하지 못한다.

```text
TurnObjectiveRevision
- turn_objective_id / revision / parent_revision
- base_turn_id / base_user_input_digest
- amendment_user_item_id / amendment_digest?
- objective / acceptance / policy refs
- committed_at / revision_hash
```

최초 revision은 canonical turn/user input에서 만들고, 실행 중 steer가 objective, acceptance, 금지사항, policy
또는 완료 조건에 영향을 주면 원문 user item을 먼저 transcript에 보존한 뒤 safe boundary에서 새 revision을
append한다. graph replan/fence와 새 GoalBindingSnapshot head는 같은 canonical bundle로 commit한다. 사소한
표현 수정도 의미 영향이 없다면 supplemental instruction으로 분류 근거를 남기고, 의미 영향이 있다면 크기와
무관하게 objective revision을 요구한다. 실행·graph에서 사용하는 projection은 current binding으로부터
파생하며 독립 수정하지 않는다.

steer 원문 수신과 의미 분류 사이의 gap을 닫기 위해 Baton은 실제 수신 선형화점인 idempotent
`enqueueFollowUp(client_request_id, payload_digest)` transaction에서 follow-up record/event와 함께 Run의
monotonic `steer_epoch`를 즉시 전진시키고 해당 follow-up ID의 durable `SteerFenceToken`을
`STEER_PENDING_CLASSIFICATION`으로 추가한다. admission은 단일 boolean이 아니라 non-terminal token 집합이
비어 있는지를 CAS한다. transcript
user item은 후속 `consumeFollowUp`에서 만들어질 수 있지만 fence는 그 delivery를 기다리지 않는다. 이후 새 external-effect
CapabilityCallGrant, mutating tool call, child dispatch, graph/completion commit은 exact steer epoch와 “pending
steer 없음”을 CAS하므로 시작할 수 없다. 이미 권한 선형화 지점을 지난 effect는 중간 변조하지 않고 결과를
기록하되 amendment 영향 분석과 unknown-outcome 규칙에 포함한다. 독립 read-only computation은 결과가 old
binding provenance를 유지하는 조건으로 계속할 수 있다.

safe boundary의 `consumeFollowUp`에서 canonical transcript item을 만들고 steer를 분류한 뒤 의미 영향이 없으면
새 epoch에 supplemental instruction record를 결박해
fence를 해제한다. objective/acceptance/policy 영향이 있으면 TurnObjectiveRevision 또는 ConversationGoal
revision, graph replan, old assignment/effect fence와 새 binding을 같은 bundle로 commit한 뒤 해제한다. 따라서
“이제부터 network 금지” 같은 입력을 받은 뒤 old binding으로 새로운 network grant가 시작되지 않는다.

follow-up이 consume 전에 사용자 취소, `stale_goal`, supersede, expiry 또는 recovery policy로 known terminalize되면
같은 transaction에서 해당 SteerFenceToken도 `CANCELLED | STALE | SUPERSEDED | EXPIRED` terminal로 바꾸고
steer epoch를 전진시킨다. 다른 non-terminal token이 없고 Run/Goal lifecycle이 허용할 때만 admission을 다시
연다. stale Goal처럼 Run 자체가 rebind/cancel되어야 하는 경우 token 해제는 old effect 권한을 되살리지 않고
그 lifecycle 경로를 따른다. enqueue/terminalize 재시도는 follow-up ID로 idempotent하다.

`delivery_unknown`은 known terminal과 다르게 처리한다. SteerFenceToken을 `DELIVERY_UNKNOWN`으로 바꾸되 effect
admission을 해제하지 않고 Run을 `RECONCILIATION_REQUIRED(steer_delivery_unknown)` projection으로 둔다.
canonical `SteerDeliveryReconciliation`은 exact follow-up ID/client request ID/payload digest를 보존하고 다음
결론만 허용한다.

- 미전달을 결정적으로 증명: token을 CANCELLED로 terminalize하고 조건부 admission 재개
- 전달/consume을 증명: 같은 payload의 transcript item과 classification/amendment 경로로 진행
- adapter가 crash-durable provider-side exact-ID dedupe와 receipt/probe capability를 증명한 경우에만 같은
  idempotency key/digest 재전송으로 동일 follow-up을 resolve한다. receipt는 동일 provider execution과 payload가
  한 번만 적용됐음을 증명해야 한다.

증거가 없으면 새 effect는 계속 막고 독립 read-only 작업만 old-binding provenance로 진행한다. timeout만으로
미전달을 추측하거나 token을 자동 해제하지 않는다. adapter가 위 dedupe/receipt 계약을 제공하지 않으면 동일
ID 재전송도 resolution이 아니며 unknown을 유지하거나 기존 execution을 cancel/reconcile한 뒤 새 execution에서
replan한다. Baton row dedupe만으로 provider 적용의 exactly-once를 주장하지 않는다.

DELIVERY_UNKNOWN token은 같은 thread/turn follow-up queue의 head-of-line fence이기도 하다. 후속 follow-up은
durably enqueue할 수 있지만 claim/deliver/consume하지 않으며, 동일 client request ID/payload digest를 사용한
reconciliation 시도만 unknown head를 처리할 수 있다. 따라서 F1의 delivery가 불명확한 동안 반대 의미의 F2가
provider나 transcript에서 F1을 추월하지 않는다.

Goal 표현을 편집하면 Baton의 canonical Goal revision을 먼저 전진시키고 기존 Run을 stale/fenced 처리한 뒤
명시적 replan/rebind 또는 새 Run을 만든다. Goal pause/cancel은 Goal-owned Run의 lifecycle epoch, execution
lease, assignment fence와 pending outbox를 같은 canonical transaction에서 revoke한다. 핵심 목적이 다른 새
요청은 새 Run을 만들고 `supersedes_run_id` lineage로 연결한다. 어느 경계를 적용했는지 사용자에게 보여 주고
감사 event로 남긴다.

Goal `clear`와 confirmed `replace`도 예외가 아니다. old Goal을 삭제/교체하는 transaction은 자동화 권한이
남은 non-terminal Goal-owned Run만 `CANCEL_REQUESTED`로 옮기고 typed reason을
`STALE_GOAL_CLEARED/REPLACED`로 기록하며
lifecycle/steer epoch,
execution lease, assignment/effect fence와 pending outbox를 revoke한다. 이미 STARTING/RUNNING child는 같은
cancellation bundle의 cancel/probe 대상이 된다. 삭제 전에 old goal binding, execution/assignment/launch
identity, 각 revoke generation과 unresolved execution을 immutable `RecoveryAuthoritySnapshot` tombstone으로
같이 보존한다. replacement의 새 Goal ID로 old Run을 자동 재결박하지 않고
명시적 새 Run/replan을 요구한다. 이 transition을 지원하는 canonical migration 전에는 Goal-owned Pareto Run이
있는 thread의 clear/replace를 fail-closed하거나 먼저 Run을 정리한다.

Goal clear/replace만으로 이미 COMPLETED/FAILED/CANCELLED인 Run의 lifecycle과 결과를 바꾸지 않고
lineage/audit reference만 남긴다. 단, 이후 도착한 identity-valid evidence가 기존 settlement attestation과
모순되면 §4.7의 challenge/reopen 경로를 따른다. terminal projection에 unresolved effect가 있다면 clean terminal로 간주하지 않고 기존
RECONCILIATION_REQUIRED 계약을 따른다.

Run의 작업 outcome과 lifecycle settlement를 분리한다. 작업은 `FAILED` outcome을 가질 수 있어도 open
`UnresolvedEffectGate`가 하나라도 있으면 lifecycle/status projection은 `RECONCILIATION_REQUIRED`이며 settled
terminal이 아니다. gate가 닫힌 transaction에서만 FAILED/CANCELLED 같은 terminal lifecycle을 확정한다.
legacy/import 상태에서 terminal outcome과 unresolved evidence가 함께 발견되면 recovery migration이 lifecycle을
reconciliation projection으로 materialize하고 RecoveryAuthoritySnapshot을 만든다.

clear와 replace transaction은 old Run outcome과 무관하게 모든 open UnresolvedEffectGate의 affected
resource/effect reconciliation closure를 가리키는 thread-scoped canonical `GoalSuccessorBarrier`를 함께 만든다.
clear 뒤 나중에 생성되는 Goal도 이 barrier를 상속한다. 이후 모든 createGoal, successor Run, 표준 GoalRuntime
continuation의
assignment, resource lease, dispatch와 effect grant는 이 barrier의 exact generation을 dependency로 CAS한다.
old effect가 known-settled이거나 resource별 reconciliation/compensation이 완료된 범위만 해제한다. 무관한
resource closure의 새 작업은 계속할 수 있다. 단순 Goal replace 확인은 unresolved-effect 위험 인수 승인이
아니며, 위험 인수는 별도 exact unresolved manifest와 사용자 decision receipt가 있어야 한다.

barrier가 새 evidence로 다시 blocking되거나 generation이 전진하면 같은 transaction에서 그 resource closure를
소비한 successor assignment/resource lease/outbox/unconsumed grant뿐 아니라 result, context provenance,
completion/join, promotion/decision receipt를 impact-index fixpoint로 stale/invalidate/revoke한다. 이미 소비된
grant와 시작된 successor effect는 새 UnresolvedEffectGate에 넣고 cancel/probe/reconciliation한다.

### 4.2 WorkItem과 WorkItemVersion

논리적 작업 ID와 immutable version을 분리한다.

```text
WorkItem
- work_item_id
- run_id
- planning_scope_id

WorkItemVersion
- work_item_id
- version
- graph_revision
- title
- objective
- acceptance_criteria[]
- hard_input_refs[]
- output_contract
- risk_class
- resource_claims[]
- budget_envelope
- lineage

WorkItemState
- work_item_id / work_item_version
- state_epoch
- status
- reason / changed_by_event_id
```

오탈자나 표시용 metadata 변경도 revision에는 남기되 동일 논리적 작업으로 유지할 수 있다. 의미, 출력 계약,
핵심 acceptance criteria가 바뀌면 새 version 또는 새 WorkItem과 `superseded_by`를 사용한다.
WorkItemVersion은 생성 후 불변이며 ready/running/waiting/completed/stale 같은 lifecycle은 CAS-versioned
WorkItemState 또는 그와 동치인 canonical state event projection에서만 전진한다. lifecycle 변화만으로 semantic
WorkItem version을 만들지 않으며 result/dependency/review는 semantic version과 소비 당시 state epoch를 각각
결박한다.

### 4.3 Canonical Execution, Assignment와 Attempt

에이전트와 작업은 동일한 노드가 아니다.

새 `AgentInvocation` 실행 정본을 만들지 않는다. Baton의 기존 canonical `executions.id`,
`parent_execution_id`, status, policy, budget, usage와 cancellation lease가 유일한 실행 identity다.
Agent Invocation Tree는 `executions`에서 파생하는 projection이다. Pareto가 필요한 model/effort/context
필드는 기존 execution의 versioned 확장 또는 1:1 unique extension에 두되, parent/status/lease를 복제하지
않는다.

```text
CanonicalExecution
- execution_id
- parent_execution_id
- session_id / thread_id / run_id
- goal_binding_hash / conversation_goal_id+revision+status_epoch?
- provider / requested_model / effective_model
- requested_effort / effective_effort
- capability_snapshot
- context_snapshot_ref
- observed_information_classes[] / observed_provenance_closure_digest
- information_taint_epoch
- consumer_scope_digest
- status
- execution_lease_epoch

ExecutionAssignment
- assignment_id
- execution_id
- subject_kind: work_item | proposal_validation | promotion_review | decision_probe | goal_review
- subject_id / subject_version / subject_digest
- work_item_id / work_item_version (subject_kind=work_item일 때)
- goal_binding_hash / objective_policy_snapshot_hash
- graph_revision
- assignment_epoch
- task_snapshot_hash
- fence_token_hash
- input_information_classes[] / allowed_output_information_class
- status

TaskAttempt
- attempt_id
- assignment_id
- base_artifact_snapshot
- checkpoint_refs[]
- result_ref
- terminal_status
- continuation_of_attempt_id?
- source_information_class / provenance_closure_digest
```

한 WorkItem에 실패, 모델 교체, 독립 검수 등 여러 attempt가 붙을 수 있다. planning proposal 검수처럼 아직
active WorkGraph에 포함되지 않은 control-plane 실행도 immutable validation subject에 결박된 canonical
ExecutionAssignment를 가진다. 한 execution이 안전 경계에서
새 assignment를 받을 수 있지만 assignment와 attempt 이력은 덮어쓰지 않는다. 모든 checkpoint, result,
tool continuation과 completion proposal은 `execution_id + execution_lease_epoch + assignment_id +
assignment_epoch + fence_token`을 제출한다. retired epoch나 revoked fence의 입력은 결과가 옳아 보여도
canonical 상태에 반영하지 않는다.

같은 execution에 새 assignment를 줄 수 있는 것은 exact goal binding, objective/policy/capability/context base가
같을 때뿐이다. split처럼 graph/work item만 바뀌고 이 tuple이 유지되면 safe checkpoint 뒤 같은 execution을
계속 사용할 수 있다. TurnObjectiveRevision 또는 ConversationGoal revision이 바뀌면 기존 execution의 immutable
policy/context provenance를 고쳐 쓰지 않고 새 execution을 만든다.

live model memory도 canonical context 밖의 예외가 아니라 정보 흐름의 일부다. context item, tool result 또는
artifact를 execution에 전달하기 전에 같은 admission transaction이 해당 source class/provenance를 execution의
monotonic observed closure와 `information_taint_epoch`에 합친다. taint는 checkpoint, compaction이나 새 assignment로
내려가지 않는다. 새 assignment의 consumer가 누적 closure 전체를 읽을 권한이 있고 exact consumer scope가
일치할 때만 execution 재사용이 가능하다. `diagnostic_unpromoted`, promotion-review 또는 다른 consumer-scoped
정보를 한 번이라도 본 execution은 production assignment에 재사용하지 않는다. PromotionReceipt는 새 production
execution에 promoted view를 제공할 뿐 이미 tainted된 live execution을 정화하지 않는다. 이 규칙을 만족하지
못하면 safe checkpoint 여부와 무관하게 기존 execution을 retire하고 새 execution을 만든다.

### 4.4 WorkGraphRevision과 mutation journal

```text
WorkGraphRevision
- run_id
- revision
- parent_revision
- goal_binding_hash
- graph_hash
- committed_mutation_id
- committed_at

GraphMutationProposal
- mutation_id / idempotency_key
- run_id
- base_revision
- expected_run_lifecycle_epoch
- expected_steer_epoch / requires_no_pending_steer
- expected_goal_binding_hash / expected_goal_status_epoch?
- expected_impact_index_epoch / provenance_event_cursor
- actor_execution_id
- planning_scope_id
- expected_authority_epoch
- affected_scope_fences[]
- reason / evidence_refs[]
- operations[]
- acceptance_coverage_map
- dependency_rewrite
- running_attempt_disposition
- resource_claim_delta
- budget_delta
- estimated_impact
```

accepted proposal은 append-only mutation event와 새 immutable graph revision을 만든다. current graph는 journal을
materialize한 projection이다. 같은 base revision에서 경쟁하는 mutation은 compare-and-swap으로 하나만
commit하며, 나머지는 최신 revision에 rebase하고 다시 검증한다. 자동 blind merge는 금지한다. graph
revision만 비교하는 것으로는 충분하지 않으며 Run lifecycle과 영향받는 모든 planning scope authority epoch도
같은 CAS 조건이다. `affected_scope_fences`는 `scope_id`로 정렬한 exact
`{scope_id, authority_epoch, lease_owner_execution_id?}` 집합이며 commit 시 모두 일치해야 한다. cross-scope
reconciliation은 자신이 대표할 수 있는 scope 집합과 상위 authority를 명시한다.

제안자가 `affected_scope_fences`를 축소 선언할 수 없게 Coordinator가 canonical impact index에서 required
scope closure의 fixpoint를 직접 계산한다. 입력은 base graph와 operation target, decomposition ancestor,
변경되는 dependency/decision/action consumer, 실제 consumed-result provenance, derived-context source,
validation/promotion job, completion receipt, active assignment, resource lease와 budget reservation owner다.
새 scope가 추가되면 그 scope의 consumer/provenance를 다시 순회해 고정점까지 반복한다. Coordinator가 계산한
정렬된 exact set과 proposal의 declared set이 다르면 proposal을 거부하고 authoritative closure를 진단으로
돌려준다. 모든 consumed-result/context/provenance append는 expected impact-index epoch, source
work-item/result version과 current validity, graph head, consumer assignment fence를 함께 CAS한 뒤 monotonic
`impact_index_epoch`와 event cursor를 전진시킨다. source가 그 사이 supersede/invalidate되거나 graph-changing
commit이 먼저 끝났으면 지연 consumption append를 거부하고 consumer를 재결박한다. 모든 closure-changing
graph/challenge commit도 impact epoch를 반드시 전진시킨다. Coordinator는 graph bundle과 동일한 serialized
write transaction 안에서 최신 impact index를
읽고 closure를 다시 계산하며, expected epoch/cursor가 다르면 proposal을 재검증한다. commit은 계산된 set
전체를 안정적인 scope ID 순서로 CAS한다. impact-index snapshot digest,
계산 알고리즘과 버전을 mutation event에 기록하며 proposer가 제공한 impact summary를 권위 입력으로 사용하지
않는다.

### 4.5 Canonical graph-commit bundle과 실행 fence

다음 항목은 하나의 canonical transaction으로 commit한다.

1. mutation event와 새 graph revision/head
2. 영향받는 assignment epoch의 retire/revoke와 새 fence
3. running attempt disposition 및 기존 result의 stale/invalidation 상태
4. parent completion/join과 decision consumer 변경
5. 새 child thread/turn/spawn item/input snapshot, `PREPARED` execution과 dispatch outbox
6. scheduler readiness/outbox, canonical resource lease epoch와 budget reservation ledger
7. proposal/validation/promotion receipt와 decision receipt의 effect-class별 reservation/consumption,
   관련 planner inbox entry/ack
8. branch capability closure, `OrchestrationRequirementsSnapshot` version과 recovery mode
9. expected Run lifecycle/steer epoch와 no-pending-steer, exact Goal binding/status 및
   `affected_scope_fences[]` 전체의 정책상 전진/확인,
   closure-changing commit마다 impact-index epoch/cursor의 필수 전진

외부 process를 DB transaction으로 중단할 수 있다고 주장하지 않는다. transaction은 기존 execution의 권위를
먼저 fence하고 cancellation intent를 durable outbox에 남긴다. fence 뒤 도착한 provider result는
`orphaned_candidate`로만 보존하며 새 graph 결과로 승인하지 않는다. fence 시점에 mutation tool이 실행 중이어서
side effect 여부가 불명확하면 해당 영향 폐쇄를 `reconciliation_required`로 만들고 자동 재실행하지 않는다.

### 4.6 Child execution dispatch 상태기

child를 시작하기 전에 stable `execution_id`, parent edge, dispatch idempotency key, execution lease와 exact
assignment fence를 같은 transaction에서 예약한다.

```text
PREPARED → STARTING → RUNNING → COMPLETED | FAILED | CANCELLED | INTERRUPTED | UNKNOWN
    └→ CANCELLED      ├→ CANCELLED        # durable CLOSED_NO_START
                      └→ INTERRUPTED | UNKNOWN
```

- `PREPARED`는 launch claim 전에 취소 transaction으로 바로 CANCELLED가 될 수 있다.
- `STARTING` 이후 start acknowledgement가 유실되면 실행되지 않았다고 추측하지 않는다.
- process/adapter가 durable `CLOSED_NO_START`를 증명하면 STARTING에서 RUNNING을 거치지 않고 같은 execution을
  CANCELLED로 terminalize한다.
- 실행 여부 또는 side effect가 불명확하면 `UNKNOWN`/reconciliation에서 멈추며 새 execution을 dispatch하지
  않는다.
- retry가 허용되면 기존 execution을 재사용하지 않고 이전 terminal/known outcome에 연결된 새
  `execution_id`와 attempt를 만든다.

현재 Baton `executions` schema와 `ExecutionStatus`는 `PREPARED`, `STARTING`, `UNKNOWN`, lease epoch를
지원하지 않고 `turn_id`도 `NOT NULL UNIQUE`다. 따라서 이 설계는 기존 schema 위에서 곧바로 구현할 수
없으며 다음 canonical migration이 Phase 1의 선행 조건이다.

1. canonical `ExecutionStatus`와 SQLite CHECK에 `prepared`, `starting`, `unknown`을 추가하고, Thread의
   canonical blocked reason/projection에 `reconciliation_required + unresolved_execution_ref`를 추가한다.
2. `execution_lease_epoch`, dispatch idempotency key, assignment fence hash와 launch claim metadata를
   `executions` 또는 같은 transaction/owner가 관리하는 1:1 canonical execution-state extension에 추가한다.
3. extension을 선택해도 execution lifecycle transition의 유일한 writer는 SessionStore이며 UI/scheduler는
   `executions`에서 만든 하나의 결정적 projection만 읽는다. 서로 독립적으로 갱신되는 두 status 정본은
   금지한다.
4. child `thread`, `turn`, spawn item, immutable input/context snapshot, execution, assignment와 outbox를 graph
   bundle transaction에서 함께 만든다. 각 retry는 새 child turn과 execution을 사용한다.
5. migration 전에는 Baton-managed Pareto child dispatch를 feature gate로 fail-closed한다.

Turn/Execution/Thread projection도 같은 migration에서 다음처럼 고정한다.

| Execution | Turn | Thread/new-turn policy |
|---|---|---|
| `PREPARED` | `queued` | active queued child; 같은 turn/execution 중복 생성 금지 |
| `STARTING` | `running` | launch 가능성이 있으므로 새 turn 및 같은 logical dispatch 재사용 금지 |
| `RUNNING` | `running`/기존 waiting 상태 | 기존 canonical active-turn 규칙 유지 |
| `UNKNOWN` | `interrupted` + unresolved execution ref | thread를 `reconciliation_required` projection으로 고정; 새 turn 금지 |
| known terminal | 해당 terminal TurnStatus | unresolved child가 없을 때만 thread idle/다음 turn 허용 |

현재 startup recovery처럼 모든 active execution/turn을 일괄 `interrupted`로 바꾸고 thread를 `idle`로 푸는
경로는 이 execution kind에 적용하지 않는다. SessionStore의 versioned CAS API가 위 mapping을 함께 전이하며,
recovery도 execution launch state와 unresolved reference를 먼저 읽는다.

STARTING claim 전에 cancellation이 이기면 같은 cancellation transaction에서 `Execution PREPARED→CANCELLED`,
`Turn queued→cancelled`, assignment/attempt terminal, outbox/lease revoke를 함께 commit한다. 같은 thread에 다른
unresolved child가 없을 때만 thread를 idle로 푼다. STARTING 이상이면 Thread의 canonical blocked reason과
unresolved execution ref를 유지해 일반 active-turn recovery와 새 turn 생성을 막는다.

child adapter는 다음 Baton-owned capability를 구현해야 한다.

```text
start_once(execution_id, launch_claim_epoch, immutable_start_spec)
probe(execution_id, launch_claim_epoch)
cancel(execution_id, launch_claim_epoch)
close_without_start(execution_id, launch_claim_epoch)
```

adapter/sidecar는 각 claim에 대해 Baton DB와 독립적으로도 crash-durable한 다음 상태를 보존한다.

```text
UNSEEN → CLAIMED → LAUNCHING → STARTED
UNSEEN | CLAIMED → CLOSED_NO_START
LAUNCHING → STARTED | UNKNOWN
```

`close_without_start`와 “실행 없음” probe의 확정은 claim을 원자적으로 `CLOSED_NO_START`로 tombstone한다.
그 뒤 늦게 재개한 worker의 `start_once`는 영구 거부된다. `STARTED`에는 stable process/provider identity,
event stream high-watermark와 terminal attestation이 연결된다. 같은 `(execution_id, launch_claim_epoch)`의 반복
start는 거부하거나 새 identity를 만들지 않고 같은 launch를 완료·resume/probe해야 한다. claim이
`STARTED`인지 `CLOSED_NO_START`인지 증명하는 adapter
acknowledgement 전에는 clean `CANCELLED`로 전이하지 않는다. 이 capability를
제공하거나 process identity/Job lease로 등가 보증하지 못하는 adapter에는 managed child dispatch를 허용하지
않는다.

receiver 측에서 stable provider idempotency key와 resume semantics를 제공하거나, Baton의 crash-surviving
LaunchSupervisor가 claim DB, stable process/rendezvous identity와 OS Job/lock을 소유해야 한다. Supervisor는
LAUNCHING crash 뒤 동일 identity의 process/provider request를 probe·resume하고, 중복 process가 생겨도
registration과 CapabilityCallGrant를 단 하나의 identity에만 부여해 외부 effect 전에 나머지를 종료한다.
process/provider 시작과 durable identity 연계를 증명할 수 없는 adapter는 feature gate에서 거부한다. 단순히
`STARTED`를 process 생성 전후 한쪽에 기록하는 구현은 이 계약을 만족하지 않는다.

outbox worker는 단순 read-check 뒤 process를 시작하지 않는다. 하나의 transaction에서
`PREPARED → STARTING` CAS, launch-claim lease와 outbox claim을 함께 commit한다. 이 `STARTING` claim이
launch의 canonical 선형화 지점이다.

- claim 전에 cancellation이 commit되면 CAS가 실패하고 child를 시작하지 않는다.
- claim 뒤 cancellation이 오면 아직 adapter 호출 전이어도 canonical하게 “이미 시작 가능성이 있는 child”로
  취급한다. cancel/probe가 terminal outcome을 확정할 때까지 Run은 settled terminal이 아니다.
- worker가 claim 뒤 실제 launch 전에 죽어도 restart는 `STARTING`을 `PREPARED`로 되돌리지 않는다. exact
  adapter/process identity probe가 실행 부재를 증명하거나 reconciliation해야 한다.
- adapter start acknowledgement는 같은 execution/claim에 결박해 `RUNNING`으로 전이한다.

### 4.7 Run lifecycle fencing과 취소 우선순위

`Run`에는 graph revision과 별개인 monotonic `lifecycle_epoch`와 canonical lifecycle status가 있다. 최소
상태는 `ACTIVE | CANCEL_REQUESTED | CANCELLING | COMPLETED | FAILED | CANCELLED |
RECONCILIATION_REQUIRED`를 포함한다. Run outcome과 lifecycle projection은
분리하되 reconciliation 진입 transaction은 다음 예정 settlement도 canonical하게 고정한다.

```text
reconciliation_resume_status: ACTIVE | COMPLETED | FAILED | CANCELLED
pending_terminal_outcome?: COMPLETED | FAILED | CANCELLED
pending_terminal_reason?
pending_terminal_outcome_epoch?
```

`reconciliation_resume_status`는 gate가 없었다면 돌아갈 lifecycle이며 전달 불명 steer처럼 실행 중 일시
reconciliation이면 ACTIVE다. `pending_terminal_outcome`은 terminal 후보가 unknown effect에 막힌 경우에만
필수이며 resolver의 사후 추측이 아니다. 최초 reconciliation 진입을 유발한 result/cancellation transaction이
exact evidence cursor와 함께 기록한다. 더 높은
우선순위의 cancellation intent가 뒤늦게 들어오면 lifecycle epoch를 전진시키는 별도 transition으로만 pending
outcome을 CANCELLED 계열로 supersede하며 이력은 보존한다. 모든
graph mutation, execution 준비, dispatch outbox 소비와 result commit은 자신이 본 lifecycle epoch와
non-terminal status를 조건으로 제출한다.

Goal-owned Run에서는 같은 경계가 exact canonical `conversation_goal_id + goal_revision + goal_status_epoch +
active/running status`도 CAS한다. Goal edit/pause/cancel transaction은 Goal revision/status를 먼저 전진시키면서
소유 Run의 lifecycle epoch와 모든 pending launch/effect fence를 함께 전진·revoke한다. 따라서 stale Goal에
결박된 mutation, PREPARED/STARTING claim, result/completion, Decision receipt와 CapabilityCallGrant는 적용되지
않는다. 새 Goal revision으로 계속하려면 safe reconciliation/replan에서 새 GoalBindingSnapshot을 commit한다.

우선순위는 cancellation intent, unknown mutating outcome/reconciliation, approval/decision wait, budget·policy
limit, ordinary failure, valid completion 순이다. cancellation transaction은 먼저 `CANCEL_REQUESTED`로
lifecycle epoch를 전진시키고
모든 active execution lease와 assignment fence를 revoke하며 pending dispatch outbox를 무효화한다. outbox
consumer의 `STARTING` claim이 이미 commit됐다면 이를 이미 시작 가능한 child로 포함해 `CANCELLING`에서
취소·probe한다. 모든 child와 external effect가 settled known outcome일 때만 `CANCELLED`가 된다. mutation
outcome이 불명확하면 `RECONCILIATION_REQUIRED`로 남겨 자동 후속
작업을 금지하고, reconciliation owner·evidence·보존 정책을 canonical record에 둔다. plugin이 없어도 Baton이
이 unresolved gate를 삭제하거나 완료로 오인하지 않는다.

허용 lifecycle transition은 다음으로 제한한다.

```text
ACTIVE → COMPLETED
ACTIVE → FAILED
ACTIVE → RECONCILIATION_REQUIRED(resume=ACTIVE, non-terminal uncertainty)
ACTIVE → RECONCILIATION_REQUIRED(resume=COMPLETED|FAILED, matching pending_terminal_outcome required)
ACTIVE → CANCEL_REQUESTED → CANCELLING
CANCELLING → CANCELLED
CANCELLING → RECONCILIATION_REQUIRED(resume=CANCELLED, pending_terminal_outcome=CANCELLED)
RECONCILIATION_REQUIRED → COMPLETED
RECONCILIATION_REQUIRED → FAILED
RECONCILIATION_REQUIRED → CANCELLED
RECONCILIATION_REQUIRED → ACTIVE
COMPLETED | FAILED | CANCELLED → RECONCILIATION_REQUIRED(late_identity_valid_evidence)
```

`RECONCILIATION_REQUIRED`에서는 모든 open ReconciliationGate/UnresolvedEffectGate가 아래 검증 계약으로
닫히고 조건이 다시 계산된 뒤에만 exact `reconciliation_resume_status`로 전이한다. terminal resume이면
`pending_terminal_outcome + pending_terminal_outcome_epoch`도 exact-match해야 한다. ACTIVE resume은 original
lifecycle/Goal/steer/ownership fence가 여전히 current이고 재개가 새 effect를 안전하게 허용할 때만 가능하며,
그렇지 않으면 replan/cancel 경로를 따른다. resolver는 outcome을 바꾸거나 “해결됨”이라고 단독 선언할 수 없다.
새 evidence가 작업 결과 자체를
뒤집는다면 원래 pending outcome을 조용히 고치는 대신 별도 superseding adjudication event와 정책상 요구되는
검수/승인을 거쳐 새 lifecycle epoch에 결박한다.

`CANCELLED`는 모든 effect가 known/settled일 때만 가능하다. 사용자가 정확한 unresolved manifest와 위험을
확인하고 자동 수렴을 더 시도하지 않기로 선택해도 lifecycle은 `RECONCILIATION_REQUIRED`로 유지한다. 별도
`automation_stopped=true`, `risk_acknowledged_receipt_id` projection만 기록하고 gate나 successor/resource barrier를
닫지 않는다. 이는 운영 자동화를 멈추는 결정이지 unknown outcome을 known으로 바꾸는 resolution이 아니다.

clean `CANCELLED`에는 모든 launch claim의 durable `CLOSED_NO_START` 또는 `STARTED + terminal attestation`,
adapter event high-watermark와 known effect outcome이 필요하다. adapter가 “이 watermark 뒤에는 해당 claim의
새 event/effect가 없다”는 terminal 보증을 제공하지 못하면 clean cancellation로 수렴하지 않고
RECONCILIATION_REQUIRED에 남는다.

모든 terminal settlement event 자체는 immutable하게 보존하되 별도 monotonic
`RunSettlementAttestation`의 generation과 `VALID | CHALLENGED | SUPERSEDED` 상태를 둔다. COMPLETED, FAILED,
CANCELLED를 근거로 thread idle, parent join, 후속 assignment 또는 resource lease를 연 projection은 exact VALID
attestation generation을 consumed input으로 기록한다.

attestation을 전제로 만드는 모든 assignment, join, outbox, result, resource/budget/credential lease,
decision/completion/promotion receipt와 CapabilityCallGrant는 canonical authority-dependency 집합에 exact
`attestation_id + generation + VALID + dependency_epoch`를 포함하고 생성·소비 시 CAS한다. 이는 cross-Run
consumer에도 적용한다. challenge transaction은 dependency epoch와 impact epoch를 전진시키므로 VALID를 읽고
대기하던 지연 admission도 commit할 수 없다.

ordinary result commit과 별도로 append-only `submit_reconciliation_evidence`를 둔다. 이는 revoked assignment
fence를 다시 활성화하지 않고 exact execution/launch claim, provider/process identity, evidence source·digest와
관측 시각을 기록한다. reconciliation만 가능한 상태에서는 일반 graph mutation, child dispatch와 completion을
전부 금지하고 다음 필드의 CAS를 통과한 resolver만 결론을 commit한다.

```text
ReconciliationGate
- gate_id / generation
- run_lifecycle_epoch
- affected_execution_ids[]
- affected_call_id
- call_revision
- idempotency_key
- owner_kind / owner_id
- resolver_id / resolver_version
- reconciliation_lease_epoch / expiry
- evidence_cursor / evidence_digest
- trusted_verifier_receipt_id / trusted_verifier_receipt_digest
- verifier_policy_version
- allowed_resolutions[]
```

unknown external call마다 별도 gate를 만들며 `affected_call_id + call_revision + idempotency_key`는 그 호출의
inflight journal/CapabilityCallGrant와 exact-match해야 한다. launch처럼 call이 아닌 unknown에는 같은 강도의
typed launch claim/adapter identity tuple을 사용하고 call 필드를 임의 sentinel로 대체하지 않는다. owner 또는
resolver의 assertion만으로 gate를 닫을 수 없다. resolver는 immutable evidence를 제출하고, Baton이 주입한
trusted verifier가 해당 exact call tuple, resolver/version, evidence cursor/digest와 verifier policy version을
검증한 receipt를 발급해야 한다. policy가 요구하면 producer, resolver와 verifier authority를 서로 분리한다.
gate-close transaction은 이 필드 전체, gate generation과 Run lifecycle epoch를 CAS하고 verifier receipt를
단일 소비한다. 이 receipt 없이 자동 retry, terminal settlement, GoalSuccessorBarrier 해제 또는 successor
effect admission을 허용하지 않는다.

late provider result는 ordinary task result가 아니라 이 evidence 경로로만 들어간다. owner lease가 만료돼도
gate나 evidence를 삭제하거나 자동 해결하지 않으며 Baton/user 또는 compatible plugin으로 authority를
명시적으로 인계한다. 보존 기간은 Run audit retention보다 짧을 수 없고, 삭제 정책이 도래해도 unresolved
fact를 tombstone/summary 없이 제거하지 않는다.

계약을 위반한 adapter나 외부 source에서 어떤 terminal settlement attestation과도 모순되는 새 identity-valid
evidence가 도착하면 audit append를 거부하지 않는다. lifecycle epoch를 전진시키는
`COMPLETED | FAILED | CANCELLED → RECONCILIATION_REQUIRED(late_identity_valid_evidence)` 전이로 다시 열고 해당
adapter capability를 quarantine한다. 같은 reopen transaction에서 `reconciliation_resume_status`를 직전 terminal로
기록하고 attestation을 CHALLENGED로 만들며 thread를 blocked로 전환한다.
Goal-owned COMPLETED Run이면 §12의 GoalCompletionAttestation challenge, Goal status-epoch 전진,
GoalSuccessorBarrier와 recovery ownership 전환도 이 reopen transaction의 필수 일부다.
canonical impact-index fixpoint로 그 attestation을 소비한 후속 assignment/join/result/resource lease를 fence해
stale/reconciliation 상태로 만든다. 이미 일어난 후속 external effect는 되돌아갔다고 추측하지 않고 별도
unknown-effect gate에 포함한다. child Execution/Turn의 과거 CANCELLED event는 변경하지 않되 unresolved-effect
projection/ref를 추가한다. 이는 일반 후속 작업 재개가 아니라 evidence 수렴 전용 예외 전이다.

## 5. 계획 주체와 권한 분리

```text
User / Goal Owner
        │
        ▼
Plan Coordinator ─ canonical commit authority
        │
        ├─ Root Planner
        ├─ Local/Subtree Planner
        ├─ Worker
        ├─ Reviewer
        └─ Scheduler / Runtime Monitor
```

### 5.1 User / Goal Owner

목표, 외부 권한, 파괴적 행동, 제품 범위와 승인 기준의 최종 권위다. 모델이나 plugin이 이를 조용히 확장하지
못한다.

### 5.2 Root Planner

Run 전체의 초기 계획, acceptance coverage, 통합 전략과 cross-subgraph 일관성을 제안한다. Root Planner가
계획의 정본은 아니다. 종료되거나 교체돼도 WorkGraph가 남아야 한다.

### 5.3 Local Planner와 Worker

배정받은 planning scope 안에서 상세 분해나 변경을 제안할 수 있다. Worker도 수행 중 새 사실을 발견하면
같은 proposal protocol을 사용한다. 자신이 맡지 않은 subgraph, 목표, 권한 또는 예산을 직접 바꾸지는 못한다.

### 5.4 Reviewer

누락, 부적합한 접근법, 추가 검수나 재작업 필요성을 발견하면 mutation을 제안한다. Reviewer verdict만으로
작업을 생성·취소·승인하지 않는다. 동일한 구조·정책 gate를 통과해야 한다.

### 5.5 Scheduler와 Runtime Monitor

ready-set 계산, resource lease, 재시도·재배치와 상태 projection을 담당한다. 의미론적 작업이나 acceptance
criteria를 임의로 바꾸지 않는다. 실행 실패가 계획 변경을 요구하면 proposal을 만들거나 planner를 호출한다.

### 5.6 Plan Coordinator

중앙의 거대한 planning 모델이 아니라 가능한 한 deterministic한 runtime component다.

- revision CAS와 idempotency
- schema, identity, cycle과 dangling reference 검증
- planning scope, capability, budget policy 검증
- dependency/resource claim 구분 검증
- running attempt disposition과 downstream invalidation 적용
- event commit과 scheduler notification
- 필요한 semantic review, parent reconciliation 또는 user decision gate 생성

자연어 acceptance coverage의 진실성이나 새 접근법의 품질을 deterministic하게 판정할 수 있다고 주장하지
않는다. 구조 검증으로 충분하지 않은 mutation은 별도 planner/reviewer verdict 또는 사용자 결정을 요구한다.

## 6. Planning scope와 변경 승인 등급

플래닝 소유권은 특정 에이전트의 기억이 아니라 durable scope에 둔다.

```text
PlanningScope
- scope_id
- root_work_item_id
- active_planner_execution_id?
- authority_epoch
- authority_lease_owner_execution_id?
- authority_lease_expiry?
- inbox_cursor / inbox_ack_cursor
- allowed_mutation_kinds[]
- external_edge_policy
- budget_envelope
- risk_ceiling
- escalation_target
- revision_seen
```

scope 인계는 authority epoch를 전진시키고 이전 lease를 revoke하는 canonical transaction이다. proposal,
semantic review verdict, reconciliation completion, integration decision과 completion proposal은 exact
`goal_binding_hash + graph_revision + scope_id + authority_epoch`에 결박한다. conversation-goal binding이면
canonical goal ID/revision/status epoch도 함께 CAS한다. 늦게 돌아온 이전 planner의 verdict는
새 graph와 의미상 같아 보여도 적용하지 않는다. inbox ack와 이를 근거로 한 planning commit은 같은
transaction 또는 exact cursor CAS로 결박한다.

### 6.1 Level 1: 기계적으로 보존이 확인되는 로컬 변경

다음을 모두 만족할 때 구조 gate와 policy gate를 통과한 뒤 상위 플래너의 동기 응답 없이 commit할 수 있다.

- Goal과 상위 acceptance criteria를 바꾸지 않는다.
- 배정된 planning scope 안에서만 일어난다.
- 외부 subgraph의 hard dependency와 이미 승인된 결과를 바꾸지 않는다.
- resource, budget, model/tool 권한 경계 안이다.
- destructive/external action이나 새 사용자 권한이 없다.
- objective, output contract, 자연어 acceptance 의미와 외부 dependency를 바꾸지 않는다.
- typed criterion의 exact partition처럼 의미 보존을 기계적으로 검증할 수 있거나, graph 의미를 바꾸지 않는
  support/diagnostic node 추가·attempt retry/reassignment allowlist에 해당한다.
- parent completion join이 보존된다.

Level 1 support/diagnostic node는 read-only이거나 별도 immutable base에서 만드는 폐기 가능한 격리 artifact만
허용한다. production workspace write, external effect, hard input, acceptance evidence 또는 parent completion
근거가 될 수 없다. 결과를 active task가 소비하거나 production artifact/evidence로 승격하려면 그 exact result
digest를 포함한 Level 2 mutation과 semantic review를 통과해야 한다. 단순히 이름을 diagnostic으로 붙여 이
경계를 우회하지 못한다.

이 경계는 선언만으로 두지 않고 canonical information-flow label로 집행한다. Level 1 결과, 그 일부를 포함한
summary/context/tool input과 파생 artifact에는 `diagnostic_unpromoted` class, source assignment와 provenance
closure digest를 전파한다. Baton-owned context assembler와 tool gate는 active/production assignment의
snapshot에 이 class가 들어가는 것을 거부한다. Level 2 `PromotionReceipt`는 승격할 exact source/result/summary
digest, 허용 consumer와 consumer-scoped target class를 기록하며 graph bundle에서 소비된다. source/result의
원래 information class를 전역으로 변경하지 않는다. 모델이 내용을 복사해
새 message로 우회하지 못하도록 모든 canonical context 생성은 source item provenance closure를 보존하고,
정본 밖 clipboard/file 경로는 diagnostic capability에서 노출하지 않는다.

승격 검수는 일반 production/control assignment가 아니라 `subject_kind=promotion_review`인 quarantine
assignment에서 수행한다. 이 reviewer는 diagnostic source를 읽을 수 있지만 모든 prompt, summary, verdict와
artifact가 계속 `diagnostic_unpromoted`로 taint된다. tainted verdict는 graph mutation이나 completion을 직접
승인할 수 없고 exact digest의 `PromotionRequest`만 제안한다. 모델 reviewer와 분리된 declassification
authority(사용자 또는 versioned policy가 허용한 trusted deterministic verifier)가 source/provenance closure,
목적 consumer와 위험을 확인해 PromotionReceipt를 만든다. receipt와 consumer-scoped promoted-view edge
생성은 같은 canonical bundle에서 원자화한다. 모델이 자신의 결과를 스스로 declassify하지 못한다.

PromotionReceipt는 source/result/summary/provenance digest 외에 exact consumer
`work_item_id + version + contract_hash`, goal-binding/graph revision, planning scope authority epoch,
policy/risk/permission snapshot digest, declassifier/verifier ID·version과 target information class를 포함한다.
bundle은 이 tuple 전체를 CAS하고 exact declassification transition에서 receipt를 one-shot 소비한다. consumer
refine, goal/policy/authority 변경 또는 다른 consumer로의 재사용은 새 promotion review와 receipt가 필요하다.
context assembler와 tool gate는 source의 전역 label이 아니라 매 소비마다 exact
`receipt_id + source/provenance digest + consumer tuple + target class` edge를 요구한다.

상위 플래너에는 durable semantic diff를 통지한다.

일반적인 자연어 task의 `split`, `refine`, `merge`, `supersede`를 worker의 coverage 주장만으로 Level 1
commit하지 않는다. exact task/goal snapshot에 결박된 독립 semantic plan-review verdict가 없다면 Level 2로
fail-closed 승격한다. review가 진행되는 동안 기존 attempt가 안전하게 계속할 수 있는 범위와 독립 ready work는
멈추지 않지만 새 의미를 전제로 한 child는 dispatch하지 않는다.

### 6.2 Level 2: Parent reconciliation

다음은 영향받은 subgraph만 보류하거나 provisional 상태로 두고 상위 planning scope의 reconciliation을
요구한다.

- 다른 subtree와 hard dependency를 추가·제거한다.
- 이미 완료된 결과가 stale 또는 invalid가 될 수 있다.
- 여러 상위 작업의 merge나 cross-cutting integration 변경이다.
- critical path, integration 전략 또는 review coverage가 크게 바뀐다.
- 자연어 의미의 보존 여부를 구조적으로 증명할 수 없다.
- 일반 자연어 split/refine이며 독립 semantic verdict가 아직 없다.

영향받지 않는 ready work는 계속 실행한다.

### 6.3 Level 3: User decision

다음은 사용자 결정 없이는 affected work를 dispatch하지 않는다.

- Goal이나 핵심 acceptance criteria 변경
- 프로젝트·제품·API 범위 확대
- 새로운 외부 권한, credential 또는 사람의 행동 필요
- 파괴적·비가역적 행동
- 승인된 비용·시간·provider/security 정책 초과
- 합리적인 여러 선택지 중 사용자 의도가 결과를 결정

질문과 무관한 subgraph는 계속 실행한다.

### 6.4 Proposal validation bootstrap

아직 commit되지 않은 mutation을 검수하기 위해 그 mutation의 child WorkItem을 먼저 만들지 않는다. Baton은
active WorkGraph와 구분되는 canonical `ProposalValidationJob`을 제공한다.

```text
ProposalValidationJob
- validation_job_id
- job_generation / claim_epoch / lifecycle_epoch
- mutation_id / proposal_digest
- base_goal_binding_hash / base_graph_revision
- affected_scope_fences[]
- review_policy_snapshot
- status: PREPARED | STARTING | RUNNING | VERDICT_RECORDED | CONSUMED | REJECTED | OBSOLETED |
  DISCARDED | FAILED | CANCELLED | INTERRUPTED | UNKNOWN
- verdict_kind: approve | reject?
- terminal_reason?
- dispatch_idempotency_key
- parent_execution_id
- assignment_id / assignment_epoch
- verdict_execution_id?
- verdict_digest?
```

Plan Coordinator는 validation job, `subject_kind=proposal_validation`인 ExecutionAssignment, reviewer child
thread/turn/execution과 dispatch outbox를 canonical transaction으로 만든다. reviewer는 immutable proposal
digest만 검수하며 active graph를 수정하지 않는다. verdict는 exact job, requested/effective model·effort,
base revisions와 scope fences에 결박한다. verdict와 mutation commit 사이에 head/scope가 바뀌면 verdict를
자동 재사용하지 않고 영향 재검증 또는 새 validation job을 요구한다. 이 control-plane job은 Work DAG의
사용자 작업 node가 아니며 UI에서는 plan review로 별도 표시한다.

job 생성은 Run lifecycle, affected scope fence, capability lease와 review budget을 CAS하고 canonical parent
execution, unique assignment generation과 budget reservation을 함께 만든다. reviewer launch는 일반 child와
동일한 PREPARED/STARTING 상태기와 start-once 계약을 사용한다. reviewer result, verdict digest,
`VERDICT_RECORDED`, reviewer execution/Turn과 assignment/attempt terminal, reviewer resource release와 budget
usage를 한 transaction으로 commit한다. `VERDICT_RECORDED`는 실행 중 상태가 아니라 canonical verdict escrow다.
mutation
commit은 exact verdict를 소비하면서 `VERDICT_RECORDED → CONSUMED`를 같은 graph bundle에서 전이한다.
crash 후 `STARTING/RUNNING/UNKNOWN` job을 새 reviewer로 추측 재실행하지 않으며, 새 generation은 이전
outcome이 known terminal이거나 명시적 reconciliation을 거친 뒤에만 만든다.

허용 전이는 `PREPARED→STARTING|CANCELLED|DISCARDED`,
`STARTING→RUNNING|CANCELLED|INTERRUPTED|UNKNOWN`,
`RUNNING→VERDICT_RECORDED|FAILED|CANCELLED|INTERRUPTED|UNKNOWN`,
`VERDICT_RECORDED→CONSUMED|REJECTED|OBSOLETED`다.
launch 부재가 durable `CLOSED_NO_START`로 증명되면 CANCELLED, process가 known하게 종료됐지만 verdict가 없으면
FAILED/INTERRUPTED와 typed reason, 실행·effect가 불명확하면 UNKNOWN을 사용한다. cancellation/probe/recovery는
job, execution, assignment, attempt와 Turn을 한 transaction에서 terminalize한다. DB unique constraint는 한
`validation_job_id + job_generation`에 non-terminal assignment/execution 하나만 허용하고,
`VERDICT_RECORDED` escrow가 있으면 새 generation 생성을 금지한다. startup recovery는 generic active-execution
interruption보다 먼저 verdict escrow를 검사해 reviewer execution/Turn/resource terminal을 idempotently
수리한다.

approve verdict가 exact mutation에 소비되면 CONSUMED, reject verdict는 graph를 바꾸지 않는 canonical control
transaction에서 REJECTED가 된다. verdict 뒤 goal binding/graph/scope/policy가 바뀌어 더 이상 사용할 수 없으면
OBSOLETED, launch 전 proposal 철회는 DISCARDED다. 이 terminal transaction은 verdict escrow와 proposal
reservation을 소비·정리하며 reviewer execution/Turn/resource는 이미 verdict transaction에서 terminal이어야
한다. terminal job은
새 generation의 근거가 될 수 있지만 그 verdict를 자동 재사용하지 않는다.

## 7. 공통 graph mutation workflow

```text
변경 필요 발견
  → proposal 작성 및 durable append
  → base revision/CAS 확인
  → 구조·권한·budget/resource 검증
  → semantic impact 분류
  → 필요 시 review/reconciliation/decision node 생성
  → 새 graph revision 원자 commit
  → running attempt disposition 적용
  → downstream stale/invalidation 전파
  → ready-set 재계산과 독립 작업 dispatch
  → 관련 planner inbox에 semantic diff 전달
```

proposal 검증이나 commit이 실패하면 실행 graph는 바뀌지 않는다. provider 호출 뒤 결과 기록 실패처럼 외부
side effect 여부가 불명확하면 자동 재시도하지 않고 reconciliation이 필요하다.

## 8. 대표 사례: A 수행 중 A1+A2 분해 발견

초기 graph는 다음과 같다.

```text
revision 5

Predecessor → A → Downstream
```

A를 수행하던 worker가 현재 진행 부분은 A1이고 별도로 독립적인 A2가 필요하다고 발견한다.

### 8.1 제안

worker는 `split_task(A, [A1, A2])` proposal에 다음을 포함한다.

- A의 각 acceptance criterion이 A1, A2 또는 parent integration check 중 어디에서 충족되는지
- 현재 진행 중인 attempt를 checkpoint한 뒤 A1로 이어갈 수 있는지
- A1과 A2의 hard input, output과 resource claim
- 논리적 독립성뿐 아니라 파일, device, browser, account, port, quota 같은 운영 충돌 가능성
- Downstream dependency를 parent completion join에 유지하는 rewrite
- 새 비용과 concurrency 영향

### 8.2 semantic gate와 commit 결과

일반 자연어 A를 A1+A2로 나누는 행위는 의미 보존을 deterministic하게 증명할 수 없으므로 기본적으로
Level 2다. 구조 검증과 병행해 exact A/Goal snapshot을 받은 독립 plan reviewer 또는 현재 유효 authority의
reconciliation verdict를 구한다. 이 verdict도 execution ID, model/effort evidence, graph/goal revision과
authority epoch에 결박한다. typed criterion의 exact partition처럼 allowlisted 증명이 있을 때만 Level 1로
처리한다.

검토 중 기존 worker는 old A contract 안에서 안전하게 수행 가능한 현재 작업을 계속할 수 있다. 다만 A1로
재결박하거나 A2를 dispatch하는 것은 commit 전에는 금지한다. 검토가 오래 걸려 현재 작업의 의미가 불명확해지면
safe checkpoint에서 해당 attempt만 suspend하고 무관 ready work는 계속 실행한다.

승인된 graph-commit bundle의 결과는 다음과 같다.

```text
revision 6

                  ┌→ A1 ─┐
Predecessor → A ──┤      ├→ A completion join → Downstream
                  └→ A2 ─┘

A.status = decomposed
A.children = [A1, A2]
```

A1 완료만으로 A를 완료 처리하지 않는다. A의 join policy가 요구하는 모든 child와 parent-level integration
criterion이 승인돼야 Downstream이 ready가 된다.

### 8.3 기존 worker 계속 실행

과거의 A attempt를 소급해서 A1이었다고 바꾸지 않는다.

```text
Attempt A-1
  terminal_status = decomposition_checkpoint
  partial_result_ref = ...

Attempt A1-1
  continuation_of_attempt_id = A-1
  task_snapshot = A1 @ revision 6
```

provider가 안전하게 새 assignment를 수용할 수 있으면 같은 canonical execution/context에서 계속할 수 있다.
그렇지 않으면 checkpoint를 참조하는 새 execution을 만든다. 어느 경우든 tool call이나 외부 mutation이
진행 중인 상태에서 assignment를 바꾸지 않는다.

A2는 commit 직후 독립성과 resource 조건이 실제로 충족되면 별도 invocation으로 dispatch한다.

### 8.4 A를 처음 계획한 주체의 인지

원래 플래너 개인의 동기 승인은 Level 1 변경의 선행 조건이 아니다. Level 2 semantic review도 반드시
“처음 계획한 동일 모델 process”가 할 필요는 없으며 현재 authority 또는 독립 reviewer가 수행할 수 있다.
대신 다음을 보장한다.

1. `plan_changed` event와 semantic diff가 durable inbox에 기록된다.
2. 플래너가 다음 proposal이나 integration 결정을 하기 전에 최신 revision과 authority epoch를 읽는다.
3. revision 5를 기반으로 한 stale write는 CAS로 거부된다.
4. 상위 의미나 integration이 영향을 받으면 자동으로 reconciliation WorkItem이 생긴다.
5. planner가 교체되면 이전 authority epoch의 verdict와 completion은 거부된다.

원래 플래너가 종료돼도 correctness가 깨지지 않으며 새 planner가 같은 diff와 graph를 이어받는다.

## 9. 계획 주체별 추가 workflow

### 9.1 Root Planner의 초기 분해

초기 goal snapshot에 대해 task, acceptance coverage, hard dependency, resource claim과 통합·검수 node를
제안한다. Plan Coordinator와 독립 plan review가 구조와 의미를 검증한 뒤 revision 1을 commit한다. 계획이
없는 상태에서 worker를 먼저 dispatch하지 않는다.

### 9.2 Worker가 단순 추가 작업을 발견

현재 scope 안의 독립 support task라도 Level 1이면 read-only 또는 폐기 가능한 격리 artifact 경계를 지켜
병렬 dispatch한다. 그 결과를 hard input, production write나 acceptance evidence로 소비하려면 Level 2 승격이
필요하다. 새 작업이 기존 acceptance에 포함되지 않았거나 외부 scope를 넓히면 Level 2 또는 3으로 승격한다.

### 9.3 Worker가 기존 작업의 의미 변경을 발견

단순 `split`으로 위장하지 않는다. 기존 task를 checkpoint하고 `refine`, `supersede` 또는 `goal_change`
중 정확한 mutation을 제안한다. 이미 소비된 결과가 있으면 impact closure를 계산해 stale 처리한다.

### 9.4 Reviewer가 재작업을 요구

review verdict는 대상 artifact/task version과 exact evidence에 결박한다. 재작업은 기존 node로 cycle을
만들지 않고 새 version 또는 repair WorkItem을 만든다. reviewer 자신이 완료를 확정하지 않는다.

### 9.5 사용자 steer 또는 목표 변경

원문 입력을 먼저 canonical transcript에 보존하고 safe boundary에서 영향 분석한다. 현재 provider/tool
operation을 중간 변조하지 않는다. 영향을 받는 task와 결과만 invalidate하고 독립 branch를 보존한다.
Goal-owned Run의 의미 변경은 canonical ConversationGoal revision을, turn-owned Run의 objective/acceptance/policy
변경은 canonical TurnObjectiveRevision amendment를 먼저 만든다. 크기가 작은 acceptance 추가도 이 경계를
우회하지 않는다. 핵심 목표나 제품 범위가 달라지면 새 Run 경계를 사용자에게 명시한다.

### 9.6 Scheduler가 실행 실패를 발견

같은 task contract에서 idempotent하고 outcome-known인 재시도·모델 재배치는 새 attempt로 처리한다.
작업 자체의 의미 변경이 필요하면 scheduler가 직접 바꾸지 않고 planner proposal을 요청한다. unknown
mutation outcome은 자동 replay하지 않는다.

### 9.7 복수 planner의 동시 변경

각 proposal은 자신이 본 `base_revision`에 결박한다. 먼저 commit된 proposal만 head를 전진시키며 다른
proposal은 충돌 범위와 semantic diff를 받아 rebase한다. 서로 disjoint해 보여도 acceptance, budget,
resource와 downstream impact를 다시 계산한다.

## 10. Dependency, resource와 결과 무효화

### 10.1 Hard dependency와 가짜 종속성

dependency edge에는 소비되는 exact input/result ref와 이유가 있어야 한다. 단순 실행 순서, 같은 agent,
파일 충돌 또는 제한된 concurrency는 edge의 근거가 아니다.

### 10.2 Resource claim

semantic DAG와 별도로 다음 lease/ownership을 관리한다.

- workspace base snapshot과 write set
- file/path ownership
- browser/device/account/session
- port/process/service
- provider quota와 concurrency
- 외부 승인 또는 exclusive lock

resource 충돌은 작업을 일시적으로 not-ready로 만들 수 있지만 plan에 거짓 dependency를 추가하지 않는다.

### 10.3 결과 provenance와 invalidation closure

각 result는 exact task version, attempt, graph revision, base artifact와 실제 consumed input refs에 결박한다.
선행 계약이나 artifact가 바뀌면 선언 dependency뿐 아니라 실제 consumption provenance를 사용해 영향 closure를
계산한다.

- `stale`: 재사용 가능성이 있지만 현재 graph에서 아직 검증되지 않음
- `needs_revalidation`: 기존 결과를 새 조건으로 다시 검수해야 함
- `invalidated`: 새 조건과 양립하지 않아 사용할 수 없음
- `orphaned_candidate`: 더 이상 active graph가 소비하지 않지만 감사·참고용으로 보존

무관한 sibling 결과를 관성적으로 모두 폐기하지 않는다.

## 11. 사용자 질문과 외부 행동

질문은 `DecisionNode`, 로그인·MFA·브라우저 승인 같은 행동은 `ExternalActionNode`로 정규화한다. 각 node는
stable ID, monotonic `decision_generation`, immutable consumer set의 `work_item_id + version + contract_hash`,
immutable `decision_subject_digest`, `OPEN | ANSWERED | CONSUMED | CANCELLED | SUPERSEDED | EXPIRED` 상태,
응답 schema, expiry,
resume token과 완료 probe를 가진다. subject digest는 사용자에게 실제 표시한 mutation ID/operations hash,
goal·policy snapshot, budget·permission delta, canonical prompt/operation manifest, locale/render contract version과
각 option의 stable ID·label·effect mapping을 포함한다.
생성 당시 graph revision은 provenance일 뿐 answer CAS의 전역 head 조건이 아니다.

model/tool loop의 `ask_user`에서 생긴 Decision은 일반 승인 Decision과 구분되는 `origin_kind=tool_call_wait`를
가지며 다음 exact correlation을 canonical field와 subject digest에 포함한다.

```text
origin_execution_id / origin_execution_lease_epoch
origin_assignment_id / origin_assignment_epoch / origin_fence_token_hash
origin_turn_id
origin_call_id / origin_call_revision / origin_provider_call_id
origin_tool_name / response_schema_digest
```

답변 transaction은 이 origin tuple과 live execution/assignment/fence를 검증하고, 정확히 그 provider call을
재개할 portable `tool_result` item을 같은 canonical transaction에서 append하며 answer receipt와 wakeup outbox를
생성한다. `call_id + revision + provider_call_id` 중 하나라도 다르거나 origin fence가 retire됐다면 답변을 소비하지
않고 Decision을 SUPERSEDED/CANCELLED 처리해 replan 또는 새 call을 요구한다. graph 승인처럼 provider call에서
기원하지 않은 Decision은 typed origin을 사용하며 가짜 call ID를 만들지 않는다.

상태는 decision generation별로 append-only다.

```text
OPEN → ANSWERED → CONSUMED
OPEN | ANSWERED → SUPERSEDED
OPEN | ANSWERED → CANCELLED
OPEN → EXPIRED
```

`DecisionAnswerReceipt`는 `UNCONSUMED | RESERVED | CONSUMED | INVALIDATED` 상태와 generation을 가진다.
canonical DB graph mutation 자체가 승인 대상 effect라면 그 graph transaction이 권한 선형화 지점이므로 live
UNCONSUMED receipt를 CONSUMED로 바꾼다. 외부 effect라면 준비 graph bundle은 exact `effect_intent_id`와 outbox를
만들며 receipt를 RESERVED로만 바꾼다. 실제 CapabilityCallGrant 소비가 effect 권한 선형화 지점이고, 그 같은
Broker transaction에서 RESERVED receipt를 CONSUMED로 바꾼다. effect를 시작하지 않은 grant denial/expiry는
receipt를 소비하지 않는다.

사용자가 effect 권한 선형화 전에 특정 Decision을 취소하면 OPEN/ANSWERED generation을 CANCELLED로 만들고
UNCONSUMED/RESERVED receipt, effect intent/outbox와 unconsumed grant를 같은 transaction에서 INVALIDATED/revoke
한다. dependency closure만 다시 계산하며 무관 subgraph는 계속 실행한다. grant/receipt가 이미 CONSUMED라면
Decision을 소급 CANCELLED로 바꾸지 않고 시작된 operation의 cancel/probe/reconciliation 경로를 사용한다.

Baton은 답을 받기 전에 immutable `DecisionPresentationInstance`를 만든다.

```text
presentation_id / nonce / generation
decision_id / decision_generation
decision_subject_digest
consumer_contract_digest
session_id / tenant_id / canonical_principal_id
auth_session_or_channel_binding_digest / audience_membership_epoch / authz_policy_epoch
intended_user_actor / audience / surface_id / renderer_attestation_key_generation
canonical rendered payload
locale / trusted_renderer_id / renderer_version
option_id → label → effect_digest mapping
expires_at / superseded_at?
```

승인 입력은 Baton이 통제하는 CLI renderer 또는 Baton Desktop의 trusted presentation component가 이 instance
객체만으로 렌더링하고 선택 event를 반환하는 경로에서만 받는다. renderer가 다른 payload를 렌더링하거나
새 locale/version으로 다시 렌더링하면 기존 instance를 supersede하고 새 nonce를 만든다. 신뢰 경계 밖 web
client가 임의 digest를 echo하는 것만으로는 실제 표시를 증명할 수 없으므로, 그런 surface에서는 범위·권한·비용
승인을 비활성화하거나 별도 attested trusted renderer 계약을 요구한다.

presentation row는 exact DecisionNode의 foreign key이며 다른 decision/session/user/surface로 재사용할 수 없다.
answer transaction은 같은 row에서 nonce liveness, decision/generation, consumer/subject digest, actor/audience,
tenant/principal, authenticated session/channel binding, membership/authz epoch, surface/renderer attestation key와
selected option mapping을 함께 검증한다. 최종 effect commit도 같은 approval receipt와 policy가 허용한
audience snapshot의 current/accepted epoch를 CAS한다.

worker가 실행 중 질문 필요성을 발견하면 현재 작업을 다음처럼 재분해할 수 있다.

```text
현재 작업
├─ decision-dependent continuation ─ waits_for → DecisionNode
└─ independent support work ───────────────────→ 계속 실행
```

- 모든 남은 completion path가 unresolved decision에 막힐 때만 Run 전체를 `WAITING_USER`로 표시한다.
- 여러 질문은 core에 동시에 존재할 수 있다.
- CLI는 FIFO로 먼저 온 질문부터 보여 주되 scheduler는 계속 돈다.
- 후속 UI는 사용자가 원하는 decision ID를 골라 답할 수 있다.
- 같은 질문의 중복만 dedupe하고 서로 다른 질문을 합치지 않는다.
- immutable `DecisionAnswerReceipt`는 answer value/option ID, user actor, decision generation,
  decision/consumer/subject digest, presentation ID/nonce, renderer ID/version, selected option의 mapping digest와
  presentation의 canonical authenticated-binding digest(tenant/principal, auth session/channel binding,
  audience-membership/authz epoch, renderer-key generation)와 수신 시각을 보존한다.
- answer는 `decision_id + decision_generation + consumer_contract_digest + decision_subject_digest +
  live presentation nonce + OPEN`을 CAS하고 승인 mutation commit도 같은 receipt와 effect mapping digest를
  요구한다.
- selected option mapping은 exact normalized effect-manifest digest를 직접 포함하거나, 입력 schema와 versioned
  deterministic `EffectCompiler`를 포함한다. 실제 graph/effect manifest는 receipt의 selected mapping과 digest가
  정확히 같거나, bound option value/input에 compiler를 적용한 검증 가능한 유일 결과여야 한다. `dry-run/A`
  승인을 인용해 `apply/B` manifest를 만드는 것처럼 receipt와 별개로 grant manifest를 선택할 수 없다.
- 무관 branch가 새 graph revision을 commit해도 decision consumer 계약이 같으면 정당한 답을 거부하지 않는다.
- consumer task/version/contract가 바뀌면 기존 decision을 `SUPERSEDED`하고 새 generation 또는 새 decision을
  만든다. 자동 rebase로 예전 질문의 답을 새 의미에 적용하지 않는다.
- consumer 계약이 같아도 proposal operations, 비용, 권한, goal/policy snapshot 또는 선택지가 바뀌면 subject
  digest가 달라지므로 기존 승인을 재사용하지 않는다.
- auth session/channel binding, principal/tenant, membership/authz epoch 또는 renderer attestation key가 답변 뒤
  revoke·교체되면 receipt를 pending effect에 사용할 수 없다. 아직 CONSUMED되지 않은 UNCONSUMED/RESERVED
  receipt와 effect intent/outbox/unconsumed grant를
  INVALIDATED, 기존 ANSWERED generation을 SUPERSEDED로 만들고 같은 subject/consumer가 여전히 current일 때
  새 `decision_generation + 1`을 OPEN으로 만드는 전이를 한 transaction에서 수행한다. 새 generation에는 새
  PresentationInstance/nonce가 필요하며 다시 답을 받아야 한다. subject/consumer가 바뀌었다면 기존 decision을
  supersede하고 새 DecisionNode를 만든다. 최종 graph mutation/effect commit은 receipt의 authenticated-binding
  tuple 전체가 현재인지 원자 CAS한다. 이미 CONSUMED되어 effect 권한이 선형화된 receipt는 재승인 상태기로
  되돌리지 않고 cancellation/unknown-outcome 규칙을 따른다.
- external action 완료 확인은 bounded deterministic probe를 우선하며 model polling loop를 만들지 않는다.

## 12. 완료와 검수

작업, parent composite, Run의 완료 권한을 분리한다.

- Worker는 completion evidence를 제출한다.
- Machine gate는 결정적으로 확인 가능한 criterion을 검증한다.
- 독립 reviewer는 exact task version/result를 검수한다.
- Parent completion aggregator는 child join과 acceptance coverage를 확인한다.
- Goal supervision은 전역 누락이나 재계획 필요성을 제안한다.
- Baton control plane만 canonical 상태를 전이한다.
- 최종 독립 검수와 사용자 승인 정책이 요구되면 이를 통과해야 Run이 완료된다.

모델의 “완료” 문장, child 전체 완료 또는 graph상 terminal node 도달만으로 Run을 완료하지 않는다.

Goal-owned Pareto execution에는 ConversationGoal을 직접 terminalize하는 기존 `update_goal` tool을 제공하지
않는다. provider 호환 때문에 같은 tool name을 노출해야 한다면 adapter가 이를 non-terminal
`propose_completion`으로 변환할 뿐 `updateGoalStatus(complete)`를 호출할 권한은 없다. completion proposal은
acceptance coverage, parent join, goal supervision과 정책상 최종 독립 review의 exact receipt를 생성한다. Baton
control plane은 이 receipt, current WorkGraph head, no-open-decision/effect/reconciliation gate, Goal binding/status,
Run lifecycle 및 `GoalAutomationOwnershipLease`를 CAS해 Run COMPLETED와 ConversationGoal complete를 하나의
transaction으로 확정한다. 이 adapter/tool gate와 atomic completion bundle migration 전에는 Goal-owned Pareto
Run을 시작하지 않는다.

이 completion bundle은 Run의 `RunSettlementAttestation`과 exact Goal status epoch를 잇는 canonical
`GoalCompletionAttestation`도 만든다. late identity-valid evidence가 COMPLETED Run settlement를 challenge하면 같은
reopen transaction에서 GoalCompletionAttestation을 CHALLENGED로 만들고 append-only Goal status epoch를
`blocked/reconciliation_required(settlement_challenged)`로 전진시키며 Goal automation ownership을 recovery owner로
fence한다. Goal은 historical complete event를 지우지 않지만 current head는 더 이상 complete가 아니다. 같은
transaction이 GoalSuccessorBarrier와 recovery authority를 만들므로 표준 GoalRuntime이나 새 Run이 오염된 완료를
근거로 진행하지 못한다. reconciliation 뒤 원래 완료가 여전히 유효하면 새 supervision/final-review receipt와
attestation generation으로 Run과 Goal complete를 다시 원자 확정한다. 무효라면 새 Goal revision 또는 명시적 repair
Run을 만들고 barrier/resource closure를 상속한다.

## 13. 실패 모드와 대응

| 실패 모드 | 필수 대응 |
|---|---|
| 원래 플래너가 변경을 모름 | durable plan inbox, semantic diff, 다음 행동 전 revision refresh |
| 원래 플래너가 종료·교체됨 | agent memory가 아닌 WorkGraph를 SSOT로 사용 |
| 두 planner의 동시 commit | base revision CAS, stale proposal rebase와 재검증 |
| 이전 planning authority의 늦은 verdict | scope authority epoch/lease와 exact cursor CAS로 거부 |
| cross-scope 변경 중 일부 scope 인계 | affected scope fence 집합 전체를 같은 commit CAS로 검증 |
| proposer가 영향 scope를 누락 | Coordinator가 base graph에서 closure를 계산하고 exact-set equality 검사 |
| 작업 의미를 조용히 변경 | immutable version과 refine/supersede lineage |
| split이 parent criterion을 누락 | acceptance coverage map과 parent integration criterion |
| child 일부 완료로 parent가 조기 완료 | explicit join policy와 completion aggregator |
| Downstream 조기 dispatch | parent completion/join에 dependency 유지 |
| 거짓 dependency | exact consumed input ref 요구; resource 대기는 별도 관리 |
| 숨은 dependency | 동일 immutable base, sibling output 격리, 실제 consumption provenance |
| 논리적 독립이나 운영 충돌 | resource claim, exclusive lease, deterministic integration node |
| 실행 중 task contract 변경 | safe checkpoint 후 새 assignment epoch/attempt |
| graph commit 뒤 old attempt가 계속 결과 제출 | commit bundle에서 old epoch/fence revoke, 모든 result/tool continuation에 fence 검증 |
| tool side effect 중 재계획 | operation terminal 또는 reconciliation 전 재결박 금지 |
| 이전 결과의 잘못된 재사용 | impact closure와 stale/revalidation/invalidation 상태 |
| 무관한 결과까지 전부 폐기 | 실제 dependency와 provenance 기반 최소 영향 폐쇄 |
| 중복 task 생성 | mutation idempotency와 scope/criterion/result fingerprint 보조; 의미 판단 없이 자동 merge 금지 |
| task 과분해와 agent 폭증 | 최소 granularity, budget/concurrency/depth cap, expected parallelism benefit |
| 계획 thrashing | revision/rate cap, 반복 원인 감지, stabilization/reconciliation gate |
| reviewer의 범위 확대 | reviewer도 proposal만 제출하고 동일 권한·budget gate 적용 |
| scheduler의 의미론적 변경 | retry/reassignment와 semantic replan API 분리 |
| 질문 하나가 전체 Run 차단 | affected consumer closure만 suspend |
| 질문 답과 background 출력 혼동 | decision ID/generation 결박과 단일 CLI renderer |
| 독립 graph revision 때문에 유효 답변 거부 | global head가 아닌 decision generation과 consumer digest CAS |
| 승인 질문 뒤 mutation 범위·비용 변경 | immutable decision subject digest를 answer와 commit에 결박 |
| context 과다·누락 | task snapshot에 계약과 reference를 주고 필요한 범위는 agent가 선택 |
| provider/model fallback 오인 | requested/effective model·effort를 attempt provenance에 기록하고 정책 불일치 fail-closed |
| plugin 장애로 canonical 상태 유실 | Baton에 proposal/event/revision을 write-before-dispatch, plugin은 무상태 복구 가능 |
| child start acknowledgement 유실 뒤 중복 실행 | PREPARED/STARTING/RUNNING/UNKNOWN 상태기와 stable execution ID |
| 기존 executions와 plugin invocation 정본 충돌 | executions를 유일한 identity/status/lease authority로 사용 |
| 취소와 실제 launch 경쟁 | PREPARED→STARTING claim을 선형화하고 CANCELLING에서 probe/settle |
| CLOSED_NO_START 뒤 지연 worker launch | adapter claim tombstone이 이후 start_once를 영구 거부 |
| STARTED 기록과 실제 launch 사이 crash | provider idempotency 또는 crash-surviving LaunchSupervisor가 같은 identity를 resume |
| PREPARED 취소 뒤 queued Turn 잔존 | execution/Turn/assignment/outbox를 같은 취소 transaction에서 terminalize |
| 취소 뒤 unknown external effect 은폐 | RECONCILIATION_REQUIRED와 automation-stopped/risk-ack projection 및 barrier 보존 |
| uncommitted proposal reviewer bootstrap 순환 | canonical ProposalValidationJob과 control assignment 사용 |
| Level 1 diagnostic의 production 우회 | read-only/격리 artifact만 허용하고 소비·승격은 Level 2 gate |
| diagnostic 내용을 summary/context로 복사해 우회 | canonical information-flow label과 provenance closure, PromotionReceipt |
| diagnostic promotion reviewer가 taint를 세탁 | quarantined promotion review와 별도 declassification authority |
| plugin 부재 복구 가능성 추측 | per-Run capability/version snapshot과 branch별 recovery mode 판정 |
| recovery 판정 직후 plugin 소멸 | capability registry epoch와 bounded plugin lease를 claim/result CAS에 포함 |
| 사용자에게 표시된 선택지와 승인 effect 불일치 | canonical presentation/effect digest와 immutable answer receipt |
| untrusted client가 새 digest만 echo | trusted PresentationInstance nonce와 renderer 경계 밖 승인 비활성화 |
| validation verdict 저장 중 crash | ProposalValidationJob generation/state와 verdict/job/assignment 원자 terminal commit |
| validation이 verdict 없이 cancel/interrupted | explicit terminal reason과 job/execution/Turn 원자 전이 |
| reject/stale validation이 reservation을 점유 | REJECTED/OBSOLETED/DISCARDED control transaction으로 terminalize |
| STARTING child가 current startup recovery에서 idle로 풀림 | Turn/Execution/Thread mapping과 start_once/probe/cancel migration |
| claim 뒤 plugin revoke 후 effect 실행 | 호출별 CapabilityCallGrant 원자 소비와 revocation tombstone |
| graph bundle 뒤 resource/budget/recovery state 유실 | lease·ledger·receipt·requirements snapshot을 같은 bundle에 포함 |
| closure 계산 뒤 새 provenance append | impact-index epoch/cursor를 같은 serialized bundle에서 재계산·CAS |
| mutation 뒤 늦은 consumption append | source validity/graph head/assignment fence와 impact epoch CAS로 거부 |
| terminal settlement attestation challenge 뒤 후속 작업 계속 | attestation generation을 challenge하고 consumer impact closure를 원자 fence |
| challenge 뒤 지연 admission이 VALID generation 사용 | 모든 authority dependency 생성·소비가 exact attestation 상태/epoch CAS |
| PromotionReceipt를 새 consumer/version에 재사용 | exact consumer/goal/authority/policy tuple과 one-shot receipt 소비 |
| consumer-scoped promotion이 source 전역 label 세탁 | immutable source label과 매 소비 시 promoted-view edge 요구 |
| presentation nonce를 다른 decision/user에 재사용 | exact decision/session/audience/surface FK와 actor 검증 |
| 로그인/tenant/role 변경 뒤 presentation 재사용 | principal/channel/authz epoch와 renderer key generation CAS |
| 답변 뒤 auth session revoke 후 effect 실행 | receipt와 grant 발급·소비가 전체 authenticated-binding tuple 재검증 |
| 승인 option과 실제 effect manifest 불일치 | exact mapping equality 또는 versioned deterministic derivation proof 검증 |
| 이전 assignment의 call grant 재사용 | Run/execution/assignment/fence 전체 tuple과 one-shot CAS |
| 중복 child가 call grant 선점 | launch claim/supervisor generation/registered identity CAS |
| grant 발급 뒤 path/account/request 변경 | normalized effect manifest와 resource/policy/credential lease CAS |
| verdict 저장 뒤 reviewer execution active로 남음 | verdict transaction에서 execution/Turn/resource까지 terminalize |
| revision commit 뒤 scheduler 통지 유실 | durable outbox와 replayable readiness projection |
| event commit 일부 성공 | 원자 transaction 또는 fail-stopped reconciliation; 메모리 상태 선행 금지 |
| 목표 변경을 task 변경으로 은폐 | canonical Goal binding/new Run 경계와 사용자 가시성 |
| ConversationGoal pause/edit 뒤 stale Run 실행 | Goal ID/revision/status epoch를 모든 mutation/dispatch/result/grant CAS에 포함 |
| turn-owned Run의 acceptance steer가 objective 정본 밖 변경 | canonical TurnObjectiveRevision amendment와 graph bundle 결박 |
| steer 수신 뒤 amendment 전 old effect 시작 | enqueueFollowUp 수신 transaction에서 steer epoch admission fence를 즉시 전진 |
| amended binding을 old execution에 재사용 | assignment에 exact binding을 두고 binding 변경 시 새 execution 강제 |
| auth revoke 뒤 ANSWERED decision 재승인 불가 | old receipt/generation invalidate·supersede와 새 OPEN generation 원자 생성 |
| external effect 전에 receipt가 조기 CONSUMED | 준비 시 RESERVED, grant 소비 시 단일 선형화로 CONSUMED |
| Goal clear/replace 뒤 old Run 고착 | goal deletion/replacement와 Run cancel/fence/cancel-probe를 같은 bundle로 처리 |
| plugin 부재로 cancel/probe grant 발급 불가 | effect 축소 전용 baton_recovery issuer grant 사용 |
| Decision enum에 CONSUMED 누락 | generation enum과 상태 전이표를 동일하게 유지 |
| cancelled/stale follow-up이 steer fence 고착 | follow-up별 token을 같은 terminal transaction에서 해제·terminalize |
| CLOSED_NO_START를 dispatch 상태로 표현 불가 | STARTING→CANCELLED no-start terminal 전이를 명시 |
| Goal 삭제 뒤 recovery CAS가 active tuple 요구 | RecoveryAuthoritySnapshot tombstone 기반 전용 CAS 사용 |
| delivery_unknown steer를 해제하거나 영구 고착 | delivery reconciliation에서 증명 전 effect fence 유지 |
| delivery_unknown을 후속 steer가 추월 | same thread/turn follow-up head-of-line fence로 claim 차단 |
| Goal clear stale reason이 recovery status와 충돌 | lifecycle은 CANCEL_REQUESTED, stale는 typed reason으로 분리 |
| Goal clear가 terminal Run을 CANCEL_REQUESTED로 회귀 | non-terminal 자동화 Run만 취소하고 terminal history 보존 |
| clear/replace 뒤 새 Goal·Run이 old unknown effect와 충돌 | thread/resource closure 기반 GoalSuccessorBarrier를 모든 createGoal/continuation에 상속 |
| FAILED/COMPLETED outcome이 open unresolved effect를 숨기거나 영구 reconciliation에 갇힘 | pending terminal outcome을 진입 시 고정하고 검증된 gate closure 뒤 exact outcome으로 수렴 |
| resolver assertion이 unknown call을 임의 해결 | exact call/revision/idempotency/resolver/evidence에 결박된 trusted-verifier receipt 없이는 gate close 금지 |
| barrier 재차단 뒤 기존 successor 결과·receipt·started effect가 생존 | impact fixpoint로 파생물까지 무효화하고 이미 시작된 effect는 새 unresolved gate로 전환 |
| 최초 steer 또는 후속 claim이 미완성 migration을 통과 | Phase 1 migration 전 모든 Pareto steer admission 또는 해당 기능 Run start를 fail-closed |
| 특정 Decision 취소를 표현하지 못함 | CANCELLED 전이와 미소비 receipt/outbox/grant 원자 무효화 |
| GoalRuntime과 Pareto가 같은 Goal을 이중 실행 | GoalAutomationOwnershipLease를 Run 생성 때 원자 claim/transfer하고 모든 dispatch가 exact epoch CAS |
| 기존 update_goal이 Pareto 최종 검수를 우회 | Pareto 실행에서는 completion proposal만 허용하고 control plane의 receipt 검증 bundle만 Goal을 완료 |
| ask_user 답이 stale/wrong provider call을 재개 | exact execution/assignment/fence/turn/call revision/provider-call correlation과 portable result append |
| graph 정본/CAS 전에 Level 1 mutation을 허용 | 최소 WorkGraphRevision, base CAS와 graph-commit bundle을 Phase 1 선행조건으로 배포 |
| non-terminal reconciliation이 ACTIVE로 복귀 불가 | 진입 시 resume status를 기록하고 gate closure 뒤 current fence CAS로 ACTIVE 복귀 |
| live Goal 행 갱신/삭제가 과거 Run binding을 파괴 | append-only ConversationGoalRevision/StatusEpoch를 FK 정본으로 두고 live row는 head projection으로 제한 |
| immutable WorkItemVersion의 status를 갱신 | CAS-versioned WorkItemState로 lifecycle을 분리 |
| unresolved cancellation을 terminal로 오인 | lifecycle은 reconciliation에 유지하고 자동화 중단/위험 인수는 별도 projection으로 기록 |
| COMPLETED/FAILED 뒤 late mutating evidence가 도착 | 모든 terminal settlement attestation을 challenge하고 lifecycle reopen+dependent impact fence를 원자 적용 |
| inspect_only가 cancel/tombstone을 수행 | 비변경 inspection과 명시적 cancellation authority가 필요한 cancel_recovery 모드를 분리 |
| diagnostic을 본 live model memory가 production으로 유출 | execution observed-information taint를 단조 증가시키고 quarantine exposure 뒤 새 production execution 강제 |
| archive/purge가 대기 Run 또는 reconciliation 증거 삭제 | non-settled/gate/barrier/challenge 검사와 restore ownership CAS, purge 전 외부 immutable tombstone |
| Baton과 Pareto JSONL이 서로 다른 inflight 정본을 replay | plugin mode는 Baton API만 durable authority로 사용하고 JSONL은 권한 없는 cache/import source로 제한 |
| active 표준 Goal turn 중 Pareto ownership 인수 | 표준 execution 전체를 ownership epoch에 결박하고 fence/cancel/reconcile 뒤 원자 transfer |
| DELIVERY_UNKNOWN steer를 provider 보증 없이 재전송 | crash-durable exact-ID dedupe와 receipt/probe capability가 있는 adapter만 resend resolution 허용 |
| Goal clear 뒤 새 Goal이 old unknown resource와 충돌 | clear도 thread-scoped GoalSuccessorBarrier를 만들고 모든 createGoal/continuation이 generation CAS |
| effect identity가 있는 session purge 뒤 late evidence 유실 | identity-indexed canonical recovery shell을 영구 보존하고 해당 session 물리 purge 금지 |
| stream digest만 남아 plugin crash 뒤 payload 재생 불가 | canonical items 또는 Baton-owned immutable blob content를 durable commit한 뒤에만 event ack |
| COMPLETED Run reopen 뒤 ConversationGoal은 complete로 고착 | GoalCompletionAttestation을 함께 challenge하고 Goal status/recovery ownership/barrier를 원자 전진 |

## 14. UI/UX projection

하나의 복잡한 그림에 모든 edge를 겹치지 않는다.

### 14.1 Run Overview

현재 GoalBindingSnapshot, active WorkGraph revision, ready/running/waiting/stale/failed 상태, critical path와 pending
decision을 보여 준다. WorkItem 카드에 담당 invocation/attempt badge를 표시한다.

### 14.2 Agents

실제 spawn lineage를 안정적인 tree로 보여 준다. subagent는 일반 session 목록을 오염시키지 않고 root Run
아래 접을 수 있다. 사용자가 필요할 때만 선택한 invocation context를 새 Baton Thread로 명시적으로 승격한다.

### 14.3 Work Graph

현재 revision의 dependency DAG를 보여 준다. decomposition/merge/supersede lineage는 선택 node 상세나
별도 overlay로 표시한다. agent tree 위에 dependency edge를 무차별적으로 덧그리지 않는다.

### 14.4 Plan History와 Timeline

revision diff, 변경 actor, reason, 영향받은 결과와 승인 gate를 보여 준다. 사용자는 “처음 계획과 현재 계획이
왜 달라졌는가”를 재구성할 수 있어야 한다.

## 15. Plugin 경계

Pareto plugin은 versioned capability manifest와 provider-neutral port를 사용한다.

```text
read_goal_snapshot
read_work_graph(revision)
propose_graph_mutation(base_revision, proposal)
request_child_execution(spec)
begin_model_step(execution_assignment_fence, request_digest)
append_model_stream_event(step_id, event_id, canonical_items_or_baton_blob_ref, payload_digest)
record_tool_call_inflight(call_id, revision, idempotency_key, grant_ref)
commit_tool_result(call_identity, result_or_unknown_evidence)
checkpoint_attempt(attempt_id, evidence)
submit_task_result(attempt_id, result)
submit_reconciliation_evidence(gate_id, call_identity, evidence)
propose_decision(decision_spec)
propose_completion(subject, evidence)
subscribe_run_events(cursor)
```

`request_child_execution`의 spec에는 Baton이 미리 예약한 stable `execution_id`, parent execution ID,
dispatch idempotency key, Run lifecycle epoch, execution lease epoch, assignment fence와 policy snapshot hash가
필수다. plugin이 임의 process를 먼저 시작한 뒤 ID를 사후 등록할 수 없다.

- plugin은 canonical DB transaction을 직접 열지 않는다.
- child execution은 Baton Child Execution Gate를 통과한다.
- provider/model/effort/tool/budget은 각 invocation에서 명시하고 effective evidence를 검증한다.
- plugin metadata는 versioned namespace에 격리하고 portable canonical projection을 항상 남긴다.
- plugin API의 retry는 idempotency key와 outcome-known 조건을 요구한다.
- plugin 제거 후에도 Baton UI가 tree, graph, result와 decision history를 읽을 수 있어야 한다.

Baton plugin mode에서는 model step, tool call/result, inflight set, checkpoint와 reconciliation의 durable authority를
Baton이 소유한다. stream event API는 digest만 받지 않고 schema-validated canonical payload/items 또는 이미
내구화된 Baton-owned immutable blob reference와 그 digest를 받는다. plugin-owned path/URL은 정본 reference가
아니다. Baton은 blob/content와 event/item projection을 원자 commit하거나 blob durable commit을 먼저 증명한 뒤
event를 결박하며, content가 replay/materialize 가능한 시점 이후에만 acknowledgement한다. 위 API는 동일한
execution/assignment/fence/call revision/idempotency identity로 dispatch 전에 inflight를 write하고,
stream/result/unknown evidence를 append하며, Baton commit acknowledgement 뒤에만 plugin
in-memory projection을 전진시킨다. Pareto standalone의 JSONL journal/checkpoint/replay는 이 mode에서
dispatch/retry/reconciliation 권한을 갖지 않는다. 필요하면 Baton event의 비정본 read cache/audit mirror로만
쓸 수 있고 cache 유실·중복이 실행 판단을 바꾸지 않는다. standalone JSONL을 가져올 때는 inflight manifest와
digest를 idempotent fenced import로 기록하고 outcome이 완전히 증명되지 않은 call마다 ReconciliationGate를 만든
뒤에만 Run을 연다. 양쪽 journal을 비교해 “아마 미실행”으로 추측 replay하지 않는다.

다음 정보는 plugin metadata가 아니라 Baton의 versioned canonical schema에 반드시 들어간다.

- WorkItem version, hard dependency, parent completion/join policy
- assignment epoch, fence와 running attempt disposition
- execution state, lease, dispatch idempotency와 unknown-outcome 상태
- planning scope authority epoch와 reconciliation gate
- Decision/ExternalAction generation, consumer digest와 resolution
- resource claim, readiness 조건, invalidation closure와 cancellation policy
- 위 policy를 해석하는 schema/policy version

plugin namespace에는 UI hint, 설명용 rationale, provider-neutral correctness에 필요하지 않은 heuristic만 둘 수
있다. Baton이 required schema/policy interpreter version을 지원하지 못하면 graph를 추측해 재개하지 않고
`reconciliation_required/unsupported_policy_version`으로 fail-closed한다. “plugin 없이 읽을 수 있음”과
“plugin 없이 자동으로 계속 실행할 수 있음”을 구분하며, 후자는 canonical policy가 완전히 해석될 때만 허용한다.

각 Run은 canonical `OrchestrationRequirementsSnapshot`을 가진다.

```text
OrchestrationRequirementsSnapshot
- required_capability_ids[]
- capability_registry_epoch
- graph_schema_version / policy_interpreter_versions[]
- plugin_id / plugin_contract_version / plugin_digest
- plugin_lease_id / plugin_lease_epoch / plugin_lease_expiry
- recovery_owner: baton | plugin:<id> | user
- recovery_mode: inspect_only | cancel_recovery | drain_ready | full_auto | reconciliation_required
- pending_control_jobs_digest
- snapshot_hash
```

Baton은 startup/recovery transaction에서 설치된 capability/interpreter와 snapshot을 비교해 recovery mode를
결정한다.

- `inspect_only`: 열람·export, 비변경 probe와 evidence append만 허용한다. cancel이나 durable
  `close_without_start` tombstone을 만들지 않는다.
- `cancel_recovery`: 이미 canonical `CANCEL_REQUESTED|CANCELLING` intent가 있거나 exact cancellation policy/user
  Decision receipt가 있을 때만 cancel, close_without_start와 그 결과 terminalization을 허용한다.
- `drain_ready`: 이미 committed되고 Baton이 termination/join까지 완전히 해석할 수 있으며 새 planning,
  proposal validation 또는 plugin callback이 필요 없는 exact ready execution만 끝낸다.
- `full_auto`: planning/review/recovery owner를 포함한 required capability가 모두 현재 digest와 일치할 때만
  허용한다.
- `reconciliation_required`: pending Level 2 review, planner inbox, unknown outcome, unsupported version 또는
  owner 부재가 있는 영향 폐쇄를 멈춘다.

독립 ready branch별 required capability closure를 계산할 수 있을 때만 일부 branch를 `drain_ready`로 계속할
수 있다. Run 전체의 단일 boolean으로 안전성을 추측하지 않는다.

recovery mode 판정만으로 dispatch 권한이 생기지 않는다. `PREPARED → STARTING` claim과
result/control-transition commit은 snapshot의 capability registry epoch와 bounded plugin lease를 CAS하고,
필요한 capability lease가 claim의 예상 실행 시간 동안 유효한지 확인한다. registry epoch 변경이나 lease
만료 시 새 claim은 실패한다.

- `inspect_only`: PREPARED를 시작하지 않고 STARTING/RUNNING에 비변경 probe/evidence 수집만 한다.
- `cancel_recovery`: PREPARED/STARTING/RUNNING에 Baton-owned adapter의 cancel/probe/close_without_start를 허용하되
  exact cancellation intent/receipt와 recovery authority epoch를 각 grant 발급·소비에서 CAS한다.
- `drain_ready`: plugin callback 없이 Baton이 해석·terminalize할 수 있는 execution만 claim한다. 이미
  STARTING/RUNNING이면 raw terminal evidence는 보존하되 plugin-dependent semantic commit은 하지 않는다.
- `full_auto`: 정확한 plugin lease가 살아 있는 동안만 planning/control job과 result transition을 허용한다.
- `reconciliation_required`: 자동 claim은 0이며 evidence append와 권한 있는 reconciliation만 허용한다.

plugin이 사라진 in-flight execution을 Baton fallback owner가 이어받으려면 snapshot에 호환 가능한 capability
ID와 takeover policy가 미리 존재하고 새 capability/authority epoch를 commit해야 한다. 임의의 “비슷한”
plugin이나 모델로 자동 대체하지 않는다.

claim 시점 lease만으로 실제 plugin/adapter 호출을 허용하지 않는다. Baton Capability Broker가 각 외부-effect
call마다 다음 one-shot 또는 bounded grant를 발급하고 호출 경계에서 원자 소비한다.

```text
CapabilityCallGrant
- issuer_kind: plugin_execution | baton_recovery
- issuer_id / issuer_authority_epoch
- grant_id / run_id / run_lifecycle_epoch / steer_epoch
- goal_binding_hash / conversation_goal_id+revision+status_epoch?
- execution_id / execution_lease_epoch
- assignment_id / assignment_epoch / fence_token_hash / call_id
- launch_claim_epoch / supervisor_generation / registered_launch_identity_digest
- allowed_operation / subject_digest / normalized_request_and_effect_manifest_digest
- target/account/path / workspace_or_artifact_snapshot_digest
- policy_permission_digest / policy_epoch
- resource_lease_ids_and_epochs[] / budget_lease_id_and_epoch / credential_lease_id_and_epoch?
- goal_successor_barrier_dependencies[]: barrier_id+generation+resource_closure_digest+state
- required_decision_answer_receipt_digest?
- required_authenticated_binding_digest?
- approval_effect_mapping_digest / effect_derivation_proof?
- registry_epoch / capability_digest / plugin_digest? / plugin_lease_epoch?
- issued_at / expires_at
- single_use / heartbeat_policy
- signature / revocation_generation
```

plugin/adapter는 Broker를 통하지 않은 worker의 직접 callback을 받지 않고, effect 시작 전에 grant signature,
registry epoch, expiry와 revocation tombstone을 검증·소비한다. `issuer_kind=plugin_execution`인 production grant의
Broker 소비 transaction은 위 Run lifecycle,
execution lease, exact assignment/fence, registered launch identity, policy와 resource/budget/credential lease
tuple, exact GoalSuccessorBarrier dependencies, required DecisionAnswerReceipt와 그
tenant/principal/auth-session/channel/audience/authz/renderer-key
binding, Goal binding/status와 selected option-effect mapping이 모두 현재인지 CAS한다. grant의 normalized
effect manifest는 receipt mapping과 exact-equal하거나 기록된 deterministic derivation proof로 검증돼야 한다.
grant 발급과 소비 양쪽에서 auth/Goal/steer revocation과 no-pending-steer를 검사한다. external effect용
receipt는 grant 소비 transaction에서 exact RESERVED effect intent와 함께 CONSUMED로 전이한다. receiver도
supervisor가 선택한 identity의 attested channel에서만 grant를
받고 grant에 hash된 immutable normalized request/effect manifest만 실행한다. mutation tool은 각 호출마다 새
one-shot grant를 요구한다.
장기 실행은 side effect 없는 heartbeat로 lease를 갱신하며 만료·revoke 후에는 새 tool/effect call을 시작하지
않고 cancel/probe한다. 이미 원자 소비된 grant의 effect는 “시작된 실행”로 간주해 cancellation 또는 unknown
outcome reconciliation으로 수렴한다. DB claim과 실제 call 사이의 무효화는 grant 소비가 최종 권한
선형화 지점이 되어 닫힌다.

plugin이 없는 `inspect_only/reconciliation_required/cancel_recovery`에서 Baton-owned adapter가 수행하는
recovery operation은 `issuer_kind=baton_recovery`인 별도 grant를 사용한다. `inspect_only`와
`reconciliation_required` grant는 비변경 probe/evidence append로 제한하고, `cancel`과
`close_without_start`는 `cancel_recovery` grant에서만 허용한다. 이 grant는
plugin lease와 current production Goal/lease/fence tuple 대신 Baton recovery authority epoch,
`RecoveryAuthoritySnapshot` tombstone digest, exact old goal/execution/assignment/revoke generation, adapter
contract/version, launch identity와 unresolved execution ref를 CAS한다. current Run은
`cancel_recovery`라면 `CANCEL_REQUESTED|CANCELLING` 또는 cancellation intent/receipt에 결박된
`RECONCILIATION_REQUIRED`여야 한다. 허용 operation은 명시된 취소·상태 축소·관측에만 한정한다. 새 child,
production mutation,
provider request 또는 일반 tool effect를 시작할 수 없다. adapter 자체가 plugin 없이는 접근 불가능하거나
recovery-only contract를 지원하지 않으면 Broker를 우회하지 않고 reconciliation에 남는다.

recovery probe/cancel result와 Execution/Turn/Run terminal transition도 같은 recovery authority epoch와
tombstone을 사용하는 전용 SessionStore CAS로 commit하며 plugin lease나 active Goal 존재를 요구하지 않는다.
recovery grant가 revoked production fence를 다시 활성화하거나 ordinary result/completion을 승인할 수는 없다.

## 16. Recovery와 취소

- mutation proposal은 검증 전에 durable append한다.
- graph revision/head, assignment fence, attempt disposition, invalidation, PREPARED execution과 dispatch outbox를
  canonical graph-commit bundle로 원자화한다.
- dispatch intent, stable execution ID, idempotency key와 lease는 child 실행 전에 기록한다.
- child cancellation은 parent/goal cancellation policy와 lease를 따른다.
- parent 취소 시 child propagation 여부와 independent promoted work 보존 여부를 정책 snapshot에 기록한다.
- crash recovery는 unfinished mutation을 `proposed`, `committed`, `rejected` 중 하나로 결정적으로 복원한다.
- `STARTING` 또는 `RUNNING` execution을 단순 ready task로 되돌리지 않는다. 실행 부재가 증명되지 않으면
  `INTERRUPTED` 또는 `UNKNOWN`에서 reconciliation한다.
- 실행됐을 수 있는 mutation tool의 outcome이 불명확하면 자동 재실행하지 않는다.
- restart 뒤 scheduler는 committed graph와 durable attempt 상태에서 ready-set을 재구성한다.
- scheduler outbox는 Run lifecycle epoch, execution lease epoch, assignment fence, capability registry epoch와
  required plugin lease가 모두 현재일 때만 STARTING claim한다.

session archive/restore/purge도 lifecycle 밖 관리 작업이 아니다. 초기 계약은 다음처럼 fail-closed한다.

- non-settled Run, non-terminal execution, open Decision/ReconciliationGate/UnresolvedEffectGate/GoalSuccessorBarrier,
  CHALLENGED settlement attestation 또는 pending outbox가 하나라도 있으면 archive를 거부한다. “현재 active turn이
  없음”은 archive 가능성의 증명이 아니다. 향후 suspended archive를 지원하려면 archive transaction 자체가 Run
  lifecycle/Goal ownership/execution/effect fence를 전진시키고 모든 recovery state를 보존하는 별도 설계를 요구한다.
- restore는 archived projection만 활성화하지 않는다. canonical Run/Goal binding, settlement attestation,
  capability/plugin version과 GoalAutomationOwnershipLease를 검사하고 recovery ownership CAS를 통과한 뒤에만
  scheduler admission을 연다. 표준 GoalRuntime이 Pareto-owned Goal을 자동 claim하지 못한다.
- purge는 위 unresolved/challenged/non-settled 상태 또는 retention 중인 reconciliation evidence가 있으면 거부한다.
  더 강하게, 한 번이라도 STARTING launch identity, provider/process identity 또는 consumed external-effect grant가
  생긴 session은 terminal이어도 canonical `PurgedRunRecoveryShell`을 영구 보존하고 물리 purge하지 않는다.
  transcript/artifact payload는 별도 retention 정책으로 compact할 수 있지만 아래 identity/authority는 남긴다.

  ```text
  PurgedRunRecoveryShell
  - session/thread/run/goal binding IDs
  - settlement attestation ID/generation/status
  - execution/launch/provider/process/call/idempotency identity indexes
  - effect/resource closure and cross-Run consumer dependency digests
  - recovery authority epoch / evidence ingress cursor / retention policy version
  ```

  late identity-valid evidence ingress는 이 canonical shell의 identity index를 찾아 lifecycle reopen, impact fence와
  ReconciliationGate를 append한다. effect/launch identity가 전혀 발급되지 않은 settled session만 물리 purge할 수
  있으며, 그 경우에도 삭제 전에 final digest를 DB 밖 append-only audit tombstone에 내구화한다. tombstone write가
  증명되지 않으면 row를 삭제하지 않는다.
- 기존 Baton archive가 Goal lease를 삭제하거나 purge가 Goal/execution/event/transcript를 물리 삭제하는 경로는
  이 검사와 tombstone migration 전에는 Pareto Run이 있는 session에 feature gate로 금지한다.

## 17. 단계적 도입

### Phase 0: 계약과 read-only projection

- 이 문서의 ID, revision, lineage, assignment와 event schema 동결
- 기존 Pareto 실행을 Baton에서 read-only Run/Agent/Task projection으로 표시
- native provider child execution은 계속 차단

### Phase 1: Baton-managed Pareto orchestration

- `executions` status/lease와 child thread/turn/spawn/input을 포함한 canonical migration 먼저 적용
- execution의 monotonic information taint/consumer fence와 quarantine→production 새 execution 강제를 적용한다.
- archive/restore/purge에 non-settled Run/gate/barrier/attestation 검사를 추가하고 purge 전 외부 immutable
  recovery tombstone을 의무화한다. migration 전에는 Pareto session archive/purge를 fail-closed한다.
- Baton plugin persistence mode의 model/tool/inflight/checkpoint/reconciliation API를 구현하고 Pareto standalone
  JSONL replay authority를 비활성화한다. 이 경계 전에는 effect-capable Pareto Run을 시작하지 않는다.
- model stream API가 canonical content 또는 Baton-owned immutable blob을 내구화하고 replay projection commit 뒤에만
  ack하도록 구현한다.
- append-only ConversationGoalRevision/StatusEpoch unique FK 정본과 live Goal head projection, WorkItemVersion과
  CAS-versioned WorkItemState 분리를 먼저 적용한다.
- 최소 `WorkGraphRevision`, append-only mutation event, `base_revision`/lifecycle/scope CAS와 §4.5 graph-commit
  bundle을 먼저 적용한다. Phase 1의 Level 1 변경도 이 경계를 우회하지 않는다.
- Goal-owned Run 생성 시 GoalAutomationOwnershipLease claim/transfer, 표준 GoalRuntime exclusion, 모든 Pareto
  dispatch와 표준 turn 전체 수명의 ownership epoch CAS를 원자화한다. active owner transfer는 fence/cancel/probe와
  effect reconciliation 뒤에만 commit한다. migration 전에는 Goal-owned Pareto Run을 fail-closed한다.
- clear/replace가 thread-scoped GoalSuccessorBarrier를 만들고 이후 createGoal, 표준 continuation과 Pareto Run이
  exact barrier generation/resource closure를 소비하도록 migration한다.
- Goal-owned Pareto execution의 terminal `update_goal`을 completion proposal로 격리하고 supervision/final-review
  receipt 기반 Run+Goal atomic completion과 GoalCompletionAttestation challenge/recovery transition을 구현한다.
  adapter gate 전에는 해당 Run을 시작하지 않는다.
- tool-call Decision의 exact execution/assignment/fence/turn/call revision/provider-call correlation, portable
  `tool_result` append와 wakeup outbox를 구현한다.
- follow-up claim query와 테스트를 migration해 earlier `delivery_unknown`/unresolved steer가 같은 thread/turn의
  later follow-up claim을 막고 동일 reconciliation ID만 예외로 허용
- 위 HOL migration과 SteerFenceToken transaction이 배포되기 전에는 Pareto Run의 모든 follow-up/steer
  admission을 feature gate로 fail-closed하거나 follow-up/steer를 노출하는 Pareto Run 시작 자체를 금지한다.
  첫 단일 steer도 허용하지 않으며 “동시 입력이 아닐 때만 허용”하는 우회 경로를 두지 않는다.
- Baton Thread에서 Pareto Run 시작
- AgentInvocation Tree, task attempt와 child execution gate 연결
- Pareto의 bounded ready-set·비차단 decision·checkpoint 계약을 구현 상태와 구분해 재사용
- 로컬 Level 1 mutation과 parent notification 구현

### Phase 2: Durable evolving WorkGraph

- general semantic mutation과 cross-scope graph transaction 확장
- Level 2 reconciliation, result invalidation closure, resource lease
- split/merge/refine/supersede와 복수 planner conflict 처리
- graph/history UI

### Phase 3: 고급 운영

- multi-run fairness와 quota-aware scheduling
- 조건부 branch, bounded iteration policy와 distributed worker
- 선택적 speculative execution은 폐기 가능성·비용·보안 정책이 입증된 경우에만 허용

## 18. 필수 conformance 시나리오

1. A 수행 중 A1+A2 분해가 commit되고 현재 execution이 checkpoint 뒤 A1을 계속하며 A2가 병렬 실행된다.
2. 원래 플래너가 비활성 상태여도 변경이 유실되지 않고 다음 활성화 때 exact semantic diff를 받는다.
3. stale planner가 이전 revision으로 쓰면 거부되고 최신 graph로 rebase한다.
4. split 후 한 child만 완료돼도 parent와 Downstream이 완료되지 않는다.
5. parent acceptance criterion 누락 split이 거부되거나 semantic reconciliation으로 승격된다.
6. 독립 task의 write/resource 충돌은 semantic edge를 만들지 않고 scheduler가 직렬화한다.
7. hidden sibling output 소비가 차단되고 선언되지 않은 dependency가 검출된다.
8. task supersede가 실제 소비 successor만 stale/invalidate하고 무관 sibling을 보존한다.
9. tool mutation 중 graph rebind가 거부되고 unknown outcome은 reconciliation에서 멈춘다.
10. 동시 disjoint proposal도 CAS 후 impact를 재계산하며 blind merge하지 않는다.
11. worker 질문이 decision-dependent continuation과 독립 support task로 분해된다.
12. 한 branch가 질문을 기다리는 동안 다른 branch가 완료된다.
13. CLI FIFO 질문과 background progress가 exact answer binding을 깨지 않는다.
14. reviewer 재작업이 새 attempt/version을 만들고 DAG cycle을 만들지 않는다.
15. 목표 범위 확대가 Level 3 사용자 결정 없이 dispatch되지 않는다.
16. task/agent 폭증과 반복 replan이 cap에서 멈추고 현재 결과를 보존한다.
17. crash 뒤 committed revision, pending proposal, attempt와 ready-set이 중복 없이 복원된다.
18. Pareto plugin을 비활성화해도 Baton에서 Run의 tree, graph, 질문, 결과를 읽을 수 있다.
19. 요청 model/effort와 effective route가 다르면 정책에 따라 fail-closed하고 증거를 남긴다.
20. cancellation과 graph commit 경쟁에서 revision/status precedence가 결정적으로 유지된다.
21. graph head commit 직후 crash해도 old assignment fence가 같은 transaction에서 폐기되어 결과를 승인하지 못한다.
22. child가 실제 시작되고 acknowledgement 저장 전에 crash하면 두 번째 child를 dispatch하지 않고
    STARTING/UNKNOWN reconciliation으로 복구한다.
23. cancellation 뒤 남은 dispatch outbox가 lifecycle epoch 검사에서 거부된다.
24. scope 인계 뒤 이전 planner의 늦은 review/reconciliation/completion verdict가 authority epoch에서 거부된다.
25. 일반 자연어 split은 worker의 coverage 주장만으로 Level 1 commit되지 않는다.
26. decision 생성 뒤 무관 branch가 graph revision을 전진시켜도 같은 consumer digest의 답은 정상 적용된다.
27. required canonical policy interpreter가 없으면 plugin 제거 후 자동 resume하지 않고 fail-closed한다.
28. outbox worker의 유효성 확인과 adapter start 사이에 cancellation을 삽입해도 STARTING claim 순서에 따라
    child가 미시작 또는 이미 시작된 child로 결정적으로 분류된다.
29. migration 전에는 PREPARED child dispatch가 feature gate에서 거부되고, migration 후 child
    thread/turn/spawn/input/execution/assignment/outbox가 한 transaction에서 생성된다.
30. cross-scope mutation 도중 한 scope authority가 인계되면 affected scope fence 집합 CAS가 실패한다.
31. uncommitted split의 독립 semantic reviewer가 ProposalValidationJob과 canonical assignment로 실행된다.
32. cancellation 중 unknown external mutation이 있으면 settled CANCELLED로 표시되지 않고 unresolved gate를
    보존한다.
33. Level 1 diagnostic이 production write, hard input 또는 acceptance evidence를 만들거나 소비되려 하면
    Level 2 없이 거부된다.
34. 같은 consumer contract라도 승인 대상 operations/budget/permission이 바뀌면 decision subject digest가
    달라져 이전 답을 재사용하지 않는다.
35. plugin 제거 시 Run/branch capability closure와 cancellation intent에 따라 inspect_only, cancel_recovery,
    drain_ready 또는 reconciliation_required가 결정적으로 선택된다.
36. STARTING/UNKNOWN execution recovery가 Turn을 idle로 풀지 않고 thread를 reconciliation-blocked로 유지한다.
37. graph bundle 직후 crash해도 resource lease, budget reservation, validation/decision receipt와 requirements
    snapshot이 graph head와 같은 revision이다.
38. proposer가 한 affected scope를 누락하면 Coordinator-computed exact closure 비교에서 거부된다.
39. validation result와 job terminal 사이 crash가 나도 같은 generation의 두 번째 reviewer가 실행되지 않는다.
40. cancellation 뒤 revoked fence의 late provider result가 ordinary result로 승인되지 않고 reconciliation evidence로
    수렴한다.
41. diagnostic summary를 production context에 넣으려 하면 provenance label로 거부되고 PromotionReceipt 후에만
    허용된다.
42. option ID와 effect mapping 또는 displayed payload가 바뀌면 이전 DecisionAnswerReceipt로 commit하지 못한다.
43. recovery mode 판정 뒤 plugin lease를 만료시키면 PREPARED claim과 plugin-dependent result transition이 모두
    CAS에서 거부된다.
44. STARTING 뒤 no-start probe가 claim을 CLOSED_NO_START로 닫으면 지연 worker의 start_once가 영구 거부된다.
45. PREPARED child 취소가 execution, queued Turn, assignment/attempt, outbox를 함께 terminalize하고 unresolved가
    없을 때만 thread를 idle로 만든다.
46. validation reviewer가 verdict 없이 cancel/fail/interrupted될 때 job과 execution/Turn이 같은 typed terminal
    reason으로 수렴한다.
47. 실제 consumption/context provenance로만 연결된 다른 scope도 impact-index fixpoint와 authority CAS에 포함된다.
48. clean CANCELLED 직전 모든 launch claim의 terminal attestation/high-watermark가 필요하고 모순 evidence는 새
    reconciliation generation을 연다.
49. promotion reviewer의 모든 출력이 tainted 상태로 유지되고 별도 declassification authority만 receipt를 만든다.
50. stale/cached renderer instance 또는 untrusted client digest echo로 승인 commit이 불가능하다.
51. plugin lease가 claim 뒤 revoke돼도 effect call의 CapabilityCallGrant 소비가 거부되며, 이미 소비됐다면
    cancellation/reconciliation 대상으로 분류된다.
52. LaunchSupervisor/provider가 LAUNCHING 전후 crash해도 같은 identity를 resume하고 중복 child는 effect grant
    전에 종료된다.
53. reject verdict와 stale approve verdict가 각각 REJECTED/OBSOLETED로 terminalize되며 budget/resource를
    해제한다.
54. closure 계산 뒤 provenance append가 경쟁하면 impact-index epoch CAS가 실패하거나 같은 transaction의
    재계산에 포함된다.
55. challenged cancellation attestation이 thread와 그 attestation을 소비한 후속 assignment/join/resource를
    함께 fence한다.
56. PromotionReceipt 발급 뒤 consumer version/authority/policy를 바꾸면 one-shot CAS가 거부된다.
57. 같은 subject를 가진 다른 decision/user/session에서 presentation nonce를 재사용할 수 없다.
58. 이전 assignment의 미사용 call grant가 남아 있어도 exact assignment ID/fence/lifecycle CAS에서 거부된다.
59. graph mutation 뒤 지연 provenance append가 source validity/head/fence/impact epoch CAS에서 거부된다.
60. challenged attestation generation을 읽은 지연 assignment/outbox/receipt/grant admission이 모두 거부된다.
61. consumer C용 promotion이 source label을 전역 변경하지 않고 consumer D는 별도 promoted-view edge 없이는
    읽지 못한다.
62. presentation 생성 뒤 tenant/principal/auth session 또는 authz membership epoch가 바뀌면 answer/commit이
    거부된다.
63. LaunchSupervisor의 탈락 process가 exact registered launch identity가 달라 grant를 소비하지 못한다.
64. request path/account/arguments 또는 resource/credential lease가 바뀌면 grant의 effect manifest/lease CAS가
    실패한다.
65. verdict recording 직후 crash해도 reviewer execution/Turn/resource는 terminal이며 startup repair가 escrow를
    generic interruption 전에 처리한다.
66. 답변 뒤 auth session/channel binding만 revoke·교체해도 기존 receipt의 graph/effect commit과 call grant
    발급·소비가 모두 거부되고 새 presentation/answer를 요구한다.
67. dry-run/account-A option receipt로 apply/account-B effect grant를 만들면 mapping equality/derivation 검증에서
    거부된다.
68. ConversationGoal pause 또는 revision edit가 Run lifecycle/fence와 함께 commit된 뒤 stale mutation,
    PREPARED dispatch와 call grant가 모두 Goal binding CAS에서 거부된다.
69. turn-owned Run에서 network 금지나 새 acceptance steer를 enqueue하면 follow-up record와 immediate steer fence가
    먼저 commit되고, safe-boundary consume에서 transcript item·TurnObjectiveRevision·graph replan이 commit된다.
70. ANSWERED 뒤 auth binding revoke 시 old receipt/generation이 INVALIDATED/SUPERSEDED되고 새 OPEN generation과
    PresentationInstance에서만 재승인할 수 있다.
71. network 금지 steer를 enqueue하는 transaction이 steer epoch를 올린 뒤 old binding의 새 network grant가
    no-pending-steer CAS에서 거부된다.
72. amendment H2를 old execution E/H1에 배정할 수 없고 새 execution만 H2 assignment를 받는다.
73. external effect 준비 뒤 auth revoke가 grant 소비 전에 발생하면 RESERVED receipt/intent가 무효화되고 새
    OPEN generation에서 재승인할 수 있다.
74. Goal clear/replace 중 STARTING child가 있으면 old Run lifecycle/fence가 함께 전진하고 cancel/probe로
    수렴하며 replacement Goal에 자동 재결박되지 않는다.
75. plugin lease가 없는 inspect_only는 비변경 probe/evidence만 수행하고 cancel/close_without_start grant는
    거부한다. exact cancellation intent/receipt가 있는 cancel_recovery만 baton_recovery grant로
    probe/cancel/close_without_start를 수행하며 production effect는 시작하지 못한다.
76. receipt 소비 후 Decision generation이 schema-valid CONSUMED terminal로 전이되고 재예약되지 않는다.
77. pending follow-up이 cancel/stale/supersede/expire되면 그 token이 terminalize되고 다른 token/lifecycle 조건에
    따라 admission이 결정적으로 재개되거나 Run cancellation을 따른다.
78. STARTING child의 CLOSED_NO_START 증명이 RUNNING을 거치지 않고 Execution/Turn을 CANCELLED로 만든다.
79. Goal clear와 plugin 제거 뒤에도 baton_recovery grant/result가 recovery tombstone과 cancellation lifecycle을
    CAS해 probe/cancel을 terminalize하며 old production fence를 되살리지 않는다.
80. delivery_unknown follow-up은 effect admission을 유지한 채 reconciliation하며 미전달/전달 증명 또는
    crash-durable provider dedupe와 exact receipt/probe가 있는 adapter의 동일-ID 재전송으로만 수렴한다.
81. Goal clear/replace의 Run lifecycle은 CANCEL_REQUESTED라 baton_recovery gate에 진입하고 stale reason은
    별도 audit field로 남는다.
82. ANSWERED+RESERVED Decision 취소가 receipt/intent/outbox/unconsumed grant를 함께 무효화하며 무관 branch를
    중단하지 않는다.
83. DELIVERY_UNKNOWN F1 뒤 F2가 enqueue돼도 F1 reconciliation 전에는 F2를 claim/deliver/consume하지 않는다.
84. 완료된 old Run이 있는 Goal clear/replace는 그 terminal lifecycle을 바꾸지 않고 non-terminal Run만
    CANCEL_REQUESTED로 전이한다.
85. clear/replace 뒤 생성된 Goal과 successor Run은 old unresolved effect/resource barrier가 해제된 closure만
    dispatch하며 무관
    closure는 계속 실행할 수 있다.
86. FAILED outcome이어도 open UnresolvedEffectGate가 있으면 recovery grant가 가능한 RECONCILIATION_REQUIRED
    lifecycle로 유지된다.
87. barrier G에서 발급한 grant가 G+1 reblock 뒤 소비되면 barrier dependency CAS에서 거부된다.
88. HOL/SteerFenceToken migration 전에는 첫 단일 Pareto follow-up/steer도 feature gate에서 거부되거나 해당
    기능을 노출하는 Run 시작이 거부되고, migration 후 F2가 delivery_unknown F1을 추월하지 않는다.
89. FAILED outcome과 unknown started effect를 같은 transaction에서 발견하면 pending terminal outcome FAILED인
    RECONCILIATION_REQUIRED가 되고, exact gate가 검증·폐쇄된 뒤 새 작업을 재실행하지 않고 FAILED로 수렴한다.
90. COMPLETED 후보도 unknown effect가 있으면 pending terminal outcome COMPLETED로 reconciliation에 머물며,
    모든 gate가 닫힌 transaction에서만 COMPLETED가 된다.
91. exact call revision, idempotency key, resolver/version, evidence cursor/digest 또는 주입된 trusted-verifier
    receipt 중 하나라도 누락·불일치하면 gate close, terminal settlement, retry와 barrier release가 거부된다.
92. GoalSuccessorBarrier G를 소비한 successor의 result/context/completion/promotion/decision receipt가 생긴 뒤
    G+1 reblock evidence가 도착하면 파생물이 impact-index fixpoint로 stale/invalidate되고, 이미 시작된 successor
    effect마다 새 UnresolvedEffectGate가 생겨 reconciliation 전 clean completion이 차단된다.
93. 같은 Goal/revision에 표준 GoalRuntime과 Pareto Run이 동시에 claim하면 한 ownership lease CAS만 성공하고,
    loser는 turn/execution/outbox를 만들지 못한다.
94. Goal-owned Pareto worker가 기존 `update_goal(complete)`를 호출해도 completion proposal만 생기며, 미완료
    WorkItem 또는 누락된 supervision/final-review receipt가 있으면 Run과 ConversationGoal 모두 complete가 아니다.
95. ask_user answer의 call revision 또는 provider call ID가 origin과 다르거나 assignment fence가 retire됐으면
    portable tool_result/wakeup이 생성되지 않고 stale Decision이 supersede된다.
96. Phase 1에서 두 Level 1 proposal이 같은 base revision을 경쟁하면 하나만 graph-commit bundle로 성공하고 loser는
    rebase 전 execution/outbox를 dispatch하지 못한다.
97. DELIVERY_UNKNOWN steer가 미전달로 검증돼 모든 gate가 닫히면 current lifecycle/Goal/ownership/steer fence를
    CAS해 ACTIVE로 복귀하며, fence가 바뀌었으면 stale ACTIVE로 복귀하지 않는다.
98. Goal revision 7에 결박된 Run 뒤 Goal edit/clear가 일어나도 append-only revision/status-epoch FK는 남고 live
    head만 revision 8 또는 cleared epoch를 가리킨다.
99. WorkItem lifecycle이 ready→running→completed로 바뀌어도 immutable WorkItemVersion row와 semantic version은
    변하지 않고 WorkItemState epoch만 CAS 전진한다.
100. unresolved cancellation 위험을 사용자가 인수해 자동화를 중단해도 Run은 reconciliation에서 successor
     barrier를 유지하며 clean terminal query에 포함되지 않는다.
101. COMPLETED 또는 FAILED settlement 후 late identity-valid mutating evidence가 오면 attestation challenge,
     lifecycle reopen, dependent result/join/resource fence와 started successor effect gate가 한 transaction에 생긴다.
102. inspect_only에서 cancel/close_without_start grant를 요청하면 거부되고, 같은 요청도 exact cancellation
     intent/receipt와 cancel_recovery authority epoch가 있을 때만 허용된다.
103. diagnostic source를 본 execution에 production assignment를 배정하면 context에서 source를 제외했어도
     information-taint/consumer fence에서 거부되고 새 execution만 promoted view를 받을 수 있다.
104. active turn이 없지만 open Decision 또는 ReconciliationGate가 있는 session의 archive/purge는 거부되며,
     settled purge도 외부 recovery tombstone write 실패 시 어떤 canonical row도 삭제하지 않는다.
105. Baton inflight commit 뒤 Pareto JSONL write 전 crash하거나 그 반대 순서가 발생해도 restart authority는
     Baton call identity/gate뿐이며 plugin cache가 자동 replay하지 않는다.
106. standard Goal turn이 tool 실행 중일 때 Pareto ownership transfer를 요청하면 old epoch가 먼저 fence되고
     started effect reconciliation 전에는 Pareto execution/outbox가 생기지 않는다.
107. provider-side dedupe capability가 없는 adapter의 DELIVERY_UNKNOWN steer를 같은 client ID로 재전송해도 token과
     effect fence가 해제되지 않는다. capability가 있으면 exact receipt/probe가 한 번 적용을 증명한 뒤에만 해제된다.
108. Goal clear 뒤 새 Goal을 만들면 GoalSuccessorBarrier dependency가 자동 부착되고 old unresolved closure와 같은
     resource effect는 barrier CAS에서 거부된다.
109. external launch/effect identity가 한 번이라도 생긴 settled session의 purge는 거부되며, late evidence는 영구
     canonical recovery shell index를 통해 원래 Run을 reopen한다.
110. stream event digest commit 직후 plugin이 죽어도 Baton-owned canonical items/blob에서 exact assistant/tool
     payload를 replay할 수 있고, content durable commit 전에는 plugin이 acknowledgement를 받지 못한다.
111. Goal-owned COMPLETED Run의 late evidence가 settlement를 challenge하면 Run/thread뿐 아니라
     GoalCompletionAttestation, current Goal status epoch, recovery ownership과 GoalSuccessorBarrier가 한 transaction에서
     전진하며 표준 GoalRuntime은 repair/reconfirmation 전 실행하지 못한다.

## 19. 비목표와 보류 사항

- 모든 subagent를 일반 Baton session으로 자동 승격하지 않는다.
- agent tree와 Work DAG를 하나의 canonical 구조로 합치지 않는다.
- Pareto plugin에 Baton DB, provider credential 또는 gateway lifecycle 소유권을 주지 않는다.
- 현재 구현되지 않은 general DAG 기능을 이미 제공한다고 표시하지 않는다.
- natural-language semantic equivalence를 hash나 deterministic validator만으로 증명한다고 주장하지 않는다.
- 분산 consensus, remote speculative execution과 임의 cyclic workflow는 초기 구현 범위가 아니다.

구현 전에 event/schema migration, maximum graph/revision/agent limits, Goal rebind와 새 Run의 사용자 선택 UX,
semantic plan review route 및 workspace integration policy를 별도 ADR 또는 이 문서의 후속 revision에서 확정한다.

## 20. 최종 불변식

1. Baton만 canonical session, Run, graph revision과 child execution을 소유한다.
   기존 `executions`가 identity, parent, status와 lease의 유일한 정본이다.
2. Pareto와 모든 모델 에이전트는 상태 변경을 제안할 뿐 직접 확정하지 않는다.
3. Agent Invocation Tree, decomposition lineage와 Work dependency DAG는 분리한다.
4. 각 active graph revision은 DAG이며 변경은 append-only mutation history로 설명 가능하다.
5. 실행 attempt는 시작 당시 task/graph/context/policy snapshot과 execution/assignment fence에 결박한다.
6. 변경은 영향받는 최소 subgraph만 block·invalidate하고 독립 ready work를 계속 실행한다.
7. original planner의 기억이나 생존이 correctness 조건이 아니다. 관련 planner는 다음 행동 전에 durable diff,
   최신 revision과 current authority epoch를 반드시 관측한다.
8. 완료는 worker 문장이 아니라 acceptance coverage, exact evidence, review와 control-plane transition으로 결정한다.
9. goal·권한·예산·파괴성 경계를 넘는 변경은 사용자 승인 없이 실행하지 않는다.
10. 모든 재시도·복구·동시성 처리는 idempotency, CAS와 unknown-outcome fail-closed 원칙을 따른다.
11. graph revision/head, execution·assignment fence, attempt disposition, invalidation, resource/budget reservation,
    control receipt, recovery requirements와 dispatch outbox는 하나의 canonical commit bundle로 원자화한다.
12. decision 답변은 global graph head가 아니라 decision generation, exact consumer contract, subject,
    displayed payload와 option-effect mapping에 결박한다.
13. STARTING claim은 launch 선형화 지점이며 Turn/Execution/Thread recovery와 adapter의 durable
    claim 상태, provider idempotency 또는 crash-surviving LaunchSupervisor가 이를 보존한다.
14. diagnostic 정보와 파생 context는 quarantined review 및 별도 declassification authority가 만든 Level 2
    PromotionReceipt 없이 production execution으로 흐르지 않는다.
15. plugin/capability availability 판정과 실제 dispatch/result transition은 같은 registry epoch와 bounded lease를
    CAS하고, 각 외부-effect 호출은 exact Run/execution/assignment/fence에 결박된 revocation-aware
    CapabilityCallGrant를 원자 소비한다.
16. impact scope closure는 graph revision뿐 아니라 실제 provenance의 monotonic epoch/cursor와 같은 transaction에
    결박하고 모든 consumption append도 source validity와 current graph/fence를 CAS한다.
17. declassification receipt와 decision presentation은 exact consumer·authority·user·surface에 결박하고 다른
    revision이나 audience에 재사용하지 않는다. 승인 receipt부터 최종 effect grant 소비까지 authenticated
    principal/session/channel/authz/renderer binding을 다시 검증한다.
18. cancellation attestation과 같은 authority dependency는 모든 후속 admission·receipt·grant에서 exact
    generation/status/epoch를 CAS한다.
19. source information label은 immutable하며 declassification은 consumer-scoped promoted-view edge로만
    표현한다.
20. Goal-owned Run의 모든 자동화 권한은 Baton ConversationGoal의 exact ID/revision/status epoch에 결박되며
    pause/edit/cancel이 Run lifecycle과 fence를 함께 전진시킨다.
21. 사용자 승인 option과 실제 graph/effect manifest는 exact-equal하거나 versioned deterministic derivation
    proof로 연결돼야 한다.
22. turn-owned Run의 의미 있는 steer는 canonical TurnObjectiveRevision amendment를 먼저 만들며 graph가 objective
    binding 밖에서 acceptance/policy를 수정하지 않는다.
23. auth-binding 폐기로 미소비 승인이 무효화되면 기존 generation을 다시 열지 않고 새 OPEN generation에서만
    재승인한다.
24. steer 수신 transaction은 의미 분류 전에 새 effect admission을 fence하며, objective binding 변경은 기존
    execution을 재사용하지 않는다.
25. 외부 effect 승인은 준비 시 RESERVED일 뿐이며 actual CapabilityCallGrant 소비와 같은 선형화 지점에서만
    CONSUMED가 된다.
26. Goal clear/replace도 old Goal-owned Run의 lifecycle/fence/cancel-probe를 함께 전진시키며 새 Goal에 자동
    재결박하지 않는다.
27. plugin 부재 recovery의 probe/cancel은 생산 effect 권한이 없는 Baton recovery-only grant로만 수행한다.
28. follow-up별 steer fence token은 consume뿐 아니라 cancel/stale/supersede/expiry terminal에서도 원자적으로
    해소된다.
29. Goal 삭제와 production fence revoke 뒤 recovery는 active tuple이 아니라 immutable recovery authority
    tombstone과 cancellation lifecycle을 CAS한다.
30. delivery-unknown steer는 증명 없이 해제하지 않으며 별도 reconciliation에서 수렴한다.
31. 사용자 Decision 취소는 effect 권한 소비 전 receipt/outbox/grant를 최소 영향 범위에서 원자 무효화한다.
32. DELIVERY_UNKNOWN follow-up은 같은 thread/turn의 후속 steer delivery에도 head-of-line fence다.
33. Goal clear/replace는 terminal Run history를 되돌리지 않으며 successor는 old unresolved resource/effect barrier를
    소비해야 한다.
34. Run outcome이 terminal처럼 보여도 open unresolved effect가 있으면 lifecycle은 reconciliation 상태이고
    successor/recovery barrier에서 제외되지 않는다.
35. GoalSuccessorBarrier generation은 successor effect grant의 authority dependency이며 재차단은 기존
    successor 권한과 파생 result/receipt를 revoke하고 이미 시작된 effect를 unresolved gate로 전환한다.
36. reconciliation 진입 시 예정 terminal outcome과 이유를 durable하게 고정하며 모든 gate가 검증돼 닫힌 뒤
    exact pending outcome으로 COMPLETED, FAILED 또는 CANCELLED 계열에 수렴할 수 있다.
37. unknown call의 reconciliation은 exact call revision, idempotency key, resolver/version, evidence와 주입된
    trusted-verifier receipt에 결박하며 owner/resolver assertion만으로 해제하지 않는다.
38. HOL/SteerFenceToken migration 전에는 concurrent 여부와 무관하게 모든 Pareto steer를 금지하거나 그 기능을
    노출하는 Run을 시작하지 않는다.
39. barrier 재차단은 아직 시작되지 않은 권한뿐 아니라 이미 만들어진 파생 결과·receipt와 이미 시작된 effect까지
    결정적으로 stale/reconciliation 상태로 전파한다.
40. Goal-owned Pareto Run과 표준 GoalRuntime은 같은 Goal revision의 단일 automation ownership lease를 공유하며
    그 lease를 원자적으로 소유한 한쪽만 dispatch할 수 있다.
41. Pareto worker의 completion은 제안일 뿐이며 supervision/final-review receipt와 current graph/Goal/Run/ownership
    tuple을 검증한 Baton control-plane bundle만 Run과 ConversationGoal을 완료한다.
42. tool-call Decision은 exact execution/assignment/fence/turn/call revision/provider call에 결박하고 답변과 그
    portable tool result를 원자적으로 같은 origin에 전달한다.
43. graph-changing Level 1을 포함한 모든 Phase 1 mutation은 최소 revision/base CAS/graph-commit bundle 뒤에서만
    실행된다.
44. reconciliation은 진입 시 terminal 후보뿐 아니라 ACTIVE 복귀 의도도 기록하며, gate closure 뒤 current authority
    fence를 검증한 경우에만 해당 lifecycle로 수렴한다.
45. Goal-owned Run의 binding은 append-only ConversationGoal revision/status-epoch 정본을 참조하며 live Goal head의
    갱신이나 clear가 과거 binding을 삭제하지 않는다.
46. WorkItem의 semantic version과 mutable lifecycle state/epoch는 분리한다.
47. unresolved effect가 남은 취소는 terminal lifecycle이 아니며 위험 인수나 자동화 중단도 gate/barrier를
    제거하지 않는다.
48. COMPLETED, FAILED, CANCELLED의 settlement attestation은 late identity-valid evidence로 challenge/reopen될 수
    있고 모든 dependent consumer와 시작된 effect에 impact fence를 전파한다.
49. inspect_only는 비변경 관측·evidence만 허용하며 cancel/close_without_start는 명시적 cancel_recovery 권한,
    cancellation intent/receipt와 recovery epoch를 모두 CAS해야 한다.
50. execution의 observed information/provenance taint는 단조 증가하며 quarantine 또는 다른 consumer 정보를 본
    live execution을 production에 재사용하지 않는다.
51. archive/restore/purge는 Run/gate/barrier/settlement/ownership lifecycle을 검사하고 unresolved evidence를
    삭제하지 않으며 purge 전 외부 immutable recovery tombstone을 요구한다.
52. Baton plugin mode에서 model/tool/inflight/checkpoint/reconciliation의 유일한 durable authority는 Baton API이고
    Pareto standalone JSONL은 dispatch/replay 권한을 갖지 않는다.
53. 표준 GoalRuntime execution도 전체 수명 동안 Goal automation ownership epoch를 소비하며 active owner 간
    transfer는 old authority fence와 effect settlement/reconciliation 전에는 완료되지 않는다.
54. DELIVERY_UNKNOWN resend는 provider-side crash-durable exact-ID dedupe와 identity-valid receipt/probe가 증명된
    adapter에서만 resolution이다.
55. Goal clear와 replace 모두 thread-scoped GoalSuccessorBarrier를 만들며 이후 모든 Goal/Run/continuation effect가
    exact generation/resource closure를 CAS한다.
56. 외부 launch/effect identity가 존재했던 session은 identity-indexed canonical recovery shell을 영구 보존하고
    물리 purge하지 않아 late evidence reopen 권위를 잃지 않는다.
57. model stream event는 digest만이 아니라 replay 가능한 canonical content 또는 Baton-owned immutable blob을
    durable commit한 뒤에만 acknowledgement한다.
58. Goal-owned Run completion과 ConversationGoal completion은 GoalCompletionAttestation으로 결박되며 late evidence
    reopen은 Run, Goal status, recovery ownership과 successor barrier를 원자적으로 함께 challenge한다.
