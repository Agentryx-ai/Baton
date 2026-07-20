# Baton Native Claude Proxy 전환 로드맵

> 상태: 구현 진행 중 기준 문서(SSOT)
> 작성일: 2026-07-20 (Asia/Seoul)
> 대상: Claude Code CLI/Desktop의 전송, 계정 전환, 모델 fallback을 Baton이 직접 소유하는 기능
> 원칙: 단계별 승인과 검증이 끝나기 전에는 다음 단계로 넘어가지 않는다.
> 실행 현황: [`BATON_NATIVE_CLAUDE_PROXY_TODO.md`](./BATON_NATIVE_CLAUDE_PROXY_TODO.md)

## 1. 결론과 사용자가 할 일

Baton은 CLIProxy를 참고 구현으로만 활용하고 런타임 코어에는 의존하지 않는 자체 Claude 프록시를 만든다.
기존 CLIProxy 경로는 새 경로가 검증될 때까지만 rollback 수단으로 유지하며, 마지막 단계에서 제거한다.

사용자에게 필요한 일은 구현이 아니라 아래의 승인·로그인·실사용 확인뿐이다.

| 순서 | 사용자 작업 | 필요한 시점 | 예상 소요 |
|---|---|---|---|
| 1 | 이 문서의 범위와 Phase 1 착수 승인 | 지금 | 5분 |
| 2 | 테스트가 허용된 Claude 계정 1개와 소량의 실제 사용량 소비 승인 | Phase 2 | 5분 |
| 3 | OAuth 로그인/동의 창에서 직접 인증 | Phase 2 | 계정당 1~2분 |
| 4 | 계정 우선순위와 canary 계정 지정 | Phase 3 | 5분 |
| 5 | 자동 모델 전환의 기본값, fallback 모델, 알림 방식을 승인 | Phase 5 | 5분 |
| 6 | Claude CLI/Desktop을 완전히 종료하고 재시작한 뒤 UX 확인 | Phase 7 | 10분 |
| 7 | CLIProxy 제거 또는 rollback 여부 최종 승인 | Phase 8 | 5분 |

나머지 코드 작성, 테스트, 로그 수집, 설정 백업, 문서 갱신은 Baton/Codex가 수행한다.

## 2. 배경과 확인된 문제

Claude Code 2.1.215를 Baton 프록시 없이 실행하면 Fable 5 한도 소진을 다음처럼 빠르고 구체적으로
알린다.

```text
You've reached your Fable 5 limit. Run /usage-credits to continue or switch models with /model.
```

동일 상황에서 현재 Baton/CLIProxy 경로는 장시간 재시도 후 일반적인 429만 노출했다.

```text
This request would exceed your account's rate limit. Please try again later.
```

즉, 계정 전체 한도가 충분한 것과 특정 모델(Fable 5)의 별도 한도는 동시에 참일 수 있으며, 현재 경로는
그 차이를 보존하지 못한다. 사용자는 어느 계정 또는 어느 모델이 막혔는지 알 수 없고, 자동 계정 전환과
모델 전환도 통제할 수 없다.

설치된 Claude CLI/Desktop artifact를 읽기 전용으로 확인한 결과, 현재 Claude 프로토콜은 다음 구조를
지원한다.

- 모델 카탈로그의 `allowed_fallback_models`
- `fallbacks: [{ model: ... }]` 요청과 `server-side-fallback-2026-06-01` beta
- `stop_reason: "refusal"` 및 구조화된 `stop_details.category`
- `model_refusal_fallback` 이벤트의 `retry`, `revert`, `sticky` 방향
- Fable 5의 현재 호환 fallback으로 Opus 4.8

따라서 Baton은 오류 문자열 정규식이 아니라 HTTP/API의 구조화된 신호를 보존하고 해석해야 한다.

## 3. 이 문서가 대체하는 결정

`docs/DESIGN.md` ADR-3의 “Baton 커스텀 프록시 기각, CLIProxy에 429/cooling/failover 위임”은 초기
제품 범위에서 내린 역사적 결정이다. 사용자가 외부 프록시 코어에 종속되지 않는 방향을 확정했으므로,
Claude 요청 경로에 한해 이 문서가 그 결정을 대체한다.

