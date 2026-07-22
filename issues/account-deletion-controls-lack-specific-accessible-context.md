# 계정 삭제 UI가 대상 계정과 핵심 경고를 접근성 이름에 연결하지 않음

## 상태

- 상태: 미해결
- 발견일: 2026-07-22
- 우선순위: P2

## 증상

홈에 표시된 다섯 계정의 삭제 button이 모두 동일한 accessible name `계정 삭제`를 사용한다.
현재 Codex 플러그인 기준계정을 삭제할 때 표시되는 replacement combobox도 accessible name이 없고,
`먼저 전환 필요` 및 connector/private workspace 재인증 경고가 dialog description에 연결되지 않는다.

시각적으로는 카드와 경고 문맥을 볼 수 있지만 스크린리더·음성 제어에서는 어느 계정을 삭제하는지,
어떤 대체 기준을 선택하는지, 삭제 전에 어떤 권한이 이전되지 않는지 파악하기 어렵다.

## 재현

1. 홈의 Claude 2개와 Codex 3개 account card 삭제 button의 accessible name을 비교한다.
2. 수동 정지 Claude/Codex 계정의 삭제 dialog를 열고 title/description/confirm을 확인한 뒤 취소한다.
3. 설정에서 비기준 및 현재 플러그인 기준계정의 삭제 dialog를 각각 연다.
4. 현재 기준계정 replacement combobox 이름과 경고의 `aria-describedby` 연결을 확인한다.
5. 모든 dialog를 취소하고 계정 수와 기준계정이 그대로인지 확인한다.

2026-07-22 실측 결과:

```text
홈 삭제 button 5개: 모두 `계정 삭제`
replacement combobox: accessible name 없음
dialog aria-describedby: `Native vault에서 삭제합니다`만 연결
미연결 경고: 먼저 전환 필요, connector/private workspace 재인증
최종 상태: 계정 5, 활성 2/5, 기준 merozemory@gmail.com
실제 삭제·전환·pause/resume: 0건
```

## 원인 후보

- account card delete button의 `aria-label`이 account nickname/email을 포함하지 않는다.
- plugin replacement select에 `<label>` 또는 `aria-labelledby`가 없다.
- critical warning paragraph가 `DialogDescription`이나 `aria-describedby` ID 집합에 포함되지 않는다.

## 영향

- 음성 제어가 동일 이름의 여러 destructive control 중 대상을 특정할 수 없다.
- 사용자가 잘못된 계정을 삭제하거나 잘못된 plugin replacement를 선택할 수 있다.
- connector/private workspace 권한이 이전되지 않는다는 중요한 사전 경고를 놓칠 수 있다.

## 완료 조건

- 모든 delete button 이름에 provider와 account nickname/email을 포함한다.
- replacement combobox에 고유한 accessible label을 연결한다.
- destructive 결과와 connector 권한 경고를 dialog description에 programmatically 연결한다.
- provider별 카드와 현재/비현재 plugin reference 삭제 dialog의 screen-reader E2E가 통과한다.

