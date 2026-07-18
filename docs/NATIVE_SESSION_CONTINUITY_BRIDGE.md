# Native session continuity bridge

상태: **Phase 4 규범 설계 — 미구현**  
작성일: 2026-07-18  
상위 계약: [`COMMON_SESSION_DESIGN.md`](COMMON_SESSION_DESIGN.md)  
관측 근거와 검토 중인 동반 제안: [`CODEX_NATIVE_PROXY_SSOT_DECISION.md`](CODEX_NATIVE_PROXY_SSOT_DECISION.md)

`CODEX_NATIVE_PROXY_SSOT_DECISION.md`는 아직 검수 요청용 제안이며 이 문서의 규범적 상위 결정이 아니다. 다만 native client 모드와 canonical runtime의 SSOT가 다르다는 관측은 이 설계에서도 명시적으로 보존한다.

## 1. 결정 요약

이 기능은 Claude·Codex native 세션에 흩어진 작업을 발견·대조하고 다음 실행 위치로 안전하게 승계하는 **migration/recovery bridge**다. 정상 상태에서는 한 논리 작업의 authority epoch마다 writer와 SSOT가 정확히 하나다. authority 전환 중에는 마지막으로 확정된 SSOT를 read-only로 유지하고 모든 종속 write를 동결하며, 새 writer는 전환이 검증·commit되기 전에 활성화하지 않는다.

| 모드 | SSOT와 writer | Baton의 역할 | 이후 실행 |
|---|---|---|---|
| `canonical_migration` | Baton session/thread/item | canonical conversation owner | Baton provider adapter만 실행 |
| `native_handoff` | 선택한 target native task/session | read-only source 분석, handoff proposal과 receipt 장부 | 사용자가 선택한 native client에서 실행 |

- provider·model·계정·gateway는 source/execution namespace이며 논리 작업 identity가 아니다.
- native session import/export는 호환 기능이다.
- 두 모드를 동시에 활성화하거나 native와 Baton을 공동 SSOT로 선언하지 않는다.
- native 파일 직접 수정, 양방향 동기화, provider tag 재작성은 지원하지 않는다.
- 모드 전환은 terminal source cut, 사용자 승인, 새 authority epoch와 single-writer 검증을 요구한다.

이 경계에서는 Baton의 “provider가 바뀌어도 대화를 잇는다”는 목표에 직접 부합한다. 경계를 벗어나면 canonical ownership과 native bridge 비권위 원칙을 위반한다.

## 2. 배경과 문제

기존 운용에서는 Codex 사용 한도 때문에 진행 중인 여러 Codex task를 수동 prompt로 Claude에 승계했다. 이후 Codex 한도가 복구되자 원래 Codex 내용과 Claude에서 추가된 작업·결정·목표를 다시 합쳐야 했다. 작업마다 다음 판단이 필요했다.

- 어느 Codex task와 Claude session이 같은 논리 작업인지
- 어느 지시·결정·파일 변경이 최신이고 아직 유효한지
- 목표를 교체해야 하는지, 추가 context만 필요하거나 둘 다 필요한지
- 모델이 어느 source 범위를 읽어야 충분한지
- 적용된 handoff가 실제 다음 실행에 사용됐는지

native Desktop 목록은 안정적인 전역 index가 아니다.

- 확인된 Codex 환경에서는 `model_provider` 변경 뒤 기존 `openai` task가 삭제된 것이 아니라 provider-filtered Desktop 목록에서 숨겨졌다. DB/rollout을 새 provider로 재작성해서는 안 된다.
- 관측된 Claude Desktop 환경에서는 로그인 계정과 gateway 설정이 서로 다른 session 목록을 보였다. 저장·조회 계약은 client/version별 capability probe 전에는 추정하지 않는다.
- 앱·tray·backend·task-open 상태에 따라 적용과 실제 실행 시작 시점이 다를 수 있다.

따라서 보이는 목록, 현재 provider, 프로세스 실행 여부 중 어느 것도 단독으로 source 존재나 실행 재개를 증명하지 않는다.

