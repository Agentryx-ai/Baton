# Goal 완료 evidence reference의 노출 스키마와 런타임 검증이 다름

## 상태

- 상태: 미해결
- 발견일: 2026-07-22
- 우선순위: P2

## 증상

`propose_goal_completion`을 호출하는 모델에는 evidence item의 `kind`와 `claim`만
필수인 스키마가 노출되지만, `kind: tool_result`에서는 런타임이 `reference`도 필수로
요구한다. 모델이 노출된 스키마를 정확히 따라도 다음 오류로 첫 완료 제안이 실패한다.

```text
invalid_tool_input: evidence requires kind, claim, and a reference for tool_result
```

2026-07-22 프로젝트리스 Codex Goal에서 실제 재현했다.

## 원인

- `server/session/tool-coordinator.ts`의 JSON schema는 evidence `required`를
  `kind`, `claim`으로만 선언한다.
- 같은 파일의 런타임 입력 검증은 `tool_result` evidence에 `reference`가 없으면 거부한다.
- 현재 테스트는 최상위 exactness만 확인하고 이 조건부 필수 계약을 검증하지 않는다.

## 영향

- 최초 완료 제안이 불필요하게 실패하고 자동 재시도와 사용량을 늘린다.
- 모델이 실패 후 reference 형식을 추측해야 하므로 Goal 완료 신뢰성이 낮아진다.
- 장시간·외부 side effect Goal에서는 불필요한 작업 재실행으로 이어질 수 있다.

## 완료 조건

- 노출 JSON schema가 `kind: tool_result`일 때 `reference`를 조건부 필수로 표현한다.
- tool 설명에 reference가 실제 transcript의 어떤 식별자를 사용해야 하는지 예시를 제공한다.
- 스키마와 런타임 검증의 일치성을 검사하는 단위 테스트가 추가된다.
- Codex와 Claude 양쪽에서 첫 유효 호출이 `invalid_tool_input` 없이 수락된다.

