# 사용자 요청 전체 점검표

> 상태 기준 시각: 2026-07-19 10:49 (Asia/Seoul)
>
> 이 문서는 대화에서 요청된 작업의 **누락 확인용 인벤토리**다. 제품 계약의 정본은
> [`COMMON_SESSION_DESIGN.md`](COMMON_SESSION_DESIGN.md), 현재 구현 판정의 정본은
> [`IMPLEMENTATION_STATUS.md`](IMPLEMENTATION_STATUS.md)다. 여기서 `완료`는 현재 코드·커밋·테스트·라이브
> 상태 중 해당 요구에 맞는 직접 근거가 있는 경우에만 사용한다.
>
> 현재까지 식별한 독립 요청·질문은 **116개**다. 아래 ID가 대화 요청의 추적 키이며, 커밋하지 않은 작업은
> 테스트가 통과했더라도 `진행 중` 또는 `부분 완료`로만 기록한다.

### 이번 누락 감사 결과

- 기존 114개를 대화 순서대로 독립 재감사해 누락 2개(`PROXY-19`, `PROXY-20`)를 추가했다. 현재 결과는
  **116개 ID / 고유 ID 116개 / 중복 0개 / 알려진 미매핑 제품 요청 0개**다.
- 홈→대화 전환 race 수정은 `485dbd1`, cache identity·auto compaction은 `3e6f61a`로 원자 커밋했다.
  이 상태 문서까지 같은 branch origin에 push하며, `.serena/`는 사용자 소유 untracked 항목이라 작업 범위에서 제외한다.
- `:4400`은 schema v14 최신 build로 재가동됐다. 고아 reservation 차단 결함은 원자 reserve/reclaim으로
  해결했고, 전체 378/378과 독립 적대적 `APPROVE`, Claude/Codex/file-tool live gate를 통과했다.
- 외부 차단 또는 사용자 결정이 필요한 요구도 삭제하지 않고 `외부 차단`·`결정 필요`·`미구현`으로 유지했다.
- “짧게 답변”, “먼저 답변” 같은 응답 형식 지시와 감사 표현은 제품 작업 ID 수에서 제외한다.

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
| LIVE-01 | `:4400` 새로고침 후 흰 화면 수정 | 완료 | 구버전 BFF의 누락 `workStatus` fail-safe(`96235a0`)와 StrictMode 홈→대화 request-generation race(`485dbd1`)를 수정했다. 최신 production build의 새로고침·홈→대화 전환에서 main/composer가 표시되고 browser console error 0건을 확인했다. |
| LIVE-02 | 정상 Claude 계정에서 “organization has disabled subscription access” 오류 수정 | 부분 완료·영구 코드 및 재시작 상태 승인 | 4400을 새 코드로 재시작하고 정책 엔진 **ON**, gateway `fill-first`, 정상 계정 active 1개·수동 정지 계정 paused 1개·engine pause 0개를 live 재확인했다. 영구 코드는 95/100% 자동 pause 제거, 전체 비수동-pause pool, ON/OFF epoch 직렬화, 매 tick `fill-first` 2xx ACK, OFF crash-recovery journal을 구현했다. 독립 적대적 APPROVE, 정책 계약 16/16과 전체 306/306·build 통과. 실제 429 동일 요청 failover와 요청 단위 upstream 계정 trace는 남았다. |
| LIVE-03 | 순차 소진을 위해 proxy를 `fill-first`로 전환 | 완료 | 설치된 CCS 계약이 `PUT {value}`임을 확인해 live gateway를 `fill-first`로 전환했다. Baton SPA의 잘못된 `POST {strategy}`와 session-affinity POST도 PUT 계약으로 수정하고 회귀 테스트를 추가했다. `ce608ee`. |
| LIVE-04 | 라이브 수정은 구현되는 즉시 4400에서 사용 가능하게 반영 | 완료(현재 작업 범위) | derived row 0개인 v13 live DB를 v14로 올리고 integrity=`ok`, FK 위반 0을 확인했다. 최신 production build를 PID 36300으로 재가동해 `/baton/health`, SPA, Fable 게이지, Claude Fable, Codex Sol/High, 허용 폴더 file tool을 live 검증했다. derived row가 있는 실험용 v13은 추측 변환하지 않고 fail-closed한다. |

## 1. 프로젝트 목적·공개 저장소·개발 규율

