# 다른 session을 선택한 뒤 Back이 미전송 draft를 건너뜀

## 상태

- 상태: 미해결
- 발견일: 2026-07-22
- 우선순위: P2

## 증상

프로젝트리스 `새 대화`에서 provider/model/effort와 여러 줄 메시지를 입력한 미전송 draft는
reload와 단독 browser Back/Forward에서는 정상 복구된다. 그러나 draft에서 기존 session을
선택한 뒤 browser Back을 누르면 draft deep link가 아니라 bare `#conversations`로 이동하며
composer가 빈 상태로 보인다.

draft 자체는 남아 있어 캡처해 둔 `?draft=<id>` URL로 직접 이동하면 입력과 선택값이 모두
복구된다. 일반 사용자는 그 URL을 보관하지 않으므로 session을 잠깐 확인한 것만으로 작성 중인
메시지가 사라진 것으로 인식한다.

## 재현

검수 draft: `670a6388-1f90-46de-a6d8-088c1127890c`

1. 명시적으로 `새 대화`를 눌러 프로젝트리스 draft를 만든다.
2. Fable 5 / Medium을 선택하고 여러 줄 Unicode 메시지를 입력하되 전송하지 않는다.
3. reload 후 draft URL, 입력, model, effort가 복구되는지 확인한다.
4. browser Back/Forward만 수행해 draft가 복구되는지 확인한다.
5. draft에서 기존 session 하나를 선택한 뒤 browser Back을 누른다.
6. 마지막으로 저장해 둔 draft deep link로 직접 이동해 실제 draft 존재 여부를 확인한다.

실측 결과:

```text
draft URL: ?draft=670a6388-1f90-46de-a6d8-088c1127890c#conversations
reload: 3줄 Unicode + Fable 5 / Medium 복구
draft에서 단독 Back → Forward: 완전 복구
draft → 기존 session 선택 → Back: bare #conversations, 빈 composer
동일 draft deep link 직접 이동: 완전 복구
```

검수 후 draft 입력은 비웠고 reload 뒤에도 빈 상태임을 확인했다. 공식 session API는 같은 ID에
404를 반환해 canonical session이나 archive 대상은 생성되지 않았다.

## 원인 후보

- session 선택 navigation이 현재 draft history entry를 보존해 push하지 않고 bare conversation
  route로 대체하거나 중간 entry를 덮어쓴다.
- draft 저장소에는 데이터가 남지만 history state와 복귀 가능한 UI affordance가 연결되지 않는다.

## 영향

- 작성 중인 긴 prompt와 명시한 provider/model/effort가 유실된 것처럼 보인다.
- deep link를 별도로 복사하지 않은 사용자는 남은 draft에 접근할 방법을 알 수 없다.
- browser navigation의 동작이 이동 순서에 따라 달라진다.

## 완료 조건

- draft에서 session을 선택하면 browser Back으로 바로 이전 draft와 입력·model·effort를 복원한다.
- history를 의도적으로 교체한다면 작성 중인 draft로 돌아가는 명시적 UI를 제공한다.
- draft → session → Back/Forward, reload, 다른 session 연속 선택 E2E가 history와 composer 상태를
  함께 검증한다.
- draft를 명시적으로 폐기한 경우에만 입력과 복귀 entry를 제거한다.
