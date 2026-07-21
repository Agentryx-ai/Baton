# Native compact checkpoint가 있는 import 대화의 재개가 차단됨

상태

- 상태: 수정 중
- 발견일: 2026-07-21
- 우선순위: P0

증상

Codex에서 compact된 대화를 Baton으로 import한 뒤 재개하면 provider를 호출하기 전에 다음 오류로 turn이 실패한다.

Execution context provenance must retain every canonical item not represented by its compaction

확인된 세션

- ai-investing: 019f80f8-0ca1-774a-a6a5-02fb0cd70ba8
- ReTalk: 019f7625-a9ae-78cd-8547-15f0d23c5abe
- 1872: 019f7625-a403-741d-93cc-9c2ebb0826ae

세 세션 모두 원본 import 경계 다음에 재개 메시지 1개만 추가됐고 provider 응답은 생성되지 않았다.
각 세션에는 codex_replacement_history 형식의 native compact checkpoint가 정상 import되어 있다.
Baton 파생 compaction artifact는 없다.

원인

context materializer는 최신 native checkpoint와 그 뒤의 canonical suffix만 provider 입력으로 선택한다.
이 동작은 Codex 원본의 replacement history 의미와 일치한다.

execution manifest 검증기는 Baton 파생 compaction만 canonical prefix를 대표할 수 있다고 가정한다.
따라서 native checkpoint 앞의 항목이 실제 provider 입력에서 제외되면 이를 누락으로 오판한다.

수정 원칙

- 실행 provider와 같은 provider의 native checkpoint만 prefix를 대표할 수 있다.
- manifest의 첫 canonical source가 해당 실행 frontier의 최신 native checkpoint여야 한다.
- checkpoint 뒤의 canonical suffix는 빠짐없이 순서대로 남아야 한다.
- 다른 provider로 전환한 실행은 이전 provider의 checkpoint를 사용할 수 없다.
- manifest가 생성된 뒤 대화가 늘어나도 기존 manifest의 frontier 검증은 변하지 않아야 한다.
- 원본 대화를 덮어쓰거나 Baton 파생 compaction을 인위적으로 만들지 않는다.

검증 조건

- 세 실패 형태를 재현하는 단위 테스트가 통과한다.
- 같은 provider의 checkpoint와 suffix로 manifest를 생성하고 다시 읽을 수 있다.
- 다른 provider가 checkpoint로 prefix를 생략하면 거부한다.
- 서버 재시작 후 세 세션을 중복 메시지 없이 재개할 수 있다.
