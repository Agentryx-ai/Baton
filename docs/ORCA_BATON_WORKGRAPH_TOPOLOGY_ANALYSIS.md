# Orca와 Baton의 WorkGraph 및 worktree 토폴로지 비교

조사일: 2026-07-21 (Asia/Seoul)  
Orca 조사 대상: [stablyai/orca](https://github.com/stablyai/orca) commit [d9d939a](https://github.com/stablyai/orca/tree/d9d939a33b5858495ffb33489a952f1ac9293610)  
Baton 조사 대상: [Work-Centric Orchestration Design V4](WORK_CENTRIC_ORCHESTRATION_DESIGN_V4.md), [Pareto Orchestration Plugin과 동적 작업 그래프 설계](PARETO_ORCHESTRATION_PLUGIN_AND_EVOLVING_WORK_GRAPH.md), [구현 정합성 현황](IMPLEMENTATION_STATUS.md)

이 문서는 Orca 공개 저장소를 로컬에 clone한 뒤 worktree 생성, 계보, Task 저장소, Dispatch, 완료 처리와 coordinator 소스를 직접 추적한 결과다.

## 전제

| 전제 | 이 문서의 처리 방식 |
|---|---|
| Baton WorkGraph가 Git worktree를 지원한다고 가정한다. | worktree를 WorkItem의 정체성이 아니라 ExecutionAssignment와 Attempt가 사용하는 격리 실행 환경으로 배치한다. |
| Orca와 Baton의 성숙도가 다르다. | 설계 우수성과 현재 구현 완성도를 분리해서 판정한다. |
| Git 분기와 작업 의존성은 서로 다른 사실이다. | 어느 commit에서 checkout했는지와 어떤 작업 결과가 다음 작업의 입력인지를 별도 관계로 평가한다. |
| Baton 문서는 목표 설계다. | 미구현 기능을 현재 제품 기능이나 현재 우위로 표현하지 않는다. |
| Orca 소스는 조사 commit의 현재 상태다. | 미래에 추가될 가능성이 아니라 현재 schema와 실행 경로만 판정한다. |

## 최종 결론

| 질문 | 판정 | 이유 |
|---|---|---|
| 순수한 작업 그래프 토폴로지는 어느 쪽이 더 좋은가? | Baton 설계 우세 | 작업 의존성, 분해 이력, 실행 계보, 재시도, 검수, 자원 충돌, 결과 provenance를 서로 다른 구조로 분리한다. |
| 작업의 의미를 정확히 보존하는 의미론은 어느 쪽이 더 좋은가? | Baton 설계 우세 | WorkItem version, graph revision, accepted artifact, acceptance receipt와 영향 범위 무효화를 명시한다. |
| 실제 Git worktree 운용 토폴로지는 어느 쪽이 더 좋은가? | Orca 현재 구현 우세 | 생성, 부모 계보, cycle 방지, instance identity, stale base 검사, terminal과 UI가 실제 동작한다. |
| 지금 당장 여러 agent를 worktree에서 병렬 운용하기 좋은 쪽은 어디인가? | Orca 현재 제품 우세 | 실제 runtime, CLI, terminal, diff, browser, remote와 coordinator가 연결돼 있다. |
| 장기적으로 더 안전한 자동 오케스트레이션 기반은 어느 쪽인가? | Baton 설계 우세 | worker 종료와 작업 수락을 분리하고 graph mutation을 versioned proposal과 canonical commit으로 처리한다. |
| 더 단순하고 이해하기 쉬운 모델은 어느 쪽인가? | Orca 우세 | Task, deps, Dispatch, terminal, worktree라는 적은 개념으로 빠르게 동작한다. |
| 종합적으로 어느 설계를 선택해야 하는가? | Baton 의미론 위에 Orca식 worktree 실행 계층을 결합 | Baton의 작업 정본을 유지하면서 Orca의 검증된 worktree lifecycle과 사용자 경험을 채택하는 구성이 가장 좋다. |

한 문장으로 정리하면 Orca는 실제 작업 공간을 운영하는 토폴로지가 강하고, Baton은 작업의 의미와 결과의 정당성을 보존하는 토폴로지가 강하다.

## 두 제품이 그래프라고 부르는 대상

| 구조 | Orca | Baton |
|---|---|---|
| 사용자 목표 | coordinator spec과 Task spec에 주로 들어간다. | Goal 또는 Turn Objective와 immutable ObjectiveBindingSnapshot으로 분리한다. |
| 작업 단위 | mutable Task row다. | stable WorkItem과 immutable WorkItemVersion을 분리한다. |
| 작업 의존성 | Task의 deps JSON 배열이다. | typed edge를 가진 immutable WorkGraphRevision이다. |
| 작업 분해 | Task parent_id로 부모를 표시할 수 있다. | decomposition lineage를 dependency와 별도로 둔다. |
| 실행 주체 | terminal handle과 pane key에 Dispatch를 연결한다. | provider-neutral ExecutionAssignment와 canonical Execution을 분리한다. |
| 재시도 | 같은 Task에 새 DispatchContext를 만들고 failure_count를 이어받는다. | 새 Attempt와 필요 시 새 Execution을 만들고 retry relation을 별도로 둔다. |
| 작업 공간 | 실제 Git worktree와 terminal이 있다. | 현재 미구현이다. 이 문서에서는 Assignment가 WorkspaceInstance를 임대한다고 가정한다. |
| 결과 | Task.result JSON과 completed 상태다. | ResultCandidate, verifier receipt, AcceptanceReceipt, AcceptedArtifact를 분리한다. |
| 그래프 변경 | Task row를 추가하고 상태를 갱신한다. graph revision은 없다. | proposal journal, revision CAS, impact closure와 commit bundle을 사용한다. |
| 완료 | 유효한 worker_done이 Task를 completed로 만든다. | 실행 종료, 후보 제출, WorkItem 수락, Goal 완료를 서로 다른 상태로 둔다. |

## Orca의 실제 토폴로지

### Orca worktree 계보

| 요소 | 소스에서 확인한 의미 | 평가 |
|---|---|---|
| worktreeId | repo ID와 실제 경로를 결합한 workspace 식별자다. | UI와 filesystem 위치를 연결하기에 실용적이다. |
| instanceId | 같은 경로가 삭제 후 재생성됐을 때 이전 worktree와 구분하는 identity다. | 경로 기반 ID의 약점을 보완하는 좋은 설계다. |
| parentWorktreeId | worktree가 어느 workspace 문맥에서 만들어졌는지 나타내는 단일 부모다. | 생성 provenance를 트리로 보기 좋다. |
| parentWorktreeInstanceId | 부모 경로가 재사용됐는지 검증한다. | stale lineage가 새 checkout에 붙는 것을 막는다. |
| capture source | 명시적 CLI flag, 환경, 현재 directory, terminal, orchestration context 등을 구분한다. | 계보가 명시인지 추론인지 설명할 수 있다. |
| confidence | explicit과 inferred를 구분한다. | 불확실한 계보를 사실처럼 표시하지 않는다. |
| origin | orchestration, CLI, manual을 구분한다. | 누가 계보를 만들었는지 추적할 수 있다. |
| taskId와 orchestrationRunId | orchestration 중 생성된 worktree를 Task와 Run에 연결할 수 있다. | 물리 workspace와 작업 출처를 느슨하게 연결한다. |
| cycle 검사 | 자기 자신을 부모로 두거나 조상으로 되돌아가는 변경을 거부한다. | worktree 계보의 구조적 안정성이 높다. |
| missing parent 처리 | instance identity가 없거나 부모를 증명하지 못하면 warning을 남기거나 lineage를 기록하지 않는다. | 잘못된 계보를 억지로 만드는 것보다 안전하다. |
| 삭제와 재생성 | 실제 Git scan으로 사라진 child 계보를 제거하고 사라진 parent의 instance identity를 갱신한다. | 외부 Git 명령으로 상태가 바뀌어도 stale 계보를 줄인다. |

Orca의 worktree 계보는 Git commit ancestry 그 자체가 아니다. 어떤 workspace 문맥에서 새 workspace가 만들어졌는지를 나타내는 운영 provenance다. 실제 checkout 기준은 baseBranch와 baseRef로 별도 관리된다. 이 분리는 올바르다.

### Orca Task와 Dispatch 그래프

| 요소 | 실제 구조 | 의미 |
|---|---|---|
| CoordinatorRun | 하나의 spec과 coordinator handle을 가진 실행 loop다. | Task를 polling하고 ready 작업을 Dispatch한다. |
| Run과 Task scope | CoordinatorRun과 Task 사이에 run_id relation이 없다. | 한 DB의 Task 목록을 coordinator가 함께 조회하는 전역 작업 pool에 가깝다. |
| Task parent_id | 선택적인 단일 부모 ID다. | 작업 생성 또는 분해 계보를 나타낼 수 있지만 실행 순서를 자동으로 뜻하지 않는다. |
| Task deps | Task ID 배열을 JSON 문자열로 저장한다. | 모든 dependency Task가 completed일 때 pending Task를 ready로 바꾼다. |
| Task status | pending, ready, dispatched, completed, failed, blocked다. | 작업과 실행 상태를 하나의 비교적 단순한 상태기에 합친다. |
| DispatchContext | Task, terminal handle, stable pane key, retry failure count를 연결한다. | 누가 현재 Task 완료 권한을 갖는지 식별한다. |
| Message | dispatch, heartbeat, worker_done, escalation, handoff, decision gate를 운반한다. | terminal agent 사이의 operational protocol이다. |
| DecisionGate | 하나의 Task를 blocked로 만들고 사용자가 해결하면 ready로 되돌린다. | 사람의 판단을 기다리는 기본 기능이 있다. |
| Coordinator worktree selector | coordinator가 선택한 worktree의 terminal을 찾거나 같은 worktree에 terminal을 만든다. | 기본 Dispatch 격리 단위는 Task별 새 worktree가 아니라 coordinator가 선택한 worktree다. |
| stale base guard | 선택한 worktree가 기준 branch보다 20 commit 넘게 뒤처지면 기본적으로 Dispatch를 보류한다. | 오래된 base에서 작업하는 위험을 실제로 줄인다. |
| decomposition | coordinator의 decompose 단계는 기존 Task가 있는지 확인할 뿐 자동 분해하지 않는다. | Task는 coordinator 실행 전에 CLI 또는 RPC로 미리 만들어야 한다. |

### Orca에서 서로 다른 두 그래프의 관계

| 관계 | 실제 상태 | 해석 |
|---|---|---|
| Task dependency와 worktree parent | 자동으로 같은 edge가 되지 않는다. | 올바른 분리다. 작업 B가 A를 소비한다고 해서 B의 worktree가 A worktree의 Git 자식일 필요는 없다. |
| Task와 worktree 생성 | Task ID, creator terminal, active Dispatch와 orchestration context를 이용해 생성 계보를 기록할 수 있다. | 누가 workspace를 만들었는지 추적하는 provenance 연결이다. |
| Task별 worktree 격리 | coordinator는 기본적으로 선택된 worktree의 terminal에 Task를 보낸다. | 모든 Task가 자동으로 고유 worktree를 받는 구조는 아니다. |
| Git base와 worktree parent | baseRef와 contextual parent lineage가 별도다. | commit 출발점과 사용자 또는 agent 생성 문맥을 혼동하지 않는다. |
| 완료와 Git 결과 | worker_done payload에는 filesModified가 들어갈 수 있지만 commit, tree digest, accepted artifact 계약은 없다. | workspace 변경과 의미론적 완료 사이의 연결은 약하다. |

## Orca 설계의 강점

| 강점 | 상세 평가 |
|---|---|
| 물리 격리의 실용성 | 실제 Git worktree, terminal, branch, diff와 remote workspace를 연결하므로 agent 병렬 작업에서 바로 가치가 생긴다. |
| workspace identity 방어 | path 기반 worktreeId만 믿지 않고 instanceId를 함께 확인한다. 삭제 후 같은 경로를 다시 만든 경우의 stale lineage 문제를 구체적으로 방어한다. |
| lineage의 정직성 | explicit과 inferred, capture source, warning을 구분한다. 추론한 부모를 확정 사실처럼 취급하지 않는다. |
| 실행 권한 검증 | worker_done의 taskId와 dispatchId뿐 아니라 현재 active Dispatch, handle, pane identity를 확인한다. 이전 retry나 다른 pane의 완료가 현재 Task를 끝내지 못한다. |
| 운영 복구 | heartbeat, hung dispatch, failure count, 3회 circuit breaker와 Decision Gate가 구현돼 있다. |
| stale checkout 방어 | Dispatch 전에 upstream drift를 검사한다. Baton worktree 설계가 반드시 참고할 부분이다. |
| 낮은 개념 비용 | Task와 terminal 중심이므로 사용자가 상태를 이해하고 수동 개입하기 쉽다. |
| 현재 완성도 | 설계 문서가 아니라 실제 SQLite, RPC, CLI, tests와 UI가 존재한다. |

## Orca 설계의 토폴로지 한계

| 한계 | 소스 수준 근거 | 발생 가능한 문제 |
|---|---|---|
| Task dependency reference 검증이 없다. | taskCreate는 deps가 문자열 배열인지 확인하지만 각 ID의 존재 여부를 검사하지 않고 저장한다. | 존재하지 않는 dependency를 가진 Task가 pending에 머물 수 있다. |
| Task dependency cycle 검증이 없다. | createTask와 RPC 경로에 DAG cycle 검사가 없다. | A가 B를 기다리고 B가 A를 기다리는 graph를 만들 수 있다. |
| Task가 CoordinatorRun에 귀속되지 않는다. | tasks와 dispatch_contexts schema에 run_id가 없고 coordinator는 DB의 전체 Task를 조회한다. | 여러 독립 Run의 graph를 동시에 안전하게 구분하거나 같은 DB에서 격리하기 어렵다. |
| parent_id 무결성 제약이 없다. | tasks schema의 parent_id에는 foreign key나 parent cycle 검사가 없다. | 삭제되거나 잘못된 부모 ID와 자기 부모 관계를 저장할 수 있다. |
| deps가 정규화된 edge table이 아니다. | JSON 배열을 모든 pending Task마다 parse해서 검사한다. | edge reason, output slot, dependency version, 소비 artifact를 표현하기 어렵다. |
| Task graph revision이 없다. | Task는 mutable row이고 graph head 또는 parent revision이 없다. | 실행 중 계획이 바뀌었을 때 worker가 어느 계획을 수행했는지 정확히 fence하기 어렵다. |
| 작업 의미 version이 없다. | Task spec과 상태가 한 row에 있다. | objective 또는 acceptance 기준 변경과 단순 상태 변경을 구조적으로 구분하기 어렵다. |
| 완료와 수락이 합쳐져 있다. | 현재 Dispatch의 유효한 worker_done이 Task를 즉시 completed로 바꾼다. | worker가 작업을 끝냈다는 보고가 요구사항 충족과 같은 의미가 된다. |
| downstream readiness가 completed에만 의존한다. | 모든 deps Task의 status가 completed면 다음 Task가 ready다. | 검수되지 않은 변경이나 불완전한 결과가 다음 작업의 입력으로 사용될 수 있다. |
| artifact provenance가 없다. | result는 completedBy, filesModified, completedAt 중심 JSON이다. | 다음 Task가 어느 commit, tree, patch 또는 검수 세대를 소비했는지 알 수 없다. |
| invalidation closure가 없다. | 이미 completed된 선행 Task 결과가 바뀌어도 downstream 결과를 자동 stale 처리하는 구조가 없다. | 재계획 후 오래된 결과와 새 결과가 섞일 수 있다. |
| 자원 충돌과 semantic dependency 구분이 약하다. | 별도 resource claim graph가 없다. | 같은 파일이나 browser를 쓰기 때문에 기다리는 상황을 deps로 표현하거나 사람이 관리하게 된다. |
| worktree와 Task의 기본 배치가 느슨하다. | coordinator는 선택한 worktree 안에서 여러 terminal을 Dispatch한다. | 병렬 Task가 같은 checkout을 수정하면 worktree가 있어도 Task별 write isolation은 보장되지 않는다. |
| coordinator가 계획을 자동 분해하지 않는다. | decompose 함수는 기존 Task가 없으면 오류를 내고, AI decomposition은 future phase라고 명시한다. | 현재 DAG 구성과 수정의 상당 부분을 사용자 또는 agent 명령에 의존한다. |

이 한계는 Orca가 나쁜 제품이라는 뜻이 아니다. Orca의 Task graph는 복잡한 형식 검증 시스템보다 실제 agent terminal을 빠르게 조율하는 pragmatic runtime으로 설계된 것으로 보는 편이 정확하다.

## Baton의 목표 토폴로지

### Baton이 분리하는 구조

| 구조 | 표현하는 사실 | 다른 구조와 분리해야 하는 이유 |
|---|---|---|
| Conversation과 Goal | 사용자가 무엇을 요청했고 장기 목표가 무엇인지 | agent session이나 Git branch가 사용자 목표의 정본이 되어서는 안 된다. |
| ObjectiveBindingSnapshot | 이번 Run이 목표의 어느 정확한 revision을 수행하는지 | 목표 수정 뒤 stale 실행이 이전 요구사항을 완료 처리하지 못하게 한다. |
| Requirement Ledger | 명시 요구사항과 acceptance evidence coverage | Task node가 모두 끝났다는 사실만으로 사용자 요구가 충족됐다고 할 수 없다. |
| WorkItem | provider와 workspace가 바뀌어도 유지되는 논리적 작업 | 실행 실패나 worktree 삭제가 작업 자체를 지우면 안 된다. |
| WorkItemVersion | 작업 objective와 입출력 계약의 immutable 의미 version | 의미 변경과 lifecycle 변경을 구분한다. |
| WorkGraphRevision | 특정 시점의 node version과 typed dependency 집합 | 실행 중 분해와 재계획을 감사하고 stale worker를 fence한다. |
| Decomposition lineage | split, merge, refine, supersede 이력 | 분해 관계가 실행 순서 또는 입력 소비를 자동으로 뜻하지 않는다. |
| ExecutionAssignment | 작업 version, context, permission, budget, graph revision을 실행에 결박 | agent가 기억하는 prompt가 실행 권한의 정본이 되지 않게 한다. |
| Execution과 Attempt | 실제 provider 또는 host 실행과 retry 이력 | retry, continuation과 parent execution을 한 edge로 합치지 않는다. |
| Resource claim | workspace, path, browser, device, account, port 등의 배타 사용 | 자원 충돌을 가짜 작업 dependency로 만들지 않는다. |
| ResultCandidate | worker가 제출했지만 아직 승인되지 않은 결과 | 실행 종료와 결과 수락을 분리한다. |
| AcceptanceReceipt | exact candidate와 policy에 대한 검수 결과 | reviewer 문장만으로 상태가 바뀌지 않게 한다. |
| AcceptedArtifact | downstream이 소비할 수 있는 검증된 결과 | 검수되지 않은 결과가 dependency를 만족하지 못하게 한다. |
| Event Journal | graph, 실행, 검수, 취소와 완료의 canonical 변경 이력 | UI projection과 실제 권위를 분리하고 crash recovery를 가능하게 한다. |

### Baton의 edge 의미론

| edge 또는 relation | 뜻 | worktree와의 관계 |
|---|---|---|
| consumes_accepted | 후속 WorkItem이 선행 WorkItem의 승인된 output을 실제 입력으로 소비한다. | 특정 worktree가 아니라 accepted commit, tree 또는 patch artifact를 resolve해야 한다. |
| integration_after | 여러 승인 산출물을 정해진 join 정책으로 통합한다. | merge worktree를 만들 수 있지만 integration WorkItem과 workspace는 별개다. |
| validates_candidate | reviewer가 exact ResultCandidate를 검수한다. | reviewer는 producer worktree를 그대로 신뢰하지 않고 frozen diff 또는 snapshot을 받아야 한다. |
| validation_prerequisite | 검수자가 검수에 필요한 별도 승인 자료를 소비한다. | 검수 대상 자체의 acceptance를 기다리는 cycle을 만들지 않는다. |
| decision_input | 사용자 또는 정책의 exact decision receipt를 소비한다. | 질문 때문에 관련 없는 worktree 실행까지 전부 멈추지 않는다. |
| condition | 활성 branch generation을 선택한다. | 비활성 branch의 workspace는 폐기할 수 있지만 이력은 보존한다. |
| decomposition relation | 작업이 어떻게 split, merge, refine, supersede됐는지 기록한다. | Git branch 부모와 다르다. |
| parent_execution_id | 어떤 실행이 실제로 child 실행을 만들었는지 기록한다. | worktree parent와 다르다. |
| retry_of_attempt_id | 어떤 Attempt의 재시도인지 기록한다. | 같은 worktree를 재사용하더라도 retry relation은 별도로 남는다. |
| resource exclusion | 동시에 사용할 수 없는 workspace나 path를 조정한다. | semantic dependency가 아니라 scheduler constraint다. |

## Baton에서 worktree를 넣어야 하는 정확한 위치

| 설계 항목 | 권장 의미 |
|---|---|
| WorkspacePlacementSpec | Assignment가 요구하는 repo, base artifact, isolation mode, sparse scope, write policy와 cleanup policy의 immutable 요청이다. |
| WorkspaceInstance | 실제 생성된 Git worktree의 stable instance ID, path, branch, HEAD, base ref, host와 lifecycle을 기록한다. |
| WorkspaceLease | 어느 Assignment 또는 Attempt가 어느 기간에 workspace를 쓸 권한이 있는지 기록한다. |
| WorkspaceLineage | 어떤 execution이 어느 workspace 문맥에서 새 workspace를 만들었는지 provenance로 기록한다. |
| CheckoutDerivation | 어느 commit 또는 accepted artifact snapshot에서 checkout했는지 기록한다. WorkspaceLineage와 분리한다. |
| WriteSetClaim | file 또는 path 충돌과 exclusive workspace 사용을 scheduler가 판단하는 자원 claim이다. |
| WorkspaceResultSnapshot | Attempt 종료 시 HEAD, tree digest, dirty state, patch digest와 untracked manifest를 freeze한다. |
| AcceptedArtifact | 검수 통과한 commit, tree, patch 또는 build artifact와 receipt generation을 저장한다. |
| IntegrationAssignment | 여러 AcceptedArtifact를 새 integration workspace에서 병합하고 검수한다. |
| TeardownReceipt | clean, archived, retained, removal_failed 같은 종료 결과와 남은 recovery action을 기록한다. |

### 피해야 할 모델

| 피해야 할 설계 | 문제 |
|---|---|
| WorkItem 하나를 worktree 하나와 동일시 | 같은 작업의 retry, 다른 model 재실행, read-only review와 여러 workspace 전략을 표현하기 어렵다. |
| worktree parent를 WorkItem dependency로 사용 | Git 생성 계보와 의미론적 결과 소비가 섞인다. |
| branch 이름을 WorkItem identity로 사용 | rename, rebase, delete와 같은 Git operation이 작업 identity를 깨뜨린다. |
| worker_done 시 worktree 전체를 accepted artifact로 간주 | dirty file, untracked file, 잘못된 base와 검수되지 않은 변경을 다음 작업이 소비할 수 있다. |
| retry마다 같은 dirty worktree를 그대로 재사용 | 이전 실패의 잔여 변경과 새 Attempt 결과를 분리하기 어렵다. |
| file 충돌을 dependency edge로 해결 | 두 작업이 의미상 독립이어도 불필요한 순서 관계가 생기고 critical path가 왜곡된다. |
| graph revision마다 모든 worktree 폐기 | 영향받지 않은 branch와 비싼 setup을 재사용하지 못한다. impact closure와 compatibility 검사가 필요하다. |

## 같은 상황에서의 동작 비교

### 독립된 두 작업이 서로 다른 파일을 수정하는 경우

| Orca | Baton 목표 설계 | 판정 |
|---|---|---|
| 사용자가 두 worktree를 만들면 실제로 안전하게 병렬 실행할 수 있다. coordinator만 사용하면 같은 선택 worktree의 여러 terminal에 배치될 수도 있다. | WorkItem은 dependency 없이 병렬 ready가 된다. Scheduler가 별도 WorkspaceInstance와 non-conflicting WriteSetClaim을 배정한다. | 현재는 Orca가 동작한다. 목표 의미론은 Baton이 더 명확하다. |

### 독립된 두 작업이 같은 파일을 수정하는 경우

| Orca | Baton 목표 설계 | 판정 |
|---|---|---|
| 서로 다른 worktree면 동시에 수정할 수 있지만 나중에 merge conflict를 사람이 처리해야 한다. 같은 worktree면 즉시 충돌할 수 있다. | semantic dependency는 만들지 않는다. workspace와 path claim으로 격리하고 integration WorkItem에서 충돌 해결과 검수를 수행한다. | Baton의 dependency와 resource 분리가 더 정확하다. Orca의 실제 merge UX는 참고할 가치가 크다. |

### A 결과를 B가 실제 입력으로 쓰는 경우

| Orca | Baton 목표 설계 | 판정 |
|---|---|---|
| A가 worker_done을 보내 completed가 되면 B가 ready가 된다. 어떤 exact commit을 소비하는지는 dependency에 없다. | A의 ResultCandidate가 정책에 따라 accepted된 후 exact artifact ID와 receipt generation을 B input manifest에 고정한다. | Baton 의미론 우세다. |

### Worker가 작업을 A1과 A2로 다시 나누는 경우

| Orca | Baton 목표 설계 | 판정 |
|---|---|---|
| 새 Task를 만들고 parent와 deps를 지정할 수 있다. graph revision과 기존 실행 영향의 canonical commit은 없다. | mutation proposal을 exact base revision에 제출하고 cycle, scope, acceptance coverage, active Attempt disposition과 impact closure를 검증한 뒤 새 revision을 commit한다. | Baton topology 우세지만 현재 미구현이다. |

### Retry가 진행 중인데 이전 worker가 늦게 완료를 보내는 경우

| Orca | Baton 목표 설계 | 판정 |
|---|---|---|
| dispatchId와 active Dispatch, handle, pane key를 검사해 stale 완료를 거부한다. | assignment epoch, attempt ID, fence token과 graph revision을 검사해 stale candidate를 diagnostic 또는 orphaned candidate로만 보존한다. | Orca는 현재 강한 구현을 갖고 있다. Baton은 더 넓은 형식 계약을 목표로 한다. |

### worktree 경로가 삭제 후 같은 경로로 재생성된 경우

| Orca | Baton 목표 설계 | 판정 |
|---|---|---|
| instanceId가 달라 이전 lineage를 유효하게 붙이지 않는다. | WorkspaceInstance도 경로와 별도인 generation identity를 가져야 한다. | Orca 설계를 Baton이 그대로 참고해야 한다. |

### 기준 branch가 크게 앞서간 경우

| Orca | Baton 목표 설계 | 판정 |
|---|---|---|
| 기본 20 commit threshold로 Dispatch를 보류하고 명시 override를 허용한다. | Assignment admission에서 base artifact compatibility와 drift policy를 검사하고 stale 허용 여부를 policy snapshot에 기록해야 한다. | 현재 Orca 우세다. Baton 문서에 구체적인 worktree drift 정책 보강이 필요하다. |

### Worker 결과가 형식상 완료됐지만 테스트가 실패한 경우

| Orca | Baton 목표 설계 | 판정 |
|---|---|---|
| worker_done이 유효하면 Task는 completed다. 별도 검수 Task를 만들어 보완할 수 있지만 원래 completion과 acceptance가 구조적으로 분리되지는 않는다. | ResultCandidate 상태에 두고 machine verifier 실패 receipt를 기록한다. WorkItem은 rework_required이며 downstream dependency는 열리지 않는다. | Baton 의미론 우세다. |

### 사용자의 결정이 한 subtree에만 영향을 주는 경우

| Orca | Baton 목표 설계 | 판정 |
|---|---|---|
| DecisionGate가 지정 Task를 blocked로 만든다. | Decision generation과 exact consumer set을 기록하고 영향 closure만 기다리게 한다. 무관한 branch는 계속 실행한다. | Orca는 기본 기능이 실제 동작하고, Baton은 더 정밀한 scope 의미론을 목표로 한다. |

## 항목별 상세 판정

| 평가 축 | Orca | Baton 목표 설계 | 우세 |
|---|---|---|---|
| 물리 workspace topology | 실제 worktree tree, branch, terminal과 host가 연결된다. | 이 문서의 가정일 뿐 아직 runtime이 없다. | Orca 현재 |
| worktree identity | path와 instance identity를 함께 사용한다. | 별도 WorkspaceInstance generation이 필요하다. | Orca 현재 |
| worktree lineage cycle 방지 | 구현돼 있다. | canonical graph validator에 포함해야 한다. | Orca 현재 |
| Task dependency cycle 방지 | 구현 경로에서 확인되지 않는다. | graph commit 필수 검증이다. | Baton 설계 |
| dangling dependency 방지 | Task ID 존재 검증이 없다. | reference 검증을 명시한다. | Baton 설계 |
| Run별 graph isolation | Task row에 run_id가 없다. | 모든 WorkItem과 graph revision이 exact run_id에 귀속된다. | Baton 설계 |
| semantic edge 정밀도 | deps가 completed Task ID만 참조한다. | accepted output, candidate review, decision, condition을 구분한다. | Baton 설계 |
| decomposition과 dependency 분리 | parent_id와 deps가 별도이므로 기본 분리는 있다. | split, merge, refine, supersede lineage를 정식으로 분리한다. | Baton 설계 |
| 실행과 작업 분리 | DispatchContext가 Task와 terminal을 분리한다. | WorkItem, Assignment, Execution, Attempt를 더 엄밀히 분리한다. | Baton 설계 |
| stale retry completion 방지 | 실제 dispatch와 pane identity 검증이 있다. | 더 일반적인 epoch와 fence 설계가 있다. | 현재 Orca, 목표 Baton |
| graph revision과 동시 변경 | 없다. | immutable revision과 CAS를 사용한다. | Baton 설계 |
| 결과 검수와 acceptance | worker_done과 completed가 사실상 연결된다. | candidate, verifier, acceptance와 artifact를 분리한다. | Baton 설계 |
| downstream artifact provenance | filesModified 요약은 있으나 exact accepted input은 없다. | artifact digest와 acceptance generation을 input manifest에 고정한다. | Baton 설계 |
| 결과 무효화 | dependency 또는 base 변경의 closure가 없다. | provenance 기반 최소 impact closure를 계산한다. | Baton 설계 |
| 자원과 의미 dependency 분리 | 별도 typed resource claim 모델이 없다. | workspace, file, device, account 등을 scheduler resource로 둔다. | Baton 설계 |
| 외부 launch 불확실성 | terminal과 heartbeat 복구가 있으나 모든 effect에 대한 canonical unknown 모델은 아니다. | PREPARED, STARTING, UNKNOWN과 reconciliation을 명시한다. | Baton 설계 |
| 사용자 이해 비용 | 낮다. | 높다. 여러 identity와 receipt를 UI projection으로 단순화해야 한다. | Orca |
| 현재 구현과 UX | 매우 앞서 있다. | child scheduler와 WorkGraph가 비활성 또는 미구현이다. | Orca 현재 |

## Baton 설계가 과도해질 수 있는 지점

| 위험 | 설명 | 권장 대응 |
|---|---|---|
| 단순 작업에도 전체 WorkGraph 생성 | 작은 수정까지 수십 개의 canonical record로 보이면 사용성과 구현 속도가 악화된다. | 기존 원칙대로 flat WorkSet을 기본으로 하고 실제 dependency, integration 또는 replan이 있을 때만 graph를 활성화한다. |
| 지나친 fence로 병렬성 상실 | 작은 metadata 변경이 모든 Assignment를 무효화하면 형식 안전성 때문에 실제 작업이 멈춘다. | exact impact closure와 compatibility 검사를 사용해 영향받지 않은 Attempt와 workspace를 유지한다. |
| worktree 수 폭증 | WorkItem, retry, review마다 무조건 새 worktree를 만들면 disk와 setup 비용이 커진다. | 위험도, write isolation, base compatibility에 따른 workspace reuse policy를 둔다. |
| 사용자가 내부 구조를 직접 봐야 함 | Assignment, Attempt, receipt와 revision을 모두 전면 노출하면 Orca보다 훨씬 어렵다. | 기본 UI는 작업, 현재 실행 위치, 검수 상태, 차단 이유만 보여주고 내부 identity는 상세 화면에 둔다. |
| 구현 전 기능 과대 주장 | 정교한 문서가 실제 runtime처럼 보일 수 있다. | 모든 비교에서 설계 목표와 구현 상태를 함께 표시한다. |
| 완전한 의미 검증 환상 | typed graph가 작업 분해의 진실성까지 보장하지는 않는다. | semantic reviewer와 사용자 authority를 유지하고 불확실성을 receipt에 기록한다. |

## 권장 결합 설계

| 계층 | Baton이 소유할 것 | Orca에서 참고할 것 |
|---|---|---|
| 목표 계층 | Conversation, Goal, Objective Binding, Requirement Ledger | terminal 작업 설명을 간결하게 보여주는 UX |
| 작업 계층 | WorkItem, WorkItemVersion, WorkGraphRevision, typed edges | Task 목록과 ready, blocked, running 상태의 직관적인 표시 |
| 실행 계층 | Assignment, Execution, Attempt, fence와 route evidence | terminal handle, stable pane identity, heartbeat와 stale worker 차단 |
| workspace 계층 | WorkspacePlacementSpec, WorkspaceInstance, Lease, Snapshot과 TeardownReceipt | path와 instance identity 분리, explicit 또는 inferred lineage, warning, parent cycle 검사 |
| Git 계층 | accepted base artifact, output tree 또는 patch digest, integration assignment | base branch 선택, stale drift 검사, branch와 worktree 생성 및 cleanup UX |
| 검수 계층 | ResultCandidate, verifier, AcceptanceReceipt, AcceptedArtifact | diff review, file comments, browser 확인과 source control UI |
| scheduler 계층 | semantic readiness, admission, resource dispatchability 분리 | 실제 terminal 생성, worktree 선택과 remote host dispatch |
| 복구 계층 | event journal, unknown outcome, reconciliation과 invalidation closure | missing worktree scan, stale path lineage 제거와 실용적인 retry circuit breaker |

## 구현 우선순위 제안

| 순서 | 구현 항목 | 이유 |
|---:|---|---|
| 1 | WorkspaceInstance를 WorkItem과 분리한 ADR | 처음부터 identity를 섞으면 이후 migration이 가장 어렵다. |
| 2 | path와 별도인 workspace instance generation | Orca 소스가 실제로 방어하는 same-path replacement 문제를 초기에 막는다. |
| 3 | Assignment의 WorkspacePlacementSpec과 immutable base snapshot | 어느 작업이 어느 base에서 실행됐는지 고정한다. |
| 4 | Task 또는 WorkItem별 exclusive WorkspaceLease | 같은 checkout에 병렬 writer가 배치되는 문제를 막는다. |
| 5 | 종료 시 tree, patch, dirty와 untracked snapshot | worker 말이 아니라 실제 workspace 결과를 freeze한다. |
| 6 | ResultCandidate와 machine verifier | worker_done과 acceptance를 가장 먼저 분리한다. |
| 7 | accepted artifact를 소비하는 최소 DAG | dependency가 exact 검수 결과를 가리키게 한다. |
| 8 | revision CAS와 cycle 및 dangling reference 검사 | 동적 분해 전에 static graph 무결성을 확보한다. |
| 9 | stale base admission과 explicit override | Orca의 실용적 안전 장치를 Baton policy snapshot으로 가져온다. |
| 10 | impact closure와 workspace 재사용 정책 | dynamic graph 변경 뒤 필요한 workspace만 fence한다. |

## 최종 판정 문구

| 용도 | 권장 문구 |
|---|---|
| 설계 평가 | Baton의 WorkGraph는 Orca의 Task DAG보다 토폴로지와 의미론이 더 엄밀하다. 작업, 실행, 재시도, 자원, 검수와 산출물 관계를 분리하고 graph revision과 acceptance provenance를 보존하기 때문이다. |
| 현재 제품 평가 | 현재 worktree 기반 다중 agent 운용은 Orca가 훨씬 앞선다. Baton의 WorkGraph와 child scheduler는 아직 목표 설계이며 실제 worktree lifecycle도 구현되지 않았다. |
| worktree 결합 원칙 | Baton이 worktree를 지원할 때 worktree는 WorkItem이 아니라 Assignment와 Attempt가 임대하는 실행 환경이어야 한다. Git 부모, 작업 dependency와 실행 parent는 서로 다른 관계로 유지해야 한다. |
| 제품 전략 | Baton은 Orca의 worktree 생성, instance identity, lineage warning, stale base guard와 UX를 흡수하되, Orca의 mutable Task 완료 의미론을 그대로 복제해서는 안 된다. |
| 종합 결론 | 가장 훌륭한 구조는 Baton의 semantic WorkGraph를 정본으로 두고 Orca식 worktree runtime을 실행 placement 계층으로 결합한 형태다. |

## Orca 소스 근거

| 판정 | 소스 |
|---|---|
| Task, deps, Dispatch와 Gate schema | [orchestration/db.ts L103](https://github.com/stablyai/orca/blob/d9d939a33b5858495ffb33489a952f1ac9293610/src/main/runtime/orchestration/db.ts#L103-L195) |
| orchestration DB는 app userData의 단일 SQLite 파일 | [orca-runtime.ts L3116](https://github.com/stablyai/orca/blob/d9d939a33b5858495ffb33489a952f1ac9293610/src/main/runtime/orca-runtime.ts#L3116-L3127) |
| Task 생성은 deps 문자열 배열을 저장 | [orchestration/db.ts L505](https://github.com/stablyai/orca/blob/d9d939a33b5858495ffb33489a952f1ac9293610/src/main/runtime/orchestration/db.ts#L505-L537) |
| RPC는 deps JSON 형식만 검사 | [rpc/methods/orchestration.ts L376](https://github.com/stablyai/orca/blob/d9d939a33b5858495ffb33489a952f1ac9293610/src/main/runtime/rpc/methods/orchestration.ts#L376-L403) |
| completed dependency가 pending Task를 ready로 승격 | [orchestration/db.ts L596](https://github.com/stablyai/orca/blob/d9d939a33b5858495ffb33489a952f1ac9293610/src/main/runtime/orchestration/db.ts#L596-L633) |
| Dispatch는 현재 Task, terminal과 pane identity를 검사 | [lifecycle-reconciliation.ts L155](https://github.com/stablyai/orca/blob/d9d939a33b5858495ffb33489a952f1ac9293610/src/main/runtime/orchestration/lifecycle-reconciliation.ts#L155-L226) |
| worker_done이 Task를 completed 처리 | [lifecycle-reconciliation.ts L227](https://github.com/stablyai/orca/blob/d9d939a33b5858495ffb33489a952f1ac9293610/src/main/runtime/orchestration/lifecycle-reconciliation.ts#L227-L238) |
| coordinator는 선택 worktree에 terminal을 생성 | [coordinator.ts L346](https://github.com/stablyai/orca/blob/d9d939a33b5858495ffb33489a952f1ac9293610/src/main/runtime/orchestration/coordinator.ts#L346-L367) |
| coordinator 자동 decomposition은 아직 미구현 | [coordinator.ts L183](https://github.com/stablyai/orca/blob/d9d939a33b5858495ffb33489a952f1ac9293610/src/main/runtime/orchestration/coordinator.ts#L183-L196) |
| Dispatch 전 stale base 검사 | [coordinator.ts L385](https://github.com/stablyai/orca/blob/d9d939a33b5858495ffb33489a952f1ac9293610/src/main/runtime/orchestration/coordinator.ts#L385-L419) |
| worktree lineage에 instance, origin, capture와 Task provenance 저장 | [shared/types.ts L661](https://github.com/stablyai/orca/blob/d9d939a33b5858495ffb33489a952f1ac9293610/src/shared/types.ts#L661-L703) |
| worktree 생성 뒤 lineage 기록 | [orca-runtime.ts L15663](https://github.com/stablyai/orca/blob/d9d939a33b5858495ffb33489a952f1ac9293610/src/main/runtime/orca-runtime.ts#L15663-L15740) |
| parent self-cycle과 ancestor cycle 검사 | [orca-runtime.ts L20847](https://github.com/stablyai/orca/blob/d9d939a33b5858495ffb33489a952f1ac9293610/src/main/runtime/orca-runtime.ts#L20847-L20889) |
| inferred lineage source와 conflict 처리 | [orca-runtime.ts L20888](https://github.com/stablyai/orca/blob/d9d939a33b5858495ffb33489a952f1ac9293610/src/main/runtime/orca-runtime.ts#L20888-L21152) |
| Task와 terminal에서 orchestration lineage 추론 | [orca-runtime.ts L21154](https://github.com/stablyai/orca/blob/d9d939a33b5858495ffb33489a952f1ac9293610/src/main/runtime/orca-runtime.ts#L21154-L21220) |
| instance identity로 stale lineage를 제외 | [orca-runtime.ts L21435](https://github.com/stablyai/orca/blob/d9d939a33b5858495ffb33489a952f1ac9293610/src/main/runtime/orca-runtime.ts#L21435-L21469) |
| 사라진 worktree의 stale lineage 정리 | [orca-runtime.ts L21472](https://github.com/stablyai/orca/blob/d9d939a33b5858495ffb33489a952f1ac9293610/src/main/runtime/orca-runtime.ts#L21472-L21511) |

## Baton 설계 근거

| 판정 | 문서 |
|---|---|
| 작업, 실행, 후보와 승인 산출물 identity 분리 | [Work-Centric V4 2장](WORK_CENTRIC_ORCHESTRATION_DESIGN_V4.md#2-corrected-conceptual-model) |
| core invariants와 edge 종류 분리 | [Work-Centric V4 3장](WORK_CENTRIC_ORCHESTRATION_DESIGN_V4.md#3-core-invariants) |
| WorkItemVersion, WorkItemState와 WorkGraphRevision | [Work-Centric V4 7장](WORK_CENTRIC_ORCHESTRATION_DESIGN_V4.md#7-work-state-and-graph-records) |
| accepted artifact, candidate review와 decision edge 의미 | [Work-Centric V4 8장](WORK_CENTRIC_ORCHESTRATION_DESIGN_V4.md#8-corrected-edge-semantics) |
| Assignment, Execution과 Attempt relation | [Work-Centric V4 9장](WORK_CENTRIC_ORCHESTRATION_DESIGN_V4.md#9-assignment-and-execution-identity) |
| graph mutation proposal, revision CAS와 fencing | [Work-Centric V4 12장](WORK_CENTRIC_ORCHESTRATION_DESIGN_V4.md#12-proposal-and-mutation-authority) |
| semantic readiness, admission과 dispatchability 분리 | [Work-Centric V4 14장](WORK_CENTRIC_ORCHESTRATION_DESIGN_V4.md#14-readiness-admission-dispatch-and-fairness) |
| AcceptancePolicy와 AcceptanceReceipt | [Work-Centric V4 16장](WORK_CENTRIC_ORCHESTRATION_DESIGN_V4.md#16-acceptance-authority) |
| 완료와 execution 종료 분리 | [Work-Centric V4 20장](WORK_CENTRIC_ORCHESTRATION_DESIGN_V4.md#20-completion-ownership) |
| Agent tree, decomposition lineage와 Work DAG 분리 | [Pareto 설계 3장](PARETO_ORCHESTRATION_PLUGIN_AND_EVOLVING_WORK_GRAPH.md#3-서로-다른-세-구조) |
| immutable WorkItemVersion과 canonical Attempt | [Pareto 설계 4장](PARETO_ORCHESTRATION_PLUGIN_AND_EVOLVING_WORK_GRAPH.md#4-canonical-데이터-모델) |
| graph revision, mutation journal과 commit bundle | [Pareto 설계 4.4장](PARETO_ORCHESTRATION_PLUGIN_AND_EVOLVING_WORK_GRAPH.md#44-workgraphrevision과-mutation-journal) |
| dependency, resource와 result invalidation 분리 | [Pareto 설계 10장](PARETO_ORCHESTRATION_PLUGIN_AND_EVOLVING_WORK_GRAPH.md#10-dependency-resource와-결과-무효화) |
| WorkGraph와 child scheduler 미구현 상태 | [구현 정합성 현황](IMPLEMENTATION_STATUS.md) |

## 재평가 조건

| 변화 | 다시 볼 판정 |
|---|---|
| Orca가 dependency reference와 cycle validator를 추가 | Task DAG 무결성 비교 |
| Orca가 Task graph revision과 mutation CAS를 추가 | 동적 topology 비교 |
| Orca가 ResultCandidate, verifier와 AcceptedArtifact를 추가 | acceptance 의미론 비교 |
| Orca가 Task별 immutable workspace snapshot과 artifact provenance를 추가 | worktree와 WorkGraph 연결 비교 |
| Baton이 WorkspaceInstance와 worktree runtime을 구현 | 물리 workspace 현재 우위 |
| Baton이 child scheduler와 accepted artifact DAG를 구현 | 설계 우위와 현재 제품 우위의 구분 |
| Baton이 Orca식 instance lineage와 stale base guard를 채택 | worktree identity와 운영 안전성 비교 |
