# 복구 후 inherited Codex subagent가 사라진 previous response를 참조함

## 상태

- 상태: 미해결
- 발견일: 2026-07-22
- 우선순위: P1

## 증상

Baton Worker와 session host를 복구한 뒤 현재 Codex 세션에서 최근 turn context를 상속한
subagent를 생성하면, subagent의 첫 추론이 다음 OpenAI 오류로 즉시 종료될 수 있다.

```text
invalid_request_error
code: previous_response_not_found
param: previous_response_id
Previous response with id 'resp_06388320fca72794016a60800bb6588193b2cb4285ac93d00e' not found.
```

같은 시점에 context 상속 없이 만든 fresh subagent는 첫 추론을 정상 시작해 browser 환경을
점검하고 결과를 반환했다. 따라서 계정·모델 전체 장애가 아니라 inherited response chain의
stale ID 처리 문제로 좁혀진다.

## 재현

1. 실행 중이던 Baton Worker/session host를 복구하고 `/baton/health`에서 session host
   `ready`를 확인한다.
2. Codex에서 최근 turn 일부를 상속하는 subagent를 생성한다.
3. subagent가 첫 응답을 생성할 때까지 기다린다.
4. 같은 작업을 fresh context subagent로 다시 생성해 비교한다.

2026-07-22 모델 매트릭스 병렬 QA에서 inherited agent는 첫 요청이 위 400으로 종료됐고,
fresh agent는 동일 Baton 상태에서 정상 추론했다.

## 영향

- 복구 직후 기존 대화에서 병렬화한 Codex 작업이 실제 작업을 시작하기 전에 사라진다.
- 사용자는 subagent task만 실패한 이유와 fresh context 재시도 필요성을 알기 어렵다.
- 장기 세션, Worker 재기동, account/provider failover가 있는 환경에서 parallel QA와 자동화의
  신뢰도가 떨어진다.

## 완료 조건

- Worker/session host 복구 뒤에도 상속된 subagent context가 유효한 response chain으로 이어진다.
- upstream이 `previous_response_not_found`를 반환하면 side effect가 시작되지 않은 첫 추론에 한해
  보존된 canonical history로 stateless 재구성하거나 명시적 안전 재시도를 수행한다.
- 실패가 복구 불가능하면 UI와 parent agent에 stale response chain 원인과 fresh-context 재시도
  안내를 구조화해 전달한다.
- inherited/fresh subagent, Worker 재기동, account 전환을 조합한 회귀 테스트가 통과한다.
