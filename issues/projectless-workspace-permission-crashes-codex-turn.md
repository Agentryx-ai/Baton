# 프로젝트리스 workspace 권한이 Codex turn을 capability violation으로 실패시킴

## 상태

- 상태: 미해결
- 발견일: 2026-07-22
- 우선순위: P1

## 증상

전역 권한을 `workspace`로 설정하고 폴더를 연결하지 않은 새 Codex 대화를 시작하면 모델이나
도구 실행 전에 turn 전체가 실패하고 다음 내부 오류가 사용자에게 그대로 표시된다.

```text
Codex capability violation: effective Codex sandbox readOnly did not match workspaceWrite
```

재현 session:

```text
d7d79f2f-9715-44bc-820a-c4bd94b265bd
```

같은 프로젝트리스 조건에서 `full_access`는 `run_command`가 정상 성공했고, `read_only`는
명령 도구를 노출하지 않고 정상 안내했다. `workspace`만 시작 불가능하다.

## 원인

`server/session/codex-adapter.ts`는 workspace profile에서 `sandbox: workspace-write`를
요청하지만 cwd가 없는 Codex가 effective `readOnly`를 반환하면 strict capability mismatch를
throw한다. UI/API는 프로젝트 없는 workspace 선택을 사전에 막거나 명시적으로 강등하지 않는다.

## 영향

- 전역 workspace 권한 사용자는 프로젝트리스 Codex 대화를 전혀 시작할 수 없다.
- 안전한 권한 축소가 내부 오류와 실패 turn으로 나타나 일반 사용자가 원인을 해결할 수 없다.
- 전역 설정 하나가 이미 존재하는 프로젝트리스 대화까지 깨뜨릴 수 있다.

## 완료 조건

- 프로젝트 없는 workspace는 폴더 연결을 요구해 제출을 사전 차단하거나, 동의된 계약에 따라
  read_only로 명시적으로 강등하고 UI에 표시한다.
- 내부 `capability violation` 문자열을 사용자에게 직접 노출하지 않는다.
- projectless/workspace의 Codex와 Claude 시작, 일반 메시지, 명령 요청을 각각 회귀 테스트한다.
- 폴더를 연결한 workspace 대화는 계속 `workspace-write`로 실행되고 강등되지 않는다.
