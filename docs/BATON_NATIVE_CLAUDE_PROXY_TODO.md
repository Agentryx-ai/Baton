# Baton Native Claude Proxy 작업 목록

> 상태: 작업 1 단일계정 구현 완료·2계정 live gate 대기 / 작업 2 구현 검증 중
> 최종 갱신: 2026-07-20 (Asia/Seoul)
> 상세 명세: [`BATON_NATIVE_CLAUDE_PROXY_ROADMAP.md`](./BATON_NATIVE_CLAUDE_PROXY_ROADMAP.md)
> 완료 표기 규칙: 구현뿐 아니라 테스트, rollback 검증, 사용자 gate까지 통과해야 `[x]`로 바꾼다.

## 현재 위치

- 현재 작업: **작업 2 / Phase 4~6 범용 자동전환 구현 검증 + 다중 계정 live gate 준비**
- 현재 runtime: Claude CLI/Desktop은 Baton Native, Codex는 기존 custom-provider 경로
- Baton Native Claude Proxy: loopback endpoint 구현·실제 CLI canary·전역 설정 적용 완료
- 지금 필요한 사용자 결정: 실제 2계정 canary용 두 번째 Claude 계정 OAuth 승인 및 자동전환 live canary의 소량 사용 승인

## 재검수 후 우선순위

실제 검증이 끝난 항목은 아래 미해결 목록에서 제외한다.

### P0 — 정확성·보안

- [ ] Claude actual 429의 모델 한도·계정 한도 판정 보강
- [ ] quota preflight 실패 시 기존 cooldown을 보존
- [ ] Codex upstream fetch에 retry deadline signal 연결
- [ ] fallback 실패 시 active override 해제·다음 후보 선택
- [ ] `fallbackModels[]`를 순서대로 모두 시도
- [ ] malformed/expired Codex OAuth JWT 저장 차단
- [ ] Claude/Codex account·OAuth mutation API 인증 및 CSRF 방어

### P1 — 재시작·가용성

- [ ] Codex 모델 catalog를 last-known-good로 영속화
- [ ] authoritative server fallback capability를 재시작 후에도 보존
- [ ] native vault 다중 프로세스 lock/CAS 구현
- [ ] quota 소진과 transport failure를 health 지표에서 분리
- [ ] 불명확한 적용 모드에서 Native account backend를 추정하지 않고 fail-closed
- [ ] fallback state 파일 크기·모델 문자열·event ID 중복 검증 강화

### P2 — 자동전환·경고 UX

- [ ] 동일 모델 재소진 시 opt-in prompt 재표시
- [ ] `[자동전환 끄기]`와 `[다시 보지 않기]` 상태 분리
- [ ] Settings fallback polling에 latest-request fencing 적용
- [ ] 적용 중인 Codex CLIProxy에도 failover·stale-plan·relogin 제한 경고 유지
- [ ] keyboard·screen reader·중복 announcement 검수

### P3 — 운영 gate

- [ ] token delta 미관측을 health 정상으로 판정하지 않도록 coverage gate 추가
- [ ] 24시간 health 표본 영속화
- [ ] health 임계치 초과 시 자동 rollback 구현·검증

### P4 — 외부 조건이 필요한 live gate

- [ ] Claude 실제 2계정 same-request failover
- [ ] Codex 실제 OAuth·모델 catalog·2계정 usage-limit failover
- [ ] 실제 free→pro 재로그인 없는 `gpt-5.6-sol` 200
- [ ] Claude/Codex CLI·Desktop 전환·rollback 및 기존 session/history 보존
- [ ] 24시간 canary와 clean install·upgrade·reinstall 검수

### 방금 완료한 긴급 canary

- [x] Fable 5 소진 → Opus 4.8 자동전환 → Claude CLI `Hi` 정상 응답
  - 자동전환은 검수 직후 OFF로 복원, active override 0개 확인
  - runtime event: `activated` 후 `disabled`, 실제 성공 계정 별칭 `Claude Code`

## 작업 1 — Baton Native Claude Proxy Core

목표: CLIProxy 코드나 프로세스를 사용하지 않고 Baton이 Claude API 전송, OAuth 계정, account
failover를 직접 소유한다.

### Phase 0 — API 계약과 golden fixture

