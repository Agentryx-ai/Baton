# Session host 장애가 정상 Proxy 상태 뒤에 가려지고 대화 UI가 무한 로딩됨

## 상태

- 상태: 미해결
- 발견일: 2026-07-22
- 우선순위: P1

## 증상

Baton 홈은 `Proxy :4400 · 정상`, 활성 계정 `2/5`, Codex·Claude 계정과 quota를 정상
표시했지만, 대화 화면의 최근 대화와 모델 catalog는 여러 분 동안 `불러오는 중…`에서
멈췄다. 새 프로젝트리스 draft의 모델 combobox와 전송 버튼은 계속 disabled였고 UI
`새로고침`으로도 회복되지 않았다.

서로 독립된 세 브라우저 QA에서 같은 현상이 동시에 재현됐다.

- provider/model matrix: 최근 대화·모델이 4초 이상 로딩 고정, 요청 전송 불가
- follow-up queue: 대화 목록·모델 로딩 고정, active turn 생성 불가
- attachment format matrix: PNG chooser는 열리지만 upload가 완료되지 않고 preview 없음

같은 시각 비파괴 `baton logs --json`에는 다음 session host 오류와 backoff가 반복됐다.

```text
session host worker error: Error: database is locked
at SqliteSessionStore.#migrate (...sqlite-store.ts:337)
session host exited (code 1); restarting in 250ms
...
session host exited (code 1); restarting in 30000ms
```

그런데 `baton status --json`의 runtime은 `proxy.running: true`, warning 빈 배열을 반환해
canonical session host가 unavailable/degraded라는 사실을 전혀 노출하지 않았다.

## 원인

- `server/index.ts`의 `/baton/health`는 이미 `sessionHost.snapshot()`을 포함하지만,
  `server/baton-status.ts`의 `/baton/status` schema와 UI `BatonRuntimeStatus`에는 session host
  필드가 없다. 홈과 CLI status는 후자만 사용한다.
- session host middleware는 worker가 ready가 아니면 각 `/baton/v1` request를 최대 20초
  대기시킨 뒤 503을 반환한다. 여러 초기 request가 겹치면 화면 전체가 오래 멈춘 것처럼 보인다.
- `refreshModels()`는 terminal error 뒤 catalog를 빈 배열로 바꾸고 오류 문자열을 저장하지만,
  model 값이 비어 있으면 combobox option은 계속 `모델 불러오는 중…`을 렌더한다. 실패 상태와
  로딩 상태가 select 자체에서는 구분되지 않는다.
- 대화 목록도 request 종료 전까지 `sessions === null`과 `loadingSessions`를 유지하므로 proxy
  상태와 모순되는 spinner가 장시간 노출된다.

## 영향

- 사용자는 Baton 전체가 정상이라고 믿지만 대화 생성·재개·모델 선택·첨부를 사용할 수 없다.
- 무한 spinner만 보여 장애 원인, 자동 복구 여부, 안전한 재시도 시점을 알 수 없다.
- provider proxy health와 canonical conversation health가 혼동되어 QA와 운영 진단이 지연된다.
- 여러 UI client가 같은 실패 요청을 반복해 장애 구간의 부하를 늘릴 수 있다.

## 완료 조건

- `/baton/status`, CLI status와 홈 UI가 session host의 `healthy/degraded/unavailable`, 마지막
  오류 코드, 재시도 시각을 별도 표시한다.
- proxy가 건강해도 session host가 실패하면 Baton 전체를 단순 `정상`으로 표시하지 않는다.
- 대화 목록·모델·첨부 request는 bounded timeout 뒤 actionable error와 재시도 버튼을 보이고
  무한 spinner에 머물지 않는다.
- 모델 catalog가 terminal 실패하면 combobox를 `불러오기 실패` 또는 `사용 불가`로 전환하고
  `모델 불러오는 중…` 문구를 유지하지 않는다.
- transient SQLite busy는 startup migration에서 bounded busy timeout/retry를 적용하고, 장기 lock은
  worker 전체 restart와 분리된 degraded 상태로 진단한다.
- locked temp SQLite DB와 임시 dataDir를 사용한 isolated E2E로 홈 상태, 대화 오류 UI,
  session host recovery를 검증한다.
- 테스트와 진단은 `%LOCALAPPDATA%\Baton` 프로덕션 DB를 직접 열거나 변경하지 않는다.
