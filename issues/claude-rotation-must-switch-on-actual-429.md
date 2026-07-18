# Claude 계정은 실제 429 이후에만 전환해야 함

## 상태

- 확인됨
- 구현 필요
- 발견일: 2026-07-19

## 요약

Baton의 스마트 로테이션 엔진은 Claude 계정의 `usedPercent`가 95 이상이면 실제 사용 가능 여부와 관계없이 `EXHAUSTED`로 분류하고 pause한다. 이 때문에 아직 정상 요청이 가능한 Max 계정이 실제 HTTP 429 전에 비활성화됐고, 만료된 테스트 계정이 유일한 타깃으로 선택됐다.

원하는 동작은 현재 계정을 실제 429가 반환될 때까지 계속 사용하고, 429가 발생한 요청 시점에 다음 **유효한** 계정으로 전환하여 같은 요청을 재시도하는 것이다.

## 확인된 현상

당시 Baton 정책 상태는 다음과 같았다.

```text
target: expired-test-account
reserve: null
enginePaused: [active-max-account]
pause reason: 소진(≥95%)
```

프록시를 통한 Claude Code 요청은 다음 메시지와 함께 실패했다.

```text
Your organization has disabled Claude subscription access for Claude Code
```

CLIProxyAPI 오류 로그에 기록된 실제 Anthropic 응답은 다음과 같다.

```json
{
  "type": "error",
  "error": {
    "type": "permission_error",
    "message": "OAuth authentication is currently not allowed for this organization."
  }
}
```

반면 프록시 설정을 제외하고 정상 Claude.ai Max OAuth로 직접 요청하면 정상 응답했다. 따라서 Claude Code 전체나 Max 구독이 차단된 것이 아니라, Baton이 아직 사용 가능한 계정을 너무 일찍 pause하고 사용할 수 없는 계정으로 라우팅한 것이 직접 원인이다.

## 근본 원인

### 1. 95%를 실제 소진으로 간주함

`server/policy-engine.ts`에는 다음 선제 임계값이 있다.

```ts
const EXHAUSTED_AT = 95
```

이 값 이상이면 계정은 실제 429 여부와 무관하게 순위에서 제외되고 pause된다. 95%는 UI 경고 기준으로는 유용하지만 실제 라우팅 전환 조건으로 사용하면 남은 쿼터를 버리게 된다.

### 2. 요청 시점의 429가 아니라 60초 쿼터 폴링으로 전환함

Baton 정책 엔진은 60초 주기로 관리 API의 쿼터를 읽는다. 그러나 정확한 429 발생 순간과 실패한 요청의 재시도는 실제 요청 경로인 CLIProxy만 처리할 수 있다. Baton의 폴링은 즉시 전환 수단이 될 수 없다.

### 3. 사용할 수 없는 계정을 유효한 예비 계정으로 취급함

만료된 테스트 계정은 Claude Code OAuth 요청에 대해 403을 반환한다. 현재 분류는 쿼터 상태와 실제 Claude Code 사용 자격을 분리하지 않아 이 계정을 타깃으로 선택했다.

### 4. 현재 프록시 전략이 순차 소진 목표와 다름

확인 당시 CLIProxy 설정은 다음과 같았다.

```yaml
disable-cooling: true
quota-exceeded:
  switch-project: true
routing:
  strategy: round-robin
```

`round-robin`은 여러 활성 계정을 요청마다 순환시키므로 "선택 계정을 429까지 사용"한다는 목표와 맞지 않는다. 순차 소진에는 CLIProxy의 `fill-first`와 네이티브 429 failover를 사용해야 한다.

## 요구 동작

Claude 계정 상태를 최소한 다음과 같이 구분한다.

```text
READY / SERVING
  정상 사용 가능. usedPercent가 95% 또는 99%여도 실제 429 전까지 유지한다.

COOLDOWN
  실제 HTTP 429가 관측된 계정. resetAt까지 다음 선택에서 제외하고,
  리셋 후 다시 후보에 포함한다.

INELIGIBLE
  구독 만료, 조직의 OAuth 금지, 인증 철회 등으로 403이 발생하는 계정.
  429 cooldown과 구분하고 자동 로테이션 대상에서 제외한다.
```

정상 흐름은 다음과 같아야 한다.

```text
유효 계정 선택
  -> 실제 429까지 동일 계정 사용
  -> CLIProxy가 429 응답을 관측
  -> 해당 계정을 cooldown 처리
  -> 다음 유효 계정으로 같은 요청 즉시 재시도
  -> resetAt 이후 원래 계정을 다시 후보에 포함
```

유효한 다음 계정이 없다면 만료된 계정으로 전환하지 말고 원래 429를 명확히 반환해야 한다.

## 제안 수정 범위

- `usedPercent >= 95`에 의한 자동 pause를 제거한다.
- 95% 기준은 UI의 사용량 경고에만 사용한다.
- 실제 429 관측을 계정 전환과 cooldown의 기준으로 삼는다.
- 403 `permission_error` 계정을 `INELIGIBLE`로 분류하고 타깃/예비에서 제외한다.
- CLIProxy 라우팅을 순차 소진에 맞는 `fill-first`로 설정한다.
- `quota-exceeded.switch-project: true`를 유지하여 요청 시점의 전환과 재시도를 CLIProxy가 담당하게 한다.
- Baton 정책 엔진은 요청 단위 failover 대신 유효 계정 풀, cooldown 상태, reset 복귀 및 UI 관측을 관리한다.
- `docs/DESIGN.md`의 "오직 실제 429에만 반응"과 "95%에서 EXHAUSTED" 간 모순을 해소한다.

## 단기 복구 절차

자동 엔진이 다음 tick에서 상태를 되돌리지 않도록 먼저 정책 엔진을 중지한 뒤 다음 상태로 정리한다.

```text
active-max-account  -> resume
expired-test-account -> pause 또는 INELIGIBLE
```

이 절차는 영구 수정이 아니라 현재 서비스 복구용이다.

## 완료 조건

- 사용량이 95% 이상이지만 아직 429를 반환하지 않는 계정이 계속 요청을 처리한다.
- 실제 429가 발생하기 전에는 다른 계정으로 전환하지 않는다.
- 실제 429가 발생하면 같은 요청이 다음 유효 계정에서 재시도된다.
- 429 계정은 resetAt까지 cooldown되고 리셋 후 다시 후보에 포함된다.
- 403 OAuth 금지 또는 만료 계정은 자동 로테이션 후보에서 제외된다.
- 유효한 예비 계정이 없으면 만료 계정으로 라우팅하지 않고 명확한 429를 반환한다.
- `round-robin` 때문에 선택 계정이 요청마다 바뀌지 않는다.
- 정책 로그와 UI가 `429 cooldown`, `403 ineligible`, `사용량 경고`를 서로 다른 상태로 표시한다.
- 관련 단위 테스트와 실제 프록시 통합 테스트가 추가된다.

## 검증 시나리오

1. 주 계정 사용률을 95% 이상으로 모의하되 요청은 200을 반환하게 한다.
2. 여러 요청이 계속 주 계정으로 전달되는지 확인한다.
3. 주 계정이 429를 반환하도록 전환한다.
4. 동일 요청이 유효한 예비 계정으로 즉시 재시도되는지 확인한다.
5. 주 계정이 resetAt 전에는 선택되지 않고 이후 다시 후보가 되는지 확인한다.
6. 예비 계정이 403 `permission_error`를 반환하면 `INELIGIBLE`로 제외되는지 확인한다.
7. 유효 계정이 하나도 없을 때 잘못된 계정으로 전환하지 않는지 확인한다.
