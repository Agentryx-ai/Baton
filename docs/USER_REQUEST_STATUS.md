# 사용자 요청 전체 점검표

> 상태 기준 시각: 2026-07-19 (Asia/Seoul)
>
> 이 문서는 대화에서 요청된 작업의 **누락 확인용 인벤토리**다. 제품 계약의 정본은
> [`COMMON_SESSION_DESIGN.md`](COMMON_SESSION_DESIGN.md), 현재 구현 판정의 정본은
> [`IMPLEMENTATION_STATUS.md`](IMPLEMENTATION_STATUS.md)다. 여기서 `완료`는 현재 코드·커밋·테스트·라이브
> 상태 중 해당 요구에 맞는 직접 근거가 있는 경우에만 사용한다.
>
> 현재까지 식별한 독립 요청·질문은 **111개**다. 아래 ID가 대화 요청의 추적 키이며, 커밋하지 않은 작업은
> 테스트가 통과했더라도 `진행 중` 또는 `부분 완료`로만 기록한다.

## 상태 표기

| 상태 | 의미 |
|---|---|
| 완료 | 요청 범위가 구현되고 직접 검증됨 |
| 부분 완료 | 유효한 일부가 구현됐지만 요청 전체를 충족하지 않음 |
| 진행 중 (NO-GO) | 작업 트리에 초안이 있으나 검증·통합 전이라 배포·커밋 불가 |
| 미착수 | 설계 또는 구현을 아직 시작하지 않음 |
| 검증 필요 | 구현 정황은 있지만 요청한 실제 환경/E2E 증거가 부족함 |
| 외부 차단 | 외부 인증·제품 계약 때문에 현재 live 검증 불가 |

## 0. 현재 안전 상태와 즉시 장애

| ID | 요청 | 상태 | 현재 근거와 남은 일 |
|---|---|---|---|
| LIVE-01 | `:4400` 새로고침 후 흰 화면 수정 | 완료 | 구버전 BFF가 `workStatus`를 생략할 때 UI가 `undefined.dot`에서 죽던 문제를 fail-safe 처리했다. `96235a0`; 실제 `/#conversations` 렌더와 브라우저 오류 0건 확인. 이미 굳은 기존 renderer 탭은 닫고 새 탭을 사용해야 할 수 있다. |
| LIVE-02 | 정상 Claude 계정에서 “organization has disabled subscription access” 오류 수정 | 부분 완료·영구 수정 검증 중 | 직접 원인은 정상 Max 계정을 95%에서 선제 pause하고, Claude Code OAuth가 거부되는 만료 테스트 계정을 선택한 정책이었다. live는 **정책 엔진 OFF**, 정상 계정 active, 만료 계정 paused, `fill-first`에서 Fable 5 smoke turn assistant 1개·오류 0개로 복구됐다. 영구 수정 WIP는 95/100% 자동 pause 제거, 전체 비수동-pause pool 보존, `fill-first` ACK 전 정책 시작 금지를 구현했고 정책 테스트 6/6·typecheck를 통과했다. 아직 원자적 커밋·전체 회귀·live 재검증 전이다. |
| LIVE-03 | 순차 소진을 위해 proxy를 `fill-first`로 전환 | 완료 | 설치된 CCS 계약이 `PUT {value}`임을 확인해 live gateway를 `fill-first`로 전환했다. Baton SPA의 잘못된 `POST {strategy}`와 session-affinity POST도 PUT 계약으로 수정하고 회귀 테스트를 추가했다. `ce608ee`. |
| LIVE-04 | 라이브 수정은 구현되는 즉시 4400에서 사용 가능하게 반영 | 부분 완료 | 흰 화면 핫픽스는 서버 재시작 없이 4400에 반영했다. 이후 기능은 아직 WIP라 검증 전 4400에 올리지 않았다. |

## 1. 프로젝트 목적·공개 저장소·개발 규율

| ID | 요청 | 상태 | 근거와 남은 일 |
|---|---|---|---|
| META-01 | 프로젝트 문서와 코어 소스를 읽고 앱의 목적·역할 확인 | 완료 | README/설계/구현상태가 account control plane과 canonical conversation runtime이라는 두 축을 명시한다. |
| META-02 | “Baton이 대화의 정본, provider는 현재 턴 어댑터”를 핵심 정체성으로 README에 강조 | 완료 | README 첫 설명, Why, Product invariants, Architecture에 반복 명시. `f5cd57c`. |
| META-03 | Claude/Codex/Gemini 등 여러 계정의 usage·상태·라우팅 관리도 동등한 핵심 정체성으로 유지 | 완료 | README Why/Current status/대시보드 및 account control plane 설계에 명시. |
| META-04 | Baton 저장소를 Agentryx-ai 조직의 public repo로 공개 | 완료 | `Agentryx-ai/Baton`, GitHub visibility=`PUBLIC`; 인증 헤더 없는 `curl`로 `https://github.com/Agentryx-ai/Baton` HTTP 200 재확인. |
| META-05 | 작업 전·중 원자적 커밋과 push | 부분 완료 | 기능별 원자 커밋과 main push가 지속됐다. 현재 신규 브랜치 `feat/canonical-runtime-workspace`에는 검증 전 WIP가 있어 의도적으로 미커밋 상태다. |
| META-06 | 큰 작업은 실제 DAG로 분해하고 독립 노드를 병렬 실행 | 진행 중 | follow-up backend/UI/stateless steer를 세 노드로 병렬화했다. 현재 통합 전 상태는 아래 AGENT 항목에 기록한다. |
| META-07 | Gemini는 환불 요청 중이므로 메시지를 보내지 말고 기존 대화만 열람 | 완료(운영 제약) | live Gemini 요청을 실행하지 않았다. 인증도 현재 차단 상태다. 이후에도 명시 해제 전 live 메시지 금지. |