- 과거 ADR은 결정 이력으로 보존한다.
- 새 코드가 완성되기 전까지 현재 CLIProxy 경로는 동작하는 기본 경로다.
- 각 phase gate를 통과한 기능만 Baton native 경로의 책임으로 이전한다.
- Codex 및 기타 provider의 전환 여부는 이 문서에서 결정하지 않는다.

## 4. 목적, 목표, 비목표

### 목적

Claude CLI/Desktop의 사용자 경험을 유지하면서 Baton이 계정과 모델 가용성을 투명하게 관리하고,
실패 원인을 정확히 보여주며, 외부 proxy core 없이 운영되도록 한다.

### 목표

1. Anthropic 요청/응답과 SSE를 손실 없이 중계한다.
2. 계정별 OAuth 자격증명을 안전하게 저장·갱신한다.
3. 한 계정의 모델 한도가 소진되면 같은 요청을 다음 적격 계정으로 전환한다.
4. 모든 계정의 Fable 5가 소진되면 사용자가 허용한 경우 Opus 4.8로 임시 전환한다.
5. Fable 5가 다시 가능해지면 자동 복귀한다.
6. 전환과 복귀를 Baton UI 및 대화 이벤트에서 설명 가능하게 표시한다.
7. 모든 자동 동작은 끌 수 있고, 안전하게 이전 경로로 rollback할 수 있다.

### 비목표

- Anthropic API 또는 Claude 클라이언트 전체를 재구현하지 않는다.
- 오류 메시지 문구를 정규식으로 추측해 safety/quota를 분류하지 않는다.
- Claude 계정 약관이나 provider 제한을 우회하지 않는다.
- 사용자 동의 없이 유료 모델로 전환하거나 사용량을 소비하지 않는다.
- Claude CLI/Desktop 바이너리나 세션 DB를 패치하지 않는다.
- 첫 구현에서 Codex/OpenAI/Gemini까지 같은 proxy core로 통합하지 않는다.

## 5. 제품 불변 조건

- **원본 보존:** 알 수 없는 응답은 status, 안전한 headers, body, SSE 순서를 가능한 그대로 전달한다.
- **구조화된 판정:** quota/refusal/fallback은 provider가 준 필드와 검증된 계약으로만 판정한다.
- **최소 재시도:** 같은 요청의 재시도 횟수와 후보 계정을 제한하고 무한 loop를 금지한다.
- **명시적 비용 동의:** 더 비싼 모델 fallback은 opt-in이 기본이다.
- **복귀 가능:** 자동 fallback은 선호 모델 설정을 덮어쓰지 않는 runtime override다.
- **보안:** OAuth token, authorization header, prompt/response 본문은 기본 로그에 남기지 않는다.
- **관측 가능:** 계정/모델 전환의 이유, 시각, 결과는 redacted event로 확인할 수 있다.
- **fail closed:** 계약이 불명확하거나 token 상태가 모호하면 임의 전환하지 않고 원래 오류를 반환한다.
- **loopback 기본:** native proxy는 기본적으로 `127.0.0.1`에만 바인딩한다.

## 6. 목표 아키텍처

```text
Claude Code CLI / Claude Desktop
                |
                | Anthropic-compatible HTTP + SSE
                v
      Baton Native Claude Proxy
       |       |        |       |
       |       |        |       +-- redacted provider/fallback events
       |       |        +---------- model fallback controller
       |       +------------------- account router + health/cooldown
       +--------------------------- OAuth vault + token refresh
                |
                v
          Anthropic endpoints

Control plane: Baton BFF/UI
Data plane:    Baton Native Claude Proxy
Rollback:      기존 CLIProxy 경로(Phase 8 전까지)
```

fallback 모델 결정 순서는 다음으로 고정한다.

1. 서버가 현재 모델에 제공한 `allowed_fallback_models`
2. 사용자가 명시한 fallback 모델
3. Baton 호환성 기본값 `claude-fable-5 -> claude-opus-4-8`

3번은 서버 정보가 없는 현재/구버전과의 호환용 seed일 뿐 자동전환 엔진에 하드코딩하지 않는다.
서버 목록과 충돌하지 않고 사용자가 자동 전환을 켠 경우에만 적용한다.

자동전환 엔진의 입력은 특정 모델명이 아니라 다음과 같은 정규화된 capability다.

