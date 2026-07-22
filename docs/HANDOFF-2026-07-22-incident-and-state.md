# 인수인계: 2026-07-22 장애 대응·재설계·purge 작업 상태

작성: Claude(메인 복구 세션), 2026-07-22 오후. 다른 AI 에이전트가 이 문서만 읽고 이어받을 수 있도록 작성.

## ⚠️ 절대 규칙 (오늘 장애의 직접 원인들 — 위반 금지)

1. **프로덕션 DB(`%LOCALAPPDATA%\Baton\canonical-conversations.sqlite3`)에 스크립트/테스트를 직접 돌리지 마라.**
   오늘 11:36 다른 에이전트 세션이 서버 실행 중에 purge 스크립트를 돌려 75분간 DB를 잠갔고(전 서비스 hang),
   그 프로세스가 도중 kill되며 DB가 빈 스키마로 손상됐다(백업에서 복구 완료). 테스트는 반드시 temp dataDir 사용.
2. **스케줄 작업 `Baton-Worker-ec21331eb2dd`를 Disable/Stop 하지 마라.** 이 작업이 서버 자동복구(self-heal)의 뿌리다.
   재시작이 필요하면 `scripts/restart-baton.ps1` 또는 작업 재시작만 사용.
3. **4400 서버 프로세스를 taskkill로 죽이지 마라.** 죽여도 자동 부활하지만(약 60초), 세션이 끊긴다.
4. 유지보수로 서버를 내려야 하면 **사용자에게 예고 후** 내리고, 끝나면 반드시 작업 Enable+Start로 복원하라.

## 시스템 현황 (이 문서 작성 시점)

- **웹/서버(4400): 정상.** sessions 28ms, 대화 868개 표시. `sessionHost: {mode:worker, state:ready}`.
- 서버는 스케줄 작업 → `baton-bootstrap.exe worker-runner` (감시자) → `tsx server/index.ts` 로 구동.
  - 서버 죽음 → 감시자가 60초 내 재기동. 감시자 죽음 → 작업의 1분 주기 heal 트리거가 재기동. 둘 다 실증됨.
- **아키텍처(오늘 재설계, main 병합됨)**: 세션 런타임+SQLite 전체가 **워커 스레드**에서 실행.
  메인 스레드(프록시/health/SPA)는 DB 정지에 영향받지 않음. `/baton/v1`은 토큰 보호 루프백 HTTP 홉으로 스트리밍.
  `server/session-host.ts`(감독자·프록시), `server/session-host-worker.ts`, `server/session-host-worker-bootstrap.mjs`.
  적대검수 3라운드(NO_PROBLEM) 후 병합. `BATON_SESSION_HOST=inline` = 구방식 escape hatch.

## 오늘 해결된 사건들 (전부 원인 확정·수정 완료)

1. **전 서비스 5초 hang** → 동기 SQLite(`DatabaseSync`)가 메인 루프에서 busy_timeout(5s) 대기.
   → 워커 스레드 격리로 해결(위 아키텍처). + `synchronous=NORMAL`, WAL 체크포인트(기동+5분 주기).
