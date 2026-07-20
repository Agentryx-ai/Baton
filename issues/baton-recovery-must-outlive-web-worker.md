# Baton 복구 경로는 Web Worker와 함께 죽으면 안 된다

상태: **P0·P1 구현 및 독립 적대적 검수 승인 · P2 구현 전**
우선순위: **P0 → P2 순차 구현**

## 문제

현재 `server/index.ts` 한 프로세스가 다음을 함께 소유한다.

- `127.0.0.1:4400`의 Claude/Codex Native proxy
- Baton SPA
- `/baton/client-integration/*` 적용·해제 API

`scripts/baton-cli.mjs`도 살아 있는 `/baton/status`만 호출한다. 따라서 이 프로세스가 멈추면
웹에서 설정을 해제할 수 없고 CLI도 복구 수단이 되지 않는다. 현재 `.baton-*.bak` 파일은 한 번의
다중 파일 변경을 되돌리기 위한 임시 파일이며, 성공 시 삭제되므로 사후 복구 근거가 아니다.

## 목표와 범위

최소 목표는 **Baton Web Worker가 실행되지 않아도 사용자가 Claude/Codex의 Baton 연결 상태를
검사하고 안전하게 해제할 수 있게 하는 것**이다. 이후 단계는 복구 UX와 자동 재기동을 개선하되,
복구 계층에 OAuth, 모델 라우팅 또는 일반 Baton 기능을 복제하지 않는다.

이 문서에서 `Worker`는 현재 Express/SPA/Native proxy 프로세스를 뜻한다.

## 설계 원칙

1. 오프라인 복구는 `localhost:4400`에 요청하지 않는다.
2. 복구는 receipt로 Baton 소유권이 증명되는 설정만 바꾼다. 불확실하면 쓰지 않고 충돌을 보고한다.
3. 적용과 복구는 같은 parser·소유권 판정·원자적 파일 교체 코드를 사용한다.
4. 프로세스 종료, 재시작 및 다른 프로세스의 포트 탈취를 추측으로 수행하지 않는다.
5. 자동 upstream 우회와 장애 직후 자동 설정 해제는 기본 동작에 포함하지 않는다.
6. P0, P1, P2는 각각 구현·검수·병합한 뒤 다음 단계로 진행한다.

## P0 — 서버 없는 설정 해제

P0가 이 이슈의 필수 안전 기능이다.

### 구현

- `client-integration.ts`에서 설정 검사·변환·원자적 교체를 서버 route와 무관하고 import 시
  OAuth/server runtime을 초기화하지 않는 모듈로 분리한다.
- 연동 적용 성공 시 `%LOCALAPPDATA%\Baton` 아래에 versioned integration receipt를 원자적으로
  기록한다.
- receipt에는 schema/installation/transaction ID, 대상, 설정 경로와 존재 여부, 적용 전/후 해시,
  Baton 소유 필드, 적용값 digest, 적용 endpoint와 상태를 기록한다.
- exact byte 복원을 위해 원본을 보관할 경우 receipt payload 전체를 Windows CurrentUser DPAPI로
  보호한다. 적용된 token은 평문으로 중복 저장하지 않고 digest로 비교하며 로그와 CLI 출력에는
  원본이나 token을 노출하지 않는다.
- `baton integration status`, `baton integration remove [--target ...]`,
  `baton integration adopt-existing`과 `baton doctor`를 구현한다. 이 명령은 Worker가 없을 때도 로컬
  파일과 receipt만으로 실행되며 네트워크 요청을 하지 않는다.
- 대상별 transaction은 `PREPARED → APPLIED → REMOVED`로 관리한다. 여러 대상을 하나의 전역
  transaction으로 묶지 않고 결과를 대상별로 보고한다.
- 프로세스 간 exclusive lock과 파일 교체 직전 SHA-256 CAS를 사용한다. 잠금 파일의 age만 보고
  임의 삭제하지 않는다.