```text
FallbackCapability {
  sourceModel
  fallbackModels[]
  reasonCategories[]
  direction          // retry | revert | sticky
  validity/resetHint
  provenance         // server | user | compatibility-default
}
```

서버가 향후 다른 원본 모델과 fallback 모델의 관계를 같은 구조로 제공하면 기존 router, 동의, runtime
override, 복귀, UI event 상태 머신을 그대로 사용한다. 새 모델 조합을 위해 별도의 전환 로직이나 새 UI를
구현하지 않는다. 서버가 capability를 제공하지 않고 사용자 mapping도 없으면 Baton은 관계를 추측하지
않으며 자동전환하지 않는다.

## 7. 단계별 구현 계획

### Phase 0 — 계약 캡처와 golden fixture

**배경:** 프록시를 먼저 구현하면 Claude API의 세부 응답을 실수로 변형해도 발견하기 어렵다.

**목적과 목표:** native Claude와 현재 경로의 정상·오류 계약을 재현 가능한 fixture로 고정한다.

**범위**

- `/v1/messages`, `/v1/messages/count_tokens`, `/v1/models` 요청/응답 shape
- 일반 JSON, SSE, 401/403/429/5xx, Fable 한도 소진, 구조화된 refusal/fallback event
- 민감값을 제거한 golden fixture와 contract test harness

**범위 밖:** 실제 proxy 구현, 계정 라우팅, 자동 모델 전환.

**기능 명세**

- fixture에는 HTTP status, allowlist headers, JSON body 또는 SSE event 순서를 기록한다.
- token, cookie, prompt, 응답 본문 등 민감 데이터는 합성값으로 치환한다.
- live capture가 없어도 fake upstream으로 contract test가 반복 실행돼야 한다.

**사용자가 할 일**

- 실제 Claude 요청 3~5회에 대한 소량 사용량 소비를 허용한다.
- safety/refusal 검증은 실제 위험 prompt가 아닌 Anthropic이 제공하거나 승인한 안전 fixture만 사용하도록 승인한다.

**Baton/Codex가 할 일**

- capture/redaction 규칙과 fake upstream을 만든다.
- native CLI `Hi` 정상 응답과 Fable 소진 응답을 fixture로 고정한다.
- fixture에 secret이 없는지 자동 검사한다.

**완료 기준**

- 정상 JSON, 정상 SSE, 모델별 429, 일반 429, 5xx fixture가 있다.
- redaction test와 contract test가 모두 통과한다.
- 실제 응답과 fixture 차이를 사람이 읽을 수 있는 diff로 확인할 수 있다.

**검증:** contract test, secret scanner, native CLI smoke test를 실행한다.

**rollback:** 생성한 fixture/harness만 제거한다. 런타임 설정은 바꾸지 않는다.

**Gate 0:** fixture에 민감정보가 없고 사용자가 Phase 1 착수를 승인하기 전까지 진행하지 않는다.

### Phase 1 — feature flag 기반 native transport core

**배경:** 계정/모델 정책보다 먼저 Claude 호환 전송 계층이 정확해야 한다.

**목적과 목표:** 단일 테스트 credential로 정책 없는 투명 프록시를 구현한다.

**범위**

- `/v1/messages`, `/v1/messages/count_tokens`, `/v1/models`
- 요청 body와 beta/version headers 전달
- backpressure, client disconnect, timeout을 포함한 SSE streaming
- exact status/body와 안전한 응답 header 전달
- loopback bind, request ID, redacted diagnostic log
- 기본 OFF인 `BATON_NATIVE_CLAUDE_PROXY` feature flag

**범위 밖:** OAuth UI, 다중 계정, 자동 재시도, 모델 fallback, Claude 전역설정 변경.

**기능·보안 명세**

- proxy 자체가 알 수 없는 필드를 삭제하거나 모델명을 다시 쓰지 않는다.
- hop-by-hop header와 credential은 전달 규칙을 명시한다.
- body size, header size, upstream timeout에 상한을 둔다.
- client disconnect 시 upstream도 취소한다.
- access log에는 request body와 authorization을 기록하지 않는다.

**사용자가 할 일:** 없음. fake upstream 검증 후 live smoke에 앞서 1회 승인만 한다.