2. **감시자 기동 실패(EPERM)** → `scripts/baton-worker-runner.mjs`의 icacls가 파일 DACL을 비움. 수정·병합됨.
3. **감시자 죽으면 영구 다운** → 작업에 1분 주기 heal 트리거 추가(코드 반영: `server/windows-lifecycle.ts`).
4. **DB 증발** → 11:36 purge 프로세스를 도중 kill한 결과. purge 자체 백업
   (`%LOCALAPPDATA%\Baton\backups\canonical-conversations-before-archived-import-purge-2026-07-22T02-36-01-668Z.sqlite3`)
   에서 복원 완료(세션 868, quick_check ok). 오염본은 `corrupted-live-20260722-131037\`에 격리 보관.
5. **DB journal 헤더가 delete 모드로 뒤집힘** → WAL로 복원 완료.

## 사용자 목표 (진행 중 — 이어받을 작업)

**목적: 임포트된 세션을 전부 지우고, Desktop 대화만 깨끗하게 재임포트.**

- 삭제 대상: `native_session_sources` 행이 있는 세션 **832개** (codex_desktop 610 / claude_code 201 / claude_desktop 21).
  터치된 1개("다음끼니 마케팅 리서치 보고서")도 삭제 확정(사용자 확인됨).
- 보존: 순수 Baton 대화 **36개** (임포트 행 없음).
- **재임포트 조건(사용자 확정)**: Desktop만. `sources: ['codex_local','claude_desktop']` +
  `codex: { origins: ['ide_app'], includeSubagents: false, includeArchived: false }`,
  Claude 쪽 아카이브는 preview 후보의 `nativeArchived === false`만 commit.
  CLI/exec/서브에이전트/아카이브 전부 제외. API: `POST /baton/v1/native-import/preview` → `commit`
  (CSRF: `GET /baton/v1/native-import/csrf`, 헤더 `X-Baton-CSRF-Token`+`Origin`+`Sec-Fetch-Site: same-origin`).

### 진행 상태와 남은 블로커

- purge 도구: `scripts/purge-native-imports.ts` (dry-run 기본, `--apply` 시 자체 백업 후 삭제, 서버 실행 중이면 거부).
  개선 완료: 배치 25 + 배치별 커밋/체크포인트/진행로그.
- **성능 수정(미커밋, 워킹트리)**: 마이그레이션 v20 = `native_imported_records(source_id)`, `(item_id)` 인덱스.
  (746K 행 테이블에 인덱스가 없어 삭제가 제곱 폭발 → 75분. item_id는 items FK 검사용.)
- **실측**: 스크래치(실데이터 1GB 사본)에서 개선판 purge = **301초** (배치당 3~21초). → 수정 유효.
- **미해결 블로커**: 같은 개선판이 **라이브 DB에서만 배치당 10분+**로 느림(원인 미상, 스크래치와 차이 미해명).
  → 라이브 사본(`scratchpad/bkverify/live-copy.sqlite3`) 대상 **문장별 타이밍 진단**(`stmt-timing.cjs`)이
  백그라운드 실행 중이었음. 결과로 느린 DELETE 문을 특정한 뒤, 필요한 인덱스를 추가하고 재실측 후에만 라이브 적용할 것.
  (스크래치 사본과 라이브의 데이터 차이: 라이브는 복원 후 서버가 recovery/goal/follow-up 작업을 수행함.)
- 주의: 이전 시도가 남긴 sentinel(`archived_at='1970-01-01T00:00:00.000Z'`)은 **되돌림 완료**(현재 0개).
  purge를 다시 돌리면 스크립트가 다시 마킹한다. **--apply는 서버 정지 후에만**, 그리고 도중에 절대 kill하지 말 것
  (kill해도 트랜잭션은 롤백되지만 sentinel 마킹 커밋은 남아 재기동 시 retention 청소가 느린 경로로 갈린다 —
  이 경우 sentinel을 NULL로 되돌리면 된다).

## 미커밋 변경 (워킹트리, main 기준)

전부 테스트 통과 상태(store 69/69, lifecycle 23/23, ui-behavior/router 포함 100/100):

1. `server/session/sqlite-store.ts` — 마이그레이션 v20(인덱스 2개, 테이블 부재 가드), SCHEMA_VERSION=20,
   `visibleWorkStatus`에서 'imported' 특례 제거(임포트 세션도 일반 상태 표시 — 사용자 요구).
2. `server/session/domain.ts`, `src/features/conversations/types.ts`, `ConversationWorkspace.tsx` — 'imported' 상태 제거.
3. `scripts/purge-native-imports.ts` — 배치/체크포인트/로그 (신규 파일, 원저자는 다른 세션).
4. `server/windows-lifecycle.ts` + `scripts/baton-hidden-launch.vbs` — **콘솔창 숨김**: 작업 액션을
   wscript(창 0) 셔틀 경유로 변경. 사용자 불만("빈 커맨드창") 해결용.
   **아직 라이브 작업에 미적용** — 적용하려면 코드 커밋 후 `autostart repair`(또는 unregister+install)로 재등록 필요.
5. 관련 테스트 갱신들.

커밋 시 논리 단위: (a) v20 인덱스+purge 스크립트, (b) imported 상태 제거, (c) 숨김 런처.

## 백업 목록 (아무것도 지우지 말 것)

`%LOCALAPPDATA%\Baton\` 아래:
- `backups\canonical-conversations-before-archived-import-purge-2026-07-22T02-36-01-668Z.sqlite3` — **원본(868세션). 최중요.**
- `canonical-conversations.sqlite3.backup-2026-07-22T04-52-38-488Z` — purge 재시도 직전 백업.
- `wal-recovery-backup-20260722-123552\` — 손상 당시 DB+178MB WAL(포렌식용).
- `corrupted-live-20260722-131037\` — 오염본 격리.

## 다음 순서 (권장)

1. 문장별 진단 결과 확인 → 느린 문장에 인덱스 추가 → **라이브 사본으로 재실측**(수 분 확인 전 라이브 금지).
2. 사용자에게 ~5분 창 예고 → 서버 정지 → `npx tsx scripts/purge-native-imports.ts --apply` → 작업 Enable+Start.
3. 재임포트(위 Desktop-only 조건) → UI 확인(세션 수십 개 수준, "가져옴" 배지 없음).
4. 미커밋 변경 커밋(+원하면 적대검수) → 숨김 콘솔 적용(`autostart repair`) → push 여부는 사용자 확인.
