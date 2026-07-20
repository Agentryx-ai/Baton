# Codex 플러그인 기준계정

## 목적

Codex의 모델 요청을 보내는 계정과 원격 플러그인 catalog·connector 권한을 조회하는 계정은
수명주기와 운영 목적이 다릅니다. Baton은 둘을 분리해, 모델 라우팅에서 일시정지한 계정도
플러그인 기준계정으로 계속 사용할 수 있게 합니다.

이 기능은 Codex 자체에 여러 동시 로그인을 추가하지 않습니다. Baton Native vault에 이미 등록된
Codex 계정의 OAuth credential을 갱신하고, 짧게 실행한 공식 Codex app-server 자식 프로세스에
공식 `account/login/start`의 `chatgptAuthTokens` 입력으로 전달합니다. 사용자의 전역 `auth.json`은
수정하지 않습니다. Settings의 `플러그인 계정 추가`도 별도 credential 저장소를 만들지 않고
Native OAuth vault에 계정을 추가하며, 플러그인 전용으로 추가한 계정은 모델 라우팅이 기본
중지된 상태로 저장됩니다.

계정 모드의 catalog·remote install·uninstall 요청은 login 완료 notification을 확인한 뒤에만
plugin 요청을 진행합니다. Native credential manager가 먼저 access token을 refresh하며, 로그인
실패나 불완전 credential은 catalog 접근 성공으로 취급하지 않습니다.

## 공식 API 경계

Baton은 Codex app-server가 공개하는 다음 메서드만 사용합니다.

- `plugin/list` — local, vertical, workspace-directory, shared-with-me,
  created-by-me-remote catalog 조회
- `plugin/install` — local marketplace path 또는 remote marketplace name 중 하나로 설치
- `plugin/uninstall` — plugin ID로 제거

Desktop의 비공개 프로토콜을 역공학하거나 별도 marketplace backend를 재구현하지 않습니다.
자식 환경에서는 기존 `CODEX_ACCESS_TOKEN`, OpenAI/Codex API key, `BATON_*`, `GATEWAY_*`를
제거합니다. 선택 계정 token은 환경변수나 전역 파일이 아니라 app-server JSON-RPC 요청에만
포함되며 로그에 기록하지 않습니다.

## 전환 계약

기본 상태는 `local_only`입니다. 계정 전환은 다음 순서로 처리합니다.

1. 현재/대상 catalog를 조회해 추가·제거·유지 plugin을 미리 계산합니다.
2. 상태 revision, 대상 account revision과 두 catalog의 digest를 확인합니다.
3. 기준계정을 원자적으로 저장합니다.
4. 대상 credential을 강제 refresh하고 catalog를 다시 확인합니다.
5. 확인이 실패하면 이전 기준으로 rollback합니다.

현재 기준계정이 삭제됐거나 credential이 폐기되어 기존 catalog를 읽을 수 없는 경우에는 차이를
추측하지 않고 `변경 차이 확인 불가`로 표시합니다. 새 대상 catalog 검증은 그대로 요구하며,
검증된 다른 계정 또는 local-only로 복구하는 전환은 허용합니다.

선택된 기준계정은 바로 삭제할 수 없습니다. UI에서 다른 계정 또는 local-only로 전환한 뒤
삭제하며, 이 과정도 동일한 preview와 확인 계약을 거칩니다.

## 계정에 귀속되는 것과 아닌 것

- Local/repo marketplace와 설치 상태는 일반 `CODEX_HOME` 및 현재 working directory에
  귀속됩니다. 플러그인 기준계정의 소유물이 아닙니다.
- Remote global/workspace/shared catalog와 connector/private workspace 권한은 선택 계정 및
  workspace 정책의 영향을 받습니다.
- Connector authorization은 계정 사이에 자동 이전되지 않습니다. 전환 후 재인증이 필요할 수
  있습니다.
- 설치 응답이 인증이 필요한 app을 반환하면 Baton은 이름을 표시하지만, 실제 connector
  authorization은 Codex/ChatGPT의 지원 UI에서 완료해야 합니다.
- ChatGPT plan, workspace role과 관리자의 허용 정책에 따라 같은 Codex 버전에서도 catalog가
  달라질 수 있습니다.

현재 Baton은 한 번에 하나의 기준계정만 활성화합니다. 두 계정의 원격 catalog를 동시에 합쳐
노출하거나 connector authorization을 중계하지 않습니다. 전환 preview를 위해 현재/대상 catalog를
각각 조회할 뿐이며, 다중 계정 catalog federation은 별도 provenance·cache invalidation·권한 모델이
필요한 후속 범위입니다.

## 검증 상태

- 단위/통합 테스트: local-only, 중지 계정 사용, preview diff, stale revision/digest 거부,
  전환 성공, 확인 실패 rollback, 삭제 보호, 상태 fail-closed, install XOR 계약
- 설치된 Codex app-server local-only canary: 공식 primary-runtime, bundled/curated cache,
  Baton repo-local marketplace 열거 및 load error 0건
- Baton Native 실제 계정 canary: account 전환·검증·원복, marketplace 4개, plugin 191개,
  load error 0건
- 남은 live gate: connector별 재인증과 private workspace 권한을 실제 연결 화면에서 확인

Native 계정 등록 후 다음 명령으로 검증합니다. 기본 명령은 preview만 수행하며, `--apply`는
기준계정을 잠시 전환해 catalog를 확인한 뒤 원래 기준으로 복원합니다.

```bash
npm run smoke:codex-plugins -- --account <native-account-id>
npm run smoke:codex-plugins -- --account <native-account-id> --apply
```

다른 Baton 포트를 검증할 때는 `BATON_URL`을 지정합니다. 기존 기준이 이미 손상된 상태에서는
자동 복원을 보장할 수 없으므로 `--apply`를 거부하고 Settings에서 먼저 복구하도록 합니다.
