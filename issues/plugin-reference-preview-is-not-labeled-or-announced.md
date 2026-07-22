# 플러그인 기준계정 preview가 이름·live announcement 없이 표시됨

## 상태

- 상태: 미해결
- 발견일: 2026-07-22
- 우선순위: P2

## 증상

설정의 `Codex 플러그인 기준계정` select는 시각적 Row label이 있지만 programmatic label이 없어
접근성 트리에서 이름 없는 `combobox`로 노출된다. `변경 내용 미리보기`로 비동기 계산한
추가·제거·유지 수와 connector 경고도 일반 paragraph로만 삽입돼 live region으로 공지되지 않는다.

키보드·스크린리더 사용자는 어떤 combobox인지 구분하기 어렵고 preview 계산이 끝나도 결과가
생겼다는 사실을 알 수 없다.

## 재현

1. 설정에서 `Codex 플러그인 기준계정` 영역의 select accessible name을 확인한다.
2. 현재 기준은 유지한 채 `local-only`를 임시 선택한다.
3. `변경 내용 미리보기`를 누르고 계산 중/완료 접근성 트리를 확인한다.
4. 실제 전환은 하지 않고 select를 원래 계정으로 되돌린다.

2026-07-22 실측 결과:

```text
combobox accessible name: 없음
계산 중: controls disabled, 버튼 `확인 중…`
preview: 추가 0 · 제거 0 · 유지 192
경고: Connector 및 private workspace 권한은 계정 사이에 이전되지 않습니다…
결과 container: role/aria-live/aria-label 없음
실제 전환: 수행하지 않음
최종 기준계정: merozemory@gmail.com으로 원복
```

## 원인

- `SettingsSection.tsx`의 native `<select>`에 `<label htmlFor>`, `aria-label`, `aria-labelledby`가
  없다. `Row`의 시각적 label도 select와 programmatically 연결되지 않는다.
- `pluginPreview` 결과 container는 일반 `<div>`와 `<p>`만 사용하고 status/live semantics를
  제공하지 않는다.

## 영향

- 설정에 여러 combobox가 생기면 보조기술 사용자가 control을 구분할 수 없다.
- catalog diff와 connector 재인증 경고를 놓친 채 실제 기준계정 전환을 진행할 수 있다.

## 완료 조건

- 기준계정 select에 고유하고 안정적인 accessible name을 제공한다.
- 비동기 preview 완료와 오류를 적절한 `role=status`/`aria-live`로 한 번 공지한다.
- diff 요약과 connector 경고가 screen-reader browse/focus 순서에서도 연결돼 읽힌다.
- local-only와 계정 후보 preview의 keyboard·screen-reader E2E가 통과한다.