| ID | 요청 | 상태 | 근거와 남은 일 |
|---|---|---|---|
| META-01 | 프로젝트 문서와 코어 소스를 읽고 앱의 목적·역할 확인 | 완료 | README/설계/구현상태가 account control plane과 canonical conversation runtime이라는 두 축을 명시한다. |
| META-02 | “Baton이 대화의 정본, provider는 현재 턴 어댑터”를 핵심 정체성으로 README에 강조 | 완료 | README 첫 설명, Why, Product invariants, Architecture에 반복 명시. `f5cd57c`. |
| META-03 | Claude/Codex/Gemini 등 여러 계정의 usage·상태·라우팅 관리도 동등한 핵심 정체성으로 유지 | 완료 | README Why/Current status/대시보드 및 account control plane 설계에 명시. |
| META-04 | Baton 저장소를 Agentryx-ai 조직의 public repo로 공개 | 완료 | `Agentryx-ai/Baton`, GitHub visibility=`PUBLIC`; 인증 헤더 없는 `curl`로 `https://github.com/Agentryx-ai/Baton` HTTP 200 재확인. |
| META-05 | 작업 전·중 원자적 커밋과 push | 완료(현재 작업 묶음) | 기능별 원자 커밋과 요청 인벤토리를 `feat/canonical-runtime-workspace`에 유지한다. UI race `485dbd1`, canonical context `3e6f61a`, 최종 상태 문서를 분리 커밋해 origin에 push한다. 사용자 소유 `.serena/`는 건드리지 않는다. |
| META-06 | 큰 작업은 실제 DAG로 분해하고 독립 노드를 병렬 실행 | 완료·계속 적용 | follow-up backend/UI/stateless steer를 독립 노드로 병렬화해 검수·통합·커밋했고, 현재 deferred session backend/UI와 compaction 사전 검토도 파일 소유권을 분리해 병렬 진행한다. |
| META-07 | Gemini는 환불 요청 중이므로 메시지를 보내지 말고 기존 대화만 열람 | 완료(운영 제약) | live Gemini 요청을 실행하지 않았다. 인증도 현재 차단 상태다. 이후에도 명시 해제 전 live 메시지 금지. |
| META-08 | 지금까지 요청한 모든 작업과 완수 여부를 누락 확인용으로 문서화 | 이번 감사 완료·계속 갱신 | 이 문서가 116개 독립 요청·질문을 ID별로 추적한다. 독립 재감사에서 기존 목록이 놓친 2개를 추가했으며 현재 중복·알려진 미매핑 제품 요청은 0개다. 완료·부분 완료·진행 중·미구현·검증 필요·외부 차단을 직접 근거와 남은 일로 구분했다. |

## 2. Claude/Codex CLI·Desktop 프록시 자동 설정

