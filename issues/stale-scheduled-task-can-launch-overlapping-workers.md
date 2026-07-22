# 오래된 Baton 예약 작업 정의가 live listener 위에 Worker를 중복 기동함

## 상태

- 상태: 미해결
- 발견일: 2026-07-22
- 우선순위: P0

## 증상

`baton status --json`은 `Baton-Worker-ec21331eb2dd`가 enabled/running이고 현재 4400
listener를 `expected-baton-worker`로 정확히 식별하면서도 예약 작업 정의는
`definitionMatches: false`라고 보고했다. 이 상태에서 periodic self-heal 실행이 기존 listener
위에 새 runner를 반복 기동했고, 새 Worker는 모두 다음 오류로 종료됐다.

```text
Error: listen EADDRINUSE: address already in use 127.0.0.1:4400
worker-started attempt 0
worker-exited code 1
worker-restart-scheduled (60 seconds)
...
worker-restart-exhausted attempts 4
```

같은 시간대에 session host는 startup migration에서 `database is locked`로 반복 종료·backoff했고,
프로젝트리스 QA를 수행하던 네 병렬 에이전트가 모두 다음 inference stream 오류로 종료됐다.

```text
stream disconnected before completion:
http://127.0.0.1:4400/baton/inference/openai/v1/responses
```

조사 중 예약 작업을 disable/stop/repair하지 않았고 프로덕션 DB도 변경하지 않았다. 증거는
비파괴 `baton status --json`과 `baton logs --json`에서만 수집했다.

이후 상태는 외부에서 `Enabled/Running`과 `Disabled` 사이를 반복 전환했다. 2026-07-22
04:15 UTC의 최종 비파괴 진단은 다음과 같다.

```text
task.enabled: false
task.state: Disabled
definitionMatches: false
port4400.occupied: false
GET /baton/health: connection refused
```

따라서 Baton UI, canonical session host와 provider inference endpoint가 모두 사용할 수 없는
상태가 됐다. QA 에이전트들은 어떤 lifecycle mutation도 실행하지 않았음을 각각 확인했다.

사용자가 지정한 `scripts/restart-baton.ps1`은 현재 구현상 기존 listener가 정확히 1개여야 하며,
listener 0개에서는 `Expected exactly one listener`로 거부한다. 즉 이 스크립트는 건강한 live
Worker 교체에는 쓸 수 있지만 disabled/offline Worker를 시작하는 복구 경로는 아니다.

## 원인

- 현재 registration 코드는 `MultipleInstances=IgnoreNew`를 요구하지만 설치된 task 정의가
  현재 plan과 일치하지 않는다.
- `scripts/baton-worker-runner.mjs`는 child spawn 전에 포트 4400의 existing owner를 검사하지
  않으므로 stale/overlapping supervisor가 시작되면 정상 Baton listener 위에 그대로 bind를 시도한다.
- bounded retry는 동일한 확정적 `EADDRINUSE`에도 60초 간격으로 네 번 반복된다.
- human-readable `baton status`는 `definitionMatches=false`를 경고하지 않아 JSON을 보지 않으면
  drift와 repair 필요성을 알기 어렵다.

## 영향

- live canonical turn과 provider stream이 중단되거나 연결 실패한다.
- 동일 머신에서 여러 runner/session host가 경쟁해 SQLite lock과 불필요한 restart storm을 만든다.
- self-heal이 실제 장애 복구가 아니라 건강한 listener 공격으로 바뀐다.
- 단순 QA 병렬 실행조차 서버 lifecycle 불안정 때문에 재현 불가능해진다.

## 완료 조건

- runner 시작 전에 4400 listener를 검사하고 현재 checkout의 expected Baton Worker가 건강하면
  성공 no-op으로 종료한다.
- foreign/stale owner이면 PID·command provenance를 진단하되 자동 kill하지 않는다.
- `EADDRINUSE`는 동일 listener가 유지되는 동안 재시도하지 않고 deterministic terminal event로 남긴다.
- human `baton status`도 definition drift와 안전한 `autostart repair` 안내를 명확히 표시한다.
- disabled/offline 상태에서 task mutation 없이 진단 가능한 복구 절차를 문서화하고,
  `restart-baton.ps1`이 지원하는 상태와 지원하지 않는 상태를 오류 메시지에 명시한다.
- registration upgrade 시 stale task를 감지하고 사용자 승인 경로로 최신
  `MultipleInstances=IgnoreNew` 정의로 repair한다.
- live listener가 있는 상태의 periodic trigger, 두 supervisor 경쟁, DB lock, active canonical turn을
  포함한 isolated temp dataDir E2E를 추가한다.
- 모든 lifecycle 테스트는 임시 포트·임시 dataDir·가짜 scheduler/process seam만 사용하고
  `%LOCALAPPDATA%\Baton` 프로덕션 DB나 실제 `Baton-Worker-*` task를 변경하지 않는다.
