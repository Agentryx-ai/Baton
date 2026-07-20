# Codex workspace command가 codex-path를 상속해야 함

## 상태

- 상태: 부분 해결
- 발견일: 2026-07-21
- 우선순위: P0
- 구현 커밋: `df8c7cc`

## 증상

Canonical 대화의 `run_command`가 `rg`를 실행하면 다음 오류로 실패했다.

```text
tool_io_error: spawn rg ENOENT
```

같은 PC의 Codex CLI에서는 `rg`가 동작하므로 모델이나 작업 폴더 문제가 아니라 Baton 실행 환경의
차이였다.

## 원인

Baton은 설치된 Codex 패키지의 `codex.exe`를 직접 찾았지만, 그 실행 파일과 함께 배포된
`codex-path` 디렉터리를 버렸다. `FullAccessCommandRunner`는 Baton 서버의 PATH만으로
`spawn(argv[0])`을 호출했다.

Codex CLI와 Desktop app-server가 사용하는 공식 진입 경로는 실행 전에 `codex-path`를 PATH에
추가한다. Windows 패키지의 `rg.exe`도 이 디렉터리에 있다. 따라서 이 오류는 Codex 자체 문제가
아니라 Baton만의 런타임 조립 결함이다.

## 구현

- Codex 실행 파일과 인접 `codex-path`를 하나의 runtime 정보로 탐색한다.
- `rg.exe`가 실제 존재할 때만 sandbox 및 full-access 자식 프로세스 PATH 앞에 추가한다.
- 서버 전역 `process.env`는 변경하지 않는다.
- PATH 항목은 Windows에서 대소문자를 무시해 중복 제거한다.
- 기존 Baton 및 Gateway 비밀 제거 규칙을 유지한다.
- 실행 파일 부재는 원시 `tool_io_error` 대신 `command_not_found`로 반환한다.

## 검증

- focused workspace runtime tests 15개 통과
- startup read-only recovery focused tests 2개 통과
- 전체 557 tests 통과
- typecheck, lint, production build, `git diff --check` 통과
- 린트의 Fast Refresh 경고 3개와 build chunk 크기 경고는 기존 경고이며 이번 변경 오류가 아니다.

## 남은 완료 조건

- 현재 4400의 진행 중 Goal이 안전 경계에 도달한 뒤 수정본으로 한 번의 stop-start handoff를 수행한다.
- 재시작한 실제 DaeumKkini 세션에서 `run_command`가 bare `rg`를 정상 탐색하는지 확인한다.
- 동일 세션에서 `spawn rg ENOENT`가 재발하지 않음을 확인한 뒤 이 문서를 `_archived`로 이동한다.

