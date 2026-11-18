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

| Field | Value |
|---|---|
| Configured at | 2026-11-18T13:56Z by the operator session (agent:default) |
| Strategy config | `config/supertrend.json` v1.0.0 (new; `config/strategy.json` unchanged) |
| Runner | `scripts/supertrend-cycle.mjs` (deterministic; decisions traceable to spec) |
| Intraday job | `Atlas Trend Intraday (hourly)`, id `1208de8e-d0fd-46aa-9999-5689d410dc74`, cron `35 14-20 * * 1-5` UTC |
| EOD job | `Atlas Trend EOD stop recompute`, id `f59ee3d2-dfab-42b8-9e09-ae547933a0db` (recreated 2026-11-18T14:39Z after the prior job id was deleted externally), cron `5 21 * * 1-5` UTC |
| Expiry | 2026-11-28T22:00:00Z |
| Permissions | Full Access (bypassPermissions), local execution, independent conversations |
| Backup | `backups/2026-11-18T1340Z/` (AGENTS.md, strategy.json, docs, prior cron job) |

## If blocked

Write an `INCIDENT` decision and report the exact failing step. Do not improvise a different account, data source or order type to "make progress".
