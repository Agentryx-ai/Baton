# 같은 프로젝트가 provider와 worktree에 따라 여러 그룹으로 분리됨

상태

- 상태: 미해결
- 발견일: 2026-07-21
- 우선순위: P1

증상

DaeumKkini라는 같은 표시 이름의 대화가 프로젝트 보기에서 여러 그룹으로 나뉜다.
현재 active API 데이터에는 실제로 세 project_key가 존재한다.

- Claude 기본 경로 2개: Fb3G7Z33ZVIeQ_tqZdtmjf0nRHmON5fPI5bpC7Mu7l4
- Codex 기본 경로 4개: fns_oBsMM8L-tN9EtBQi2eYpRNEypX7PUTpSVCVuh40
- Codex worktree 경로 1개: b-PJMkoidR38PQnYFUIoZ0nrsHwk6qc-gDX6lGIagZE

Claude와 Codex 기본 경로는 모두 C:\_projects\Agentryx-ai\DaeumKkini로 같다.
worktree 경로는 C:\Users\MeroZemory\.codex\worktrees\263c\DaeumKkini이다.

원인

UI는 표시 이름보다 sessions.project_key를 먼저 사용해 그룹을 나눈다.
project_key는 import 시점의 namespace secret과 literal cwd를 HMAC한 값이다.

현재 namespace secret으로 기본 경로를 계산한 값은 Claude 그룹 키와 같다.
Codex 기본 경로와 worktree의 저장 키는 현재 계산값과 다르며 import 뒤 갱신되지 않은 stale key다.
같은 literal cwd도 저장 시점이 다르면 분리될 수 있다.

또한 현재 설계는 Git worktree의 cwd를 별도 프로젝트로 취급한다.
따라서 stale key를 갱신하는 것만으로는 기본 checkout과 worktree가 계속 분리된다.

해결 원칙

- 표시 이름이나 폴더 basename만으로 합치지 않는다. 이름이 같은 무관한 저장소가 존재할 수 있다.
- Git 저장소는 common Git directory를 기준으로 동일한 repository identity를 만든다.
- worktree 경로와 branch는 프로젝트 아래의 실행 위치 정보로 따로 보존한다.
- Git이 아닌 디렉터리는 real path와 Windows 대소문자 정규화를 사용한다.
- identity 형식에 버전을 두고 stale project_key를 안전하게 재계산한다.
- import refresh에 새 item이 없어도 위치와 project identity는 갱신할 수 있어야 한다.

검증 조건

- Claude와 Codex의 같은 repository가 한 프로젝트 그룹으로 표시된다.
- 기본 checkout과 linked worktree가 한 프로젝트 그룹으로 표시된다.
- 이름이 같은 서로 다른 repository는 합쳐지지 않는다.
- 존재하지 않는 과거 cwd와 Git이 아닌 cwd도 안정적으로 그룹화된다.
- 기존 저장 키가 migration 또는 refresh 후 새 identity로 수렴한다.
