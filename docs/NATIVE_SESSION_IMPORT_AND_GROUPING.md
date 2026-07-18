# Native session import와 대화 목록 그룹화 설계

- 상태: 구현 기준안
- 작성일: 2026-07-18
- 상위 계약: [`COMMON_SESSION_DESIGN.md`](COMMON_SESSION_DESIGN.md),
  [`NATIVE_SESSION_CONTINUITY_BRIDGE.md`](NATIVE_SESSION_CONTINUITY_BRIDGE.md)

## 1. 결정 요약

Baton은 로컬 Codex Desktop task와 Claude Desktop의 로컬 Claude Code task를 읽기 전용으로
발견하고, 사용자가 목록과 경고를 확인한 뒤에만 **별도 logical-work fork인 Baton 복사본**으로
가져온다. native 원본은 수정하지 않는다. 이 1차 import는 SSOT handoff나 동기화가 아니다.

- bulk import 기본값에서는 한 native task가 하나의 **새 logical-work ID와 canonical session**이 된다.
  parent source snapshot과 fork edge를 기록하므로 native 원본과 같은 logical work로 오인하지 않는다.
  서로 다른 task를 제목이나 `cwd`만으로 합치지 않는다.
- Codex의 `threads.title`, Claude Desktop의 `title/titleSource`를 source alias로 보존한다.
- 원본 identity는 `source_client + namespace_key + native_session_id`로 식별한다.
- 같은 identity의 같은 content digest는 다시 import하지 않는다. 원본이 늘어난 경우에는 새 revision만
  추가할 수 있도록 source head를 별도로 기록한다.
- import된 session과 native 원본은 import 지점에서 갈라진 독립 작업이다. Baton에서 새 turn을 실행해도
  native 작업의 authority를 획득했다고 주장하지 않는다. 동일 logical work의 SSOT를 Baton으로 옮기는
  기능은 continuity bridge의 `authority_transition`을 구현한 후 별도 `canonical_migration`으로 제공한다.
- import는 `preview -> explicit commit` 두 단계이며 preview가 가리킨 원본 head가 달라지면 commit을
  거부하고 다시 preview한다.
- 대화 sidebar는 project 그룹화를 기본값으로 사용하고 작은 보기 메뉴에서 `없음 / 프로젝트 /
  provider`를 선택한다.
- assistant message 표시는 기본적으로 `Codex`, `Claude`, `Gemini`처럼 provider 이름을 쓴다. Baton의
  provider 전환 이력을 숨기지 않는 것이 `Assistant`라는 일반명보다 중요하다. 같은 보기 메뉴에서
  `provider / Assistant / 둘 다`를 로컬 표시 설정으로 바꿀 수 있다.

## 2. 범위와 명시적 한계

### 2.1 지원 source

| source client | 목록 metadata | transcript | source alias |
|---|---|---|---|
| `codex_local` | `~/.codex/state_5.sqlite`의 `threads` | `threads.rollout_path` JSONL | `threads.title` |
| `claude_desktop` | `%APPDATA%/Claude/claude-code-sessions/<profile>/<workspace>/local_*.json` | `cliSessionId`와 일치하는 `~/.claude/projects/**/*.jsonl` | `title`, `titleSource` |

Codex Desktop과 Codex CLI는 같은 store를 공유할 수 있으므로 별도 source로 중복 열거하지 않는다.
Claude Desktop의 위 경로는 Desktop 안에서 실행한 로컬 Claude Code task를 뜻한다. `~/.claude/projects`
만 존재하는 독립 Claude Code CLI session도 `claude_code` source로 열거할 수 있지만, Desktop metadata와
같은 `cliSessionId`가 있으면 Desktop identity 하나로 합친다. 이 교차 client dedupe는 탐색 로직만으로
처리하지 않고 §4의 identity-key unique constraint로 강제한다.

Claude의 일반 원격 채팅 목록은 계정과 endpoint가 소유하는 서버 자료다. Electron cache나 IndexedDB를
비공식적으로 역공학해 “전부 import했다”고 주장하지 않는다. 공식 export/API가 제공되기 전에는 preview에
`unsupported_remote_chat` 경고와 발견 가능한 namespace만 표시한다. gateway를 바꾸면 목록이 달라지는
현상도 이 계정/endpoint namespace 차이로 취급한다.

