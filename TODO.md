# Baton TODO

완료 판정은 합성 테스트, local/live canary, 외부 계정 조건을 구분합니다.

## P0 — Native 단일 코어 전환 마무리

- [x] Claude/Codex OAuth를 Baton Native vault로 무재로그인 이전
- [x] canonical runtime, account/quota API와 UI를 Baton Native 경로로 전환
- [x] 외부 gateway session, inference bridge, proxy mode 선택과 관리 API 제거
- [x] Codex plugin catalog를 동일 Native OAuth의 `chatgptAuthTokens`로 인증
- [x] 실행 중인 Codex CLI/Desktop을 사용자가 종료한 뒤 `~/.codex/config.toml`을
      built-in `openai` + Baton `openai_base_url`로 원자적 이전
- [x] 기존 `model_provider=baton` session resume용 Native compatibility alias를 보존하고
      Native 모델 200 응답 재검증
- [x] 원본 OAuth Docker volume backup을 보존한 채 legacy proxy 컨테이너를 제거하고
      기존 3000/8317 포트 의존성 부재 확인

## P1 — 외부 조건이 필요한 검수

- [ ] Claude 2계정에서 동일 요청 429 failover와 우선순위 검증
- [ ] Codex 2계정에서 model-aware failover 검증
- [ ] Codex free→pro 결제 변경 후 재로그인 없는 claim/catalog 갱신 검증
- [ ] Claude/Codex 24시간 canary와 설정 rollback 검증

## P2 — 제품 기능

- [ ] WorkSet/WorkGraph scheduler, child execution API, acceptance receipt 구현
- [ ] Canonical 대화에 provider/plugin skill discovery와 Baton-owned MCP execution 연결
      (`issues/canonical-conversations-must-expose-plugin-skills-and-mcp.md`)
- [ ] Built-in browser의 durable navigation/action/result 계약 구현
- [ ] Computer Use screenshot→approval→action→result loop 구현
- [ ] 범용 모델 fallback 다중 후보 순회와 실패 override 정리
- [ ] Native priority-failover 외 선택적 부하분산 정책 설계
- [ ] Codex Responses WebSocket transport를 구현해 HTTP fallback 시작 지연 제거

## 마이그레이션 회귀 후속 (2026-07-21 발견)

- [ ] 마이그레이션된 Claude credential이 quota 500으로 실패하는 원인 확증
      (refresh `invalid_grant` 추정) 및 quota 라우트에서 refresh 실패를 표면화
      → issues/migrated-claude-accounts-fail-quota-and-canary-placeholder-duplicate.md
- [ ] 같은 Anthropic 계정의 Native vault 중복 정리 + 마이그레이션 매칭을 불변 account id로 수행
- [ ] Claude 계정 email 미기입 시 placeholder(`Claude Code`) 대신 재로그인 유도/식별 라벨 표시
- [ ] b813d7c 이전에 마이그레이션된 `~/.codex/config.toml`에 baton compat alias가 없는 경우
      자동 복구(detect-and-heal) 또는 repair 명령 제공
      → issues/already-migrated-codex-config-missing-baton-compat-alias.md