## 3. 방향 비대칭과 capability 경계

수동으로 가능한 동작과 Baton이 자동화할 수 있는 지원 계약을 구분한다.

| 대상 | 현재 관측된 수동/in-product 흐름 | Baton 자동 적용 | 기본 fallback |
|---|---|---|---|
| Codex task | 기존 task를 열어 message를 추가하고 필요하면 `/goal` 변경 | 지원 API/wrapper, exact target binding과 live conformance를 통과하기 전 **비활성** | preview한 message/goal package를 사용자가 적용 |
| Claude Desktop | 현재 namespace에서 session을 열어 일반 prompt 전달 | 안정적인 외부 session 생성·goal/message API가 확인되기 전 **비활성** | 기존 또는 새 session에 context prompt 전달 |
| Claude Code wrapper | 명시적 session 실행 가능성은 있으나 version별 검증 필요 | versioned wrapper contract 통과 뒤에만 활성 | prompt package |
| Baton adapter | Codex Preview만 현재 등록됨 | adapter capability가 있는 provider만 가능 | 미지원 provider 선택 차단 |

### 3.1 Claude → Codex native handoff

현재 특정 환경에서는 기존 Codex task에 context를 전달하고 목표가 실질적으로 바뀐 경우 `/goal`을 갱신하는 수동 흐름이 가능했다. 이는 안정적인 Baton API capability를 뜻하지 않는다. 자동화는 versioned probe, terminal-head 검증, message/goal 적용 conformance와 결과 reconciliation을 모두 통과한 client/version에서만 허용한다.

### 3.2 Codex → Claude native handoff

Claude Desktop에는 Codex task와 동등한 durable `/goal` primitive나 외부 session mutation 계약이 확인되지 않았다. 따라서 현재 기본 출력은 다음 중 하나다.

- 보이는 기존 Claude session에 전달할 context prompt package
- 새 Claude/Claude Code session에 전달할 goal·진행 상태·source reference package
- Claude adapter 구현 뒤 `canonical_migration`을 선택하고 같은 Baton thread의 다음 turn 실행

Claude 일반 prompt를 Codex `/goal`과 같은 durable goal로 간주하지 않는다.

### 3.3 Canonical 전환 뒤의 정상 흐름

```text
Codex source snapshot ──┐
                        ├─▶ Baton canonical thread ─▶ Codex turn adapter
Claude source snapshot ─┘                         └─▶ Claude turn adapter
```

`canonical_migration`을 commit한 뒤 원래 native source에서 계속 실행하면 single-writer 계약이 깨진다. native 실행이 필요하면 먼저 `native_handoff` authority epoch로 전환해야 하며, 그 시점부터 native target이 SSOT다.

## 4. Authority epoch, transition과 identity

### 4.1 상호배타 epoch

각 논리 작업은 다음을 기록한다.

```text
logical_work_id
authority_epoch_id
mode: canonical_migration | native_handoff
authoritative_store_ref
writer_capability
source_cut_refs[]
started_at
ended_at?
transition_receipt?
```

native에서 Baton으로 돌아오려면 native delta를 새 cut으로 재import·reconcile한 뒤 새 canonical epoch를 승인한다. 자동 양방향 capture를 가정하지 않는다.

### 4.2 Durable authority transition

외부 native side effect는 Baton DB transaction에 포함할 수 없으므로 active epoch와 별도로 `authority_transition`을 둔다.

```text
PREPARED -> QUIESCED -> APPLYING -> COMMITTED
                │           ├─> APPLY_UNKNOWN
                │           ├─> DIVERGED
                └───────────> ABORTED
```

