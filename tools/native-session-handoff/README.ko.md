# Baton Native Session Handoff 0.1.0

Codex와 Claude의 로컬 CLI 세션을 읽기 전용으로 조사해 같은 작업을 매칭하고, Codex → Claude 승계 또는 Claude → 기존 Codex task 재승계용 goal/context를 생성하는 일회성 Windows 패키지입니다.

## 안전 경계

- `~/.codex`와 `~/.claude`의 JSONL·SQLite·설정을 직접 수정하지 않습니다.
- `Inventory`와 `Plan`은 원본 세션을 읽기만 합니다.
- `Wizard`와 `Apply`는 각 작업의 goal/context 전체를 먼저 보여 주고 exact phrase를 입력한 항목만 처리합니다.
- 분석 중 source JSONL이 append·삭제되면 오래된 manifest를 만들지 않고 `SOURCE_CHANGED_DURING_ANALYSIS`로 중단합니다.
- 적용 turn은 context ingest 전용이며 read-only/no-tool로 실행합니다. 실제 프로젝트 작업은 시작하지 않습니다.
- Codex `/goal`은 재개한 task에 실제 goal tool이 있을 때만 변경합니다. 없으면 성공으로 가장하지 않고 context message에 목표를 보존합니다.
- Claude Desktop을 자동 제어하지 않습니다. Claude CLI session만 생성하거나 재개합니다.

## 요구사항

- Windows 10/11
- Windows PowerShell 5.1 이상 또는 PowerShell 7 (`powershell`/`pwsh`)
- PATH에 `codex`, `claude` CLI
- 두 CLI 모두 해당 PC에서 직접 로그인된 상태
- proxy/custom gateway를 사용하지 않는 기본 provider 환경

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

1. `~/.codex/sessions/**/*.jsonl`과 `~/.claude/projects/**/*.jsonl`의 metadata를 읽습니다.
2. `cwd`별 candidate group을 만들되 cwd만으로 동일 작업을 확정하지 않습니다.
3. project group마다 `gpt-5.6-sol/high` 분석을 병렬 실행합니다.
4. 모델은 전달받은 전체 source 경로 중 필요한 범위를 자율적으로 선택해 읽습니다.
5. 원래 Codex 내용, Claude의 추가 작업, 최신 사용자 지시, 변경된 목표와 미완료 작업을 합칩니다.
6. `context only`, `goal replace`, 둘 다 또는 무조치를 제안합니다.
7. 사용자가 승인한 target만 context-ingest turn으로 재개하거나 새 Claude CLI session을 만듭니다.
8. 사용자는 이후 대상 CLI session을 직접 열어 실제 작업을 재개합니다.

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

- source session 경로와 짧은 첫 사용자 message preview
- 분석 prompt와 Codex JSONL event
- goal/context proposal이 들어 있는 handoff manifest
- apply acknowledgement와 receipt

원본 transcript 전체를 복사하지는 않지만 manifest에는 민감한 작업 내용이 포함될 수 있습니다. 실행이 끝나면 필요한 receipt만 보관하고 output 디렉터리를 사용자가 직접 정리하십시오. 스크립트는 output이나 원본 session을 자동 삭제하지 않습니다.

## 알려진 제한

- task 매칭과 goal/context 생성은 모델 판단이므로 낮은 confidence와 warning을 반드시 확인해야 합니다.
- Codex `exec resume`는 message-only API가 아니라 실제 model turn입니다. 패키지는 read-only context-ingest prompt와 schema로 행동을 제한하지만 target history에는 user/assistant turn이 추가됩니다.
- Claude에는 Codex `/goal`과 동일한 durable primitive가 없으므로 working goal은 prompt context입니다.
- live 실행 중인 native session을 자동 판별·중단하지 않습니다. 적용 전에 대상 CLI/Desktop 작업을 종료해야 합니다.
- session 포맷이 바뀌어 metadata를 읽을 수 없으면 해당 source는 inventory에서 누락될 수 있으므로 count와 unmatched 목록을 확인해야 합니다.
