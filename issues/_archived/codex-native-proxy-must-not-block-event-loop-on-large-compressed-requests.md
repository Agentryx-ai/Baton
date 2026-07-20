# Codex Native proxy가 대용량 압축 요청으로 event loop를 막아서는 안 됨

## 상태

- 상태: **해결됨**
- 보관일: 2026-07-21
- 발견일: 2026-07-21
- 우선순위: P0
- 범위: `POST /baton/inference/openai/v1/responses*`

## 증상과 확정 증거

여러 `codex resume` 요청이 수 MB 본문을 동시에 보내면 4400은 listen 상태인데도 웹 UI와
health 요청이 40~60초 동안 응답하지 않았다.

- 단순 `res.json()` health handler가 40초/60초 timeout
- Baton 서버 프로세스의 한 코어가 100%로 고정되고 4초마다 CPU time이 약 4초 증가
- 부하가 끝나면 별도 재시작 없이 밀린 요청이 다시 처리됨

따라서 listener 종료나 Native OAuth/upstream 장애가 아니라 Node event loop starvation이다.

## 원인

Codex proxy가 요청마다 routing model을 알아내기 위해 다음 CPU 작업을 event loop에서
동기 실행했다.

1. `zstdDecompressSync` 등으로 압축 본문 전체 해제
2. 해제한 multi-MB 본문 전체를 `JSON.parse`

resume 본문에는 전체 대화 이력이 포함되고 client retry도 겹치므로 두 작업이 직렬로 누적되어
health와 SPA asset 같은 무관한 요청까지 막았다.

## 조치

- zstd/gzip/deflate/brotli 해제를 Node 비동기 zlib API로 옮겨 libuv threadpool에서 처리한다.
- routing에 필요한 root `model`만 해제된 본문의 첫 64 KiB에서 bounded scan한다.
- 스캐너는 JSON string escape와 object depth를 추적해 중첩 객체의 `model`을 root model로
  오인하지 않는다.
- upstream에는 원래 compressed bytes와 `Content-Encoding`을 그대로 전달한다.
- 전체 본문 `JSON.parse`는 다시 도입하지 않는다.

## 검증

`server/codex-native-proxy-event-loop.test.ts`가 다음을 고정한다.

1. 중첩 객체의 잘못된 `model`을 무시하고 root model로 routing
2. 5,250,034-byte resume 본문 12개를 zstd로 동시에 처리하면서 같은 Express app의 health 요청
3. 모든 proxy 요청 200 및 compressed upstream body 보존 회귀

2026-07-21 단독 로컬 실측에서 health latency는 **6.6ms**, 전체 suite 병행 실행에서는
**9.5ms**였고 제한 1,000ms를 통과했다. 기존 `server/codex-native-proxy.test.ts`의 zstd byte
preservation과 account failover 테스트도 통과했다.

전체 검증은 537 tests, typecheck와 production build가 통과했다. 수정본을 별도 4401 canary로
먼저 검증한 뒤 4400을 PID 79076에서 PID 25092로 교체했다. 재시작 후 결과는 다음과 같다.

| 검증 | 결과 |
|---|---|
| `/baton/health` 연속 5회 | 62.4, 4.8, 3.6, 3.1, 2.7ms |
| `/baton/proxy-status` | `running=true`, `baton-native` |
| SPA `/` | HTTP 200 |
| Codex `/models` | ModelInfo 8개 + OpenAI `data` 8개 |
| 이전 listener | PID 79076 종료 확인 |
| 현재 대화 | 재시작 이후 동일 세션 응답 지속 |

## 완료 조건

- 전체 test/typecheck/build가 통과한다.
- 수정본으로 4400을 안전하게 재시작한 뒤 `/baton/health`, `/baton/proxy-status`, `/models`가
  정상 응답한다.
- 실행 중인 Codex 세션이 Native endpoint를 통해 계속 응답한다.
- 동일 부하에서 health가 1초 미만이고 40~60초 starvation이 재현되지 않는다.
