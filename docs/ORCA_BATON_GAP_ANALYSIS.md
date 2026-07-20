# Baton이 해결하려는 문제: Orca 소스 기준 가능 여부

조사일: 2026-07-20 (Asia/Seoul)  
Orca 조사 대상: [stablyai/orca](https://github.com/stablyai/orca) commit
[d9d939a](https://github.com/stablyai/orca/tree/d9d939a33b5858495ffb33489a952f1ac9293610)  
Baton 기준: 이 저장소 commit 00e2bbad4e68b693e15a0ad534f85009f27dcfeb의 설계, 구현 문서  
판정 방법: Orca 저장소 9,131개 파일을 로컬 clone한 뒤 UI 문구가 아니라 service, runtime,
SQLite schema, provider session reader, RPC와 test까지 추적했다.

## 판정표 읽는 법

| 표시 | 뜻 |
|---|---|
| 가능 | Orca 소스에 실제 실행 경로와 저장 구조가 있다. |
| 일부 가능 | 비슷한 사용자 경험은 있지만 Baton이 해결하려는 핵심 의미까지는 충족하지 않는다. |
| 불가능 | 현재 Orca 소스 구조에는 해당 실행 경로나 정본이 없다. |
| Orca 우세 | Orca가 이미 구현했고 현재 Baton보다 기능이 넓다. |
| Baton 목표 | Baton 설계에는 있지만 Baton도 아직 실행 경로가 없다. 현재 우위로 주장하면 안 된다. |

불가능은 미래에도 절대 만들 수 없다는 뜻이 아니라 조사한 commit의 현재 소스로는 할 수
없다는 뜻이다.

## 한눈에 보는 결론

| 우리가 해결하려던 큰 문제 | Orca에서 가능한가? | 한 줄 결론 |
|---|---:|---|
| 여러 계정의 사용량, reset을 한곳에서 보기 | 가능 | Orca가 Claude/Codex를 포함한 여러 agent의 사용량을 수집한다. |
| 사용자가 계정을 클릭해 수동 변경 | 가능 | Claude/Codex managed account와 수동 hot-swap이 구현돼 있다. |
| 한도, 429 발생 시 사용자 개입 없이 자동 계정 스왑 | 불가능 | usage 수집은 정보 표시용이고, 한도 상태가 account selection을 호출하지 않는다. |
| 실패한 동일 요청을 다른 계정으로 즉시 재시도 | 불가능 | Orca는 inference proxy가 아니므로 provider HTTP 요청을 가로채 재전송할 수 없다. |
| 모델 한도 시 대체 모델로 자동 전환 후 원 모델 복귀 | 불가능 | 모델 선택 UI는 있지만 model fallback controller는 없다. |
| Claude에서 하던 같은 대화를 Codex가 그대로 이어받기 | 불가능 | Orca는 각 provider의 원래 session을 각 provider CLI로 resume한다. |
| 하나의 장기 목표를 provider가 바뀌어도 자동으로 계속 수행 | 불가능 | automation과 task orchestration은 있지만 conversation-owned Persistent Goal은 없다. |
| 여러 agent를 worktree로 병렬 실행하고 task DAG로 조율 | Orca 우세 | 실제 SQLite orchestration runtime과 coordinator가 구현돼 있다. |
| IDE, terminal, diff, browser, computer use, 모바일, SSH | Orca 우세 | 이 영역은 Orca의 주력 제품 기능이고 Baton보다 훨씬 넓다. |

## 먼저 정확히 답하기: 자동 스왑과 같은 대화의 모델 변경

| 질문 | Orca에서 가능한가? | 정확한 의미 |
|---|---:|---|
| Claude/Codex 계정을 여러 개 등록할 수 있는가? | 가능 | 여러 managed account를 저장하고 사용량을 각각 볼 수 있다. |
| 한 계정이 소진되면 Orca가 자동으로 다음 계정으로 바꾸는가? | 불가능 | 사용자가 account selector에서 직접 선택해야 한다. |
| 계정을 바꾸면 실패한 현재 요청이 자동 재시도되는가? | 불가능 | 실행 중 session은 기존 계정을 계속 쓰며 Codex는 재시작 안내가 나온다. |
| 같은 Claude 대화에서 Opus를 Sonnet으로 수동 변경할 수 있는가? | 가능 | Orca가 Claude의 /model picker/command를 사용한다. 대화 주인은 계속 Claude다. |
| 같은 Codex 대화에서 Codex 모델을 수동 변경할 수 있는가? | 가능 | Orca가 Codex의 /model picker를 연다. 대화 주인은 계속 Codex다. |
| 모델 한도 시 Orca가 자동으로 다른 모델을 선택하는가? | 불가능 | model fallback/recovery controller가 없다. |
| Claude에서 진행하던 같은 대화를 Codex 모델로 이어갈 수 있는가? | 불가능 | Claude session과 Codex session은 서로 다른 provider-owned conversation이다. |
| 한 대화에서 Claude 모델과 Codex 모델을 turn마다 번갈아 쓸 수 있는가? | 불가능 | 같은 provider 안의 모델 변경은 되지만 provider를 넘는 같은 대화는 되지 않는다. |

정리하면 Orca는 한 provider가 소유한 같은 native conversation 안에서 모델을 수동 변경할
수 있다. 하지만 여러 계정의 자동 스왑, 자동 model fallback, Claude와 Codex가 공유하는
한 대화는 제공하지 않는다.

## Orca를 사용하면서 남는 불편이 Baton의 출발점이었다면

아래는 프로젝트의 실제 창업 연혁을 주장하는 문장이 아니라, Orca를 직접 사용했을 때 남는
불편을 중심으로 Baton의 존재 이유를 설명하는 제품 서사다.

Orca는 여러 agent를 동시에 띄우고 코드를 병렬로 만드는 데 매우 편하다. 문제는 agent가
멈췄을 때와 agent를 바꿔야 할 때 시작된다. 사용량을 보여주는 것과 중단된 작업을 자동으로
살리는 것은 다른 문제이고, 여러 대화를 한 화면에 보여주는 것과 같은 대화를 다른 provider가
이어받는 것도 다른 문제다. Baton은 바로 이 사이의 빈 공간을 해결하려고 만든 control plane으로
설명할 수 있다.

| Orca를 쓰면서 남는 불편 | 사용자가 해야 하는 일 | Baton에서만 지원하거나 지원할 해결책 |
|---|---|---|
| 사용량은 보이지만 계정이 소진돼도 자동으로 바뀌지 않는다 | 오류를 확인하고 account selector를 열어 다른 계정을 직접 고른다. | 한도, 429 기반 자동 account selection |
| 계정을 바꿔도 실행 중 Codex session은 이전 계정에 남는다 | 현재 session을 재시작하고 실패한 prompt를 다시 보내야 한다. | request-time exact account routing과 same-request failover |
| 사용 중인 모델이 소진되면 session이 멈춘다 | /model을 열어 사용 가능한 모델을 추측해 직접 고른다. | capability 기반 자동 model fallback, 원 모델 자동 복귀와 전환 이유 표시 |
| Claude 한도가 끝나 Codex로 옮기고 싶어도 같은 대화가 아니다 | 새 Codex terminal/session을 열고 이전 맥락, 결정, 파일 상태를 수동으로 설명한다. | 하나의 canonical thread를 Claude/Codex/Gemini가 turn별 adapter로 이어받음 |
| Session History에서 여러 대화가 보이지만 각각 원래 provider 소유다 | 과거 대화를 열어 원래 Claude 또는 Codex로 resume한다. | provider-native session을 정본이 아닌 import source/최적화 정보로 취급 |
| 긴 맥락을 다른 provider로 옮길 때 무엇을 복사해야 할지 불명확하다 | transcript를 요약, 복사하고 누락된 tool result와 결정을 사람이 보완한다. | portable item과 provider-private state 분리, canonical compaction artifact |
| agent가 한 번 답하고 멈추면 장기 목표가 남지 않는다 | 계속하라는 prompt를 반복해서 보내거나 별도 automation/task를 만든다. | conversation-owned Persistent Goal과 bounded automatic continuation |
| 여러 agent의 Task는 잘 조율되지만 worker가 완료를 선언하면 바로 completed가 된다 | 결과가 정말 요구사항을 만족하는지 별도로 검토하고 상태를 되돌려야 한다. | 향후 결과 후보, 검증, 수락 증거, 승인된 결과물을 서로 분리 |
| provider마다 tool, approval, session 기록 방식이 다르다 | 각 CLI의 권한 설정과 transcript를 별도로 이해해야 한다. | provider-neutral tool/effect ledger와 immutable execution policy snapshot |
| 앱이나 agent가 mutation 도중 죽으면 실제 실행 여부가 불명확하다 | terminal/log/file 상태를 사람이 조사한 뒤 재시도 여부를 판단한다. | effect 전 intent 기록, unknown-outcome reconciliation, 불명확한 mutation 자동 replay 금지 |

## Orca의 Baton 대비 특장점

Orca가 해결하지 못한 문제만 보면 제품 비교가 왜곡된다. 현재 사용자가 매일 체감하는 개발환경,
병렬 실행과 원격 작업에서는 Orca가 Baton보다 훨씬 앞선다.

| Orca의 특장점 | 사용자가 얻는 이점 | Baton 현재 상태 | 소스 기준 판정 |
|---|---|---|---|
| 통합 Agent 개발환경 | terminal, split layout, editor, file explorer, diff 검토, commit과 push를 한 앱에서 처리한다. | Baton은 control plane과 대화 UI 중심이다. | Orca 우세 |
| Git worktree 기반 격리 | 여러 agent가 같은 저장소에서 동시에 작업해도 파일과 branch 충돌을 줄일 수 있다. | WorkGraph와 child execution은 아직 실행 경로가 없다. | Orca 우세 |
| 병렬 agent 비교 | 같은 문제를 여러 agent에게 맡기고 결과와 diff를 비교한 뒤 선택할 수 있다. | Baton은 현재 한 canonical turn의 단일 agent 실행이 중심이다. | Orca 우세 |
| 실제 다중 agent orchestration | Task, dependency, Dispatch, heartbeat, retry, Decision Gate와 coordinator loop를 사용할 수 있다. | Baton은 더 엄격한 설계를 갖고 있지만 scheduler는 미구현이다. | Orca 우세 |
| stale worker 차단 | 이전 retry의 완료 메시지나 잘못된 terminal의 완료 메시지가 현재 Task를 끝내지 못하게 한다. | Baton 설계에도 있지만 child runtime은 비활성이다. | Orca 우세 |
| 폭넓은 CLI agent 지원 | Claude, Codex, Gemini 외에도 Cursor, OpenCode, Grok, Copilot, Kimi, Hermes, Pi 등 다양한 agent를 실행한다. | Baton은 Claude, Codex, Gemini adapter 중심이다. | Orca 우세 |
| 같은 native session의 모델 변경 | Claude와 Codex 대화 안에서 사용자가 모델을 수동 변경할 수 있다. | Baton도 turn별 모델 선택을 제공한다. | 양쪽 가능, 자동 fallback은 Baton만 목표 |
| Native Session History | 여러 agent의 과거 session을 한 화면에서 검색하고 원래 provider CLI로 resume할 수 있다. | Baton은 preview와 canonical fork-copy import를 제공하지만 UI 범위는 더 좁다. | 일반적인 native resume는 Orca 우세 |
| Built-in browser와 Design Mode | worktree별 browser에서 화면을 확인하고 요소를 agent에게 전달하며 UI 문제를 수정할 수 있다. | Built-in browser는 미구현이다. | Orca 우세 |
| Computer Use | desktop application을 click, scroll, drag, type, key, hotkey로 조작할 수 있다. | Computer Use는 미구현이다. | Orca 우세 |
| Scheduled automation | hourly, daily, weekly, cron, RRULE 작업과 precheck, headless run, 실행 이력을 제공한다. | Persistent Goal은 있지만 일반 예약 automation은 별도 확장 범위다. | Orca 우세 |
| 모바일 companion | 휴대전화에서 agent 상태, terminal, 승인 질문과 계정 사용량을 확인하고 조작할 수 있다. | 모바일 client가 없다. | Orca 우세 |
| SSH와 remote server | 원격 장비와 임시 VM에서도 worktree와 agent를 동일한 UI로 관리한다. | 로컬 단일 사용자 control plane이다. | Orca 우세 |
| 개발 서비스 통합 | GitHub, GitLab, Bitbucket, Linear, Jira와 Azure DevOps 작업을 앱에서 연결한다. | 일부 connector와 plugin 경계만 있다. | Orca 우세 |
| 제품 범위와 사용자 경험 | 계정 확인부터 코드 작성, 검토, 병합과 원격 제어까지 하나의 개발 흐름으로 연결된다. | Baton은 더 좁고 깊은 account와 canonical 영역에 집중한다. | 일반 개발환경은 Orca 우세 |

### 두 제품이 각각 더 잘하는 문제

| 문제 영역 | 더 적합한 제품 | 이유 |
|---|---|---|
| 여러 agent를 동시에 실행하고 코드를 비교, 검토, 병합 | Orca | 완성된 ADE, worktree와 orchestration runtime이 있다. |
| browser, desktop, 모바일과 원격 장비까지 포함한 개발환경 | Orca | 관련 실행 경로와 UI가 이미 구현돼 있다. |
| 계정 소진 시 자동 스왑하고 실패한 동일 요청을 살리기 | Baton | Orca에는 inference router와 same-request failover가 없다. |
| Claude와 Codex가 같은 대화를 이어서 수행하기 | Baton | Orca 대화는 provider-owned이고 Baton은 canonical thread를 소유한다. |
| provider가 바뀌어도 하나의 장기 목표를 계속 수행하기 | Baton | Baton에는 Persistent Goal이 있고 Orca Task는 native terminal orchestration이다. |
| 독립 검수와 accepted artifact를 포함한 장기 Work runtime | 아직 없음 | Orca는 worker_done으로 Task를 완료하고 Baton도 acceptance runtime은 설계 단계다. |

가장 공정한 결론은 Orca가 더 좋은 개발 작업장이고, Baton은 Orca가 소유하지 않는 account
routing과 provider-neutral continuity를 담당하는 control plane이라는 것이다. Baton이 Orca의
IDE 기능을 복제하기보다 Orca와 함께 사용할 수 있는 하위 계층으로 자리 잡는 전략도 가능하다.

### 이 설명에서 Orca를 탓하면 안 되는 부분

| 영역 | 판단 |
|---|---|
| worktree 병렬화, terminal, editor, diff review | Orca가 잘 해결한다. Baton을 만든 이유로 내세울 부분이 아니다. |
| Task DAG, Dispatch, heartbeat, Decision Gate | Orca에 실제 구현돼 있다. Baton이 현재 더 낫다고 주장하면 안 된다. |
| browser, Computer Use, 모바일, SSH | Orca가 훨씬 앞선다. |
| 자동 account/model failover | Orca가 해결하지 않은 실제 불편이며 Baton의 핵심 이유가 될 수 있다. |
| provider-neutral 같은 대화와 Persistent Goal | Orca의 제품 경계 밖에 남은 불편이며 Baton의 가장 구조적인 이유다. |

## 1. 계정과 한도 문제

| 사용자가 겪는 문제 | Baton이 만들려는 해결책 | Baton 현재 상태 | Orca 가능 여부 | Orca 소스 진단 |
|---|---|---:|---:|---|
| 계정마다 사용량과 reset 시간이 흩어져 있다 | 모든 provider/account의 quota, reset, 상태를 한 화면에 표시 | 구현 | 가능 | RateLimitService가 Claude, Codex, Gemini, OpenCode, Kimi, Grok 등 사용량을 polling하고 inactive account cache도 유지한다. |
| 계정 추가와 재로그인이 번거롭다 | OAuth 추가, 재인증, 삭제를 UI에서 처리 | 구현 | 가능 | Claude/Codex AccountService에 add, reauthenticate, remove가 실제 구현돼 있다. |
| 다른 계정으로 바꾸려면 설정 파일을 직접 만져야 한다 | UI에서 수동 계정 고정, 변경 | 구현 | 가능 | Orca selectAccount가 active account 설정을 갱신하고 Claude auth/Codex runtime home을 동기화한다. |
| 계정을 바꿨는데 실행 중 Codex가 이전 계정을 계속 쓴다 | request router가 매 요청의 실제 계정을 선택 | Native live gate 대기 | 일부 가능 | Orca도 이를 감지하지만 해결은 session restart다. UI가 "재시작 전에는 이전 계정 유지"라고 명시한다. |
| 한 계정이 소진되면 사용자가 직접 다른 계정을 찾아 바꿔야 한다 | quota/429를 근거로 다음 적격 계정 자동 선택 | 합성 검증, 실제 2계정 canary 대기 | 불가능 | Orca의 quota polling은 소스 주석상 "informational" UI용이다. rate-limit 결과에서 selectAccount로 이어지는 call path가 없다. |
| 한 계정에서 429가 난 현재 요청이 그대로 실패한다 | stream 시작 전이면 다른 계정으로 같은 요청 재시도 | 합성 검증, live gate 대기 | 불가능 | Orca에는 Anthropic /v1/messages나 OpenAI /responses를 중계하는 inference server가 없다. CLI process가 provider에 직접 요청한다. |
| 어떤 계정은 요청 모델을 사용할 수 없다 | 계정별 model catalog를 읽어 지원 계정만 후보로 선택 | Codex 합성 검증, live 대기 | 불가능 | Orca는 계정 identity와 usage는 읽지만 account entitlement별 model catalog 기반 request router는 없다. |
| 모델 한도가 찼을 때 작업이 멈춘다 | preferred/effective model 분리, 자동 fallback과 원 모델 복귀 | Fable 5에서 Opus 4.8로 전환 live 검증, 범용 보강 중 | 불가능 | Orca에는 수동 모델 변경과 agent의 auto 옵션은 있으나 provider 오류를 받아 다른 모델로 재전송하는 controller가 없다. |
| 사용자가 중지한 계정을 자동화가 다시 써서는 안 된다 | pause/resume/delete와 manual-pause 우선권 | 구현 | 동등 기능 없음 | Orca에는 active account 선택은 있지만 inference 후보 pool, pause epoch, one-shot dispatch grant가 없다. |
| 기존 Claude/Codex CLI, Desktop도 같은 account control plane을 써야 한다 | loopback proxy 설정 apply/remove와 rollback | 구현, 일부 live smoke 대기 | 불가능 | Orca는 Orca가 띄운 terminal CLI의 credential home을 관리한다. 외부 CLI/Desktop의 inference base URL을 Orca data plane으로 전환하지 않는다. |

### 자동 스왑에 대한 최종 판정

| 질문 | Orca 소스 판정 |
|---|---|
| 한도를 자동으로 읽는가? | 읽는다. |
| 여러 계정의 한도를 각각 보여주는가? | 보여준다. |
| 사용자가 클릭하면 계정을 바꾸는가? | 바꾼다. |
| 한도 초과를 감지하면 자동으로 다른 계정을 선택하는가? | 아니다. |
| 실패한 현재 요청을 다른 계정으로 재시도하는가? | 아니다. |
| 자동 model fallback과 recovery를 하는가? | 아니다. |

따라서 수동 hot-swap은 중복 기능이지만 자동 account swap과 same-request failover는 Baton의
명확한 차별점이다. 단, Baton도 실제 두 계정 live canary가 남아 있으므로 "운영 검증 완료"라고
표현해서는 안 된다.

## 2. 대화가 provider마다 끊기는 문제

| 사용자가 겪는 문제 | Baton이 만들려는 해결책 | Baton 현재 상태 | Orca 가능 여부 | Orca 소스 진단 |
|---|---|---:|---:|---|
| Claude 대화와 Codex 대화가 따로 존재한다 | Baton session/thread/item/event를 유일한 공통 정본으로 소유 | core 구현 | 불가능 | Orca NativeChatSession.sessionId는 소스에 명시적으로 provider-owned conversation id라고 정의돼 있다. |
| 한 provider의 한도가 끝나면 다른 provider가 맥락을 모른다 | 같은 canonical history를 선택 provider 요청으로 변환 | Claude/Codex 가능, Gemini live 차단 | 불가능 | Orca는 portable history를 다른 provider request로 materialize하지 않는다. |
| 여러 provider 대화를 한곳에서 보고 싶다 | 공통 transcript와 event UI | 부분 구현 | 가능 | Orca AI Vault가 여러 agent session store를 scan하고 Native Chat이 Claude/Codex/Grok transcript를 공통 화면 model로 decode한다. |
| "한곳에서 보기"가 실제 "같은 대화 공유"인지 헷갈린다 | 화면 통합과 정본 통합을 구분 | 설계 원칙 | 보기만 통합 | Native Chat type은 renderer-facing contract이고 원본은 transcript/hook/scrape다. 실행 정본으로 다시 provider에 materialize하지 않는다. |
| 앱을 재시작해도 대화를 이어야 한다 | Baton SQLite/WAL에서 같은 canonical thread resume | core 구현, live E2E 일부 대기 | 일부 가능 | Orca도 재개 가능하지만 claude --resume, codex resume처럼 원래 provider session을 재실행한다. |
| turn마다 provider/model을 바꾸고 싶다 | provider/model은 대화 정체성이 아니라 turn별 실행 선택 | provider 전환 부분 구현 | 같은 provider 모델만 가능 | Orca는 Claude 또는 Codex native session 안에서 /model로 모델을 바꿀 수 있다. 그러나 같은 logical conversation의 다음 turn provider를 Claude와 Codex로 바꾸는 구조는 아니다. |
| provider-private reasoning/tool 상태를 억지로 옮기면 깨진다 | portable item과 provider-private binding을 분리하고 safe boundary에서만 전환 | 부분 구현 | 불가능 | Orca에는 cross-provider continuation 자체가 없어 portable/private failover 경계도 없다. |
| 대화를 특정 시점에서 안전하게 분기하고 싶다 | immutable history의 exact-cut canonical fork | API 구현, UI 미완 | 불가능 | Orca의 git worktree fork는 코드 checkout 분기다. conversation ledger fork와는 다르다. |
| 기존 native 대화를 Baton으로 가져오고 싶다 | read-only preview 후 승인된 별도 canonical fork-copy import | 구현 | 원본 resume만 가능 | Orca는 native transcript를 찾아 원래 CLI로 resume한다. 새 provider-neutral owner로 import하지 않는다. |
| 긴 대화가 model context를 넘는다 | 원문은 보존하고 model별 immutable derived compaction artifact 사용 | V1 구현 | 불가능 | Orca는 provider의 compaction event를 관찰하지만 공통 원문 ledger와 provider-neutral compaction chain은 없다. |
| provider cache가 다른 대화와 섞이거나 model 전환 때 끊긴다 | canonical thread별 비가역 prompt cache identity | 구현, 계측 대기 | 불가능 | Orca는 inference payload를 소유하지 않아 공통 prompt_cache_key를 강제할 위치가 없다. |

### Orca의 대화 구조를 쉽게 표현하면

| Orca가 하는 일 | Orca가 하지 않는 일 |
|---|---|
| Claude/Codex 등 각자의 transcript를 찾아 한 화면에 표시 | 여러 transcript를 하나의 공통 원장으로 합치지 않음 |
| transcript를 공통 NativeChatMessage 모양으로 decode | 그 message를 다른 provider의 다음 요청 history로 사용하지 않음 |
| 원래 session ID와 cwd를 찾아 원래 CLI로 resume | Claude session을 Codex session으로 이어주지 않음 |
| 여러 agent terminal을 나란히 실행 | 하나의 conversation identity를 여러 provider가 turn별로 공유하지 않음 |

## 3. 장기 작업이 중간에 멈추는 문제

| 사용자가 겪는 문제 | Baton이 만들려는 해결책 | Baton 현재 상태 | Orca 가능 여부 | Orca 소스 진단 |
|---|---|---:|---:|---|
| 한 번 답하고 끝나지 말고 목표가 끝날 때까지 계속했으면 한다 | conversation에 Persistent Goal을 귀속하고 자동 후속 turn 실행 | V1 구현 | 동등 기능 없음 | Orca 소스에는 ConversationGoal, persistent objective projection 또는 동일 계약이 없다. |
| provider를 바꾸면 장기 목표도 사라진다 | Goal을 provider가 아닌 canonical thread가 소유 | V1 구현 | 불가능 | Orca automation/task는 provider terminal에 연결되고 공통 conversation owner가 없다. |
| 자동 실행이 끝없이 반복될 수 있다 | 최대 turn, 시간, token budget, 연속 no-progress 한도 | V1 구현 | 일부 가능 | Orca coordinator에는 heartbeat timeout과 3회 failure circuit breaker가 있지만 conversation Goal의 turn/time/no-progress 계약은 아니다. |
| 사용자가 잠시 멈추거나 목표를 수정해야 한다 | Goal pause/resume/edit/clear와 CAS revision | V1 구현 | 일부 가능 | Orca Task status, gate, automation enable/disable은 있지만 conversation-owned Goal lifecycle과는 다르다. |
| 정해진 시간마다 agent 작업을 실행하고 싶다 | Baton 장기 automation 목표 | 별도 확장 | Orca 우세 | Orca AutomationService에 scheduled/manual run, precheck, headless dispatch, run history가 구현돼 있다. |

## 4. 도구 실행과 실패를 믿을 수 없는 문제

| 사용자가 겪는 문제 | Baton이 만들려는 해결책 | Baton 현재 상태 | Orca 가능 여부 | Orca 소스 진단 |
|---|---|---:|---:|---|
| agent가 무엇을 실행했는지 provider마다 기록 방식이 다르다 | provider-neutral tool call/result ledger | file tools 구현 | 보기만 가능 | Orca Native Chat이 tool call/result를 decode해 보여주지만 실행을 공통 broker가 중개하지 않는다. |
| 실행 직전에 앱이 죽으면 실행 여부를 모른다 | effect 전에 tool call 기록, result 후 provider 재개 | broker 구현 | 불가능 | 각 provider CLI가 tool을 직접 실행하므로 Orca가 모든 effect의 durable-before-effect 순서를 보장하지 않는다. |
| 결과를 잃은 mutation을 자동 재시도하면 중복 피해가 난다 | unknown outcome 기록 후 자동 replay 금지 | 부분 구현 | 공통 계약 없음 | 일부 Orca RPC는 idempotency를 쓰지만 모든 provider tool mutation에 적용되는 ledger는 없다. |
| 대화별 권한을 일관되게 고정하고 싶다 | read_only/workspace/full_access를 turn 시작 시 immutable snapshot | profile 구현, approval 미구현 | 일부 가능 | Orca는 agent별 CLI flag를 manual/yolo/mixed로 매핑하고 native approval을 중계하지만 공통 세부 권한 snapshot은 아니다. |
| 멀리서도 승인 질문에 답하고 싶다 | 향후 canonical approval wait | 미구현 | 가능 | Orca가 native PermissionRequest를 Allow/Deny card로 표시하고 PTY에 선택 값을 돌려보내며 모바일도 지원한다. |
| 취소 후 어디까지 실행됐는지 알아야 한다 | canonical cancel, orphan recovery, reconciliation API | 부분 구현 | 일부 가능 | Orca는 terminal stop, session restore와 orchestration reconciliation이 있지만 provider turn/tool 전체의 canonical recovery는 아니다. |

## 5. 여러 agent의 결과를 관리하기 어려운 문제

| 사용자가 겪는 문제 | Baton이 만들려는 해결책 | Baton 현재 상태 | Orca 가능 여부 | Orca 소스 진단 |
|---|---|---:|---:|---|
| 여러 agent가 같은 파일을 건드려 충돌한다 | 작업별 격리와 resource policy | Work runtime 미구현 | Orca 우세 | Orca가 실제 git worktree를 만들고 agent terminal, browser, UI를 worktree별 격리한다. |
| 큰 일을 여러 작은 일로 나눠 병렬 실행하고 싶다 | WorkSet/WorkGraph와 scheduler | 기반만 존재 | 가능 | Orca SQLite에 Task, parent, dependency, status가 있고 coordinator가 ready task를 병렬 dispatch한다. |
| worker가 누구에게 무엇을 보고해야 하는지 모른다 | canonical assignment와 lineage | 부분 기반 | 가능 | Orca에 Message, Dispatch Context, taskId/dispatchId, heartbeat, worker_done가 구현돼 있다. |
| 오래된 worker 결과가 현재 retry를 완료 처리하면 안 된다 | assignment epoch/stale attempt fencing | 설계 | 가능 | Orca가 현재 dispatchId와 assignee pane identity를 검사하고 stale/wrong-sender completion을 거부한다. |
| 사람이 결정해야 하는 질문에서 작업을 멈춰야 한다 | Decision gate와 user authority | 설계 | 가능 | Orca Decision Gate가 Task를 blocked로 만들고 사용자가 resolve하면 ready로 되돌린다. |
| worker가 "끝났다"고 말한 것과 검수 통과를 구분해야 한다 | ResultCandidate, verifier, AcceptanceReceipt, accepted artifact 분리 | 미구현 | 불가능 | Orca는 유효한 assignee의 worker_done을 받으면 Task를 즉시 completed로 변경한다. 독립 verifier/acceptance row가 없다. |
| agent가 자기 권한 밖의 계획, 목표를 바꾸면 안 된다 | proposal과 canonical mutation 분리, single writer | 미구현 | 동등 계약 없음 | Orca coordinator/DB가 상태를 쓰지만 semantic proposal journal과 revisioned commit bundle은 없다. |
| 작업 그래프 변경 이력과 결과 무효화를 추적해야 한다 | versioned WorkGraph revision과 invalidation closure | 미구현 | 불가능 | Orca Task deps는 JSON 배열이며 graph revision/accepted artifact provenance가 없다. |
| provider-native subagent가 정본 밖 작업을 만들면 안 된다 | Baton-owned child ID, 예산, 권한, lease 없이는 실행 차단 | 차단 모드만 구현 | 불가능 | Orca는 native agent/subagent와 terminal 실행을 장려하며 이를 하나의 canonical conversation tree로 강제하지 않는다. |

### 오케스트레이션 영역의 공정한 결론

| 항목 | 더 앞선 쪽 |
|---|---|
| 지금 바로 여러 agent/worktree를 만들고 병렬 실행 | Orca |
| Task dependency, dispatch, heartbeat, gate, retry | Orca |
| worker 완료와 독립 검수/acceptance 분리 | 둘 다 아직 부족; Baton은 설계만 더 강함 |
| provider 교체에도 유지되는 canonical Goal/Conversation/Run 권위 | Baton의 구현, 설계 방향 |
| versioned dynamic WorkGraph와 accepted artifact provenance | 둘 다 현재 제품 기능 아님 |

## 6. 개발환경과 원격 작업 문제

| 필요한 기능 | Baton 현재 | Orca 가능 여부 | 판정 |
|---|---:|---:|---|
| terminal split, editor, file explorer, diff review | 제한적 host/file tools | Orca 우세 | Orca의 핵심 ADE 기능이다. |
| git worktree 생성, 비교, 병합 | Work runtime 목표 | Orca 우세 | 실제 worktree runtime과 source-control UI가 있다. |
| built-in browser와 Design Mode | 미구현 | Orca 우세 | AgentBrowserBridge에 snapshot/click/fill/screenshot 등이 구현돼 있다. |
| desktop Computer Use | 미구현 | Orca 우세 | macOS/Windows/Linux provider와 click/scroll/drag/type/key/hotkey 구현이 있다. |
| 모바일에서 terminal, 승인, 계정 사용량 확인 | 미구현 | Orca 우세 | iOS/Android companion과 host RPC가 있다. |
| SSH/remote server/ephemeral VM | 범위 밖 | Orca 우세 | remote execution host와 SSH worktree가 구현돼 있다. |
| GitHub, GitLab, Linear, Jira 작업 통합 | 제한적/별도 plugin | Orca 우세 | provider별 integration과 UI가 있다. |
| 임의 CLI agent 지원 | Claude/Codex/Gemini adapter 중심 | Orca 우세 | Orca는 terminal에서 실행 가능한 다수 CLI agent와 custom command를 지원한다. |

## 7. Baton 설계 원칙을 Orca에 대입

| Baton 설계 원칙 | 쉬운 뜻 | Orca가 만족하는가? | 이유 |
|---|---|---:|---|
| Canonical ownership | 대화의 진짜 원본은 Baton 하나다 | | Orca session ID와 transcript는 provider-owned다. |
| Turn-scoped routing | provider/model/account는 매 turn 바꿀 수 있다 | | Orca 선택은 terminal/native session launch 중심이다. |
| Proposal is not mutation | agent 제안이 곧 상태 변경은 아니다 | | orchestration DB가 일부 검증하지만 semantic proposal/commit 체계는 없다. |
| Result is not acceptance | worker 결과와 검수 통과는 다르다 | | 유효한 worker_done이 Task를 바로 completed로 만든다. |
| Portable boundaries only | 옮길 수 있는 완료 상태에서만 provider 전환 | | cross-provider conversation 전환 자체가 없다. |
| Durable before effect | 실행 의도를 먼저 기록하고 실행한다 | | provider CLI tool 실행은 Orca 공통 broker를 지나지 않는다. |
| Least authority | 실행, 계정, 검수, 완료 권한을 나눈다 | | native permission/gate는 있으나 전 계층 권한 분리는 아니다. |
| Fail closed | 확실하지 않으면 추측 실행하지 않는다 | | 여러 subsystem에 안전 검사가 있지만 공통 conversation/effect 계약은 아니다. |
| Compatibility is not authority | native session은 호환 수단이지 정본이 아니다 | | Orca는 native transcript와 resume command를 실제 session authority로 사용한다. |
| Honest status | 구현, test, live 검증을 구분한다 | 비교 불가 | 제품 기능이 아니라 Baton 문서 운영 원칙이다. |

## 8. Baton의 입지

| 구분 | 기능 | 판단 |
|---|---|---|
| Orca도 해결 | 사용량 대시보드, 계정 추가, 수동 hot-swap | 이것만으로 Baton을 차별화하면 안 된다. |
| Orca가 더 잘 해결 | ADE, worktree 병렬화, task orchestration, browser, computer use, 모바일, SSH | Baton이 정면으로 복제할 우선순위가 아니다. |
| Orca가 해결하지 못함 | 자동 account swap, same-request failover, model fallback/recovery | Baton account control plane의 핵심 차별점이다. |
| Orca가 해결하지 못함 | provider-neutral canonical conversation과 turn별 provider 교체 | Baton의 가장 구조적인 차별점이다. |
| Orca가 해결하지 못함 | Persistent Goal과 provider-neutral automatic continuation | Baton의 장기 작업 차별점이다. |
| Orca가 해결하지 못함 | 모든 provider tool effect의 durable ledger와 unknown-outcome recovery | Baton runtime이 완성하면 강한 차별점이 된다. |
| 아직 누구도 완성하지 못함 | 독립 acceptance, versioned dynamic WorkGraph, accepted artifact provenance | Baton도 설계 단계이므로 현재 우위로 광고하면 안 된다. |

### 가장 정확한 제품 설명

| 제품 | 한 문장 정의 |
|---|---|
| Orca | 여러 native AI agent를 worktree, terminal, IDE에서 병렬로 운용하는 Agent Development Environment |
| Baton | 계정과 provider가 바뀌어도 현재 요청, 대화 정본, 장기 목표가 끊기지 않게 하는 local control plane |

둘은 일부 겹치지만 동일 제품은 아니다. Baton이 방어해야 할 영역은 "더 좋은 IDE"가 아니라
자동 request routing + canonical conversation + persistent objective다.

## 9. Orca 소스 근거

| 판정 | Orca 소스 근거 |
|---|---|
| 수동 Codex 계정 선택 | [codex-accounts/service.ts#L251](https://github.com/stablyai/orca/blob/d9d939a33b5858495ffb33489a952f1ac9293610/src/main/codex-accounts/service.ts#L251-L285) : settings selection 변경 후 runtime home 동기화 |
| 수동 Claude 계정 선택 | [claude-accounts/service.ts#L333](https://github.com/stablyai/orca/blob/d9d939a33b5858495ffb33489a952f1ac9293610/src/main/claude-accounts/service.ts#L333-L367) : settings selection 변경 후 auth 동기화 |
| Codex 기존 session은 이전 계정 유지 | [CodexRestartChip.tsx#L199](https://github.com/stablyai/orca/blob/d9d939a33b5858495ffb33489a952f1ac9293610/src/renderer/src/components/CodexRestartChip.tsx#L199-L219) |
| usage polling은 정보 표시용 | [rate-limits/service.ts#L70](https://github.com/stablyai/orca/blob/d9d939a33b5858495ffb33489a952f1ac9293610/src/main/rate-limits/service.ts#L70-L89), [#L703](https://github.com/stablyai/orca/blob/d9d939a33b5858495ffb33489a952f1ac9293610/src/main/rate-limits/service.ts#L703-L729) |
| 여러 native session 목록 통합 | [session-scanner.ts#L46](https://github.com/stablyai/orca/blob/d9d939a33b5858495ffb33489a952f1ac9293610/src/main/ai-vault/session-scanner.ts#L46-L83) |
| 원래 provider CLI로 resume | [ai-vault-types.ts#L297](https://github.com/stablyai/orca/blob/d9d939a33b5858495ffb33489a952f1ac9293610/src/shared/ai-vault-types.ts#L297-L329) |
| Native Chat은 화면용 공통 contract | [native-chat-types.ts#L1](https://github.com/stablyai/orca/blob/d9d939a33b5858495ffb33489a952f1ac9293610/src/shared/native-chat-types.ts#L1-L30) |
| conversation ID는 provider-owned | [native-chat-types.ts#L110](https://github.com/stablyai/orca/blob/d9d939a33b5858495ffb33489a952f1ac9293610/src/shared/native-chat-types.ts#L103-L117) |
| transcript 전체를 provider별 decoder로 읽음 | [transcript-reader.ts#L32](https://github.com/stablyai/orca/blob/d9d939a33b5858495ffb33489a952f1ac9293610/src/main/native-chat/transcript-reader.ts#L32-L59) |
| 같은 native session의 수동 model 변경 | [agent-session-option-catalog-claude-codex.ts#L69](https://github.com/stablyai/orca/blob/d9d939a33b5858495ffb33489a952f1ac9293610/src/shared/agent-session-option-catalog-claude-codex.ts#L69-L101), [#L135](https://github.com/stablyai/orca/blob/d9d939a33b5858495ffb33489a952f1ac9293610/src/shared/agent-session-option-catalog-claude-codex.ts#L135-L153) |
| model 변경 command dispatch, 검증 | [native-chat-session-option-apply.ts#L120](https://github.com/stablyai/orca/blob/d9d939a33b5858495ffb33489a952f1ac9293610/src/renderer/src/components/native-chat/native-chat-session-option-apply.ts#L120-L171) |
| orchestration SQLite Task/Dispatch/Gate | [orchestration/db.ts#L103](https://github.com/stablyai/orca/blob/d9d939a33b5858495ffb33489a952f1ac9293610/src/main/runtime/orchestration/db.ts#L103-L195) |
| 잘못된/stale worker completion 차단 | [lifecycle-reconciliation.ts#L155](https://github.com/stablyai/orca/blob/d9d939a33b5858495ffb33489a952f1ac9293610/src/main/runtime/orchestration/lifecycle-reconciliation.ts#L155-L235) |
| worker_done이 Task를 즉시 completed 처리 | [lifecycle-reconciliation.ts#L227](https://github.com/stablyai/orca/blob/d9d939a33b5858495ffb33489a952f1ac9293610/src/main/runtime/orchestration/lifecycle-reconciliation.ts#L227-L238) |
| agent 권한은 manual/yolo CLI flag mapping | [tui-agent-permissions.ts#L4](https://github.com/stablyai/orca/blob/d9d939a33b5858495ffb33489a952f1ac9293610/src/shared/tui-agent-permissions.ts#L4-L31) |
| scheduled automation service | [automations/service.ts#L25](https://github.com/stablyai/orca/blob/d9d939a33b5858495ffb33489a952f1ac9293610/src/main/automations/service.ts#L25-L105) |
| embedded browser action bridge | [agent-browser-bridge.ts#L500](https://github.com/stablyai/orca/blob/d9d939a33b5858495ffb33489a952f1ac9293610/src/main/browser/agent-browser-bridge.ts#L500-L765) |
| Computer Use CLI action handlers | [cli/handlers/computer.ts#L78](https://github.com/stablyai/orca/blob/d9d939a33b5858495ffb33489a952f1ac9293610/src/cli/handlers/computer.ts#L78-L211) |

### 부재 판정에 사용한 소스 검색

| 찾은 계약 | 조사 결과 |
|---|---:|
| Anthropic inference endpoint /v1/messages | Orca src, native, mobile에서 0건 |
| OpenAI inference endpoint /responses | Orca src/main, native에서 0건 |
| account/rate-limit 모듈의 same-request, failover, account cooldown | 0건 |
| rate-limit 결과가 selectAccount를 호출하는 경로 | 0건; 호출자는 UI/mobile/RPC와 test |
| prompt_cache_key, provider-neutral compaction chain | 0건 |
| ConversationGoal, persistent goal, automatic goal continuation | 0건 |
| result candidate, acceptance receipt, accepted artifact | orchestration runtime schema에서 0건 |

문자열 0건만으로 부재를 단정하지 않았다. 위 검색 뒤 실제 account selection call graph,
inference endpoint 유무, provider session ownership, SQLite schema와 completion transition을 함께
읽어 판정했다.

## 10. Baton 기준 문서

| 범위 | Baton 문서 |
|---|---|
| 제품 문제, 설계 원칙, 현재 상태 | [README](../README.md) |
| 계정, quota, rotation 목표 | [Account control plane](DESIGN.md) |
| canonical conversation과 provider adapter | [Common session design](COMMON_SESSION_DESIGN.md) |
| Goal과 automatic continuation | [Persistent Goal runtime](PERSISTENT_GOAL_RUNTIME.md) |
| 파일, 명령, 권한, effect 기록 | [Host automation](HOST_AUTOMATION.md) |
| native session preview/import | [Native import and grouping](NATIVE_SESSION_IMPORT_AND_GROUPING.md) |
| native와 canonical authority 이행 목표 | [Native continuity bridge](NATIVE_SESSION_CONTINUITY_BRIDGE.md) |
| WorkSet/WorkGraph, acceptance 목표 | [Work-Centric Orchestration V4](WORK_CENTRIC_ORCHESTRATION_DESIGN_V4.md) |
| Orca와 Baton의 WorkGraph, worktree 토폴로지 상세 비교 | [WorkGraph topology analysis](ORCA_BATON_WORKGRAPH_TOPOLOGY_ANALYSIS.md) |
| 실제 구현/부분/미구현 판정 | [Implementation status](IMPLEMENTATION_STATUS.md) |
| Native proxy의 합성/live gate | [Native proxy TODO](BATON_NATIVE_CLAUDE_PROXY_TODO.md) |

## 11. 문서를 다시 조사해야 하는 조건

| 변화 | 재판정 대상 |
|---|---|
| Orca가 inference gateway를 추가 | 자동 account failover, model fallback 표 전체 |
| Orca가 한도 기반 automatic account selection을 추가 | 자동 스왑 차별점 |
| Orca가 transcript를 다른 provider 요청 history로 materialize | canonical conversation 차별점 |
| Orca가 provider-neutral Goal/Run을 추가 | Persistent Goal 차별점 |
| Orca가 verifier/acceptance artifact schema를 추가 | Work-centric acceptance 차별점 |
| Baton 실제 2계정 canary 완료 | Baton 자동 스왑 상태를 부분 검증에서 구현 완료로 변경 |
| Baton child scheduler/WorkGraph 구현 | 설계 목표를 현재 기능으로 재판정 |
