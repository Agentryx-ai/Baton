# Baton canonical 대화는 provider plugin skill과 MCP를 안전하게 실행해야 함

## 상태

- 상태: **미해결**
- 발견일: 2026-07-20
- 우선순위: P1
- 범위: `/baton/v1` canonical conversation runtime
- Native client proxy의 plugin 문제는 해결됐으며 이 이슈와 별개다.

## 요구사항

Baton 자체 대화에서 선택한 provider/model이 사용할 수 있는 skill과 MCP/app connector를 발견하고
실행할 수 있어야 한다. 단순히 Codex transient app-server의 native plugin 기능을 켜는 것으로
끝내면 안 된다. 모든 tool call/result, permission, cancellation, retry와 crash recovery는 Baton의
canonical tool broker가 계속 소유해야 한다.

## 2026-07-20 실측

검수 session: `3e9bac36-b093-47d2-acef-31539b93470a`

| capability | 결과 | 증거 |
|---|---|---|
| system skill `openai-docs` resource | 성공 | `read_skill_resource(openai-docs, SKILL.md)` |
| skill helper 실행 | 성공, **full_access에서만 실측** | Baton `run_command`로 helper exit 0, `CANONICAL_SKILL_HELPER_OK` |
| helper 산출물 | 성공 | manual 799,577 bytes, header read 검증 |
| workspace 밖 temp file의 `read_file` | 의도대로 거부 | `path_escape: Path must be workspace-relative` |
| plugin skill `baton-codex-runtime-bridge:resolve-codex-runtime` | 실패 | `skill_not_available` |
| plugin skill `spreadsheets:Spreadsheets` | 실패 | `skill_not_available` |
| MCP/plugin callable tool | 없음 | execution `allowedTools`에 MCP/plugin 0개 |

첫 canary turn은 다른 작업의 Baton restart와 겹쳐 `runtime_interrupted`됐지만 그 전에
`openai-docs` resource read는 성공했다. 안정된 재시도 turn은 helper와 manual 검증을 끝까지
완료했다. plugin skill 두 개의 typed failure 뒤 provider stream이 별도
`provider_retry_exhausted`로 끝났지만, 두 `skill_not_available` tool result는 이미 canonical store에
durably 기록됐다.

## 현재 구현이 이렇게 동작하는 이유

- `server/session/codex-adapter.ts`의 hardening override가 `features.plugins=false`, apps/web/native
  shell을 비활성화하고 MCP server 잔존도 capability violation으로 처리한다.
- canonical prompt는 native plugin/MCP 실행을 금지하고 Baton dynamic tools만 사용하도록 한다.
- `SkillResourceToolRuntime`은 provider가 명시적으로 노출한 filesystem resource만 읽는다.
- Codex system skill 일부는 isolated runtime에서 발견되지만 installed plugin cache/marketplace의
  contributed skill을 canonical registry로 투영하는 계층이 없다.
- plugin 기준계정 control plane은 catalog 관리용이며 canonical execution tool registry와 아직
  연결되지 않았다.

이 hardening 자체는 결함이 아니다. 현재 결함은 native capability를 막은 뒤 동일 기능을 Baton-owned
execution으로 대체하지 않아 canonical 대화의 기능 표면이 CLI/Desktop보다 좁다는 점이다.

## 목표 설계

### Skill discovery

- selected provider의 system skill, 사용자가 설치한 skill, plugin-contributed skill을 provenance와
  함께 canonical registry에 투영한다.
- 동일 이름 충돌 시 `provider/plugin/skill` identity와 deterministic precedence를 보존한다.
- skill resource 읽기와 skill이 요구하는 executable capability를 별도 grant로 판정한다.
- permission profile이 부족하면 skill 자체를 성공으로 표시하지 말고 필요한 capability와 재시도
  방법을 typed error로 반환한다.

### MCP와 connector execution

- 선택된 plugin 기준계정의 catalog/connector 권한을 사용하되 OAuth secret은 model prompt,
  canonical item 또는 로그에 넣지 않는다.
- MCP tool schema를 Baton tool registry에 namespace와 provenance를 보존해 등록한다.
- 모델은 Baton dynamic tool만 호출하며 Baton broker가 approval, side-effect classification,
  timeout, cancellation, idempotency와 durable result 기록을 수행한다.
- provider native MCP/plugin call은 계속 비활성화해 canonical audit 우회를 막는다.
- 계정 전환 시 catalog diff, connector 재인증 필요와 in-flight execution fencing을 처리한다.

## 수용 기준

1. canonical Codex turn이 `openai-docs`를 읽고 helper를 permission 정책에 맞게 실행한다.
2. canonical turn이 `spreadsheets:Spreadsheets`와 runtime bridge를 발견하고 공식
   `@oai/artifact-tool`로 workbook create/render/export canary를 완료한다.
3. 최소 한 개 read-only MCP connector가 canonical tool registry에 나타나고 실제 호출/result가
   canonical items로 기록된다.
4. mutation MCP tool은 approval/permission 없이는 실행되지 않는다.
5. Claude/Codex 등 provider 변경 시 해당 provider에 허용된 skill/MCP 표면으로 재산출되며 이전
   provider credential이나 tool binding이 누출되지 않는다.
6. restart 중 unresolved mutation은 자동 재실행하지 않고 unknown/reconciliation 계약을 따른다.
7. plugin 기준계정 삭제·전환과 canonical in-flight tool execution 간 race가 revision fence로
   보호된다.
8. secret redaction, path escape, symlink escape와 tool output limit 회귀 테스트를 통과한다.

## 비목표

- Codex native plugin/MCP를 무조건 enable해 Baton broker를 우회하는 것
- 서로 다른 계정의 remote catalog와 connector 권한을 provenance 없이 합치는 것
- skill instruction만 읽고 실제 helper/tool 실행 없이 성공으로 판정하는 것

