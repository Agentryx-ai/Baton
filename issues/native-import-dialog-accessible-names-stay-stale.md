# Native import 상태·필터 전환 뒤 버튼 accessible name이 이전 값으로 남음

## 상태

- 상태: 미해결
- 발견일: 2026-07-22
- 우선순위: P2

## 증상

Native 작업 가져오기 결과 화면에서 보이는 버튼 텍스트와 접근성 이름이 상태 전환 뒤 서로
다르게 남는다.

```text
visible: 다시 검색        accessible name: 원본 변경
visible: 닫기             accessible name: 선택한 1개 가져오기
visible: 검색 결과 신규·업데이트 선택 (0)
a11y:   전체 신규·업데이트 선택 (222)
```

마지막 사례는 Claude Code 222건 검색 후 filter를 적용해 visible 결과가 0건이 된 상태에서
재현됐다.

2026-07-22 read-only 재검증에서는 신규 후보 checkbox를 선택한 뒤에도 accessible name과
보조 문구가 계속 `선택하면 가져오기 전에 항목을 분석합니다.`로 남았다. visible checked
상태는 바뀌었지만 접근성 이름이 선택 전 action을 설명해 checkbox 현재 상태와 어긋났다.

## 영향

- 스크린리더 사용자는 현재 버튼 action과 선택 건수를 잘못 안내받는다.
- 음성 제어와 role/name 기반 UI 자동화가 다른 action을 누르거나 대상을 찾지 못한다.
- source 변경, commit 결과, 필터 변경처럼 위험도가 다른 동작을 구분하기 어렵다.

## 완료 조건

- visible label과 accessible name을 동일한 현재 state에서 계산한다.
- 검색, filter, source-changed, commit 성공/실패, dialog close 전환마다 즉시 갱신한다.
- role/name 기반 접근성 E2E로 이전 label이 남지 않는지 검증한다.
- count가 있는 버튼은 화면과 접근성 트리에서 같은 count를 알린다.
