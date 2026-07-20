# Baton

**여러 AI provider와 여러 계정을 하나의 작업 흐름으로 운용하는 로컬 control plane.**

Baton이라는 이름은 릴레이의 배턴에서 왔습니다. 계정이나 provider가 바뀌더라도 사용자가
진행하던 대화와 작업의 소유권은 끊기지 않아야 한다는 뜻입니다.

> Baton이 대화와 작업 이력의 정본(canonical owner)입니다. Claude, Codex, Gemini,
> model, account는 현재 실행을 맡는 교체 가능한 실행자이지 정본의 소유자가 아닙니다.

## 빠른 설치

Claude Code, Codex 같은 AI 에이전트에게 아래 문장만 전달하세요.

> Baton을 설치하고 검증해 주세요. 다음 지침을 정확히 따르세요: https://raw.githubusercontent.com/Agentryx-ai/Baton/feat/canonical-runtime-workspace/docs/installation.md

직접 설치하려면 [설치 가이드](docs/installation.md)를 참고하세요.

## Baton이 해결하려는 문제

여러 AI 코딩 도구를 함께 쓰면 보통 세 층이 서로 분리됩니다.

1. **계정과 한도** — 계정별 quota, reset, OAuth, failover 상태가 흩어집니다.
2. **대화와 실행 이력** — Claude 세션과 Codex 세션이 서로 다른 정본을 가져 provider를
   바꾸는 순간 문맥, 도구 결과, 취소와 복구 이력이 끊깁니다.
3. **작업 자체** — 네이티브 subagent tree는 누가 누구를 호출했는지는 보여주지만, 어떤
   결과가 어떤 선행 작업과 검수를 통과해야 하는지는 장기적으로 표현하기 어렵습니다.

Baton은 이 문제를 두 control plane으로 나눕니다.

- **Account control plane**은 어떤 자격 증명과 모델로 요청할지를 결정합니다. Baton Native
  Proxy가 Claude와 Codex OAuth, token refresh, account failover를 직접 소유하며, 기존
  CLIProxy 경로도 호환 모드로 남아 있습니다.
- **Canonical work plane**은 어떤 대화와 작업을 계속하는지를 결정합니다. Provider adapter는
  정본 history를 현재 요청으로 변환하고 결과를 다시 Baton의 item/event로 정규화합니다.

계정 교체와 provider 교체는 새 대화를 뜻하지 않습니다. 둘은 같은 canonical thread의 새
execution provenance로 기록됩니다.

## 무엇이 다른가

### 프록시보다 넓은 경계

일반적인 multi-account proxy의 책임은 credential 선택과 요청 전달에서 끝납니다. Baton은
그 기능에 더해 대화, turn, tool call, 결과, 취소, Goal과 향후 WorkGraph를 provider 중립
형식으로 소유합니다. Proxy가 실패하거나 교체되어도 canonical state의 주인은 바뀌지 않습니다.

### Provider session보다 강한 정본

Provider-native response ID, reasoning signature, session ID는 같은 provider에서 이어갈 때
유용하지만 다른 provider가 해석할 수 없는 opaque binding입니다. Baton은 이를 최적화 정보로
보존하되 정본으로 승격하지 않습니다. 이동 가능한 완료 메시지와 도구 결과만 공통 history에
포함하고, 진행 중인 private tool loop는 조용히 다른 provider로 옮기지 않습니다.

### Agents가 아니라 Work

Baton의 DAG 기반 작업 시스템은 아직 구현 중인 **설계 가설**입니다. 핵심 가설은 “장기 작업의
정본은 agent tree가 아니라 검증 가능한 작업 그래프여야 한다”는 것입니다.

- `WorkItem`이 목적, 입력, 요구사항과 acceptance 조건을 소유합니다.
- Agent, provider, model, account는 WorkItem을 수행한 execution provenance입니다.
- 호출 계보(execution lineage), 작업 dependency, retry, review, resource exclusion은 서로 다른
  edge로 기록해야 합니다.
- Worker와 planner는 구조화된 proposal을 제출할 뿐 canonical graph를 직접 수정하지 않습니다.
- Baton의 결정적 control plane이 revision, 권한, 예산, lease, verifier receipt와 completion
  gate를 검사한 뒤 상태 전이를 확정합니다.
- 단순 병렬 작업에는 평면 `WorkSet`을 쓰고, 실제 선후관계와 통합이 필요한 경우에만 versioned
  `WorkGraph`로 확장합니다. 모든 대화에 DAG를 강제하지 않습니다.