## 2. Claude/Codex CLI·Desktop 프록시 자동 설정

| ID | 요청 | 상태 | 근거와 남은 일 |
|---|---|---|---|
| PROXY-01 | CLI/Desktop이 수동 gateway 입력 없이 Baton proxy를 쓰도록 자동 설정 | 완료 | Claude CLI/Desktop, Codex CLI/Desktop 대상별 설정 적용 API/UI 구현. `5a4aa28`. |
| PROXY-02 | 설정을 안정적으로 파싱하고 정확한 소유 키만 결정론적으로 교체 | 완료 | TOML/JSON 구조 파싱, 소유 키 충돌 검사, byte round-trip, 원자 교체 테스트. |
| PROXY-03 | 대상 프로세스가 확실히 종료된 경우에만 설정하고 lock이 남으면 오류 | 완료 | 프로세스 분류와 lock fail-closed 구현·테스트. |
| PROXY-04 | 네 클라이언트를 모두 끄지 않아도 선택한 대상만 독립 적용 | 완료 | 부분 target 파싱과 선택 대상만 process gate 적용. |
| PROXY-05 | 이미 적용된 대상은 적용됨 표시, 재적용 차단, 적용 해제 제공 | 완료 | applied/absent/conflict/unknown 검사 및 apply/unapply UI. |
| PROXY-06 | “확인 불가”, 부분 적용, 충돌 상태에서 복구 불가능한 UX 수정 | 완료 | 결정론적 conflict repair가 추가됐다. `513d01b`. unknown은 안전상 자동 덮어쓰지 않는다. |
| PROXY-07 | Codex `model_provider=openai` 유지 + `openai_base_url=Baton`을 옵션으로 제공 | 완료·live 검증 필요 | **기존 세션 유지**(`native-openai`)와 격리 custom provider 모드가 UI/설정에 존재. `5ddf647`. ChatGPT/API-key 각각의 실제 inference/no-direct-fallback smoke는 아직 필요하다. |
| PROXY-08 | 분리된 Baton provider 모드의 설명 개선 | 완료 | 설정 UI가 기존 OpenAI 대화와 분리되는 격리 모드임을 설명한다. |
| PROXY-09 | Codex CLI에도 native-openai가 필요한지 확인 | 부분 완료 | CLI와 Desktop은 같은 `~/.codex/config.toml`/로컬 thread store를 사용하므로 기존 `openai` 목록 유지에는 동일 옵션이 유효하다고 문서화했다. 실제 CLI inference 경유 smoke는 남음. |
| PROXY-10 | Claude CLI gateway 적용 후 기존 세션 목록 유지 | 완료 | 환경변수 transport만 변경하며 로컬 `--continue/--resume` 세션을 유지한다고 README에 명시. |
| PROXY-11 | Claude Desktop도 OpenAI처럼 base URL만 바꿔 기존 목록 유지 | 불가·안내 완료 | 공식 지원 gateway는 별도 inference provider로 전환되므로 기존 계정 Chat/Cowork 목록 보존을 약속할 수 없음을 README에 명시. |
| PROXY-12 | Claude connector precedence 경고를 README에 짧게 안내 | 완료 | `bdb08ed`; connectors가 필요하면 Baton proxy 설정을 해제·재시작하도록 안내. |
| PROXY-13 | 설정을 런타임에 읽는지, 재시작이 필요한지 안내 | 완료 | 설정 적용/해제는 대상 클라이언트를 완전 종료 후 수행하고 재시작하도록 README/UI 계약에 반영. account pause/routing은 다음 요청부터 반영되며 보통 클라이언트 재시작 불필요. |
| PROXY-14 | proxy 실제 경유와 선택 계정을 1% 변화 전에 판정 | 부분 완료 | UI target/log와 pause pool로 판단 가능하나, 요청 단위의 확정적 upstream account receipt/trace는 아직 제품 기능으로 완성되지 않았다. |
| PROXY-15 | Codex Desktop이 잘못된 Agentryx-ai 계정을 쓰는 문제 | 부분 완료 | local login 표시와 CLIProxy upstream 계정은 별개임을 README에 구분했고, paused 계정 우회 방지 수정(`4f81e66`)이 있다. 요청 단위 실제 계정 E2E 증거는 더 필요하다. |
| PROXY-16 | Codex canonical mode의 “requires zero execution environment roots”를 결정론적으로 해결 | 완료(구조)·live 검증 필요 | Codex native execution root를 넘기지 않고, 검증된 Baton `cwd`는 provider-neutral dynamic file tools로만 노출한다. isolated CODEX_HOME/project-doc 차단도 적용했다. 실제 workspace turn smoke는 WORKSPACE-06에 남아 있다. |
| PROXY-17 | 한글 응답이 `???`로 표시되는 문제 완전 수정 | 완료(현재 4400) | UTF-8 source/JSON/render 경로를 사용하며 이번 4400 브라우저 검증에서 한글 홈·대화·계정명이 정상 표시됐다. 과거 이미 손상 저장된 원문을 복구하는 migration은 별도 범위다. |

