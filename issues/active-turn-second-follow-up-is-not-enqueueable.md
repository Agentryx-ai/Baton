# 활성 turn에 두 번째 follow-up을 연속 enqueue할 수 없음

## 상태

- 상태: 미해결
- 발견일: 2026-07-22
- 우선순위: P1

## 증상

프로젝트리스 Codex turn이 실행 중일 때 첫 번째 추가 요청은 정상 접수·실행되지만,
같은 active turn에 두 번째 추가 요청을 이어서 입력하면 composer는 계속
`응답 생성 중 · 추가 요청 가능`이라고 안내하면서 전송 버튼을 비활성 상태로 둔다.

두 번째 텍스트는 입력란에 남고 Enter로도 전송되지 않는다. 첫 turn이 끝난 뒤에는 다음
오류가 표시된다.

```text
Expected turn is not active in this thread
```

## 재현

2026-07-22 복구된 production UI에서 새 프로젝트리스 Codex 대화 두 번으로 재현했다.

1. Baton `run_command`로 `Start-Sleep -Seconds 12`를 실행하는 첫 요청을 보낸다.
2. `응답 생성 중 · 추가 요청 가능` 상태에서 첫 follow-up을 보낸다.
3. 첫 follow-up이 접수된 직후 서로 다른 두 번째 follow-up을 입력한다.
4. 버튼과 Enter로 두 번째 follow-up 전송을 시도한다.

첫 follow-up은 첫 명령 종료 뒤 `FIFO_ONE_DONE`까지 순서대로 실행됐다. 두 번째 follow-up은
composer에 남은 채 접수되지 않았고 위 stale-turn 오류가 표시됐다.

별도 취소 시나리오에서는 active turn과 대기 follow-up이 함께 취소됐고, 12초 뒤에도 늦은
명령 결과나 assistant 응답이 나타나지 않아 취소 동작 자체는 정상임을 확인했다.

## 원인 후보

- UI는 `submitting` 동안에도 입력란과 `추가 요청 가능` 안내를 유지하지만 전송 버튼만
  비활성화한다.
- 첫 enqueue 뒤 `refreshThread()`가 끝날 때까지 `submitting`이 해제되지 않으면 두 번째
  intent를 클라이언트 큐에 보존하지 못한다.
- turn 종료 경계에서는 composer가 보유한 `expectedTurnId`가 stale해져 서버의
  `turn_not_running`으로 귀결된다.

## 영향

- 사용자가 active turn 동안 여러 보충 지시를 FIFO로 예약할 수 없다.
- UI가 입력 가능하다고 안내하므로 사용자는 두 번째 요청이 예약됐다고 오인할 수 있다.
- 입력 내용은 화면에 남지만 서버에 저장되지 않아 탐색·reload 시 사용자 intent를 잃을 수 있다.

## 완료 조건

- active turn이 accepting 상태인 동안 여러 follow-up을 빠르게 연속 enqueue할 수 있다.
- 각 요청은 canonical queue에 고유 sequence로 저장되고 FIFO로 소비된다.
- 첫 enqueue가 진행 중이면 composer가 입력을 금지한다고 명확히 표시하거나 로컬 intent를
  안전하게 보존해 직후 전송한다.
- turn 종료 경계의 미접수 텍스트는 다음 turn으로 명시적으로 전환하거나 사용자가 재전송할 수
  있는 오류 상태로 남긴다.
- 두 follow-up 연속 입력, 첫 요청 직후 turn 종료, active turn 취소를 포함하는 E2E가 통과한다.