- 정확한 적용 후 해시가 일치하면 원래 값을 복원한다. 무관한 사용자 변경만 있으면 일반 3-way
  merge가 아니라 receipt에 기록된 Baton 소유 필드만 원래 값으로 복구하고 나머지는 보존한다.
  Baton 소유 값이 바뀌었거나 receipt가 손상됐으면 fail closed 한다.
- 기존 관련 필드가 있거나 현재 코드에서 `conflict`로 분류되는 상태는 기본 apply가 덮어쓰지 않는다.
  기존 receipt 없는 exact Baton 설치는 `adopt-existing`의 preview와 명시적 확인으로만 채택한다.
  이때 적용 전 값을 알 수 없음을 표시하며 불명확·부분 적용 상태에서는 receipt를 만들지 않는다.
  복원할 원래 값을 추측하거나 시작 시 자동 채택하지 않는다.
- 기존 웹 mutation API도 같은 core와 lock/CAS를 사용하고 loopback client capability 및 엄격한
  `Host`/`Origin` 검증으로 cross-origin 요청을 거부한다.

### P0 수용 기준

- `:4400` listener가 없는 상태에서 Codex, Claude CLI, Claude Desktop 각각의 상태 확인과 해제가
  테스트된다.
- 복구 명령의 네트워크 호출은 0건이고 Worker/OAuth/model catalog module을 초기화하지 않는다.
- 적용 후 Worker를 종료해도 원래 설정이 복원된다.
- 적용 중 또는 receipt 기록 중 강제 종료 후 다음 실행이 확정된 상태를 판별하고 안전하게
  완료하거나 되돌린다.
- unrelated 사용자 변경은 보존되고 Baton 소유 값 변경은 충돌 처리된다.
- 기존 관련 provider/gateway 필드는 기본 apply에서 덮어쓰지 않는다.
- 설정 파일 잠금, 잘못된 JSON/TOML, 손상·누락 receipt, 일부 대상만 변경된 경우가 테스트된다.
- UI/CLI 동시 변경에서는 하나만 lock/CAS를 통과하며 cross-origin 웹 mutation은 거부된다.
- 기존 `client-integration` API는 같은 core를 사용하며 기존 apply/remove 테스트가 통과한다.

## P1 — 사용자 동의 기반 자동 재기동

P1은 일시적 Worker 종료를 줄이되 복구 기능 자체는 P0 CLI에 둔다.

### 구현

- 사용자 동의를 받은 경우에만 Windows 사용자 단위 로그인 시작을 등록한다.
- Task Scheduler의 제한된 실패 재시작 정책은 best-effort 안전망으로 설정하되 정상 Worker 복구는
  여기에 의존하지 않으며, 반복 실패 시 무한 재시작하지 않는다.
- 등록·해제·상태 확인·repair와 최근 Worker 종료/로그 진단을 CLI로 제공한다.
- CurrentUser DPAPI와 사용자 프로필 설정을 사용하므로 LocalSystem 서비스로 실행하지 않는다.
- 다른 프로세스가 `:4400`을 점유하면 종료하거나 포트를 탈취하지 않고 진단한다.
- Worker 장애 또는 재시작은 Claude/Codex 설정을 자동 변경하지 않는다.

### P1 수용 기준

- 새 사용자 로그인과 Worker 비정상 종료 후 정책에 따라 Worker가 다시 시작된다.
- 반복 startup crash 시 재시작 한도를 지키며 진단 가능한 상태를 남긴다.
- 자동 시작은 사용자 승인 없이 등록되지 않으며 해제 시 integration 설정을 바꾸지 않는다.
- 자동 시작이 실패하거나 등록이 손상돼도 P0 오프라인 CLI가 동작한다.
- 설치 경로에 공백이 있고 사용자 권한만 있는 환경에서 동작한다.

### P1 구현 및 검증 기록

2026-07-21에 P1을 별도 Supervisor가 아닌 **Task Scheduler action의 bounded lifecycle
wrapper**로 구현했다. 이 wrapper는 `:4400` front-door, recovery web 또는 별도 상주 control plane이
아니다.

