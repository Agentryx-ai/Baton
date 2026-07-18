# Baton MVP — 빌드 DAG

> DESIGN.md 구현을 독립 작업으로 분해. **가짜 종속성 제거 원칙**: 공유 계약(타입·시그니처·prop
> 인터페이스)을 파운데이션에서 먼저 확정하면, 구현끼리는 서로를 기다릴 필요가 없다.
> 각 노드는 **서로소(disjoint) 파일 집합**을 소유 → 병렬 쓰기 충돌 없음.

- 작성: 2026-07-18 · 오케스트레이터: 메인 세션
- 실행 모델: F(직렬 루트, 메인) → {P1..P6}(병렬, 에이전트 1개씩) → I(통합·검증, 메인)

## 0. 의존 그래프

```
        ┌──────────────────────────── F (Foundation, 직렬) ───────────────────────────┐
        │ 스캐폴드·deps·vite/tsconfig·tailwind·shadcn primitives·공유계약(types)·폴더  │
        └───────────────┬───────────────────────────────────────────────────────────┘
                        │ (모두 F에만 의존 — 서로간엔 계약으로 분리, 진짜 종속 없음)
   ┌────────┬───────────┼───────────┬───────────┬───────────┐
   ▼        ▼           ▼           ▼           ▼           ▼
  P1       P2          P3          P4          P5          P6
BFF-core  BFF-policy  SPA-data   SPA-accts   SPA-wizard  SPA-settings
   │        │           │           │           │           │
   └────────┴───────────┴─────┬─────┴───────────┴───────────┘
                              ▼
                          I (통합: App 조립 + 배선 + 검증, 메인)
```

**진짜 종속성만**: P1..P6 → F. I → P1..P6.
**가짜 종속성 제거 근거**: P4(계정카드)는 P3(훅)의 *구현*이 아니라 *시그니처*에만 의존 →
계약이 F에 박혀 있으면 병렬 가능. P2는 P1의 `gateway-client` *export 계약*에만 의존(§계약).

## 1. 노드 정의 · 파일 소유 · 모델

| 노드 | 담당 | 모델 | 소유 파일 (배타적 쓰기) |
|---|---|---|---|
| **F** | 메인 | — | 스캐폴드 전체, `vite.config.ts`, `tsconfig*.json`, `src/index.css`, `components.json`, `src/lib/utils.ts`, `src/api/types.ts`(공유계약), `.env`, `.gitignore`, `package.json`(scripts/deps), `src/components/ui/*`(shadcn primitives), 빈 폴더 스켈레톤 |
| **P1** BFF-core | 에이전트 | opus-high | `server/config.ts`, `server/gateway-session.ts`, `server/gateway-client.ts`, `server/index.ts` |
| **P2** BFF-policy | 에이전트 | opus-high | `server/policy-engine.ts`, `server/baton-routes.ts`, `server/policy-types.ts` |
| **P3** SPA-data | 에이전트 | opus-high | `src/api/client.ts`, `src/hooks/*.ts` |
| **P4** SPA-accts | 에이전트 | opus-high | `src/components/AccountCard.tsx`, `QuotaBar.tsx`, `ProviderSection.tsx`, `RotationPanel.tsx` |
| **P5** SPA-wizard | 에이전트 | opus-high | `src/components/AddAccountWizard.tsx` |
| **P6** SPA-settings | 에이전트 | opus-high | `src/components/SettingsSection.tsx`, `Header.tsx`, `ThemeToggle.tsx`, `theme.tsx` |
| **I** 통합·검증 | 메인 | — | `src/App.tsx`, `src/main.tsx`, 배선/픽스, 검증 |

**금지 규칙(모든 P)**: `npm install` 금지(F가 모든 deps 제공), 소유 외 파일 수정 금지,
특히 `package.json`·`tsconfig*`·`index.css`·`components.json`·`src/api/types.ts`·`src/components/ui/*` **읽기 전용**.

## 2. 공유 계약 (F가 확정 → 모든 노드가 코드 기준으로 삼음)

### 2.1 API 타입 — `src/api/types.ts` (F 생성, 전 노드 읽기전용)
DESIGN.md §2.4 실측 스키마 기준. Provider, Account, QuotaWindow, AccountQuota,
ProxyStatus, RoutingStrategy, SessionAffinity, AddStatus, PolicyState, SteerLogEntry.
(정확한 필드는 F가 파일로 확정; 아래 시그니처가 이를 참조)

