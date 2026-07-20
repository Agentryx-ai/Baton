# LDPlayer 전용 기능 제거 작업 목록

> 상태: core 제거 완료, 선택적 플러그인/내부 확장만 허용
> 작성일: 2026-07-20 (Asia/Seoul)

## 배경

Baton의 Android 자동화는 특정 에뮬레이터 제품에 종속될 필요가 없다. LDPlayer도 표준 ADB로
접근할 수 있으므로 제품명, 설치 경로, 전용 instance 탐지 및 전용 연결 API를 제거하고 범용 ADB
device serial/endpoint 계약만 유지한다.

## 목적과 범위

- 범용 `adb devices`, `adb connect <host:port>`, device serial 선택은 Full access의 direct argv로 보존한다.
- screenshot, input, shell 등 Android 작업은 표준 ADB 명령 또는 선택적 확장에서 수행한다.
- LDPlayer 실행 파일·설치 경로·instance index·제품명에 의존하는 탐지와 UI를 제거한다.
- 저장된 LDPlayer 전용 session/config는 더 이상 읽거나 실행 권한으로 사용하지 않는다.
- Native Claude Proxy 작업과 무관한 이미지 artifact 기능은 보존한다.

## 구현 작업

- [x] 전용 runtime, 제품 탐지 및 structured tool 제거
- [x] 서버 route, runtime 등록, orchestration branch 제거
- [x] UI 연결 상태, 버튼, API와 공개 type 제거
- [x] 범용 ADB는 Full access direct argv로 보존
- [x] 이미지 artifact 기능 보존 및 capture source를 제품 중립 명칭으로 변경
- [x] SQLite v18 migration에서 기존 제품 전용 session 저장값 폐기
- [x] 제품별 편의 기능은 다중 target 선택이 가능한 플러그인/내부 확장 경계로 제한
- [x] typecheck, lint, build 및 전체 test 통과

## 현재 발견된 영향 범위

- 과거 schema migration 15의 column은 기존 DB 호환을 위한 inert 자리로만 남고, v18에서 저장값을 모두 비운다.
- 과거 screenshot reference의 source 문자열은 읽을 때 `tool_capture`로 정규화한다.
- 이 잔여 데이터는 API 응답, 세션 권한, tool 등록 또는 UI에 노출되지 않는다.

전용 기능 제거와 무관한 범용 이미지 첨부/표시 기능은 그대로 유지한다.