**Baton/Codex가 할 일:** 최소 transport, 단위/통합 test, 설정 flag, 진단 endpoint를 구현한다.

**완료 기준**

- Phase 0 golden fixture가 byte/semantic 허용 범위에서 동일하게 통과한다.
- 느린 SSE 소비자와 중간 연결 종료에서 누수·중복 event가 없다.
- flag OFF이면 기존 경로에 영향이 없다.
- 의도하지 않은 외부 interface에 listen하지 않는다.

**검증:** fake upstream integration test, SSE disconnect test, typecheck, targeted live smoke를 실행한다.

**rollback:** feature flag를 OFF로 하고 기존 CLIProxy URL로 즉시 복구한다.

**Gate 1:** 모든 transport test와 단일 계정 canary가 통과하기 전에는 OAuth/라우팅을 얹지 않는다.

### Phase 2 — Baton OAuth vault와 token lifecycle

**배경:** 외부 proxy 의존을 제거하려면 계정 자격증명의 저장·refresh·폐기를 Baton이 소유해야 한다.

**목적과 목표:** Claude 계정을 안전하게 추가하고 만료 전에 refresh하며 사용자가 철회할 수 있게 한다.

**범위**

- Claude OAuth 시작/callback 또는 검증된 device flow
- OS 보안 저장소를 우선한 encrypted-at-rest vault
- access token refresh single-flight, expiry 관리, re-auth 상태
- 계정 별칭, 우선순위, enabled/disabled 상태
- token 삭제와 로그 redaction

**범위 밖:** 비공식 로그인 자동화, 브라우저 credential 추출, 계정 간 token 공유.

**기능·보안 명세**

- OAuth scope와 endpoint는 설치 버전/공식 계약으로 검증한다.
- state/PKCE, callback origin, replay 방지를 적용한다.
- refresh 실패는 다른 계정 token을 손상시키지 않는다.
- UI/API가 token 원문을 다시 반환하지 않는다.
- vault migration과 backup에는 명시적 version을 둔다.

**사용자가 할 일**

- 테스트 계정을 지정하고 OAuth 창에서 직접 로그인·동의한다.
- 계정 별칭과 삭제/재인증 UX를 확인한다.

**Baton/Codex가 할 일:** vault, OAuth flow, refresh scheduler, redaction/보안 test를 구현한다.

**완료 기준**

- 재시작 뒤에도 승인된 계정이 유지되며 token 원문은 노출되지 않는다.
- 동시 요청에서 refresh가 한 번만 수행된다.
- 취소·만료·revocation·clock skew가 명확한 상태로 표시된다.
- 계정 삭제 후 해당 token으로 요청할 수 없다.

**검증:** OAuth happy/cancel/replay test, refresh concurrency test, vault-at-rest 검사, 재시작 smoke를 실행한다.

**rollback:** native vault 사용을 중단하고 기존 CLIProxy credential store로 되돌린다. Baton에 저장된 token은 사용자 확인 후 폐기한다.

**Gate 2:** 보안 검토와 계정 1개의 refresh/restart 검증 전에는 다중 계정 라우팅을 켜지 않는다.

### Phase 3 — 계정 router와 같은 요청 failover

**배경:** 모델 한도는 계정별로 다를 수 있으므로 첫 계정의 429가 전체 실패를 뜻하지 않는다.

**목적과 목표:** 선호 모델을 유지한 채 적격 계정들을 순서대로 시도하고 정확한 최종 오류를 반환한다.

**범위**

- 사용자 우선순위, enabled, auth health, cooldown을 반영한 후보군
- retry 가능한 provider 신호에 한정한 same-request failover
- request replay 가능성 판정과 retry budget
- 계정·모델별 가용성 상태 및 reset hint
- 모든 후보 실패 시 가장 유용한 원본 오류 보존

**범위 밖:** safety refusal의 모델 전환, 서로 다른 모델로의 자동 fallback.

**기능 명세**

- 기본 후보 순서는 사용자가 정한 우선순위다.
- 모델별 quota 소진은 계정 전체 auth failure와 분리한다.
- 401/403, 모델별 429, 일반 429, 5xx의 retry 여부를 표로 고정한다.
- streaming body가 클라이언트에 시작된 뒤에는 다른 계정으로 몰래 재시도하지 않는다.
- 요청당 최대 시도 횟수와 전체 deadline을 둔다.

