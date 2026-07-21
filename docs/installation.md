# Baton Installation Guide

이 문서는 Baton 설치를 맡은 AI 에이전트가 따라야 하는 실행 계약입니다. 기존 checkout과
사용자 설정을 보존하고, 필수 검증이 끝나기 전에는 설치 완료를 보고하지 마세요.

## 1. 사전 확인

변경 전에 다음 항목을 읽기 전용으로 확인하고 중요한 가정을 사용자에게 알립니다.

- OS, Git, Node.js와 npm 버전
- 기존 Baton checkout과 현재 Git 변경 사항
- 적용되는 `AGENTS.md`와 저장소 `README.md`
- 기존 `.env`의 존재 여부. 값은 출력하지 않습니다.
- 기존 Baton Native data directory와 legacy OAuth 원본의 존재 여부. 비밀값은 출력하지 않습니다.
- 실행 중인 Claude Code, Codex CLI/Desktop. 현재 에이전트 자신의 프록시 설정은 설치 도중
  변경하지 않습니다.

## 2. Checkout 준비

기존 Baton checkout이 있으면 사용자 변경과 `.env`를 보존한 채 그 위치를 재사용합니다.
없으면 사용자의 일반 프로젝트 디렉터리에 clone합니다. 적절한 위치를 확인할 수 없을 때만
`~/Baton`을 사용합니다.

```bash
git clone --branch feat/canonical-runtime-workspace https://github.com/Agentryx-ai/Baton.git
cd Baton
```

기존 파일을 삭제하거나 덮어써서 깨끗한 상태를 만들지 마세요. 변경이 설치 작업과 충돌하면
자동으로 reset하지 말고 정확한 충돌을 보고합니다.

## 3. 환경 설정

`.env`가 없을 때만 `.env.example`을 복사합니다.

```bash
cp .env.example .env
```

다음 값을 필요할 때만 설정합니다.

- `BATON_PORT` — 선택 사항, 기본값 `4400`
- `BATON_DATA_DIR` — 선택 사항. canonical SQLite, vault와 runtime state를 다른 위치에 저장할
  때만 지정

기존 설정이나 로컬 환경에서 안전하게 확인할 수 없는 비밀값만 사용자에게 요청합니다. 비밀값을
명령 출력, 로그 또는 최종 보고에 포함하지 마세요.

## 4. 설치와 검증

```bash
npm ci
npm run typecheck
npm run lint
npm test
npm run build
```

Codex CLI가 설치돼 있으면 다음 smoke test도 실행합니다.

```bash
npm run smoke:codex-adapter
```

Codex CLI에서 OpenAI primary-runtime 문서 plugin을 사용할 경우 Baton의 repo-local
compatibility marketplace와 bridge plugin도 설치합니다. Marketplace source는 checkout root입니다.

```bash
codex plugin marketplace add <BATON_CHECKOUT>
codex plugin add baton-codex-runtime-bridge@baton-local
```

`codex debug prompt-input`에 `baton-codex-runtime-bridge:resolve-codex-runtime`이 나타나는지
확인합니다. 이 bridge는 `load_workspace_dependencies`가 없는 CLI에서만 쓰며, 공식 loader가
추가되면 loader를 우선합니다.

Codex 연동 적용은 새 세션에 built-in `openai` provider를 사용합니다. Baton은 과거 세션
metadata의 `model_provider=baton`도 재개할 수 있도록 같은 Native endpoint를 가리키는 인증 없는
loopback compatibility provider를 함께 유지합니다. 이 alias는 CLIProxy 선택지가 아니며
`BATON_PROXY_TOKEN` 환경변수에 의존하지 않습니다.

검증이 실패하면 오류 원인을 확인하고 설치에 필요한 최소 변경만 적용한 뒤 실패한 검사와 관련
전체 검사를 다시 실행합니다. Provider OAuth나 추가 계정이 없어 live 검증만 실패한 경우에도
Baton 자체 build/test 결과와 외부 blocker를 구분해 보고합니다.

## 5. 실행 확인

```bash
npm run install:bootstrap:dev
npm start
```

첫 명령은 Worker와 별개로 동작하는 offline recovery 실행 파일을
`%LOCALAPPDATA%\Baton\bootstrap`에 staging→hash/self-test→atomic activation 순서로 설치합니다.
P1 Task가 `worker-runner`로 stable exe를 실행 중이면 Windows가 그 exe 교체를 잠글 수 있으므로
bootstrap upgrade 전에 `baton stop`으로 owned Worker Task를 명시적으로 중지합니다. installer는 잠긴
entry를 우회하거나 Task를 자동 변경하지 않고 전체 전환을 rollback합니다.
이 명령은 이름과 flag에서 드러나듯 unsigned local-development 설치에 대한 명시적 opt-in입니다.
unsigned SEA는 SmartScreen/AppLocker 정책에 따라 실행되지 않을 수 있고, 전역 integration apply는
`BATON_ALLOW_UNSIGNED_BOOTSTRAP=1`을 별도로 지정한 개발 실행에서만 허용됩니다. production에서는
SEA 생성 후 조직의 release signing 단계로 Authenticode 서명하고 다음처럼 실제 signer thumbprint를
검증해 설치해야 합니다.

