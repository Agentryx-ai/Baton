# Baton

**여러 AI provider와 여러 계정을 하나의 대화 흐름으로 운용하는 로컬 control plane.**

Baton이라는 이름은 릴레이의 배턴에서 왔습니다. 계정이 바뀌어도, Claude에서 Codex로
provider가 바뀌어도 사용자의 대화는 끊기지 않아야 합니다.

> **Baton이 대화의 정본(canonical owner)이고, Claude·Codex·Gemini는 현재 턴을
> 실행하는 어댑터입니다.** Provider의 네이티브 세션이나 계정은 대화의 소유자가
> 아닙니다.

## AI 에이전트에게 설치 맡기기

Claude Code, Codex 등에 아래 블록을 그대로 붙여 넣으면 됩니다.

```text
Baton을 이 컴퓨터에 안전하게 설치하고 실행해 주세요.

저장소: https://github.com/Agentryx-ai/Baton.git

작업 규칙:
1. 변경 전에 OS, Git, Node.js, npm, 기존 Baton checkout, gateway 관리 API,
   CLIProxy 실행 상태를 읽기 전용으로 확인하고 주요 가정을 알려 주세요.
2. 기존 checkout이 있으면 사용자 변경과 `.env`를 보존하고 그 위치를 재사용하세요.
   없으면 기존 프로젝트 디렉터리 규칙을 따르고, 발견할 수 없으면 `~/Baton`에
   clone하세요. 다른 사용자 파일을 덮어쓰거나 삭제하지 마세요.
3. 저장소의 `README.md`와 적용되는 `AGENTS.md`를 읽고 현재 설치 계약을 확인하세요.
4. `.env`가 없으면 `.env.example`을 복사하고 `GATEWAY_URL`, `GATEWAY_USER`,
   `GATEWAY_PASS`를 설정하세요. 기존 설정이나 로컬 실행 환경에서 안전하게 확인할
   수 없는 비밀값만 저에게 요청하고, 값을 로그나 최종 보고에 출력하지 마세요. 정본 대화
   저장 위치를 바꿔야 할 때만 선택적으로 `BATON_DATA_DIR`도 설정하세요.
5. gateway 관리 API(기본 `:3000`)나 CLIProxy(기본 `:8317`)가 없다면 알 수 없는
   백엔드를 임의로 설치하지 말고, Baton 자체의 의존성 설치·빌드까지 진행한 뒤
   정확한 부족 조건을 보고하세요.
6. `npm ci`로 의존성을 설치하고 `npm run typecheck`, `npm run lint`, `npm test`,
   `npm run build`를 실행하세요. Codex CLI가 설치되어 있으면
   `npm run smoke:codex-adapter`로 app-server handshake와 안전 설정도 확인하세요.
   실패하면 설치에 필요한 최소 변경만 하고 재검증하세요.
7. 검증이 통과하면 `npm start`로 Baton을 실행하고 `http://127.0.0.1:4400/baton/health`
   응답과 `http://127.0.0.1:4400`의 대시보드 접속을 확인하세요. 운영체제의 부팅
   자동 시작은 제 명시적 허가 없이 등록하지 마세요.
8. 현재 실행 중인 Claude Code·Codex 자신의 프록시 설정은 세션 중에 변경하지
   마세요. 설치 후 사용자가 대상 클라이언트를 모두 종료하고 Baton UI에서
   프록시 설정을 적용하도록 안내하세요.
9. 최종에 설치 경로, 실행 상태, 검증 결과, 대시보드 URL, 재실행·종료 명령,
   사용자가 수동으로 해야 할 남은 작업만 간결히 보고하세요.