**사용자가 할 일:** canary 계정, 계정 우선순위, 허용할 실제 failover test 횟수를 지정한다.

**Baton/Codex가 할 일:** router state machine, cooldown, retry budget, fake clock test, diagnostics를 구현한다.

**완료 기준**

- A 계정 Fable 소진 + B 계정 가용 시 같은 Fable 요청이 B에서 성공한다.
- 모든 계정이 소진되면 무한 재시도 없이 모델별 한도 오류를 반환한다.
- auth failure 계정은 quota 소진으로 잘못 표시되지 않는다.
- 이미 시작된 stream을 중복 생성하지 않는다.

**검증:** 다중 fake account matrix, race/timeout test, 실제 2계정 canary를 실행한다.

**rollback:** router flag를 OFF하고 고정 단일 계정 또는 기존 CLIProxy 경로로 복구한다.

**Gate 3:** 계정 순서·retry matrix·최종 오류가 UI 없이도 로그/진단에서 설명 가능해야 한다.

### Phase 4 — 구조화된 safety refusal fallback

**배경:** Claude는 안전 검토 결과에 따라 fallback 모델을 제안하거나 전환 event를 보낼 수 있다.
이는 quota 429와 다른 상태 머신이다.

**목적과 목표:** provider의 구조화된 refusal/fallback protocol을 보존하고, 허용된 모델로만 안전하게 재시도한다.

**범위**

- `stop_reason: refusal`, `stop_details.category`
- `model_refusal_fallback`의 `retry`, `revert`, `sticky`
- server-side fallback beta와 `fallback_credit_token`
- `/v1/models`의 `allowed_fallback_models`
- 모델명과 무관한 정규화 `FallbackCapability` resolver
- server-authorized fallback과 Baton client-side fallback의 중복 방지

**범위 밖:** prompt 내용으로 안전 분류 추측, 안전 정책 우회, 임의 category 생성.

**기능 명세**

- 서버가 처리한 fallback은 Baton이 다시 fallback하지 않는다.
- fallback 후보는 서버 허용 목록을 최우선으로 한다.
- 서버가 반환한 새로운 모델 조합은 코드 배포 없이 같은 상태 머신으로 처리한다.
- 원 모델, fallback 모델, category, 방향을 redacted event로 남긴다.
- `revert`는 다음 요청의 원 모델 복귀를 뜻하며 사용자 선호 설정을 변경하지 않는다.
- sticky의 수명은 Claude protocol과 session 경계로 제한한다.

**사용자가 할 일:** 기본 safety fallback 모델과 알림 공개 수준을 승인한다.

**Baton/Codex가 할 일:** protocol parser/state machine, duplicate-prevention, fixture test를 구현한다.

**완료 기준**

- 알려진 구조화 event는 native client가 기대하는 순서로 전달된다.
- server-side/client-side 이중 과금·이중 재시도가 없다.
- 알 수 없는 category는 원본 보존 후 fail closed한다.
- safety fallback을 꺼도 원래 refusal은 훼손되지 않는다.

**검증:** Phase 0 refusal fixture, state transition table, safe synthetic event test를 실행한다.

**rollback:** client-side safety fallback만 OFF하고 server/native 응답을 그대로 전달한다.

**Gate 4:** 실데이터 없이도 모든 상태 전이가 deterministic하게 검증되어야 한다.

### Phase 5 — 범용 opt-in quota fallback과 자동 복귀

**배경:** 모든 계정의 특정 모델 한도가 소진되면 계정 전환만으로는 요청을 완료할 수 없다. 최초 적용
시나리오는 Fable 5이지만 엔진은 모델명에 종속되면 안 된다.

**목적과 목표:** 사용자가 동의하면 서버 capability가 허용한 fallback 모델로 해당 요청을 수행하고,
원 모델이 회복되면 자동 복귀한다. 현재 호환성 시나리오는 Fable 5에서 Opus 4.8로의 전환이다.

**범위**