| ID | 요청 | 상태 | 근거와 남은 일 |
|---|---|---|---|
| PROXY-01 | CLI/Desktop이 수동 gateway 입력 없이 Baton proxy를 쓰도록 자동 설정 | 완료 | Claude CLI/Desktop, Codex CLI/Desktop 대상별 설정 적용 API/UI 구현. `5a4aa28`. |
| PROXY-02 | 설정을 안정적으로 파싱하고 정확한 소유 키만 결정론적으로 교체 | 완료 | TOML/JSON 구조 파싱, 소유 키 충돌 검사, byte round-trip, 원자 교체 테스트. |
| PROXY-03 | 대상 프로세스가 확실히 종료된 경우에만 설정하고 lock이 남으면 오류 | 완료 | 프로세스 분류와 lock fail-closed 구현·테스트. |
| PROXY-04 | 네 클라이언트를 모두 끄지 않아도 선택한 대상만 독립 적용 | 완료 | 부분 target 파싱과 선택 대상만 process gate 적용. |
| PROXY-05 | 이미 적용된 대상은 적용됨 표시, 재적용 차단, 적용 해제 제공 | 완료 | applied/absent/conflict/unknown 검사 및 apply/unapply UI. |
| PROXY-06 | “확인 불가”, 부분 적용, 충돌 상태에서 복구 불가능한 UX 수정 | 완료·과거 원인 미입증 | 결정론적 conflict repair가 추가됐다. `513d01b`. unknown은 안전상 자동 덮어쓰지 않는다. 사용자가 당시 본 Claude CLI/Desktop의 일시적 “확인 불가”가 백엔드 수정 중 상태 때문이었는지는 당시 진단 증거가 없어 단정하지 않는다. |
| PROXY-07 | Codex `model_provider=openai` 유지 + `openai_base_url=Baton`을 옵션으로 제공 | 완료·live 검증 필요 | **기존 세션 유지**(`native-openai`)와 격리 custom provider 모드가 UI/설정에 존재. `5ddf647`. ChatGPT/API-key 각각의 실제 inference/no-direct-fallback smoke는 아직 필요하다. |
| PROXY-08 | 분리된 Baton provider 모드의 설명 개선 | 완료 | 설정 UI가 기존 OpenAI 대화와 분리되는 격리 모드임을 설명한다. |
| PROXY-09 | Codex CLI에도 native-openai가 필요한지 확인 | 부분 완료 | CLI와 Desktop은 같은 `~/.codex/config.toml`/로컬 thread store를 사용하므로 기존 `openai` 목록 유지에는 동일 옵션이 유효하다고 문서화했다. 실제 CLI inference 경유 smoke는 남음. |
| PROXY-10 | Claude CLI gateway 적용 후 기존 세션 목록 유지 | 완료 | 환경변수 transport만 변경하며 로컬 `--continue/--resume` 세션을 유지한다고 README에 명시. |
| PROXY-11 | Claude Desktop도 OpenAI처럼 base URL만 바꿔 기존 목록 유지 | 불가·안내 완료 | 공식 지원 gateway는 별도 inference provider로 전환되므로 기존 계정 Chat/Cowork 목록 보존을 약속할 수 없음을 README에 명시. |
| PROXY-12 | Claude connector precedence 경고를 README에 짧게 안내 | 완료 | `bdb08ed`; connectors가 필요하면 Baton proxy 설정을 해제·재시작하도록 안내. |
| PROXY-13 | 설정 변경 시 안전한 종료·재시작 절차 안내 | 완료 | 설정 적용/해제는 대상 클라이언트를 완전 종료 후 수행하고 재시작하도록 README/UI 계약에 반영. account pause/routing은 다음 요청부터 반영되며 보통 클라이언트 재시작 불필요. 제품별 실제 hot-reload 시점 판정은 `PROXY-19`로 분리한다. |
| PROXY-18 | Claude Desktop이 CLI를 내부 호출하는지, 독립 코어·설정·세션인지 설명 | 답변 완료 | Claude Desktop은 `~/.claude/settings.json`을 따르는 CLI wrapper가 아니라 독립 애플리케이션 런타임·설정·세션 표면이다. 따라서 Claude CLI 설정만 바꿔 Desktop을 제어할 수 없다. |
| PROXY-19 | Claude/Codex CLI·Desktop별 설정을 런타임에 다시 읽는지 시작 시 한 번만 읽는지 판정하고, 불명확하면 테스트 방법 안내 | 부분 답변·제품별 live 재현 필요 | 안전한 공통 계약은 “완전 종료→결정론적 수정→재시작”으로 구현·안내했다. 그러나 네 클라이언트 각각의 config/env hot-reload 여부와 버전별 차이를 독립 live 재현해 확정한 증거는 아직 없다. 적용 전후 새 요청의 endpoint/process env/log를 비교하는 제품별 테스트가 남았다. |
| PROXY-20 | Codex Desktop도 CLI wrapper인지, 자체 코어·설정·세션 표면인지 설명 | 답변 완료·hot-reload는 별도 검증 | Codex Desktop은 CLI 프로세스를 단순 shell-out하는 wrapper로 보지 않으며 자체 UI와 app-server 실행 표면을 사용한다. 다만 Codex CLI와 `~/.codex/config.toml`, state DB, rollout store를 공유하므로 설정·세션 저장소 공유와 런타임 프로세스 독립을 구분해야 한다. 정확한 설정 reload 시점은 `PROXY-19`에 남겼다. |
| PROXY-14 | proxy 실제 경유와 선택 계정을 1% 변화 전에 판정 | 부분 완료 | UI target/log와 pause pool로 판단 가능하나, 요청 단위의 확정적 upstream account receipt/trace는 아직 제품 기능으로 완성되지 않았다. |
| PROXY-15 | Codex Desktop이 잘못된 Agentryx-ai 계정을 쓰는 문제 | 부분 완료 | local login 표시와 CLIProxy upstream 계정은 별개임을 README에 구분했고, paused 계정 우회 방지 수정(`4f81e66`)이 있다. 요청 단위 실제 계정 E2E 증거는 더 필요하다. |
| PROXY-16 | Codex canonical mode의 “requires zero execution environment roots”를 결정론적으로 해결 | 완료(구조)·live 검증 필요 | Codex native execution root를 넘기지 않고, 검증된 Baton `cwd`는 provider-neutral dynamic file tools로만 노출한다. isolated CODEX_HOME/project-doc 차단도 적용했다. 실제 workspace turn smoke는 WORKSPACE-06에 남아 있다. |
| PROXY-17 | 한글 응답이 `???`로 표시되는 문제 완전 수정 | 완료(현재 4400) | UTF-8 source/JSON/render 경로를 사용하며 이번 4400 브라우저 검증에서 한글 홈·대화·계정명이 정상 표시됐다. 과거 이미 손상 저장된 원문을 복구하는 migration은 별도 범위다. |

## 3. 계정·사용량·라우팅 정책

