# Goal 생성 요청 중 composer와 전송 버튼이 계속 활성 상태임

## 상태

- 상태: 미해결
- 발견일: 2026-07-22
- 우선순위: P2

## 증상

프로젝트리스 대화에서 Goal을 제출하면 POST는 정상 201로 성공하지만 약 2.36초 동안 Goal
입력값과 활성 `메시지 보내기` 버튼이 그대로 남았다. spinner, `처리 중`, disabled 상태가
없어 사용자는 제출이 무시됐다고 판단하고 같은 버튼을 여러 번 누르게 된다.

재현 session:

```text
13319aa2-0be7-4572-a462-d918ea87c5bf
```

## 원인

- `saveGoalObjective()`는 `goalBusyAction='create'`를 설정하지만 POST와 `refreshThread()`를
  모두 기다린다.
- `startTurn()`은 그 Promise가 끝난 뒤에만 Goal composer를 닫고 prompt를 지운다.
- `canSubmit`과 submit Button은 `goalBusyAction`을 보지 않아 중복 제출을 막지 않는다.

## 영향

- 정상 요청이 무반응처럼 보이며 중복 클릭과 경쟁 요청을 유도한다.
- 느린 로컬 서버나 provider 상태에서 같은 Goal 생성/교체 요청이 겹칠 수 있다.
- 성공 여부가 나타날 때까지 사용자가 안전하게 기다려야 하는지 알 수 없다.

## 완료 조건

- Goal 생성/교체 요청 시작 즉시 composer와 전송 버튼을 disabled 처리한다.
- 전송 버튼에 spinner 또는 `처리 중` accessible label을 표시한다.
- 단일 in-flight 요청만 허용하고 중복 click/Enter를 회귀 테스트한다.
- 성공 시 Goal 패널로 전환하고 실패 시 입력을 보존한 채 오류와 재시도 상태를 표시한다.