이 구조는 provider-native subagent 기능을 그대로 감싸는 것이 아니라 장기적으로 대체하려는
시도입니다. Agent가 중단되거나 provider가 바뀌어도 작업 정의, accepted artifact와 미완료
dependency가 남으므로 다른 실행자가 이어받을 수 있다는 가설을 단계적으로 검증합니다. 현재는
execution 기록과 delegation 차단 경계까지만 구현됐으며 scheduler, child execution API,
acceptance receipt와 동적 graph revision은 아직 실행 경로가 없습니다.

최신 명세는 [Work-Centric Orchestration Design V4](docs/WORK_CENTRIC_ORCHESTRATION_DESIGN_V4.md),
Pareto orchestration plugin과 evolving graph의 확장안은
[Pareto Orchestration Plugin and Evolving Work Graph](docs/PARETO_ORCHESTRATION_PLUGIN_AND_EVOLVING_WORK_GRAPH.md)에
있습니다.

## 설계 원칙

1. **Canonical ownership** — Baton의 session, thread, item, event 기록만이 공통 대화의
   정본입니다.
2. **Turn-scoped routing** — provider와 model은 session 정체성이 아니라 turn별 실행
   선택입니다.
3. **Proposal is not mutation** — LLM, worker, reviewer와 plugin은 변경을 제안할 수 있지만
   canonical state를 직접 commit하지 않습니다.
4. **Result is not acceptance** — provider가 응답을 끝냈다는 사실과 WorkItem이 검수를 통과한
   사실을 분리합니다.
5. **Portable boundaries only** — 완료된 portable checkpoint에서만 provider failover를
   허용합니다. 이동 불가능한 내부 상태는 숨기지 않고 pin 또는 cancel합니다.
6. **Durable before effect** — tool call과 mutation intent를 실행 전에 기록하고 결과를
   provider 재개 전에 기록합니다. 결과가 불명확한 mutation은 자동 재실행하지 않습니다.
7. **Least authority** — 권한, 계정 선택, graph mutation, 검수와 완료 권한을 분리합니다.
   Third-party plugin은 alternate control plane이 될 수 없습니다.
8. **Fail closed** — lock, credential, model capability, sandbox 또는 state revision을 확신할
   수 없으면 추측해서 진행하지 않습니다.
9. **Compatibility is not authority** — native session import와 CLIProxy integration은 호환
   기능이며 canonical ownership을 provider에 돌려주지 않습니다.
10. **Honest status** — 설계, 합성 테스트, live canary와 운영 검증을 같은 “완료”로 표시하지
    않습니다.

## 현재 상태

| 영역 | 상태 | 현재 경계 |
|---|---|---|
| 여러 provider/계정 UI | 구현됨 | Claude/Codex 계정, quota, reset, pause/resume/delete |
| Baton Native Claude Proxy | 부분 완료 | OAuth vault, refresh, quota preflight, same-request failover, SSE 보존; 단일계정 live canary 완료, 2계정/rollback gate 대기 |
| Baton Native Codex Proxy | 합성 검증 완료 | OAuth, live-claim plan, account별 model catalog, model-aware failover; 실제 OAuth/free→pro/2계정 canary 대기 |
| Codex primary-runtime bridge | 구현·canary 완료 | CLI에 `load_workspace_dependencies`가 없을 때 검증된 공식 runtime만 노출; artifact-tool workbook render/export E2E 통과 |
| Codex 플러그인 기준계정 | 구현·합성/로컬 canary 완료 | 모델 라우팅과 독립된 계정 선택, catalog diff, CAS 전환/rollback, 설치·제거, 삭제 보호; 실제 원격 계정 canary 대기 |
| CLIProxy 호환 경로 | 유지됨 | 기존 gateway 계정 API와 custom-provider 모드 지원; Native core는 CLIProxy 코드나 프로세스에 의존하지 않음 |
| 범용 모델 자동전환 | 부분 완료 | 기본 OFF, capability/mapping 기반 fallback과 복귀, Fable 5→Opus 4.8 live 전환 완료; 다중 fallback 후보와 실패 정리 보강 필요 |
| Canonical conversation runtime | V1 부분 구현 | provider-neutral model/tool loop, SQLite/WAL, replay SSE, bounded cancel/recovery |
| Persistent Goal runtime | V1 구현 | CAS/lease, 자동 후속 turn, pause/resume/edit/clear, turn/time/no-progress 한도 |
| Canonical UI | Preview | draft-first 대화, provider/model/effort, Goal, folder/image, permission profile, fallback notice |
| Host automation | Preview | `read_only`/`workspace`/`full_access`, direct-argv command, 이미지와 typed LDPlayer adapter |
| Work-centric DAG runtime | 설계/기반 단계 | V4 명세와 execution 기반만 존재; WorkSet/WorkGraph scheduler와 acceptance runtime은 미구현 |
| Built-in browser / Computer Use | 미구현 | canonical screenshot/action loop, approval, cancellation, replay 계약부터 필요 |