### 2.2 비목표

- native DB/JSONL 수정, `/goal` 변경 또는 native task에 message 전송
- 동일 logical work의 authority를 native에서 Baton으로 전환하거나 single-writer를 보장하는 기능
- 제목, `cwd`, 시간 유사성만으로 서로 다른 native task 자동 병합
- hidden reasoning, credential, provider-private opaque state 복제
- import 즉시 native continuation을 보장한다는 주장

## 3. SourceReader와 alias 규칙

source adapter는 allowlist된 기본 root만 읽고 쓰기 handle을 열지 않는다. 각 candidate에는 transcript
본문 전체가 아니라 다음 bounded index를 만든다.

```text
candidate_id                 preview에만 유효한 opaque ID
source_client                codex_local | claude_desktop | claude_code
provider                     codex | claude
namespace_key                scoped profile/endpoint pseudonym
native_session_id
source_alias                 사용자가 보던 task/session 이름
alias_source                 native | generated | first_user | path_fallback
project_alias
cwd / normalized_cwd
created_at / updated_at
message_count / portable_item_count / skipped_item_count
source_head                  size + mtime + final-record digest
content_digest               import 대상 normalized record stream 전체의 SHA-256
prefix_digest                마지막 import cursor까지 normalized stream의 SHA-256
record_cursor                마지막 안정 record의 ordinal과 identity
parser_version
warnings[]
```

alias 우선순위는 다음과 같다.

1. native UI가 저장한 명시적 title/name
2. native UI가 생성한 title
3. 첫 user message의 제한된 preview
4. `cwd`의 마지막 path segment
5. `Codex task` 또는 `Claude task`

첫 user message는 preview 응답과 sidebar alias에 기본 노출하지 않는다. native title이 없을 때도 UI에는
generic fallback을 먼저 보여 주고, 사용자가 candidate 상세를 펼친 경우에만 제한·redaction된 preview를
읽는다. title 자체도 secret-like pattern과 길이 제한을 통과시킨다.

`source_alias`는 provenance metadata로 영구 보존한다. canonical `sessions.title`은 최초 import 때 alias를
복사하지만 이후 사용자가 바꾼 canonical title과 동기화하지 않는다. project label은 명시적
`project_alias`, repository/worktree 이름, `projectKey`, `cwd` basename 순서로 계산한다.

Codex adapter는 SQLite의 metadata를 권위 index로 사용하고 rollout JSONL은 content source로 사용한다.
Claude adapter는 Desktop metadata의 `sessionId`를 native identity로, `cliSessionId`를 transcript locator로
사용한다. 계정/profile 디렉터리 UUID는 평문 저장하지 않고 설치별 secret으로 HMAC한 `namespace_key`만
저장한다.

## 4. 데이터 모델

```sql
CREATE TABLE native_session_sources (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  source_client TEXT NOT NULL,
  provider TEXT NOT NULL,
  namespace_key TEXT NOT NULL,
  native_session_id TEXT NOT NULL,
  source_alias TEXT,
  alias_source TEXT NOT NULL,
  project_alias TEXT,
  cwd TEXT,
  current_content_digest TEXT NOT NULL,
  current_prefix_digest TEXT NOT NULL,
  current_last_record_ordinal INTEGER NOT NULL,
  current_last_record_digest TEXT NOT NULL,
  imported_item_sequence INTEGER NOT NULL,
  first_imported_at TEXT NOT NULL,
  last_imported_at TEXT NOT NULL,
  UNIQUE(source_client, namespace_key, native_session_id)
);

CREATE TABLE native_session_identity_keys (
  source_id TEXT NOT NULL REFERENCES native_session_sources(id),
  provider TEXT NOT NULL,
  namespace_key TEXT NOT NULL,
  identity_kind TEXT NOT NULL,
  identity_value_hmac TEXT NOT NULL,
  PRIMARY KEY(provider, namespace_key, identity_kind, identity_value_hmac),
  UNIQUE(source_id, identity_kind)
);

CREATE TABLE native_session_revisions (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL REFERENCES native_session_sources(id),
  content_digest TEXT NOT NULL,
  prefix_digest TEXT NOT NULL,
  source_head_json TEXT NOT NULL,
  parser_version TEXT NOT NULL,
  portable_item_count INTEGER NOT NULL,
  skipped_item_count INTEGER NOT NULL,
  last_record_ordinal INTEGER NOT NULL,
  last_record_digest TEXT NOT NULL,
  imported_at TEXT NOT NULL,
  UNIQUE(source_id, content_digest)
);

CREATE TABLE native_imported_records (
  source_id TEXT NOT NULL REFERENCES native_session_sources(id),
  native_record_key_hmac TEXT NOT NULL,
  item_id TEXT REFERENCES items(id),
  source_revision_id TEXT NOT NULL REFERENCES native_session_revisions(id),
  source_ordinal INTEGER NOT NULL,
  normalized_record_digest TEXT NOT NULL,
  imported_at TEXT NOT NULL,
  PRIMARY KEY(source_id, native_record_key_hmac)
);

CREATE TABLE native_import_commits (
  token_nonce_hmac TEXT PRIMARY KEY,
  principal_key TEXT NOT NULL,
  request_digest TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('applying','completed','failed')),
  receipt_json TEXT CHECK(receipt_json IS NULL OR json_valid(receipt_json)),
  created_at TEXT NOT NULL,
  completed_at TEXT
);
```

