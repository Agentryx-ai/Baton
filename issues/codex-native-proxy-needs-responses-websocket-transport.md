# Codex Native proxy는 Responses WebSocket transport를 지원해야 함

## 상태

- 상태: **미해결**
- 발견일: 2026-07-20
- 우선순위: P2

## 증상

Baton 서버에는 Responses WebSocket endpoint와 protocol 테스트가 구현돼 있지만 실제 Codex
CLI에는 capability가 광고되지 않아 모든 turn이 처음부터 HTTP transport를 사용한다.

2026-07-22 live canary:

```text
session: 52546795-7e80-46c4-a11d-881d5ef85ff1
turn 1: WS_CANARY_ONE_OK
turn 2: WS_CANARY_TWO_OK
native log: transport="responses_http"
request: POST http://127.0.0.1:<port>/v1/responses
markers: turn 1 http=3/ws=0, turn 2 http=2/ws=0
```

두 turn의 응답과 문맥 연속성은 정상이지만 수용 기준 1의 WebSocket 연결은 실패했다. probe
후 fallback한 것도 아니고 capability가 false라 WebSocket을 시도하지 않았다.

## 원인

- `server/session/codex-adapter.ts`의 custom provider override는 `name`, `base_url`, `env_key`,
  `wire_api`, retry만 설정하고 `model_providers.baton.supports_websockets=true`를 누락한다.
- Codex의 model provider info는 이 필드를 기본 `false`로 읽고, client는 false일 때
  WebSocket transport를 즉시 비활성화한다.
- `server/index.ts`의 endpoint attach와 `codex-native-websocket.ts`의 beta protocol 구현은
  존재하므로 서버 구현이 실제 client 경로에 도달하지 않는다.

현재 설치 Codex CLI는 `0.145.0`이며, isolated native log는 다음 위치에서 확인했다.

```text
C:\Users\MeroZemory\AppData\Local\Temp\baton-codex-mrEbr8\logs_2.sqlite
```

targeted 서버 테스트는 정상이다.

```text
npx tsx --test server/codex-native-websocket.test.ts server/codex-native-proxy.test.ts
8 tests passed
```

## 요구사항

- Codex가 사용하는 Responses WebSocket handshake와 frame 계약을 Native endpoint에서 지원한다.
- HTTP/SSE와 동일한 OAuth refresh, model-aware account selection, actual-429 failover와 health
  telemetry를 사용한다.
- client disconnect, upstream close, timeout과 partial response 이후 재시도 금지 규칙을 보존한다.
- WebSocket 지원 여부를 추측하지 않고 protocol/version capability로 협상한다.
- Baton custom provider override에 WebSocket capability를 명시하고 실제 설치 CLI에서
  `responses_websocket` transport provenance를 검증한다.

## 수용 기준

1. Codex CLI가 WebSocket 첫 시도에서 연결되고 HTTP fallback 지연이 사라진다.
2. streaming delta와 completed/error event가 순서와 payload 손실 없이 전달된다.
3. stream 시작 전 429는 다음 model-capable 계정으로 failover하고, 첫 frame 이후에는 재시도하지 않는다.
4. HTTP/SSE 회귀 테스트와 legacy client 동작이 유지된다.

