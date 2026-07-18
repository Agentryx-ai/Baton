# Baton 구현 정합성 현황

> 기준일: 2026-07-19
> 판정 기준: 제품 계약은 [`COMMON_SESSION_DESIGN.md`](COMMON_SESSION_DESIGN.md), 현재 상태는
> 소스와 테스트를 기준으로 한다. 구현이 설계와 다르다는 이유만으로 설계를 구현에 맞춰
> 축소하지 않는다.

## 판정 의미

| 판정 | 의미 |
|---|---|
| 구현됨 | 설계 계약과 현재 코드·테스트가 일치 |
| 부분 구현 | 단계적 부분집합만 동작하며 나머지는 명시적으로 미구현 |
| 미구현 | 계약은 유지되지만 실행 경로가 없음 |
| 구현 결함 | 현재 사용자 동작이 설계나 실제 capability와 모순됨 |
| 설계 변경 | 구현 근거가 더 타당해 설계 결정을 명시적으로 갱신 |

## 기능별 정합성

| 영역 | 판정 | 현재 증거 | 남은 작업 또는 결정 |
|---|---|---|---|
| Account control plane | 구현됨 | 계정·quota·OAuth·pause/resume/delete UI와 API, 정책 엔진, 관련 테스트 | 없음 |
| 수동 계정 고정 | 설계 변경 | CLIProxy의 `default`는 요청 라우팅 레버가 아님. 현재 UI의 **이 계정만**은 다른 활성 계정을 pause해 실제 단독 풀을 만듦 | `default` 중심의 과거 설명을 사용하지 않음 |
| Smart rotation | **안전 경계 구현·순위 적용 미지원** | enable/start 및 매 tick `fill-first` PUT fail-closed, 전환 직렬화, OFF crash-recovery journal, 60초 provider별 ACTIVE/FRESH/BLIND 관측, 95/100% 자동 pause 제거, 사용자 pause 불변, 전체 유효 풀 유지 | 실제 429/cooling/failover는 CLIProxy 권한. 계산한 리셋 임박 순위를 credential order에 적용할 관리 API는 없음 |
| Smart rotation 순위 표시 | **관측값** | target/reserve는 쿼터 기반 계산 순위이며 UI도 `정책 1순위/2순위`로 실제 전송 대상과 구분 | credential ordering 관리 계약이 생기기 전까지 실제 요청 순위 적용은 미지원 |
| Claude 403 eligibility | **외부 계약 차단** | 현재 accounts/quota API에 durable ineligible/last-403 상태가 없음. 사용량으로 추정하지 않고 수동 pause를 fail-safe로 사용 | CLIProxy가 계정별 durable eligibility 상태/API를 제공해야 자동 제외 가능 |
| Quota freshness 표시 | 부분 구현 | `lastUpdated` 타입과 `useQuota`의 age 계산은 존재 | 현재 `App`의 quota 경로는 해당 hook을 사용하지 않아 설계의 “n초 전 기준” UI가 노출되지 않음 |
| 클라이언트 프록시 통합 | **구현됨·native live 검증 대기** | Claude CLI/Desktop와 Codex CLI/Desktop의 적용·해제·충돌·프로세스·lock 검사, Codex `native-openai`와 격리 `custom-provider` 모드의 결정론적 round-trip 테스트 | 기존 OpenAI task 가시성을 유지하는 `openai_base_url` loopback bridge는 구현됐다. ChatGPT/API-key 인증별 실제 inference 경유와 proxy failure 시 no-direct-fallback은 live smoke 전 자동 배포하지 않으며, 적용/해제 후 대상 클라이언트 완전 재시작이 필요하다. |
| Canonical domain과 SQLite | 구현됨 | session/thread/turn/item/execution/binding 스키마, WAL, transaction, idempotency, fork lineage, 재시작 recovery 테스트 | 없음 |
| Canonical item/content 계약 | 부분 구현 | Preview enum과 자유형 `payload` JSON은 존재 | 설계의 ordered content parts, artifact digest store, command/web/compaction/diagnostic 표현은 아직 없음 |
| Context builder와 compaction | 부분 구현 | fork lineage와 portable text replay는 구현됨 | model context budget, immutable compaction range, artifact-aware materialization은 미구현 |
| Canonical REST/SSE | 구현됨 | session/thread/turn/item과 Goal 생성·수정·상태·삭제, unknown-mutation 명시 reconciliation API, Goal 상태 cursor replay SSE | child execution API는 아직 없음 |
| Codex adapter | V1 구현 | app-server ephemeral thread, Baton dynamic tools, web/MCP/plugin/subagent 차단, ID·timeout·model provenance 검증 | 공식적으로 끌 수 없는 provider-local `update_plan` metadata tool 예외가 있음 |
| Canonical UI | 부분 구현 | 2-column 대화, 상태 표시, transcript, provider/model/effort, Goal panel과 `/goal`, native 폴더 선택, 첫 전송 전 browser draft와 원자 first-turn API | fork와 instruction 선택 UI는 아직 없음. 폴더 file-tool live E2E 대기 |
| UI provider 선택 | 구현됨 | 서버 모델 catalog를 provider별로 조회하고 모델이 0개인 provider는 비활성화 | Gemini 인증 복구 후 live catalog 표시 검증 필요 |
| Provider 전환 | 부분 구현 | Codex·Claude·Gemini adapter가 같은 portable history 계약을 사용; Claude Fable 5 live 검증 완료 | Gemini는 현재 proxy 인증 문제로 모델 0개이며 live 실행 미검증 |
| Claude adapter | **V1 구현** | `/v1/messages` stateless history, Baton tool loop, effort, round별 reported model/fallback, structured provider-private continuation durability, bounded retry/timeout, Fable 5 live 응답 | streaming은 아직 미구현 |
| Gemini adapter | **V1 구현·live 차단** | `/v1/chat/completions` 호환 history/tool loop, reasoning effort, round provenance와 structured provider-private continuation durability, bounded retry/timeout | 현재 인증 버그로 live catalog/turn 검증 불가; 인증 복구 전 UI 비활성화 유지 |
| 일반 tool 실행 | 부분 구현 | provider-neutral broker가 call 선기록, read 병렬·mutation 직렬화, result 후속 기록을 강제하며 read/list/search/write/replace와 Goal tools를 제공 | 이 Windows 환경은 cwd 밖 read 제한에 elevated backend가 필요해 `run_command`를 fail-closed로 미노출. approval/user-input wait도 미구현 |
| Persistent Goal runtime | V1 구현 | Goal projection/event, CAS, 30초 lease/10초 heartbeat, 24턴·2시간·3회 no-progress, 자동 continuation, pause/resume/edit/clear, `/goal` UI | Gemini live 검증은 인증 복구 전까지 차단 |
| Provider opaque state | 부분 구현 | binding 스키마와 invalidation은 구현됨 | at-rest encryption이 없어 non-null opaque state 저장을 fail-closed로 거부함 |
| Provider binding freshness | 설계 변경 | 구현은 `last_turn_id` 대신 `synced_revision`과 `context_digest`로 exact context compatibility를 판정 | 공통 설계 문서의 binding 필드를 이 결정에 맞춰 갱신 |
| Baton-managed child execution | 부분 구현·비활성 | execution 기록과 `delegationMode: disabled`, native child capability 검증이 있음 | child API, scheduler/executor, budget/depth/join/cancel 구현 필요 |
| Native session bridge/import | **fork-copy import 구현·authority migration 미구현** | Codex Desktop과 Claude Desktop/Code의 local task를 alias·project·provider provenance와 함께 read-only preview하고, 명시 승인 뒤 별도 Baton logical-work fork로 멱등 import함. project grouping, source-scoped dedupe, delta CAS/fork guard, CSRF·realpath 보호, durable receipt와 대규모 metadata-only scan이 구현됨. one-shot package도 유지 | native 원본과 Baton 사이의 SSOT 전환·동기화·`/goal` mutation은 하지 않음. 같은 logical work를 승계하는 authority epoch workflow는 [`NATIVE_SESSION_CONTINUITY_BRIDGE.md`](NATIVE_SESSION_CONTINUITY_BRIDGE.md)의 후속 범위이며 bulk import 계약은 [`NATIVE_SESSION_IMPORT_AND_GROUPING.md`](NATIVE_SESSION_IMPORT_AND_GROUPING.md)에 있음 |
| Live Codex 검증 | 검증 공백 | 단위·통합 테스트와 `smoke:codex-adapter` handshake는 존재 | 실제 model turn → BFF 재시작 → Baton history 재개 E2E를 추가해야 Phase 1 exit를 완전히 충족 |