- logical work마다 `ACTIVE` epoch는 최대 하나이고 open transition도 최대 하나다. DB partial unique constraint 또는 동등한 transactional invariant로 강제한다.
- `PREPARED`는 old epoch revision, source/target head, goal, capability, proposal과 approval digest를 보존한다.
- `QUIESCED`에서는 old epoch가 마지막 확정 SSOT지만 writer는 동결된다. 새 epoch는 아직 active가 아니다.
- `APPLYING` 전에 target을 다시 읽고 stale이면 `ABORTED` 또는 새 승인으로 돌아간다.
- 외부 적용과 확인이 끝난 뒤에만 old epoch 종료와 new epoch `ACTIVE`를 old revision CAS 조건 아래 같은 Baton transaction으로 commit한다.
- 외부 결과가 불명확하면 `APPLY_UNKNOWN`이며 어느 새 writer도 활성화하지 않고 해당 logical work의 종속 실행을 막는다.
- abort는 old head가 quiesce 당시와 같고 외부 side effect가 없음을 증명할 때만 old writer를 재활성화할 수 있다.
- Baton이 native client의 out-of-band 실행을 물리적으로 막았다고 주장하지 않는다. old/target head가 바뀌면 `DIVERGED`로 표시하고 새 terminal cut과 reconciliation을 요구한다.

수동 package 경로에서 사용자는 target을 새 SSOT로 지정할 수 있다. 이때 package 적용의 기계 검증과 authority 선택을 구분한다. 사용자가 exact target·head·proposal을 확인하고 새 native authority를 명시적으로 선택하면 `application_evidence=user_attested`로 transition을 commit할 수 있지만 `APPLIED`, `VISIBLE` 또는 `VERIFIED`를 기계 검증 상태로 표시하지 않는다.

### 4.3 Immutable source와 mutable target 분리

`source_snapshot`은 import 당시 content-addressed cut이다.

```text
source_snapshot_id
client_kind
provider
scoped_account_profile_pseudonym
scoped_endpoint_pseudonym
native_session_or_task_id
source_reader_locator
observed_schema_version
range_or_head_revision
content_digest
captured_at
```

`native_export_target`은 이후 변경될 수 있는 별도 identity다.

```text
target_namespace
native_session_or_task_id
capability_version
observed_head_revision_or_digest
observed_goal_digest?
```

같은 native task가 source와 target이어도 두 record를 합치지 않는다. apply 후 새 target revision을 별도로 관측한다.

replay 보장은 두 단계로 나눈다.

- `canonical replay`: import된 portable/normalized Baton items, authority events, goal artifact와 loss report를 Baton 저장소만으로 재생한다. canonical mode의 필수 보장이다.
- `native source replay`: 원래 native record/range를 byte-equivalent하게 재생한다. 암호화된 immutable artifact/chunk를 보관한 source에만 보장한다.

raw native artifact를 보관하지 않는 정책의 `source_snapshot`은 content digest로 외부 cut의 무결성을 확인하는 reference다. 원본이 삭제·변경되면 native source replay를 주장하지 않으며, canonical replay와 당시 import report만 유지한다.

## 5. 안전한 SourceReader

모델에 raw filesystem path나 native DB 접근 권한을 주지 않는다. Baton 소유의 bounded read-only `SourceReader`가 다음 계약으로 index와 range를 제공한다.

- 사용자가 승인한 project/root/client/namespace allowlist
- canonical path 확인과 symlink/junction/reparse-point containment
- file count, byte, record, time와 model-call 상한
- versioned parser와 unknown-schema fail-closed
- content digest와 읽은 range audit
- source별 sensitivity 및 portability-loss label

native transcript는 명령이 아니라 untrusted data다. handoff 분석 route에는 shell, write, native session mutation과 unrestricted network 도구를 제공하지 않는다. transcript 내부의 tool 지시, “이전 지시를 무시하라”, 외부 링크 fetch 요청은 실행하지 않는다.

raw credential·token·secret-like field는 index, prompt, log에 포함하지 않는다. outbound model 호출 전 redaction 결과와 disclosure 범위를 정책에 따라 검증하고, 필요한 민감 원문 전송은 별도 사용자 승인 없이는 금지한다. raw native blobs는 암호화-at-rest 보관이 구현되기 전 Baton store에 복제하지 않으며 source cut의 digest와 bounded normalized content만 저장한다. 이 경우 native source replay는 지원하지 않는다.

