# 전체 테스트가 live Baton lifecycle을 건드리지 않아야 함

## 상태

- 상태: 미해결
- 발견일: 2026-07-21
- 우선순위: P0

## 증상

live Baton과 Goal이 실행 중인 머신에서 npm test를 실행한 뒤 4400 listener PID가 59528에서
39948로 바뀌었고, 실행 중이던 Goal sequence 39가 runtime_interrupted로 종료됐다. 이후
Windows scheduled task가 Baton을 다시 기동하는 동안 listener가 일시적으로 사라졌다.

## 영향

- 검증 명령이 사용자의 실제 AI 작업을 중단한다.
- offline CLI 테스트가 live 4400 서버를 발견해 실패한다.
- Windows lifecycle 테스트가 설치된 unsigned development bootstrap 상태에 영향을 받는다.

## 현재 판단

전체 테스트 중 offline client integration과 Windows lifecycle 계열이 실제 사용자 포트,
설치 디렉터리 또는 예약 작업으로부터 완전히 격리되지 않았다. 정확한 mutation 경로와
테스트별 환경 주입 누락은 추가 소스 진단이 필요하다.

## 완료 조건

- 테스트는 임시 포트, 임시 설치 루트, 가짜 scheduler/process seam만 사용한다.
- live 4400 listener와 Baton 예약 작업이 존재하는 상태에서도 전체 테스트가 PID와 task 상태를 바꾸지 않는다.
- 테스트 전후 live PID, health, scheduled task 정의가 동일함을 자동 검증한다.