상세한 구현 판정은 [구현 정합성 현황](docs/IMPLEMENTATION_STATUS.md), Native proxy와 모델
fallback의 미해결 gate는 [Native Proxy TODO](docs/BATON_NATIVE_CLAUDE_PROXY_TODO.md)에서
추적합니다.

## 아키텍처

```text
                         Canonical work plane
User / Baton UI --> Session Core --> Context builder --> provider adapter
                         |                                  |
                         | session / thread / turn          +--> Codex
                         | item / event / Goal               +--> Claude
                         | execution provenance              +--> Gemini
                         |
                         +--> WorkSet / WorkGraph runtime (planned)

                         Account control plane
                         +--> Baton Native Claude Proxy --> Anthropic
Baton BFF (:4400) -------+--> Baton Native Codex Proxy  --> OpenAI/ChatGPT
                         +--> CLIProxy compatibility    --> provider APIs
```

React SPA와 loopback-only Express BFF가 두 control plane을 제공합니다. Canonical SQLite와
vault/state는 소스 트리 밖 `BATON_DATA_DIR`에 저장됩니다. Codex adapter는 매 turn ephemeral
app-server thread에 portable history를 주입하고, Claude/Gemini adapter도 같은 canonical
history에서 provider 요청을 재구성합니다.

## 구현된 주요 기능

- Claude/Codex 계정 추가, 상태, quota, pause/resume/delete와 우선순위 관리
- Codex 원격 플러그인 catalog용 기준계정 선택
  - 모델 라우팅 pause와 독립적으로 OAuth refresh
  - 전환 전 추가·제거 plugin diff와 connector 재인증 경고
  - revision/digest 확인, 전환 후 catalog 검증 실패 시 rollback, 기준계정 삭제 보호
  - 설치된 Codex app-server의 공식 `plugin/list`·`plugin/install`·`plugin/uninstall`만 사용
- Claude/Codex CLI와 Desktop별 프록시 적용/해제
  - 대상 프로세스 종료와 file lock 확인
  - 구조화된 설정 parser, Baton 소유 값 검증, 원자적 파일 교체
  - Codex 기존 OpenAI session 가시성을 위한 `native-openai`와 격리된 custom-provider 모드
- Baton Native Claude/Codex data plane, OAuth refresh, encrypted local vault와 account router
- preferred model과 effective model을 분리한 opt-in 자동 fallback/복귀 및 대화 event
- session/thread/turn/item/execution/provider binding의 SQLite/WAL 영속화
- `/baton/v1` REST API, cursor replay SSE, idempotent retry, fork와 crash recovery
- provider-neutral agent loop와 durable tool broker
  - tool call 선기록, read 병렬화, mutation 직렬화, result 기록 후 provider 재개
  - permission profile을 turn 시작 시 immutable snapshot으로 고정
  - 정상 final까지 같은 turn 안에서 bounded model/tool round 반복
- content-addressed 이미지 저장과 Codex/Claude/Gemini별 multimodal 변환
- persistent Goal과 자동 continuation
- native local task의 read-only preview와 승인 기반 fork-copy import

## 실행

```bash
cp .env.example .env
npm ci
npm run build
npm start
```

대시보드는 기본적으로 <http://127.0.0.1:4400>에서 열립니다. `.env`에는 gateway 관리
자격 증명이 필요하며, 정본 데이터의 기본 위치는 Windows `%LOCALAPPDATA%\Baton`, 그 외
환경에서는 사용자 홈의 `Baton` 디렉터리입니다. 자세한 설치와 검증 순서는
[설치 가이드](docs/installation.md)에 있습니다.

## Codex 세션 재개 시 provider 복원

Codex는 session 생성 당시의 model/provider를 보존합니다. 설정 파일을 Baton으로 바꾼 뒤에도
기존 `openai` session을 단순히 `codex resume`하면 원래 provider로 복원될 수 있습니다.
custom-provider 모드로 명시적으로 재개하려면 다음처럼 override합니다.

```bash
codex resume <session-id> -c model_provider=baton
```

`baton` provider는 `BATON_PROXY_TOKEN`이 필요합니다. 기존 OpenAI thread 목록을 유지하려면
Baton 설정 UI에서 Codex의 `native-openai` 모드를 사용하세요. 프록시 설정 변경 뒤에는 대상
CLI/Desktop을 완전히 종료했다가 다시 시작해야 합니다.

## 알려진 한계와 핵심 TODO

