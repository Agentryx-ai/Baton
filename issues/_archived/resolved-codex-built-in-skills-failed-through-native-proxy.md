# Codex built-in skill 요청이 Baton Native proxy에서 실패함

## 상태

- 상태: **해결됨**
- 보관일: 2026-07-21
- 발견·해결일: 2026-07-20
- 영향 경로: Codex CLI 및 동일 Native transport를 사용하는 Codex client
- live 검증: CLI 완료. Desktop UI에서 개별 plugin을 누르는 별도 canary는 수행하지 않음
- 관련 커밋: `b813d7c`, `8a119ba`

## 사용자 증상

작은 모델 요청(`Hi`)과 plugin catalog 조회는 성공하지만, 실제 built-in workflow는 서로 다른
단계에서 중단됐다.

1. Spreadsheets skill은 필수 `load_workspace_dependencies`가 없다고 판단하고
   `@oai/artifact-tool` authoring을 시작하지 못했다.
2. `openai-docs`처럼 skill 지침과 도구 schema가 포함된 큰 요청은 HTTP 415
   `UnsupportedMediaTypeError: unsupported content encoding "zstd"`로 실패했다.
3. `/models`는 OpenAI 호환 `data`만 반환해 Codex model manager가 `missing field models` 경고를
   반복했다.

별도 회귀로, Native 전환 때 `[model_providers.baton]`을 완전히 삭제하면 과거 session metadata의
`model_provider=baton`을 해석하지 못해 `resume`이 실패했다. 이 항목의 상세 기록은
`already-migrated-codex-config-missing-baton-compat-alias.md`에 있다.

## 원인

### 1. Codex CLI와 primary-runtime plugin의 loader 계약 불일치

Codex CLI 0.144.6은 공식 primary-runtime plugin과 artifact package를 설치·노출하지만,
Spreadsheets skill이 요구하는 `load_workspace_dependencies` tool을 session tool schema에 등록하지
않았다. package 설치 실패가 아니라 CLI tool schema와 plugin instruction 사이의 불일치였다.

### 2. Express raw parser가 zstd request body를 거부

built-in `openai` provider는 큰 Responses 요청을 `Content-Encoding: zstd`로 보낸다. 전역
`express.raw()`는 zstd decompressor가 없어 proxy router에 도달하기 전에 415를 반환했다. 작은
요청은 압축되지 않아 통과했으므로 plugin만 고장 난 것처럼 보였다.

### 3. 서로 다른 `/models` wire schema를 하나로 취급

Codex model manager는 `{ models: ModelInfo[] }`를 기대하지만 Native proxy는 일반 OpenAI
`{ object, data }` 목록만 반환했다.

## 해결

- `baton-codex-runtime-bridge`가 native loader 부재 시에만 공식 primary-runtime의 bundled Node와
  `@oai/artifact-tool` identity를 검증해 경로를 제공한다. 다른 package 설치나 Python library
  fallback은 허용하지 않는다.
- Codex data plane을 전역 body parser보다 먼저 mount하고 encoded body를 byte-for-byte 수집한다.
  routing에 필요한 model만 Node zstd decoder로 별도 읽고 원래 compressed bytes와
  `Content-Encoding`은 upstream에 그대로 전달한다.
- `/models`는 실제 upstream `ModelInfo` metadata를 보존한 `models`와 OpenAI-compatible `data`를
  함께 반환한다.
- 새 session은 built-in `openai + openai_base_url`을 사용하고, 과거 session resume용
  `baton` alias만 동일 Native loopback endpoint에 남긴다. CLIProxy나 별도 OAuth 저장소를
  되살리지 않는다.
- plugin catalog 인증은 별도 계정 저장소가 아니라 Baton Native vault의 동일 Codex OAuth 중
  선택한 기준계정을 app-server `chatgptAuthTokens` 계약에 전달한다.

## 검증 증거

| 검증 | 결과 |
|---|---|
| 메인 4400 `/models` | full ModelInfo 8개 + OpenAI `data` 8개 |
| Codex CLI `openai-docs` 실제 helper | `OPENAI_DOCS_MAIN_OK` |
| 공식 artifact runtime resolver | `ARTIFACT_RUNTIME_MAIN_OK`, `@oai/artifact-tool 2.8.24` |
| plugin 기준계정 | 선택한 Native OAuth 기준계정 사용 |
| account catalog | marketplace 4개, plugin 191개, load error 0 |
| legacy provider transport | `BATON_PROXY_TOKEN` 없이 Native model 응답 성공 |
| 회귀 suite | 522 tests pass, typecheck/build pass; lint는 기존 Fast Refresh 경고만 존재 |

## 완료 판정

- 작은 prompt뿐 아니라 zstd가 적용되는 실제 built-in skill prompt가 메인 4400에서 성공한다.
- runtime bridge가 공식 artifact package를 반환하고 실제 Codex turn이 그 결과를 검증한다.
- plugin catalog와 기준계정이 Native OAuth 하나를 사용한다.
- CLIProxy container 및 3000/8317 listener 없이 동작한다.

## 남은 비차단 한계

Codex CLI 0.144.6은 Responses WebSocket을 먼저 시도한다. Baton은 아직 HTTP/SSE만 지원하므로
405 뒤 HTTP로 fallback하며 시작 지연이 생긴다. 요청 성공과 이 이슈의 완료 판정에는 영향을
주지 않지만 `codex-native-proxy-needs-responses-websocket-transport.md`에서 별도로 추적한다.
