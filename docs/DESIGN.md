# Baton — Account control plane 설계 문서 v2

> Baton의 제품 정체성은 두 축이다. 첫째는 여러 provider·계정의 usage, quota, 상태와
> 로테이션을 관리하는 **account control plane**이고, 둘째는 **Baton이 대화의 정본을
> 소유하고 Claude·Codex·Gemini가 현재 턴만 실행하는 canonical conversation runtime**이다.
> 이 문서는 첫 번째 축의 구현을 다루며, 두 번째 축은
> [`COMMON_SESSION_DESIGN.md`](COMMON_SESSION_DESIGN.md)에 명세한다.
>
> 이름: 릴레이 배턴 — 계정 사이에는 요청을, provider 사이에는 동일한 대화의 다음 턴을
> 넘긴다. 어느 경우에도 provider 계정이나 native session이 대화의 소유자가 되지 않는다.

- 작성: 2026-07-18 (v2 — 리뷰용 전면 개정)
- 상태: **v1 구현됨, canonical conversation runtime 후속 구현 설계 확정**
- 전제 환경: the gateway Docker(:3000 관리 / :8317 프록시), Claude 2계정 + Codex 2계정 인증 완료

---

## 1. 목표와 비목표

### 1.1 문제
- the gateway's built-in dashboard의 UI/UX가 나쁨: 정보 위계 없음, 가독성 낮음, 핵심 동선(계정 추가·쿼터 확인)이 어렵고 숨겨져 있음.
- CLIProxy의 로테이션 전략이 단순(round-robin/fill-first)해서 쿼터 윈도우 특성을 활용하지 못함.
- Claude/Codex/Gemini의 native session이 서로 독립적이어서 provider를 바꾸면 같은 대화의 정본과 실행 이력을 이어가기 어려움.

### 1.2 목표
1. **한눈 대시보드**: 4개 계정의 쿼터·리셋·상태를 첫 화면에서 즉시 파악
2. **계정 추가를 3분 → 30초로**: OAuth 마법사로 동선 단축
3. **스마트 로테이션 v1**: 리셋 임박 우선 소진 정책 (사용자 결정 2026-07-18)
4. 백엔드 교체 내성: Docker gateway → 네이티브 gateway 이전 시 설정 1줄 변경
5. **Canonical conversation runtime으로 확장**: Baton session은 계정·provider와 독립된 정체성을 가지며, provider는 turn adapter로만 동작

### 1.3 이 문서의 비목표 (하지 않음)
- 계정 로테이션 프록시 자체 구현 (CLIProxy 소관 — account routing 트래픽은 Baton을 경유하지 않음)
- OAuth 토큰 저장·갱신 (the gateway 소관)
- the gateway의 주변 기능(채널, 이미지 분석, IDE 확장, 카탈로그 편집 등) 재노출
- 다중 사용자/원격 접속 (로컬 단일 사용자 전용)
- canonical session 저장소·provider adapter·child execution 구현 상세 (별도 공통 세션 설계 문서의 범위)

---

## 2. 검증된 기반 사실 (전부 소스/실측으로 확인)

### 2.1 시스템 구성

```
[Claude Code / Codex CLI 등]
        │  ANTHROPIC_BASE_URL=http://localhost:8317/api/provider/claude
        ▼
[CLIProxy · Go · :8317] ─── 계정 선택·로테이션·429 페일오버 (요청 시점)
        │  선택된 계정의 OAuth 토큰으로 대리 호출
        ▼
[Anthropic / OpenAI API]

[the gateway 웹서버 · Node · :3000] ─ 관리 REST API + CLIProxy config 생성 + 쿼터 조회
```

### 2.2 로테이션의 실제 동작 (요청 구동형 — 스케줄러 아님)

| 시점 | 동작 | 설정 키 |
|---|---|---|
| 요청 도착 | 전략에 따라 계정 선택 (round-robin: 매 요청 순환 / fill-first: 소진까지 유지) | `routing.strategy` |
| 429 수신 | 다음 계정으로 즉시 전환 + 같은 요청 재시도 (클라이언트 무감지) | `quota-exceeded.switch-project: true` |
| (없음) | 쿨다운 예측 스케줄링은 비활성 — 오직 실제 429에만 반응 | `disable-cooling: true` |
| 옵션 | 같은 세션을 같은 계정에 고정 (TTL 기본 1h) | `session-affinity` |