- [x] `/v1/messages`, `/v1/messages/count_tokens`, `/v1/models` 계약 목록 확정
- [x] 정상 SSE fixture 작성
- [x] 정상 non-stream JSON fixture 작성
- [x] generic 429와 Fable 모델 한도 fixture 작성
- [x] 401/403/5xx fixture 작성
- [x] 구조화된 refusal fixture 작성
- [x] 구조화된 fallback event fixture 작성
- [x] fixture에 token/refresh token이 포함되지 않는 credential test 구현
- [x] fake upstream contract test 구현
- [x] native Claude CLI 비교 smoke 실행
- [x] Gate 0: fixture·보안 검증 결과 확인

사용자 작업:

- [x] Phase 0/1 착수 승인
- [x] 소량의 실제 Claude 요청 사용 승인

### Phase 1 — Native transport core

- [x] Baton 소유 Claude proxy/credential/quota module 경계 확정
- [x] 명시적 proxy 선택 전에는 클라이언트에 적용되지 않는 loopback 경로 구현
- [x] 세 Anthropic-compatible endpoint 구현
- [x] 요청 body와 API/beta header 전달 및 OAuth capability header 병합
- [x] JSON 응답의 status/body/안전 header 보존
- [x] SSE 순서, backpressure, disconnect, cancellation 구현
- [x] loopback bind, timeout, body 크기 제한 구현
- [x] authorization과 본문을 기록하지 않는 오류 diagnostics 구현
- [x] fake upstream의 SSE/429 contract test 통과
- [x] 단일 계정 live canary 통과 — Opus 4.8 정상 응답 및 Fable 5 구체적 한도 오류
- [x] Native/CLIProxy별 Claude CLI/Desktop 설정 apply·inspect·remove round-trip 단위 검증
- [ ] 기존 CLIProxy 경로 rollback 검증
- [ ] Gate 1: transport 완료 승인

사용자 작업:

- [x] 단일 계정 live canary의 소량 사용 승인

### Phase 2 — OAuth vault와 token lifecycle

- [x] 지원되는 Claude OAuth flow 계약 확정
- [x] state/PKCE/replay 방지 구현
- [x] OS 보안 저장소 기반 vault 구현 — Windows DPAPI(CurrentUser), atomic versioned file
- [x] token refresh single-flight와 expiry 관리 구현
- [x] 계정 추가, 비활성화, 재개, 삭제 구현
- [x] token redaction 및 vault-at-rest test 통과
- [x] 취소·만료·replay·재시작 및 vault refresh test 통과
- [ ] 기존 credential 경로 rollback 검증
- [ ] Gate 2: OAuth 보안 검토 승인

사용자 작업:

- [ ] canary Claude 계정 지정
- [ ] OAuth 창에서 직접 로그인·동의
- [ ] 계정 별칭과 삭제/재인증 UX 확인

### Phase 3 — 계정 router와 same-request failover

- [x] 계정 우선순위와 적격성 model 구현
- [x] auth failure, 모델 quota, 일반 429, 5xx·network retry matrix 확정
- [x] account/model별 cooldown과 reset hint 구현
- [x] replay 가능성 판정, retry budget, 전체 deadline 구현
- [x] stream 시작 후 숨은 재시도 금지
- [x] 모든 후보 실패 시 가장 구체적인 원본 오류 보존
- [x] 다중 계정·fake clock·deadline·응답 cleanup test 통과
- [ ] 실제 2계정 canary 통과
- [ ] 단일 계정/CLIProxy rollback 검증
- [ ] Gate 3: 계정 failover 완료 승인

사용자 작업:

- [x] Native 우선계정 지정 API/UI 구현 (실제 2계정 선택 UX 확인은 live gate에서 수행)
- [ ] 2계정 failover canary의 실제 요청 승인

### 작업 1 완료 조건

- [x] Claude 정상 요청이 Baton Native Proxy만으로 성공 — Opus 4.8 live canary
- [ ] 한 계정의 Fable 한도 소진 시 다른 계정의 같은 모델로 성공
- [x] CLIProxy library/source/process를 native core가 호출하지 않음 — native core 정적 의존 검색 0건
- [x] 오류와 SSE가 generic 응답으로 열화되지 않음 — byte-preserving SSE/error contract 및 live Fable 오류 확인
- [ ] 작업 1 완료 결과와 rollback 증거 기록

## 작업 1-C — Codex Native Proxy 확장

목표: `issues/codex-native-proxy-must-failover-and-preserve-model-availability.md`의 수용 기준을
CLIProxy 없이 충족하고, Claude와 같은 vault/router 불변조건을 Codex에도 적용한다.