### 2.2 SPA API 클라이언트 — `src/api/client.ts` (P3 구현, P4/P5/P6 호출)
```ts
// 조회
getAccounts(): Promise<Record<Provider, Account[]>>
getQuota(provider: Provider, accountId: string): Promise<AccountQuota>
getProxyStatus(): Promise<ProxyStatus>
getRoutingStrategy(): Promise<RoutingStrategy>
getSessionAffinity(): Promise<SessionAffinity>
getPolicy(): Promise<PolicyState>
// 변경
setDefault(provider, accountId): Promise<void>
pauseAccount(provider, accountId): Promise<void>
resumeAccount(provider, accountId): Promise<void>
removeAccount(provider, accountId): Promise<void>
setRoutingStrategy(strategy): Promise<void>
setSessionAffinity(enabled: boolean, ttl?: string): Promise<void>
restartProxy(): Promise<void>
setPolicy(enabled: boolean, policy?: string): Promise<PolicyState>
// OAuth 추가
startAddAccount(provider, nickname?): Promise<{ url: string; state: string }>
getAddStatus(provider, state): Promise<AddStatus>       // {status:'wait'|'success'|'error', error?}
submitCallback(provider, redirectUrl): Promise<AddStatus>
cancelAddAccount(provider): Promise<void>
```
모든 호출은 상대경로 `/api/...`(BFF 프록시). 실패 시 `throw new ApiError(status, message)`.

### 2.3 훅 — `src/hooks/` (P3 구현, P4/P5/P6 소비)
```ts
usePolling<T>(fn: () => Promise<T>, intervalMs: number): { data: T|null; error: Error|null; refresh: () => void; loading: boolean }
  // 문서가치: document.hidden 이면 폴링 정지, visible 복귀 시 즉시 1회 + 재개
useAccounts(): { accounts: Record<Provider, Account[]>|null; refresh: () => void; error: Error|null }   // 30s + refresh
useQuota(provider, accountId): { quota: AccountQuota|null; ageSec: number|null }                        // 60s
useProxyStatus(): { status: ProxyStatus|null }                                                          // 10s
usePolicy(): { state: PolicyState|null; setEnabled: (b:boolean)=>Promise<void>; refresh:()=>void }      // 5s
```

### 2.4 컴포넌트 prop 계약 (P4/P5/P6 각자 구현, I가 조립)
```ts
// P4
<QuotaBar window={QuotaWindow} />                       // 5h/7d 바 1개 + 리셋 카운트다운 + 경고색(<60/60-85/>85)
<AccountCard account={Account} quota={AccountQuota|null} isPolicyTarget={boolean}
             onSetDefault onPause onResume onRemove />  // 콜백은 () => void (I가 client 배선)
<ProviderSection provider={Provider} accounts={Account[]} quotas={Record<id,AccountQuota>}
                 policyTargets={string[]} on...={} onAddAccount={() => void} />
<RotationPanel state={PolicyState|null} onToggle={(b)=>void} />   // ON/OFF, 현재 타깃, 조향 로그(접힘)
// P5
<AddAccountWizard open={boolean} onOpenChange onAdded={() => void} />   // 내부에서 client.* 직접 호출
// P6
<Header proxy={ProxyStatus|null} onRefresh={()=>void} />
<SettingsSection routing={RoutingStrategy|null} affinity={SessionAffinity|null}
                 proxy={ProxyStatus|null} connectionSnippet={string}
                 onSetStrategy onSetAffinity onRestartProxy />
<ThemeToggle />   // theme.tsx의 useTheme 사용
```
- UI primitives는 `@/components/ui/*` (F 제공). 아이콘 `lucide-react`.
- 스타일: DESIGN.md §4.4 (shadcn, 중립톤, 쿼터 바에만 의미색). 카드 2열 그리드.
- **미제공 쿼터**(windows=[]) 를 1급 상태로 렌더(회색 "한도 정보 없음") — §4.2.