### 2.3 쿼터 데이터의 출처와 한계

- the gateway(Node)가 계정별 OAuth 토큰으로 provider API를 **직접** 조회:
  - Claude: `api.anthropic.com/api/oauth/usage` → 5h/주간 사용률 + 리셋 시각
  - Codex: `chatgpt.com/backend-api/...` → 5h 한도 + 리셋 시각
- **서버측 2분 캐시** (`quota-response-cache.js`, TTL 120s) → 어떤 소비자도 2분보다 신선한 데이터를 가질 수 없음
- 쿼터 데이터는 **표시용**이며 CLIProxy의 로테이션 판단에 쓰이지 않음 (§2.2)
- **쿼터 윈도우는 고정 시각이 아니라 리셋 후 첫 요청에 앵커링됨** → 소진 순서가 미래 가용량 분포를 바꿈 (정책 엔진의 존재 이유)

### 2.4 실측 API 계약 (Baton이 소비할 것)

#### 조회
| 엔드포인트 | 실측 응답 요약 |
|---|---|
| `GET /api/auth/check` | `{authenticated, username, ...}` |
| `GET /api/cliproxy/accounts/:provider` | `{provider, accounts: [{id, provider, isDefault, email, nickname, paused?, createdAt, lastUsedAt}]}` |
| `GET /api/cliproxy/quota/:provider/:accountId` | `{success, windows: [{rateLimitType: 'five_hour'\|'seven_day', usedPercent, remainingPercent, resetAt, status}], lastUpdated, accountId}` — **쿼터 미제공 계정은 `windows: []`** (예: claude-reserve) |
| `GET /api/cliproxy/routing/strategy` | `{strategy: 'round-robin'\|'fill-first', source, reachable}` |
| `GET /api/cliproxy/routing/session-affinity` | `{enabled, ttl, ...}` |
| `GET /api/cliproxy/proxy-status` | `{running, port, pid, sessionCount, startedAt, version}` |
| `GET /api/cliproxy/stats`, `/usage` | 사용 통계 (v2 차트용) |

#### 변경
| 엔드포인트 | 요청 본문 (소스 확인) |
|---|---|
| `POST /api/auth/login` | `{username, password}` → `connect.sid` 쿠키. **레이트리밋 5회/15분** |
| `POST /api/cliproxy/accounts/:provider/default` | `{accountId}` |
| `POST /api/cliproxy/accounts/:provider/:id/pause` · `resume` | (본문 없음) → `{paused: true/false}` |
| `DELETE /api/cliproxy/accounts/:provider/:id` | → `{deleted: true}` |
| `POST /api/cliproxy/routing/strategy` | `{strategy}` (또는 `{value}`) |
| `POST /api/cliproxy/routing/session-affinity` | `{enabled, ttl}` |
| `POST /api/cliproxy/restart` | — |

#### OAuth 계정 추가 (핵심 플로우)
| 단계 | 엔드포인트 | 계약 |
|---|---|---|
| 시작 | `POST /api/cliproxy/auth/:provider/start-url` | 요청 `{nickname?}` → 응답 `{url \| auth_url, state}` |
| 상태 | `GET /api/cliproxy/auth/:provider/status?state=` | `{status: 'wait'\|'success'\|'error', error?}` |
| 콜백 | `POST /api/cliproxy/auth/:provider/submit-callback` | `{redirectUrl}` — code 파라미터 없으면 400 |
| 취소 | `POST /api/cliproxy/auth/:provider/cancel` | — |

**스파이크로 검증 완료** (2026-07-18): BFF에서 로그인 → 세션 쿠키 보관 → `/api/cliproxy/auth`
프록시 왕복이 실계정 4개 데이터로 동작함을 확인. 로그인 레이트리밋 때문에 BFF의 로그인은
single-flight + 최소 간격 가드가 필수라는 것도 확인.

---

## 3. 아키텍처

