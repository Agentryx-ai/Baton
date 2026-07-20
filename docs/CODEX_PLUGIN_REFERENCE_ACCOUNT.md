# Codex 플러그인 기준계정

## 목적

Codex의 모델 요청을 보내는 계정과 원격 플러그인 catalog·connector 권한을 조회하는 계정은
수명주기와 운영 목적이 다릅니다. Baton은 둘을 분리해, 모델 라우팅에서 일시정지한 계정도
플러그인 기준계정으로 계속 사용할 수 있게 합니다.

이 기능은 Codex 자체에 여러 동시 로그인을 추가하지 않습니다. Baton Native vault에 이미 등록된
Codex 계정의 OAuth credential을 갱신하고, 짧게 실행한 공식 Codex app-server 자식 프로세스에
`CODEX_ACCESS_TOKEN`으로만 전달합니다. 사용자의 전역 `auth.json`은 수정하지 않습니다.

## 공식 API 경계

Baton은 Codex app-server가 공개하는 다음 메서드만 사용합니다.

- `plugin/list` — local, vertical, workspace-directory, shared-with-me,
  created-by-me-remote catalog 조회
- `plugin/install` — local marketplace path 또는 remote marketplace name 중 하나로 설치
- `plugin/uninstall` — plugin ID로 제거

Desktop의 비공개 프로토콜을 역공학하거나 별도 marketplace backend를 재구현하지 않습니다.
자식 환경에서는 기존 `CODEX_ACCESS_TOKEN`, OpenAI/Codex API key, `BATON_*`, `GATEWAY_*`를
제거한 뒤 선택 계정의 access token만 주입합니다.

## 전환 계약

기본 상태는 `local_only`입니다. 계정 전환은 다음 순서로 처리합니다.

1. 현재/대상 catalog를 조회해 추가·제거·유지 plugin을 미리 계산합니다.
2. 상태 revision, 대상 account revision과 두 catalog의 digest를 확인합니다.
3. 기준계정을 원자적으로 저장합니다.
4. 대상 credential을 강제 refresh하고 catalog를 다시 확인합니다.
5. 확인이 실패하면 이전 기준으로 rollback합니다.

선택된 기준계정은 바로 삭제할 수 없습니다. UI에서 다른 계정 또는 local-only로 전환한 뒤
삭제하며, 이 과정도 동일한 preview와 확인 계약을 거칩니다.

## 계정에 귀속되는 것과 아닌 것

- Local/repo marketplace와 설치 상태는 일반 `CODEX_HOME` 및 현재 working directory에
  귀속됩니다. 플러그인 기준계정의 소유물이 아닙니다.
- Remote global/workspace/shared catalog와 connector/private workspace 권한은 선택 계정 및
  workspace 정책의 영향을 받습니다.
- Connector authorization은 계정 사이에 자동 이전되지 않습니다. 전환 후 재인증이 필요할 수
  있습니다.
- ChatGPT plan, workspace role과 관리자의 허용 정책에 따라 같은 Codex 버전에서도 catalog가
  달라질 수 있습니다.

## 검증 상태

- 단위/통합 테스트: local-only, 중지 계정 사용, preview diff, stale revision/digest 거부,
  전환 성공, 확인 실패 rollback, 삭제 보호, 상태 fail-closed, install XOR 계약
- 설치된 Codex app-server local-only canary: 공식 primary-runtime, bundled/curated cache,
  Baton repo-local marketplace 열거 및 load error 0건
- 남은 live gate: Baton Native Codex 계정을 등록한 환경에서 remote account catalog와 connector
  재인증을 실제 확인
