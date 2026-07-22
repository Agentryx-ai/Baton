# 권한 RadioGroup이 로드 후 제어 모드를 전환함

## 상태

- 상태: 미해결
- 발견일: 2026-07-22
- 우선순위: P2

## 증상

프로덕션 Baton UI를 새 탭에서 열 때마다 React 콘솔에 다음 경고가 1회 발생한다.

```text
RadioGroup is changing from uncontrolled to controlled. Components should not switch from controlled to uncontrolled (or vice versa).
```

계정과 프록시 상태는 약 1.5초 뒤 정상 표시되지만, 초기 렌더 상태 계약이 불안정하고
Radix RadioGroup의 선택 상태가 데이터 로드 타이밍에 따라 달라질 수 있다.

## 재현

1. 최신 프로덕션 빌드를 제공하는 `http://localhost:4400/`을 새 브라우저 탭에서 연다.
2. 대시보드의 계정 데이터가 로드될 때까지 기다린다.
3. 브라우저 콘솔의 warning을 확인한다.

2026-07-22 실제 인앱 브라우저 새 탭 2개에서 각각 동일 경고를 재현했다.

## 원인 후보

`App`은 설정 화면을 `hidden` 처리할 뿐 항상 `SettingsSection`을 mount한다.
`SettingsSection`의 권한 `RadioGroup`은 초기 `permissionSettings === null`일 때
`value={undefined}`로 uncontrolled 상태가 되고, `/api` 응답 후
`value={permissionSettings.defaultProfile}`로 controlled 상태가 된다.

## 완료 조건

- 권한 설정 로드 전후에 RadioGroup이 동일한 제어 모드를 유지한다.
- 새 탭 진입과 새로고침에서 해당 React 경고가 발생하지 않는다.
- 권한 설정 조회 실패·재시도와 세 프로필 선택/저장이 정상 동작한다.
- 관련 컴포넌트 테스트와 프로덕션 빌드가 통과한다.
