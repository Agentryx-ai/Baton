# Baton Native Session Handoff 0.2.0

Codex Desktop에 현재 표시되는 interactive task와 Claude Desktop에서 실행한 로컬 Claude Code/Cowork task를 읽기 전용으로 조사해 같은 작업을 매칭하고, Codex → Claude 승계 또는 Claude → 기존 Codex task 재승계용 goal/context를 생성하는 일회성 Windows 패키지입니다.

기본 `-SourceScope desktop-visible`의 정확한 범위는 다음과 같습니다.

- Codex: `codex app-server`의 `thread/list`를 `archived=false`로 호출한 현재 provider의 interactive root task. Desktop과 CLI가 공유하는 local store 중 Desktop 목록 의미에 맞는 집합입니다.
- Claude: `%APPDATA%\Claude\claude-code-sessions`에서 `isArchived=false`인 Desktop local task와 `cliSessionId`로 연결되는 `~/.claude/projects` transcript.
- 제외: Claude.ai의 일반 원격 채팅 및 원격 Projects. 이들은 로컬 CLI transcript 정본이 아니며 로컬 CLI 로그인만으로 완전하게 열거할 수 없습니다.

과거 동작처럼 로컬 transcript 전체를 조사하려면 명시적으로 `-SourceScope local-all`을 사용하십시오. 이 경우 Codex `~/.codex/sessions`와 Claude `~/.claude/projects`를 읽으며 Desktop 전용 목록이라고 주장하지 않습니다.

## 안전 경계

- `~/.codex`와 `~/.claude`의 JSONL·SQLite·설정을 직접 수정하지 않습니다.
- `Inventory`와 `Plan`은 원본 세션을 읽기만 합니다.
- `Wizard`와 `Apply`는 각 작업의 goal/context 전체를 먼저 보여 주고 exact phrase를 입력한 항목만 처리합니다.
- 분석 중 source JSONL이 append·삭제되면 오래된 manifest를 만들지 않고 `SOURCE_CHANGED_DURING_ANALYSIS`로 중단합니다.
- 적용 turn은 context ingest 전용이며 read-only/no-tool로 실행합니다. 실제 프로젝트 작업은 시작하지 않습니다.
- Codex `/goal`은 재개한 task에 실제 goal tool이 있을 때만 변경합니다. 없으면 성공으로 가장하지 않고 context message에 목표를 보존합니다.
- Claude Desktop을 자동 제어하지 않습니다. Claude CLI session만 생성하거나 재개합니다.
- Claude 일반 원격 채팅이나 원격 Projects를 가져왔다고 주장하지 않습니다.

## 요구사항

- Windows 10/11
- Windows PowerShell 5.1 이상 또는 PowerShell 7 (`powershell`/`pwsh`)
- PATH에 `codex`, `claude` CLI
- 두 CLI 모두 해당 PC에서 직접 로그인된 상태
- 권장 실행 환경은 proxy/custom gateway를 사용하지 않는 기본 provider입니다. gateway를 사용 중이면 Codex 기본 inventory가 현재 provider에 한정되며, 의도적으로 합칠 때만 `-CodexProviderScope all`을 사용합니다.
- Desktop 범위를 사용할 때 Claude Desktop이 만든 `%APPDATA%\Claude\claude-code-sessions` metadata

검증 기준 버전은 Codex CLI `0.144.5`, Claude Code `2.1.214`입니다. 다른 버전은 inventory까지 실행할 수 있지만 apply capability는 실제 CLI 옵션 검증을 통과해야 합니다.

안정적인 source cut을 위해 실행 전에 작업 중인 Codex/Claude CLI와 Desktop turn을 종료하십시오. 앱 자체를 반드시 제거할 필요는 없지만 session JSONL이 계속 append되는 상태에서는 분석이 의도적으로 실패합니다.

## 빠른 실행

압축을 푼 디렉터리에서 먼저 self-test를 실행합니다.

```powershell
Set-ExecutionPolicy -Scope Process Bypass
.\Test-NativeSessionHandoff.ps1
```

현재 상황처럼 Claude에서 추가된 작업을 기존 Codex task로 되돌리는 한 번 실행:

```powershell
.\Invoke-NativeSessionHandoff.ps1 `
  -Action Wizard `
  -Direction claude-to-codex `
  -SinceDays 0 `
  -Concurrency 4
```

`-SinceDays 0`은 전체 이력입니다. 최근 1년만 보려면 생략합니다. `-Concurrency 0`은 모든 project group 분석을 동시에 시작하므로 계정 rate limit이 충분할 때만 사용합니다.

Codex는 기본적으로 현재 provider에서 Desktop에 보이는 task만 선택합니다. 프록시와 직접 provider 양쪽의 interactive task를 함께 조사하려면 `-CodexProviderScope all`을 명시하십시오. 이 옵션도 exec/subagent를 포함하지는 않습니다.

Codex에서 Claude로 승계하려면 다음을 사용합니다.

```powershell
.\Invoke-NativeSessionHandoff.ps1 -Action Wizard -Direction codex-to-claude
```

양방향 후보를 모두 분석하려면 `-Direction all`을 사용합니다.

## 권장 2단계 실행

다른 PC에서 실제 적용 전 manifest를 별도로 검토하려면 먼저 `Plan`만 실행합니다.

```powershell
.\Invoke-NativeSessionHandoff.ps1 -Action Plan -Direction claude-to-codex -SinceDays 0
```

특정 프로젝트 하나만 분석하려면 프로젝트 안의 경로를 지정합니다. Git 저장소이면 `git rev-parse --show-toplevel`의 worktree root로, 아니면 실제 폴더 경로로 정규화한 뒤 inventory 단계에서 필터링하므로 다른 프로젝트는 모델에 전달되지 않습니다.

