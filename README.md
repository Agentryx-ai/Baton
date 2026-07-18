# Baton

Pooled multi-account AI gateway control — a clean web UI + smart-rotation engine on top of
the gateway / CLIProxy stack. Named for the relay baton: passing the request baton across accounts.

> Baton does **not** re-implement the proxy. OAuth, token refresh, rotation, and quota all live
> in the gateway/CLIProxy. Baton is a thin **BFF + SPA** that manages and observes them, plus a
> **policy engine** that steers which accounts are active. See [`docs/DESIGN.md`](docs/DESIGN.md)
> and [`docs/BUILD_DAG.md`](docs/BUILD_DAG.md).

## What it does (v1)

- **Accounts dashboard** — per-provider cards with 5h/weekly quota bars, reset countdowns, warning
  colors, and a first-class "no limit info" state. Set-default / pause / resume / delete.
- **Add Account wizard** — OAuth start-url → open in a tab → paste the callback URL → done.
- **Smart rotation (reset-imminent-first)** — a 60s-tick engine that steers `pause`/`resume`/`default`
  so the account whose window resets soonest is spent first (its remaining quota would otherwise
  expire). Keeps a failover reserve; fail-safe releases everything when off. Fully observable via the
  steering log.
- **Settings** — CLIProxy strategy, session-affinity, client-specific proxy auto-configuration,
  connection snippet, and proxy restart.
- Dark / light.

## Architecture

```
SPA (React + Vite + Tailwind + shadcn)  →  BFF (Express :4400)  →  gateway API (:3000)
                                             ├─ holds gateway session (SPA has no login)
                                             ├─ /api/* passthrough proxy
                                             └─ policy engine daemon (/baton/*)
```

The BFF absorbs gateway auth (cookie + rate-limit), so the SPA is same-origin and login-free.
Migrating the gateway from Docker to native later means changing only `GATEWAY_URL` in `.env`.

## Run

```bash
# 1. configure (gateway location + dashboard credentials)
cp .env.example .env   # edit GATEWAY_URL / GATEWAY_USER / GATEWAY_PASS

# 2. dev (Vite :5173 + BFF :4400, both hot-reload)
npm run dev
#    open http://localhost:5173

# 3. production (single process serves SPA + proxy on :4400)
npm run build
npm start
#    open http://localhost:4400
```

`.env` (gitignored) holds the gateway dashboard username/password the BFF logs in with.

## Layout

- `server/` — BFF: `config`, `gateway-session` (session), `gateway-client` (typed gateway calls),
  `policy-engine` + `baton-routes` (rotation), `index` (proxy + static).
- `src/api/` — typed client + response types.
- `src/hooks/` — visibility-aware polling hooks.
- `src/components/` — UI (shadcn primitives in `ui/`, features alongside).

## Known limitations (v1)

- The rotation policy classifies windows provider-agnostically: any primary window
  (Claude `five_hour`/`seven_day`, Codex `category:'usage'`) that is maxed excludes the
  account; Codex `category:'additional'` sub-quotas (e.g. Codex-Spark) are non-blocking.
- The exhaustion threshold is 95% (leaves a 5% buffer). Tunable — see DESIGN §10-Q1.
- Closing the Add-Account wizard mid-flow logs a benign `404` on `/…/cancel` — the manual
  paste-flow has no server session to cancel. Harmless.
- Codex's usage API is slow (several seconds); quota reads are cached but the first
  policy tick after a cache miss can lag.
