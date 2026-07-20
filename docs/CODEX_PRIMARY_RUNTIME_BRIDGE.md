# Codex primary-runtime bridge

## 문제

Codex CLI 0.144.6은 `workspace_dependencies` feature와 OpenAI primary-runtime plugin을
활성화하지만, Spreadsheets skill이 필수로 요구하는 `load_workspace_dependencies` 도구를
세션에 등록하지 않는다. `artifact`와 `workspace_dependencies`를 명시적으로 켜거나 custom
provider에 `requires_openai_auth=true`를 부여해도 결과는 같다.

설치된 runtime과 `@oai/artifact-tool` 자체는 정상이다. 문제는 dependency installation이
아니라 CLI tool schema와 plugin instruction 사이의 계약 불일치다. Baton proxy는 HTTP 요청이
시작되기 전에 Codex가 구성하는 로컬 tool schema를 추가할 수 없으므로 proxy/model catalog
수정으로 해결할 수 없다.

별개로 built-in `openai` provider는 스킬 목록이 포함된 큰 요청을 `Content-Encoding: zstd`로
압축한다. 초기 Native proxy는 Express raw parser가 이를 해제하려다 HTTP 415를 반환해, 작은 prompt는
성공하지만 문서 스킬만 실패하는 것처럼 보였다. 현재는 encoded body를 byte-for-byte 보존해 upstream에
전달하고 routing에 필요한 model만 Node의 zstd decoder로 별도 확인한다.

## 해결 경계

`plugins/baton-codex-runtime-bridge`는 다음 좁은 계약만 제공한다.

1. Native `load_workspace_dependencies`가 있으면 항상 그것을 우선한다.
2. Loader가 없을 때 resolver가 `CODEX_RUNTIME_DEPENDENCIES`,
   `CODEX_WORKSPACE_DEPENDENCIES`, `CODEX_DEPENDENCIES`, 표준 primary-runtime 위치 순서로
   후보를 확인한다.
3. 실행 가능한 bundled Node와 실제 `@oai/artifact-tool/package.json` identity를 모두
   검증한 경우에만 경로를 JSON으로 반환한다.
4. Artifact skill은 반환된 Node와 `node_modules`만 사용한다. 다른 library, package install,
   guessed path 또는 vendor package 내부 import는 허용하지 않는다.
5. Authoring, formula/content 검사, render와 export 규칙은 원래 OpenAI artifact skill을 그대로
   따른다.

이 bridge는 upstream loader의 재구현이나 proxy tool injection이 아니다. 공식 runtime에 대한
검증된 discovery adapter이며 upstream 계약이 고쳐지면 자동으로 우선순위에서 빠진다.

## 설치

```bash
codex plugin marketplace add <BATON_CHECKOUT>
codex plugin add baton-codex-runtime-bridge@baton-local
```

Plugin 변경 뒤에는 새 Codex thread/process에서 검증한다.

## 검증 기준

- resolver unit test가 env로 지정된 fake runtime의 identity와 모든 realpath를 검증한다.
- 현재 설치에서 resolver가 official primary runtime과 실제 artifact-tool version을 반환한다.
- 새 Codex process가 bridge skill과 Spreadsheets skill을 함께 로드한다.
- `@oai/artifact-tool`로 workbook 생성, A1 content 검사, formula-error scan, render, XLSX export를
  완료한다.

2026-07-20 canary는 `Canary!A1 = bridge-ok`, error match 0건, worksheet 1개, visual render 통과,
XLSX export 성공으로 완료됐다.
