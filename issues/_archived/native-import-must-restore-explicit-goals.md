# Native import가 명시적 Goal을 복원해야 함

## 상태

- 상태: **해결됨**
- 보관일: 2026-07-21
- 구현 및 기존 데이터 복원 완료 (`1fc1017`, `feat/canonical-runtime-workspace`)
- 발견일: 2026-07-19

## 구현 결과

- Codex의 exact `/goal`, 성공한 `create_goal`/`update_goal` 호출과 Claude의 구조화 `/goal`, `Goal set/cleared`, `goal_status` attachment를 분석한다.
- 새 import와 기존 import 재분석 모두 같은 store reconcile 경로를 사용한다.
- 미완료 Goal은 자동 실행되지 않도록 처음부터 `paused`로 원자 생성한다.
- 기존 Baton Goal은 덮어쓰지 않는다. 수동 복원된 `다음끼니 마케팅 리서치 보고서` Goal도 그대로 보존됐다.
- `npm run restore:native-goals`는 기본 dry-run이며 `-- --apply`에서만 복원한다.
- 2026-07-19 실데이터 복원에서 14개 Goal을 복원했고, 명시 Goal 없음/완료/clear 46개는 건너뛰었으며 기존 Goal 1개를 보존했다. 원본 transcript delta가 있는 1개는 선행 re-import가 필요해 건너뛰었다.

## 요약

Baton의 native conversation importer는 Codex/Claude 원장의 메시지와 도구 이벤트를 portable item으로 가져오지만, 원본 대화에 명시적으로 설정된 `/goal` 또는 goal lifecycle 이벤트를 canonical `goals` 상태로 복원하지 않는다.

그 결과 원본에서는 goal이 설정돼 있던 대화도 Baton으로 import하면 일반 transcript만 존재하고 `GET /threads/:threadId/goal`은 `null`을 반환한다.

## 확인된 원인

- goal persistence는 schema migration 7의 별도 `goals` 테이블에서 관리된다.
- migration 7은 기존 import 세션에 goal을 생성하는 backfill을 수행하지 않는다.
- `NativePortableRecord` 및 `NativeSessionCandidate` 계약에는 goal 상태가 없다.
- Codex/Claude source parser에는 `/goal`, goal 생성·수정·상태 변경을 canonical goal로 해석하는 경로가 없다.
- import commit은 transcript item과 native provenance를 저장하지만 `createGoal`을 호출하지 않는다.

따라서 goal 구현 전에 import한 세션은 물론이고, 현재 구현으로 다시 import한 세션도 원본의 명시적 goal을 자동 복원하지 못한다.

## 요구 동작

Importer는 원본 transcript에서 **명시적인** goal 정보만 복원해야 한다. 대화 제목, 첫 메시지 또는 요약을 근거로 goal을 임의 추론해서는 안 된다.

지원 우선순위:

1. 원본의 구조화된 goal 생성·수정·상태 이벤트
2. 구조화 이벤트가 없을 때 명시적인 `/goal ...` 명령
3. 여러 goal이 존재하면 lifecycle 순서대로 재구성하고 마지막 유효 상태를 현재 goal로 materialize
4. goal을 찾지 못하면 현재처럼 `null` 유지

## 제안 설계

- native import 계약에 선택적 goal snapshot 또는 goal lifecycle record를 추가한다.
- Codex와 Claude parser가 provider별 원본 형식에서 goal 이벤트를 별도 추출한다.
- preview에 `goalDetected`, objective, status 및 파서 경고를 표시한다.
- commit은 session/thread/items/provenance와 goal 생성을 하나의 트랜잭션으로 처리한다.
- append import 시 이미 materialize된 goal과 원본의 새 goal 이벤트를 revision/CAS 규칙에 맞게 병합한다.
- Baton에서 import 후 사용자가 수정한 goal을 원본 재-import가 무조건 덮어쓰지 않도록 provenance와 충돌 정책을 둔다.
- parser version을 올려 기존 candidate가 재분석되도록 한다.

## 기존 데이터 처리

Migration 7 적용 전에 import된 세션에는 자동으로 goal을 추론하지 않는다. 별도 재분석/backfill 작업에서 native provenance로 원장을 다시 열고 명시적 goal이 확인된 세션만 갱신한다.

Backfill은 다음을 보장해야 한다.

- dry-run preview 제공
- 원본 파일과 identity key가 일치하는 세션만 대상
- 이미 Baton goal이 존재하면 기본적으로 충돌로 보고 자동 덮어쓰기 금지
- 반복 실행해도 중복 goal/event가 생기지 않는 멱등성
- 원본을 읽을 수 없으면 transcript를 변경하지 않고 경고만 기록

## 완료 조건

- 구조화된 goal 이벤트가 있는 Codex 대화를 import하면 동일 objective와 마지막 상태가 복원된다.
- 명시적 `/goal` 명령만 있는 원본에서도 마지막 goal이 복원된다.
- 여러 goal 생성·수정·완료 이벤트의 순서가 보존된다.
- goal이 없는 일반 대화에는 goal이 생성되지 않는다.
- 대화 제목이나 첫 메시지만으로 goal을 추론하지 않는다.
- append import와 재시도에서 중복 goal이 생기지 않는다.
- Baton에서 수정된 goal과 원본 goal이 충돌하면 사용자에게 선택을 요구한다.
- migration 7 이전 import 세션을 dry-run backfill로 탐지하고 선택적으로 복원할 수 있다.
- Codex 및 Claude source adapter 테스트와 native import service 통합 테스트가 추가된다.

## 검증 시나리오

1. goal 없음, 단일 `/goal`, 여러 `/goal`, 구조화 goal lifecycle 원장을 각각 준비한다.
2. preview가 감지 결과와 경고를 정확히 표시하는지 확인한다.
3. commit 후 `GET /threads/:threadId/goal`과 canonical events를 확인한다.
4. 같은 원장을 다시 import해 중복이 없는지 확인한다.
5. Baton에서 goal을 수정한 뒤 원본에 다른 goal을 추가하고 충돌 처리를 확인한다.
6. migration 7 이전 세션에 dry-run backfill을 실행하고 선택한 세션만 변경되는지 확인한다.
