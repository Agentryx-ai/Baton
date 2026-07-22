# Low turn 전송 직후 composer effort가 High로 리셋됨

## 상태

- 상태: 미해결
- 발견일: 2026-07-22
- 우선순위: P1

## 증상

새 프로젝트리스 대화에서 Claude Fable 5 또는 Codex GPT-5.6 Luna의 `Low` effort를 명시적으로
선택해 turn을 보내면 실제 Provider 이벤트와 응답 article은 요청대로 `Low`로 정상 실행된다.
그러나 전송 직후 active turn부터 같은 탭의 composer effort가 사용자 조작 없이 `High`로
바뀌고 완료 후에도 그대로 남는다.

사용자가 표시만 보고 첫 요청도 High였다고 오인할 수 있고, 그대로 다음 요청을 보내면 의도보다
비싼 effort로 실행될 수 있다.

## 재현

검수 session: `af7e8a01-11bc-463e-91c9-48fdcd2455c9`

1. 새 프로젝트리스 대화에서 `Fable 5`, `Low`를 선택한다.
2. `Reply with exactly one word: loquat`를 전송한다.
3. 전송 직전 selected model/effort와 완료 article을 확인한다.
4. reload하지 않은 같은 탭의 composer effort를 확인한다.

실측 결과:

```text
전송 직전: Fable 5 / Low
Provider 이벤트: Fable 5 · Low
응답: loquat
완료 직후 composer: Fable 5 / High
reload 후 composer: GPT-5.6 Sol / High
```

reload 후 provider/model/effort 초기화는
`conversation-reload-resets-provider-model-to-codex.md`에 별도로 기록돼 있다. 이 이슈는
reload 전, 첫 turn 전송·완료 boundary에서 effort만 이미 바뀌는 더 이른 상태 전이다.

2026-07-22 Codex 교차 검증에서도 같은 현상을 확인했다.

```text
session: b39aebe8-3dda-4645-9b6c-35eba424179c
전송 직전: GPT-5.6 Luna / Low
active turn composer: GPT-5.6 Luna / High
응답 article: GPT-5.6 Luna · Low / TITLE_OK
완료 직후 composer: GPT-5.6 Luna / High
```

따라서 Claude 전용 문제가 아니라 draft에서 canonical turn으로 전환할 때 provider 공통 composer
effort가 현재 모델의 기본값으로 덮이는 문제다.

## 원인

- `ConversationWorkspace.tsx`의 catalog effect는 draft가 열린 동안에는 `draft.effort`를 쓰지만,
  첫 turn 생성 뒤 `draftOpen=false`가 되면 현재 model의 `defaultEffort`를 다시 적용한다.
- 완료된 canonical turn의 requested/actual effort를 composer state로 복원하는 경로가 없다.

## 영향

- 후속 요청이 사용자의 명시적 선택과 다른 effort로 실행될 수 있다.
- 비용·속도·응답 깊이가 조용히 바뀌며 Provider article을 보기 전에는 차이를 알기 어렵다.
- QA provenance에서 실제 요청 effort와 현재 composer 표시가 충돌한다.

## 완료 조건

- 첫 turn 전송 중과 완료 뒤에도 사용자가 마지막으로 명시 선택한 provider/model/effort를 유지한다.
- catalog refresh와 draft→canonical session 전환이 선택값을 default로 덮어쓰지 않는다.
- 더 이상 지원되지 않는 effort만 명시적 안내와 함께 안전하게 fallback한다.
- Claude Low/Medium/High와 Codex Low/Medium/Extra High의 첫 turn 완료·후속 turn·reload E2E가
  실제 article provenance와 composer 선택값 일치를 검증한다.