## 현재 구현된 canonical API

```text
POST   /baton/v1/sessions
GET    /baton/v1/sessions
GET    /baton/v1/native-import/csrf
POST   /baton/v1/native-import/preview
POST   /baton/v1/native-import/commit
GET    /baton/v1/sessions/:sessionId
GET    /baton/v1/threads/:threadId
POST   /baton/v1/threads/:threadId/fork
POST   /baton/v1/threads/:threadId/turns
GET    /baton/v1/threads/:threadId/goal
POST   /baton/v1/threads/:threadId/goal
PATCH  /baton/v1/goals/:goalId
POST   /baton/v1/goals/:goalId/status
DELETE /baton/v1/goals/:goalId?expectedRevision=<revision>
GET    /baton/v1/threads/:threadId/items?after=<cursor>
GET    /baton/v1/threads/:threadId/events?after=<cursor>   (SSE)
POST   /baton/v1/turns/:turnId/cancel
```

다음 계약은 설계에는 있지만 아직 구현되지 않았습니다.

```text
POST   /baton/v1/executions/:executionId/children
GET    /baton/v1/executions/:executionId/children
POST   /baton/v1/executions/:executionId/cancel
```

## 문서 운영 원칙

1. README의 `Current status`는 이 문서의 판정을 요약한다.
2. 설계 목표를 낮추는 변경은 구현 편의만으로 하지 않고 별도 결정 근거를 남긴다.
3. 구현 결함은 `Known limitations`로만 정상화하지 않는다. 사용자에게 현재 위험을 알리되
   해결 대상임을 명시한다.
4. 새 기능은 코드, 테스트, 이 현황표, README 요약을 한 변경에서 갱신한다.
