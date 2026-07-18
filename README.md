# Baton

**여러 AI provider와 여러 계정을 하나의 대화 흐름으로 운용하는 로컬 control plane.**

Baton이라는 이름은 릴레이의 배턴에서 왔습니다. 계정이 바뀌어도, Claude에서 Codex로
provider가 바뀌어도 사용자의 대화는 끊기지 않아야 합니다.

> **Baton이 대화의 정본(canonical owner)이고, Claude·Codex·Gemini는 현재 턴을
> 실행하는 어댑터입니다.** Provider의 네이티브 세션이나 계정은 대화의 소유자가
> 아닙니다.

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
| Smart rotation | 구현됨 | provider별 독립 조향, 단일 가용 계정과 failover 처리 |
| 클라이언트 프록시 자동 설정 | 구현됨 | Claude/Codex CLI·Desktop별 결정론적 적용/해제와 종료·lock 검사 |
| Canonical conversation model | **설계 확정, 구현 예정** | Baton session/thread/turn/item, replay, fork, provider binding |
| Provider turn adapters | **설계 확정, 구현 예정** | Codex 우선, Claude, Gemini-ready contract |
| Baton-managed child execution | **설계 확정, 구현 예정** | native subagent 차단 후 Baton 소유 실행만 허용 |

현재 공개된 UI는 account control plane입니다. README가 설명하는 canonical conversation
runtime을 현재 구현된 기능으로 오해하지 않도록 상태를 명시합니다. 상세 계약은
[`docs/COMMON_SESSION_DESIGN.md`](docs/COMMON_SESSION_DESIGN.md)에 있습니다.

## Architecture

목표 구조에서 Baton Core가 대화와 실행의 유일한 소유자입니다.

```text
                          Canonical conversation plane
User / Baton UI ──▶ Baton Session Core ──▶ Context builder
                         │                       │
                         │ session/thread/      ├─▶ Claude adapter ─▶ current turn
                         │ turn/item/event       ├─▶ Codex adapter  ─▶ current turn
                         │                       └─▶ Gemini adapter ─▶ current turn
                         │
                         └─▶ Child Execution Gate ─▶ Baton-owned child thread/execution

                             Account control plane
Baton BFF (:4400) ──▶ gateway management API (:3000) ──▶ account/quota/steering
                                      │
                                      └─▶ CLIProxy (:8317) ─▶ provider API
```

Provider adapter는 canonical history를 해당 provider 요청으로 변환하고, 응답 스트림을 다시
Baton item/event로 정규화합니다. CLIProxy는 계정 선택·OAuth·token refresh·429 failover를
담당하며 대화의 소유권을 갖지 않습니다.

현재 구현은 React SPA와 Express BFF가 gateway/CLIProxy 위에서 account control plane을
제공하는 단계입니다.

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
- 계정 기본값 지정, pause/resume/delete와 OAuth 계정 추가 wizard
- reset-imminent-first smart rotation과 조향 로그
- CLIProxy strategy, session affinity, proxy restart
- Claude/Codex CLI·Desktop 개별 프록시 설정 적용/해제
  - 대상 하나씩 독립 실행
  - 앱이 확실히 종료된 경우에만 변경
  - 파일 lock과 설정 충돌을 fail-closed로 처리
  - 구조화된 parser, Baton 소유 값 확인, 원자적 교체

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

## Layout

- `server/` — BFF, gateway client/session, rotation policy, client integration
- `src/api/` — typed API client와 계약
- `src/hooks/` — visibility-aware polling
- `src/components/` — account, rotation, settings UI와 shadcn primitives
- `docs/DESIGN.md` — 현재 account control plane 설계와 정책
- `docs/COMMON_SESSION_DESIGN.md` — canonical conversation runtime 설계
- `docs/BUILD_DAG.md` — 빌드 구조

## Known limitations

- Canonical session runtime과 provider adapters는 아직 구현 전입니다. 현재의 proxy 자동 설정만으로
  native CLI/Desktop 대화가 공유되지는 않습니다.
- 수정하지 않은 native Desktop UI는 외부 session protocol을 보장하지 않으므로 transparent한
  공유를 약속하지 않습니다. 명시적 Baton UI/API 또는 지원되는 bridge가 정본 경로입니다.
- Codex usage API의 첫 quota 조회는 수 초 지연될 수 있습니다.
- Provider마다 역할·tool·reasoning 의미가 달라 완전한 내부 상태 이동은 불가능합니다. Baton은
  표시 가능한 대화와 완료된 실행 결과를 보존하고, 이동 불가능한 상태는 명시적으로 차단합니다.

## Design references

- [Account control plane and rotation](docs/DESIGN.md)
- [Canonical session and provider-adapter contract](docs/COMMON_SESSION_DESIGN.md)