```

## Why Baton

AI 코딩 도구를 여러 provider와 여러 계정으로 운용하면 두 문제가 생깁니다.

1. **계정과 사용량이 흩어집니다.** 계정별 quota, reset 시각, 활성 상태와 failover를
   각각 확인하고 조정해야 합니다.
2. **대화가 provider에 갇힙니다.** Claude 세션과 Codex 세션은 서로 다른 정본이어서,
   도구를 바꾸는 순간 문맥·도구 결과·분기 이력이 단절됩니다.

Baton은 이 둘을 하나의 제품 경계에서 해결합니다.

- **Account control plane** — provider별 여러 계정의 사용량을 보고, 추가·중지·재개하며,
  quota와 reset 시각에 따라 안전하게 조향합니다.
- **Canonical conversation runtime** — Baton이 provider 중립적인 대화와 실행 이력을
  보존하고, 매 턴에 선택된 provider adapter가 그 턴만 실행합니다. 같은 Baton thread에서
  `Claude → Codex → Gemini`로 이어갈 수 있고, provider 전환은 새 대화를 만드는 일이
  아닙니다.

두 축은 독립적입니다. 계정 로테이션은 **어떤 자격 증명으로 요청할지** 결정하고,
canonical session은 **어떤 대화를 계속하는지** 결정합니다. 계정이 바뀌어도 Baton session
ID는 바뀌지 않습니다.

## Product invariants

- Baton session/thread/item 기록만이 대화의 정본입니다.
- provider와 model은 session 속성이 아니라 **turn별 실행 선택**입니다.
- provider 고유 response ID, reasoning signature, native session ID는 같은 provider에서의
  최적화를 위한 opaque binding일 뿐 정본이 아닙니다.
- 완료된 메시지와 도구 결과만 provider 간에 이동합니다. 처리 중인 tool loop가 있으면
  전환을 거부하거나 먼저 취소합니다.
- provider 네이티브 subagent/team 실행은 canonical history 밖에 별도 대화를 만들 수
  있으므로 관리 턴에서 비활성화합니다. 하위 실행은 Baton이 ID·계보·예산·권한·이벤트를
  소유하는 통제된 child execution으로만 허용합니다.
- native CLI/Desktop 세션 import와 프록시 캡처는 호환 기능이지 정본 경로가 아닙니다.

## Current status

| 영역 | 상태 | 설명 |
|---|---|---|
| 여러 provider/계정 대시보드 | 구현됨 | Claude/Codex 계정, quota, reset, 상태 관리 |
| Smart rotation | **부분 구현** | quota 기반 target/reserve 활성 풀 조향; 실제 target 우선 라우팅은 미보장 |
| 클라이언트 프록시 자동 설정 | 구현됨 | Claude/Codex CLI·Desktop별 결정론적 적용/해제, Codex 기존 세션 유지 모드, 종료·lock 검사 |
| Canonical conversation runtime | **V1 부분 구현** | 한 요청 안에서 완료 경계까지 반복하는 provider-neutral model/tool loop, durable broker, bounded cancel/recovery |
| Persistent Goal runtime | **V1 구현** | `/goal`, CAS/lease, 자동 후속 턴, pause/resume/edit/clear, 24턴·2시간·no-progress 안전 한도 |
| Codex turn adapter | **V1 구현** | app-server ephemeral thread, Baton tools, web/MCP/plugin/subagent 차단, model provenance |
| Canonical conversation UI | **Preview 구현** | 2-column 대화, 작업 상태, provider/model/effort, Goal panel, 턴 실행·취소 |
| Claude turn adapter | **Preview 구현** | portable text history 기반 stateless 실행; Fable 5 live 검증 완료 |
| Gemini turn adapter | **Preview 구현·live 차단** | OpenAI 호환 stateless 경로 구현; 현재 proxy 인증 문제로 모델이 0개라 UI에서 비활성화 |
| Baton-managed child execution | 기반만 구현, 실행 비활성 | execution 기록과 delegation-disabled 정책; child API·실행기는 예정 |

현재 UI에는 account control plane과 canonical conversation preview가 함께 노출됩니다.
Codex와 Claude adapter는 실행 가능하며 Gemini도 같은 정본 계약으로 구현되어 있습니다.
단, proxy가 Gemini 모델을 제공하지 않는 현재 인증 상태에서는 Gemini를 선택할 수 없습니다.
구현 경계와 정합성 판정은
[`docs/IMPLEMENTATION_STATUS.md`](docs/IMPLEMENTATION_STATUS.md)에 있습니다.

## Architecture

목표 구조에서 Baton Core가 대화와 실행의 유일한 소유자입니다.

```text
                          Canonical conversation plane