| ID | 요청 | 상태 | 근거와 남은 일 |
|---|---|---|---|
| ACCOUNT-01 | provider별 Claude/Codex target을 독립 평가 | 완료 | 정책 엔진이 provider별로 독립 tick을 수행한다. |
| ACCOUNT-02 | usable 계정이 정확히 1개면 그 계정을 target으로 하고 소진 계정 pause | 설계 변경·코드 완료 | 기존 “두 계정만 active/95% 소진” 모델을 폐기했다. 사용량으로 계정을 pause하지 않고 모든 비수동-pause 계정을 proxy pool에 남겨 `fill-first`와 CLIProxy가 순차 소진·3번째 이상 failover를 담당한다. `정책 1순위`는 관측값이다. |
| ACCOUNT-03 | 수동 정지 계정은 어떤 경우에도 사용하지 않음 | 구현됨·live 재검증 필요 | 적대적 race 검수와 테스트에서 수동 paused 계정을 선택·resume하지 않음을 확인했다. proxy 요청 단위 trace만 남았다. |
| ACCOUNT-04 | round-robin/fill-first 의미를 UI에서 설명 | 완료 | 홈/설정에 전략 설명과 상태가 존재. |
| ACCOUNT-05 | quota 95%를 실제 소진으로 간주하지 않고 실제 429까지 사용 | 코드 완료·live 429 E2E 필요 | 95/98/100% 자동 소진·pause를 제거했다. 실제 429/cooling/동일 요청 failover는 CLIProxy 책임이며, Baton 정책은 `fill-first` 2xx ACK 없이는 시작·유지되지 않는다. |
| ACCOUNT-06 | 실제 429에서 같은 요청을 다음 유효 계정으로 재시도 | 검증 필요 | CLIProxy의 `quota-exceeded.switch-project` 책임이지만 현재 설치의 실제 failover E2E가 없음. |
| ACCOUNT-07 | 403 OAuth/구독 불가 계정을 INELIGIBLE로 제외 | 외부 계약 차단 | 현재 CCS accounts/quota API가 계정별 durable 403/INELIGIBLE 상태를 제공하지 않는다. 사용량만으로 추정 제외하면 정상 계정도 오판하므로, 지원 신호가 생길 때까지 명시적 수동 pause만 결정론적으로 안전하다. |
| ACCOUNT-08 | Claude Fable 5 전용 usage 게이지 표시 | 완료·4400 live 확인 | CCS 8.1.4가 새 Claude OAuth `limits[]`를 버리는 원인을 확인했다. BFF가 local management API의 `weekly_scoped(Fable)`만 안전 보강해 `seven_day_fable5`/`Fable 5` window로 합치며 2분 cache·single-flight·fail-open을 적용했다. 최신 4400 홈에서 `Fable 5` 게이지 렌더를 확인했다. |
| ACCOUNT-09 | usage freshness를 “n초 전 기준”으로 표시 | 부분 완료 | `useQuota`에는 age 계산이 있으나 현재 App의 quota fan-out에 연결되지 않음. |
| ACCOUNT-10 | usage를 대화 응답마다 반복 표시하지 않음 | 완료 | transcript 안의 매 usage 이벤트 대신 대화 단위 최신 요약으로 표시하도록 개선. |

## 4. Canonical conversation SSOT와 provider adapter

| ID | 요청 | 상태 | 근거와 남은 일 |
|---|---|---|---|
| SESSION-01 | provider-neutral 공통 세션 관리 계층 설계, Gemini 포함 | 완료(설계)·V1 구현 | canonical session/thread/turn/item/execution SQLite와 Claude/Codex/Gemini adapter가 존재. |
| SESSION-02 | Baton만 대화 정본이고 provider는 현재 턴 실행 어댑터 | 완료(계약)·핵심 V1 구현 | README/설계/SQLite/adapter 경계와 canonical turn loop에 반영했다. ordered canonical items, provider별 materialization, immutable derived auto compaction까지 구현·승인했다. Baton-managed child execution은 별도 후속 범위다. |
| SESSION-03 | 응답마다 요청 model/실제 model/effort 등 turn 메타데이터 보존 | 완료 | assistant payload/turn provenance와 UI model label을 보존하며 Fable→Opus fallback도 구분. |
| SESSION-04 | Codex/Claude native subagent·task가 정본 밖 대화를 만들지 못하도록 차단 | 완료(차단 모드) | Codex app-server native child/MCP/plugin/shell surface 검증 및 차단. Claude/Gemini는 Baton 도구만 전달. |
| SESSION-05 | 향후 child execution은 Baton이 ID·계보·예산·권한을 소유 | 부분 완료 | execution schema와 delegation disabled 계약만 존재. child API/scheduler/join/cancel은 미구현. |
| SESSION-06 | Codex native thread SSOT 모드와 Baton canonical runtime을 모순 없이 분리 | 완료(설계/설정) | native client proxy는 Codex thread SSOT, canonical runtime은 Baton SSOT로 명시. 자동 merge하지 않음. |
| SESSION-07 | provider 간 fork/DB 직접 수정으로 이중 SSOT를 만들지 않음 | 완료(정책) | DB/JSONL 직접 mutation 금지, native import는 명시적 fork-copy만 수행. |
| SESSION-08 | Codex/Claude 세션 포맷 차이를 분석하고 Baton이 달라야 하는 부분 반영 | 완료(V1) | provider-private continuation과 turn별 provenance를 분리했다. ordered canonical item, immutable 원문, 파생 compaction artifact/execution manifest, full artifact-chain 검증과 provider-private retirement가 schema v14에 구현됐고 전체 378/378 및 독립 적대적 APPROVE를 통과했다. |
| SESSION-09 | `prompt_cache_key`를 Baton 대화별 고유하게 사용 | 구현 완료·provider 계측 대기 | canonical thread ID와 설치 비밀 HMAC으로 안정적이고 비가역적인 cache identity를 만든다. Codex loopback bridge가 client key를 강제 교체하고 Claude cache control도 연결했으며 unit/전체 회귀를 통과했다. 실제 provider A/B hit/miss 수치와 proxy 장애 no-direct-fallback live는 남았다. |

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
| UI-18 | active turn 중 추가 메시지, Stop과 Send 분리, pending FIFO 표시 | 완료(코드)·4400 live 대기 | durable backend/UI/stateless steer가 독립 적대적 APPROVE와 전체 회귀를 통과해 `f066f5d`로 커밋됐다. 실제 4400 렌더·전송 확인은 최종 live gate에 포함한다. |
| UI-19 | ChatGPT·Claude·Gemini 웹과 Codex/Claude Desktop/CLI의 대화 표시를 벤치마킹 | 부분 완료 | 2-column, compact tool details, long-message disclosure, model/effort metadata에 반영했다. 제품별 최신 버전의 동일 시나리오 스크린샷 비교표와 최종 시각 승인 기록은 아직 없다. Gemini에는 메시지를 보내지 않았다. |
| UI-20 | 테스트 메시지를 보내도 응답이 오지 않는 문제 | 완료·Claude/Codex live 확인 | 최신 4400에서 Claude Fable 5가 `CLAUDE_FABLE_LIVE_OK`, Codex GPT-5.6 Sol/High가 `CODEX_LIVE_OK`를 terminal 완료했고 한글·model·usage가 표시됐다. 테스트 대화는 휴지통으로 이동했다. |