`native_session_sources`는 원본 identity와 표시 alias의 provenance이며 provider continuation binding과
다른 개념이다. `provider_bindings`는 canonical thread를 provider runtime에서 계속 실행하기 위한 상태다.
두 테이블을 합치지 않는다.

Claude Desktop candidate는 `sessionId`와 `cliSessionId` 두 identity key를 저장한다. 독립 Claude Code
adapter도 `cliSessionId` key를 사용하므로 같은 transcript를 두 source client가 동시에 claim할 수 없다.
identity 원문은 저장하지 않고 설치 secret HMAC을 저장한다. Codex는 thread/session ID key를 사용한다.
CLI source가 먼저 import된 뒤 Desktop metadata가 발견되면 새 session을 만들지 않고 기존 source에 Desktop
identity key와 alias provenance를 추가한다. 이 승격도 unique constraint와 transaction 안에서 수행한다.

Claude의 identity `namespace_key`는 Desktop account/profile UUID가 아니라 canonical transcript store root와
Baton 설치 identity에서 만든 installation scope를 쓴다. Desktop metadata와 독립 CLI adapter가 같은
`~/.claude/projects` transcript를 읽으면 같은 namespace가 된다. account/gateway profile pseudonym은 별도
provenance attribute이며 `cliSessionId` uniqueness에 포함하지 않는다.

import된 item은 기존 `items`에 저장한다.

- user/assistant text: `portable`
- tool call/result와 검증 가능한 file-change 요약: 지원 schema만 `portable`
- reasoning summary: 명시적으로 제공된 summary만 `provider_private`
- unknown/encrypted/secret-like content: 본문을 저장하지 않고 loss report count만 기록
- `native_id`: source record UUID/event ID가 있을 때 보존
- payload provenance: `nativeSourceId`, `nativeRecordType`, `nativeTimestamp`

## 5. Import protocol

### 5.1 Preview

`POST /api/conversations/native-import/preview`

요청은 source 종류와 선택적 기간/project filter만 받는다. 응답은 source별 count, candidate 목록,
`new / update_available / duplicate / unavailable / unsupported` 상태, 총 예상 item 수와 경고를 제공한다.
응답 본문은 redaction된 alias·project label·provider·시각·건수 같은 bounded display metadata만 반환한다.

대규모 inventory에서 preview는 모든 normalized item을 메모리에 보유하지 않는다. bounded-concurrency
metadata scan이 alias, count, digest와 내부 locator만 계산하고 item 배열은 즉시 버린다. 내부 locator와 raw
path/native ID/namespace는 token과 UI 응답에 포함하지 않는다. commit은 선택된 candidate를 한 개씩 다시
읽어 head·digest·count를 검증하고 즉시 transaction/checkpoint한 뒤 다음 candidate로 넘어간다.

