# Follow-up API가 생략된 선택 필드를 저장해야 함

## 상태

- 상태: 해결됨
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

- focused router test 14개 통과
- typecheck 통과
- lint 통과. 기존 Fast Refresh 경고 3개만 유지
- production build 통과. 기존 chunk size 경고만 유지
- 실제 DaeumKkini Goal sequence 40에 선택 필드 없는 follow-up이 202로 접수됨
- 접수된 follow-up이 같은 turn에서 queued에서 consumed로 전이되고 canonical item ID가 기록됨

전체 테스트는 612개 중 610개가 통과했다. 나머지 2개는 live 4400 서버와 설치된 unsigned
development bootstrap에 의존하는 테스트 격리 문제이며 이 수정과 별도 이슈로 추적한다.