User / Baton UI ──▶ Baton Session Core ──▶ Context builder
                         │                       │
                         │ session/thread/      ├─▶ Codex adapter (Preview) ─▶ current turn
                         │ turn/item/event       ├─▶ Claude adapter (Preview)
                         │                       └─▶ Gemini adapter (Preview; auth blocked)
                         │
                         └─▶ delegation disabled ── child execution (planned)

                             Account control plane
Baton BFF (:4400) ──▶ gateway management API (:3000) ──▶ account/quota/steering
                                      │
                                      └─▶ CLIProxy (:8317) ─▶ provider API
```

Provider adapter는 canonical history를 해당 provider 요청으로 변환하고, 응답 스트림을 다시
Baton item/event로 정규화합니다. CLIProxy는 계정 선택·OAuth·token refresh·429 failover를
담당하며 대화의 소유권을 갖지 않습니다.

현재 구현은 React SPA와 Express BFF가 account control plane과 multi-provider canonical
conversation preview를 함께 제공합니다. 정본 데이터는 소스 트리 밖의 SQLite에 저장됩니다.
Codex app-server는 매 턴 ephemeral thread로 실행되고 Baton history를 주입받으며,
Claude/Gemini adapter도 같은 portable history를 provider 요청으로 재구성합니다.

```text
SPA (React + Vite + Tailwind + shadcn)
  └─ BFF (Express :4400)
       ├─ gateway session과 same-origin /api proxy
       ├─ smart-rotation policy engine
       └─ client proxy configuration manager
            └─ gateway API (:3000) / CLIProxy (:8317)