- [x] 설치된 Codex 원본 소스에서 OAuth authorize/refresh/PKCE 계약 확인
- [x] DPAPI(CurrentUser) provider-neutral vault와 revision CAS 구현
- [x] Codex OAuth 로그인, 만료 전/강제 refresh, refresh single-flight 구현
- [x] plan을 파일명이 아닌 live ID-token claim에서 파생
- [x] access token별 `/backend-api/codex/models` capability 카탈로그 구현
- [x] free→pro refresh 후 `gpt-5.6-sol` 노출 가상 회귀표 test 통과
- [x] 계정 API 강제 refresh → catalog 갱신 → `gpt-5.6-sol` 200 서빙 통합 회귀 test 통과
- [x] `/responses`, `/responses/compact`, `/models` Baton Native data plane 구현
- [x] 요청 모델을 지원하는 계정만 후보로 삼는 모델-aware router 구현
- [x] 실제 429 fixture의 same-request account failover·cooldown·reset 복귀 test 통과
- [x] 지원 계정 부재 시 명확한 `model_unsupported` 오류 구현
- [x] Native/CLIProxy 계정 API 자동 선택 및 CLIProxy 제한 경고 UI 구현
- [x] 수동 `엔트리먼트 새로고침` API/UI 구현
- [x] Codex `native-openai` 설정 적용 시 CLIProxy 연결을 요구하지 않도록 분리
- [ ] 실제 Codex OAuth 계정 1개 로그인 및 모델 catalog canary
- [ ] 실제 2계정 usage-limit same-request failover canary
- [ ] 실제 free→pro 계정에서 재로그인 없는 강제 refresh·`gpt-5.6-sol` 200 canary
- [ ] Codex CLI/Desktop native-openai 전환·rollback 및 기존 세션 보존 검증

사용자 작업:

- [ ] Codex Native canary 계정으로 OAuth 로그인·동의
- [ ] 실제 entitlement refresh와 소량 inference 사용 승인
- [ ] Codex CLI/Desktop 완전 종료 후 native-openai 전환 UX 확인

## 작업 2 — 범용 모델 자동전환

목표: 특정 모델명에 종속되지 않고 서버 capability에 따라 fallback하고 원 모델로 자동 복귀한다.

### Phase 4 — 구조화된 safety refusal fallback

- [x] `FallbackCapability` 정규화 schema와 resolver 구현
- [x] `/v1/models`의 `allowed_fallback_models` 우선 적용
- [x] `stop_reason`, `stop_details.category` 구조화 판정
- [x] `model_refusal_fallback`의 retry/revert/sticky 구조화 event 판정·보존
- [x] server-side fallback과 Baton fallback 중복 방지 — safety는 provider에 1회 위임
- [x] fallback event 추적 구현 (credit token은 provider payload 무변형 전달)
- [x] 알 수 없는 category의 fail-closed 동작 검증
- [x] 합성 fixture 기반 상태 전이 test 통과
- [ ] Gate 4: safety fallback 완료 승인

사용자 작업:

- [ ] safety fallback 알림 공개 수준 확인

### Phase 5 — 범용 quota fallback과 자동 복귀

- [x] 기본 OFF인 자동 모델전환 설정 구현
- [ ] 임의의 `sourceModel -> fallbackModels[]` 범용 상태 머신 완료 — 첫 후보 실패 시 다음 후보·override 정리 보완 필요
- [x] server capability → 사용자 mapping → compatibility seed 순서 구현
- [x] Fable 5 → Opus 4.8 compatibility seed 추가
- [x] 모든 계정의 원 모델 소진 후에만 fallback하도록 보장
- [x] preferred model과 effective model 분리
- [x] reset hint, 60초 bounded probe 기반 복귀 구현
- [ ] 조기 quota reset과 stale usage 처리 — preflight 실패 시 기존 cooldown 보존 필요
- [x] 자동전환 OFF 시 원 모델 즉시 재시도
- [x] 여러 합성 모델 조합의 model-generic test 통과
- [x] opt-in/out 및 fallback 비용 0 guard test 통과
- [x] 제한된 실제 Fable 5 → Opus 4.8 전환 canary 통과
- [ ] Fable 5 reset 후 자동 복귀 canary 통과
- [ ] Gate 5: 비용·전환·복귀 정책 승인

사용자 작업:

- [ ] 자동전환 기본값 승인 — 권장: OFF
- [ ] fallback 모델 및 비용 경고 확인
- [ ] 실제 전환·복귀 canary의 소량 사용 승인

### Phase 6 — UI banner와 canonical event