account/profile/endpoint 식별자는 설치별 비밀키를 사용한 scoped pseudonym으로 만든다. 평문 identifier의 단순 hash를 사용하지 않는다. retention·archive·delete는 source snapshot, normalized content, analysis artifact와 receipt별로 명시하고 삭제 시 provenance가 깨지는 경우 먼저 영향을 표시한다.

## 6. 이행 파이프라인

### 6.1 Discover

승인된 namespace만 읽기 전용으로 열거한다. Desktop 기본 필터와 별개로 가능한 경우 provider 전체를 조회하고 목록 누락과 실제 source 부재를 구분한다.

### 6.2 Match

동일 논리 작업 후보는 repository/worktree identity, 안정적 ID, 시간적 handoff, goal·사용자 지시, 변경 artifact digest와 명시적 승계 reference를 함께 사용한다. `cwd`, 제목 또는 model confidence만으로 자동 merge하지 않는다. 모호하면 사용자 결정을 기다리되 독립 작업의 분석은 resource cap 안에서 계속한다.

### 6.3 Analyze by reference

transcript 전체를 선주입하지 않는다. SourceReader index와 안전한 range handle을 주고 모델이 필요한 범위를 선택하게 한다. 실제 read set과 digest를 기록한다.

`handoff_analysis`는 versioned route policy를 사용한다. 지정 model/effort가 필수라면 provider/runtime가 반환한 신뢰 가능한 execution metadata만 attestation으로 인정한다.

```text
VERIFIED      요구한 model/effort와 신뢰 가능한 metadata가 일치
MISMATCH      metadata가 다른 model/effort를 증명
UNVERIFIABLE  metadata 누락·출처 불명·effort 미노출
```

필수 route에서는 `MISMATCH`와 `UNVERIFIABLE` 모두 hard fail이다. 사용자는 정책을 바꿔 새 분석을 실행할 수 있지만 이미 생성된 fallback/미확인 결과를 소급 승인할 수 없다. 현재 owner policy가 요구하는 `gpt-5.6-sol/high`는 deployment policy로 기록하며 core schema에 고정하지 않는다.

### 6.4 Reconcile

작업별로 다음 artifact를 만든다.

- mode와 authority epoch proposal
- canonical 또는 native-target goal proposal과 revision 근거
- 완료 작업과 검증 증거
- 추가된 결정·변경·미완료 작업·blocker
- 충돌·폐기된 지시와 근거
- portable context와 provider-private/비이식 손실 보고

이전 native session의 마지막 assistant 메시지는 새 사용자 지시나 더 최신 authority revision보다 높은 권위를 갖지 않는다. goal이 실질적으로 유지되면 context만 제안하고, 범위·완료 조건이 바뀌면 goal replacement와 context를 별도로 제안한다.

### 6.5 Mode별 출력

`canonical_migration`:

- canonical session/thread revision과 normalized items
- source provenance, handoff edge, loss report와 goal artifact
- 이후 native message/goal mutation 또는 native resume 없음

`native_handoff`:

- target native session에 전달할 context only, goal only, both 또는 no-output proposal
- Baton에는 non-authoritative source snapshot, reconciliation artifact, approval/apply receipt만 저장
- apply 뒤 target native session이 새 epoch의 SSOT
- 최신 상태가 다시 필요하면 새 terminal cut을 명시적으로 import

## 7. 승인, 적용과 crash reconciliation

native mutation은 자동 capability가 검증된 경우에도 항상 사용자 승인을 요구한다. approval envelope는 다음을 모두 포함한다.

```text
logical_work_id + authority_epoch
target namespace + native ID
source cut digest
native head revision/digest
current goal digest
capability/version
exact action set
proposal digest
expiry
```

apply 직전에 target을 다시 읽어 envelope와 비교한다. 하나라도 바뀌면 `STALE_APPROVAL`로 중단하고 재분석·재승인을 요구한다. terminal turn을 증명할 capability가 없으면 자동 write를 허용하지 않는다.