```

## Implemented features

- provider별 계정 카드, 5h/weekly quota, reset countdown, 제한 정보 없음 상태
- 계정 pause/resume/delete, 수동 **이 계정만**, OAuth 계정 추가 wizard
- reset-imminent-first 순위 계산, target/reserve 활성 풀 조향과 로그
- CLIProxy strategy, session affinity, proxy restart
- Claude/Codex CLI·Desktop 개별 프록시 설정 적용/해제
  - 대상 하나씩 독립 실행
  - 앱이 확실히 종료된 경우에만 변경
  - 파일 lock과 설정 충돌을 fail-closed로 처리
  - 구조화된 parser, Baton 소유 값 확인, 원자적 교체
  - Codex는 `model_provider=openai`를 유지하고 `openai_base_url`만 Baton loopback bridge로
    설정하는 **기존 세션 유지 모드**와, 별도 `baton` provider 모드를 선택 가능
- canonical session/thread/turn/item과 provider binding의 SQLite/WAL 영속화
- `/baton/v1` REST API, cursor replay SSE, fork, idempotent retry, cancel, crash recovery
- provider-neutral agent loop와 Baton tool broker
  - tool call 선기록, read 병렬화, mutation 직렬화, 결과 기록 후 provider 재개
  - 검증된 `cwd`가 있는 세션에만 workspace read/list/search/write/replace 제공
  - 정상 최종 응답까지 같은 canonical turn 안에서 model/tool round를 반복
  - provider readiness 30초, turn 30분, tool/retry/output 한도로 무한 대기를 차단
  - tool/retry/time/output 한도와 late completion보다 cancellation 우선; Codex app-server가
    공개하지 않는 정확한 sampling/retry 합계는 30분 turn timeout과 host tool limit로 보완
- persistent Goal runtime
  - `/goal`, `/goal edit|pause|resume|clear`, Goal panel과 세션 상태
  - SQLite CAS/event, scheduler lease, 자동 continuation, token/turn/time/no-progress 한도
- Codex app-server adapter
  - portable history를 ephemeral native thread에 주입하는 stateless continuation
  - approval, shell, MCP, plugin, multi-agent 실행면을 비활성화하고 시작 시 검증
  - text, plan, reasoning summary, usage, error를 정본 item/event로 정규화
- Claude/Gemini stateless HTTP adapter
  - Baton portable text history만 전송하고 provider-native tool/subagent 실행은 허용하지 않음
  - 요청 model과 실제 응답 model을 함께 기록해 Fable 5 등의 fallback을 명시적으로 표시
- canonical conversation preview UI
  - 홈·대화·설정에 동일한 앱 셸과 내비게이션 적용
  - provider/model/effort 선택, 실행 불가능한 provider 비활성화, 턴 실행·취소

## 활성 계정 확인

Baton이 선택하는 **CLIProxy 업스트림 계정**과 네이티브 클라이언트에
로그인된 **로컬 계정**은 서로 다른 상태입니다.

- Codex의 `/status`는 로컬에 캐시된 Codex 로그인·세션 정보를 표시합니다. Baton이
  실제 요청에 사용한 업스트림 계정과 다를 수 있으며, Baton 라우팅 검증 수단이
  아닙니다.
- 실제 사용 계정은 요청을 한 번 전송한 뒤 Baton의 **현재 타겟**, **조향 로그**,
  또는 계정별 quota 변화로 확인합니다.
- `paused`인 계정은 기본 계정이어도 라우팅 대상이 아닙니다. `round-robin`에서는
  활성 계정이 여러 개면 요청이 순환되므로, 특정 계정을 고정하려면 **이 계정만**을
  선택하거나 나머지 계정을 일시정지합니다.
- 계정 활성·일시정지·라우팅 변경은 보통 다음 요청부터 반영되어 Codex CLI를
  재시작할 필요가 없습니다. 단, session affinity가 켜져 있으면 TTL 동안 기존
  계정이 유지될 수 있습니다. 클라이언트의 프록시 URL·인증 설정을 적용하거나
  해제한 경우에는 해당 클라이언트를 재시작합니다.

> Claude CLI 프록시 설정은 `ANTHROPIC_AUTH_TOKEN`을 사용하므로 claude.ai 조직
> connectors가 비활성화된다는 경고는 정상입니다. connectors가 필요하면 해당
> 클라이언트의 Baton 프록시 설정을 해제하고 재시작하세요.

### 네이티브 클라이언트의 세션 목록

- **Codex Desktop(ChatGPT 로그인 포함)과 CLI:** 기존 OpenAI thread 목록을 유지하려면 설정 UI에서
  **기존 세션 유지**를 선택합니다. 두 클라이언트 모두 `~/.codex/config.toml`의 현재
  `model_provider`를 기준으로 목록을 필터링하므로, 별도 `baton` provider 모드는 기존
  `openai` 목록과 분리됩니다.
- **Claude CLI:** gateway 설정은 `ANTHROPIC_BASE_URL`/`ANTHROPIC_AUTH_TOKEN`만 바꾸며,
  `--continue`/`--resume`이 사용하는 로컬 프로젝트 세션은 그대로 유지됩니다.
- **Claude Desktop:** 지원되는 gateway 설정은 `inferenceProvider=gateway`라는 별도
  provider로 전환합니다. Claude 계정에 저장된 기존 Chat/Cowork 목록을 그대로 유지하면서
  base URL만 바꾸는 공식 설정은 없으므로, Baton은 세션 목록 보존을 약속하지 않습니다.

## Run

```bash
# 1. configure
cp .env.example .env   # GATEWAY_URL / GATEWAY_USER / GATEWAY_PASS

# 2. development (Vite :5173 + BFF :4400)
npm run dev

