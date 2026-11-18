# CLOUD_MIGRATION_PLAN.md — Atlas Trend, local cron → Qoder Cloud Agents

Status: **draft, not executed** · 2026-11-18 · owner: operator · strategy unchanged (SuperTrend(10,3) v1.0.0)
Scope: move the two scheduled cycles off this Windows machine so they survive the laptop being off. Nothing in `config/`, the strategy, or the account gate changes.

## 1. Goal and non-goals

Goal: the intraday cycle (09:35 ET hourly) and the EOD cycle (16:05 ET) run in Qoder Cloud Agents against paper account 5830107, with the same deterministic runner, the same hard rules, and a durable audit trail.

Non-goals: no new strategy logic, no live trading, no change to risk limits, no second concurrent executor.

## 2. What is already proven

| Fact | Evidence |
|---|---|
| Hosted Moomoo MCP works from a cloud session | `sim_trade_account_list`, `cash_info`, `position_list`, `quote_stock_quote` all `ret_code 0` in session `sess_00vvj7f6roqo0v7mm1f8` |
| Competition account visible in cloud | `5830107` "Moomoo x Qoder AI Paper Trading Agent Challenge", market 100, type 2 |
| All 8 `sim_trade_*` tools exposed (incl. `input_order`) | tool inventory from the same session |
| Credentials can stay in the Vault | session bound to `vault_00vv31hdfn5s09u2oa1c` (`moomoo-mcp`), zero auth errors |
| QCA can schedule cron with a timezone | `create_forward_schedule` → `trigger_policy {type: cron, expression, timezone, start_at, stop_at}` |
| A forward template/agent must supply MCP + Vault + tools | `create_forward_template` accepts `mcp_servers`, `vault_ids`, `github_repositories`, `files`, `tools` |
| Runner has zero npm dependencies | [package.json](file:///C:/Users/behfa/Documents/Qoder/2026-11-16/2000c586/moomoo-trading-agent/package.json) — needs `node >=20` only |

## 2a. Phase 0 result — executed 2026-11-18 14:32Z

Probe agent `agent_00vvk2cl5ci6813bexu2` ("Atlas Trend Runner (paper)"), sessions `sess_00vvk30rty6tcz50awwl` and `sess_00vvk825237r4yuc7do3`:

| Probe | Result |
|---|---|
| Node / npm / git / python | **v22.23.2 / 10.9.8 / 2.34.1 / 3.12.13** |
| Working dir | `/data`, writable (root ext4, no separate volume) |
| Outbound HTTPS | `github.com` → **200** |
| Moomoo MCP + Vault on a Bash-capable agent | **PASS** — `sim_trade_account_list` ret_code 0, 5830107 visible |
| File persistence between two sessions | **ISOLATED** — a file written in session 1 is absent in session 2 |
| Bounded `sim_trade_history_order_list` (3-day window) | **works** — returned all 8 orders with `cum_qty`, `avg_fill_price` |
| `quote_history_kline` in cloud | **works** — 5 daily bars, newest bar flagged partial intraday |

Consequences:
- **Node is not a blocker.** The runner executes in the cloud as-is.
- **The filesystem is not a state store.** Every scheduled session starts empty, so `state.json`, `cycle-state.json`, klines and the `.jsonl` logs must come from outside the sandbox.
- **Klines can be rebuilt in-cloud** via `quote_history_kline`, so the git snapshot does not have to carry market data.
- **Order history is authoritative** for fills, which makes an idempotency guard possible without shared state.

## 3. What is still unproven (these gate everything)

| Unknown | Why it matters | How to settle it |
|---|---|---|
| Is Node present in `env_00vo9r477f66985sihxo`? | No Node = no runner | Phase 0 probe (needs a Bash-capable agent; **the current Atlas Cloud Paper Trader agent has MCP tools only — that is why the probe failed**) |
| Can the image install packages / reach hosts? | env config is `packages: {}`, networking `limited`, `allow_package_managers: false` | second probe + `update_environment` in a **copy** env |
| Do files persist between forward sessions? | `state.json`, `cycle-state.json`, klines, logs must survive | two-session write/read test, or assume ephemeral and use git (§5) |
| What is `identity_id` for a forward schedule? | required field, no list tool exposed | discover from an existing schedule/template or the app UI |

If Phase 0 fails on Node, stop: the no-Bash fallback (LLM builds orders from MCP data) breaks the determinism the Auditor checks, so it is not an acceptable substitute.

## 4. Target architecture

```
Qoder Cloud Agents (forward template "Atlas Trend Runner")
├── environment  env_00vo9r477f66985sihxo (+ nodejs, if missing)
├── MCP          moomoo → https://mcp.moomoo.com/mcp
├── Vault        vault_00vv31hdfn5s09u2oa1c (OAuth, never printed)
├── tools        Bash, Read, Write, Edit, Glob, Grep  +  mcp_toolset
│                trading_order_* / crypto_* = always_deny, sim_trade_* = allow
├── schedules    intraday  cron "35 9-15 * * 1-5" America/New_York
│                eod       cron "5 16 * * 1-5"    America/New_York
│                stop_at   2026-11-28T22:00:00Z
└── workspace    repo checkout → run → commit → push   (durable state, §5)
```

Per run the agent does exactly what the local cycle does: account gate → collect cash/positions/orders/quotes via MCP → write `data/raw/live-input.json` → `node scripts/supertrend-cycle.mjs --mode=…` → submit only `orders[]` → write `reports/exec-results.json` → `record` + `dashboard` → commit.

## 5. State durability — the only real design decision

Phase 0 proved the sandbox is per-session, so state has to live outside it. Two viable paths:

| Path | Durable | Keeps existing code untouched | Needs from you | Risk |
|---|---|---|---|---|
| **A. Git remote (preferred)** — mount the repo in the template, commit+push each run | yes | yes | a private repo URL + a token with contents:rw | PAT lives in the template config, outside the Vault |
| **B. Stateless rebuild** — reconstruct positions, stops and daily order count from `history_order_list` + `quote_history_kline` every run; ship code via template `files` | partial (no local logs) | no — new `rebuild-state.mjs`, and equity/peak history is approximate | nothing | approximations feed the daily-loss and drawdown checks, which fire real flatten orders |

Path B is only acceptable if A is impossible. A wrong reconstructed `dayStart` equity can trigger a false `DAILY_LOSS_HALT` or mask a real one, and no `.jsonl` audit trail survives the session.

Local tooling note: there is **no `gh` CLI and no git remote** on this machine (git 2.52 present, workspace not a repo), so Path A cannot be completed from here without a repo URL and a token.

## 5a. Historical option, rejected by Phase 0

Template `files` snapshots and local-sync uploads were considered: the first is static, the second fails exactly when the laptop is off. `workspace_id` (`ws_00vk2dor79zpcaqnogxg`) is a CAS workspace handle, not a shared volume — two sessions in it did not share files.

## 6. Phases

### Phase 0 — Probe (15 min, no writes to the account)
1. Create agent/template with Bash + moomoo MCP + Vault (`mcp_servers` array + `vault_ids`), no order tools enabled.
2. In one session run: `node -v`, `git -v`, `python3 -v`, `pwd`, `df -h .`, writability test, `curl -o /dev/null -w '%{http_code}' https://github.com` (single attempt).
3. Second session in the same template: read back the probe file → proves persistence.
**Gate:** Node ≥20 present (or installable), and a persistence answer.

### Phase 1 — Package for cloud (1 h)
- `scripts/cloud-cycle.sh` — calls `node` directly, no `momo-node.sh` wrapper, no moomoo CLI.
- `scripts/split-klines.mjs` — takes one combined `{symbol: kline_list}` JSON, writes `data/raw/klines-moomoo/US.<SYM>.json` in the existing shape (confirmed: `{kline_list:[{date,open_price,high_price,low_price,close_price,volume}]}`).
- EOD procedure replaces `scripts/refresh-klines.sh` with 24 `quote_history_kline` MCP calls → combined JSON → `split-klines.mjs`. Keep-last-good-file semantics preserved.
- If Node is missing: `create_environment` (copy of the default) + `update_environment` with `packages.apt: ["nodejs"]`. Config is replaced wholesale, so re-verify MCP reachability in the copy before using it.

### Phase 2 — State store (30 min)
- `git init` + private remote; commit `config/`, `docs/`, `scripts/`, `src/`, `data/` (klines + logs), `.gitignore` excluding `.env*` and `reports/dashboard.png`.
- Run protocol: `git pull --rebase` → execute → `git add -A data reports` → `git commit -m "cycle <ts> <mode>"` → `git push`. Append-only `.jsonl` files stay append-only because commits only add lines.
- **Duplicate-order guard** (new, ~20 lines): before submitting, re-read today's orders via `sim_trade_history_order_list` and skip any plan order whose symbol+side+qty+price already exists today. This makes a retry after a timeout safe.

### Phase 3 — Shadow mode (2 intraday + 1 EOD session)
- Template variant with `ATLAS_SHADOW=1`: the runner writes `reports/cycle-plan.json` but the agent submits nothing.
- Acceptance: shadow plan `orders[]` is identical to the local plan for the same timestamp, or every difference is explained in one line. Logs and commits present.

### Phase 4 — Cutover (at an EOD boundary, ~5 min)
1. 16:05 ET EOD run finishes locally; no resting orders.
2. Pause/disable local automations `1208de8e-d0fd-46aa-9999-5689d410dc74` and `bcf3b210-b523-4cd7-a71e-df1fdbdb57ce`.
3. Enable the two forward schedules (`start_at` now, `stop_at` 2026-11-28T22:00Z).
4. Run one schedule manually (`run_forward_schedule`) and confirm the commit landed.
5. Next morning 09:35 ET: verify the first unattended cloud cycle against the account.

### Phase 5 — Rollback (always available)
`pause_forward_schedule` both → unpause the two local automations → `git reset --hard <last good commit>` in the checkout → reconcile `orders_today` from `sim_trade_history_order_list` before the next local run. The plan never deletes history, so rollback is a pointer move.

## 7. Risk register

| Risk | Mitigation |
|---|---|
| Two executors place duplicate orders | local jobs paused **before** schedules enabled; git push acts as a single-writer lock; Phase 2 idempotency guard |
| Stale klines in cloud → wrong signals | EOD refresh is a hard step; cycle already logs `DATA_INCIDENT` when a bar is missing |
| `update_environment` wipes the networking block (config replaced wholesale) | change a copy environment first, verify MCP, then swap |
| PAT leaks | fine-grained, single-repo, rotate after the competition, never echoed |
| Cloud session dies mid-run after submitting | idempotency guard + `order-sync-check` reconcile; log the incident, no blind retry |
| Only ~7 sessions left in the window | Phase 0 gates everything; if it fails, stay local and finish the competition there |

## 8. Decisions needed from you

- **8a. State store:** approve a private GitHub repo + fine-grained PAT in the forward template (recommended), or accept that cloud runs cannot persist state (which defeats the goal).
- **8b. Environment edit:** approve adding `nodejs` to a copy of `env_00vo9r477f66985sihxo` if Phase 0 finds no Node.
- **8c. Cutover time:** approve pausing both local automations at an EOD boundary — recommended **today 16:05 ET if Phase 0 passes**, otherwise tomorrow EOD. I will not pause them before shadow mode is clean.
- **8d. Order permission in cloud:** confirm `sim_trade_input_order` may be enabled for the cloud agent once shadow mode passes (it is already exposed; it stays unused until cutover).

I will not create the repo, move a PAT, edit the environment, disable the local cron jobs, or submit an order from a cloud session until you answer 8a–8d.

## 9. Cutover record — executed 2026-11-18 15:03–15:07Z

Answers received: 8a approved (repo `wilsonbeh-tech/atlas-trading-cloud`, PAT supplied), 8c/8d approved by "proceed migration and all necessary action". 8b not needed — Node v22.23.2 was already present.

### What was proven before cutover

| Test | Session | Result |
|---|---|---|
| Cloud git push to `main` | `sess_00vvmhczmyubl5nmn2pe` | **PASS** — `d919dc5..46dbbb6`; probe commit removed afterwards |
| Cloud push with no PAT env var | `sess_00vvmokh68a9sglgzi5d` | **PASS** — the image installs a repo-scoped credential helper; branch `probe-no-token` pushed then deleted |
| Shadow cycle (no submit, no commit) | `sess_00vvmgiblvif4ruxbin9` | **PASS** — gate PASS, equity 100,086.725, MSFT 17 stop 449.85, AMZN 29 stop 224.26, `orders: []`, `rejected: []`, exit 0, plan sha256 `c18e8856…` |

### Live resources

| Kind | Id | Notes |
|---|---|---|
| Agent "Atlas Trend Runner (paper)" | `agent_00vvk2cl5ci6813bexu2` v4 | Bash/Read/Write/Edit/Glob/Grep; `sim_trade_input_order` **enabled**; `trading_order_*`, `crypto_*`, `sim_trade_modify/cancel` **denied** |
| Deployment "Atlas Trend Intraday (cloud)" | `dep_00vvmuz2fahvkfrnwjwp` | cron `35 9-15 * * 1-5` America/New_York, active |
| Deployment "Atlas Trend EOD (cloud)" | `dep_00vvmvi1yjgg0ah3dbbw` | cron `5 16 * * 1-5` America/New_York, active |
| Template (unused, superseded by deployments) | `tmpl_bac79a800a1ca032b01515c5` | archived; deployments are the live path (Forward schedules need an `identity_id` this account does not have) |
| Environment / Vault / repo | `env_00vo9r477f66985sihxo`, `vault_00vv31hdfn5s09u2oa1c`, `wilsonbeh-tech/atlas-trading-cloud` | state of record = git `main` |

Both deployments export `ATLAS_CLOUD=1`, which the cycle script now requires; a run without it writes a blocked plan with empty orders and exits 2.

### EOD kline path

`scripts/refresh-klines.sh` needs the local moomoo CLI, so it cannot run in the cloud. Replacement: the EOD run calls `quote_cur_kline {symbol, num: 3, ktype: 2}` for each of the 24 symbols, writes the raw payloads to `data/raw/klines-moomoo/_incoming/US.<SYM>.json`, then runs `node scripts/klines-apply.mjs --require-date <NY date>`. That script upserts bars by date into the committed 370-bar files, refuses to rewrite history with older bars, and exits non-zero unless every symbol reached the requested date.

### Known leftovers

- The two local Qoder automations (`1208de8e-…`, `bcf3b210-…`) are not exposed to any API; they still fire, but the `ATLAS_CLOUD` guard makes each one a no-op that submits nothing. Switch them off in the app UI when convenient.
- The PAT was pasted in plain text into the chat; rotate it after 2026-11-27. It is stored only in the deployment `resources.authorization_token` (never in git).
- Deployments pin agent version 4, so later agent edits do not affect scheduled runs until the deployment is updated.
