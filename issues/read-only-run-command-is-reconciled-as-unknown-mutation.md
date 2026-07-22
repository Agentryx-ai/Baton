# 읽기 전용 run_command도 중단 시 unknown mutation으로 오인됨

## 상태

- 상태: 미해결
- 발견일: 2026-07-22
- 우선순위: P2

## 증상

프로젝트리스 `full_access` 대화에서 파일 존재 여부만 확인하는 PowerShell `Test-Path`
명령이 중단되자 Baton이 이를 다음과 같은 변경 작업으로 표시했다.

```text
변경 작업의 결과를 확인해야 합니다
중단 전에 시작된 변경 작업의 성공 여부가 기록되지 않았습니다.
```

실제 미해결 호출은 아래와 같은 읽기 전용 경로 탐색이었다.

```text
powershell.exe -NoProfile -Command
if (Test-Path -LiteralPath 'D:\ChangZhi\LDPlayer9\dnconsole.exe') { ... }
```

2026-07-22 실제 Baton UI에서 `결과 확인` 대화상자까지 재현했고, 재실행 없이
`실패함`과 “읽기 전용 탐색이며 외부 변경 없음” 메모로 reconciliation을 완료했다.

## 원인

모든 `run_command` 정의가 실제 argv 의미와 관계없이 `workspace_command` side effect를
사용한다. 시작 복구와 unknown-outcome 판정은 이 분류만 보고 command를 mutation과 같은
수동 reconciliation 대상으로 취급한다.

임의 명령을 자동으로 read-only라 추론하면 위험하므로 보수적 기본값은 타당하지만,
현재 계약에는 호출자가 명시적으로 비변경 명령임을 선언하고 제한된 실행기로 검증할 방법이 없다.

## 영향

- 단순 진단 명령 중단도 사용자가 성공/실패/알 수 없음을 수동 판정해야 한다.
- UI의 “변경 작업” 문구가 실제 동작과 달라 사용자가 외부 상태 변경을 우려하게 된다.
- 긴 진단 흐름에서 불필요한 reconciliation이 대화 재개를 막는다.

## 완료 조건

- 보수적인 command 기본 분류는 유지한다.
- 안전하게 제한 가능한 읽기 전용 진단 도구 또는 검증 가능한 read-only command 계약을 제공한다.
- 읽기 전용으로 검증된 호출은 중단 시 `runtime_interrupted` 실패 result로 자동 종결된다.
- 진짜 command/mutation은 기존처럼 unknown outcome 수동 확인을 유지한다.
- UI가 실제 side effect 분류에 맞춰 “변경 작업”과 “읽기 작업”을 구분한다.
- `Test-Path`/상태 조회와 실제 파일 변경 명령의 중단 회귀 테스트가 각각 기대 경로를 통과한다.

