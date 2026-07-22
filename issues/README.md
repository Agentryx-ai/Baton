# Issues

현재 작업이 남은 이슈만 이 폴더에 둔다. 완료 조건과 검증을 모두 충족한 문서는
[`_archived/`](_archived/)로 이동한다.

## 상태 규칙

- **미해결**: 요구사항의 핵심 구현 또는 검증이 시작되지 않았거나 부족함
- **부분 해결**: 일부 구현·검증은 완료됐지만 명시된 완료 조건이 남음
- **해결됨**: 완료 조건과 필요한 회귀/live 검증을 충족함. 루트에 두지 않고 `_archived/`로 이동

## 현재 open issues

`P0` → `P1` → `P2` 순으로 정렬하며, 같은 우선순위에서는 파일명 오름차순으로 정렬한다.

| 우선순위 | 이슈 | 상태 |
|---|---|---|
| P0 | [기존 Codex config의 resume alias 자동 복구](already-migrated-codex-config-missing-baton-compat-alias.md) | 부분 해결 |
| P0 | [Codex workspace command의 codex-path 상속](codex-workspace-command-must-inherit-codex-path.md) | 부분 해결 |
| P0 | [Goal continuation 중단의 in-memory 소유권 해제](goal-continuation-abort-must-release-in-memory-ownership.md) | 부분 해결 |
| P0 | [마이그레이션된 Claude 계정 quota·중복·placeholder](migrated-claude-accounts-fail-quota-and-canary-placeholder-duplicate.md) | 부분 해결 |
| P0 | [Native compact checkpoint가 있는 import 대화의 재개 차단](native-compact-checkpoint-provenance-blocks-resume.md) | 수정 중 |
| P0 | [오래된 예약 작업 정의의 live Worker 중복 기동](stale-scheduled-task-can-launch-overlapping-workers.md) | 미해결 |
| P0 | [테스트·유지보수·lifecycle의 active turn 보호](test-suite-must-not-restart-live-baton.md) | 미해결 |
| P1 | [Codex 계정 추가 trigger가 Claude 선택 wizard를 엶](account-add-wizard-ignores-provider-trigger.md) | 미해결 |
| P1 | [활성 turn에 두 번째 follow-up을 연속 enqueue할 수 없음](active-turn-second-follow-up-is-not-enqueueable.md) | 미해결 |
| P1 | [Canonical 대화의 plugin skill과 MCP](canonical-conversations-must-expose-plugin-skills-and-mcp.md) | 미해결 |
| P1 | [Claude Goal verifier의 non-strict JSON 차단](claude-goal-verifier-rejects-non-strict-json-and-blocks.md) | 미해결 |
| P1 | [Claude actual-429 계정 전환](claude-rotation-must-switch-on-actual-429.md) | 부분 해결 |
| P1 | [Codex model-aware failover와 plan 갱신](codex-native-proxy-must-failover-and-preserve-model-availability.md) | 부분 해결 |
| P1 | [복구 후 inherited Codex subagent의 previous response 유실](codex-subagent-fork-can-reference-missing-response.md) | 미해결 |
| P1 | [Low turn 전송 직후 composer effort가 High로 리셋](completed-claude-turn-resets-composer-effort-to-high.md) | 미해결 |
| P1 | [기존 Claude 대화 reload 시 composer가 Codex로 초기화](conversation-reload-resets-provider-model-to-codex.md) | 미해결 |
| P1 | [프로젝트리스 명령 증거가 Goal 진전에서 제외되어 차단](goal-completion-verifier-can-loop-and-block-after-evidence-retry.md) | 미해결 |
| P1 | [중단된 turn의 종료 원인이 대화 본문에 표시되지 않음](interrupted-turn-cause-is-hidden-in-transcript.md) | 미해결 |
| P1 | [모바일 대화 drawer의 홈·설정 navigation 실패](mobile-conversation-drawer-navigation-does-not-change-page.md) | 미해결 |
| P1 | [같은 프로젝트가 provider와 worktree에 따라 여러 그룹으로 분리](native-project-identity-splits-providers-and-worktrees.md) | 미해결 |
| P1 | [OAuth callback이 HTTPS와 state mismatch 제출을 허용](oauth-callback-validation-allows-https-and-state-mismatch.md) | 미해결 |
| P1 | [프로젝트리스 workspace 권한의 Codex capability violation](projectless-workspace-permission-crashes-codex-turn.md) | 미해결 |
| P1 | [run_command의 0이 아닌 종료 코드가 성공·완료로 표시](run-command-nonzero-exit-is-marked-success.md) | 미해결 |
| P1 | [Session host 장애를 숨기는 정상 Proxy 표시와 무한 로딩](session-host-failure-is-masked-by-healthy-proxy-status.md) | 미해결 |
| P2 | [계정 삭제 UI의 대상·경고 접근성 문맥 부재](account-deletion-controls-lack-specific-accessible-context.md) | 미해결 |
| P2 | [손상·빈 이미지 첨부의 raw backend 오류 노출](attachment-invalid-image-errors-expose-raw-backend-details.md) | 미해결 |
| P2 | [이미지 첨부 한도 초과 선택의 조용한 잘림](attachment-selection-over-limit-is-silently-truncated.md) | 미해결 |
| P2 | [Codex 엔트리먼트 refresh의 pending·중복 제출](codex-entitlement-refresh-allows-duplicate-submissions.md) | 미해결 |
| P2 | [Codex Responses WebSocket transport](codex-native-proxy-needs-responses-websocket-transport.md) | 미해결 |
| P2 | [대화 첫 진입의 전송 불가능한 빈 composer](conversation-empty-state-composer-is-dead-until-new-chat-click.md) | 미해결 |
| P2 | [휴지통 이동·복원 뒤 session URL과 새 대화 본문 불일치](conversation-trash-restore-leaves-session-url-on-new-draft.md) | 미해결 |
| P2 | [휴지통 목록 reload 시 active 대화로 초기화](conversation-trash-scope-resets-to-active-on-reload.md) | 미해결 |
| P2 | [대시보드 로딩이 Proxy 정지·계정 0개로 표시](dashboard-loading-state-looks-stopped-and-empty.md) | 미해결 |
| P2 | [다른 session 선택 뒤 Back이 미전송 draft를 건너뜀](draft-session-navigation-back-skips-unsent-draft.md) | 미해결 |
| P2 | [Goal 완료 evidence reference 스키마 불일치](goal-completion-evidence-reference-schema-mismatch.md) | 미해결 |
| P2 | [Goal 생성 요청 중 composer와 전송 버튼이 계속 활성](goal-create-keeps-enabled-composer-during-request.md) | 미해결 |
| P2 | [Controlled dialog close 뒤 focus 복원 실패](mobile-conversation-drawer-does-not-restore-focus.md) | 미해결 |
| P2 | [범용 모델 fallback 후보 순회와 override 정리](model-fallback-must-exhaust-candidates-and-clear-failed-overrides.md) | 미해결 |
| P2 | [Native import 전체 선택이 non-importable 기록까지 집계](native-import-bulk-selection-counts-nonimportable-records.md) | 미해결 |
| P2 | [Native import 상태 전환 뒤 stale accessible name](native-import-dialog-accessible-names-stay-stale.md) | 미해결 |
| P2 | [권한 RadioGroup의 로드 후 제어 모드 전환](permission-radio-group-switches-control-mode-after-load.md) | 미해결 |
| P2 | [플러그인 기준계정 preview의 이름·live announcement 부재](plugin-reference-preview-is-not-labeled-or-announced.md) | 미해결 |
| P2 | [읽기 전용 run_command도 중단 시 unknown mutation으로 오인](read-only-run-command-is-reconciled-as-unknown-mutation.md) | 미해결 |