- `baton autostart install --confirm|status|repair|uninstall`과
  `baton start|stop|restart|status|doctor|logs`를 추가했다. 등록은 명시적 opt-in만 허용하고
  CurrentUser의 `Interactive`/`Limited` 로그인 trigger만 사용한다. LocalSystem·LocalService·
  NetworkService SID와 실행 사용자가 계획된 CurrentUser와 다른 경우 mutation을 거부한다.
- Task 정의는 고정 TaskPath와 installation별 이름·Description, 정확히 하나의 action과 사용자
  AtLogOn trigger, principal, working directory, `IgnoreNew`, `StartWhenAvailable`, 무제한 execution
  time, 배터리 정책, restart 횟수·간격을 모두 검사한다. start를 포함한 정상 lifecycle mutation은
  ownership과 전체 definition이 모두 일치해야 한다. repair는 손상된 definition을 고치는 명령이므로
  고정 path·description·CurrentUser 소유권을 두 번 확인한 뒤에만 교체한다.
- install은 단일 PowerShell 호출 안에서 기존 Task를 검사하고 `-Force` 없는 register를 사용한다.
  따라서 검사 뒤 같은 이름의 foreign Task가 먼저 등록되면 덮어쓰지 않고 실패한다. stop,
  uninstall, repair도 같은 호출 안에서 mutation 직전 재검사한다.
- Task Scheduler API에는 파일 CAS와 같은 조건부 update/delete가 없다. 따라서 재검사 직후와
  `Disable/Unregister/Start` 사이에 동일 TaskPath·TaskName을 비협조 프로세스가 바꾸는 극단적
  경합까지 원자적으로 배제할 수는 없다. repair는 unregister 직전 재검사 후 no-force register를
  사용해 창을 최소화하며, foreign Task가 register를 선점하면 덮어쓰지 않는다. 이보다 강한 보장은
  Windows가 조건부 Task mutation primitive를 제공해야 한다.
- `:4400` listener의 PID뿐 아니라 `ExecutablePath`와 `CommandLine`을 계획된 Node executable,
  checkout 및 `server/index.ts`와 대조한다. foreign owner는 진단만 하고 시작·종료하지 않는다.
  이미 Running인 Task도 definition과 port owner 검사를 마친 뒤에만 no-op 처리한다.
- runner는 Worker stdout/stderr를 CurrentUser 전용 ACL과 mode의 1 MiB bounded rotating log에
  redaction하여 기록한다. signal을 소유 child에 전달하고 child settlement를 기다리며, 로그 쓰기
  실패 시 자신이 만든 child tree만 종료한다. 임의 port owner는 종료하지 않는다.
- `baton doctor`는 Scheduler 조회 실패를 lifecycle `unavailable`로 포함하되 P0 진단 결과와 exit
  의미를 보존한다. `baton status`는 Worker가 없을 때 lifecycle을 출력하면서도 기존처럼 nonzero로
  종료한다. Worker/Task 장애는 integration 설정을 변경하지 않는다.

#### 실제 Windows 관측

실제 Windows에서 Task Scheduler의 `RestartCount=3`, `RestartInterval=PT1M` 정의는 확인됐지만,
수동 시작한 Exec action이 exit code 9로 끝난 경우 235초 동안 Scheduler가 action을 다시 실행하지
않았다. 따라서 이 설정만으로 **Worker** 재기동을 보장한다고 주장하지 않는다.

Worker 종료는 lifecycle runner가 60초 간격으로 초기 실행과 최대 3회의 재시도를 직접 수행한다.
네 번째 실패 후 `worker-restart-exhausted`를 남기고 runner는 정상 종료하여 Scheduler 정책과의
곱연산 재시도를 막는다. Scheduler restart 설정은 runner 자체가 비정상 crash하거나 action 시작에
실패하는 경우를 위한 **best-effort 설정**일 뿐이며, Baton의 정상 복구 계약이나 수용 판정은 이에
의존하지 않는다.

