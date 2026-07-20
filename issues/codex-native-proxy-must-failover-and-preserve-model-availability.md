# Codex 네이티브 프록시는 usage-limit failover와 모델 가용성을 함께 보장해야 함

## 상태

- 상태: **부분 해결**
- 발견일: 2026-07-20
- 현재 조치: (1) 소진 계정 수동 pause(임시 fail-safe)로 서비스 복구, (2) merozemory **재로그인**으로 Pro 토큰 재발급 → `gpt-5.6-sol` 카탈로그 복귀·200 서빙 확인
- 미해결 핵심: 구현·합성 회귀는 완료했으며, **실제 OAuth 계정에서 재로그인 없는 free→pro canary**가 남음
- 근본 해결: Baton Codex Native Proxy, OAuth/vault, live claim/catalog, model-aware same-request router 구현 완료. 실제 계정 gate 진행 전
- 관련 이슈: [[claude-rotation-must-switch-on-actual-429]] (Claude 경로의 동일 계열 문제)

## 왜 지금 Baton 코드만으로는 못 고치나 (2026-07-20 확인)

- `server/openai-inference-bridge.ts`는 **thin pass-through**다. codex 요청을 `${proxy.baseUrl}/v1`(= CLIProxy 8317)로 그대로 포워딩하고 `Authorization: Bearer ${BATON_PROXY_TOKEN}`만 붙인다. **Baton은 codex(ChatGPT) OAuth 토큰을 소유하지 않는다.**
- 따라서 codex 토큰 파일(`codex-<email>-<plan>.json`), 플랜 판정, `/v1/models` 카탈로그 산출은 **전부 CLIProxy(외부 Go 프록시)** 소관이다. 플랜은 인증 시점에 토큰/파일명에 사실상 고정된다.
- 반면 Claude 네이티브 경로는 `server/claude-native-credentials.ts`의 `ClaudeCodeCredentialManager`가 OAuth **refresh를 직접 소유**한다(`ClaudeOAuthRefreshResponse`, `REFRESH_SKEW_MS`, `loadClaudeCodeCredential`, `oauthCredential`). 그래서 재로그인 없이 access token을 갱신할 수 있다.
- 결론: "재로그인 없는 free→pro 반영"은 (a) CLIProxy가 refresh/재판정 API를 노출하거나, (b) **Baton codex 네이티브 프록시가 codex OAuth를 소유**해 refresh·카탈로그 재산출을 스스로 하는 방식으로만 가능하다. 후자가 이 이슈의 목표다.

## 배경 / 현재 경로

Codex CLI는 `~/.codex/config.toml`의 `model_provider = "baton"`을 통해 **CLIProxyAPI**로 라우팅된다.

```toml
model = "gpt-5.6-sol"
model_reasoning_effort = "medium"
model_provider = "baton"

[model_providers.baton]
name = "Baton CLIProxy"
base_url = "http://127.0.0.1:8317/v1"   # CLIProxy 추론 엔드포인트 (Baton native 아님)
env_key = "BATON_PROXY_TOKEN"
wire_api = "responses"
```

포트 정리:
- `3000` — CLIProxyAPI 관리 대시보드/API (`GATEWAY_URL`). 계정 풀·쿼터·라우팅 관리.
- `4400` — Baton BFF/대시보드. CLIProxy(3000)를 감싸는 상위 레이어. **Claude는 여기 native 경로(`/baton/inference/claude`)를 씀.**
- `8317` — CLIProxy의 codex(OpenAI) 추론 엔드포인트. 현재 codex는 여기로 감.

즉 **codex의 계정 회전/모델 라우팅은 지금 전적으로 CLIProxy 책임**이고, Baton은 상태를 비추기만 한다. Claude에는 native 프록시가 있지만 **codex native 경로(`openai-inference-bridge`, `4400/baton/inference/openai/v1`)는 아직 client-integration의 `native-openai` 모드로만 존재하고 실제 라우팅에 쓰이지 않는다.**