### 3.1 구성

```
┌─ Baton (단일 npm 프로젝트) ────────────────────────────────┐
│                                                            │
│  SPA (React 19 + Vite + Tailwind v4 + shadcn/ui)           │
│   └─ /api/* 호출 (자기 오리진)                             │
│                                                            │
│  BFF (Express · :4400)                                     │
│   ├─ the gateway 세션 보관 (로그인 자동화, 401 재로그인)    │
│   ├─ /api/* → the gateway :3000 패스스루 프록시             │
│   ├─ 정책 엔진 (60s 틱 데몬) ← §5                          │
│   └─ /baton/* (엔진 상태·토글·조향 로그)                   │
└────────────────────────────────────────────────────────────┘
                    │ .env: GATEWAY_URL 한 줄로 절연
                    ▼
        the gateway :3000 (Docker → 추후 네이티브)
```

### 3.2 아키텍처 결정 기록 (대안 비교)

**ADR-1. 왜 새 웹인가 — the gateway's built-in dashboard를 고치지 않고?**
| 대안 | 평가 |
|---|---|
| the gateway 레포 포크·UI 수정 | 업스트림 추적 부담. 이미지 품질 이력(gcompat·claude CLI 누락) 고려 시 유지비 큼. **기각** |
| the gateway UI에 CSS만 덮어쓰기 | 표면 치장. 동선·정보구조 문제 해결 불가. **기각** |
| **독립 웹 + the gateway's management API 소비** | API가 충분함을 실측으로 확인. UI 완전 재량. **채택** |

**ADR-2. 왜 BFF를 두는가 — SPA가 the gateway를 직접 부르지 않고?**
| 근거 | 설명 |
|---|---|
| 인증 소멸 | the gateway 세션(로그인·쿠키·레이트리밋)을 BFF가 흡수 → SPA에 로그인 화면 자체가 없음 |
| CORS 소멸 | 브라우저는 단일 오리진만 봄 |
| 정책 엔진의 집 | 브라우저 탭은 닫히면 죽음 — 상주 데몬은 서버 프로세스에 있어야 함 (**BFF가 없으면 정책 엔진을 둘 곳이 없음** — 이것이 결정적 근거) |
| 이전 내성 | Docker → 네이티브 전환 시 `.env`의 `GATEWAY_URL`만 변경 |

**ADR-3. 왜 "조향(steering)"인가 — 커스텀 프록시가 아니고?**
| 대안 | 평가 |
|---|---|
| Baton이 8317 앞단 프록시가 되어 요청마다 계정 선택 | 계정 선택은 CLIProxy 내부 로직이라 외부 프록시가 요청 단위로 지정 불가. 전체 재구현 필요. **기각** |
| CLIProxy(Go) 포크에 정책 추가 | Go 코드베이스 유지 부담 + 업스트림 추적. **기각** |
| **pause/resume/default API로 활성 계정 집합을 틱 단위 조정** | 포크 없음. 코스 그레인(60s)이지만 리셋 타이밍은 시간 단위로 변하므로 충분. 엔진이 죽어도 CLIProxy 기본 동작으로 자연 퇴행. **채택** |

### 3.3 프로젝트 구조 (구현 시)

```
Baton/
├─ docs/DESIGN.md
├─ server/                  # BFF
│   ├─ index.ts             # Express: 정적 서빙(prod) + /api 프록시 + /baton API
│   ├─ gateway-session.ts   # 로그인 single-flight·쿠키 보관·401 재로그인·간격 가드
│   ├─ gateway-client.ts    # 타입드 gateway 호출 (정책 엔진 전용)
│   ├─ policy-engine.ts     # §5
│   └─ config.ts            # .env (GATEWAY_URL, GATEWAY_USER, GATEWAY_PASS, BATON_PORT)
├─ src/
│   ├─ api/                 # fetch 클라이언트 + §2.4 계약 타입
│   ├─ hooks/               # usePolling(visibility-aware), useAccounts, useQuota
│   ├─ components/ui/       # shadcn 스타일 (button/card/badge/progress/dialog/switch)
│   ├─ components/          # AccountCard, QuotaBar, PolicyPanel, ...
│   └─ App.tsx              # 단일 페이지 (라우터 없음 — §4.1)
└─ .env                     # gitignore 대상 (gateway 자격증명 포함)
```