- 기본 OFF인 quota model fallback
- 임의의 `sourceModel -> fallbackModels[]`을 처리하는 범용 상태 머신
- `claude-fable-5 -> claude-opus-4-8` 호환성 seed
- 서버 허용 목록/사용자 설정 기반 후보 해석
- runtime model override, 주기적 probe, reset hint 기반 재확인
- 수동 “자동전환 끄기”와 즉시 Fable 재시도
- 갑작스러운 quota 조기 reset 대응

**범위 밖:** 사용자의 저장된 선호 모델 변경, silent paid upgrade, 매 요청 무제한 probe, 서버 응답에 없는
모델 관계 추측.

**기능 명세**

- 한 계정이 아닌 모든 적격 계정의 원 모델 소진이 확인된 뒤에만 모델 fallback한다.
- 최초 전체 소진 시 상단 prompt로 자동전환 활성화를 제안하고 “다시 보지 않기”를 제공한다.
- opt-in 후 실제 전환 때만 `<원 모델> -> <fallback 모델> 자동 전환됨`을 동적으로 표시한다.
- 전환 중에도 사용자의 preferred model은 원 모델로 유지한다.
- reset 시각, 60초 quota polling, bounded active probe를 조합해 복귀한다.
- 원 모델 성공 확인 즉시 override와 활성 banner를 제거하고 복귀 event를 남긴다.
- 자동전환 OFF 시 다음 요청은 원 모델로 시도하고 실패하면 구체적 원본 오류를 보여준다.
- 서버가 새로운 모델 조합을 반환해도 resolver 출력만 달라지고 전환·복귀 상태 머신은 동일해야 한다.

**사용자가 할 일**

- 자동전환 기본값(권장: OFF), fallback 모델, 비용 경고를 승인한다.
- 실제 전환/복귀 canary에서 소량 사용량 소비를 승인한다.

**Baton/Codex가 할 일:** fallback/recovery controller, probe throttling, preference 분리, test를 구현한다.

**완료 기준**

- 일부 계정만 소진되면 모델이 아니라 계정을 먼저 전환한다.
- 전 계정 소진 + opt-in일 때만 Opus 4.8로 전환한다.
- opt-out이면 Opus 요청이 발생하지 않는다.
- Fable 회복 시 설정 변경 없이 Fable로 복귀한다.
- 합성한 다른 모델 조합에서도 동일한 전환·복귀 test suite가 parameterized test로 통과한다.
- poll/probe가 rate-limit 폭풍을 만들지 않는다.

**검증:** fake clock quota matrix, early reset, stale usage, opt-in/out, 비용 guard test와 제한된 live canary를 실행한다.

**rollback:** quota fallback flag를 OFF하고 runtime override를 지운 뒤 Fable 원본 동작으로 복구한다.

**Gate 5:** 비용 동의, 전환 조건, 복귀 조건을 사용자가 승인하기 전에는 기본 사용자에게 노출하지 않는다.

### Phase 6 — UI banner와 canonical fallback event

**배경:** 자동화가 정확해도 왜 계정/모델이 바뀌었는지 보이지 않으면 신뢰하기 어렵다.

**목적과 목표:** 현재 상태와 대화의 전환 이력을 명료하게 보여주되 내부 token이나 민감한 정책 세부를 노출하지 않는다.

**범위**

- goal 상단의 전체 소진 opt-in prompt
- 활성 fallback banner, `[자동전환 끄기]`, “다시 보지 않기”
- 전환·복귀·실패 `provider_event`
- 현재 preferred/effective model과 사용 계정 별칭 표시
- 진행 중 세션의 실시간 갱신과 재시작 복원

**범위 밖:** 원 prompt/response를 event에 복제, Claude native 대화 DB 직접 수정.

**기능 명세**

- `preferred_model`과 `effective_model`을 UI/API에서 구분한다.
- event는 이유 코드, 원/대상 모델, 시각, 계정 별칭, 상태만 저장한다.
- 복귀 시 활성 banner는 사라지지만 대화 timeline의 과거 event는 유지한다.
- UI 버튼 동작은 idempotent하고 진행 중 요청과 race가 없어야 한다.

**사용자가 할 일:** 문구, 버튼 위치, timeline event 보존 여부를 실제 화면에서 확인한다.

**Baton/Codex가 할 일:** API/event schema, persistence, banner/timeline UI, accessibility test를 구현한다.