서버는 preview 결과를 메모리에만 두지 않고 만료 시간이 있는 digest-bound token으로 서명한다. token에는
현재 local principal, exact allowlist scope, candidate set, candidate identity, full normalized-stream digest,
prefix digest, source head와 parser version이 결합된다. 기본 만료는 10분이다.
token nonce는 commit identity다. 최초 요청은 `native_import_commits`에 principal과 request digest를 기록한다.
동일 principal·nonce·request의 재시도는 mutation을 반복하지 않고 durable receipt를 반환하며, 다른
principal이나 payload로 nonce를 재사용하면 거부한다. API는 loopback에 bind된 Baton origin의 same-origin
요청만 허용하고 strict `Host`/`Origin` 검증과 per-process CSRF token을 함께 요구한다.

UI는 commit 전 다음을 명시한다.

- 발견 수, 새 import 수, update 수, duplicate 수
- 선택된 task의 alias, project, provider, 마지막 수정 시각
- native 원본은 수정되지 않고 Baton DB로 복사된다는 점
- unsupported/skip/loss count
- 원격 Claude 채팅은 포함되지 않을 수 있다는 경고
- 결과가 native 원본과 동기화되지 않는 독립 Baton 복사본이며 SSOT 승계가 아니라는 경고

### 5.2 Commit

`POST /api/conversations/native-import/commit`

요청은 preview token과 사용자가 선택한 `candidate_id[]`를 받는다. 서버는 source head와 digest를 다시
검증하고 candidate별 DB transaction을 수행한다. 한 candidate 실패가 다른 candidate의 성공을 되돌리지
않으며 결과를 `imported / updated / duplicate / stale / failed`로 개별 반환한다.

신규 identity는 session, root thread, source, revision, normalized items와 loss summary를 한 transaction으로
만든다. 기존 identity의 새 digest는 마지막 import 이후의 record만 append할 수 있을 때만 update한다.
full digest는 parser가 import 대상으로 인정한 normalized record stream 전부를 순서대로 hash한다. 파일의
size, mtime와 final record digest는 빠른 stale hint일 뿐 commit 증거가 아니다. prefix digest/record cursor가
맞지 않으면 자동 merge하지 않고 `source_rewritten`으로 거부한다. update는
`WHERE current_last_record_digest = :previewed_previous_digest AND imported_item_sequence =
:previewed_item_sequence` 조건의 CAS로 source head를 전진시킨다. 각 원본 record
identity도 `native_imported_records` unique key로 보호한다. CAS 실패는 `stale`이고 자동 재시도하지 않는다.
exact digest duplicate는 성공한 no-op이다. 재시도와 동시 commit은 identity, record unique constraint와
transaction으로 멱등이다.

import된 session은 idle 상태이며 자동으로 모델 실행을 시작하지 않는다. 사용자가 이후 메시지를 보내면
import 지점에서 fork된 Baton logical work의 새 turn을 시작한다. UI는 native 원본의 후속 변경이 Baton에
자동 반영되지 않음을 표시한다. 같은 logical work를 승계하려면 향후 authority transition workflow를 써야 한다.
bulk import의 `fork_copy` logical-work ID는 source native ID와 다르며 authority epoch도 공유하지 않는다.

source delta는 root thread revision이 여전히 `0`이고 `imported_item_sequence` 뒤에 Baton-origin item이 없을
때만 같은 fork copy에 append한다. Baton turn 또는 별도 item이 추가됐으면 두 fork를 자동으로 선형 merge하지
않고 `update_conflict_after_fork`로 표시한다. 사용자는 새 snapshot fork를 만들거나 향후 reconciliation
workflow에서 두 갈래를 명시적으로 합칠 수 있다.

## 6. UI 설계

sidebar 상단의 작은 `Menu` 버튼은 보기 popover를 연다.

```text
그룹화
  프로젝트  (기본)
  Provider
  없음

응답자 표시
  Provider 이름 (기본)
  Assistant
  둘 다

Native 대화 가져오기…
```

그룹 순서는 그룹 내부의 가장 최근 `updatedAt` 기준이며 각 그룹 안에서도 최신순이다. project가 없는
session은 `프로젝트 없음`에 둔다. 그룹은 접을 수 있고 접힘 상태, group mode와 응답자 표시는 versioned
`localStorage` UI preference로 저장한다. 이는 canonical data가 아니며 다른 기기와 동기화하지 않는다.