---

## 4. UI/UX 설계

### 4.1 정보 구조 — 단일 페이지, 3개 섹션

라우터 없음. 이 도구의 사용 패턴은 "열고 → 훑고 → 닫기"이므로 페이지 전환은 마찰일 뿐이다.
스크롤 한 번에 전부 보이는 세로 구성:

```
┌────────────────────────────────────────────────────────────┐
│ ⑂ Baton        [● Proxy :8317 · 42m]      [☾ theme] [⟳]   │ ← 헤더 (sticky)
├────────────────────────────────────────────────────────────┤
│                                                            │
│  ── 스마트 로테이션 ──────────────────────────── [ON ●]    │
│  정책: 리셋 임박 우선 소진                                 │
│  현재 타깃: claude → claude-main (1h 42m 후 리셋)         │
│  ▸ 조향 로그 (접힘, 펼치면 최근 20건)                      │
│                                                            │
│  ── Claude (2) ──────────────────────── [+ 계정 추가]      │
│  ┌──────────────────────┐  ┌──────────────────────┐        │
│  │ claude-main ⛳타깃    │  │ claude-reserve ★기본 │        │
│  │ 5h  ████████░░  70%  │  │ 한도 정보 미제공     │        │
│  │     2h 후 리셋       │  │ (구독 정보 없음)     │        │
│  │ 7d  █████████░  88%⚠ │  │                      │        │
│  │     1d 11h 후 리셋   │  │                      │        │
│  │ [기본지정][일시정지] │  │ [일시정지] [삭제]    │        │
│  └──────────────────────┘  └──────────────────────┘        │
│                                                            │
│  ── Codex (2) ───────────────────────── [+ 계정 추가]      │
│  │ codex-main ★ 4%·5d12h│  │ codex-reserve  0%    │        │
│                                                            │
│  ── 설정 ──────────────────────────────────────────        │
│  CLIProxy 전략   (●) round-robin  ( ) fill-first           │
│                  ⓘ 스마트 로테이션 ON일 땐 엔진이 우선     │
│  세션 고정       [OFF] · TTL [1h]                          │
│  연결 정보       ANTHROPIC_BASE_URL=... [복사]             │
│  프록시          [재시작]                                  │
└────────────────────────────────────────────────────────────┘
```

### 4.2 계정 카드 해부 (핵심 컴포넌트)

the gateway 원본의 최대 결함 = 쿼터가 provider 상세를 파고들어야 보임.
Baton은 **계정 카드에 모든 상태를 집약**:

```
┌────────────────────────────────────┐
│ user@example.com                   │ ← 이메일 (닉네임은 보조 표기)
│ ⛳ 정책 타깃  ·  ⏸ 일시정지됨      │ ← 상태 배지 행 (해당 시에만)
│                                    │
│ 5h   ████████████░░░░  70%         │ ← 쿼터 바 ×2 (5h/7d)
│      ↻ 2h 14m 후 리셋              │    색상: <60% 기본 / 60-85% 주의 /
│ 7d   ██████████████░░  88%         │          >85% 경고 / 미제공 회색
│      ↻ 1d 11h 후 리셋              │
│                                    │
│ [★ 기본지정] [⏸ 일시정지] [🗑]     │ ← 액션 (삭제는 확인 모달)
└────────────────────────────────────┘
```

원칙:
- 리셋 시각은 절대시각이 아니라 **카운트다운**("2h 14m 후") — 판단에 필요한 형태로
- "한도 정보 미제공"(claude-reserve 케이스)은 오류가 아닌 **1급 상태**로 디자인 (§2.4)
- 데이터 신선도 명시: 헤더에 "쿼터 기준: 45초 전" 타임스탬프 (2분 캐시의 정직한 표기)
- 정책 엔진이 pause한 계정은 배지로 **엔진에 의한 것임을 구분** (사용자 pause와 시각 분리)

### 4.3 계정 추가 마법사 (다이얼로그, 3단계)