## 3. 계정·사용량·라우팅 정책

| ID | 요청 | 상태 | 근거와 남은 일 |
|---|---|---|---|
| ACCOUNT-01 | provider별 Claude/Codex target을 독립 평가 | 완료 | 정책 엔진이 provider별로 독립 tick을 수행한다. |
| ACCOUNT-02 | usable 계정이 정확히 1개면 그 계정을 target으로 하고 소진 계정 pause | 정책 교체 진행 중 | 기존 `876f76a`의 “두 계정만 active/95% 소진” 모델은 실제 CLIProxy failover를 약화했다. 새 WIP는 사용량으로 계정을 pause하지 않고 모든 비수동-pause 계정을 proxy pool에 남겨 `fill-first`가 순차 소진·3번째 이상 failover를 담당하게 한다. |
| ACCOUNT-03 | 수동 정지 계정은 어떤 경우에도 사용하지 않음 | 구현됨·live 재검증 필요 | 새 정책 테스트는 수동 paused 계정을 선택·resume하지 않음을 확인했다. proxy 요청 단위 trace로 한 번 더 검증하고 원자적 커밋해야 한다. |
| ACCOUNT-04 | round-robin/fill-first 의미를 UI에서 설명 | 완료 | 홈/설정에 전략 설명과 상태가 존재. |
| ACCOUNT-05 | quota 95%를 실제 소진으로 간주하지 않고 실제 429까지 사용 | 진행 중 (NO-GO) | 영구 수정 WIP에서 95/98/100% 자동 소진·pause를 제거했다. 실제 429/cooling/동일 요청 failover는 CLIProxy 책임으로 유지하며, Baton 정책은 `fill-first` 설정 ACK 없이는 시작하지 않는다. 전체 회귀·live 429 E2E가 남았다. |
| ACCOUNT-06 | 실제 429에서 같은 요청을 다음 유효 계정으로 재시도 | 검증 필요 | CLIProxy의 `quota-exceeded.switch-project` 책임이지만 현재 설치의 실제 failover E2E가 없음. |
| ACCOUNT-07 | 403 OAuth/구독 불가 계정을 INELIGIBLE로 제외 | 외부 계약 차단 | 현재 CCS accounts/quota API가 계정별 durable 403/INELIGIBLE 상태를 제공하지 않는다. 사용량만으로 추정 제외하면 정상 계정도 오판하므로, 지원 신호가 생길 때까지 명시적 수동 pause만 결정론적으로 안전하다. |
| ACCOUNT-08 | Claude Fable 5 전용 usage 게이지 표시 | 완료(코드)·4400 재시작 대기 | CCS 8.1.4가 새 Claude OAuth `limits[]`를 버리는 원인을 확인했다. BFF가 local management API에서 `weekly_scoped(Fable)`만 안전 보강해 `seven_day_fable5`/`Fable 5` window로 합치며 2분 cache·single-flight·fail-open을 적용했다. 테스트와 live 원문 discovery는 통과했고 현재 4400 프로세스 재시작 후 화면 검증이 남았다. |
| ACCOUNT-09 | usage freshness를 “n초 전 기준”으로 표시 | 부분 완료 | `useQuota`에는 age 계산이 있으나 현재 App의 quota fan-out에 연결되지 않음. |
| ACCOUNT-10 | usage를 대화 응답마다 반복 표시하지 않음 | 완료 | transcript 안의 매 usage 이벤트 대신 대화 단위 최신 요약으로 표시하도록 개선. |

## 4. Canonical conversation SSOT와 provider adapter

