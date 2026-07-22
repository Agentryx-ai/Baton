# 모바일 대화 drawer의 홈·설정 navigation이 화면을 전환하지 않음

## 상태

- 상태: 미해결
- 발견일: 2026-07-22
- 우선순위: P1

## 증상

모바일 viewport의 대화 화면에는 desktop sidebar 대신 `대화 목록 열기` 버튼이 표시된다.
drawer를 연 뒤 안쪽 `홈` 또는 `설정` navigation을 누르면 drawer가 닫히거나 잠시 남지만
최종 화면은 계속 `Baton 대화`와 `새 대화`이다. `대시보드`나 `설정` heading으로 전환되지
않는다.

모바일 화면에는 drawer 밖의 대체 홈·설정 navigation이 없어 사용자가 대화 화면을 벗어날
수 없다.

## 재현

1. viewport를 약 `390x844`로 설정하고 Baton 대화 화면을 연다.
2. `대화 목록 열기`를 눌러 dialog `대화 목록`을 연다.
3. dialog 안에서 visible하고 unique한 `설정` 버튼을 누른다.
4. 현재 main heading과 dialog open 상태를 확인한다.
5. fresh snapshot을 얻어 `홈`과 `설정`을 각각 다시 시도한다.

2026-07-22 Chrome extension QA에서 반복 시도 모두 최종 화면이 대화 workspace에 남았다.
같은 세션의 desktop viewport에서는 홈·대화·설정 navigation이 모두 정상 동작했다.

## 원인 후보

- 하나의 `SessionSidebar` element를 desktop `<aside>`와 mobile `DialogContent` 양쪽에 동시에
  렌더링하면서 navigation event와 dialog close/unmount 순서가 충돌한다.
- mobile `onNavigate`가 먼저 `setMobileSidebarOpen(false)`를 호출한 뒤 상위 view 전환을
  요청하지만 dialog close boundary에서 후속 navigation이 반영되지 않는다.

## 영향

- 모바일 사용자는 대화 화면에서 홈의 계정/quota 상태나 설정 화면으로 이동할 수 없다.
- drawer가 닫혀 클릭이 된 것처럼 보여 navigation 실패를 알아차리기 어렵다.

## 완료 조건

- mobile drawer의 홈·대화·설정이 desktop과 동일한 view로 정확히 전환한다.
- navigation click은 drawer close와 view transition을 하나의 예측 가능한 상태 전이로 처리한다.
- 320px~767px viewport에서 각 destination heading과 URL/history state를 검증하는 E2E가 통과한다.
- 키보드 Enter/Space와 pointer click 모두 동일하게 동작한다.