UUID 격리 Task와 harmless fixture로 다음을 실제 관측했다.

- 공백 경로, CurrentUser/Interactive/Limited, 전체 definition match와 등록 후 cleanup
- Worker 실패 시 정확히 4회 실행 후 exhaustion, 다섯 번째 실행 없음
- 명시적 stop 후 Task disabled, 현재 child 종료, 여러 test retry interval 이후 재실행 없음
- 모든 `Baton-P1-Isolated-*` Task와 fixture 정리 후 잔존 0

단위 검증은 service account 거부, opt-in, idempotency, name collision, repair, mutation 내부 재검사,
foreign port, doctor fail-soft, runtime unavailable exit, 로그 rotation/redaction, logging failure cleanup과
bounded retry를 포함한다. P2 standalone packaging은 이 단계에서 구현하지 않았다.

독립 검수는 네 차례 진행됐다. 변조 Task 실행과 foreign Task mutation, 정의 검증 누락, P0 doctor
결합, Worker 로그 폐기, secret redaction 우회와 로그 상한 해제를 차례로 반례화해 수정을 요구했다.
최종 검수는 ownership/full-definition/no-force mutation, SID guard, port no-kill, bounded retry와
explicit stop, child settlement, 1 MiB rotation, 64 KiB CLI tail, JSON·query·chunk-boundary redaction,
unavailable exit 의미와 P0 독립성을 다시 확인한 뒤 새 승인 차단 finding 없이 P1을 승인했다.

## P2 — 복구 도구의 배포 독립성

P2는 checkout, `node_modules`, 시스템 Node가 손상된 경우에도 P0 복구를 유지한다.

### 구현

- P0 recovery core와 CLI를 Worker release와 분리된 bootstrap artifact로 패키징한다.
- Worker와 bootstrap이 서로 다른 parser를 구현하지 않도록 동일 core를 bundle한다.
- `%LOCALAPPDATA%\Baton\bootstrap`의 고정 위치에 설치하고 P1 자동 시작도 checkout의
  `npm start`가 아닌 설치된 launcher를 사용한다.
- 새 bootstrap을 검증해 설치하기 전 기존 정상 artifact를 제거하지 않는다.
- 구현 기술은 별도 언어 재작성을 요구하지 않으며 단일 실행 artifact라는 계약만 고정한다.
- bootstrap 설치와 self-test가 성공하기 전에는 전역 client integration apply를 허용하지 않는다.

### P2 수용 기준

- Baton checkout 또는 `node_modules`가 없고 시스템 Node를 사용할 수 없어도 P0 status/remove가
  동작한다.
- Worker, checkout과 네트워크를 동시에 사용할 수 없는 상태에서도 receipt를 읽어 복구한다.
- bootstrap 교체 검증 실패 시 기존 정상 artifact가 남는다.
- bootstrap만으로 P1 자동 시작 상태를 진단하고 명시적으로 repair할 수 있다.
- 이해할 수 없는 receipt schema는 변경 없이 fail closed 한다.
- 진단과 오류 출력은 token과 설정 원본을 redaction한다.

## 명시적 비범위

다음은 현재 문제를 해결하는 데 필수적이지 않으므로 별도 근거가 생기기 전에는 구현하지 않는다.

- Rust/Go로 전체 Baton 또는 proxy 재작성
- A/B release updater와 자동 버전 rollback
- Supervisor가 `:4400`을 소유하는 reverse proxy와 상시 Recovery Web
- Windows LocalSystem 서비스
- heartbeat/TTL 기반 자동 설정 원복
- Baton 장애 시 provider로 조용히 직접 우회
- Recovery Host의 OAuth, account pool, 모델 선택 기능
- 원격 recovery API 또는 LAN bind

전체 Worker release의 A/B 배포는 updater를 도입할 때 별도 이슈로 다룬다. P2의 bootstrap
교체 안전성은 복구 도구 자체를 잃지 않기 위한 최소 범위이며 Worker 자동 rollback을 뜻하지 않는다.

