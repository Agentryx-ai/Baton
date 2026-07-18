# Codex Native Proxy의 provider namespace와 SSOT 결정 제안

> 상태: 검수 요청용 제안서. 아직 구현 결정 또는 완료를 뜻하지 않는다.
> 관측일: 2026-07-18 (Asia/Seoul)
> 대상: Baton의 Codex CLI/Desktop 프록시 적용 기능. Baton canonical conversation runtime 자체는 별도 범위다.

## 1. 결론 요약

기존 Codex Desktop task를 계속 사용하는 **Native Client Proxy 모드**에서는 Codex의 논리적
`model_provider`를 `openai`로 유지해야 한다. Baton은 provider identity를 바꾸는 대신 내장 OpenAI
provider의 전송 주소인 `openai_base_url`만 로컬 Baton Proxy로 바꾸는 방향이 SSOT 요구에 가장 잘 맞는다.

목표 상태는 다음과 같다.

```text
Codex task/thread identity and history: 기존 openai namespace에 단 하나
Model request transport:             Baton Proxy
Provider/account routing:            Baton/CLIProxy 내부 책임
```

현재 구현처럼 `model_provider = "baton"`과 `[model_providers.baton]`을 설치하면 기존 `openai`
task가 삭제되지는 않지만 Codex Desktop 목록에서 숨겨진다. 이 문제를 task fork·복제로 해결하면 같은
논리 작업이 두 native thread에 존재해 대화, `/goal`, archive, 실행 상태가 갈라진다. Native Client
Proxy 모드의 기본 해결책으로 사용해서는 안 된다.

단, 내장 OpenAI provider가 보내는 Authorization을 현재 CLIProxy가 그대로 받아들이는지는 아직
검증되지 않았다. 이는 개인 loopback 도구에서 Baton이 요청을 본다는 정보 노출 문제가 아니라 인증
호환성 문제다. loopback bridge와 live smoke test를 통과하기 전에는 현재 설정을 자동 전환하면 안 된다.

## 2. 두 SSOT 모드의 경계

Baton에는 성격이 다른 두 실행 모드가 있다. 둘을 같은 session ownership 규칙으로 다루면 안 된다.

| 모드 | 사용자가 보는 주 대화 UI | SSOT | Native Codex thread |
|---|---|---|---|
| Baton canonical runtime | Baton | Baton session/thread/item store | ephemeral execution detail 또는 import source |
| Native Client Proxy | Codex CLI/Desktop | 기존 Codex thread/rollout | **SSOT 자체** |

`COMMON_SESSION_DESIGN.md`의 “Baton owns the conversation” 결정은 첫 번째 모드에 적용된다. 이번 문서는
두 번째 모드에서 Baton이 투명한 전송·계정 라우팅 계층으로 동작할 때의 계약을 추가한다.

Native Client Proxy 모드에서는 다음이 금지된다.

- 프록시 적용만으로 native task를 새 provider namespace에 복제하는 것
- 동일 논리 작업을 OpenAI/Baton 양쪽 task에서 계속 실행하는 것
- `state_5.sqlite`나 rollout JSONL의 `model_provider`를 직접 치환하는 것
- 사용자의 명시적 import 없이 Baton canonical session을 새 SSOT라고 선언하는 것

## 3. 재현된 문제

### 3.1 사용자 증상

Codex Desktop에 Baton CLIProxy 설정을 적용한 뒤:

- 프로젝트 목록은 남아 있다.
- 기존 task/session 목록은 보이지 않는다.
- 세션 파일이 삭제된 것처럼 보인다.

### 3.2 읽기 전용 관측 증거

관측 당시 로컬 상태는 다음과 같았다.

- `~/.codex/config.toml`의 활성 provider는 `baton`이었다.
- `~/.codex/sessions`의 기존 rollout JSONL은 그대로 존재했다.
- `state_5.sqlite.threads`에는 `model_provider` 컬럼이 있으며 Baton용 별도 DB는 없었다.
- 현재 스냅샷의 thread 분포는 `openai` 2,851개, `zai_coding` 9개, `baton` 0개였다.
  이 수치는 백필·보관 상태에 따라 변할 수 있지만 `baton=0`과 기존 `openai` thread 보존이 핵심이다.