- [x] 전체 소진 시 자동전환 opt-in prompt 구현
- [x] “다시 보지 않기” 설정 구현
- [x] 동적 `<원 모델> → <fallback 모델>` 활성 banner 구현
- [x] `[자동전환 끄기]` 및 원 모델 재시도 구현
- [x] preferred/effective model과 실제 성공 계정 별칭 표시
- [x] 전환·복귀·실패 runtime event schema/persistence 구현
- [x] 복귀 후 활성 banner 제거와 과거 event 보존
- [x] refresh/restart/reconnect 상태 일관성 test 통과
- [ ] race, keyboard, screen reader test 통과
- [ ] Gate 6: UX와 event privacy 승인

사용자 작업:

- [ ] prompt, banner, 버튼 문구와 위치 확인
- [ ] 전환·복귀 timeline UX 확인

### 작업 2 완료 조건

- [ ] 일부 계정만 소진되면 모델보다 계정을 먼저 전환
- [ ] 전 계정 원 모델 소진 및 opt-in일 때만 fallback
- [ ] 서버가 새 모델 조합을 제공해도 별도 구현 없이 동작
- [ ] 원 모델 회복 시 자동 복귀
- [ ] 모든 자동 동작의 이유와 현재 상태를 UI에서 확인 가능
- [ ] 작업 2 완료 결과와 rollback 증거 기록

## 작업 3 — Claude CLI/Desktop 전환과 CLIProxy 제거

목표: Baton Native Claude Proxy를 실제 Claude 클라이언트의 기본 경로로 만들고 Claude 경로의 CLIProxy
의존을 제거한다.

### Phase 7 — shadow/canary migration

- [ ] Claude 설정 source와 Baton 소유 설정 범위 확정
- [ ] 원자적 backup, marker patch, restore 구현
- [ ] CLI 비대화형 smoke 통과
- [ ] CLI interactive smoke 통과
- [ ] Desktop canary 통과
- [ ] 기존 native session/history 보존 확인
- [ ] generic 429 열화가 없는지 확인
- [x] error rate, first-token latency, SSE failure 24h health gate 구현 — `/baton/health.nativeProxy`
- [ ] 임계치 초과 시 자동 rollback 검증
- [ ] Claude 버전 업데이트 compatibility smoke 구현
- [ ] 24시간 canary 안정성 관찰
- [ ] Gate 7: 실사용 전환 승인

사용자 작업:

- [ ] 설정 backup 위치 확인
- [ ] 안내 시 Claude CLI/Desktop 완전 종료·재시작
- [ ] CLI interactive에서 정상·소진·자동전환 OFF 확인
- [ ] Desktop에서 기존 대화와 전환 UX 확인

### Phase 8 — Claude 경로의 CLIProxy 제거

- [ ] Claude 관련 CLIProxy 호출·설정·dependency 전체 목록 작성
- [ ] 정적 검색과 runtime 관측으로 잔여 의존 확인
- [ ] legacy credential/config migration 완료
- [ ] Claude 관련 CLIProxy 코드와 설정 제거
- [ ] clean install test 통과
- [ ] 기존 설치 upgrade test 통과
- [ ] uninstall/reinstall와 downgrade-safe rollback 검증
- [ ] 운영·업데이트·복구 runbook 작성
- [ ] rollback package와 보존 기간 확정
- [ ] Gate 8: 최종 제거 승인

사용자 작업:

- [ ] 최종 Baton Native 경로 cutover 승인
- [ ] CLIProxy rollback package 보존 기간 승인
- [ ] Claude 경로의 CLIProxy 제거 승인

### 작업 3 완료 조건

- [ ] Claude 요청에 CLIProxy process/port/config 불필요
- [ ] Claude CLI/Desktop의 기존 세션과 정상 UX 유지
- [ ] clean install과 upgrade 모두 Baton Native 경로 사용
- [ ] 최종 아키텍처·운영·rollback 문서 최신화
- [ ] 작업 3 완료 및 전체 roadmap 종료 선언

## 완료 증거 기록

각 gate 완료 시 아래 표에 테스트 명령, 결과, 날짜, 관련 변경을 기록한다.

