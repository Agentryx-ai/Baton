# Codex Native proxy는 Responses WebSocket transport를 지원해야 함

## 상태

- 상태: **미해결**
- 발견일: 2026-07-20
- 우선순위: P2

## 증상

Codex CLI 0.144.6은 Responses WebSocket을 먼저 시도한다. Baton Native proxy는 현재 HTTP/SSE만
지원하므로 WebSocket 시도가 실패한 뒤 HTTP로 fallback하며 turn 시작이 약 7초 늦어진다.
최종 응답은 성공하므로 기능 중단은 아니지만 모든 Codex turn에 불필요한 지연과 오류 로그가
발생할 수 있다.

## 요구사항

- Codex가 사용하는 Responses WebSocket handshake와 frame 계약을 Native endpoint에서 지원한다.
- HTTP/SSE와 동일한 OAuth refresh, model-aware account selection, actual-429 failover와 health
  telemetry를 사용한다.
- client disconnect, upstream close, timeout과 partial response 이후 재시도 금지 규칙을 보존한다.
- WebSocket 지원 여부를 추측하지 않고 protocol/version capability로 협상한다.

## 수용 기준

1. Codex CLI가 WebSocket 첫 시도에서 연결되고 HTTP fallback 지연이 사라진다.
2. streaming delta와 completed/error event가 순서와 payload 손실 없이 전달된다.
3. stream 시작 전 429는 다음 model-capable 계정으로 failover하고, 첫 frame 이후에는 재시도하지 않는다.
4. HTTP/SSE 회귀 테스트와 legacy client 동작이 유지된다.