| ID | 요청 | 상태 | 근거와 남은 일 |
|---|---|---|---|
| SESSION-01 | provider-neutral 공통 세션 관리 계층 설계, Gemini 포함 | 완료(설계)·V1 구현 | canonical session/thread/turn/item/execution SQLite와 Claude/Codex/Gemini adapter가 존재. |
| SESSION-02 | Baton만 대화 정본이고 provider는 현재 턴 실행 어댑터 | 완료(계약)·부분 구현 | README/설계/SQLite/adapter 경계에 반영. ordered content parts, compaction, child execution 등 완성 전. |
| SESSION-03 | 응답마다 요청 model/실제 model/effort 등 turn 메타데이터 보존 | 완료 | assistant payload/turn provenance와 UI model label을 보존하며 Fable→Opus fallback도 구분. |
| SESSION-04 | Codex/Claude native subagent·task가 정본 밖 대화를 만들지 못하도록 차단 | 완료(차단 모드) | Codex app-server native child/MCP/plugin/shell surface 검증 및 차단. Claude/Gemini는 Baton 도구만 전달. |
| SESSION-05 | 향후 child execution은 Baton이 ID·계보·예산·권한을 소유 | 부분 완료 | execution schema와 delegation disabled 계약만 존재. child API/scheduler/join/cancel은 미구현. |
| SESSION-06 | Codex native thread SSOT 모드와 Baton canonical runtime을 모순 없이 분리 | 완료(설계/설정) | native client proxy는 Codex thread SSOT, canonical runtime은 Baton SSOT로 명시. 자동 merge하지 않음. |
| SESSION-07 | provider 간 fork/DB 직접 수정으로 이중 SSOT를 만들지 않음 | 완료(정책) | DB/JSONL 직접 mutation 금지, native import는 명시적 fork-copy만 수행. |
| SESSION-08 | Codex/Claude 세션 포맷 차이를 분석하고 Baton이 달라야 하는 부분 반영 | 부분 완료 | provider-private continuation과 turn별 provenance를 분리했다. ordered content/artifact/compaction 모델은 남음. |
| SESSION-09 | `prompt_cache_key`를 Baton 대화별 고유하게 사용 | 미구현 | 현재 소스에 `prompt_cache_key`/동등한 명시적 session cache key가 없다. provider 기본 캐싱에만 의존하므로 적대적 검수 요구를 아직 충족하지 못했다. |

## 5. 네이티브 세션 가져오기·검색·그룹화

| ID | 요청 | 상태 | 근거와 남은 일 |
|---|---|---|---|
| IMPORT-01 | Codex Desktop뿐 아니라 같은 로컬 store의 CLI/IDE/exec/subagent 출처를 정확히 명명 | 완료 | `codex_desktop` 혼합 표기를 `codex_local`로 교정하고 origin/filter를 제공. `c974099`. |
| IMPORT-02 | Claude Desktop/Code와 Codex local 세션을 read-only preview 후 명시적으로 가져오기 | 완료 | CSRF, realpath, receipt, source provenance, 멱등 fork-copy import 구현. |
| IMPORT-03 | Codex 수천 세션 검색이 장시간 걸리는 병목 수정 | 완료 | 본문 전체 파싱 대신 metadata-only scan/paging으로 변경. `c224d24`. |
| IMPORT-04 | Codex rollout을 regex로 잘못 파싱하지 않고 구조화 JSONL로 처리 | 구현됨·회귀 검증 필요 | 구조화 parser와 알려진 bookkeeping frame 경계를 사용. 최신 실제 2,887개 inventory 재측정은 남음. |
| IMPORT-05 | archived 제외 및 CLI/Desktop/exec/subagent 선택 가능 | 완료 | origin, includeSubagents, includeArchived 필터 제공. |
| IMPORT-06 | `request contains unsupported fields` 수정 | 검증 필요 | 현재 API DTO는 허용 필드를 엄격히 제한하며 UI와 공유 타입을 사용한다. 사용자가 본 실제 요청을 다시 재현한 E2E 증거는 부족하다. |
| IMPORT-07 | 최근 대화의 프로젝트 가시성·그룹 간격·세션 간격·정렬 개선 | 완료(현재 UI)·시각 재검수 필요 | project identity 충돌 방지, alias 표시, 정렬/간격 개선 커밋(`b9ebfff`, `86467a4`). 실제 4400 시각 회귀 검수는 최종 단계에서 반복. |
| IMPORT-08 | native 원본과 Baton 사이 authority 승계/동기화 | 미구현 | 현재 import는 별도 Baton logical-work fork다. authority epoch migration은 설계만 존재. |
| IMPORT-09 | native 원본의 명시적 `/goal`/goal lifecycle을 import 후 복원 | 미구현(발견 결함) | 현재 importer는 transcript만 가져오고 canonical `goals` projection을 만들지 않는다. 제목/첫 메시지로 추론하지 않고 명시 이벤트만 복원하는 요구는 [`../issues/native-import-must-restore-explicit-goals.md`](../issues/native-import-must-restore-explicit-goals.md)에 기록했다. |

## 6. 대화 UI/UX

