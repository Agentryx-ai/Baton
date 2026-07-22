# Native import의 전체 선택이 신규·업데이트 0건인데 기존 기록까지 선택함

## 상태

- 상태: 미해결
- 발견일: 2026-07-22
- 우선순위: P2

## 증상

Native 작업 가져오기에서 검색 요약이 `신규 0 · 기존 205 · 업데이트 0`인데도
`전체 신규·업데이트 선택 (205)` 버튼이 활성화된다. Codex only에서는 184, Claude Code
only에서는 222로 각각 검색 결과 전체를 선택 대상으로 세어 `가져온 기록`과 `확인 필요`
항목까지 신규·업데이트인 것처럼 라벨링한다.

안정된 기존 기록 `Respond to greeting` 한 건을 UI로 commit하면 실제 결과는
`신규 0 · 업데이트 0 · 중복 1`로 정상 처리되어 중복 session은 생성되지 않았다. 즉 commit
dedupe는 안전하지만 selection 설명과 대상 집계가 import eligibility와 모순된다.

2026-07-22 read-only 재검증에서도 실제 commit 없이 같은 결함을 확인했다.

```text
기본 검색: 발견 205 / 신규 137 / 기존 68 / 업데이트 0
전체 신규·업데이트 선택 label: 205 (기대: 137)
Claude Desktop only: 신규 0 / 기존 21, bulk label 21 (기대: 0)
현재 페이지 선택: 기존 기록을 포함한 50개 모두 선택
```

추가 검색에서는 Claude Code 222개, Codex Exec 550개, 기타+subagent+archive 2088개를 읽기
전용으로 확인했으며 selection은 모두 해제하고 source checkbox도 시작값으로 원복했다.

## 영향

- 사용자는 0건이라고 요약된 상태에서 수백 건을 다시 가져오는 것으로 오인한다.
- 대규모 source에서 어떤 항목이 실제 신규·업데이트인지 판단하기 어렵다.
- 불필요한 전체 선택과 commit으로 source-changed 충돌이나 긴 검증을 유발한다.

## 완료 조건

- `전체 신규·업데이트 선택`은 실제 신규·업데이트 eligible record만 선택하고 그 개수를 표시한다.
- 기존·중복·확인 필요 항목은 명시적인 별도 action 없이는 bulk selection에 포함하지 않는다.
- summary, 필터 후 selection count, commit result count가 동일한 eligibility 정의를 사용한다.
- 신규 0/업데이트 0/기존 N 및 혼합 결과를 E2E로 검증한다.