- app-server의 `thread/list`를 `modelProviders: ["baton"]`으로 호출하면 기존 task가 반환되지 않았다.
- `modelProviders: ["openai"]` 또는 `modelProviders: []`로 호출하면 기존 task가 반환됐다.
- 프로젝트 목록은 provider thread 목록이 아니라 Codex config의 `[projects]`에서 오므로 그대로 보였다.
- 별도 `CODEX_HOME` 또는 `CODEX_SQLITE_HOME`에 의한 저장 루트 분리는 없었다.

따라서 이는 삭제나 계정별 물리 저장 분리가 아니라 **provider tag 기반 목록 필터링**이다.

### 3.3 추가 실행 결함

Codex Desktop 로그에는 `BATON_PROXY_TOKEN`이 Desktop 프로세스 환경에 없다는 오류도 반복됐다. 현재
구현은 user environment variable을 설치하지만 이미 실행 중인 Desktop은 새 환경을 상속하지 않는다.
따라서 provider namespace 문제와 별개로, 적용 후 완전 종료·재시작 전에는 프록시 실행도 신뢰할 수 없다.

## 4. 현재 구현의 직접 원인

현재 Native Client 통합은 `server/client-integration.ts`에서 다음 형태의 설정을 생성한다.

```toml
model_provider = "baton"

[model_providers.baton]
name = "Baton CLIProxy"
base_url = "http://127.0.0.1:<port>/v1"
env_key = "BATON_PROXY_TOKEN"
wire_api = "responses"
```

직접 관련 코드는 다음과 같다.

- `server/client-integration.ts:618`: 적용 상태 검사
- `server/client-integration.ts:888`: `patchCodexConfig`
- `server/client-integration.ts:928`, `:939`: root `model_provider = "baton"` 강제
- `server/client-integration.ts:948`: `BATON_PROXY_TOKEN` custom-provider 인증
- `server/session/codex-adapter.ts:640-667`: canonical adapter 자식 app-server의 Baton provider override

마지막 `codex-adapter.ts` 경로는 Baton canonical runtime의 ephemeral 실행 경로이므로 Native Client 설정과
동일하게 취급할 필요가 없다. 이번 결함의 1차 수정 대상은 `client-integration.ts`의 Codex CLI/Desktop
적용 경로다.

## 5. SSOT를 깨뜨리는 임시 해결책

기존 `openai` thread를 `baton` provider로 fork하면 지원 API만 사용할 수 있고 원본을 보존한다는 장점은
있다. 하지만 Native Client Proxy의 기본 해법으로는 다음 문제가 생긴다.

- 동일 작업의 원본과 복제본이 동시에 존재한다.
- 어느 쪽 `/goal`이 현재 권위인지 별도 장부가 필요하다.
- 새 메시지, 파일 변경, archive, blocked 상태가 양쪽에서 갈라진다.
- Desktop provider를 다시 바꾸면 반대쪽 task가 숨겨진다.
- 자동 continuation이나 중복 writer를 막기 위한 별도 조정이 필요하다.
- provider-private encrypted continuation state의 교차 provider 호환성을 별도로 입증해야 한다.

따라서 fork는 사용자가 의도한 분기, 독립 실험, 명시적 migration에만 사용한다. 투명 프록시 적용을
위한 자동 migration에는 사용하지 않는다.

## 6. 제안 설정

Codex 공식 설정 계약은 내장 OpenAI provider를 LLM proxy/router로 보낼 때 별도 custom provider 대신
`openai_base_url`을 사용하도록 안내한다.

```toml
model_provider = "openai" # 기본값이므로 생략 가능
openai_base_url = "http://127.0.0.1:<baton-port>/v1"
```

참고:

