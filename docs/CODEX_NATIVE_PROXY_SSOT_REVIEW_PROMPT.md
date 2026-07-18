# Baton 전달용 독립 검수 프롬프트

아래 코드 블록 전체를 Baton 검수 task의 첫 사용자 메시지로 전달한다.

```text
[BATON_CODEX_NATIVE_PROXY_SSOT_REVIEW:v1]

당신은 Baton 저장소의 Codex Native Client Proxy/SSOT 설계를 검증하는 독립 적대적 reviewer다. 이 검수는
제안서를 승인하기 위한 요식행위가 아니다. 문서의 주장, 현재 구현, Codex 공식 계약, 로컬 재현 증거가
서로 맞지 않으면 명확히 기각하거나 수정안을 제시하라.

런타임 필수 조건:

- 실제 모델은 gpt-5.6-sol이어야 한다.
- 실제 reasoning effort는 high여야 한다.
- 실행 시작 시 authoritative runtime metadata/header에서 model과 effort를 확인해 보고하라.
- 모델/effort 불일치, silent fallback, 정책 대체, 빈 결과이면 검수 결과를 무효로 처리하고 올바른
  설정으로 다시 실행하라. 스스로 모델을 추정하거나 프롬프트의 선언만 근거로 통과시키지 마라.

작업 모드:

- 이번 turn은 read-only 설계 검수다.
- source, test, 문서, Codex config, 환경변수, session JSONL, SQLite, goal을 수정하지 마라.
- 프로세스를 종료하거나 Desktop/CLI를 재시작하지 마라.
- token, API key, bearer, auth.json 내용 또는 메시지 본문을 출력하지 마라.
- 비밀은 존재 여부와 전달 경로만 조사하고 값은 읽거나 보고하지 마라.
- 구현, config migration, task fork/resume는 사용자 별도 승인 전 수행하지 마라.

위협 모델:

- Baton과 inference proxy는 개인 단일 사용자 PC의 `127.0.0.1`에만 바인딩한다.
- 같은 사용자 권한의 악성 로컬 프로세스 방어와 LAN 공유는 현재 범위가 아니다.
- Baton이 요청 본문을 처리하는 것은 의도된 데이터 경로이므로 그 자체를 정보 누출로 판정하지 마라.
- credential의 로그·저장·불필요한 upstream 전달과 direct endpoint 우회는 별도로 검증하라.

권위 입력은 다음 경로다. 전체 내용을 이 프롬프트에 복사하지 않는다. 필요한 파일과 범위를 스스로
선택하되, 결론에 사용한 경로와 line/range를 결과에 기록하라.

저장소:

- C:\_projects\Agentryx-ai\Baton

핵심 제안서:

- C:\_projects\Agentryx-ai\Baton\docs\CODEX_NATIVE_PROXY_SSOT_DECISION.md

관련 Baton 설계·상태:

- C:\_projects\Agentryx-ai\Baton\docs\COMMON_SESSION_DESIGN.md
- C:\_projects\Agentryx-ai\Baton\docs\IMPLEMENTATION_STATUS.md
- C:\_projects\Agentryx-ai\Baton\docs\DESIGN.md
- C:\_projects\Agentryx-ai\Baton\docs\BUILD_DAG.md

현재 구현·테스트:

- C:\_projects\Agentryx-ai\Baton\server\client-integration.ts
- C:\_projects\Agentryx-ai\Baton\server\client-integration.test.ts
- C:\_projects\Agentryx-ai\Baton\server\session\codex-adapter.ts
- C:\_projects\Agentryx-ai\Baton\server\session\codex-adapter.test.ts

읽기 전용 로컬 Codex 증거:

- C:\Users\MeroZemory\.codex\config.toml
- C:\Users\MeroZemory\.codex\state_5.sqlite
- C:\Users\MeroZemory\.codex\goals_1.sqlite
- C:\Users\MeroZemory\.codex\sessions\
- Codex Desktop/app-server 로그 저장소

로컬 증거를 조사할 때 config와 로그에서 비밀값을 출력하지 말고 key name, provider ID, count, schema,
error category만 보고하라. SQLite는 read-only URI로 열고 transaction/write/pragma mutation을 하지 마라.
session 내용은 provider/filter/rollout 존재 확인에 필요한 metadata만 읽고 대화 본문은 읽지 마라.

Codex 기술 계약은 현재 설치된 Codex CLI/app-server schema와 OpenAI 공식 Codex 문서/공식
openai/codex 저장소만 근거로 검증하라. 블로그, 검색 요약, 제3자 문서를 권위 근거로 사용하지 마라.
특히 다음을 직접 확인하라.

1. thread/list의 modelProviders 생략, 빈 배열, 명시 provider가 각각 어떤 의미인지.
2. Codex Desktop이 실제로 현재 provider 기준 목록을 요청하거나 app-server가 생략을 현재 provider로
   해석하는지.
3. state DB thread identity에 model_provider가 어떻게 저장되며 project 목록과 어떤 관계인지.
4. built-in openai provider에서 openai_base_url이 공식 proxy/router 경로인지.
5. reserved provider ID openai를 custom provider로 덮어쓸 수 없는지.
6. Codex Desktop의 ChatGPT login과 API-key login 각각에서 openai_base_url이 실제 inference 요청에
   적용되는지.
7. built-in openai provider에 Baton 전용 인증 credential/header를 안전하게 제공할 지원 경로가 있는지.
8. proxy 실패 시 direct OpenAI endpoint로 silent fallback할 가능성과 이를 차단·검증할 방법.
9. 기존 rollout의 encrypted_content, response IDs, goal, resume가 transport URL 변경 뒤에도 같은 thread
   SSOT에서 안전한지.

반드시 독립 재현할 주장:

- 현재 Baton client integration이 model_provider="baton"과 [model_providers.baton]을 설치한다.
- 기존 Codex task는 삭제되지 않았지만 openai provider tag로 남아 있다.
- 현재 baton provider로 생성된 기존 thread가 없거나 극히 적어 Desktop 목록이 비어 보인다.
- modelProviders=[] 조회는 provider 전체를 반환한다.
- project 목록은 thread provider 필터와 별개로 남을 수 있다.
- Desktop 프로세스에서 BATON_PROXY_TOKEN 전달 실패가 실제로 관측되는지.

SSOT 검수 질문:

A. Native Client Proxy 모드에서 기존 Codex thread를 SSOT로 유지하고 Baton은 transport/account routing만
   담당한다는 경계가 타당한가?
B. Baton canonical runtime에서 Baton session이 SSOT이고 Codex native thread가 ephemeral execution
   detail이라는 기존 계약과 모순 없이 두 모드를 분리할 수 있는가?
C. Native Client Proxy 문제를 thread fork/복제로 해결하면 실제로 이중 SSOT와 goal/history divergence가
   생기는가?
D. provider identity를 openai로 유지하고 transport만 openai_base_url로 Baton에 연결하는 것이 가장
   작은 올바른 변경인가?
E. 인증 제약 때문에 D가 불가능하거나 위험하다면, SSOT를 유지하는 더 안전한 대안은 무엇인가?

대안을 동일 기준으로 비교하라.

- 제안안: model_provider=openai + openai_base_url=Baton
- 현행안: custom model_provider=baton
- 현행안 + Baton 자체 통합 native session UI(modelProviders=[])
- 지원 API를 사용한 provider 간 fork/migration
- 같은 thread를 modelProvider override로 resume하는 방식
- DB/JSONL provider 직접 수정

비교 기준:

- 단일 SSOT
- 기존 thread ID/history/goal/archive 보존
- Codex Desktop 목록 가시성
- Baton Proxy 통과 보장과 direct fallback 방지
- credential 비기록·비저장·불필요한 upstream 비전달
- rollback 가능성
- Desktop/CLI 호환성
- provider-private continuation state 호환성
- 구현·운영 복잡도

현재 소스에 대한 변경 영향도도 검토하라.

- client-integration.ts의 patch/inspect/unpatch/apply/rollback 계약
- user environment variable 설치와 Desktop 완전 재시작 계약
- 기존 config bytes/comments/CRLF와 사용자의 openai_base_url 보존
- stale/partial apply, concurrent config edit, rollback receipt
- canonical codex-adapter.ts의 ephemeral custom provider 경로를 Native Client 경로와 분리할지
- 기존 테스트가 provider namespace와 session visibility 회귀를 놓친 이유

결과는 한국어로 다음 순서와 형식을 지켜 작성하라.

1. Runtime verification
   - 실제 model, effort, provider/runtime header 근거

2. 최종 판정
   - APPROVE / APPROVE_WITH_CHANGES / REJECT 중 하나
   - 5문장 이내 요약

3. 주장 검증표
   - Claim
   - Verdict: VERIFIED / PARTIAL / FALSE / UNPROVEN
   - Evidence path/range 또는 공식 URL
   - Correction

4. 재현 결과
   - config provider
   - provider별 thread count
   - thread/list filter 결과
   - project/session 분리 근거
   - token 전달 상태
   - 대화·비밀값은 포함하지 않음

5. SSOT 및 모드 경계 판정
   - Native Client Proxy
   - Baton canonical runtime
   - 두 모드 사이 import/migration 경계

6. 인증·보안 판정
   - openai_base_url에서 실제 전송되는 인증
   - loopback bridge의 인증 교체 가능성
   - silent direct fallback 방지
   - 미해결 기능 blocker

7. 대안 비교표
   - 위 여섯 대안을 동일 기준으로 평가

8. 권장 최소 변경 계획
   - 실제 의존성만 포함한 DAG
   - 공용 계약 동결 노드
   - 서로 독립이고 파일 소유권이 겹치지 않는 노드는 병렬화
   - 주제 유사성·파일 인접성에 의한 가짜 종속성 제거
   - 구현 전 decision gate와 rollback gate 명시

9. 필수 검증 계획
   - 설정 unit/round-trip
   - proxy auth
   - 기존 대표 thread ID/list/goal 보존
   - 새 task provider tag
   - Baton proxy 실제 경유
   - proxy failure와 no-fallback
   - Desktop 완전 재시작/resume
   - 적용 해제/원본 복원

10. Go/No-Go
    - 즉시 구현 가능한 부분
    - 먼저 실험해야 하는 부분
    - 사용자 결정이 필요한 부분
    - live smoke 전 자동 배포 가능 여부

검수 과정에서 제안서에 중요한 오류나 누락이 발견되면 문서를 직접 고치지 말고 정확한 수정 문안을
결과에 제안하라. 구현 agent가 그대로 실행할 수 있을 정도로 구체적이어야 하지만, 이번 검수 turn에서는
어떠한 파일도 변경하지 마라.
```
