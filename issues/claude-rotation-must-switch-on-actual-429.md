# Claude 계정은 실제 429 이후에만 전환해야 함

## 상태

- 코드·단위 검증: 95/100% 자동 pause 및 pool 축소 해결
- live 검증 대기: 실제 429 same-request failover와 reset 복귀
- 403 durable 상태 계약 대기
- 발견일: 2026-07-19

## 요약

Baton의 스마트 로테이션 엔진은 과거 Claude 계정의 `usedPercent`가 95 이상이면 실제 사용 가능 여부와 관계없이 `EXHAUSTED`로 분류하고 pause했다. 이 때문에 아직 정상 요청이 가능한 Max 계정이 실제 HTTP 429 전에 비활성화됐고, 만료된 테스트 계정이 유일한 타깃으로 선택됐다. 이 선제 pause는 제거됐으며 남은 blocker는 durable 403 eligibility 계약이다.

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

### 1. 95%를 실제 소진으로 간주함 — 해결

라우팅 임계값과 `EXHAUSTED` 분류를 제거했다. 95/98/100%는 UI 경고 데이터로만 남고,
실제 429 전까지 ACTIVE로 순위와 유효 풀에 포함된다.

### 2. 요청 시점의 429가 아니라 60초 쿼터 폴링으로 전환함

Baton 정책 엔진은 60초 주기로 관리 API의 쿼터를 읽는다. 그러나 정확한 429 발생 순간과 실패한 요청의 재시도는 실제 요청 경로인 CLIProxy만 처리할 수 있다. Baton의 폴링은 즉시 전환 수단이 될 수 없다.

### 3. 사용할 수 없는 계정을 유효한 예비 계정으로 취급함 — 자동 판정 차단

만료된 테스트 계정은 Claude Code OAuth 요청에 대해 403을 반환한다. 그러나 현재 CLIProxy
accounts/quota 관리 API는 계정별 마지막 403 또는 durable `INELIGIBLE` 상태를 노출하지 않는다.
Baton이 쿼터나 오류 문자열로 이를 추정하면 정상 계정을 다시 잘못 제외할 수 있으므로 자동 판정하지
않는다. 현재 fail-safe는 해당 계정의 명시적 수동 pause이며, CLIProxy가 durable 상태/API를 제공한
뒤에만 자동 제외를 구현한다.

### 4. 현재 프록시 전략이 순차 소진 목표와 다름 — 해결

확인 당시 CLIProxy 설정은 다음과 같았다.

```yaml
disable-cooling: true
quota-exceeded:
  switch-project: true
routing:
  strategy: round-robin
```

엔진 enable/start는 설치된 관리 계약 `PUT /api/cliproxy/routing/strategy`
`{value:'fill-first'}`를 먼저 성공시킨다. 실패하면 enabled 상태와 timer를 시작하지 않는다.
ON 동안에도 매 tick 계약을 재확인하고 실패하면 즉시 OFF로 전환한다. UI는 정책 ON 동안
전략 변경을 잠근다.
실제 429/cooling/같은 요청의 다음 계정 failover는 CLIProxy 기본 동작의 권한이다.

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
- 403은 CLIProxy가 계정별 durable 상태/API를 노출하기 전에는 추정하지 않는다. 그 전에는 명시적
  수동 pause로 제외하고 엔진은 이를 resume하지 않는다.
- CLIProxy 라우팅을 순차 소진에 맞는 `fill-first`로 설정한다.
- `quota-exceeded.switch-project: true`를 유지하여 요청 시점의 전환과 재시도를 CLIProxy가 담당하게 한다.
- Baton 정책 엔진은 모든 비수동-pause 계정을 유효 풀에 남긴다. 두 계정으로 줄여 세 번째 유효
  failover를 차단하지 않는다. cooldown/reset 복귀는 CLIProxy, quota/순위 관측은 Baton의 권한이다.
- OFF 전환은 `recoveryPending` journal을 먼저 저장하고 과거 engine-owned pause를 복구한다. 중간에
  프로세스가 종료돼도 다음 시작에서 enabled=false 상태로 복구를 재개한다.
- `docs/DESIGN.md`의 "오직 실제 429에만 반응"과 "95%에서 EXHAUSTED" 간 모순을 해소한다.

## 단기 복구 절차

자동 엔진이 다음 tick에서 상태를 되돌리지 않도록 먼저 정책 엔진을 중지한 뒤 다음 상태로 정리한다.

```text
active-max-account  -> resume
expired-test-account -> 수동 pause 유지 (durable INELIGIBLE API 제공 전 자동 추정 금지)
```

이 절차는 영구 수정이 아니라 현재 서비스 복구용이다.

## 완료 조건

- 사용량이 95% 이상이지만 아직 429를 반환하지 않는 계정이 계속 요청을 처리한다.
- 실제 429가 발생하기 전에는 다른 계정으로 전환하지 않는다.
- 실제 429가 발생하면 같은 요청이 다음 유효 계정에서 재시도된다.
- 429 계정은 resetAt까지 cooldown되고 리셋 후 다시 후보에 포함된다.
- 403 OAuth 금지 또는 만료 계정은 명시적 수동 pause로 제외된다. durable 상태/API 없이는 자동화하지 않는다.
- 유효한 예비 계정이 없으면 만료 계정으로 라우팅하지 않고 명확한 429를 반환한다.
- `round-robin` 때문에 선택 계정이 요청마다 바뀌지 않는다.
- 429/cooling은 CLIProxy 상태, 사용량 경고는 Baton telemetry로 구분한다. `403 ineligible` 표시는
  durable upstream 증거가 생기기 전까지 미지원으로 명시한다.
- 관련 단위 테스트와 실제 프록시 통합 테스트가 추가된다.

## 검증 시나리오

1. 주 계정 사용률을 95% 이상으로 모의하되 요청은 200을 반환하게 한다.
2. 여러 요청이 계속 주 계정으로 전달되는지 확인한다.
3. 주 계정이 429를 반환하도록 전환한다.
4. 동일 요청이 유효한 예비 계정으로 즉시 재시도되는지 확인한다.
5. 주 계정이 resetAt 전에는 선택되지 않고 이후 다시 후보가 되는지 확인한다.
6. 수동 pause 계정은 선택/resume되지 않는지 확인한다. 향후 CLIProxy durable eligibility 계약이
   추가되면 403 `INELIGIBLE` 자동 제외 통합 테스트를 별도로 추가한다.
7. 유효 계정이 하나도 없을 때 잘못된 계정으로 전환하지 않는지 확인한다.