## 7. 로컬 폴더 권한·프로젝트별 새 대화·도구

| ID | 요청 | 상태 | 근거와 남은 일 |
|---|---|---|---|
| WORKSPACE-01 | 사용자 허용 후 Baton이 로컬 폴더 파일에 접근 | 완료·live E2E 확인 | 절대 `cwd` realpath/CAS와 root 한정 도구(`405d6bd`), native picker host API(`006a7d6`), 대화 UI 선택·연결을 통합했다. 최신 4400의 허용 temp root에서 Codex가 실제 파일을 쓰고 다시 읽었다. |
| WORKSPACE-02 | 폴더별로 접근을 요청·허용 | 완료(코드)·host picker 수동 확인만 남음 | 명시적 사용자 클릭의 OS native picker, 취소·typed error, 기존/신규 세션별 연결·해제를 구현했다. root 연결과 도구 권한은 live 확인했으며 OS picker의 실제 마우스 선택은 브라우저 자동화 밖 수동 확인 항목이다. |
| WORKSPACE-03 | 폴더(프로젝트)별 작업/세션 생성 | 완료(코드) | 첫 turn 원자 생성 시 canonical cwd를 session grouping identity로 저장하며, 폴더 없는 `cwd=null` 일반 chat도 지원한다. |
| WORKSPACE-04 | “새 대화” 클릭만으로 DB 세션을 만들지 않고 임시 composer에서 폴더/model/message를 고른 뒤 첫 전송 때 원자 생성 | 완료·4400 live 확인 | 클릭 전후 session count가 같고, 첫 Enter 전송 때에만 draft ID와 같은 canonical session이 생성되어 Claude 응답까지 완료되는 것을 확인했다. 단일 idempotent PUT/`BEGIN IMMEDIATE`, unknown-delivery 재시도와 409 새 draft 처리 계약도 유지된다. |
| WORKSPACE-05 | 가져온 세션의 source cwd는 제안일 뿐, 명시 연결 전 권한 없음 | 완료 | source cwd와 authorized cwd를 분리하고 drift/junction 교체를 fail-closed 처리. |
| WORKSPACE-06 | 실제 file tool call이 동작 | 완료(V1)·Claude/Codex live E2E | 기존 Claude smoke에 이어 최신 4400에서 Codex가 임시 허용 root의 `baton-live-tool.txt`를 `write_file`→`read_file`로 처리하고 정확한 `BATON_WORKSPACE_LIVE_OK`를 반환했다. 파일 내용을 host에서 재확인했고 smoke session은 휴지통으로 이동했다. |
| WORKSPACE-07 | `run_command`도 안전하게 사용 | 미완료·fail-closed | Windows sandbox가 cwd 밖 read를 막는다는 검증이 부족해 광고하지 않는다. elevated backend/검증 뒤 opt-in 필요. |
| WORKSPACE-08 | 웹보다 Electron 등 Desktop 전환이 적합하면 전환 | 결정 필요 | 전체 Electron migration은 아직 하지 않았다. 현재 핵심 blocker는 웹 UI 자체가 아니라 BFF에 안전한 native directory grant/picker가 없는 점이다. 이를 작은 host capability로 해결 가능한지 먼저 구현·검증한 뒤 전환 여부를 결정한다. |

## 8. Agent loop, follow-up, Goal, tool lifecycle

