# 테스트·유지보수·lifecycle 작업이 active Baton turn을 강제 중단하지 않아야 함

## 상태

- 상태: 미해결
- 발견일: 2026-07-21
- 우선순위: P0

## 증상

live Baton과 Goal이 실행 중인 머신에서 npm test를 실행한 뒤 4400 listener PID가 59528에서
39948로 바뀌었고, 실행 중이던 Goal sequence 39가 runtime_interrupted로 종료됐다. 이후
Windows scheduled task가 Baton을 다시 기동하는 동안 listener가 일시적으로 사라졌다.

2026-07-22에는 Native import 유지보수 작업이 import 작업만 기준으로 `실행 중 0개`라고
판정한 뒤 포트 4400의 프로세스를 `Stop-Process -Force`로 종료했다. 당시 별도 프로젝트리스
canonical turn은 실제 `running`이었고 재기동 복구에서 `runtime_interrupted`가 됐다.

## 영향

- 검증 명령이 사용자의 실제 AI 작업을 중단한다.
- offline CLI 테스트가 live 4400 서버를 발견해 실패한다.
- Windows lifecycle 테스트가 설치된 unsigned development bootstrap 상태에 영향을 받는다.

## 현재 판단

전체 테스트뿐 아니라 import·maintenance·공식 stop/restart 경로도 canonical DB/API의
모든 `queued`, `running`, `waiting_tool` turn/execution을 admission 조건으로 검사하지 않는다.
특정 작업 종류만 세면 관련 없는 live 대화를 놓칠 수 있고, raw force kill은 graceful
cancel/drain 경로를 우회한다.

## 완료 조건

- 테스트는 임시 포트, 임시 설치 루트, 가짜 scheduler/process seam만 사용한다.
- live 4400 listener와 Baton 예약 작업이 존재하는 상태에서도 전체 테스트가 PID와 task 상태를 바꾸지 않는다.
- 테스트 전후 live PID, health, scheduled task 정의가 동일함을 자동 검증한다.
- import·maintenance·stop·restart 전에 모든 canonical active turn/execution을 검사하고,
  기본적으로 대상 session/turn을 표시하며 작업을 거부한다.
- 명시적 중단은 Baton 소유의 drain/cancel 절차만 사용하고 raw force kill을 금지한다.
- projectless turn이 `running` 또는 `waiting_tool`일 때 유지보수 재기동이 거부되고 PID가
  유지되는 live 회귀 테스트를 추가한다.
