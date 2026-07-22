# run_command의 0이 아닌 종료 코드가 성공·완료로 표시됨

## 상태

- 상태: 미해결
- 발견일: 2026-07-22
- 우선순위: P1

## 증상

프로젝트리스 canonical Claude 대화에서 `run_command`가 `exitCode: 1`과 stderr를
반환했는데도 portable tool result는 `success: true`, UI 카드는 `명령 · 완료`로 표시됐다.

2026-07-22 Windows에서 Claude가 다음 형태의 명령 세 개를 병렬 호출해 재현했다.

```text
argv: ["bash", "-c", "..."]
exitCode: 1
stderr: WSL ... execvpe(/bin/bash) failed: No such file or directory
stdout: ""
success: true
UI: 명령 · 완료
```

Claude는 세 명령을 실제 서브에이전트 실행으로 잘못 해석하고, 최종 응답에
`3개 완료`, `실패한 도구 없음`이라고 보고했다. 요청한 성공 문자열 중 하나도
최종 응답에서 누락했다.

## 영향

- 명령 실패가 성공 증거로 오염되어 후속 판단과 Goal completion evidence가 틀릴 수 있다.
- 사용자는 접힌 tool card 제목만 보고 실패를 알아차릴 수 없다.
- 모델이 stderr와 exit code보다 wrapper의 `success: true`를 신뢰해 허위 성공 보고를 만든다.
- 병렬 실행에서는 여러 실패가 한꺼번에 성공으로 오인될 수 있다.

## 원인

- command runner는 프로세스 spawn 실패만 예외로 처리하고 close의 종료 코드는 output으로 반환한다.
- host/workspace runtime은 timeout이 아니면 0이 아닌 종료 코드도 무조건 successful tool result로 감싼다.
- Claude adapter와 UI는 이 wrapper의 `success`만 보고 각각 `is_error`와 카드 상태를 정한다.
- Goal verifier도 같은 값을 authoritative tool evidence 판정에 사용한다.

따라서 “프로세스를 실행함”과 “명령이 성공함”이 하나의 `success` 의미로 섞여 있다.

## 완료 조건

- `exitCode === 0 && !timedOut`인 경우만 명령 성공으로 판정한다.
- 0이 아닌 종료 코드와 비정상 `exitCode: null`은 tool result `success: false`로 정규화한다.
- UI 카드는 `명령 · 실패`로 표시하고 exit code와 stderr 요약을 접기 전에도 보여준다.
- Claude 실패 payload에도 bounded stdout/stderr와 exit code를 보존한다.
- timeout, 실행 파일 없음, non-zero exit, stderr-only, 정상 exit 0을 각각 회귀 테스트한다.
- Goal evidence와 모델 후속 턴이 실패한 명령을 성공 evidence로 사용할 수 없게 한다.
- Codex와 Claude 프로젝트리스·workspace runtime에서 동일한 결과 의미론을 유지한다.
