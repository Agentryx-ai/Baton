# Follow-up API가 생략된 선택 필드를 저장해야 함

## 상태

- 상태: 부분 해결
- 발견일: 2026-07-21
- 우선순위: P0

## 증상

실행 중인 Goal 턴에 텍스트 follow-up을 보내면 다음 응답으로 실패했다.

```text
500 internal_error
```

기존 턴은 계속 실행됐지만 추가 컨텍스트는 저장되지 않았다.

## 원인

HTTP 요청에서 선택 필드인 visibility, provider, nativeId를 생략해도 라우터의 parseNewItem이
해당 속성을 undefined 값으로 다시 만들었다. durable 저장소의 canonical JSON 직렬화는
undefined를 금지하므로 enqueueFollowUp이 TypeError로 실패했다.

운영 DB의 일관된 복사본에서 동일 입력으로 다음 예외를 재현했다.

```text
TypeError: Canonical JSON rejects undefined values
```

## 구현

- parseNewItem은 요청에 실제로 존재하는 선택 필드만 결과 객체에 포함한다.
- turn과 follow-up 라우터 계약 테스트에서 생략 필드가 undefined 속성으로 복원되지 않음을 검증한다.

## 검증

- focused router test
- typecheck
- 수정본을 로드한 서버에서 실제 Goal follow-up 저장과 소비 확인

## 남은 완료 조건

- 현재 실행 중인 Goal이 안전 경계에 도달한 뒤 수정본으로 stop-start handoff를 수행한다.
- 실제 DaeumKkini Goal 턴에서 follow-up이 202로 접수되고 consumed 상태가 되는지 확인한다.
- 검증 완료 후 이 문서를 _archived로 이동한다.