우리가 오늘 수동으로 겪은 흐름(콜백 URL 붙여넣기)을 그대로 UI화:

```
[1/3 시작]                [2/3 인증 대기]              [3/3 완료]
provider 선택(라디오)  →  OAuth URL 새탭 자동오픈   →  ✓ 계정 추가됨
닉네임(선택) 입력         "브라우저에서 로그인 후,      카드 목록 갱신
[인증 시작]               리다이렉트 실패 페이지의
                          주소창 URL을 붙여넣으세요"
                          [URL 입력란] ← 검증*
                          (status 2s 폴링 병행)
```

\* 클라이언트 검증: `localhost:54545|1455` + `code=` + `state=` 파라미터 존재 확인 후 제출.
실패(코드 만료 등) 시 "다시 시작" 원클릭 → start-url 재발급.
CAPTCHA는 provider 페이지에서 사용자가 푸는 것 — 마법사 안내문에 명시.

### 4.4 시각 언어

- shadcn/ui 기반, 다크/라이트 (시스템 추종 + 수동 토글)
- 밀도: 카드 그리드 2열(≥900px) / 1열(모바일). 여백 우선, the gateway의 빽빽한 테이블 지양
- 색: 쿼터 바에만 의미색 사용(기본/주의/경고), 나머지는 중립 톤 — 시선이 쿼터로 가게

### 4.5 클라이언트 자동 설정

- 대상별로 실제 설정 파일을 파싱해 `적용됨` / `미적용` / `설정 충돌` / `확인 불가`를 판정한다. Baton 내부 플래그만으로 판정하지 않는다.
- 이미 `적용됨`인 대상은 재적용하지 않고, 정확히 Baton 값과 일치할 때만 해제할 수 있다.
- 적용과 해제 모두 선택한 클라이언트의 종료 상태를 두 번 확인하고, 파일 독점 잠금 검사 후에만 원자적 교체한다.
- 해제는 Baton 소유 키/테이블만 제거하고 관계없는 사용자 설정을 보존한다. 부분 적용이나 다른 값이 감지되면 파일을 수정하지 않고 충돌로 표시한다.

---

## 5. 스마트 로테이션 정책 엔진 (v1: 리셋 임박 우선 소진)

### 5.1 결정과 근거 (2026-07-18 사용자 결정)

> 곧 리셋될 계정의 남은 쿼터는 **소멸 예정 자원** → 우선 소진하고 타 계정 쿼터를 보존.
> 리셋 후엔 해당 계정의 다음 리셋이 가장 멀어지므로, 타깃이 자연히 다음 임박 계정으로
> 넘어가는 **캐스케이드**가 형성된다.

### 5.2 알고리즘 (60s 틱, provider별 독립 수행)

```
tick(provider):
  accounts ← GET /accounts/:provider
  quotas   ← GET /quota/:provider/:id  (각 계정)

  분류:
    ACTIVE    = 5h 윈도우 살아있고 usedPercent < 95
    FRESH     = windows가 비었거나 미사용 (윈도우 앵커 없음)
    EXHAUSTED = usedPercent ≥ 95
    BLIND     = 쿼터 조회 실패 or 한도 미제공 (claude-reserve 유형)

  순위: ACTIVE를 resetAt 오름차순(임박 우선)
        → FRESH (새 윈도우를 여는 비용이 있으므로 후순위)
        → BLIND (판단 불가 — 최후순위지만 배제하지 않음)
        → EXHAUSTED는 순위 제외

  목표 상태:
    target  = 순위 1위 → default 지정
    reserve = 순위 2위 → 활성 유지 (429 페일오버 예비)
    나머지   → pause

  적용(멱등): 현재 상태와 목표 상태의 차이만 API 호출
```

### 5.3 엣지케이스 (설계 시점에 확정)

