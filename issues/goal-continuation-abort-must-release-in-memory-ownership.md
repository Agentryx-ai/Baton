# Goal continuation 중단이 in-memory 소유권을 해제해야 함

## 상태

- 상태: 부분 해결
- 발견일: 2026-07-21
- 우선순위: P0

## 증상

DaeumKkini Goal의 provider turn sequence 35는 completed였고 thread도 idle이었지만 UI는 장시간
`다음 작업 준비 중`에 머물렀다. 2시간 active-time 제한 뒤 Goal을 재개해도 새 scheduler lease와
turn이 생기지 않았다.

이 상태에서 다음 부가 증상도 확인됐다.

- 메시지 composer가 전송 가능하게 보이지만 다음 Goal turn에 컨텍스트를 붙이지 못함
- active 상태 재적용은 terminal checkpoint 충돌 또는 invalid transition으로 실패
- paused CAS는 먼저 저장되지만 interrupt 대기 timeout 때문에 API가 internal error를 반환

## 원인

완료된 turn의 `executeTurn` 후처리는 `recordAutomaticTurn`이 즉시 다음 continuation을 준비하는 과정까지
await한다. 다음 turn의 context compaction이 오래 걸리면 이전 terminal turn이 orchestrator의 active map과
Goal runtime의 in-flight set에 계속 남는다.

active-time timer와 pause는 AbortSignal을 발생시키지만 `startTurnInternal`의 context 준비 await를 직접
끊지 못했다. DB lease와 Goal status는 정리되어도 프로세스 메모리의 busy 소유권이 남아 이후 resume이
계속 거절됐다.

## 구현

Goal continuation의 `startTurnInternal` 준비를 AbortSignal과 경합시킨다. timeout, lease loss 또는 pause가
발생하면 launcher가 즉시 cancelled 결과로 돌아가 `inFlightGoalIds`, pending controller와 lease를 정리한다.

백그라운드의 context 준비가 늦게 끝나더라도 기존 `startSignal.aborted` 검사가 beginTurn 전에 차단하므로
stale turn을 생성하지 않는다.

## 검증

- context 준비가 영원히 끝나지 않는 합성 runtime에서 1초 active-time 제한 후 Goal이
  `budget_limited`로 전환됨
- 같은 Goal을 counter reset과 함께 active로 재개할 수 있음
- focused 회귀 테스트, typecheck, lint, `git diff --check` 통과

## 남은 완료 조건

- 수정본으로 4400을 안전하게 재시작한다.
- DaeumKkini Goal을 재개해 새 scheduler lease와 running turn이 생성되는지 확인한다.
- 다음 turn에 복구 컨텍스트가 소비되고 pause/resume API가 timeout 없이 응답하는지 확인한다.
- live 검증 뒤 이 문서를 `_archived`로 이동한다.

