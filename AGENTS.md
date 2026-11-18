# Agent Instructions — Atlas Trend (paper)

Read `docs/STRATEGY_SPEC.md` and `config/supertrend.json` before acting. The primary strategy is **Atlas Trend SuperTrend(10,3) v1.0.0**.

## Hard rules

1. **Paper only.** Never call a live trading tool. Use `sim_trade_*`.
2. **Competition account only.** The account title must contain `Qoder` and `Challenge` (id 5830107, market 100). If absent, stop and report. Never trade the generic US margin paper account (4666439).
3. **Do not edit risk limits** in `config/strategy.json` or `config/supertrend.json`, and do not bypass the limits enforced by `scripts/supertrend-cycle.mjs`.
4. **Do not edit historical logs.** `data/*.jsonl` is append-only. Do not reset `data/state.json` or `data/cycle-state.json`.
5. **Limit orders only** (`order_type=1`), integer quantities, ≤3% from last price, ≤12 orders/day.
6. **No shorts, options, futures or crypto.** No symbols outside the 24-symbol universe.
7. **No new positions after the 2026-11-25 close.** Everything flat by 2026-11-27 12:45 ET.
8. **Never print, commit or send tokens.** OAuth belongs in the environment/Vault.

## Commands

```bash
bash scripts/momo-node.sh scripts/supertrend-cycle.mjs --mode=intraday   # manage exits, execute EOD plan
bash scripts/momo-node.sh scripts/supertrend-cycle.mjs --mode=eod        # reconcile, ratchet stops, plan next session
bash scripts/refresh-klines.sh                                           # 24 symbols via quote-only CLI
bash scripts/momo-node.sh src/cli.js record --results reports/exec-results.json
bash scripts/momo-node.sh src/cli.js dashboard
```

Windows: `scripts\momo-node.cmd`.

## Daily loop (competition window 17–28 Nov 2026)

1. Account gate via `sim_trade_account_list`.
2. Pull cash, positions, quotes and order count; write `data/raw/live-input.json`.
3. Run the cycle script for the current mode. It writes `reports/cycle-plan.json` (`orders`, `rejected`, risk state).
4. Submit only `orders` from the plan, one by one, via `sim_trade_input_order`. Never invent or retry orders.
5. Write `reports/exec-results.json`; run `record --results …`; run `dashboard`.
6. Report equity, positions with stops, submitted orders, skips, risk state, blockers.

## Automation config record

**Primary executor since 2026-11-18T15:07Z: Qoder Cloud Agents deployments.** State of record is the git remote `wilsonbeh-tech/atlas-trading-cloud` (`main`); every run pulls, runs and pushes.

| Field | Value |
|---|---|
| Configured at | 2026-11-18T15:07Z by the operator session (cloud cutover) |
| Strategy config | `config/supertrend.json` v1.0.0 (`config/strategy.json` unchanged) |
| Runner | `scripts/supertrend-cycle.mjs` (requires `ATLAS_CLOUD=1`; without it the run is blocked with an empty plan) |
| Cloud agent | `Atlas Trend Runner (paper)` `agent_00vvk2cl5ci6813bexu2` v4 — `sim_trade_input_order` allowed, all other order/crypto tools denied |
| Intraday deployment | `Atlas Trend Intraday (cloud)` `dep_00vvmuz2fahvkfrnwjwp` — cron `35 9-15 * * 1-5` America/New_York |
| EOD deployment | `Atlas Trend EOD (cloud)` `dep_00vvmvi1yjgg0ah3dbbw` — cron `5 16 * * 1-5` America/New_York; refreshes klines via MCP + `scripts/klines-apply.mjs` |
| Environment / Vault | `env_00vo9r477f66985sihxo` / `vault_00vv31hdfn5s09u2oa1c` |
| Local automations (switched off) | `1208de8e-d0fd-46aa-9999-5689d410dc74` (intraday) and `f59ee3d2-dfab-42b8-9e09-ae547933a0db` (EOD) — disabled in the app UI on 2026-11-18T15:19Z (`enabled=0`, `pauseReason=manual`, no next run). `bcf3b210-b523-4cd7-a71e-df1fdbdb57ce` was already off. The `ATLAS_CLOUD` guard stays as a second lock if any of them is re-enabled |
| Expiry | Last session 2026-11-27; stop the cloud deployments then |
| Backup | `backups/2026-11-18T1340Z/` (AGENTS.md, strategy.json, docs, prior cron job) |

## If blocked

Write an `INCIDENT` decision and report the exact failing step. Do not improvise a different account, data source or order type to "make progress".