| ID | 요청 | 상태 | 근거와 남은 일 |
|---|---|---|---|
| AGENT-01 | 한 번 응답하고 끝내지 않고 요청 완수까지 model/tool round를 반복 | 완료(V1) | provider-neutral broker와 Claude/Gemini/Codex bounded loop 구현. |
| AGENT-02 | 무한 루프 방지와 명확한 종료 조건 | 완료(V1) | turn timeout, provider readiness, tool/retry/output bounds, Goal 24턴/2시간/3회 no-progress. |
| AGENT-03 | persistent `/goal`을 provider-neutral하게 구현하고 Claude 호환 | 완료(V1) | durable CAS/event/lease/scheduler, UI 명령·panel, Claude/Codex adapter 연동. Gemini live만 외부 차단. |
| AGENT-04 | 실행 중 사용자 follow-up을 Codex `turn/steer` 또는 stateless safe boundary로 전달 | 완료(코드)·4400 live 대기 | durable API/store/orchestrator/UI와 Claude/Gemini safe-boundary steer를 통합했다. 독립 적대적 APPROVE와 관련 111/111, 전체 회귀를 통과해 `f066f5d`로 커밋했다. |
| AGENT-05 | pending 사용자 입력을 자동 Goal continuation보다 우선 | 완료 | queued user follow-up 우선, Goal scope/tuple 검증, targetless next-turn, bounded retry와 transient failure 보존을 검증했다. |
| AGENT-06 | accepted/unknown/requeue가 중복 실행 없이 durable | 완료 | schema v12 `steer|next_turn`, `delivery_unknown`, CAS/idempotency, accepted crash fail-close, close-time drain·DB reopen 경쟁 검증을 완료했다. |
| AGENT-07 | Claude/Gemini follow-up을 tool-result 뒤 안전 경계에서 FIFO 삽입 | 완료(코드)·Claude live 대기 | end/tool boundary FIFO, pause/max_tokens 순서, final/cancel/dispose race를 mock 검증했다. Gemini는 사용자 지시대로 live 호출하지 않았다. |
| AGENT-08 | approval/user-input wait | 미구현 | 현재 blocker/approval lifecycle은 완성되지 않았다. |

### Follow-up 병렬 통합의 최종 상태

1. **UI/API 노드** — Send/Stop 분리, 모델 잠금, pending FIFO 상태·취소까지 구현했다.
2. **Backend/store/orchestrator 노드** — schema v12, CAS/idempotency, Goal 우선순위, crash fail-close, shutdown drain까지
   구현했다. 마지막 수정 기준 orchestrator 26/26와 typecheck가 통과했다.
3. **Claude/Gemini stateless steer 노드** — safe-boundary FIFO와 final/cancel/dispose race를 mock 검증했다. Gemini live는 금지다.
4. **통합 판정 APPROVE** — 독립 적대적 검수와 관련 111/111, 전체 회귀 후 `f066f5d`로 원자 커밋했다. 4400 live UI 검증은 최종 live gate에 포함한다.

## 9. Context caching과 compaction

| ID | 요청 | 상태 | 근거와 남은 일 |
|---|---|---|---|
| CONTEXT-01 | 서로 다른 대화 A/B를 번갈아 실행해도 provider cache가 세션별로 작동하는지 설명 | 구현 완료·live hit/miss 계측 대기 | canonical thread별 HMAC cache identity로 A/B가 같은 key를 공유하지 않고 같은 대화 turn은 안정 key를 재사용한다. Codex bridge와 Claude cache-control을 포함한 전체 378/378을 통과했으며 실제 provider hit/miss 수치 계측은 남았다. |
| CONTEXT-02 | Codex CLI 세션 포맷과 Baton 포맷 비교, Baton만의 필수 차이 정의 | 완료(설계) | provider-neutral item/event, turn별 model provenance, provider-private binding 분리를 설계·부분 구현. |
| CONTEXT-03 | Codex auto compact 동작을 참고해 Baton auto compact 구현 | 완료(V1)·독립 APPROVE | schema v14, pre/post budget 검사, exact prompt·previous summary·portable delta·terminal receipt provenance, immutable artifact chain, head CAS, provider 호출 전 durable reservation을 구현했다. queued orphan과 다른 계약의 expired-running을 durable failed receipt로 정리하고 새 lease를 같은 `BEGIN IMMEDIATE`에서 획득한다. 두 crash 회귀를 포함한 전체 378/378, typecheck/lint/build, 독립 적대적 APPROVE를 통과했다. derived row가 있는 과거 v13은 의미를 추측하지 않고 fail-closed한다. |
| CONTEXT-04 | compaction 시 정본 원문을 남길지 정본 자체를 축약할지 결정 | 완료(설계) | **원문 canonical items는 불변으로 보존**하고 compaction은 exact covered range/source hash를 가진 재생성 가능한 derived item으로 저장한다. 최신 valid compaction + uncovered suffix만 provider context에 materialize한다. [`COMMON_SESSION_DESIGN.md`](COMMON_SESSION_DESIGN.md) §7. |
| CONTEXT-05 | provider-private continuation을 잘못 compact하지 않음 | 완료(V1) | summary generator에는 provider-private state를 전달하지 않고 canonical ledger에는 보존한다. covered private state는 새 summary 뒤 provider에 재생하지 않으며, materializer는 full artifact chain의 cycle/incomplete를 fail-closed한다. 독립 재검수에서 canonical 정보 손실·우회를 발견하지 않았다. |

