# 기존 Claude 대화를 다시 열면 composer provider/model이 Codex로 초기화됨

## 상태

- 상태: 미해결
- 발견일: 2026-07-22
- 우선순위: P1

## 증상

마지막 정상 turn이 `Claude · Haiku 4.5`인 프로젝트리스 대화를 URL로 다시 열면 composer가
`Codex · GPT-5.6 Sol`로 초기화된다. 사용자가 이를 알아채지 못하고 Goal을 만들면 Goal과
모든 automatic continuation도 실제 Codex/Sol로 실행된다.

```text
session: 13319aa2-0be7-4572-a462-d918ea87c5bf
seed turn: Claude / claude-haiku-4-5-20251001
reloaded Goal: Codex / gpt-5.6-sol / high
```

모델을 다시 명시적으로 Haiku로 선택한 뒤 제출한 POST는 `provider=claude`,
`model=claude-haiku-4-5-20251001`로 정상 동작하므로 provider runtime 문제가 아니라 UI
복원 문제다.

2026-07-22 전체 Claude 모델 매트릭스에서도 동일 계열을 추가 확인했다. Fable 5를
`Low`로 실행한 turn은 Provider 이벤트에 `Claude / Fable 5 · Low`와 정상 응답 `amber`를
남겼지만, 해당 session을 다시 열자 composer는 `Codex / GPT-5.6 Sol · High`와 Codex
라우팅 계정을 표시했다. 즉 provider/model뿐 아니라 effort도 실행 provenance와 다르게
초기화된다.

## 원인

- `ConversationWorkspace.tsx`는 provider 상태를 `codex`, model을 빈 값으로 초기화한다.
- catalog effect가 현재 provider의 기본 모델을 먼저 채운다.
- `refreshThread()`는 snapshot만 저장하고 최신 canonical turn의 provider/model/effort를
  composer에 동기화하지 않는다.

## 영향

- 대화 재개와 Goal이 사용자가 마지막으로 사용한 provider가 아닌 provider로 과금·실행된다.
- Claude/Codex 간 문맥 및 도구 차이 때문에 결과가 달라지고 사용량 판단이 왜곡된다.
- UI에서 provider 선택을 주의 깊게 다시 확인하지 않으면 전환을 발견하기 어렵다.

## 완료 조건

- 기존 대화를 열 때 최신 실행 가능한 turn 또는 명시적으로 저장된 composer 설정에서
  provider/model/effort를 복원한다.
- provider catalog가 늦게 로드돼도 복원값을 기본값으로 덮어쓰지 않는다.
- 새 draft만 제품 기본 provider/model을 사용한다.
- Claude→reload→일반 turn, Goal, pause/resume 각각 Claude/model이 유지되는 E2E를 추가한다.
- 더 이상 사용 불가능한 모델이면 명시적인 fallback 안내와 provenance를 표시한다.