control plane은 외부 호출 전에 durable apply intent를 기록하고 성공 receipt를 나중에 기록한다. 외부 side effect 뒤 crash 또는 응답 유실로 결과를 알 수 없으면 `APPLY_UNKNOWN`으로 두고 맹목 재시도하지 않는다. native 표면이 CAS/idempotency를 제공하지 않으면 operation marker 조회 또는 사용자 확인으로 reconcile한다.

```text
PROPOSED -> APPROVED -> APPLYING
                         ├─> APPLIED -> VISIBLE -> RESUMED -> VERIFIED
                         ├─> STALE_APPROVAL
                         └─> APPLY_UNKNOWN -> RECONCILED
```

- `APPLIED`: 지원 표면이 exact action을 수락했다는 신뢰 가능한 결과
- `VISIBLE`: 올바른 native target revision에서 적용 내용이 관찰됨
- `RESUMED`: target native epoch에서 새 실행 event가 시작됨
- `VERIFIED`: 최신 goal/context를 실제 입력으로 사용한 증거가 있음

Desktop을 열거나 task를 선택해야 실행되는 경우 `APPLIED`를 `RESUMED`로 가장하지 않는다. 한 target의 승인·적용 대기가 다른 독립 작업의 분석·검증을 막지 않는다.

### 7.1 수동 package 경로

자동 mutation capability가 없는 client의 기본 상태는 별도로 관리한다.

```text
PACKAGE_EXPORTED -> AWAITING_USER_ACTION -> USER_REPORTED_APPLIED
                                      └─> PACKAGE_STALE
```

- package에는 표시용 target namespace/ID, 관측 head, proposal digest와 사람이 확인할 operation marker를 포함한다.
- marker는 자동 적용, exact acceptance 또는 idempotency의 증거가 아니다.
- Baton이 target을 읽을 수 없으면 `APPLIED`, `VISIBLE`, `VERIFIED`로 승격하지 않는다.
- `USER_REPORTED_APPLIED`는 사용자 attestation이며 machine verification과 별도 필드로 저장한다.
- 사용자가 적용 전에 target/head 변경을 알리거나 Baton이 이를 관측하면 기존 package는 `PACKAGE_STALE`로 폐기하고 재생성한다.
- 중복 전달, 잘못된 target, 부분 복사 또는 확인 불가는 성공으로 간주하지 않는다.

## 8. Canonical import transaction

`POST /baton/v1/sessions/import`의 후속 구현은 `canonical_migration`에서 다음을 원자적으로 만든다.

- 새 canonical session/thread 또는 명시적으로 선택한 기존 thread revision
- authority epoch와 single-writer 상태
- source snapshot별 provenance와 digest
- portable canonical items, handoff edge와 손실 보고
- versioned goal artifact
- import idempotency key와 validation report

같은 source cut 재import는 중복 session/item을 만들지 않는다. 새 source head는 새 cut과 명시적 reconciliation을 요구한다. native source는 변경하지 않는다.

## 9. 실패 정책

- unknown/damaged schema: 해당 source fail-closed
- live source: immutable terminal cut을 만들 수 없으면 snapshot/import 금지
- 동일 작업 후보가 복수: 사용자 선택; 독립 분석은 계속
- goal/context 충돌: apply 금지
- target이 다른 namespace에만 보임: provider/account tag를 재작성하지 않고 올바른 namespace로 안내하거나 canonical mode 선택
- requested route `MISMATCH/UNVERIFIABLE`: 결과 폐기 후 정책 변경·재실행만 허용
- stale target/approval: `STALE_APPROVAL`
- crash 뒤 외부 결과 불명: `APPLY_UNKNOWN`, 자동 retry 금지
- 전환 중 old/target의 out-of-band 변경: `DIVERGED`, 새 cut과 reconciliation 요구
- 수동 package target/head 변경: `PACKAGE_STALE`
- resume 미관측: `APPLIED` 또는 `VISIBLE`에 유지하고 필요한 사용자 action 보고

## 10. 비목표

