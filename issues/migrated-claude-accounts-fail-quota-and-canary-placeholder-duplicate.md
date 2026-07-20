# Migrated Claude accounts fail quota; pre-migration canary account survives as a placeholder duplicate

## 상태

- 상태: **부분 해결**
- 발견일: 2026-07-21
- 신규 OAuth의 profile email/stable account ID 저장과 기존 계정 backfill 도구는 `ef68dd5`에서 구현
- refresh 실패 원인 확증, vault 중복 병합과 live quota 검증은 미완료

## 증상 (사용자 관찰)

Baton UI에서 Claude 계정 `merozemory@gmail.com` 카드는 사용량(quota)이 로드되지 않고,
이름이 placeholder `Claude Code`인 **다른 카드**에 사용량이 표시됩니다.

## 증거 (실측)

`GET /baton/claude-native/accounts` → Claude Native 계정 3개:

| id | email | nickname | created | quota (`GET /baton/claude-native/quota/:id`) |
|---|---|---|---|---|
| `c39d3b12-…a731b` | merozemory@gmail.com | merozemory | 2026-07-20T15:25:56Z (migration) | ❌ HTTP 500 |
| `30b684e4-…2e3a5` | **(빈 문자열)** | **Claude Code** | 2026-07-20T**09:26**:53Z (migration 이전) | ✅ 정상 windows 반환 |
| `0286d1c5-…89794` | eternalreturn.test.001@gmail.com | eternalreturn… | 2026-07-20T15:25:53Z (migration) | ❌ HTTP 500 |

- `30b684e4`는 15:25 마이그레이션 배치보다 **이른 09:26**에 생성됨 → 마이그레이션 이전
  Native Claude live-canary(단일계정)에서 만들어진 **잔여 계정**으로 보임. OAuth에서
  email이 채워지지 않아 UI가 앱 이름 `Claude Code`를 placeholder로 표시.
- CLIProxy에서 **마이그레이션된** 두 계정(merozemory 포함)은 모두 quota 500.
  마이그레이션 경로(`30b684e4`가 아닌)로 들어온 credential만 실패하는 패턴.

## 가장 유력한 원인 (미확증)

`30b684e4`(canary)와 `c39d3b12`(migration)는 **같은 Anthropic 계정**(merozemory)을 가리키는
중복으로 추정됩니다. Anthropic OAuth refresh 토큰은 1회성 회전(rotating)이므로,
canary가 먼저 로그인/갱신하며 토큰을 회전시켜 **CLIProxy가 보관하던 옛 refresh 토큰
(=마이그레이션된 `c39d3b12`의 것)이 무효화**된 것으로 보입니다 → refresh 실패 → quota 500.
같은 이유로 `0286d1c5`도 실패.

- 마이그레이션 idempotency(`scripts/migrate-legacy-cliproxy-accounts.ts`의 refresh-token
  fingerprint 대조)가 canary 계정과 매칭에 실패해 **중복 계정을 생성**한 것도 이 회전으로
  설명됨(같은 계정이라도 토큰 문자열이 달라 fingerprint 불일치).
- 미확정: 정확한 실패 코드(`invalid_grant` 등). standalone probe가 런타임 import 단계에서
  `TransformError`로 종료돼 끝까지 재현하지 못함. HTTP quota 500만 확인됨.

## 영향 범위

- 마이그레이션 이전에 Native 로그인/canary를 한 뒤 CLIProxy에서도 마이그레이션된 모든
  사용자가 **중복 계정 + 사용량 표시 오배치**를 겪을 수 있음.
- email 미기입 계정은 UI에서 `Claude Code`처럼 구분 불가능한 placeholder로 표시됨.

## 조치 상태

1. **원인 확증 — 미완료**: `loadNativeClaudeAccountCredential` 실패 경로가 `invalid_grant`인지 확인하고,
   quota 라우트의 generic 500 대신 refresh 실패를 구분 가능한 에러로 표면화.
2. **중복 정리 — 미완료**: 같은 Anthropic 계정(동일 sub/account id)에 대한 Native vault 중복을 감지·병합.
   마이그레이션 매칭을 refresh-token fingerprint 외에 **불변 계정 식별자(account id / id_token sub)**로도 수행.
3. **placeholder 제거 — 구현됨**: 신규 OAuth는 `/api/oauth/profile`의 email과 stable UUID를
   저장한다. `scripts/backfill-claude-emails.ts`가 기존 계정의 email/UUID/nickname을 멱등 보강한다.
   profile 조회 실패는 로그인 자체를 실패시키지 않는다.
4. **깨진 credential 복구 UX — 미완료**: quota가 refresh 실패로 죽은 계정은 카드에 "재로그인 필요"를
   명확히 노출(현재는 무표시).

## 검증 (수정 후)

- 3계정 각각 `/quota/:id` 200 + windows.
- 같은 Anthropic 계정 중복 0개.
- 모든 Claude 카드에 email/식별 라벨 표시.