### 2.5 BFF 내부 계약
```ts
// P1: server/config.ts
export const config: { gatewayUrl; gatewayUser; gatewayPass; port }
// P1: server/gateway-session.ts
export function fetchGateway(path, {method, headers?, body?}): Promise<{status; headers; body: Buffer}>
export function sessionStatus(): { loggedIn: boolean }
// P1: server/gateway-client.ts  (P2가 소비)
export interface GatewayAccount { id; provider; isDefault; email; nickname; paused?; lastUsedAt? }
export interface AccountQuota { success; windows: {rateLimitType; usedPercent; remainingPercent; resetAt: string|null}[]; lastUpdated; accountId }
export async function getAccounts(provider): Promise<GatewayAccount[]>
export async function getQuota(provider, accountId): Promise<AccountQuota>
export async function setDefaultAccount(provider, accountId): Promise<void>
export async function pauseAccount(provider, accountId): Promise<void>
export async function resumeAccount(provider, accountId): Promise<void>
// P1: server/index.ts
//   express: raw body, GET /baton/health, use('/api', proxy via fetchGateway),
//   import { batonRouter } from './baton-routes.ts'; app.use(batonRouter)
//   import { policyEngine } from './policy-engine.ts'; policyEngine.startIfEnabled()
//   prod: serve ../dist static + SPA fallback. listen(config.port) on 127.0.0.1

// P2: server/policy-engine.ts  (싱글턴 export)
export const policyEngine: {
  getState(): PolicyState; setEnabled(b): Promise<PolicyState>; setPolicy(id): Promise<PolicyState>;
  startIfEnabled(): void; stop(): void;
}
//   정책 'reset-imminent-first' 구현 (DESIGN.md §5.2 알고리즘, §5.3 엣지케이스).
//   gateway-client의 getAccounts/getQuota/setDefault/pause/resume 사용.
//   상태 영속: server/.baton-state.json (enabled + 엔진-pause 장부).
// P2: server/baton-routes.ts
export const batonRouter: Router  // GET /baton/policy, POST /baton/policy {enabled?,policy?}, GET /baton/policy/log
//   SPA는 /api가 아닌 /baton/* 를 vite proxy로 함께 프록시 → F가 vite.config에 /baton 프록시 추가
```

### 2.6 SPA→정책 경로
`client.getPolicy()`/`setPolicy()` 는 `/baton/policy` 를 호출(‑`/api` 아님).
F가 `vite.config.ts` 프록시에 `/baton` 도 `:4400` 로 추가. PolicyState/SteerLogEntry 타입은 §2.1(types.ts)에 포함.

## 3. 실행 순서

1. **F** (메인, 직렬): 스캐폴드→deps→config→tailwind→shadcn init+primitives→`types.ts`+`utils.ts`→폴더 스켈레톤→**baseline 빌드 통과 확인**(빈 App).
2. **P1..P6** (에이전트 6개, 단일 메시지 병렬 스폰): 각자 계약대로 소유 파일만 구현. 앱 전체 컴파일은 이 시점 미보장(정상).
3. **I** (메인): `App.tsx`로 전 컴포넌트 조립 + 콜백을 client에 배선 + `main.tsx`/테마 provider. 이후 검증:
   - `tsc -b` 타입 통과, `vite build` 성공
   - BFF 기동 → `curl :4400/api/cliproxy/accounts/claude` 실계정 반환
   - `/baton/policy` 토글 → 조향 로그 확인 → OFF 복원 확인
   - dev 기동 → SPA가 실데이터 4계정 렌더(쿼터 바·카운트다운) 스크린샷
   - Add Account: start-url→(수동 승인)→submit-callback E2E 1회

## 4. 검증 게이트 (완료 정의) — 전부 통과 (2026-07-18)
- [x] `npm run build` 무오류(tsc+vite) — 1909 모듈, 0 에러
- [x] BFF 프록시 실계정 데이터 왕복 — `/api/cliproxy/auth/accounts/*` JSON
- [x] SPA 4계정 카드+쿼터 렌더 — 실데이터 스크린샷(쿼터 바 색상·리셋 카운트다운·"한도 정보 없음" 1급 상태)
- [x] 정책 엔진 ON→조향 로그→OFF 복원 실증 — UI 토글로 target=claude-main 지정, OFF 시 fail-safe release 로그 확인
- [x] Add Account 마법사 E2E — start-url→실 OAuth URL 새탭→step2(콜백 입력·자동확인) (실 로그인 경계까지)
- [x] 다크/라이트 토글 동작 — 스크린샷 확인

## 5. 통합에서 잡은 계약-불일치 (기록)
- 계정 목록/변경 실경로는 `/api/cliproxy/**auth**/accounts/:provider` (문서의 `/api/cliproxy/accounts/...`는 틀렸음). gateway-client + client 양쪽 수정.
- start-url 응답 필드는 `authUrl` (문서의 `url`/`auth_url` 아님). client 정규화에 `authUrl` + URL에서 state 파싱 폴백 추가.
- P3 client는 named export가 아니라 `client` 객체 — P5가 자동 적응.
- AccountCard 쿼터 key: Codex 두 윈도우가 동일 rateLimitType이라 index 포함 key로 수정.