## 10. 모델·provider 표시와 fallback

| ID | 요청 | 상태 | 근거와 남은 일 |
|---|---|---|---|
| MODEL-01 | Codex CLI 소스를 참고해 모델 목록이 하드코딩인지 catalog인지 확인 | 완료 | 서버/provider catalog를 UI의 source로 사용하고 model 0개 provider를 비활성화. |
| MODEL-02 | Claude와 Gemini provider 지원 | 완료(V1)·Gemini live 차단 | stateless adapters와 catalog UI 존재. Gemini 인증 버그 때문에 live call 금지/불가. |
| MODEL-03 | Fable 5 요청이 Opus 4.8로 fallback될 때 문제 없이 실제 model 기록 | 완료·회귀 유지 | request/response model을 분리하고 Fable 5 live fallback provenance를 검증한 기록과 테스트가 있다. |
| MODEL-04 | 모델 표시 이름·순서·effort를 실제 제품과 비교 | 부분 완료 | grouping/label/effort UX를 개선했다. 공식 catalog가 바뀔 수 있으므로 최종 release 전 최신 설치 스키마 재검증 필요. |
| MODEL-05 | 모델 설명은 selector 목록에서만 필요하고 composer에는 노출하지 않음 | 완료 | composer는 compact selection만 표시. |
| MODEL-06 | “수동 정지 플래그된 모델”은 어떤 경우에도 사용하지 않음 | 의도 확인 필요 | 현재 제품의 수동 정지는 **계정** 단위이며 ACCOUNT-03으로 강제한다. provider model 자체에 대한 별도 수동 차단 플래그는 현재 도메인에 없으므로, 원문이 계정 오타가 아니라 model denylist 요구라면 미구현이다. |

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
| REVIEW-01 | Codex Native Client Proxy/SSOT 제안서를 공식 계약·로컬 DB/config/log로 적대적 검수 | 부분 완료·지정 runtime 검증 증거 없음 | custom `baton` provider가 기존 `openai` thread 가시성을 분리한다는 설계 판정은 native-openai 옵션에 반영했다. 다만 사용자가 요구한 `gpt-5.6-sol/high` authoritative runtime header 검증 결과가 저장소에 남아 있지 않아, 요청 형식 그대로의 독립 검수 완료로는 주장하지 않는다. 결정 문서는 [`CODEX_NATIVE_PROXY_SSOT_DECISION.md`](CODEX_NATIVE_PROXY_SSOT_DECISION.md). |
| REVIEW-02 | 개인 로컬 proxy라는 실제 threat model로 정보 누출 결론 재검토 | 완료(정책) | Baton은 loopback local control plane이므로 외부 SaaS 전송 위험과 동일시하지 않는다. 그래도 auth 값은 UI/log/문서에 출력하지 않고 BFF가 upstream credential을 대체하며, canonical DB에는 plaintext provider opaque credential을 저장하지 않는다. |
| REVIEW-03 | proxy 실패 시 direct OpenAI silent fallback 차단 | 구현됨·live 검증 필요 | adapter/provider URL 검증과 Baton loopback bridge가 있다. Desktop ChatGPT/API-key 각 로그인 모드에서 proxy를 죽인 실제 no-direct-fallback smoke가 남아 있다. |
| REVIEW-04 | 기존 Codex thread ID/history/goal/archive를 transport 변경 뒤 보존 | 구현됨·live 검증 필요 | native-openai는 provider identity를 유지하고 base URL만 바꾼다. 대표 기존 thread의 list/resume/goal을 적용 전후 비교하는 live smoke가 남아 있다. |
| REVIEW-05 | DB/JSONL provider 직접 수정 금지와 rollback | 완료 | config parser/receipt 기반 apply/unapply만 사용하며 native thread DB/rollout의 provider tag를 직접 바꾸지 않는다. |

## 13. 아직 닫히지 않은 필수 결정·검증 순서

아래가 현재 실제 남은 작업의 우선순위다.

1. **Claude 영구 라우팅 live gate** — 95% 선제 pause 제거·전체 pool·fill-first 영구 코드는 승인·커밋됐고,
   정책 ON 재시작까지 확인했다. 실제 429 same-request failover와 요청 단위 upstream 계정 trace를 남겼다.
2. **native folder grant + deferred conversation creation** — 지연 생성과 허용 root의 실제 read/write tool turn은 live 통과했다.
   최신 4400에서 Codex `write_file`→`read_file`, 홈→대화 전환과 console error 0건을 재확인했다. OS native picker의 실제 사용자 선택만 수동 확인 항목이다.