| ID | 요청 | 상태 | 근거와 남은 일 |
|---|---|---|---|
| UI-01 | 3-column을 제거하고 대화 폭을 확보한 미니멀 레이아웃 | 완료(2-column)·시각 재검수 필요 | 앱 shell + sidebar + 최대 폭 transcript 구조. `dc757db`, `b9ebfff`. |
| UI-02 | 홈/대화/설정의 레이아웃을 일관되게 유지 | 완료 | 공통 앱 shell/nav 적용. `6daa0b6`. |
| UI-03 | 홈 대시보드에 계정별 usage·routing 핵심 정보 집중 | 완료 | dashboard overview, 계정 카드, policy, proxy 상태 제공. |
| UI-04 | Baton 대화를 별도 탭/좌측 sidebar로 분리 | 완료 | 대화 sidebar, project grouping, mobile drawer 구현. |
| UI-05 | provider 선택 설명 등 불필요한 문구 제거·연결 정보 스포일링 | 부분 완료 | 설명을 다수 정리하고 provider account disclosure를 접었다. 최신 화면의 모든 문구에 대한 최종 UX audit는 남음. |
| UI-06 | provider/model 목록을 실제 제품처럼 그룹화하고 effort를 알기 쉽게 표시 | 완료·catalog live 검증 필요 | provider별 server catalog, grouped model selector, effort mapping. Gemini catalog는 외부 차단. |
| UI-07 | Sol/Terra 모델 설명과 기본 표시 오류 수정, 입력창에는 설명 숨김 | 완료 | `c877e7e`, model label provenance 테스트. |
| UI-08 | 선택 model/provider에 실제 사용될 계정 정보를 hover/접힘으로 표시 | 완료 | `ProviderAccountDisclosure`와 account summary 구현. |
| UI-09 | Enter 전송, Shift+Enter 개행, IME 안전 | 완료 | `0714f0d` 및 composer 회귀 테스트. |
| UI-10 | 오류·추론 요약·어시스턴트·사용량을 Codex 스타일로 구분 | 완료(V1) | canonical item별 렌더러와 compact metadata/usage summary 구현. |
| UI-11 | tool call/result, Read/Edit 등을 기본 접힘으로 표시 | 완료(V1) | call/result를 한 compact entry로 묶고 details로 확장. |
| UI-12 | 긴 Claude/Codex 스타일 메시지에 Show more/접기 | 완료(V1) | 문자/줄 수 기반 deterministic long-message collapse 테스트. 사용자와 assistant 모두 현재 같은 정책이므로 역할별 재조정 가능. |
| UI-13 | 대화 로드시 최상단이 아니라 최신 하단부터 표시, 실시간은 하단 근처에서만 follow | 완료 | initial bottom positioning과 near-bottom follow helper 테스트. |
| UI-14 | 대화 삭제, 30일 휴지통, 복원, 기한 경과 자동 purge | 완료 | recoverable trash, startup/interval purge, UI restore. `8455948`. |
| UI-15 | assistant 이름은 필터가 아니라 설정으로 이동 | 완료 | Settings의 assistant display name 항목 존재. |
| UI-16 | 필터에 group뿐 아니라 sort 제공 | 완료 | session view preferences에 group/sort 포함. |
| UI-17 | 세션 상태 표시 | 완료 | idle/running/wait/tool/limit/failure/completion/import/archive 상태 projection. |
| UI-18 | active turn 중 추가 메시지, Stop과 Send 분리, pending FIFO 표시 | 진행 중 (UI만 검증) | UI/API 초안은 app typecheck 및 UI 테스트 10/10 통과. backend가 NO-GO라 실제 4400에는 배포하지 않음. |
| UI-19 | ChatGPT·Claude·Gemini 웹과 Codex/Claude Desktop/CLI의 대화 표시를 벤치마킹 | 부분 완료 | 2-column, compact tool details, long-message disclosure, model/effort metadata에 반영했다. 제품별 최신 버전의 동일 시나리오 스크린샷 비교표와 최종 시각 승인 기록은 아직 없다. Gemini에는 메시지를 보내지 않았다. |
| UI-20 | 테스트 메시지를 보내도 응답이 오지 않는 문제 | 부분 완료 | provider loop/오류 표시는 구현됐지만 당시 실제 실패 요청의 end-to-end 원인과 동일 조건 재검증 기록이 없다. Claude live routing 영구 수정 및 workspace live smoke와 함께 다시 확인해야 한다. |

## 7. 로컬 폴더 권한·프로젝트별 새 대화·도구

