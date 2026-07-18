# Baton 구현 정합성 현황

> 기준일: 2026-07-18
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
| Smart rotation | **부분 구현·의미 불일치** | 60초 provider별 틱, ACTIVE/FRESH/BLIND/EXHAUSTED 분류, target/reserve, debounce, 엔진 장부 복원 | target과 reserve가 모두 활성이라 `round-robin`에서는 순환됨. “리셋 임박 우선 소진”을 실제 요청 라우팅에서 보장하지 못함 |
| Smart rotation 타깃 표시 | **구현 결함** | UI와 로그가 계산상 1순위를 `현재 타깃`으로 표시 | 실제 트래픽 타깃으로 오해되지 않도록 `정책 1순위` 등으로 표시하거나, 프록시가 우선순위를 강제하도록 구현해야 함 |
| Quota freshness 표시 | 부분 구현 | `lastUpdated` 타입과 `useQuota`의 age 계산은 존재 | 현재 `App`의 quota 경로는 해당 hook을 사용하지 않아 설계의 “n초 전 기준” UI가 노출되지 않음 |
| 클라이언트 프록시 통합 | **부분 구현·Codex SSOT 결함** | Claude CLI/Desktop와 Codex CLI/Desktop의 적용·해제·충돌·프로세스·lock 검사 테스트 | Codex에 `model_provider=baton`을 설치하면 기존 `openai` task가 provider-filtered Desktop 목록에서 숨겨진다. [`CODEX_NATIVE_PROXY_SSOT_DECISION.md`](CODEX_NATIVE_PROXY_SSOT_DECISION.md)의 `openai_base_url` + loopback bridge 제안을 구현하고 인증 호환성·no-fallback을 live 검증해야 하며 적용/해제 후 대상 클라이언트 완전 재시작이 필요하다. |
| Canonical domain과 SQLite | 구현됨 | session/thread/turn/item/execution/binding 스키마, WAL, transaction, idempotency, fork lineage, 재시작 recovery 테스트 | 없음 |
| Canonical item/content 계약 | 부분 구현 | Preview enum과 자유형 `payload` JSON은 존재 | 설계의 ordered content parts, artifact digest store, command/web/compaction/diagnostic 표현은 아직 없음 |
| Context builder와 compaction | 부분 구현 | fork lineage와 portable text replay는 구현됨 | model context budget, immutable compaction range, artifact-aware materialization은 미구현 |
| Canonical REST/SSE | 구현됨 | `/baton/v1` session 조회·생성, thread snapshot/fork, turn 시작·취소, item cursor, SSE replay | child execution/import API는 아직 없음 |
| Codex adapter | 부분 구현 | app-server handshake, ephemeral `thread/start`, `thread/inject_items`, `turn/start`, interrupt, durable text/plan/reasoning/usage/error 정규화 | 현재 text 중심 Preview. 일반 tool/file-change 실행 계약은 아직 충족하지 않음 |
| Canonical UI | 부분 구현 | 세션 생성·선택, transcript, SSE 상태, model 입력, 턴 실행·취소가 `App`에 마운트됨 | fork UI, cwd/project/instruction 설정, capability 기반 provider 선택 필요 |
| UI provider 선택 | **구현 결함** | UI는 Claude/Codex/Gemini를 모두 선택 가능하게 표시하지만 runtime에는 Codex adapter만 등록됨 | capability를 서버에서 조회해 미지원 provider를 숨기거나 비활성화해야 함 |
| Provider 전환 | 미구현 | 공통 enum·domain 계약만 존재 | Claude와 Gemini adapter 구현 후 portable history 전환 E2E 필요 |
| 일반 tool 실행 | 부분 구현 | item/domain 계약은 있으나 현재 turn policy는 `allowedTools: []`; Codex adapter는 shell, MCP, plugin과 approval/tool 요청을 차단 | Baton 소유 tool 실행과 approval 정책을 설계대로 구현하기 전까지 text-only 제약 유지 |
| Provider opaque state | 부분 구현 | binding 스키마와 invalidation은 구현됨 | at-rest encryption이 없어 non-null opaque state 저장을 fail-closed로 거부함 |
| Provider binding freshness | 설계 변경 | 구현은 `last_turn_id` 대신 `synced_revision`과 `context_digest`로 exact context compatibility를 판정 | 공통 설계 문서의 binding 필드를 이 결정에 맞춰 갱신 |
| Baton-managed child execution | 부분 구현·비활성 | execution 기록과 `delegationMode: disabled`, native child capability 검증이 있음 | child API, scheduler/executor, budget/depth/join/cancel 구현 필요 |
| Native session bridge/import | 부분 구현·실험 도구 | [`../tools/native-session-handoff/`](../tools/native-session-handoff/)에 read-only inventory, `gpt-5.6-sol/high` project-group 분석, 승인 기반 Codex/Claude CLI context-ingest와 fixture/live-analysis self-test가 있음 | one-shot operator package일 뿐 canonical import API·authority epoch store·versioned importer는 미구현. [`NATIVE_SESSION_CONTINUITY_BRIDGE.md`](NATIVE_SESSION_CONTINUITY_BRIDGE.md)의 전체 migration/recovery 경계를 계속 구현해야 함 |
| Live Codex 검증 | 검증 공백 | 단위·통합 테스트와 `smoke:codex-adapter` handshake는 존재 | 실제 model turn → BFF 재시작 → Baton history 재개 E2E를 추가해야 Phase 1 exit를 완전히 충족 |

## 현재 구현된 canonical API

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

다음 계약은 설계에는 있지만 아직 구현되지 않았습니다.

```text
POST   /baton/v1/executions/:executionId/children
GET    /baton/v1/executions/:executionId/children
POST   /baton/v1/executions/:executionId/cancel
POST   /baton/v1/sessions/import
```

## 문서 운영 원칙

1. README의 `Current status`는 이 문서의 판정을 요약한다.
2. 설계 목표를 낮추는 변경은 구현 편의만으로 하지 않고 별도 결정 근거를 남긴다.
3. 구현 결함은 `Known limitations`로만 정상화하지 않는다. 사용자에게 현재 위험을 알리되
   해결 대상임을 명시한다.
4. 새 기능은 코드, 테스트, 이 현황표, README 요약을 한 변경에서 갱신한다.
