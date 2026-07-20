# Baton 복구 경로는 Web Worker와 함께 죽으면 안 된다

상태: **설계 승인 · 구현 전**  
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
- Task Scheduler의 제한된 실패 재시작 정책을 사용하고 반복 실패 시 무한 재시작하지 않는다.
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
