# Codex 계정 추가 trigger가 Claude 선택 wizard를 엶

## 상태

- 상태: 미해결
- 발견일: 2026-07-22
- 우선순위: P1

## 증상

홈의 Codex 섹션에서 `계정 추가`를 눌러도 account wizard는 Claude radio가 checked되고 초기 focus도
Claude에 놓인 상태로 열린다. 사용자가 trigger의 provider 문맥을 믿고 바로 `인증 시작`을 누르면
Codex가 아니라 Claude OAuth 흐름으로 이동한다.

Claude 섹션 trigger는 기본 provider와 우연히 같아 정상처럼 보이지만, Codex trigger를 다시 열어도
매번 Claude로 초기화돼 provider 문맥이 전달되지 않음을 재현했다.

## 재현

1. 홈의 Claude 섹션 `계정 추가`를 열어 provider와 초기 focus를 확인하고 닫는다.
2. Codex 섹션 `계정 추가`를 연다.
3. checked provider, 초기 focus, `인증 시작`이 여는 OAuth provider를 확인한다.
4. provider를 Codex로 수동 변경한 경우에는 auth attempt를 즉시 `다시 시작`으로 취소한다.

2026-07-22 실측 결과:

```text
Claude trigger: Claude checked/focused, Sign in - Claude
Codex trigger: Claude checked/focused (기대: Codex)
Codex 수동 선택 뒤 시작: Welcome back - OpenAI
Claude/Codex attempt: 모두 다시 시작으로 취소
최종 계정: Claude 2, Codex 3, 활성 2/5 (변경 없음)
```

OAuth credential 입력, 승인, 계정 생성은 수행하지 않았고 로그인 탭도 모두 닫았다. 무료기간·자동결제
문구는 보이지 않았다.

## 원인

- `ProviderSection`은 `onAddAccount(provider)`로 올바른 provider를 전달한다.
- `App.tsx`의 `onAddAccount = (_prov) => setWizardOpen(true)`가 인자를 버리고 wizard에
  `fixedProvider`나 initial provider를 전달하지 않는다.
- `AddAccountWizard`의 초기값과 reset 기본값은 항상 `claude`다.

## 영향

- 사용자가 의도와 다른 provider OAuth에 credential을 입력할 수 있다.
- 잘못된 계정 종류를 추가한 뒤 삭제·재시도해야 할 수 있다.
- provider별 onboarding 신뢰성과 계정 수·quota 판단을 훼손한다.

## 완료 조건

- provider section trigger가 선택한 provider를 wizard 초기값과 initial focus에 전달한다.
- dialog를 닫고 다른 provider trigger로 다시 열어도 최신 trigger provider로 reset한다.
- dedicated/fixed provider wizard는 기존 고정 동작을 유지한다.
- Claude→close→Codex, Codex→Escape→Claude 순서의 UI E2E가 provider와 OAuth URL을 검증한다.