import dialog는 `검사 -> 선택 -> 확인 -> 결과` 네 상태를 갖는다. 검사만으로 DB를 변경하지 않는다.
commit 버튼에는 선택 수를 표시하고 duplicate는 기본 선택에서 제외한다. stale 결과는 새 preview 링크를
제공한다. mobile과 desktop sidebar가 같은 preference와 dialog를 공유한다.

candidate와 결과 목록은 검색과 50행 pagination으로 bounded render한다. 신규/update 수천 건을 자동
선택하지 않으며 현재 page 선택 또는 2단계 확인을 거친 전체 선택만 허용한다. 한 preview의 안전 상한은
10,000개이고 이를 넘으면 검색으로 범위를 줄여야 한다.

assistant message header는 기본 mode에서 provider 하나만 보여 중복된 `Assistant · Codex` 표기를 피한다.
tool/error/usage 같은 non-message item은 item 종류가 핵심이므로 기존 종류 label 뒤에 provider를 보조 표기로
유지한다.

## 7. 모듈 구조와 DAG

```text
A. contracts + migration
├─ B. Codex SourceReader adapter
├─ C. Claude SourceReader adapter
├─ D. preview/commit service + API
└─ E. sidebar grouping/view preference
   └─ F. import dialog

B + C + D + E + F -> G. integration/E2E/adversarial review
```

구현 위치:

```text
server/session/native-import/contracts.ts
server/session/native-import/codex-source.ts
server/session/native-import/claude-source.ts
server/session/native-import/service.ts
server/session/native-import/source-utils.ts
src/features/conversations/session-view-preferences.ts
src/features/conversations/NativeImportDialog.tsx
```

PowerShell one-shot package와 server adapter는 파일을 직접 공유하지 않는다. package는 다른 PC에서
독립 실행되어야 하고 server는 TypeScript runtime 계약을 따라야 한다. 다만 candidate schema, alias
우선순위, source identity와 duplicate 규칙은 같은 fixture로 교차 검증한다.

one-shot package의 기본 `desktop-visible` inventory는 Codex `app-server thread/list`의 현재 provider,
interactive, `archived=false` 집합과 Claude Desktop `claude-code-sessions`의 `isArchived=false` local
Code/Cowork metadata만 사용한다. Claude 일반 원격 채팅·원격 Projects는 로컬 CLI 정본으로 간주하지
않으며 포함됐다고 주장하지 않는다. `local-all`은 명시적 호환 모드이고 Desktop 전용 의미가 아니다.
매칭 전 Git worktree root 또는 canonical folder로 project를 선분할한 뒤, project 안의 두 provider
session dossier 목록을 한 번의 분석 컨텍스트로 합친다. 전역 M×N LLM pair 비교는 하지 않는다.

## 8. 실패와 보안 규칙

- live native file은 read 전후 head를 비교하고 변하면 candidate를 stale로 표시한다.
- SQLite는 read-only connection으로 열고 busy/locked이면 해당 source만 unavailable로 반환한다.
- canonical path가 승인 root 밖이거나 symlink/junction으로 탈출하면 fail-closed한다.
- transcript 문자열은 데이터이며 prompt나 shell command로 실행하지 않는다. deterministic import에는 모델을
  호출하지 않는다.
- preview API는 localhost Baton UI에서만 사용하고 raw source path, profile UUID, endpoint, token을 응답하지
  않는다.
- 최대 file/byte/record/preview 길이를 두고 한 candidate의 과대 입력이 전체 scan을 고갈시키지 않게 한다.
- 현재 로컬 단일 사용자 profile의 hard cap은 source file 256MiB, physical JSONL line 250,000개,
  portable record 250,000개, preview candidate 10,000개다. file scan concurrency 기본값은 1이다. 초과
  source는 부분 import하지 않고 구조화된 `unsupported` 경고로 fail-closed한다. inventory가 10,000개를
  넘으면 reader가 incomplete sentinel과 정확하거나 보수적인 초과 수를 반환하고 server는 잘린 목록을
  token화하지 않고 preview 전체를 거부한다.
- parser가 모르는 top-level schema/version은 candidate 전체를 `unsupported_schema`로 fail-closed한다. 이미
  지원한다고 선언한 record 안에서 parser contract가 framing과 순서를 보존한 채 ignorable이라고 명시한
  optional content block만 loss count와 warning으로 생략한다.