## 단계별 검수 계약

각 단계는 한 번에 합쳐 구현하지 않는다.

1. 작업자 에이전트가 해당 단계만 구현하고 단계 수용 기준을 실행한다.
2. 독립 검수 에이전트가 요구사항 누락, 같은 failure domain 의존, 데이터 손실, 보안 회귀를
   적대적으로 검토한다.
3. 발견 사항을 반영하고 검수자가 동의할 때까지 반복한다.
4. 단계 커밋은 다른 변경과 섞지 않고 병합 전 전체 회귀 검수를 받는다.
5. P0가 병합되기 전 P1을, P1이 병합되기 전 P2를 구현하지 않는다.

모델 선택을 제어할 수 있는 실행 환경에서는 작업자는 Terra High, 단계·최종 검수자는 Sol High를
사용한다. 모델 선택을 제어할 수 없는 환경에서는 임의로 충족했다고 주장하지 않고 실제 사용
가능한 독립 에이전트와 검수 증거를 기록한다.

## P0 구현 기록

2026-07-21에 P0만 다음과 같이 구현했다. P1 자동 시작과 P2 standalone packaging은 시작하지
않았다.

- `client-integration-recovery.ts`에 server/OAuth/model catalog를 import하지 않는 offline core를
  분리했다. 대상별 OS exclusive lock, 교체 직전 SHA-256 CAS, flush 후 atomic rename과
  `PREPARED → APPLIED → REMOVED` reconciliation을 한곳에서 처리한다.
- receipt의 원본·적용본은 CurrentUser DPAPI payload에만 보관하고, protected payload는 target,
  경로, owned fields와 digest 등 외부 metadata에도 binding한다. CLI/API 출력에는 payload와 token을
  반환하지 않는다.
- exact 적용 해시는 원본 bytes로 복구한다. 적용 이후 무관한 구조 변경은 보존하되 owned field가
  달라지거나 설정/receipt가 손상되면 쓰지 않는다.
- `baton integration status/remove/adopt-existing`와 `baton doctor`는 `:4400` 또는 Worker에 요청하지
  않는다. receipt 없는 기존 exact 설치는 preview와 `--confirm`을 거쳐야 하며 원래 owned value를
  모른다는 provenance를 기록한다.
- 기존 web apply/remove도 같은 recovery core를 사용한다. 기존 관련 필드의 `conflict` 자동 repair는
  제거했다. mutation route는 loopback Host, same-origin Origin/Sec-Fetch-Site 및 기동별 random
  capability를 모두 검증한다.
- 테스트는 Worker listener가 없는 offline CLI, 세 target, crash boundary reconciliation, unrelated 및
  owned edit, malformed config/receipt, lock/CAS, legacy adoption, DPAPI와 cross-origin 거부를 포함한다.

P0 병합 전 남은 gate는 이 변경과 독립적인 검수자가 같은 failure domain 의존, 데이터 손실 및 보안
회귀를 적대적으로 검토하고 지적 사항이 없어질 때까지 수정하는 것이다.

### 1차 적대적 검수 후 보강

첫 독립 검수는 P0 승인을 거부했고, 발견 사항을 다음과 같이 보강했다.

- receipt 없는 Codex 채택은 TOML 전체 재직렬화 대신 exact managed field만 text-preserving 방식으로
  제거한다. CRLF, 주석, 인라인 주석 및 다른 provider를 보존하고, 알 수 없는 key·중첩 table·비표준
  managed 형태는 채택하지 않는다.
- Claude patcher가 실제로 변경할 동일 snapshot에서 기존 owned 연결 항목을 다시 검증하므로 status
  검사 뒤 관련 field가 삽입되는 경합도 덮어쓰지 않는다.
- web과 offline mutation은 한 target 실패 뒤에도 나머지를 실행하고 target별 success/error를
  반환한다. CLI는 부분 실패를 출력하고 nonzero로 종료하며 SPA도 부분 결과를 표시한다.
