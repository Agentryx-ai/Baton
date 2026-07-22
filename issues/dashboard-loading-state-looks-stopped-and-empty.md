# 대시보드 로딩 상태가 Proxy 정지·계정 0개로 표시됨

## 상태

- 상태: 미해결
- 발견일: 2026-07-22
- 우선순위: P2

## 증상

정상 실행 중인 Baton 홈을 새로 열면 초기 데이터 fetch가 끝나기 전 약 1초 동안 다음 상태를
실제 장애·빈 계정 상태처럼 표시한다.

```text
Proxy 정지
요청을 전달하지 않습니다
활성 계정 0 / 0
Claude (0) / Codex (0)
등록된 계정이 없습니다.
```

같은 화면은 잠시 뒤 `Proxy :4400`, `정상`, `활성 계정 2 / 5`와 실제 계정 5개로 바뀐다.
loading/skeleton 표시는 없다.

## 재현

1. Baton Worker와 session host가 정상인 상태에서 새 브라우저 탭을 연다.
2. `http://localhost:4400/`으로 이동한 직후 DOM을 캡처한다.
3. 1.2초 뒤 다시 캡처한다.

2026-07-22 root in-app browser와 독립 Codex 모델 QA의 Chrome 탭에서 각각 관찰했다. root
측정에서는 첫 DOM이 위 false empty/stopped 상태였고 1.2초 뒤 실제 `정상`, `2 / 5`로
수렴했다.

## 원인

- `Header.tsx`의 `ProxyPill`은 `proxy === null`을 `running=false`로 처리한다.
- `DashboardOverview.tsx`는 `accounts === null`일 때도 빈 배열을 만들어 `0 / 0`을 계산하고,
  `proxy === null`을 `정지`로 렌더링한다.
- `ProviderSection`도 데이터가 아직 없는 loading과 fetch 완료 후 계정 0개를 구분하지 않는다.

## 영향

- 사용자는 정상 서비스를 정지 상태로 오인해 불필요한 새로고침이나 복구를 시도할 수 있다.
- 계정이 삭제됐다고 오인해 로딩 중 `계정 추가`를 중복 실행할 수 있다.
- 실제 정지·빈 계정과 로딩 상태가 시각적·접근성 트리에서 구분되지 않는다.

## 완료 조건

- `proxy/accounts/quotas === null`인 동안 명시적인 loading/skeleton 상태를 표시한다.
- loading 상태에는 `정지`, `0 / 0`, `등록된 계정이 없습니다` 같은 확정 문구를 사용하지 않는다.
- 데이터 fetch 실패는 loading과 실제 정지 상태를 구분한 오류와 재시도 동작을 제공한다.
- 즉시 렌더, 지연 응답, fetch 실패, 실제 proxy 정지·계정 0개를 구분하는 UI 테스트가 통과한다.
