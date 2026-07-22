# Pre-b813d7c migrated Codex configs lack the baton compat alias → legacy `codex resume` fails

## 상태

- 상태: **부분 해결**
- 발견일: 2026-07-21
- 우선순위: P0
- 신규 apply/repair 경로는 구현됨
- 기존 마이그레이션 사용자에 대한 자동 detect-and-heal 또는 명시적 repair UX는 미완료

## 증상

마이그레이션 이전 `model_provider = "baton"`(CLIProxy custom-provider)로 생성된 Codex 세션을
`codex resume <id>` 하면 실패:

```
Error: ... thread/resume failed: failed to load configuration:
Model provider `baton` not found (code -32600)
```

## 원인

초기 Native 전환 커밋(`38ded4b`)의 `patchCodexNativeConfig`는 `~/.codex/config.toml`에서
`[model_providers.baton]` 테이블과 `model_provider = "baton"` 루트 키를 **제거**하고 built-in
`openai` + `openai_base_url`로 바꿨습니다. Codex는 세션 생성 시점의 provider를 기록하므로,
마이그레이션 전 세션은 존재하지 않는 `baton` provider를 찾다가 config 로드에 실패합니다.

## 현재 상태 (부분 해결)

- 후속 커밋 `b813d7c fix(codex): complete native plugin and resume compatibility`에서
  codegen에 **managed baton compat provider**(`managedBatonCompatProviderLines`,
  `isManagedBatonCompatProvider`, `server/client-integration.ts`)가 추가됨.
  → **앞으로 client-integration을 적용하는** 사용자는 config에 Baton 소유 `baton` alias가
  자동 포함되어 legacy resume이 동작함.
- **남은 갭**: `b813d7c` **이전에 이미 마이그레이션된** 사용자(예: 이 환경의
  `~/.codex/config.toml`)는 alias가 없어 resume이 여전히 실패함. 자동 복구 경로 없음.

임시 우회(이 환경에 수동 적용됨, `config.toml.bak-baton-provider-restore` 백업 존재):

```toml
[model_providers.baton]
name = "Baton Native"
base_url = "http://127.0.0.1:4400/baton/inference/openai/v1"
wire_api = "responses"
env_key = "BATON_PROXY_TOKEN"
```

주의: 위 수동 블록이 `isManagedBatonCompatProvider`가 기대하는 "managed" 포맷과 정확히
일치하는지 확인 필요. 불일치 시 다음 client-integration 적용에서 conflict(409)로 처리될 수 있음.

## 제안 수정 (미적용)

1. 서버 기동 또는 client-integration 조회 시 **기존 config를 감지해 compat alias가 없으면
   자동 삽입(detect-and-heal)**, 또는 명시적 repair 명령/버튼 제공.
2. 수동 우회 블록을 managed 포맷으로 정규화하는 마이그레이션 처리(idempotent).
3. 문서화: 마이그레이션 후 legacy 세션 resume 절차 안내(초기 마이그레이션이 삭제한 README
   "Codex 세션 재개 시 provider 복원" 섹션 대체).

## 검증

- 마이그레이션 전 세션 id로 `codex resume` 성공.
- alias 존재 시 client-integration 적용이 conflict 없이 idempotent.