- parser 오류는 원문이나 secret 행을 포함하지 않는 고정 오류로 변환한다. receipt의 state,
  updatedAt, pending removal, temp path를 포함한 판단 metadata 전체를 DPAPI payload에 bind하고 모든
  상태 전이에서 다시 seal한다.
- plaintext config temp는 receipt transaction에서 결정되는 경로만 사용한다. crash 뒤 다음 offline
  status/remove가 해당 경로를 검증하고 제거한 후 transaction을 reconcile한다.
- offline remove/adopt도 대상 client 종료를 확인하고 실제 설정 파일의 Windows exclusive-open 검사를
  통과해야 한다. doctor는 exact `UNTRACKED` 설치를 정상으로 판정하지 않는다.
- SPA가 capability 401/403을 받으면 cached capability를 폐기하고 딱 한 번만 재취득·재시도한다.

### CAS가 제공하는 계약과 한계

설정 교체는 같은 디렉터리에 temp를 flush한 뒤, target을 다시 읽어 SHA-256 CAS를 확인하고 OS atomic
rename으로 교체한다. Baton writer끼리는 target별 OS lock으로 직렬화하며 offline mutation은 client
종료와 Windows file lock 가능 여부도 먼저 확인한다.

일반 파일시스템에는 임의의 비협조 외부 writer에 대해 “내용 비교와 경로 교체”를 하나의 원자 연산으로
묶는 portable primitive가 없다. 따라서 CAS 재읽기 직후부터 rename 직전 사이에 파일 잠금을 무시하고
쓰는 외부 프로세스까지 완전히 배제한다고 주장하지 않는다. Baton은 그 창을 temp flush 이후의 마지막
두 연산으로 제한하고, 정상적인 Windows 공유 잠금 사용자와 Baton 동시 writer는 fail closed 처리한다.
이보다 강한 보장이 필요하면 대상 애플리케이션과의 협조 lock 또는 filesystem transaction 지원이
별도 전제되어야 한다.

### P0 최종 검수

독립 검수자는 세 차례의 구현 검수를 수행했다. 2차 검수에서 외부 receipt의 `state`만 변조하면
apply/adopt가 sealed payload 검증 전에 기존 receipt를 덮어쓸 수 있는 반례를 찾아 승인을 거부했다.
공통 reconciled receipt loader가 모든 기존 receipt를 DPAPI binding 검증한 뒤 상태를 판단하도록
수정하고, 변조된 receipt의 apply/adopt 거부와 기존 receipt/config bytes 보존 테스트를 추가했다.

3차 재검수에서 같은 token-loss 반례, Codex text 보존, parser redaction, target별 partial result,
plaintext temp cleanup, stale capability 재취득, process CommandLine 분류와 BUSY 진단을 다시 확인했고
새 승인 차단 finding 없이 P0를 승인했다.

## 설계 검수 기록

2026-07-21에 서로 독립적인 최소설계 검토와 적대적 검토를 두 차례 수행했다.

- 1차 검토에서 `:4400` front-door Supervisor, 상시 Recovery Web, 일반 3-way merge와 Worker A/B
  updater가 현재 문제보다 큰 data-plane·운영 복잡성을 만든다는 데 합의했다.
- 적대적 검토에서 현재 `conflict` apply 허용, 영속 provenance 부재, replace 직전 CAS 부재,
  in-memory 다중 파일 rollback 및 mutation API의 cross-origin 방어 부재를 P0 필수 결함으로
  추가했다.
- 2차 검토에서 P1은 별도 Supervisor가 아니라 OS Task Scheduler로 제한했다.
- 두 검토자는 P2를 P0과 같은 core를 담은 on-demand standalone escape hatch로만 유지하는 데
  최종 동의했다. Baton이 프로세스보다 오래 남는 전역 설정을 변경하므로 checkout/Node 손상 후에도
  그 역연산은 가능해야 한다는 판단이다.