| ID | 요청 | 상태 | 근거와 남은 일 |
|---|---|---|---|
| WORKSPACE-01 | 사용자 허용 후 Baton이 로컬 폴더 파일에 접근 | 부분 완료 | 절대 `cwd`의 realpath 검증·CAS와 root 한정 read/list/search/write/replace 도구가 있다(`405d6bd`). Windows native folder picker host API도 명시적 interaction header, UTF-8 Base64 JSON, timeout·크기 제한·typed failure로 구현·커밋했다(`006a7d6`). 대화 UI 연결과 실제 폴더 live E2E가 남았다. |
| WORKSPACE-02 | 폴더별로 접근을 요청·허용 | 부분 완료 | BFF native picker 기반은 완료됐지만 UI의 폴더 선택·grant 흐름과 세션별 권한 표시가 아직 연결되지 않았다. |
| WORKSPACE-03 | 폴더(프로젝트)별 작업/세션 생성 | 부분 완료 | session에 verified `cwd`/project grouping은 있지만, 새 대화 시작 UX가 요구와 다르다. |
| WORKSPACE-04 | “새 대화” 클릭만으로 DB 세션을 만들지 않고 임시 composer에서 폴더/model/message를 고른 뒤 첫 전송 때 원자 생성 | 미착수 | 현재 dialog의 `대화 시작`이 즉시 `POST /sessions`를 호출한다. deferred draft + create-and-start atomic API/UX가 필요하다. |
| WORKSPACE-05 | 가져온 세션의 source cwd는 제안일 뿐, 명시 연결 전 권한 없음 | 완료 | source cwd와 authorized cwd를 분리하고 drift/junction 교체를 fail-closed 처리. |
| WORKSPACE-06 | 실제 file tool call이 동작 | 완료(V1)·live E2E 필요 | read/list/search/write/replace broker와 durability/realpath/CAS 테스트가 있다. 4400에서 사용자 선택 폴더를 연결한 실제 turn E2E는 남음. |
| WORKSPACE-07 | `run_command`도 안전하게 사용 | 미완료·fail-closed | Windows sandbox가 cwd 밖 read를 막는다는 검증이 부족해 광고하지 않는다. elevated backend/검증 뒤 opt-in 필요. |
| WORKSPACE-08 | 웹보다 Electron 등 Desktop 전환이 적합하면 전환 | 결정 필요 | 전체 Electron migration은 아직 하지 않았다. 현재 핵심 blocker는 웹 UI 자체가 아니라 BFF에 안전한 native directory grant/picker가 없는 점이다. 이를 작은 host capability로 해결 가능한지 먼저 구현·검증한 뒤 전환 여부를 결정한다. |

## 8. Agent loop, follow-up, Goal, tool lifecycle

| ID | 요청 | 상태 | 근거와 남은 일 |
|---|---|---|---|
| AGENT-01 | 한 번 응답하고 끝내지 않고 요청 완수까지 model/tool round를 반복 | 완료(V1) | provider-neutral broker와 Claude/Gemini/Codex bounded loop 구현. |
| AGENT-02 | 무한 루프 방지와 명확한 종료 조건 | 완료(V1) | turn timeout, provider readiness, tool/retry/output bounds, Goal 24턴/2시간/3회 no-progress. |
| AGENT-03 | persistent `/goal`을 provider-neutral하게 구현하고 Claude 호환 | 완료(V1) | durable CAS/event/lease/scheduler, UI 명령·panel, Claude/Codex adapter 연동. Gemini live만 외부 차단. |
| AGENT-04 | 실행 중 사용자 follow-up을 Codex `turn/steer` 또는 stateless safe boundary로 전달 | 진행 중 (NO-GO) | Codex live steer 기반(`fc70699`) 위에 durable API/store/orchestrator/UI와 Claude/Gemini safe-boundary steer를 통합했다. 마지막 shutdown/drain race 수정 후 orchestrator 26/26·typecheck가 통과했으나 최종 적대적 재검수·전체 회귀·커밋 전이다. |
| AGENT-05 | pending 사용자 입력을 자동 Goal continuation보다 우선 | 진행 중 (NO-GO) | queued user follow-up 우선, Goal scope capture/tuple 검증, targetless next-turn, bounded retry가 구현됐다. crash/startup/close 경계의 최종 적대적 재검수가 남았다. |
| AGENT-06 | accepted/unknown/requeue가 중복 실행 없이 durable | 진행 중 (NO-GO) | schema v12의 `steer|next_turn`, `delivery_unknown`, CAS/idempotency, accepted crash fail-close와 close-time drain 대기를 구현했다. 중복 실행 방지 최종 리뷰와 DB reopen 포함 전체 회귀 후에만 커밋한다. |
| AGENT-07 | Claude/Gemini follow-up을 tool-result 뒤 안전 경계에서 FIFO 삽입 | 진행 중 (NO-GO) | stateless adapter에 end/tool boundary FIFO, pause/max_tokens 순서, final/cancel/dispose race 처리를 구현하고 mock 검증했다. Gemini는 사용자 지시대로 live 호출하지 않았으며 전체 통합 검증이 남았다. |
| AGENT-08 | approval/user-input wait | 미구현 | 현재 blocker/approval lifecycle은 완성되지 않았다. |

### 현재 중단된 병렬 작업의 정확한 상태

1. **UI/API 노드** — Send/Stop 분리, 모델 잠금, pending FIFO 상태·취소까지 구현했다.
2. **Backend/store/orchestrator 노드** — schema v12, CAS/idempotency, Goal 우선순위, crash fail-close, shutdown drain까지
   구현했다. 마지막 수정 기준 orchestrator 26/26와 typecheck가 통과했다.
