# Baton Native Claude Proxy 완료 감사

> 감사일: 2026-07-20 (Asia/Seoul)
> 판정 원칙: 합성 테스트와 실제 계정 검증을 구분하며, 사용자 승인이 필요한 live gate는 완료로 추정하지 않는다.

## 요구사항별 현재 판정

| 요구사항 | 권위 있는 증거 | 판정 |
|---|---|---|
| CLIProxy library/source/process 없이 Claude 전송 | `claude-native-dependency.test.ts`; Native core 정적 경계; `package.json` dependency 감사; 실제 Claude Code 2.1.215 Native 요청 | 완료 |
| Anthropic JSON/SSE/status/header 보존 | fake upstream byte-order, header, refusal, 401/403/429/5xx, disconnect, backpressure, stream deadline 테스트 | 완료 |
| 모델별 429와 계정 429 구분 | usage preflight 구조화 응답; 실제 Fable 5 `Hi`가 비용 0·107ms·구체적 모델 한도 429 | 완료 |
| 다중 OAuth 계정 보안 저장 | Windows DPAPI CurrentUser, atomic versioned vault, token redaction, restart/replay/expiry/cancel 테스트 | 구현 완료; 실제 두 번째 계정 로그인 대기 |
| 동일 모델 account failover | priority/model eligibility/cooldown/deadline/429/5xx/network matrix 및 응답 cleanup 테스트 | 합성 검증 완료; 실제 두 계정 canary 대기 |
| 우선계정 선택 | atomic `prefer` vault mutation, Native API/UI, restart persistence, lowest-priority router 테스트 | 완료 |
| 범용 모델 fallback | server capability → user mapping → compatibility seed resolver; 임의 모델 조합 테스트 | 완료 |
| 비용 동의 및 원 모델 우선 | 기본 OFF; 전 계정 원 모델 소진 전 fallback 금지; OFF 비용 0 테스트 | 완료 |
| Fable 5 → Opus 4.8 및 복귀 | runtime override, reset hint, 60초 bounded probe, 조기 reset, restart persistence | 합성 검증 완료; 실제 Opus 1회 canary 대기 |
| safety refusal fallback | 구조화 refusal/event만 판정; provider `fallbacks` protocol에 1회 위임; SSE 무변형 event 관측 | 합성 검증 완료; live safety event는 재현하지 않음 |
| 사용자 가시성 | 상단 opt-in prompt, 다시 보지 않기, 활성 banner, 끄기, preferred/effective/account alias, event timeline | 구현·build 완료; Browser 플러그인 누락으로 시각/키보드 검수 대기 |
| 재시작/오염 상태 | vault 및 fallback state restart, corrupt-state fail-closed 테스트 | 완료 |
| 전체 회귀 | `npm test` 512개, typecheck, lint, production build, `git diff --check` | 통과 (기존 Fast Refresh/번들 크기 경고만 존재) |

## CLIProxy 잔여 표면의 정확한 범위

Native Claude core 구현 파일은 CLIProxy management API, process, port, config 또는 library를 참조하지
않는다. 다음 CLIProxy 표면은 Native core 의존이 아니라 명시적 legacy/rollback 및 다른 provider 지원이다.

- `server/client-integration.ts`: 사용자가 `cliproxy` rollback 모드를 명시적으로 선택할 때만 Claude
  설정을 해당 연결로 패치한다.
- `src/api/client.ts`: 적용된 client mode를 읽고 Claude Native이면 `/baton/claude-native/**`만 사용한다.
  legacy Claude 또는 다른 provider이면 기존 `/api/cliproxy/**` 계약을 유지한다.
- proxy status/restart, routing strategy/session affinity 설정은 CLIProxy 관리 기능으로 명시되어 있으며
  Native Claude account priority와 혼동되지 않도록 UI에서 `CLIProxy`로 표시한다.
- `/api/*` BFF passthrough는 다른 provider와 legacy 관리 UI를 위해 남아 있으며 Native Claude inference
  성공 조건이 아니다.

따라서 CLIProxy를 설치하거나 실행하지 않아도 Native Claude data/control plane은 동작한다. 다만 최종
rollback 선택지 삭제는 실제 두 계정·유료 fallback·장기 client canary 이후 별도 승인 gate로 유지한다.

## 완료를 막는 외부 gate

1. 사용자가 두 번째 Claude 계정 OAuth 로그인/동의를 완료해야 실제 same-request account failover를 검증할 수 있다.
2. 사용자가 Opus 사용량 1회 소비를 승인해야 실제 Fable → Opus 전환과 banner/복귀 canary를 실행할 수 있다.
3. 설치된 Browser 플러그인의 `docs/browser-safety.md` 누락이 복구되어야 UI 시각·키보드 검수를 실행할 수 있다.

이 세 항목 전에는 전체 roadmap/active goal을 완료로 선언하지 않는다. 제품 전용 에뮬레이터 기능은
후속 변경에서 canonical core로부터 제거되었다.
