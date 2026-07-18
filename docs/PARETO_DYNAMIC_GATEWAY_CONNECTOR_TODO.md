# Pareto용 동적 Gateway Connector 선행 TODO

상태: 미구현. 이 계약과 conformance test가 완료되기 전에는 Pareto에 Baton 이름 기반 특례나 자동
discovery를 추가하지 않는다. 완료 후에도 preset이 아니라 generic dynamic resolver로 연결한다.

## 배경

현재 Baton은 gateway 관리 API의 proxy status와 raw token 응답을 별도로 조회해 실행 중인 CLIProxy
connection을 내부에서 구성한다. 현재 기본 포트는 외부 소비자에게 보장된 고정 endpoint가 아니며, 향후
Electron/Desktop과 sidecar 구조에서는 port와 process lifecycle이 더 명시적으로 분리될 수 있다.

Pareto는 그 전까지 사용자가 endpoint와 credential 환경변수 참조를 직접 입력하는 범용 static
`GatewayProfile`만 제공한다. Pareto가 Baton의 비공개 관리 API나 raw-token endpoint를 호출해서는 안 된다.
대응 설계는 `ParetoPilot/docs/generic-gateway-profiles.ko.md`에 있다.

## 공개 connector 계약

- [ ] OS 사용자별 IPC를 우선 제공한다. Windows named pipe는 사용자 SID ACL, Unix는 user runtime-dir
  socket 권한을 강제한다. 파일 descriptor를 제공한다면 well-known platform path에 사용자 ACL을 적용하고
  atomic replace해야 한다.
- [ ] optional `baton gateway describe --json`은 같은 권위 source를 읽을 수 있지만 raw credential을
  stdout에 출력하지 않는다.
- [ ] discovery 응답은 `schema_version`, `instance_id`, `instance_epoch`, `descriptor_revision`, PID,
  started-at, heartbeat/expiry를 포함한다.
- [ ] `openai_responses`, `anthropic_messages`, `openai_chat_completions`별 exact base/path와 auth scheme을
  versioned field로 제공한다. 소비자가 한 base URL에서 path를 추정하게 하지 않는다.
- [ ] credential 발급/reference는 discovery와 같은 authenticated transaction에서 instance ID/epoch에
  결합한다. audience=`pareto`, provider scope, expiry와 rotation semantics를 포함한다.
- [ ] health/capability는 BFF 생존뿐 아니라 data-plane과 provider readiness, model catalog schema,
  protocol version, optional affinity support를 구분한다.
- [ ] account/session affinity를 제공한다면 key/header, scope, TTL, rotation 계약을 공개한다. 현재 global
  management toggle은 외부 run/turn affinity 계약으로 간주하지 않는다.

## lifecycle 계약

- [ ] Pareto가 한 provider request 또는 turn을 시작하면 exact instance/epoch/credential lease를 끝까지
  고정할 수 있어야 한다.
- [ ] 새 request 전 안전 경계에서만 rediscovery한다.
- [ ] dispatch 뒤 instance/epoch 변경이나 mid-stream 종료는 provider idempotency가 입증되지 않으면
  unknown outcome/reconciliation 대상으로 보고하며 자동 replay하지 않는다.
- [ ] proxy/provider 장애 시 direct endpoint로 fallback하지 않는다.
- [ ] token rotation은 기존 lease의 유효 종료 시점과 새 lease 적용 경계를 명시한다.

## 필수 conformance test

- [ ] Desktop/BFF/sidecar restart와 동적 port 변경
- [ ] token rotation과 expired credential
- [ ] stale descriptor, 죽은 PID, heartbeat 만료
- [ ] 다른 instance의 endpoint와 credential을 섞은 요청 거부
- [ ] provider별 ready/unready와 catalog 불일치
- [ ] 요청 전후 epoch 변경과 mid-stream process death
- [ ] direct fallback이 발생하지 않음
- [ ] credential과 raw account identifier가 descriptor, log, CLI stdout에 노출되지 않음
- [ ] Gemini live authentication과 Codex native bridge의 fail-closed live smoke

## 완료 후 Pareto 연결 방식

Baton은 Pareto core의 특별 provider나 preset이 되지 않는다. 공개 discovery 계약을 소비하는 optional
resolver plugin이 범용 immutable `GatewayProfile` snapshot을 생성한다. core의 이름 비교나 고정 포트
분기는 금지하고 capability negotiation으로만 선택 기능을 활성화한다.