- first-user alias 후보는 DLP/secret-like redaction, control-character 제거, Unicode 정규화와 길이 제한을
  모두 통과해야 한다. 민감 판정이면 generic alias를 쓴다.
- tool input/result는 raw body가 아니라 path/name/id/status/type 같은 bounded metadata만 이식한다. file body,
  patch, command, env, header, credential/token/password/cookie, blob/base64와 대용량 result는 저장하지 않고
  loss count로 남긴다. reasoning summary는 provider-private이며 DLP와 16KiB 상한을 통과한 경우만 저장한다.

## 9. 검증 기준

1. fixture와 실제 store의 read-only scan에서 alias, namespace, cwd, count가 노출 가능한 범위와 일치한다.
2. preview만 실행하면 Baton DB와 native source의 digest/mtime이 변하지 않는다.
3. commit 전에 UI가 총 수와 선택 목록, 경고를 표시한다.
4. 같은 preview/commit을 두 번 실행해도 canonical session/item이 중복되지 않는다.
5. import 뒤 늘어난 append-only source는 delta만 추가되고 rewritten source는 거부된다.
6. provider 또는 project가 다른 같은 제목의 task가 합쳐지지 않는다.
7. project/provider/none 그룹화와 provider/Assistant/both 표기가 desktop/mobile에서 유지된다.
8. unit, router, SQLite migration, build/typecheck와 실제 local source를 사용한 비파괴 E2E를 통과한다.
9. one-shot package의 실제 환경 dry-run은 `gpt-5.6-luna/low`로 Plan만 만들고 native session을 변경하지 않는다.
   운영 handoff 분석 기본값은 계속 `gpt-5.6-sol/high`이다.
10. imported copy는 native authority를 획득했다고 표시하지 않고, future canonical migration과 명확히
    구분된다.
11. 같은 base에서 두 delta commit의 동시 실행, Baton turn 뒤 native delta, same-size/mtime 중간 rewrite,
    append+rewrite, response 유실·server restart 뒤 receipt replay, nonce의 다른 request 재사용, 다른
    principal/candidate token 사용, Desktop metadata late promotion을 fixture로 검증한다.

## 10. 향후 reconciliation과의 연결

bulk import는 source별 `fork_copy`가 기본이라 자동 merge하지 않는다. 상위 continuity workflow는 사용자가
여러 source를 하나의 기존 canonical target/lineage로 명시적으로 선택하고 reconciliation 결과와 authority
transition을 승인한 경우에만 여러 `native_session_sources`를 한 session에 연결할 수 있다. 이 경로는 1차
bulk import API에 포함하지 않지만 데이터 모델로 막지 않는다.

## 11. 로컬 인벤토리와 2단계 파싱 계약

- `codex_local`은 Codex Desktop 전용 저장소가 아니라 Desktop, CLI, IDE가 공유하는 `~/.codex` 로컬
  저장소를 뜻한다. 공개 API와 UI는 이 이름을 사용한다. 기존 Baton DB의 `codex_desktop` 값은 v3-v5
  CHECK 제약과의 호환을 위한 내부 저장 인코딩일 뿐이며 읽기 경계에서 `codex_local`로 정규화한다.
- Codex 기본 인벤토리는 `archived=false`인 사용자 표면 `source=cli|vscode`만 포함한다. `exec`,
  `subagent`, 기타 source와 archived task는 UI에서 명시적으로 포함해야 한다.
- preview inventory는 transcript 본문을 파싱하지 않는다. DB/metadata와 file size, mtime, 마지막 4KiB
  digest만 읽으며 portable/skipped count와 exact duplicate/update 판정은 `analysis pending`이다.
- commit은 사용자가 선택한 candidate만 한 개씩 전체 JSONL 파싱한다. preview의 source head와 Baton import
  state가 유지되는지 확인한 뒤 정확한 content/prefix digest, record count, duplicate/update를 결정한다.
- composite Claude reader는 요청한 `claude_desktop`/`claude_code` source만 candidate로 구성한다. Desktop
  metadata와 연결되지 않은 CLI transcript는 `claude_code`를 선택한 경우에만 인벤토리에 포함한다.
