# 프로젝트리스 명령 증거가 Goal 진전에서 제외되어 완료 재시도 후 차단됨

## 상태

- 상태: 미해결
- 발견일: 2026-07-22
- 우선순위: P1

## 증상

프로젝트를 연결하지 않은 canonical Codex 대화에서 `Goal`을 실행하면, 실제 작업과
요구사항별 증거 수집이 끝났는데도 완료 검증이 반복된 뒤 Goal이 다음 상태로 멈출 수 있다.

```text
확인 필요
작업이 차단되었습니다
진전이 없어 멈췄습니다.
```

사용자에게는 어떤 요구사항이나 증거가 부족한지 표시되지 않으며, 가능한 동작은
`재개`, `목표 수정`, `목표 지우기`뿐이다.

## 재현

1. 프로젝트를 연결하지 않은 Baton 대화에서 Codex 모델과 `전체 액세스`를 선택한다.
2. 여러 명령 결과를 증거로 요구하는 Goal을 만든다.
3. 에이전트가 작업을 끝내고 `propose_goal_completion`을 호출하도록 기다린다.
4. 완료 검증과 자동 재시도가 끝날 때까지 기다린다.

2026-07-22 LDPlayer index 14 lifecycle Goal에서 다음 흐름을 실제 재현했다.

1. 첫 완료 제안이 `evidence requires kind, claim, and a reference for tool_result`로 실패했다.
2. 에이전트가 reference를 포함해 다시 제출했고 `propose_goal_completion · 완료`가 표시됐다.
3. 독립 검증은 증거 부재를 이유로 거부했고 에이전트가 권위 있는 명령 결과를 다시 수집했다.
4. 세 번째 `propose_goal_completion · 완료` 후에도 Goal은 완료되지 않고 `확인 필요`로 차단됐다.

이 과정에서 lifecycle 종료·재기동, ADB `device`, `boot_completed=1`, PNG 경로·크기,
최종 잠금 상태 증거가 모두 대화에 남았다.

## 영향

- 실제로 완료된 Goal이 완료 상태가 되지 않아 자동화와 후속 작업을 막는다.
- 검증 실패 사유가 일반 문구로 축약되어 사용자가 고칠 증거나 요구사항을 알 수 없다.
- 자동 재시도가 동일하거나 더 많은 외부 side effect를 반복할 수 있다.
- 모델이 tool schema를 추측해 첫 제출을 낭비하며 사용량과 실행 시간이 증가한다.

## 원인

- `server/session/orchestrator.ts`의 Goal progress digest는 file change, plan, task와
  성공한 `workspace_mutation`/`host_mutation`만 진전으로 센다.
- 프로젝트리스 `full_access`의 `run_command` side effect는 `workspace_command`이므로,
  성공한 lifecycle 검증과 새 명령 증거가 있어도 해당 turn의 digest가 비어 있다.
- 빈 digest는 no-progress 횟수를 증가시키고 3회째 Goal을 `blocked/no_progress`로 바꾼다.
- 검증기의 상세 거부 사유가 저장되어도 마지막 no-progress 사유가 이를 덮어쓰며,
  UI는 status history 대신 최신 일반 문구만 보여준다.

## 완료 조건

- 모델에 노출되는 `propose_goal_completion` schema와 예시에 evidence reference 필수 형식이 명확하다.
- 검증기는 대화에 존재하는 유효한 tool result reference를 안정적으로 해석한다.
- 성공한 프로젝트리스 `workspace_command`와 완료 제안을 의미 있는 Goal 진전으로 계산한다.
- 검증 거부 시 부족한 요구사항, 무효한 reference, 기대 evidence 형식을 UI에 표시한다.
- 동일 증거로 진전 없는 재시도를 반복하기 전에 사용자 확인으로 전환하며 외부 side effect를 재실행하지 않는다.
- 프로젝트리스 Goal에서 다단계 명령 증거를 제출해 한 번의 수정 이내에 완료되는 회귀 테스트가 통과한다.
