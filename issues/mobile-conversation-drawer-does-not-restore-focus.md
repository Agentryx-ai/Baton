# Controlled dialog를 닫으면 focus가 opener로 복원되지 않음

## 상태

- 상태: 미해결
- 발견일: 2026-07-22
- 우선순위: P2

## 증상

모바일 대화 drawer를 `Escape`로 닫으면 dialog는 숨겨지지만 focus가 `대화 목록 열기` 버튼으로
돌아오지 않는다. `activeElement`는 숨겨진 drawer content를 포함하던 accessible name 없는
`DIV`에 남는다.

같은 controlled-dialog 패턴을 사용하는 `Native 작업 가져오기`도 Escape와 Close 버튼 모두
dialog는 정상적으로 닫히지만 opener button으로 focus가 복원되지 않고 문서에 active control이
없는 상태가 된다. 따라서 모바일 drawer 하나가 아니라 trigger와 연결되지 않은 대화 dialog의
공통 keyboard focus 문제다.

계정 추가 wizard와 홈·설정의 account/plugin 삭제 dialog에서도 같은 현상을 확인했다. Claude와
Codex OAuth wizard는 Close·Escape 모두, 네 종류의 삭제 dialog는 Escape·취소·Close 모두 닫힌
뒤 focus가 opener 대신 `BODY`로 이동했다.

## 재현

1. viewport를 약 `390x844`로 설정한다.
2. `대화 목록 열기` 버튼에 focus를 두고 drawer를 연다.
3. drawer 안 첫 navigation control로 focus가 이동했음을 확인한다.
4. Escape를 눌러 drawer를 닫는다.
5. dialog hidden 상태와 `document.activeElement`를 확인한다.

2026-07-22 실제 Chrome 검수에서 open 시 focus 이동과 close 자체는 성공했지만 opener focus
복원은 실패했다.

같은 날 desktop 프로젝트리스 대화의 `Native 작업 가져오기`에서도 다음을 교차 검증했다.

```text
open: Codex 로컬 checkbox로 focus 이동
Escape close: dialog hidden, Native 작업 가져오기 opener active 아님
Close button close: dialog hidden, active control 없음
OAuth wizard Close/Escape: dialog hidden, activeElement BODY
Claude/Codex account delete Escape/취소: dialog hidden, activeElement BODY
plugin account delete Close/취소: dialog hidden, activeElement BODY
```

## 원인 후보

Radix `Dialog`를 외부 button의 state 변경으로 열고 `DialogTrigger` 또는 명시적
`onCloseAutoFocus` 복원 target을 사용하지 않아 원래 trigger와 focus scope가 연결되지 않는다.

## 영향

- 키보드 사용자는 drawer, import, OAuth, destructive dialog를 닫은 뒤 현재 위치를 잃고 Tab
  탐색을 처음부터 반복할 수 있다.
- 스크린리더가 숨겨진 content 주변의 이름 없는 요소를 현재 위치로 인식할 수 있다.

## 완료 조건

- Escape, close button, overlay click으로 닫을 때 focus가 해당 dialog를 연 visible trigger로
  돌아간다.
- navigation으로 view 자체가 바뀌면 새 destination의 의미 있는 heading/main으로 focus를 옮긴다.
- trigger unmount 같은 예외에는 안전한 visible fallback target을 사용한다.
- 모바일 drawer와 desktop Native import·OAuth wizard·account/plugin delete dialog의
  keyboard-only·screen-reader focus 회귀 테스트가 통과한다.
