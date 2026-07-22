# OAuth callback validation이 HTTPS와 state mismatch 제출을 허용함

## 상태

- 상태: 미해결
- 발견일: 2026-07-22
- 우선순위: P1

## 증상

Claude와 Codex account wizard의 callback URL 검증은 올바른 localhost port, code, state 유무는
확인하지만 URL scheme을 검증하지 않는다. 실제 loopback redirect와 다른
`https://localhost:<port>`도 경고 없이 `완료` button을 활성화한다.

현재 OAuth attempt와 다른 `state`를 입력한 경우에는 다른 인증 session일 수 있다는 경고를
표시하면서도 validation 결과를 성공으로 처리해 `완료`를 활성화한다. 사용자가 경고를 놓치면
다른 attempt의 authorization response를 현재 wizard에 제출할 수 있다.

## 재현

Claude와 Codex 각각 별도 OAuth attempt를 시작하고 credential 입력 없이 callback 입력만 검수했다.

```text
빈 값: disabled, 문구 없음
not-a-url: disabled, 올바른 URL 형식이 아닙니다.
잘못된 host: disabled, localhost:<provider port> 안내
code 누락: disabled, code 파라미터 안내
https://localhost:<correct port> + code/state: 경고 없음, 완료 enabled
state mismatch: warning 표시, 완료 enabled
올바른 형식 + 가짜 code: client validation enabled, 제출하지 않음
```

Claude port는 54545, Codex port는 1455에서 같은 결과를 재현했다. `완료`는 한 번도 누르지
않았고 각 attempt는 `다시 시작`으로 취소했으며 외부 로그인 탭도 닫았다. 최종 계정은
Claude 2, Codex 3, 활성 2/5로 변하지 않았고 무료기간·자동결제 문구도 없었다.

## 원인

- `validateCallback()`은 hostname과 port만 검사하고 `url.protocol === 'http:'` 조건이 없다.
- state mismatch 분기는 의도적으로 `{ ok: true, warn: ... }`를 반환해 submit을 허용한다.

## 영향

- 현재 attempt와 결합되지 않은 callback을 사용자가 제출할 수 있다.
- 잘못된 scheme URL이 형식상 정상으로 보이며 server 오류나 혼란스러운 재인증을 유발한다.
- OAuth CSRF/session binding의 핵심 신호인 state mismatch를 blocking error로 취급하지 않는다.

## 완료 조건

- provider가 발급한 정확한 loopback scheme·host·port·path 계약을 검증한다.
- state가 없거나 현재 attempt와 다르면 submit을 차단하고 새 callback을 요구한다.
- server도 callback의 state를 authoritative하게 검증하며 mismatch를 소비하거나 계정을 만들지 않는다.
- Claude/Codex의 scheme, host, port, code, state negative matrix E2E가 통과한다.