- native stores 또는 native와 Baton의 실시간·양방향 동기화
- 한 authority epoch의 복수 writer/SSOT
- provider/account/gateway 변경을 session migration으로 가장하는 것
- DB/JSONL/provider tag를 고쳐 목록 필터를 우회하는 것
- hidden reasoning, opaque signature, 승인/UI/process 상태의 provider 간 복제
- Desktop이 제공하지 않는 session 생성·resume·goal API를 안정적 capability로 주장하는 것
- 사용자 승인 없는 native mutation, archive 또는 삭제
- 미확인 모델 결과를 사용자 승인으로 소급 인증하는 것

## 11. 구현 순서

1. authority epoch/transition DB invariant, source snapshot/target identity, SourceReader, capability와 approval envelope 계약을 고정한다.
2. Codex/Claude read-only importer와 hostile fixture를 서로 독립적으로 구현한다.
3. match/reconcile와 trusted route attestation을 구현한다.
4. canonical import transaction/idempotency와 native handoff ledger를 구현한다.
5. approval preview, durable authority transition, manual-package 상태와 stale/unknown/diverged reconciliation을 구현한다.
6. Codex는 수동 package부터 제공하고 지원 표면 conformance 뒤에만 자동 context/goal export를 연다.
7. Claude는 prompt package부터 제공하고 wrapper/sidecar conformance 뒤에만 자동 적용한다.
8. provider adapter가 완성되면 기본 continuation은 canonical mode로 제공한다.

2의 provider별 importer와 fixture는 병렬화할 수 있다. 3은 1에, 4는 1과 3에, 자동 native export는 capability·approval·reconciliation에 실제로 종속된다.

## 12. 수용 기준

1. 정상 상태의 각 epoch에는 writer와 SSOT가 하나뿐이며 두 mode가 동시에 active가 아니다.
2. logical work당 active epoch와 open transition은 각각 최대 하나이며 concurrent transition은 거부된다.
3. transition intent 직후 또는 external apply 직후 crash가 old/new epoch를 동시에 active로 만들지 않는다.
4. `APPLY_UNKNOWN` 동안 마지막 확정 SSOT는 read-only이고 종속 실행은 차단된다.
5. old native source가 out-of-band로 재실행되면 `DIVERGED`를 탐지하고 새 cut을 요구한다.
6. canonical mode에서 import 후 native source를 writer로 취급하지 않는다.
7. native mode에서 target 재개 뒤 Baton이 최신 canonical history라고 주장하지 않는다.
8. native→canonical 재전환은 새 terminal cut과 reconciliation을 요구한다.
9. source snapshot과 mutable target revision이 분리된다.
10. canonical replay는 source 원본 없이 가능하고, native source replay는 암호화 artifact를 보관한 경우에만 주장한다.
11. Codex/Claude 자동 mutation은 versioned capability probe와 live conformance 전 비활성이다.
12. manual package는 사용자 attestation과 machine verification을 구분하고 stale/duplicate/wrong-target/partial-copy를 성공 처리하지 않는다.
13. provider/gateway 전환으로 목록이 비어도 삭제로 오판하거나 DB/provider tag를 변경하지 않는다.
14. SourceReader가 allowlist, path containment, bounds와 unknown-schema fail-closed를 지킨다.
15. prompt injection, symlink escape, 비허용 namespace와 secret 로그/전송을 차단한다.
16. 지정 route의 metadata 누락·변조·model/effort 불일치가 hard fail한다.
17. 동일 source cut 재import가 중복 canonical session/item을 만들지 않는다.
18. approval 뒤 target head/goal/capability가 바뀌면 `STALE_APPROVAL`이다.
19. 외부 적용 직후 crash/응답 유실은 `APPLY_UNKNOWN`이며 맹목 재시도하지 않는다.
20. 사용자 승인 전에는 native goal/message/archive가 바뀌지 않는다.
21. `APPLIED`, `VISIBLE`, `RESUMED`, `VERIFIED`를 독립 검증한다.
22. 한 작업의 질문·실패가 다른 독립 작업을 불필요하게 차단하지 않는다.
23. 모든 native source/output이 없어도 canonical mode의 Baton conversation은 replay된다.
24. native mode의 Baton ledger가 native target보다 높은 대화 권위를 주장하지 않는다.
