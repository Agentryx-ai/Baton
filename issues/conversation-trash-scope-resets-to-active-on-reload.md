# 휴지통 목록을 reload하면 active 대화로 돌아감

## 상태

- 상태: 미해결
- 발견일: 2026-07-22
- 우선순위: P2

## 증상

대화 목록 보기 설정에서 `휴지통`을 선택한 뒤 page를 reload하면 scope가 `대화(active)`로
돌아간다. 같은 설정 패널의 그룹화와 정렬은 reload 후에도 유지되므로 scope만 다른 persistence
계약을 갖는다.

## 재현

1. Baton 대화 화면의 `대화 목록 보기 설정`을 연다.
2. 보기 `휴지통`, 그룹화 `없음`, 정렬 `이름순`을 선택한다.
3. radio checked 상태와 휴지통 항목을 확인한다.
4. page를 reload한다.

2026-07-22 실측에서는 reload 뒤 checked 값이 `대화 / 없음 / 이름순`이었다. group/sort는
그대로였지만 scope만 active로 초기화됐다. 복원·영구 삭제·아카이브 mutation은 수행하지 않았다.

## 원인

- `ConversationWorkspace.tsx`의 `sessionScope`는 항상 `useState('active')`로 초기화된다.
- `session-view-preferences`는 group/sort/collapsedGroups만 저장하고 scope를 저장하지 않는다.
- URL/history state에도 active/trash 위치가 표현되지 않는다.

## 영향

- 휴지통을 검토하다 reload하면 사용자가 보던 위치와 목록 상태를 잃는다.
- 정렬·그룹 설정은 유지되므로 scope도 유지될 것이라는 사용자 기대와 충돌한다.
- 휴지통이 비어졌거나 복원된 것으로 오인할 수 있다.

## 완료 조건

- active/trash scope를 view preference 또는 URL/history state로 명시하고 reload 시 복원한다.
- deep link/back/forward 동작이 active/trash를 예측 가능하게 유지한다.
- scope 복원이 불가능하거나 의도적으로 transient라면 reload 전에 active로 돌아감을 명확히
  안내하고 group/sort와 다른 계약을 문서화한다.
- active/trash × group × sort reload 회귀 테스트가 통과한다.