- [Codex advanced configuration: custom model providers](https://learn.chatgpt.com/docs/config-file/config-advanced#custom-model-providers)
- Codex 문서의 핵심 계약: built-in OpenAI provider의 base URL 변경에는 `openai_base_url`을 사용하고
  reserved ID인 `[model_providers.openai]`를 정의하지 않는다.

이 구조에서 `model_provider="openai"`는 session namespace/논리 provider identity이고,
`openai_base_url`은 transport endpoint다. 전자가 `openai`라고 해서 요청이 Baton을 우회하는 것은 아니다.

## 7. 인증 호환성과 로컬 신뢰 경계

현재 custom provider는 `env_key="BATON_PROXY_TOKEN"`으로 로컬 프록시를 인증한다. 내장 `openai`
provider에 `openai_base_url`만 지정하면 이 custom `env_key` 계약은 자동 승계되지 않는다.

현재 제품의 신뢰 경계는 개인 단일 사용자 PC와 `127.0.0.1` 전용 서비스다. 같은 사용자 권한의 악성
로컬 프로세스 방어와 LAN 공유는 현재 범위가 아니다. 따라서 Baton이 inference 요청 본문을 보는 것은
의도된 데이터 경로이며 정보 노출로 분류하지 않는다.

남은 문제는 내장 provider의 Authorization과 CLIProxy token 계약이 서로 다를 수 있다는 기능적
호환성이다. 가장 작은 안정적 해법은 `openai_base_url`을 Baton의 loopback inference bridge로 향하게
하고, bridge가 inbound Authorization을 로그·저장·전달하지 않은 채 서버가 보유한 CLIProxy token으로
로컬 CLIProxy에 전달하는 것이다. 그러면 Desktop 프로세스에 `BATON_PROXY_TOKEN`을 상속할 필요가 없다.

구현 전에 다음을 결정하고 live 검증한다.

1. Codex Desktop이 ChatGPT login과 API-key login 각각에서 `openai_base_url` 요청에 어떤 Authorization을
   보내는가?
2. Baton loopback bridge가 inbound credential을 버리고 CLIProxy token으로 교체해 streaming·cancel을
   손실 없이 전달하는가?
3. Desktop 프로세스에 Baton 전용 credential을 설치하지 않고도 ChatGPT/API-key login이 모두 동작하는가?
4. 프록시가 꺼졌거나 인증에 실패할 때 direct OpenAI endpoint로 조용히 fallback하지 않음을 어떻게
   입증할 것인가?

현재 신뢰 경계에서도 금지할 임시방편:

- bearer token을 URL path/query에 삽입
- repository child process 전체에 장기 token을 상속
- 사용자 동의·원본 백업 없이 Codex `auth.json`을 덮어쓰기
- 요청/로그/진단에 OpenAI 또는 Baton bearer를 출력
- LAN 인터페이스에 인증 없는 inference bridge를 바인딩

loopback bridge의 인증 교체와 no-fallback이 성립하지 않으면 제안 설정을 자동 적용하지 말고 fail
closed해야 한다. 이 경우 custom provider를 유지하면서 Baton UI가 `modelProviders: []`로 native 목록을
통합 표시하는 대안은 가능하지만, Codex Desktop 자체의 단일 native-task SSOT 요구를 완전히 만족하지는
못한다.

## 8. 구현 변경 제안

### 8.1 Native Client 설정 적용

`server/client-integration.ts`의 Codex 적용 경로를 다음 계약으로 재설계한다.

- 기존 provider가 `openai`이거나 생략된 경우에만 transparent proxy 모드를 적용한다.
- root `model_provider`를 `baton`으로 바꾸지 않는다.
- `[model_providers.baton]`을 만들지 않는다.
- top-level `openai_base_url`만 현재 Baton endpoint로 설정한다.
- 기존 `openai_base_url`의 존재 여부와 정확한 원본 값을 rollback receipt에 보존한다.
- unrelated TOML bytes, comments, table order를 보존하고 atomic replace한다.
- 적용 상태 검사는 provider가 아니라 `openai_base_url`, proxy health, 인증 readiness를 함께 본다.
- 적용·해제 후 Desktop 완전 재시작 필요성을 UI에서 명시한다.
- 다른 custom provider를 사용 중이면 자동 덮어쓰지 않고 충돌로 중단한다.

### 8.2 적용 해제

- Baton이 설치한 `openai_base_url`만 제거하거나 저장한 원래 값으로 정확히 복원한다.
- 기존 `model_provider`, custom providers, comments, 다른 설정은 변경하지 않는다.
- rollback receipt/hash가 현재 설정과 일치하지 않으면 자동 복원하지 않고 사용자에게 충돌을 보고한다.

### 8.3 Baton canonical adapter와 분리

`server/session/codex-adapter.ts`의 ephemeral app-server 실행은 Baton canonical history가 SSOT인 별도
경로다. 해당 custom provider override를 유지할지 여부는 Native Client 수정과 별도 결정으로 검수한다.
Native task 목록을 만들지 않는 ephemeral thread라면 이번 Desktop namespace 결함과 직접 같지 않다.

## 9. 기존 사용자 상태의 migration 원칙

제안이 승인되고 인증 경로가 검증되면 기존 상태는 다음 순서로 복구한다.

1. 현재 Codex config와 관련 환경의 비밀 제외 해시/rollback receipt를 만든다.
2. `[model_providers.baton]` 및 Baton이 설치한 `model_provider="baton"`을 소유권 검증 후 제거한다.
3. 원래 provider가 `openai` 또는 생략 상태였음을 receipt로 확인해 복원한다.
4. 검증된 `openai_base_url=<Baton endpoint>`와 인증 준비 상태를 설치한다.
5. Codex Desktop을 완전히 종료하고 새 환경으로 재시작한다.
6. 기존 thread ID, rollout path, `/goal`, archive 상태가 그대로인지 확인한다.
7. 새 native task 하나를 만들고 `model_provider=openai`로 기록되는지 확인한다.
8. 같은 task의 model 요청이 Baton Proxy를 통과했음을 content-free correlation receipt로 확인한다.

DB/rollout 수정, thread fork, 대량 task 재생성은 이 migration에 포함하지 않는다.

## 10. 검증 매트릭스

### 설정 단위 테스트

- provider 생략/openai 설정에 `openai_base_url`을 추가한다.
- 기존 동일 URL에는 byte-idempotent다.
- 다른 custom provider 사용 중에는 fail closed한다.
- 기존 사용자 `openai_base_url`을 정확히 백업·복원한다.
- unrelated comments, arrays, tables, CRLF를 보존한다.
- 비표준·중복 root key에는 쓰지 않는다.
- partial apply와 stale rollback receipt를 탐지한다.

### 실제 Codex Desktop smoke test

- 적용 전후 기존 대표 thread ID들이 동일하게 목록에 보인다.
- 기존 thread의 rollout path와 provider tag가 바뀌지 않는다.
- 기존 `/goal` objective/status가 정확히 유지된다.
- 프록시 적용 후 생성한 새 task도 `model_provider=openai`다.
- 실제 요청이 Baton Proxy를 통과하며 direct fallback이 없다.
- Desktop 프로세스가 필요한 credential을 실제로 상속한다.
- runtime metadata에서 요청 모델/effort와 provider transport를 각각 검증한다.
- Desktop 완전 재시작 후 기존 task resume와 새 turn이 성공한다.
- proxy stop, token 없음, 잘못된 token에서 명시적으로 실패한다.
- 적용 해제 후 원본 config와 직접 연결 동작이 복원된다.

### SSOT acceptance criteria

- 논리 작업당 native Codex thread ID는 하나다.
- 프록시 적용 때문에 fork/duplicate task가 생기지 않는다.
- 기존 대화, `/goal`, archive, cwd, lineage가 유지된다.
- provider 전환 없이 프록시 적용·해제가 가능하다.
- UI에 보이는 세션과 실제 실행되는 세션이 같다.
- Baton canonical import를 수행할 때만 별도 Baton canonical ID가 생기고 명시적 provenance link가 남는다.

## 11. Baton 검수자에게 요청할 판단

실제 독립 검수에 전달할 전체 프롬프트는
[`CODEX_NATIVE_PROXY_SSOT_REVIEW_PROMPT.md`](CODEX_NATIVE_PROXY_SSOT_REVIEW_PROMPT.md)에 고정한다.

1. Native Client Proxy와 Baton canonical runtime의 SSOT 경계가 충분히 명확한가?
2. `openai_base_url`이 Codex Desktop ChatGPT-auth 경로에도 실제로 적용되는가?
3. built-in provider와 CLIProxy의 인증 차이를 loopback bridge가 안정적으로 흡수할 수 있는가?
4. bridge가 inbound credential의 비기록·비전달과 silent bypass 차단을 동시에 보장하는가?
5. `client-integration.ts`와 `codex-adapter.ts`의 provider 설정을 분리하는 것이 맞는가?
6. 적용/해제 receipt가 기존 config를 손실 없이 복원하기에 충분한가?
7. live smoke test가 통과하기 전 기존 custom-provider 설정을 유지하고 UI에 known issue를 표시할 것인가?

## 12. 현재 판정

- 문제 재현: **확인됨**
- 세션 삭제: **아님**
- 직접 원인: **custom provider 전환에 따른 Desktop provider-filtered 목록**
- SSOT 제안: **provider는 openai로 유지하고 transport만 openai_base_url로 Baton에 연결**
- 인증 설계: **정보 노출 blocker 아님·loopback bridge 호환성 검증 필요**
- 기존 thread 복제/fork: **기본 해결책으로 기각**
- DB/JSONL 직접 수정: **기각**
- 구현 변경: **아직 수행하지 않음**
