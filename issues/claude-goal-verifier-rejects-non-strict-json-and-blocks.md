# Claude Goal verifier가 non-strict JSON 응답을 거부하고 3회 뒤 차단함

## 상태

- 상태: 미해결
- 발견일: 2026-07-22
- 우선순위: P1

## 증상

프로젝트리스 Claude Haiku Goal이 terminal assistant 자체를 deliverable로 제출하고
`current_turn` evidence를 정확히 사용했지만, 독립 verifier가 세 번 모두 유효한 판정을
남기지 못했다. Baton은 매번 `verification_indeterminate`로 자동 continuation을 다시 실행한
뒤 `no_progress_count = 3`에서 Goal을 `blocked`로 전환했다.

```text
session: 13319aa2-0be7-4572-a462-d918ea87c5bf
goal:    019f8794-59eb-7afa-b763-da461734ecf2
model:   claude-haiku-4-5-20251001
error:   Independent verifier failed: Goal verifier response must be one strict JSON object
```

세 verification attempt의 `decision_json`은 모두 실제 evidence 불충분이 아니라 verifier
응답 파싱 실패를 fallback 결과로 바꾼 것이며, `missingEvidence`에는
`A valid independent verifier result is required`만 기록됐다.

## 영향

- 외부 상태가 아닌 순수 assistant deliverable조차 Claude Goal로 완료할 수 없다.
- 같은 완료 제안을 세 번 반복해 토큰과 시간을 소모한 뒤 잘못 `진전 없음`으로 차단된다.
- UI의 요약 오류는 evidence가 부족한 것처럼 보여 실제 원인인 verifier 출력 형식 실패를 가린다.

## 완료 조건

- Claude verifier에 JSON-only 출력 계약을 provider 수준에서 강제하거나 안전하게 복구 가능한
  fenced/prefixed 단일 JSON 응답을 엄격히 정규화한다.
- 원문이 유효한 단일 판정 객체를 포함하지 않으면 파싱 오류와 bounded raw diagnostic을 보존한다.
- verifier 인프라/형식 실패는 작업 진전 실패와 분리하고 `no_progress_count`를 증가시키지 않는다.
- 같은 `current_turn` Goal이 Claude Haiku에서 한 번의 verification으로 완료되는 live 회귀를 추가한다.
- Codex와 Claude verifier의 malformed, fenced JSON, prose prefix, 복수 객체 출력을 테스트한다.
