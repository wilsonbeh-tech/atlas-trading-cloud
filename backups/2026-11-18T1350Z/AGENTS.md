# Agent Instructions — Atlas Paper Trading

Read `README.md`, `docs/RISK_POLICY.md` and `skills/momo-momentum/SKILL.md` before acting.

## Hard rules

1. **Paper only.** Never call a live trading tool. Use `sim_trade_*`.
2. **Competition account only.** The account title must contain `Qoder` and `Challenge`. If it is absent, stop and report. Never trade the generic US margin paper account.
3. **Do not edit risk limits** in `config/strategy.json`, and do not bypass `guardOrders`.
4. **Do not edit historical logs.** `data/*.jsonl` is append-only.
5. **Do not reset state** (`data/state.json`) to clear a halt or daily order count.
6. **Limit orders only** (`order_type=1`), integer quantities, ≤3% from last price, ≤40 orders/day.
7. **No shorts, options, futures or crypto.** No symbols outside the 24-symbol universe.
8. **Never print, commit or send tokens.** OAuth belongs in the environment/Vault.

## Commands

```bash
scripts/momo-node.sh src/cli.js selftest
scripts/momo-node.sh src/cli.js signals
scripts/momo-node.sh src/cli.js plan
scripts/momo-node.sh src/cli.js backtest
scripts/momo-node.sh src/cli.js dashboard
```

Windows: `scripts\momo-node.cmd`.

## Daily loop (competition window 17–28 Nov 2026)

1. Account gate via `sim_trade_account_list`.
2. Pull cash, positions, quotes and order count; write `data/raw/live-input.json`.
3. `import-live` → `signals` → `plan`.
4. Submit only `reports/plan.json` approved orders via `sim_trade_input_order`.
5. Write `reports/exec-results.json`; run `record --results …`.
6. Run `dashboard`; report regime, equity, approved/rejected, submitted, halt state.

## If blocked

Write an `INCIDENT` decision and report the exact failing step. Do not improvise a different account, data source or order type to "make progress".