3. **Fable 5 quota live UI** — raw schema discovery와 BFF 보강 코드는 `dc4434d`로 완료됐고 재시작한 4400 API에서
   Fable 전용 window와 브라우저 `Fable 5` 게이지 렌더를 모두 확인했다.
4. **Baton auto compaction** — v13→v14 migration, 백업/live 사본 smoke, 첫 턴 oversize, compaction 후 budget,
   exact provenance, 원자 reserve/reclaim, durable receipt와 provider-private retirement를 구현했다. 전체 378/378과 독립 적대적 APPROVE를 통과해 `3e6f61a`로 커밋했다.
5. **cache identity** — thread별 HMAC identity와 Codex bridge/Claude cache-control 구현·회귀는 완료했다. 실제 provider A/B hit/miss 계측과 proxy failure no-direct-fallback live는 운영 gate로 남았다.
6. **전체 완료 audit** — typecheck, lint, full 378/378 tests, build, v13→v14 reopen, DB integrity/FK, 4400 browser,
   Claude/Codex live turn과 workspace tool을 통과했다. active goal 밖에서 남은 live gate는 native-openai proxy failure와 Goal/follow-up UI 시나리오다.

## 14. 명시적으로 누락 여부를 확인할 항목

다음은 대화에서 요청됐지만 아직 `완료`로 둘 수 없는 항목이다. 사용자가 요청 누락을 빠르게 확인할 수 있도록 따로 모았다.

- [ ] 실제 429 전까지 정상 Claude 계정을 유지하고 429에서 같은 요청을 failover
- [ ] 403/만료 Claude 계정을 자동 INELIGIBLE 처리
- [x] Claude Fable 5 전용 usage 게이지의 4400 시각 검증
- [x] `prompt_cache_key` 또는 provider별 동등 cache identity의 Baton thread별 구현·회귀·커밋(실제 hit/miss 계측은 남음)
- [x] 실행 중 follow-up의 durable FIFO/steer/next-turn/Goal-priority 코드 통합(브라우저 live만 남음)
- [x] OS native 폴더 선택·권한 허용 UX 코드 통합(실제 picker 선택 live만 남음)
- [x] 첫 메시지를 보낼 때만 session+turn을 원자 생성하는 새 대화 UX 코드 및 브라우저 live
- [x] 허용된 선택 root에서 실제 Baton file tool live E2E
- [x] provider-neutral Baton auto compaction의 고아 reservation blocker 수정·적대적 재검수·전체 378/378·커밋
- [ ] Baton-managed child execution 및 approval/user-input wait
- [ ] Codex native-openai ChatGPT/API-key 실제 proxy 경유와 no-direct-fallback smoke
- [ ] native 원본↔Baton authority migration/sync
- [ ] native import의 명시적 Goal lifecycle 복원과 기존 import dry-run backfill
- [ ] Gemini 인증 복구 후 catalog/turn/tool live 검증(사용자의 live-message 금지 해제 전 실행 금지)

## 15. 로컬 ADB·이미지 컨텍스트

| ID | 요청 | 상태 | 근거와 남은 일 |
|---|---|---|---|
| HOST-01 | 범용 권한으로 로컬 도구와 ADB를 사용 | 구현 완료 | 전역 기본+대화별 `read_only`/`workspace`/`full_access`와 턴별 immutable snapshot을 구현했다. Full access는 제품 전용 grant 없이 direct argv로 ADB·Git·PowerShell 등 설치 도구를 사용할 수 있다. |
| HOST-02 | 제품별 에뮬레이터 편의 기능 | core에서 제거 | 제품 탐지, 단일 인스턴스 연결, 전용 조작 route/tool은 canonical core에서 제거했다. 필요하면 다중 ADB target을 지원하는 선택적 플러그인/내부 확장으로 제공한다. |
| HOST-03 | 파일로 저장한 캡처·업로드 이미지를 실제 모델 context에 첨부 | 구현 완료·provider wire 회귀 통과 | content-addressed artifact ref를 정본에 저장하고 Codex `localImage`/dynamic-tool `inputImage`, Claude image block, Gemini `image_url`로 실행 경계에서 변환한다. provider-private continuation에도 base64 대신 artifact ref만 저장한다. |
| HOST-04 | Claude/Codex CLI·Desktop 권한 구현 참고 | 완료 | Claude Code 공식 permissions 문서, 현재 Codex 공개 소스, 설치된 Codex/Claude Desktop 번들의 turn/session permission 전달 계약을 비교해 Baton의 범용 프로필로 설계했다. 자세한 경계는 [`HOST_AUTOMATION.md`](HOST_AUTOMATION.md). |
| HOST-05 | Computer Use와 built-in browser | TODO로 명시 | 현재 요구에는 필요하지 않아 실행면을 추가하지 않았다. Baton canonical permission/cancel/replay 계약을 별도 설계하기 전까지 비활성이다. |
| HOST-06 | Electron 마이그레이션 | 불필요 판정 | same-origin local BFF가 host process와 artifact를 소유하고 React UI가 grant/가시성만 담당하므로 현재 기능에는 Electron이 필요하지 않다. |