## 확인된 현상 (2026-07-20 실측)

새 codex 계정을 추가했는데도 신규 터미널 `codex`에서 usage limit이 뜨고, 기존 세션 `resume`에서는 502가 뜬다.

### 증상 1 — usage limit (새 세션)

```text
■ You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage ...
```

CLIProxy codex 계정 풀 상태:

| 계정 | default | paused | usage(5h primary) | 비고 |
|------|---------|--------|-------------------|------|
| support@agentryx-ai.com | true | true | **100%** | 7/25 리셋 |
| winapihooking@gmail.com | false | false | **100%** | 7/25 리셋 |
| merozemory@gmail.com | false | false | **0%** | 오늘 추가, 7/27 리셋 |

- 라우팅 전략: `fill-first`
- default(`support`)는 paused → 스킵. 다음 순번 `winapihooking`이 100% 소진 → 요청이 여기 꽂혀 usage-limit 반환.
- 정작 여유 있는 `merozemory`(0%)로 **request-time failover가 일어나지 않음.** 새 계정을 추가해도 "선택"이 안 되니 오류가 계속됨.

### 증상 2 — unknown provider (기존 세션 resume)

```text
Unexpected status 502 Bad Gateway: unknown provider for model gpt-5.6-sol,
url: http://127.0.0.1:8317/v1/responses
```

- config.toml과 다수 에이전트가 `gpt-5.6-sol`에 pin돼 있음.
- 그러나 CLIProxy `/v1/models` 전체 목록에 **`gpt-5.6-sol`이 없음.** 존재하는 5.6은 `gpt-5.6-luna`, `gpt-5.6-terra`뿐.
- `gpt-5.6-sol`은 **Pro 플랜 계정에서만 노출되는 모델**로 추정. 소진된 Pro 계정(support/winapihooking)을 pause하자 카탈로그에서 sol이 사라졌다.
- 남은 `merozemory`는 토큰 파일이 `codex-merozemory@gmail.com-free.json`(free-origin). 계정은 이후 Pro로 업그레이드됐지만 **CLIProxy가 free 시절 토큰의 엔트리먼트를 캐시**하고 있어 sol을 노출하지 못한다. (quota API는 정상 응답하고 `gpt-5.5`/`luna`/`terra`는 서빙되므로 토큰 자체는 유효.)

## 근본 원인

### 1. codex usage-limit에 대한 same-request failover 부재

CLIProxy는 실제 429/usage-limit이 나도 **다음 유효 계정으로 같은 요청을 재시도하지 않고** 소진 계정의 raw 오류를 그대로 반환한다. `quota-exceeded.switch-project`는 Gemini 프로젝트 전환 개념이라 OpenAI 계정-레벨 usage-limit에는 적용되지 않는다. Baton의 60초 쿼터 폴링은 telemetry일 뿐 request-time 전환 수단이 될 수 없다(이슈 [[claude-rotation-must-switch-on-actual-429]] 참고).

### 2. 모델 가용성이 활성 계정 엔트리먼트에 종속

CLIProxy `/v1/models`는 활성 계정들의 엔트리먼트를 합쳐 만든다. 그래서:
- 특정 모델(`gpt-5.6-sol`)은 그 모델을 가진 계정이 활성일 때만 카탈로그에 존재한다.
- 계정을 pause/rotate하면 **핀된 세션 모델이 갑자기 unknown이 되어 502**가 난다.
- 토큰이 stale(free 시절)이면 계정이 실제로 Pro여도 Pro 모델을 노출하지 못한다.

failover(문제 1)와 모델 가용성(문제 2)이 얽혀 있다: "여유 계정으로 돌린다"가 곧 "그 계정이 요청 모델을 지원하는가"를 함께 판단해야 한다.

## 요구 동작 (네이티브 프록시 구현 시)

Baton codex 네이티브 프록시가 CLIProxy 대신 codex 요청 경로를 소유할 때 다음을 만족해야 한다.