- Native proxy는 구현됐지만 실제 2계정 failover, Codex free→pro entitlement refresh,
  CLI/Desktop rollback과 24시간 canary는 외부 계정/시간 조건 때문에 아직 완료되지 않았습니다.
- Codex CLI 0.144.6은 OpenAI Spreadsheets plugin을 노출하면서 plugin이 요구하는
  `load_workspace_dependencies` 도구를 등록하지 않습니다. Baton runtime bridge가 공식 primary
  runtime을 검증해 우회하지만, upstream CLI/plugin 계약이 수정되면 native loader를 다시
  우선합니다.
- Codex 플러그인 기준계정은 Baton Native vault에 등록한 계정 중 하나를 짧게 실행한
  app-server에 `CODEX_ACCESS_TOKEN`으로 주입하는 기능입니다. 전역 `auth.json`을 바꾸거나
  `codex login`에 두 번째 동시 로그인을 추가하지 않습니다. Local/repo plugin은 계정 소유가
  아니며, remote connector/private workspace 권한은 계정 사이에 이전되지 않습니다. 실제
  원격 계정 catalog canary는 Native Codex 계정이 등록된 환경에서 추가 검증해야 합니다.
- 모델 fallback은 첫 후보 실패 후 다음 후보를 순회하고 실패한 override를 정리하는 보강이
  필요합니다. 현재 compatibility seed는 Fable 5→Opus 4.8이며 범용 schema 자체는 모델명과
  분리돼 있습니다.
- Work-centric DAG는 가설과 V4 설계 단계입니다. Native subagent/team은 canonical history
  밖에 실행을 만들 수 있어 관리 turn에서 비활성화하며, Baton-managed child scheduler가
  구현되기 전에는 대체 실행 경로가 없습니다.
- **Built-in browser**는 아직 없습니다. 외부 개발 환경의 browser tool은 Baton conversation
  tool이 아니며, durable navigation/action/result와 credential/permission 경계를 먼저 설계해야
  합니다.
- **Computer Use**는 아직 없습니다. Screenshot→action loop, 사용자 승인, effect 기록,
  cancellation, timeout과 unknown-outcome recovery를 canonical runtime 아래 두기 전에는 노출하지
  않습니다.
- `full_access`는 사용자의 권한으로 임의 로컬 프로그램을 실행할 수 있습니다. 별도 approval
  workflow는 아직 없으므로 명시적으로 선택한 대화에서만 사용해야 합니다.
- Smart rotation의 계산상 우선순위는 CLIProxy credential order를 바꾸지 못합니다. Native
  router와 달리 CLIProxy 호환 경로의 실제 요청 순서를 보장하는 값이 아닙니다.
- Gemini adapter는 구현됐지만 현재 인증/model catalog 문제로 live 검증이 차단돼 있습니다.
- Provider별 private reasoning/tool state는 완전히 이동할 수 없습니다. Baton은 portable
  history를 보존하고 이동 불가능한 상태를 명시적으로 제한합니다.

## 저장소 구조

- `server/` — BFF, Native proxies, account/fallback runtime, gateway integration
- `server/session/` — canonical domain, SQLite store, orchestrator, adapters와 tools
- `src/` — React UI, typed API client, conversation/account/settings 화면
- `scripts/baton-cli.mjs` — `baton status` CLI
- `docs/COMMON_SESSION_DESIGN.md` — canonical conversation 계약
- `docs/WORK_CENTRIC_ORCHESTRATION_DESIGN_V4.md` — work-centric runtime 최신 목표 설계
- `docs/HOST_AUTOMATION.md` — 권한 profile, host command, 이미지와 자동화 경계
- `docs/BATON_NATIVE_CLAUDE_PROXY_TODO.md` — Native proxy/fallback 검증 및 미해결 작업
- `plugins/baton-codex-runtime-bridge/` — Codex CLI primary-runtime loader compatibility plugin

## 설계 문서

- [Account control plane](docs/DESIGN.md)
- [Canonical session and provider adapters](docs/COMMON_SESSION_DESIGN.md)
- [Work-Centric Orchestration V4](docs/WORK_CENTRIC_ORCHESTRATION_DESIGN_V4.md)
- [Host access and automation](docs/HOST_AUTOMATION.md)
- [Native session import and grouping](docs/NATIVE_SESSION_IMPORT_AND_GROUPING.md)
- [Implementation status](docs/IMPLEMENTATION_STATUS.md)
- [Codex primary-runtime bridge](docs/CODEX_PRIMARY_RUNTIME_BRIDGE.md)
- [Codex plugin reference account](docs/CODEX_PLUGIN_REFERENCE_ACCOUNT.md)
