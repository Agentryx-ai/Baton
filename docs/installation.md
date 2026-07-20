# Baton Installation Guide

이 문서는 Baton 설치를 맡은 AI 에이전트가 따라야 하는 실행 계약입니다. 기존 checkout과
사용자 설정을 보존하고, 필수 검증이 끝나기 전에는 설치 완료를 보고하지 마세요.

## 1. 사전 확인

변경 전에 다음 항목을 읽기 전용으로 확인하고 중요한 가정을 사용자에게 알립니다.

- OS, Git, Node.js와 npm 버전
- 기존 Baton checkout과 현재 Git 변경 사항
- 적용되는 `AGENTS.md`와 저장소 `README.md`
- 기존 `.env`의 존재 여부. 값은 출력하지 않습니다.
- gateway 관리 API와 CLIProxy의 실행 상태. 발견되지 않아도 임의의 외부 backend를 설치하지
  않습니다.
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

다음 값을 설정합니다.

- `GATEWAY_URL` — 기본값 `http://localhost:3000`
- `GATEWAY_USER`, `GATEWAY_PASS` — gateway 관리 API 자격 증명
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

검증이 실패하면 오류 원인을 확인하고 설치에 필요한 최소 변경만 적용한 뒤 실패한 검사와 관련
전체 검사를 다시 실행합니다. Gateway 또는 CLIProxy가 없어서 외부 연동 검증만 실패한 경우에도
Baton 자체 build/test 결과와 외부 blocker를 구분해 보고합니다.

## 5. 실행 확인

```bash
npm start
```

다음을 확인합니다.

- `http://127.0.0.1:4400/baton/health`가 JSON health 응답을 반환함
- `http://127.0.0.1:4400`에서 대시보드가 열림
- `node scripts/baton-cli.mjs status`가 Baton과 integration 상태를 출력함

운영체제 부팅 자동 시작은 사용자의 명시적 승인 없이 등록하지 않습니다.

## 6. 클라이언트 연결

설치 작업을 실행 중인 Claude Code 또는 Codex 자신의 설정을 세션 도중 바꾸지 않습니다.
설치와 검증이 끝난 뒤 사용자가 대상 CLI/Desktop을 완전히 종료하고 Baton 설정 UI에서 각
클라이언트의 integration mode를 선택하도록 안내합니다.

- Baton Native는 Claude/Codex credential, refresh와 failover를 Baton이 직접 소유하는 경로입니다.
- CLIProxy는 기존 설치와의 호환 경로입니다. 필요한 backend가 없으면 임의로 설치하지 않습니다.
- Codex의 기존 OpenAI thread 목록을 유지하려면 `native-openai` 모드를 선택합니다.

설정을 적용하거나 해제한 뒤에는 해당 클라이언트를 완전히 재시작합니다.

## 7. 완료 보고

다음 항목만 간결히 보고합니다.

- 설치 경로와 branch/commit
- 의존성 설치, typecheck, lint, test, build와 선택 smoke 결과
- Baton 실행 상태와 대시보드 URL
- 재실행 명령과 종료 방법
- gateway/CLIProxy/OAuth/login처럼 사용자가 직접 처리해야 하는 남은 조건

필수 검증 실패, health 실패 또는 unresolved 설정 충돌이 있으면 설치 완료로 표시하지 않습니다.