```powershell
.\Invoke-NativeSessionHandoff.ps1 `
  -Action Plan `
  -Direction claude-to-codex `
  -ProjectPath C:\work\demo `
  -CodexModel gpt-5.6-luna `
  -CodexEffort low
```

출력된 `handoff-manifest.json`을 확인한 뒤 적용합니다.

```powershell
.\Invoke-NativeSessionHandoff.ps1 `
  -Action Apply `
  -ManifestPath .\output\run-YYYYMMDD-HHMMSS\handoff-manifest.json
```

각 작업에서 선택 후 다음 exact phrase를 다시 입력해야 합니다.

```text
APPLY CODEX <work_id>
APPLY CLAUDE <work_id>
```

## 처리 흐름

1. Codex `app-server thread/list`와 Claude Desktop local-task metadata에서 비아카이브 candidate를 얻고 transcript를 연결합니다.
2. 각 session에 native title, 첫·최근 사용자 preview, 활동 시각, scan count, source reference로 된 bounded dossier를 만듭니다.
3. LLM을 호출하기 전에 Git worktree root 또는 canonical folder로 project group을 만듭니다.
4. 한 project 안의 Codex/Claude dossier 두 목록을 하나의 분석 컨텍스트로 합칩니다. 전역 M×N session-pair LLM 호출은 하지 않습니다.
5. project group마다 `gpt-5.6-sol/high` 분석을 병렬 실행합니다. 모델은 dossier로 후보를 좁힌 뒤 모호한 session의 source 범위를 자율적으로 선택해 더 읽습니다.
6. 원래 Codex 내용, Claude의 추가 작업, 최신 사용자 지시, 변경된 목표와 미완료 작업을 합칩니다.
7. `context only`, `goal replace`, 둘 다 또는 무조치를 제안합니다.
8. 사용자가 승인한 target만 context-ingest turn으로 재개하거나 새 Claude CLI session을 만듭니다.

## 모델 보장 범위

분석 호출은 다음을 강제합니다.

- `--model gpt-5.6-sol`
- `model_reasoning_effort="high"`
- `--ignore-user-config`
- fallback model 인자 없음
- model catalog에서 exact model과 effort 지원 확인
- read-only sandbox와 ephemeral analysis session

현재 검증한 Codex `exec --json`은 effective model metadata를 출력하지 않았습니다. 따라서 기본 manifest에는 `effective_attestation=unavailable_from_codex_exec_jsonl`이라고 정직하게 기록합니다. 명령 선택과 catalog 검증보다 강한 기계적 attestation이 필수라면 다음 옵션을 사용하십시오.

```powershell
-RequireEffectiveAttestation
```

해당 CLI가 runtime model metadata를 제공하지 않으면 분석 결과를 사용하지 않고 중단합니다. 이 옵션을 끈 상태를 “effective model이 기계적으로 인증됨”이라고 해석하면 안 됩니다.

Claude apply는 alias를 허용하지 않고 기본적으로 `--model claude-fable-5 --effort high`를 요청합니다. 실제 적용 전에 `--no-session-persistence` probe를 실행하고 JSON `modelUsage`가 exact model family와 다르면 session을 변경하지 않고 `MODEL_MISMATCH`로 중단합니다. 적용 호출 자체의 `modelUsage`도 다시 검사합니다. 실제 적용 뒤 mismatch가 발견되면 해당 session에 ingest turn이 남았을 수 있으므로 자동 재시도하지 않습니다.

## 적용 후 재개

Codex receipt의 session ID:

```powershell
codex resume <session-id>
```

Claude receipt의 session ID:

```powershell
claude --resume <session-id>
```

Claude CLI session이 Claude Desktop 목록에 나타나는지는 Desktop 버전·계정 namespace에 따라 다르며 이 패키지는 이를 보장하지 않습니다.

## 출력과 개인정보

`output/run-*`에는 다음 자료가 남습니다.

- source session 경로와 native title, 짧은 첫·최근 사용자 message preview
- 분석 prompt와 Codex JSONL event
- goal/context proposal이 들어 있는 handoff manifest
- apply acknowledgement와 receipt

원본 transcript 전체를 복사하지는 않지만 manifest에는 민감한 작업 내용이 포함될 수 있습니다. 실행이 끝나면 필요한 receipt만 보관하고 output 디렉터리를 사용자가 직접 정리하십시오. 스크립트는 output이나 원본 session을 자동 삭제하지 않습니다.

## 알려진 제한

- task 매칭과 goal/context 생성은 모델 판단이므로 낮은 confidence와 warning을 반드시 확인해야 합니다.
- Codex `exec resume`는 message-only API가 아니라 실제 model turn입니다. 패키지는 read-only context-ingest prompt와 schema로 행동을 제한하지만 target history에는 user/assistant turn이 추가됩니다.
- Claude에는 Codex `/goal`과 동일한 durable primitive가 없으므로 working goal은 prompt context입니다.
- Claude Desktop 일반 원격 채팅·원격 Projects는 포함되지 않습니다. 공식 export/API 없이 Electron cache나 private endpoint를 정본처럼 스크래핑하지 않습니다.
- Codex `desktop-visible`은 현재 provider를 기본값으로 사용합니다. provider/gateway 전환으로 숨은 task까지 합치려면 `-CodexProviderScope all`을 명시해야 합니다.
- live 실행 중인 native session을 자동 판별·중단하지 않습니다. 적용 전에 대상 CLI/Desktop 작업을 종료해야 합니다.
- session 포맷이 바뀌어 metadata를 읽을 수 없으면 해당 source는 inventory에서 누락될 수 있으므로 count와 unmatched 목록을 확인해야 합니다.
