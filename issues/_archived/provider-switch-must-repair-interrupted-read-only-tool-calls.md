# Provider 전환 전에 중단된 읽기 전용 tool call을 복구해야 함

## 상태

- 상태: 해결됨
- 발견일: 2026-07-21
- 보관일: 2026-07-21
- 수정 커밋: `85dcf4c`

## 증상

DaeumKkini 마케팅 리서치 Goal을 재개할 때 다음 오류로 새 turn이 실패했다.

```text
Provider switch blocked by unresolved tool calls:
019f8160-8b47-74d0-95be-671909c2d640:exec-c085c51f-d660-44e5-9560-6bff0b2ae419
```

## 원인

해당 호출은 turn `019f8160-8b47-74d0-95be-671909c2d640`의 `search_text`였고 side effect는
`read_only`였다. 프로세스 중단 전에 tool call은 저장됐지만 tool result는 저장되지 않았다.

Provider snapshot의 안전 검사기는 모든 tool call에 대응하는 result가 있어야 provider history를
구성한다. 결과가 없는 호출을 그대로 통과시키면 다른 provider가 미완료 도구 실행을 이어받은 것처럼
해석할 수 있으므로 차단 자체는 맞다. 결함은 시작 복구가 결과를 확정하지 않아 안전 차단이 영구화된
것이었다.

## 구현

시작 복구가 terminal 또는 interrupted turn의 미해결 `read_only` 호출마다 결정적인 실패 result를
정확히 한 번 저장한다.

```text
code: runtime_interrupted
message: Runtime interrupted before a durable tool result was recorded; the output is unavailable
retryable: false
```

쓰기와 command처럼 결과를 모르면 외부 상태를 추측하게 되는 호출은 자동 재실행하거나 성공 처리하지
않고 기존 unknown mutation 경계를 유지한다.

## 실데이터 증거

- 원래 tool call sequence: 4163
- 복구된 tool result sequence: 4165
- call ID와 providerCallId가 원 호출과 일치
- 복구 result의 visibility: portable
- 같은 복구를 다시 실행해도 result가 중복되지 않음
- 차단된 재개 turn sequence 34 뒤, 같은 Goal의 Codex turn sequence 35가 2026-07-20
  21:46:30 UTC에 시작해 21:54:27 UTC에 completed 됨

따라서 startup 복구 뒤에는 같은 호출이 더 이상 unresolved set에 남지 않으며 provider snapshot 생성도
통과한다.

## 검증

- `startup recovery durably fails interrupted read-only tool calls exactly once` 통과
- `startup recovery repairs legacy terminal read-only calls but leaves mutations unresolved` 통과
- 전체 557 tests, typecheck, lint, production build 통과
- 실제 canonical DB에서 sequence 4163과 4165의 call/result 대응 확인
- 실제 Goal의 후속 turn sequence 35 완료 확인

## 완료 조건

- 중단된 읽기 전용 호출은 재시작 시 실패 result로 정확히 한 번 닫힌다.
- mutation 결과는 추측하거나 자동 재실행하지 않는다.
- 복구 뒤 provider snapshot과 다음 turn이 unresolved tool 오류 없이 진행된다.

