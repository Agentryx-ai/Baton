# 모델 fallback은 후보를 끝까지 순회하고 실패한 override를 정리해야 함

## 상태

- 상태: **미해결**
- 발견일: 2026-07-20
- 우선순위: P2
- 범위: provider/model 공통 자동전환 runtime

## 현재 한계

preferred model과 effective model을 분리한 opt-in fallback 및 reset 후 원복은 구현됐다. 하지만
첫 fallback 모델도 실패할 때 다음 후보를 순회하는 계약과, 실패하거나 더 이상 유효하지 않은
effective-model override를 정리하는 상태 전이가 충분히 고정되지 않았다.

이 문제는 Fable 5→Opus 4.8에 한정되지 않는다. 서버가 임의의 preferred model과 ordered fallback
후보를 내려줄 수 있는 범용 schema를 유지해야 한다.

## 요구사항

- preferred model에 대해 capability/availability가 맞는 ordered fallback 후보를 순서대로 시도한다.
- quota, safety refusal, authentication, unsupported model과 transport failure를 서로 다른 정책으로
  분류하고 허용된 실패만 다음 후보로 넘긴다.
- 성공한 후보만 effective override로 기록한다.
- 모든 후보 실패 시 preferred model과 실패 chain을 보존한 typed terminal error를 반환한다.
- preferred model이 다시 사용 가능하면 override와 자동전환 notice를 원자적으로 제거하고 원복한다.
- 사용자가 자동전환을 끄면 override를 제거하고 preferred model로 다시 시도한다.

## 수용 기준

1. 세 개 이상 후보에서 앞 후보 두 개가 실패하고 세 번째가 성공하는 순회 테스트가 통과한다.
2. 모든 후보 실패 시 stale override가 남지 않는다.
3. reset/availability 회복 시 preferred model로 자동 복귀하고 중복 event를 만들지 않는다.
4. Claude/Codex 및 추후 provider가 모델명을 하드코딩하지 않고 동일 runtime을 사용한다.
5. retry deadline, cancellation과 이미 시작된 stream의 재시도 금지 규칙을 지킨다.

