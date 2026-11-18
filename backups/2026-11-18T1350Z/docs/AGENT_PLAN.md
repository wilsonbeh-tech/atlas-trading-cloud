# AGENT_PLAN.md — Cloud Agents Forward Mode build plan (gated on approval)

Status: **design only. Nothing has been built or scheduled.** The previous local cron is paused (`1208de8e-d0fd-46aa-9999-5689d410dc74`, manual pause). No orders exist.

## 1. Architecture — three agents, one veto

```
                 ┌──────────────────────────────┐
  schedule  ───▶ │  Coordinator (Forward Mode)   │
  (Asia/Singapore)│  enforces the handoff rule    │
                 └───────────────┬──────────────┘
                                 │
        ┌────────────────────────┼────────────────────────┐
        ▼                        ▼                        ▼
  Researcher                Risk Auditor             Executor
  read-only data,           read-only; writes        only agent with
  writes plan.json          verdict.json (APPROVE /  sim_trade_input_order
  no order tools            REJECT / WAIT + reasons) / cancel tools
```

**Coordinator rule (verbatim, non-negotiable):** *never let the Executor act on the Researcher's output without the Auditor's approval.* Implementation: `plan.json` carries a SHA-256; the Auditor writes `verdict.json` containing that hash, an expiry (≤30 min) and per-order decisions; the Executor refuses any order whose plan hash lacks an APPROVE verdict newer than its own run start.

| Agent | Tools | Writes | Forbidden |
|---|---|---|---|
| **Researcher** | quote/cash/position/order read tools, kline CLI, ledger read | `reports/plan.json`, `reports/signals.json` | any `sim_trade_input_order`, any cancel |
| **Risk Auditor** | read-only: plan, account snapshot, limits, ledger | `reports/verdict.json` | all trading tools; may not edit the plan |
| **Executor** | `sim_trade_input_order`, `sim_trade_cancel_order` (account 5830107 only) | `reports/exec-results.json`, `decisions.jsonl` | acting without a valid verdict; retrying a rejected order |

Every run starts with the **account gate**: exactly one account whose title contains "Qoder" and "Challenge"; otherwise INCIDENT + stop. Target account **5830107**; the generic paper account 4666439 is never eligible.

## 2. Forward Mode specifics

- Cloud Agents Forward Mode = persistent agent instances with scheduled sessions and shared resources (vault for credentials, pinned skill, environment). The three roles are separate agents/templates so one prompt-injection in the Researcher cannot reach the trading tools.
- **Vault**: Moomoo credentials/token live in the Forward vault; no token in prompts, logs, repo or chat. The Executor authenticates through the environment, not through text.
- **Pinned skill**: `skills/momo-supertrend/` v1.0.0 (SKILL.md + references/ + scripts/), referenced by **version**, never `latest`; the upstream Moomoo hub reference (if any) is pinned to commit `ec092d2b…` as in the installed Skill.
- **Environment**: one cloud environment with this repo checked out at a tagged commit; forward sessions add the skill and vault, nothing else.

## 3. Schedule (Asia/Singapore, UTC+8) — ET is UTC−5 in November

| Run (SGT) | ET | Purpose |
|---|---|---|
| 20:45 | 07:45 | Pre-market scan: overnight gaps, earnings blackout list, quotes fresh?, account gate |
| 21:30 | 08:30 | Researcher plan for the open (built on yesterday's close) → Auditor → Executor submits entry orders |
| 22:45, 23:45, 00:45, 01:45, 02:45, 03:45 | 09:45–14:45 | Intraday stop/trail checks every hour (30–60 min as required), flatten checks |
| 04:15 | 15:15 | Pre-close: cancel unfilled orders, verify stops, log fills |
| 05:15 | 16:15 | EOD: reconcile positions/orders, mark equity, run `record`, `dashboard`, daily report |

- Days: Mon–Fri only; **no runs 26 Nov** (Thanksgiving). On **27 Nov** the early close (13:00 ET) is **02:00 SGT on 28 Nov**: final review at **01:00 SGT 28 Nov** (=12:00 ET 27 Nov), final exits by **01:45 SGT 28 Nov** (=12:45 ET).
- Because SGT sessions run overnight, the cloud schedule is the reliable executor; the local machine is not required.
- Each session is a fresh run reading the repo state; no memory of the previous conversation is assumed.

## 4. Logging and dashboard

One JSON line per decision in `data/decisions.jsonl`, schema:

```json
{"ts":"...","agent":"researcher|auditor|executor","action":"PLAN|APPROVE|REJECT|ORDER|FILL|SKIP|INCIDENT|HALT",
 "symbol":"US.MSFT","side":"BUY","qty":19,"px":507.00,"stop":451.2,"riskPct":0.98,
 "reason":"flip 9 bars ago, close>200d","planHash":"...","verdict":"APPROVED","equity":100000}
```

- Rejections and skip decisions go to `rejections.jsonl` with a one-line reason (no silent decisions).
- `reports/dashboard.html` regenerated after every run (existing `bash scripts/momo-node.sh src/cli.js dashboard`), including the daily competition-return strip.
- Daily report at 05:15 SGT: equity, positions with stops, orders, rejections, regime, remaining competition days, next actions. Delivered in the run output; Slack delivery only if the user provides an app/webhook, and the token goes in the vault, never in text.

## 5. Change control and backups

- Before any change to config/docs/code: dated snapshot `backups/2026-11-18T<HHMM>Z/` containing `config/`, `skills/`, `docs/`, `AGENTS.md`, plus a `MANIFEST.sha256`.
- New config file `config/supertrend.json` (does not edit the existing `config/strategy.json` risk limits — the audit trail of the old strategy stays intact).
- Restore = copy the dated folder back and verify `sha256sum -c MANIFEST`.
- `AGENTS.md` gains a header block on build:

```
## Active agent configuration
- configured_at: 2026-11-18T__:__Z (UTC)
- strategy: Atlas Trend (SuperTrend 10,3) v1.0.0
- agents: researcher=<id>, auditor=<id>, executor=<id>
- cloud/forward version: <version returned by the platform>
- schedule: Asia/Singapore, see docs/AGENT_PLAN.md §3
- skill: skills/momo-supertrend v1.0.0 (pinned)
- limits: 1% risk/trade, 12%/name, 6 positions, 72% gross, −1.5% daily halt, −4% de-risk, −6% kill
```

IDs and version are filled from the platform response at build time — not invented now.

## 6. Build checklist (runs only after "Yes")

1. Dated backup + manifest.
2. `config/supertrend.json` + `scripts/supertrend-signals.mjs` (deterministic, unit-tested against the research harness on the same bars).
3. `skills/momo-supertrend/` v1.0.0 with SKILL.md, references (signal spec, runbook, limits), scripts; package zip built; version pinned.
4. Create Forward environment, vault entry, three agents/templates, schedules; record the returned IDs in AGENTS.md.
5. Dry run (Researcher + Auditor only) → compare plan against the manual 17 Nov signal (MSFT, AMZN) and risk table.
6. Acceptance: `selftest`, `snapshot-check`, reconciliation of 0/0, dashboard renders; then and only then enable the Executor schedule.
7. Report the first live plan before any order is submitted, if the user asked for a confirmation step on the first trade.

## 7. Rollback

Disable the three schedules → cancel DAY orders → keep positions with manual stops → restore the dated backup → re-enable the old cron only on explicit request. Rollback never deletes `data/*.jsonl`.
