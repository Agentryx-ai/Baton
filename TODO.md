# Baton TODO

완료 판정은 합성 테스트, local/live canary, 외부 계정 조건을 구분합니다.

## P0 — Native 단일 코어 전환 마무리

- [x] Claude/Codex OAuth를 Baton Native vault로 무재로그인 이전
- [x] canonical runtime, account/quota API와 UI를 Baton Native 경로로 전환
- [x] 외부 gateway session, inference bridge, proxy mode 선택과 관리 API 제거
- [x] Codex plugin catalog를 동일 Native OAuth의 `chatgptAuthTokens`로 인증
- [ ] 실행 중인 Codex CLI/Desktop을 사용자가 종료한 뒤 `~/.codex/config.toml`을
      built-in `openai` + Baton `openai_base_url`로 원자적 이전
- [ ] 이전 직후 기존 Codex session 목록/재개와 Native 모델 200 응답 재검증
- [ ] 원본 OAuth backup을 보존한 채 legacy proxy 컨테이너를 중지하고 포트 의존성 부재 확인

## P1 — 외부 조건이 필요한 검수

- [ ] Claude 2계정에서 동일 요청 429 failover와 우선순위 검증
- [ ] Codex 2계정에서 model-aware failover 검증
- [ ] Codex free→pro 결제 변경 후 재로그인 없는 claim/catalog 갱신 검증
- [ ] Claude/Codex 24시간 canary와 설정 rollback 검증

## P2 — 제품 기능

- [ ] WorkSet/WorkGraph scheduler, child execution API, acceptance receipt 구현
- [ ] Built-in browser의 durable navigation/action/result 계약 구현
- [ ] Computer Use screenshot→approval→action→result loop 구현
- [ ] 범용 모델 fallback 다중 후보 순회와 실패 override 정리
- [ ] Native priority-failover 외 선택적 부하분산 정책 설계
