# 중단된 turn의 종료 원인이 대화 본문에 표시되지 않음

## 상태

- 상태: 미해결
- 발견일: 2026-07-22
- 우선순위: P1

## 증상

프로젝트리스 canonical Codex 대화가 여러 `run_command`를 실행하던 중 Baton 서버가
강제 종료됐다. 재기동 복구는 해당 turn을 `interrupted`와
`{"code":"runtime_interrupted"}`로 정확히 기록했지만, 대화 본문에는 마지막 중간
assistant 메시지와 정상적으로 짝지어진 tool call/result만 남고 종료 원인 카드나 경고가
표시되지 않았다.

```text
이제 각 앱을 하나씩 열어 ... 확인하겠습니다.
```

대화 목록에는 `중단됨` badge가 있지만 본문을 읽는 사용자는 provider가 도구 결과 뒤
조용히 끝난 것처럼 오인할 수 있다.

재현 session/turn:

```text
session: 5ce237da-93eb-44ab-a7cc-0447e3289e27
turn:    019f8726-a6dd-7808-b465-c6869217aa72
status:  interrupted
error:   {"code":"runtime_interrupted"}
```

## 원인

- `server/session/sqlite-store.ts`의 startup recovery는 실행 중 turn을 `interrupted`로
  바꾸고 stream에 `turn_interrupted`를 남기지만 사용자 가시 terminal item은 추가하지 않는다.
- `src/features/conversations/ConversationWorkspace.tsx`의 `latestTurnError`는
  `status === 'failed'`만 표시하고 `interrupted`와 `cancelled`는 제외한다.
- provider `turn/completed`가 없으므로 terminal assistant가 없는 것은 정상적인 중단
  결과다. 문제는 그 원인을 transcript가 보여 주지 않는다는 점이다.

## 영향

- 사용자는 작업이 완료됐는지, 중단됐는지 본문만으로 판단할 수 없다.
- 로그인·결제 금지, 최종 잠금처럼 중요한 종료 조건의 미충족 여부가 가려진다.
- 후속 턴에서 중단 원인을 추측하거나 같은 작업을 불필요하게 재실행할 수 있다.

## 완료 조건

- `interrupted`와 `cancelled` turn은 transcript에 durable terminal 상태 카드를 표시한다.
- 카드에는 가능한 경우 `runtime_interrupted` 같은 원인과 안전한 재개 안내를 포함한다.
- 목록 badge와 본문 상태가 일치한다.
- 정상 tool call/result와 provider event는 보존하고 가짜 assistant final은 만들지 않는다.
- 재기동 복구, 사용자 취소, timeout, provider stream 종료를 각각 회귀 테스트한다.