3. **Claude/Gemini stateless steer 노드** — safe-boundary FIFO와 final/cancel/dispose race를 mock 검증했다. Gemini live는 금지다.
4. **현재 판정은 여전히 NO-GO** — 최종 독립 적대적 재검수, 전체 test/lint/build, 원자적 커밋 전에는 완료로 올리지 않는다.

## 9. Context caching과 compaction

| ID | 요청 | 상태 | 근거와 남은 일 |
|---|---|---|---|
| CONTEXT-01 | 서로 다른 대화 A/B를 번갈아 실행해도 provider cache가 세션별로 작동하는지 설명 | 답변 완료·제품 검증 미완료 | 대화별 안정 prefix/cache key가 중요하다고 설명했으나 Baton에는 명시적 `prompt_cache_key`가 없어 실제 hit-rate instrumentation이 없다. |
| CONTEXT-02 | Codex CLI 세션 포맷과 Baton 포맷 비교, Baton만의 필수 차이 정의 | 완료(설계) | provider-neutral item/event, turn별 model provenance, provider-private binding 분리를 설계·부분 구현. |
| CONTEXT-03 | Codex auto compact 동작을 참고해 Baton auto compact 구현 | 미착수(구현) | Codex native compaction event 관측/기록만 한다. Baton context builder의 budget-triggered compaction은 없다. |
| CONTEXT-04 | compaction 시 정본 원문을 남길지 정본 자체를 축약할지 결정 | 완료(설계) | **원문 canonical items는 불변으로 보존**하고 compaction은 exact covered range/source hash를 가진 재생성 가능한 derived item으로 저장한다. 최신 valid compaction + uncovered suffix만 provider context에 materialize한다. [`COMMON_SESSION_DESIGN.md`](COMMON_SESSION_DESIGN.md) §7. |
| CONTEXT-05 | provider-private continuation을 잘못 compact하지 않음 | 완료(계약)·구현 필요 | pending provider-private blocks는 compact/타 provider 이동 금지로 계약했다. 실제 Baton compactor가 아직 없음. |

## 10. 모델·provider 표시와 fallback

| ID | 요청 | 상태 | 근거와 남은 일 |
|---|---|---|---|
| MODEL-01 | Codex CLI 소스를 참고해 모델 목록이 하드코딩인지 catalog인지 확인 | 완료 | 서버/provider catalog를 UI의 source로 사용하고 model 0개 provider를 비활성화. |
| MODEL-02 | Claude와 Gemini provider 지원 | 완료(V1)·Gemini live 차단 | stateless adapters와 catalog UI 존재. Gemini 인증 버그 때문에 live call 금지/불가. |
| MODEL-03 | Fable 5 요청이 Opus 4.8로 fallback될 때 문제 없이 실제 model 기록 | 완료·회귀 유지 | request/response model을 분리하고 Fable 5 live fallback provenance를 검증한 기록과 테스트가 있다. |
| MODEL-04 | 모델 표시 이름·순서·effort를 실제 제품과 비교 | 부분 완료 | grouping/label/effort UX를 개선했다. 공식 catalog가 바뀔 수 있으므로 최종 release 전 최신 설치 스키마 재검증 필요. |
| MODEL-05 | 모델 설명은 selector 목록에서만 필요하고 composer에는 노출하지 않음 | 완료 | composer는 compact selection만 표시. |

## 11. 표시 정책 관련 질문의 현재 결론

| ID | 질문 | 현재 결론 |
|---|---|---|
| DISPLAY-01 | Codex CLI는 중간 usage를 매번 안 보이는데 Baton은 왜 매번 보였나 | 초기 UI 결함이었다. 현재는 canonical usage 이벤트는 보존하되 transcript 밖 최신 요약으로 1회 표시한다. |
| DISPLAY-02 | 긴 Baton assistant 응답을 접는 것이 Claude/Codex Desktop과 같은가 | 두 제품도 긴 내용/도구 상세를 점진 노출하지만 동일한 임계값 계약은 아니다. Baton은 현재 문자·줄 수 기준으로 사용자/assistant 메시지를 접는다. 역할별 정책이 더 나은지는 최종 UX 검수 항목이다. |
| DISPLAY-03 | 도구 호출이 안 되면 agent loop가 없어서인가 | 현재는 agent loop와 workspace tool broker가 모두 있다. 도구가 안 보이면 verified cwd 부재, provider tool schema, 정책 제한, 또는 live integration 문제를 구분해야 한다. |
| DISPLAY-04 | Serena language server 초기화 실패가 proxy 문제인가 | Baton/CLIProxy의 provider proxy 오류가 아니라 별도 MCP/language-server 초기화 문제다. 수동 pause 계정 사용 여부와도 무관하다. |

## 12. Native proxy SSOT 적대적 검수·보안 경계