**완료 기준**

- 사용자가 현재 왜 Opus를 쓰는지 한 화면에서 알 수 있다.
- OFF 버튼 후 다음 요청의 모델을 확인할 수 있다.
- refresh/restart 후 활성 상태와 event가 모순되지 않는다.
- keyboard/screen reader로 prompt와 버튼을 사용할 수 있다.

**검증:** component test, persistence/reconnect test, race test, 수동 UX 시나리오를 실행한다.

**rollback:** UI feature flag를 OFF하되 proxy 기능은 유지할 수 있다. event schema는 backward-compatible하게 남긴다.

**Gate 6:** 사용자 UX 확인과 event privacy 검토를 통과해야 native client canary로 간다.

### Phase 7 — Claude CLI/Desktop shadow와 canary migration

**배경:** Claude CLI와 Desktop은 같은 API를 쓰더라도 설정 상속, 재시작, 세션 UI 동작이 다를 수 있다.

**목적과 목표:** 전역 설정을 안전하게 백업한 뒤 일부 트래픽부터 Baton native 경로로 전환한다.

**범위**

- 기존 Claude 설정의 원자적 backup/restore
- CLI 비대화형 smoke, CLI interactive mode, Desktop 순차 canary
- 가능한 경우 redacted shadow comparison
- canary 비율 확대, health threshold, 자동 rollback
- Claude 업데이트 후 compatibility smoke

**범위 밖:** Claude 바이너리 수정, 사용자 확인 없는 전역 설정 overwrite.

**기능·안전 명세**

- 적용 전 실제 설정 source와 현재 proxy URL을 보여준다.
- 설정 변경은 marker 기반으로 Baton 소유 구간만 수정한다.
- 실행 중인 Claude 프로세스에는 설정을 강제 주입하지 않는다.
- error rate, first-token latency, SSE parse failure threshold를 넘으면 rollback한다.

**사용자가 할 일**

- 설정 backup 위치를 확인한다.
- 안내 시 Claude CLI/Desktop을 완전히 종료하고 재시작한다.
- CLI interactive에서 `Hi`, Fable 소진, 전환 OFF를 확인한다.
- Desktop에서 기존 대화가 유지되고 banner/event가 이해되는지 확인한다.

**Baton/Codex가 할 일:** installer/restore, health check, canary controller, version compatibility test를 구현한다.

**완료 기준**

- CLI 비대화형/interactive와 Desktop에서 정상 streaming이 된다.
- 기존 native session/history가 사라지거나 fork되지 않는다.
- Fable 오류가 generic 429로 열화되지 않는다.
- 한 번의 동작으로 기존 CLIProxy 설정으로 복구할 수 있다.

**검증:** 설정 diff, process restart, 세 클라이언트 시나리오, 24시간 canary 관찰을 수행한다.

**rollback:** Claude를 종료하고 backup 설정을 원자적으로 복원한 뒤 기존 CLIProxy health를 확인한다.

**Gate 7:** 사용자 실사용 승인과 안정성 관찰 기간을 통과하기 전에는 CLIProxy를 제거하지 않는다.

### Phase 8 — CLIProxy 제거와 운영 전환

**배경:** 두 proxy core를 영구 유지하면 책임과 장애 원인이 다시 불명확해진다.

**목적과 목표:** Claude runtime에서 CLIProxy 의존을 제거하고 Baton native 경로를 유일한 지원 경로로 만든다.

**범위**

- Claude 관련 CLIProxy 설정/호출/dependency 제거
- legacy credential/config migration 종료
- 운영 runbook, upgrade compatibility test, recovery export
- dead code 및 문서의 역사적 의존 표시

**범위 밖:** 다른 provider가 아직 사용하는 CLIProxy 제거. 이는 별도 결정과 migration이 필요하다.

**기능 명세**

- 제거 전 의존 호출을 정적 검색과 runtime telemetry 양쪽에서 확인한다.
- rollback package와 설정 backup은 최소 한 안정화 기간 보관한다.
- Claude update가 contract test를 실패하면 자동 적용을 중단하고 명확히 알린다.

**사용자가 할 일:** 최종 cutover와 rollback package 보존 기간을 승인한다.

**Baton/Codex가 할 일:** 의존 제거, migration cleanup, 운영/복구 문서와 release validation을 완료한다.