# 3. production
npm run build
npm start              # http://localhost:4400
```

`.env`는 gitignore되며 BFF가 gateway dashboard에 로그인할 자격 증명을 보관합니다.
정본 SQLite는 `BATON_DATA_DIR`에 저장되며, 기본값은 Windows에서
`%LOCALAPPDATA%\Baton`, 그 외 환경에서는 사용자 홈의 `Baton` 디렉터리입니다.

## Layout

- `server/` — BFF, gateway client/session, rotation policy, client integration
- `server/session/` — canonical domain, SQLite store, orchestrator, REST/SSE, Codex adapter
- `src/api/` — typed API client와 계약
- `src/features/conversations/` — canonical conversation preview UI와 event stream client
- `src/hooks/` — visibility-aware polling
- `src/components/` — account, rotation, settings UI와 shadcn primitives
- `scripts/codex-adapter-smoke.ts` — 실제 Codex app-server handshake·hardening smoke test
- `tools/native-session-handoff/` — Codex Desktop-visible interactive task와 Claude Desktop local Code/Cowork task의 일회성 inventory·승계 proposal·승인 기반 CLI context-ingest 패키지(원격 Claude 채팅 제외, `local-all` 호환 범위 제공)
- `docs/DESIGN.md` — 현재 account control plane 설계와 정책
- `docs/COMMON_SESSION_DESIGN.md` — canonical conversation runtime 설계
- `docs/NATIVE_SESSION_IMPORT_AND_GROUPING.md` — native task fork-copy import, 중복 방지와 대화 목록 그룹화 계약
- `docs/BUILD_DAG.md` — 빌드 구조

## Known limitations

- Canonical conversation runtime은 V1 부분 구현입니다. Claude/Gemini는 stateless adapter이고 provider 고유
  streaming/content part 확장은 아직 제한됩니다. Native session import는 독립 `fork_copy`만 지원하며 native
  원본의 authority 승계·동기화·`/goal` 변경은 아직 구현되지 않았습니다.
- Smart rotation의 `현재 타깃`은 계산상 1순위일 뿐 실제 요청 우선권을 보장하지 않습니다.
  target과 reserve가 모두 활성인 `round-robin`에서는 두 계정이 순환되므로, 엄밀한
  reset-imminent-first 정책은 아직 완성되지 않았습니다.
- quota 응답에는 freshness 시각이 있지만 현재 카드 UI에는 설계된 “n초 전 기준” 표시가
  연결되지 않았습니다.
- 현재 canonical Codex 턴은 text 중심이며 native tool calling, shell, MCP, plugin, multi-agent를
  의도적으로 비활성화합니다. 대신 provider-neutral Baton workspace/Goal tools를 사용합니다.
- `run_command`는 현재 Windows sandbox가 작업공간 밖 읽기까지 차단할 수 있다고 검증되지 않아
  기본 도구 목록에서 fail-closed로 제외됩니다. 파일 read/write 도구는 realpath 경계를 별도로 강제합니다.
- Goal이 없는 일반 요청도 도구 호출이 끝나고 provider가 정상 final을 낼 때까지 한 턴 안에서 계속됩니다.
  여러 canonical turn에 걸친 장기 목표는 사용자가 명시적으로 `/goal`을 만든 경우에만 자동 계속됩니다.
- fork는 API와 저장소에서 지원하지만 현재 preview UI에는 fork 조작 화면이 없습니다.
- 수정하지 않은 native Desktop UI는 외부 session protocol을 보장하지 않으므로 transparent한
  공유를 약속하지 않습니다. 명시적 Baton UI/API 또는 지원되는 bridge가 정본 경로입니다.
- Codex usage API의 첫 quota 조회는 수 초 지연될 수 있습니다.
- Provider마다 역할·tool·reasoning 의미가 달라 완전한 내부 상태 이동은 불가능합니다. Baton은
  표시 가능한 대화와 완료된 실행 결과를 보존하고, 이동 불가능한 상태는 명시적으로 차단합니다.

## Design references

- [Account control plane and rotation](docs/DESIGN.md)
- [Canonical session and provider-adapter contract](docs/COMMON_SESSION_DESIGN.md)
- [Native session import and conversation grouping](docs/NATIVE_SESSION_IMPORT_AND_GROUPING.md)
- [Implementation conformance and known gaps](docs/IMPLEMENTATION_STATUS.md)
