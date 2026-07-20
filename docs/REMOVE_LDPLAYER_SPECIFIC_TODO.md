# LDPlayer 전용 기능 제거 작업 목록

> 상태: Native Claude Proxy 목표 완료 후 착수
> 작성일: 2026-07-20 (Asia/Seoul)

## 배경

Baton의 Android 자동화는 특정 에뮬레이터 제품에 종속될 필요가 없다. LDPlayer도 표준 ADB로
접근할 수 있으므로 제품명, 설치 경로, 전용 instance 탐지 및 전용 연결 API를 제거하고 범용 ADB
device serial/endpoint 계약만 유지한다.

## 목적과 범위

- 범용 `adb devices`, `adb connect <host:port>`, device serial 선택을 보존한다.
- screenshot, input, shell 등 기존 Android 작업은 선택된 ADB device에서 계속 동작해야 한다.
- LDPlayer 실행 파일·설치 경로·instance index·제품명에 의존하는 탐지와 UI를 제거한다.
- 저장된 LDPlayer 전용 session/config는 범용 ADB target으로 안전하게 migration하거나 명시적으로
  지원 종료 오류를 제공한다.
- Native Claude Proxy 작업과 무관한 이미지 artifact 기능은 보존한다.

## 구현 작업

- [ ] `ldplayer-runtime`의 책임을 범용 `adb-runtime` 계약과 제품 전용 탐지로 분류
- [ ] 범용 ADB로 이미 대체 가능한 tool/API/event/schema 목록 확정
- [ ] 저장된 session 및 SQLite column의 호환/migration 정책 확정
- [ ] 서버의 LDPlayer 전용 route, runtime 등록, orchestration branch 제거
- [ ] UI의 LDPlayer 전용 연결 상태, 버튼, 안내 문구 제거
- [ ] 범용 ADB device 목록·연결·선택 UX로 기존 진입점 대체
- [ ] LDPlayer 명칭이 남은 type, test fixture, README 및 운영 문서 정리
- [ ] clean database와 기존 database migration test 통과
- [ ] 실제 ADB device/emulator에서 connect, screenshot, input, shell smoke 통과
- [ ] `rg -i "ldplayer|ld player|LD 플레이어"` 잔여 결과가 migration note 외에는 없음
- [ ] typecheck, lint, build 및 관련 전체 test 통과

## 현재 발견된 영향 범위

- 서버: `server/session/tools/ldplayer-runtime.ts`, session domain/router/runtime/orchestrator/store
- UI: conversation API/types/workspace, 설정 화면
- 문서: `README.md`, `docs/HOST_AUTOMATION.md`, `docs/USER_REQUEST_STATUS.md`
- 테스트: runtime, SQLite, orchestrator, stateless adapter, image artifact 관련 fixture

이미지 artifact test의 LDPlayer 문자열은 실제 제품 종속인지 단순 fixture인지 구분한 뒤 수정한다.
전용 기능 제거를 이유로 범용 이미지 첨부/표시 기능을 삭제하지 않는다.