**완료 기준**

- Claude 요청 경로에서 CLIProxy process/port/config가 필요 없다.
- clean install과 기존 설치 upgrade가 모두 통과한다.
- 기존 계정과 설정을 잃지 않고 제거/재설치할 수 있다.
- 문서와 UI가 CLIProxy를 Claude 필수 구성요소로 안내하지 않는다.

**검증:** clean install, upgrade, uninstall/reinstall, dependency search, 장기 canary를 실행한다.

**rollback:** 보존한 release/config package로 이전 안정 버전을 복원한다. 데이터 schema는 downgrade-safe migration을 제공한다.

**Gate 8:** 다른 provider 의존과 분리되었음을 확인한 뒤 Claude 부분만 제거 완료로 선언한다.

## 8. 공통 검증 시나리오

각 phase의 targeted test 외에 cutover 전 아래 시나리오를 반복한다.

| 시나리오 | 기대 결과 |
|---|---|
| 계정 A Fable 소진, B 가용 | 모델 유지, B 계정으로 성공 |
| 모든 계정 Fable 소진, 자동전환 OFF | Opus를 호출하지 않고 구체적 Fable 한도 오류 표시 |
| 모든 계정 Fable 소진, 자동전환 ON | 허용 목록 확인 후 Opus로 한 번 전환 |
| Fable 한도 조기 복구 | 다음 bounded probe 성공 후 Fable로 자동 복귀 |
| safety refusal + server fallback | Baton의 중복 fallback 없이 server event 보존 |
| SSE 시작 뒤 upstream 단절 | 중복 요청 없이 오류 종료 |
| OAuth refresh 동시 발생 | single-flight refresh 한 번만 수행 |
| Baton 재시작 | preferred/effective model과 fallback 상태 일치 |
| 자동전환 끄기 | runtime override 제거 후 Fable 재시도 |
| Claude 설정 rollback | 기존 CLIProxy 경로와 native history 정상 복구 |

## 9. 위험 등록부

| 위험 | 영향 | 대응 |
|---|---|---|
| 비공개/변경 가능한 Claude OAuth 계약 | 로그인 중단 | versioned adapter, startup compatibility check, fail closed |
| SSE 변형 또는 buffering | CLI/Desktop hang | golden fixture, byte-order test, backpressure test |
| 429 오분류 | 재시도 폭풍·비용 증가 | 구조화된 판정표, retry budget, deadline |
| server/client 이중 fallback | 중복 과금·응답 혼선 | fallback credit/event 추적, idempotency state |
| Opus 자동전환 비용 | 예상 외 소비 | 기본 OFF, 명시 동의, 즉시 OFF, event 표시 |
| stale quota 데이터 | 늦은 복귀/잘못된 전환 | 실제 요청 신호 우선, bounded probe, reset hint |
| token 유출 | 계정 침해 | OS vault, redaction test, loopback, 최소 scope |
| Claude 앱 업데이트 | 갑작스러운 호환성 파손 | version gate, contract smoke, automatic rollback |
| dirty 설정 덮어쓰기 | 사용자 설정 손실 | marker patch, backup/diff/restore test |
| CLIProxy 조기 제거 | 복구 경로 상실 | Phase 7 안정화와 사용자 승인 전 제거 금지 |

## 10. 구현 순서와 승인 방식

한 번에 하나의 phase만 `in progress`로 둔다. 각 phase마다 다음 순서를 따른다.

1. 해당 phase의 상세 설계와 변경 파일 목록을 제시한다.
2. material assumption, API 계약, 보안·비용 위험을 먼저 확인한다.
3. 사용자가 gate를 승인한다.
4. 가장 작은 feature-flagged 변경을 구현한다.
5. 문서에 적힌 concrete verification을 실행하고 결과를 제시한다.
6. rollback을 실제로 검증한다.
7. acceptance criteria를 모두 충족한 뒤에만 다음 phase를 제안한다.

지금 필요한 다음 결정은 **Phase 0과 Phase 1을 하나의 첫 작업 묶음으로 설계·구현해도 되는지**이다.
승인되면 runtime 기본값은 계속 기존 CLIProxy이며, native proxy는 test/canary flag에서만 동작한다.