| 상황 | 처리 |
|---|---|
| 순위 가능 계정 = 0 | **조향 해제**: 엔진이 pause한 계정 전부 resume, 로그 남김 |
| 순위 가능 계정 = 1 | 해당 계정을 **단독 타깃**으로 지정, EXHAUSTED 계정은 pause, 상태에 `예비 없음` 표시 |
| 쿼터 조회 실패(일시) | 해당 계정은 이번 틱에서 BLIND 취급. **연속 2틱 동일 판단일 때만 조향 변경** (플래핑 방지 디바운스) |
| 타깃의 리셋 통과 | 다음 틱에서 자연 재순위 (앵커 이동으로 캐스케이드) |
| 사용자가 수동 pause한 계정 | 엔진은 **자기가 pause한 계정만** resume (자체 장부로 구분) — 사용자 의사 존중 |
| 엔진 OFF 전환 | 엔진이 pause한 계정 전부 resume 후 정지 (fail-safe 복원) |
| BFF 재시작 | 장부(`.baton-state.json`)에서 enabled + 엔진-pause 목록 복원. enabled면 즉시 틱 |
| the gateway/CLIProxy 다운 | 틱 실패 로그만 남기고 다음 틱 재시도. 조향 상태 변경 없음 |

### 5.4 제약의 정직한 명시

- **요청 단위 개입 불가**: 트래픽이 Baton을 경유하지 않음. 틱(60s)이 유일한 제어점.
  리셋 타이밍은 시간 단위로 변하므로 이 해상도로 충분하다고 판단 (리뷰 포인트 §10-Q3)
- **데이터 신선도 하한 2분**: the gateway 캐시(§2.3). 엔진 판단·UI 표기 모두 이 한계 위에서 동작
- **관측성**: 모든 조향 행위는 링버퍼 로그(최근 50건)에 "무엇을 왜"와 함께 기록, UI 노출.
  블랙박스면 신뢰할 수 없는 기능이 됨

### 5.5 확장 구조 (v2 대비)

정책은 인터페이스로 분리 — `순위(accounts, quotas) → ordering` 만 교체 가능:

| v2 후보 정책 | 목표 함수 |
|---|---|
| 동시 분산 | 순간 처리량 최대 (윈도우 동기화 리스크 감수) |
| 순차 소진 | 상시 가용성 (윈도우 계단식) |
| 저사용/고사용 우선 | 균등 마모 / 윈도우 조기 마감 |
| 가중 랜덤 | 균형 + 예측불가성 |
| 예약(reserve N) | 긴급 작업용 여유 확보 |

---

## 6. 데이터 흐름과 폴링 정책

| 데이터 | 주기 | 근거 |
|---|---|---|
| 쿼터 (SPA 표시용) | 60s | 서버 캐시 2분 — 더 자주는 무의미. "n초 전 기준" 표기 |
| 쿼터 (엔진 판단용) | 60s 틱 | 동일 근거. SPA와 별개 경로(BFF 내부) |
| 프록시 상태 | 10s | 경량. 재시작 감지 |
| 계정 목록 | 탭 포커스 시 + 변경 액션 직후 | 저빈도 변경 |
| OAuth 진행 상태 | 마법사 진행 중에만 2s | 완료 감지 |
| 조향 로그 | 정책 패널 펼침 시 + 5s | 관측용 |

공통: 탭 백그라운드 시 SPA 폴링 전면 정지(visibilitychange). 엔진 틱은 서버 상주이므로 계속.

### OAuth 추가 시퀀스 (참여자 간)

```
SPA          BFF              gateway            Provider(브라우저 새탭)
 │ 시작(닉네임)│                 │                  │
 ├──────────→│ start-url       │                  │
 │           ├────────────────→│ → {url, state}   │
 │ ←──url────┤                 │                  │
 │ 새탭 오픈 ─────────────────────────────────────→│ 사용자: 로그인·승인·CAPTCHA
 │           │                 │                  │ → localhost 리다이렉트(실패 페이지)
 │ 사용자가 콜백 URL 붙여넣기   │                  │
 ├──────────→│ submit-callback │                  │
 │           ├────────────────→│ 토큰 교환·저장   │
 │ (status 2s 폴링) ──────────→│ 'success'        │
 │ 완료 화면·카드 갱신          │                  │
```

---

## 7. 비기능 요구