| ID | 요청 | 상태 | 근거와 남은 일 |
|---|---|---|---|
| REVIEW-01 | Codex Native Client Proxy/SSOT 제안서를 공식 계약·로컬 DB/config/log로 적대적 검수 | 완료(설계 판정) | custom `baton` provider가 기존 `openai` thread 가시성을 분리한다는 문제를 확인해 native-openai 옵션으로 반영했다. 결정 문서는 [`CODEX_NATIVE_PROXY_SSOT_DECISION.md`](CODEX_NATIVE_PROXY_SSOT_DECISION.md). |
| REVIEW-02 | 개인 로컬 proxy라는 실제 threat model로 정보 누출 결론 재검토 | 완료(정책) | Baton은 loopback local control plane이므로 외부 SaaS 전송 위험과 동일시하지 않는다. 그래도 auth 값은 UI/log/문서에 출력하지 않고 BFF가 upstream credential을 대체하며, canonical DB에는 plaintext provider opaque credential을 저장하지 않는다. |
| REVIEW-03 | proxy 실패 시 direct OpenAI silent fallback 차단 | 구현됨·live 검증 필요 | adapter/provider URL 검증과 Baton loopback bridge가 있다. Desktop ChatGPT/API-key 각 로그인 모드에서 proxy를 죽인 실제 no-direct-fallback smoke가 남아 있다. |
| REVIEW-04 | 기존 Codex thread ID/history/goal/archive를 transport 변경 뒤 보존 | 구현됨·live 검증 필요 | native-openai는 provider identity를 유지하고 base URL만 바꾼다. 대표 기존 thread의 list/resume/goal을 적용 전후 비교하는 live smoke가 남아 있다. |
| REVIEW-05 | DB/JSONL provider 직접 수정 금지와 rollback | 완료 | config parser/receipt 기반 apply/unapply만 사용하며 native thread DB/rollout의 provider tag를 직접 바꾸지 않는다. |

## 13. 아직 닫히지 않은 필수 결정·검증 순서

아래가 현재 실제 남은 작업의 우선순위다.

1. **Claude 영구 라우팅 수정** — 95% 선제 pause 제거, 실제 429 cooldown, 403 ineligible, 지원되는
   fill-first/failover 설정 확인 및 live E2E.
2. **현재 follow-up WIP 폐기 여부가 아니라 완결** — 확인된 세 correctness bug와 migration/race/API tests를 먼저 수정하고,
   stateless steer 테스트를 추가한 뒤 UI와 통합한다.
3. **native folder grant + deferred conversation creation** — 폴더 선택/허용 → 임시 composer → 첫 전송에서
   session+turn 원자 생성. 이 경로로 실제 read/write tool E2E를 수행한다.
4. **Fable 5 quota discovery** — 실제 quota raw schema에서 전용 window가 어디에 있는지 확인하고 누락 시 gateway/BFF
   별도 조회를 추가한다.
5. **Baton auto compaction** — immutable canonical history를 유지하는 derived compaction 정책을 context builder와
   SQLite/API/UI에 구현하고 exact-range/source-hash/replay/provider-switch tests를 추가한다.
6. **cache identity** — provider가 지원하는 경우 Baton thread별 안정적인 cache key를 적용하고 A/B 교차 실행 hit/miss를 계측한다.
7. **전체 완료 audit** — typecheck, lint, full tests, clean build, DB v10→v11 reopen, 4400 browser, Claude/Codex live turn,
   proxy failure/no-direct-fallback, workspace tool, Goal/follow-up 우선순위를 검증한다.

## 14. 명시적으로 누락 여부를 확인할 항목

다음은 대화에서 요청됐지만 아직 `완료`로 둘 수 없는 항목이다. 사용자가 요청 누락을 빠르게 확인할 수 있도록 따로 모았다.

- [ ] 실제 429 전까지 정상 Claude 계정을 유지하고 429에서 같은 요청을 failover
- [ ] 403/만료 Claude 계정을 자동 INELIGIBLE 처리
- [ ] Claude Fable 5 전용 usage 게이지 4400 재시작 후 시각 검증
- [ ] `prompt_cache_key` 또는 provider별 동등 cache identity의 Baton thread별 적용과 적대적 검수
- [ ] 실행 중 follow-up의 durable FIFO/steer/next-turn/Goal-priority 통합
- [ ] OS native 폴더 선택·권한 허용 UX
- [ ] 첫 메시지를 보낼 때만 session+turn을 원자 생성하는 새 대화 UX
- [ ] 선택 폴더에서 실제 Baton file tool live E2E
- [ ] provider-neutral Baton auto compaction 구현
- [ ] Baton-managed child execution 및 approval/user-input wait
- [ ] Codex native-openai ChatGPT/API-key 실제 proxy 경유와 no-direct-fallback smoke
- [ ] native 원본↔Baton authority migration/sync
- [ ] native import의 명시적 Goal lifecycle 복원과 기존 import dry-run backfill
- [ ] Gemini 인증 복구 후 catalog/turn/tool live 검증(사용자의 live-message 금지 해제 전 실행 금지)
