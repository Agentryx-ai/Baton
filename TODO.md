# Baton TODO

## 탈-Docker (native gateway) — 우선순위: 중

**현황(2026-07-18 확인):** 실제 로테이션/추론 프록시는 Baton이 아니라 **Docker 컨테이너 `ccs-ccs-1`**
(compose 프로젝트 "ccs", 위치 `C:\_tools\ccs`, 이미지 `ghcr.io/kaitranntt/ccs:latest`)이 서빙한다.
- `:3000` = CCS Dashboard(관리 API), `:8317` = CLIProxy API(클라이언트가 붙는 추론 엔드포인트)
- Baton(`:4400`)은 `GATEWAY_URL=http://localhost:3000` 으로 CCS를 호출하는 **관리 UI + 조향 엔진**일 뿐,
  추론 트래픽은 Baton을 경유하지 않는다(README / DESIGN §1.3 / ADR-3에 명시).
- 따라서 **현재 Baton은 Docker 의존을 없애주지 않는다.** Docker Desktop이 떠 있어야 :8317이 산다.

**목표:** Docker Desktop을 매번 켜는 번거로움 제거 = CCS(게이트웨이 + CLIProxy)를 **네이티브로 상시 구동**.

**조사/작업 항목:**
- [ ] CCS(`kaitranntt/ccs`)가 비-Docker(네이티브) 배포/실행 모드를 제공하는지 확인
      (CLIProxy는 Go 단일 바이너리라 네이티브 구동 가능성 높음. CCS Dashboard는 Node).
      → 불가하면 CLIProxy 바이너리만 네이티브로 띄우고 CCS Dashboard는 선택적으로 둘지 검토.
- [ ] 네이티브 구동 시 상태 저장 위치(현재 Docker 볼륨 `ccs_home:/root/.ccs`, `ccs_logs`)의
      네이티브 대응 경로 및 OAuth 토큰 마이그레이션.
- [ ] 네이티브 프로세스의 부팅 시 자동시작(Windows 작업 스케줄러 또는 서비스 등록).
- [ ] 전환 후 Baton `.env`의 `GATEWAY_URL`을 네이티브 엔드포인트로 변경(DESIGN §3.2에 이미 예고된 절연 지점).
- [ ] 전환 후 M1 스모크 재검증(`curl :4400/api/cliproxy/auth/accounts/claude` → 실계정 JSON).

**"크게 문제없으면"의 판단 기준:** 네이티브 CLIProxy가 Docker판과 동일한 라우팅/429 페일오버/쿼터 조회를
제공하고, 토큰/상태가 온전히 이전되면 문제없음. 하나라도 어긋나면 Docker 유지가 안전.

---

## 참고: 연결 스니펫 경로 불일치 (별도 확인 필요)

`src/App.tsx`의 `buildConnectionSnippet`은 `ANTHROPIC_BASE_URL=http://127.0.0.1:8317/api/provider/claude`를
안내하지만, 실측(CLIProxy 7.2.83)에서 그 경로는 **404**다. 실제 동작 경로는 루트 `http://127.0.0.1:8317`
(클라이언트가 `/v1/messages`를 붙임). 스니펫 문구를 실제 경로로 교정할지 검토.
- [ ] `buildConnectionSnippet` 경로를 `http://127.0.0.1:8317` 로 수정(또는 CLIProxy가 `/api/provider/*`를
      지원하는 버전/설정인지 재확인).