| Gate | 상태 | 검증 결과 | 날짜 | 관련 변경 |
|---|---|---|---|---|
| 0 | 통과 | JSON/SSE/401/403/429/500/refusal/fake-upstream 및 credential redaction test 통과 | 2026-07-20 | `server/claude-native-*.ts` |
| 1 | 진행 중 | `/v1/models` 200·10개, Opus 4.8 `Hi` 성공, Fable 5 오류 구체화, SSE deadline/disconnect 및 Native/CLIProxy 설정 round-trip test 통과, Claude CLI/Desktop Native 적용 확인 | 2026-07-20 | `server/claude-native-proxy.ts`, `server/client-integration.ts` |
| 2 | 진행 중 | Claude OAuth PKCE, DPAPI vault, 계정 CRUD, vault-backed single-flight refresh test 통과; 실제 로그인 UX gate 대기 | 2026-07-20 | `server/claude-native-account-*.ts`, `server/claude-native-oauth.ts` |
| 3 | 진행 중 | 우선순위·cooldown·deadline·모델 quota/generic 429/5xx router 및 다중 계정 fixture 통과; 실제 2계정 gate 대기 | 2026-07-20 | `server/native-account-router.ts`, `server/claude-native-proxy.ts` |
| C | 진행 중 | Codex OAuth/live claim/catalog/native responses/429 failover 및 free→pro 가상 수용표 통과; 실제 OAuth canary 대기 | 2026-07-20 | `server/codex-native-*.ts` |
| 4 | 구현 완료·승인 대기 | 구조화 refusal/fallback parser, provider 1회 위임, SSE byte-preserving event 관측 test 통과 | 2026-07-20 | `server/model-fallback.ts`, `server/claude-native-proxy.ts` |
| 5 | 합성 검증 완료·live 대기 | 기본 OFF, 전 계정 소진, 비용 0 guard, generic mapping, 60초 probe·복귀·재시작 test 통과 | 2026-07-20 | `server/model-fallback*.ts`, `server/claude-native-proxy.test.ts` |
| 6 | 구현 완료·접근성 검수 대기 | 상단 opt-in prompt, 다시 보지 않기, 활성 banner, 끄기, 모델/계정 별칭, event persistence 구현 | 2026-07-20 | `src/components/ModelFallbackNotice.tsx`, `src/components/SettingsSection.tsx` |
| 7 | 대기 | — | — | — |
| 8 | 대기 | — | — | — |

## 2026-07-20 완료 감사

| 요구사항 | 현재 증거 | 판정 |
|---|---|---|
| CLIProxy 없이 Claude 정상 전송 | Native `/v1/models` 200·10개, Opus 4.8 CLI canary 성공 | 단일 계정 완료 |
| SSE/JSON/status/header 무손실 전달 | fake upstream, byte-order, deadline, disconnect test 통과 | 완료 |
| Fable 모델 한도와 일반 429 구분 | 실제 usage preflight가 모델별 429·unified reset/claim 반환, Claude CLI가 Fable 5 문구 표시 | 완료 |
| Native/CLIProxy 선택 및 문제 경고 | 설정 UI mode 선택, CLIProxy generic 429/재시도 경고, 설정 round-trip test | 완료 |
| 기존 Claude CLI/Desktop 설정 적용 | runtime status에서 두 대상 모두 `applied/native` | 완료 |
| OAuth token refresh | atomic 저장 및 single-flight unit test | 현재 Claude CLI 단일 계정만 완료 |
| Baton 소유 다중 계정 vault | Claude 전용 vault+OAuth control plane 및 Codex provider-neutral DPAPI vault+OAuth API, at-rest/재시작 test | 구현 완료 · 실제 로그인 UX gate 대기 |
| 모델 한도 시 같은 모델로 계정 failover | Claude 모델 quota/generic 429 다중 계정 fixture와 Codex actual-429 fixture에서 same-request 성공 | 합성 검증 완료 · 실제 2계정 gate 대기 |
| Codex 재로그인 없는 plan/model 반영 | live ID-token claim, 강제 refresh, access-token catalog 재조회로 free→pro 표 재현 | 합성 검증 완료 · 실제 계정 canary 대기 |
| 범용 모델 fallback과 자동 복귀 | server→user→compat resolver, 기본 OFF 상태 머신, 전 계정 소진 guard, 60초 probe/복귀, 상단 prompt/banner와 재시작 persistence test | 구현·합성 검증 완료 · 실제 비용 canary/접근성 gate 대기 |
| Claude 경로의 CLIProxy 완전 제거 | Claude Native data/control plane은 CLIProxy 없이 동작; CLIProxy 선택지는 명시적 rollback으로 보존 | 제거 gate·장기 canary 대기 — Phase 7~8 |

전체 `npm test` 512개, typecheck, lint, production build와 `git diff --check`가 통과했다. Claude 2.1.215
live Fable 요청도 비용 0으로 구체적 모델 한도 429를 유지했다. 실제 두 번째 Claude 계정, 유료 fallback
canary, 장기 client canary가 남아 전체 목표는 아직 완료로 선언하지 않는다.
