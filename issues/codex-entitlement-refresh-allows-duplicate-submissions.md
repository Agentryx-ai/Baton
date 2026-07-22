# Codex 엔트리먼트 refresh가 pending 상태 없이 중복 제출됨

## 상태

- 상태: 미해결
- 발견일: 2026-07-22
- 우선순위: P2

## 증상

홈의 Codex 계정 카드에서 `엔트리먼트 새로고침`을 누르면 OAuth와 quota refresh 요청이
진행되는 동안에도 버튼이 계속 활성 상태로 남는다. label, spinner, `disabled`, `aria-busy`가
바뀌지 않아 사용자는 요청이 시작됐는지 알기 어렵고 같은 계정에 refresh를 연속 제출할 수 있다.

## 재현

1. 홈에서 Codex 계정 카드의 `엔트리먼트 새로고침`을 누른다.
2. 응답 전 버튼의 enabled 상태, label, spinner, accessible busy state를 확인한다.
3. 활성 계정과 수동 정지 계정에서 각각 완료 feedback을 확인한다.

2026-07-22 프로젝트리스 UI 검수 결과:

```text
활성 계정: 성공 toast, quota 28% → 29% 갱신
수동 정지 계정 2개: 0% 유지, reset 시각 갱신
요청 중 버튼: 계속 enabled, label 동일, spinner/aria-busy 없음
계정 pause 상태: 변경 없음
```

무료기간 만료나 결제 흐름은 노출되지 않았다.

## 원인

- `App.tsx`의 `onRefreshCodexEntitlements()`는 promise를 fire-and-forget으로 실행하지만 계정별
  pending state를 저장하지 않는다.
- `AccountCard`의 refresh button도 loading/disabled prop 없이 callback만 호출한다.

## 영향

- 중복 OAuth·entitlement refresh 요청이 병렬 실행될 수 있다.
- 사용자는 클릭이 접수됐는지 알 수 없어 반복 클릭하게 된다.
- 느린 응답과 순서가 뒤바뀐 refresh가 quota/reset 시각을 불안정하게 보이게 할 수 있다.

## 완료 조건

- 계정별 refresh가 진행되는 동안 해당 버튼을 disabled 처리하고 spinner와 진행 label을 표시한다.
- `aria-busy` 또는 동등한 live feedback으로 보조기술에도 pending 상태를 전달한다.
- 같은 계정의 중복 요청은 client와 server 중 적어도 한 계층에서 병합하거나 거부한다.
- 성공·실패 후 button state와 quota가 최신 요청 결과로 일관되게 복구된다.