| 항목 | 설계 |
|---|---|
| 보안 — 자격증명 | gateway 대시보드 계정은 `.env`(gitignore)에만. BFF는 `127.0.0.1` 바인딩 (외부 노출 없음) |
| 보안 — 로그인 | gateway 레이트리밋(5/15min) 보호: single-flight + 시도 간 최소 30s (스파이크에서 필요성 검증) |
| 성능 | 폴링 전량 로컬 호출. 계정 n=4~10 규모에서 무시 가능. 쿼터 병렬 조회 |
| 장애 — 엔진 | 죽어도 CLIProxy 기본 동작으로 퇴행. 재기동 시 장부 복원 (§5.3) |
| 장애 — gateway 다운 | SPA는 마지막 데이터 + "연결 끊김" 배너. BFF 502 패스스루 |
| 이전 내성 | `GATEWAY_URL` 1줄 (§3.2 ADR-2) |

---

## 8. 구현 마일스톤 (승인 후)

| 단계 | 내용 | 완료 기준 |
|---|---|---|
| M1 | BFF: 세션+프록시 | `curl :4400/api/cliproxy/accounts/claude` → 실계정 JSON (스파이크로 사전 검증됨) |
| M2 | SPA 골격 + Accounts 섹션 | 실데이터 4계정 카드 + 쿼터 바 + 카운트다운 렌더 |
| M3 | 계정 액션 + 추가 마법사 | 실 OAuth 1왕복 E2E |
| M4 | 정책 엔진 + 정책 패널 | 조향 로그에 의도된 pause/resume/default 기록 확인, ON→OFF 복원 확인 |
| M5 | Settings + 테마 + 마감 | 빌드 산출물로 BFF 단독 서빙 |

각 단계 끝에 실환경 검증 후 다음 단계 진행.

---

## 9. 리스크

| 리스크 | 심각도 | 대응 |
|---|---|---|
| the gateway's management API 비공식 — 버전업 시 파손 | 중 | `src/api/` 한 층에 격리 + 기동 시 스모크 체크(계약 어긋나면 배너) |
| 조향과 사용자 수동 조작 충돌 | 중 | 엔진 장부로 자기 행위만 되돌림 + 로그 투명화 (§5.3) |
| reserve까지 소진 시 페일오버 공백 | 중 | 순위 가능 <2 → 조향 해제 규칙. 추가로 "전 계정 위험" 배너 |
| 쿼터 API가 봇 차단 등으로 막힘 | 저 | BLIND 분류로 퇴행 — 엔진은 보수적으로 동작 |
| Docker→네이티브 이전 시 예상외 차이 | 저 | BFF 절연 + 이전 후 M1 검증 재실행 |

---

## 10. 사용자 판단 필요 사항 (리뷰 포인트)

- **Q1. 소진 판정 임계값**: EXHAUSTED를 95%로 잡음(§5.2). 100%로 두면 429 직전까지 태우고,
  90%로 두면 여유를 남김. **95%가 적절한가?**
- **Q2. FRESH(미사용) 계정의 순위**: 현재 설계는 "윈도우를 새로 열지 않도록 후순위".
  반대로 "빨리 열어서 리셋 사이클에 편입"시키는 선택지도 있음. **후순위가 맞는가?**
- **Q3. 틱 주기 60s**: 쿼터 캐시가 2분이므로 60~120s가 합리 구간. **60s로 확정?**
- **Q4. 엔진 ON일 때 CLIProxy 전략**: 조향과 겹치는 round-robin을 그대로 둘지,
  엔진이 자동으로 fill-first로 전환할지(활성 2계정 내에서 타깃 우선 소진에 유리).
  **엔진이 fill-first로 자동 전환하는 안을 제안** — 동의하는가?
- **Q5. 대시보드 접근 보안**: BFF는 127.0.0.1 바인딩 + 무인증(로컬 단일 사용자 전제).
  LAN 공유 필요 시 인증 추가 필요. **로컬 전용으로 확정?**
- **Q6. Codex Spark 쿼터**: Codex 계정에 별도 "Spark(5h)" 윈도우가 실측됨(현재 100%).
  v1 카드에 표기만 할지, 정책 판단에도 반영할지. **v1은 표기만을 제안** — 동의하는가?