```powershell
npm run build:bootstrap
# .tmp\bootstrap-build\baton-bootstrap.exe를 승인된 release key로 서명
node node_modules\tsx\dist\cli.mjs scripts\install-baton-bootstrap.ts `
  --artifact .tmp\bootstrap-build\baton-bootstrap.exe `
  --signed-release-thumbprint <APPROVED_CERT_THUMBPRINT>
```

Baton은 production apply 직전에도 artifact hash, schema, self-test와 Authenticode signer identity를
다시 검증합니다. 이때 Worker를 시작하는 배포 정책에서 active manifest와 별도로 다음 값을
주입해야 하며, manifest가 자기 signer를 임의로 승인할 수 없습니다.

```powershell
$env:BATON_APPROVED_SIGNER_THUMBPRINT='<APPROVED_CERT_THUMBPRINT>'
```

`active.json`은 같은 사용자에게 쓰기 가능한 lifecycle/deployment metadata이지 외부 signer trust
anchor가 아닙니다. 위 환경값도 같은 사용자가 자유롭게 바꿀 수 있는 실행이라면 강한 적대자 경계를
제공하지 않으므로, production 배포기는 승인 thumbprint와 Worker launch policy를 별도 ACL/관리
정책으로 보호해야 합니다. Baton의 이 검증은 손상·잘못된 release와 정책 불일치를 fail closed하는
계약이며 동일 사용자 관리자에 대한 완전한 방어 주장은 아닙니다. 현재 저장소 자체에는 signing
key/서명 파이프라인이 없으므로 unsigned local
artifact를 production-ready라고 주장하지 않습니다. 생성 exe는 build 산출물이며 저장소에 commit하지
않습니다.

Worker와 `active.json`이 모두 손상돼도 다음 고정 경로는 manifest 없이 P0 status/remove를 실행합니다.

```powershell
& "$env:LOCALAPPDATA\Baton\bootstrap\baton-bootstrap.exe" integration status
& "$env:LOCALAPPDATA\Baton\bootstrap\baton-bootstrap.exe" integration remove --target codex
& "$env:LOCALAPPDATA\Baton\bootstrap\baton-bootstrap-lkg.exe" integration status
```

`active.json` lifecycle metadata가 손상됐으면 실행 중인 active exe가 자신을 교체하지 않도록 반드시
고정 LKG entry에서 다음 명령을 실행합니다.

```powershell
& "$env:LOCALAPPDATA\Baton\bootstrap\baton-bootstrap-lkg.exe" recover-active --from-lkg
```

다음을 확인합니다.

- `http://127.0.0.1:4400/baton/health`가 JSON health 응답을 반환함
- `http://127.0.0.1:4400`에서 대시보드가 열림
- `node scripts/baton-cli.mjs status`가 Baton과 integration 상태를 출력함
- `npm run verify:bootstrap`이 격리 프로필에서 standalone 복구, 동시 설치 배제와 rollback을 검증함

운영체제 부팅 자동 시작은 사용자의 명시적 승인 없이 등록하지 않습니다.

## 6. 클라이언트 연결

설치 작업을 실행 중인 Claude Code 또는 Codex 자신의 설정을 세션 도중 바꾸지 않습니다.
설치와 검증이 끝난 뒤 사용자가 대상 CLI/Desktop을 완전히 종료하고 Baton 설정 UI에서 각
클라이언트의 Baton Native 연결을 적용하도록 안내합니다.

- Baton Native는 Claude/Codex credential, refresh, quota, plugin 인증과 failover를 직접 소유합니다.
- Codex는 built-in `openai` provider identity를 유지해 기존 OpenAI thread 목록을 보존합니다.
- legacy proxy OAuth가 발견되면 `npm run migrate:legacy-accounts`로 Native vault에 한 번 이전합니다.

설정을 적용하거나 해제한 뒤에는 해당 클라이언트를 완전히 재시작합니다.

## 7. 완료 보고

다음 항목만 간결히 보고합니다.

- 설치 경로와 branch/commit
- 의존성 설치, typecheck, lint, test, build와 선택 smoke 결과
- Codex를 사용하는 경우 runtime bridge plugin 설치/검증 결과
- Baton 실행 상태와 대시보드 URL
- 재실행 명령과 종료 방법
- OAuth/login이나 추가 계정처럼 사용자가 직접 처리해야 하는 남은 조건

필수 검증 실패, health 실패 또는 unresolved 설정 충돌이 있으면 설치 완료로 표시하지 않습니다.
