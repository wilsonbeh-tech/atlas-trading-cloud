# Running Atlas as a Qoder Cloud Agent

Atlas ships in two layers:

1. **Deterministic core** (`src/`) — identical offline and online.
2. **Agent skill** (`skills/momo-momentum/`) — the loop, account gate, MCP calls and audit handoff.

The Cloud Agent uses layer 2 to drive layer 1. The local Qoder client and the cloud workspace have **separate** Moomoo authorizations; a token from one cannot be pasted into the other.

## 1. Prerequisites

- A Qoder Cloud Agent workspace with this repository.
- Node 20+ in the workspace (or use the `scripts/momo-node.sh` fallback).
- Moomoo MCP connector authorized **in that workspace**. Complete OAuth in the browser; never paste the token into a prompt or commit it.
- The competition paper account joined and visible to `sim_trade_account_list`. If it is not listed, the agent must stop; see [TROUBLESHOOTING.md](TROUBLESHOOTING.md).

## 2. Environment

Preferred: set `MOOMOO_MCP_URL` and `MOOMOO_MCP_TOKEN` as Cloud secrets/Vault entries. Then the deterministic HTTP broker can submit orders directly:

```bash
node src/cli.js fetch
node src/cli.js signals
node src/cli.js run --execute
```

If the workspace exposes Moomoo only as **tools** (no HTTP token), do not create a token by hand. Use the agent-mediated path: the agent calls `sim_trade_*`, writes `data/raw/live-input.json`, runs `import-live` + `plan`, submits approved orders, writes `reports/exec-results.json`, then runs `record`.

## 3. Scheduled task prompt

Use Forward Mode / scheduled tasks with a weekday cadence. A 30-minute cadence during the US regular session is enough because entries are rebalanced every 10 trading days; stops and the daily-loss check run every cycle.

```
You are Atlas, the paper-trading agent for the Moomoo x Qoder AI Trading Agent Challenge.
Work only in the competition paper account. Never place a live order.

Every run:
1. Read config/strategy.json and skills/momo-momentum/SKILL.md.
2. Call sim_trade_account_list. Find the account whose title contains "Qoder", "Trading",
   "Agent" and "Challenge". If it is absent, STOP and report the blocker. Do not use any
   other account.
3. Pull sim_trade_cash_info, sim_trade_position_list and quote_stock_quote for every
   symbol in the config/supertrend.json sector map (27 today: 24 core + US.SH, US.SQQQ,
   US.QID inverse sleeve). Write data/raw/live-input.json with account, cash, positions, quotes
   and today's order count.
4. Run: node src/cli.js import-live && node src/cli.js signals && node src/cli.js plan
5. Read reports/plan.json. If approved is empty, log the no-op and finish.
6. For each approved order, call sim_trade_input_order with:
   acc_id=<competition account>, market=100, symbol=<US.SYM>, order_type=1,
   order_side=1 for BUY or 2 for SELL, qty=<string>, price=<2dp string>,
   order_trade_time_type=1, text=<reason, max 100 bytes>.
7. Write the returned order IDs and statuses to reports/exec-results.json, then run
   node src/cli.js record --results reports/exec-results.json.
8. Run node src/cli.js dashboard. Post a short summary: regime, equity, targets,
   approved/rejected counts, orders submitted, kill-switch state.
9. If any order times out, query today's orders before retrying. Never resubmit blindly.
10. Never change risk limits, never trade a symbol outside the universe, never use market
    orders, and never exceed 40 orders in a day.

Schedule: every 30 minutes, Monday-Friday, 09:35-15:55 America/New_York.
Skip runs outside the regular session. The competition window is 04:00-20:00 ET but
Atlas uses regular-session orders for predictable fills.
```

## 4. Risk auditor pattern (optional)

For higher assurance, split the run into two agents:

- **Planner** — steps 1–5, produces `reports/plan.json`, places nothing.
- **Risk auditor** — independently re-reads `plan.json`, `signals.json`, positions and state, and verifies every approved order against `docs/RISK_POLICY.md`. It may veto the whole plan but not widen a limit.
- **Executor** — submits only orders carrying the auditor's approval marker, then records fills.

This maps directly to the 30% "strategy & risk design" and 30% "Qoder/Cloud Agent usage" criteria: the cloud workflow demonstrates multi-agent separation of duties, not just a cron job.

## 5. Slack notifications

After step 8, send one message:

```
Atlas 2026-11-16 10:35 ET
Regime: RISK_ON | Equity: $100,000.00 | DD: 0.0%
Targets: XLV 20.0%, V 20.0%, LLY 16.9%, AAPL 14.0%, XLF 10.9%, MSFT 8.2%
Orders: 6 approved / 0 rejected / 6 submitted | Cash: 12.1%
Kill switch: clear
Dashboard: reports/dashboard.html
```

Keep it short; the dashboard carries the detail. Never include tokens or full account numbers.

## 6. Failure handling

| Failure | Action |
| --- | --- |
| Competition account absent | Stop; notify operator; place no orders |
| MCP authorization expired | Stop; re-run OAuth in the cloud workspace; do not attempt a local token |
| Quote stale / missing | Skip the symbol; plan with the rest |
| Order timeout or unknown result | Query today's orders; cancel duplicates if any; log `INCIDENT` |
| Daily order cap reached | Stop submitting; finish the cycle |
| Kill switch active | Flatten if not already flat; no buys until `haltUntil` passes |
| State file missing/corrupt | Do not trade; restore from backup or reset with operator approval |

## 7. Why this counts as Cloud Agent usage

- The skill is reusable and broker-thin; any agent with Moomoo tools can run it.
- The scheduled loop runs without a human in the inner loop, but every order is gated by deterministic code.
- The planner/auditor/executor split demonstrates orchestration and separation of duties.
- All artifacts (decisions, rejections, fills, dashboard) are produced by the same pipeline locally and in the cloud, so results are reproducible.