1. **모델-aware failover.** 요청 모델 M에 대해 "유효(미소진·미pause·인증정상) + M을 지원" 하는 계정만 후보로 삼는다. 현재 계정이 실제 usage-limit을 반환하면 같은 요청을 다음 후보로 즉시 재시도한다.
2. **핀 모델 폴백 정책.** 후보 중 M을 지원하는 계정이 없으면 임의로 다른 모델로 바꾸지 말고, 명확한 오류(어떤 모델이 왜 불가한지)를 반환한다. 선택적으로 사전에 합의된 동급 대체 모델 매핑(예: `gpt-5.6-sol` → `gpt-5.6-luna`)을 옵트인으로 허용한다.
3. **토큰 stale 감지/갱신 (재로그인 없는 플랜 반영) — 핵심.** 계정 플랜이 바뀌면(free→pro) **인터랙티브 재로그인 없이** access token을 refresh하고, 최신 토큰의 plan/entitlement claim 기준으로 모델 카탈로그를 재산출한다.
   - 구현 형태: codex 네이티브 프록시가 codex OAuth credential(access+refresh)을 소유하고, Claude의 `ClaudeCodeCredentialManager`(`server/claude-native-credentials.ts`)와 **동형**으로 만료 전 refresh(`REFRESH_SKEW_MS`)한다.
   - 플랜은 **파일명(`-free.json`/`-pro.json`)이 아니라 live 토큰 claim**에서 파생한다. refresh 응답이 pro면 별도 재로그인 없이 상위 모델(`gpt-5.6-sol` 등)이 카탈로그에 나타나야 한다.
   - 즉시 반영이 필요하면 수동 "엔트리먼트 새로고침" 액션(강제 refresh)을 노출한다. CLIProxy 경로만 쓰는 동안에는 CLIProxy가 해당 refresh 계약을 제공하기 전까지 재로그인이 유일한 우회임을 명시한다.
4. **소진 계정 자동 제외 + 리셋 복귀.** 실제 usage-limit(429) 관측 시 해당 계정을 resetAt까지 cooldown, 이후 자동 후보 복귀. 95% 등 사전 임계값으로 미리 죽이지 않는다(이슈 [[claude-rotation-must-switch-on-actual-429]] 원칙 계승).
5. **유효 계정 부재 시 명확한 오류.** 소진/미지원만 남으면 잘못된 계정으로 라우팅하지 말고 원래 usage-limit 또는 "지원 계정 없음"을 그대로 반환한다.

## 수용 기준 — 실측 기반 가상 검수 (2026-07-20)

재로그인이 하던 일을 **네이티브 프록시의 무중단 refresh가 재현**해야 한다. 오늘 재로그인 전/후로 실제 관측한 상태가 그대로 수용 기준이다.

| 항목 | 재로그인 前 (free 토큰) | 재로그인 後 (pro 토큰) | 네이티브 프록시 목표 |
|------|------------------------|------------------------|----------------------|
| tokenFile | `codex-merozemory@gmail.com-free.json` | `codex-merozemory@gmail.com-pro.json` | 파일명 무관, live claim 기준 |
| `/v1/models`에 `gpt-5.6-sol` | 없음 | 있음 | **refresh만으로** 있음 |
| `POST /v1/responses` model=`gpt-5.6-sol` | 502 `unknown provider for model gpt-5.6-sol` | 200 `completed` | **재로그인 없이** 200 |
| 5h primary usage | 0% (여유) | 0% (여유) | 동일 계정 유지 |

즉 네이티브 프록시 구현의 검수는 "credential refresh(강제 또는 만료 임박) 후, 재인증 없이 위 '後' 열이 재현되는가"로 판정한다. 라이브 재로그인 없이 이 전이를 만들면 통과다.

## 구현 및 회귀 증거 (2026-07-20)

- `server/codex-native-credentials.ts`: 원본 Codex와 같은 refresh endpoint/client ID/body,
  5분 선갱신, 8일 fallback, 강제 refresh, single-flight
