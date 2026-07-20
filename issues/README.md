# Issues

현재 작업이 남은 이슈만 이 폴더에 둔다. 완료 조건과 검증을 모두 충족한 문서는
[`_archived/`](_archived/)로 이동한다.

## 상태 규칙

- **미해결**: 요구사항의 핵심 구현 또는 검증이 시작되지 않았거나 부족함
- **부분 해결**: 일부 구현·검증은 완료됐지만 명시된 완료 조건이 남음
- **해결됨**: 완료 조건과 필요한 회귀/live 검증을 충족함. 루트에 두지 않고 `_archived/`로 이동

## 현재 open issues

| 이슈 | 상태 |
|---|---|
| [Web Worker와 독립적인 Baton 복구 경로](baton-recovery-must-outlive-web-worker.md) | 설계 승인 · 구현 전 |
| [기존 Codex config의 resume alias 자동 복구](already-migrated-codex-config-missing-baton-compat-alias.md) | 부분 해결 |
| [Canonical 대화의 plugin skill과 MCP](canonical-conversations-must-expose-plugin-skills-and-mcp.md) | 미해결 |
| [Claude actual-429 계정 전환](claude-rotation-must-switch-on-actual-429.md) | 부분 해결 |
| [Codex model-aware failover와 plan 갱신](codex-native-proxy-must-failover-and-preserve-model-availability.md) | 부분 해결 |
| [Codex Responses WebSocket transport](codex-native-proxy-needs-responses-websocket-transport.md) | 미해결 |
| [마이그레이션된 Claude 계정 quota·중복·placeholder](migrated-claude-accounts-fail-quota-and-canary-placeholder-duplicate.md) | 부분 해결 |
| [범용 모델 fallback 후보 순회와 override 정리](model-fallback-must-exhaust-candidates-and-clear-failed-overrides.md) | 미해결 |