- `server/native-account-vault.ts`: Windows DPAPI(CurrentUser), 원자적 versioned file, revision CAS
- `server/codex-native-models.ts`: live access token으로 계정별 `/backend-api/codex/models` 재조회
- `server/native-account-router.ts`, `server/codex-native-proxy.ts`: model-aware 후보, actual 429 cooldown,
  same-request failover, stream 시작 후 재시도 금지
- `server/codex-native-oauth.ts`: 원본 Codex authorize scope/PKCE/form token exchange와 동일 계약
- `server/codex-native-models.test.ts`: free claim에서는 `gpt-5.6-sol` 없음 → 강제 refresh의 pro claim과
  새 access token만으로 `gpt-5.6-sol` 노출
- `server/codex-native-account-routes.test.ts`: 계정 API의 강제 refresh 전에는 `gpt-5.6-sol` 요청이
  `model_unsupported`, refresh 후에는 재로그인 없이 catalog/계정 API에 노출되고 같은 요청이 200으로 서빙됨
- `server/codex-native-proxy.test.ts`: 첫 계정 429 → 다음 model-capable 계정 200, pinned model union,
  지원 계정 부재 시 명확한 오류

가상 수용표는 통과했다. 실제 계정 검수는 Codex Native vault에 OAuth 계정을 추가한 뒤,
재로그인 없이 `[엔트리먼트 새로고침]`을 실행하고 `gpt-5.6-sol` 요청 200을 확인해야 완료된다.

## 완료 조건

- 계정 플랜이 free→pro로 바뀐 뒤 **재로그인 없이**(강제 refresh 또는 자동 만료-refresh) 상위 모델이 카탈로그에 노출되고 해당 모델 요청이 200으로 서빙된다. (위 수용 기준 '後' 열 재현)
- 소진 계정에 요청이 꽂혀도 M을 지원하는 여유 계정이 있으면 같은 요청이 자동 재시도되어 성공한다.
- 핀 모델을 지원하는 계정이 하나도 없을 때 502 raw가 아니라 원인이 분명한 오류를 반환한다(옵트인 폴백 시 대체 모델로 서빙).
- 계정 pause/rotate가 핀 세션 모델의 502를 유발하지 않는다.
- 플랜 업그레이드된 계정이 갱신된 토큰으로 상위 모델을 노출한다.
- 관련 단위 테스트 + 실제 프록시 통합 테스트 추가.

## 임시 복구 절차 (근본 해결 전까지)

이번 인시던트에서 실제로 적용한 fail-safe:

```text
1) 소진 Pro 계정 수동 pause:
   POST /api/cliproxy/auth/accounts/codex/winapihooking@gmail.com/pause
   (support는 이미 paused)
   → 유효 active 계정이 merozemory(0%)만 남아 서빙됨. gpt-5.5로 200 OK 검증.

2) gpt-5.6-sol이 필요하면 둘 중 하나:
   - 7/25 리셋 후 Pro 계정을 resume (용량·sol 모델 복귀)
   - merozemory를 재인증(재로그인)하여 Pro 엔트리먼트가 반영된 새 토큰 발급
   - 임시로 세션 모델을 gpt-5.6-luna 등 서빙되는 모델로 변경 (/model 또는 config.toml)
```

수동 pause는 정책 엔진이 자동 resume하지 않으므로 리셋까지 안정 유지된다.

## 검증 시나리오

1. 계정 A(모델 M 지원)를 usage-limit 상태로, 계정 B(M 지원, 여유)를 준비.
2. M 요청이 A에서 429 → B로 자동 재시도되어 성공하는지.
3. M을 지원하는 계정을 모두 소진/pause → M 요청이 raw 502가 아닌 원인 명확 오류(또는 옵트인 대체 모델)로 처리되는지.
4. 계정 pause 후 해당 계정 전용 모델에 핀된 세션이 명확한 오류를 받는지(무한 reconnect 502 아님).
5. free→pro 업그레이드 계정 재인증 후 상위 모델이 카탈로그에 노출되는지.
