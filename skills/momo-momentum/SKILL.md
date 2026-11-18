---
name: momo-momentum
description: Run the Atlas dual-momentum paper-trading loop for the Moomoo x Qoder AI Trading Agent Challenge. Use when asked to trade the competition paper account, rebalance the momentum book, check risk limits, or produce the daily decision log and dashboard. Enforces the competition account gate, deterministic guardrails and paper-only execution.
---

# Atlas Dual-Momentum Paper Trading

A broker-thin, deterministic momentum agent. You are the orchestrator and broker adapter; the filesystem is the audit trail; `src/lib/risk.js` is the final authority on every order.

## Invariants — never violate

1. **Paper only.** Use `sim_trade_*` tools exclusively. No live trading tool, ever.
2. **Competition account only.** The account title must contain `Qoder` and `Challenge` (case-insensitive). If absent, stop and report; never substitute the generic US paper account.
3. **No limit changes.** Do not edit `config/strategy.json` risk limits, do not bypass guardrails, do not widen the 3% limit-price band.
4. **No ad-hoc symbols.** Trade only the 24 symbols in `config/strategy.json`.
5. **No shorts, options, futures, crypto or market orders.** Limit orders (`order_type=1`) only.
6. **≤40 orders/day internally, ≤200 by rule.** Never reset or fake `state.dailyOrders`.
7. **Every order has a reason** in `text` (≤100 bytes), and every submission is recorded.
8. **Do not retry blindly.** On timeout, query today's orders first.

## Preconditions

- Repository root contains `config/strategy.json`, `src/cli.js`, `skills/momo-momentum/`.
- Node 20+ is available. If `node` is missing, use `scripts/momo-node.sh` (or `.cmd` on Windows).
- `data/raw/klines/*.json` exists for all 24 symbols. If not, run `scripts/momo-node.sh scripts/fetch-yahoo.mjs` for research-grade history, or fetch 370 bars per symbol with `quote_history_kline` (`ktype=2`).
- The competition account is joined and switched on in the Moomoo app. The paper-trading window is **17–28 Nov 2026** (submit by 30 Nov); the dedicated account tab is provisioned for approved participants. Before 17 Nov it may not exist, so the account gate will correctly fail.

## Cycle procedure

### Step 1 — Account gate

Call `sim_trade_account_list` with no arguments.

- Scan `data.accounts[].account_title` for both tokens (`Qoder`, `Challenge`).
- If exactly one matches, use its `account_id` and `market_id` (expect `100`) for the cycle.
- If none match: **stop**. Write a decision `{action:"INCIDENT", summary:"competition account not visible"}` and report to the operator. Do not use any other account.
- If several match, stop and ask the operator which one is the competition book.

### Step 2 — Read live state

Call, for the competition account:

- `sim_trade_cash_info` — `acc_id`
- `sim_trade_position_list` — `acc_id`, `market`
- `quote_stock_quote` — `code_list` = the 24 universe symbols
- `sim_trade_history_order_list` — today's orders (use it to count orders already submitted and to detect open orders; a symbol with a non-terminal order is skipped this cycle to prevent duplicates)

Write `data/raw/live-input.json` with this shape (raw payloads are accepted):

```json
{
  "source": "mcp-agent",
  "account": { "account_id": "…", "account_title": "…", "market_id": 100 },
  "cash": { "total_asset": "…", "balance": "…", "long_mv": "…", "short_mv": "…" },
  "positions": [ … ],
  "quotes": [ … ],
  "open_orders": [ … ],
  "orders_today": 0
}
```

`positions` and `quotes` may be the raw `data.positions` / `data.quote_list` arrays. Keep `orders_today` equal to the number of orders already submitted today; the guard adds to it.

### Step 3 — Normalize, score, plan

```bash
scripts/momo-node.sh src/cli.js import-live
scripts/momo-node.sh src/cli.js signals
scripts/momo-node.sh src/cli.js plan
```

`import-live` marks the snapshot `isCompetition` only if the title matches. If it prints a development warning, **do not execute** — return to Step 1.

Read `reports/plan.json`. Print:

- regime and reasons
- equity, cash, drawdown, daily P&L
- target weights
- approved orders and rejected orders with reasons
- projected gross, positions, cash, orders today

If `approved` is empty, log the no-op and finish the cycle.

### Step 4 — Human-visible order table

Before submitting, restate the approved orders in a compact table: side, symbol, qty, limit, notional, reason, post-trade weight. This is the last checkpoint if the operator is watching.

If any order looks wrong (symbol not in the universe, price off by >3%, qty implausible), do **not** submit; re-read the snapshot and re-plan.

### Step 5 — Submit

For each approved order, call `sim_trade_input_order` exactly once:

```
acc_id: <competition account_id>
market: <account market_id, usually 100>
symbol: US.XXX
order_type: 1
order_side: 1 (BUY) or 2 (SELL)
qty: "<integer string>"
price: "<2-decimal string>"
order_trade_time_type: 1
text: "<reason, max 100 bytes>"
```

Wait for each response before the next call. Record `order_id` from `data.order_id` (or `data.orderId`).

### Step 6 — Record submissions and fills

Write `reports/exec-results.json` with the actual status returned by the broker:

```json
[
  { "symbol": "US.XLV", "side": "BUY", "qty": 105, "price": 189.13,
    "order_id": "123456789", "status": "SUBMITTED",
    "reason": "add to target 20% (rank-driven rebalance)" }
]
```

Then:

```bash
scripts/momo-node.sh src/cli.js record --results reports/exec-results.json
```

The command classifies each row by `status`:

- `SUBMITTED` / not filled → appends `data/orders.jsonl` and increments `state.dailyOrders` once per new order ID. It does not touch position metadata.
- `FILLED` / `PARTIALLY_FILLED` with a filled quantity → appends `data/fills.jsonl` and updates position metadata (entry, peak, ATR). It does not double-count an order already in `dailyOrders`.

Submitted orders are never written to `data/fills.jsonl`.

### Step 7 — Report

```bash
scripts/momo-node.sh src/cli.js dashboard
```

Post a short summary to the operator/Slack:

```
Atlas <date time ET>
Regime: RISK_ON | Equity: $… | DD: …% | Day P&L: …%
Targets: …
Orders: X approved / Y rejected / Z submitted | Cash: …% | Gross: …%
Kill switch: clear | Halt until: —
```

Never include tokens or full account numbers.

## Risk state machine (authoritative summary)

| Trigger | Action |
| --- | --- |
| Daily P&L ≤ -2.5% | Flatten; no new buys today |
| Drawdown ≤ -8% | Halve target weights |
| Drawdown ≤ -12% | Flatten; no new buys for 5 trading days |
| Stop loss -15% | Sell position |
| Trailing stop 5×ATR(14) | Sell position |
| Rank exit | Sell position |
| Trim band 1.5% | Only trade if target differs by >1.5% of equity |

The full list of 14 pre-trade guard checks is in `references/risk-policy.md`.

## Failure handling

| Failure | Action |
| --- | --- |
| Account gate fails | Stop; log `INCIDENT`; no orders |
| MCP auth error | Stop; re-authorize in this environment; never reuse a token from another |
| Missing/stale quote | Skip the symbol; plan with the rest |
| `import-live` warns "development" | Do not execute |
| Order timeout | Query today's orders; cancel duplicates; log `INCIDENT` |
| Daily cap reached | Stop submitting |
| Kill switch active | Flatten if needed; no buys until `haltUntil` |

## What not to do

- Do not edit `data/state.json` to clear a halt or lower the order count.
- Do not edit `data/fills.jsonl` or `data/decisions.jsonl`; append corrections instead.
- Do not run `run --execute` with `--allow-dev` against the competition book or vice versa.
- Do not compute signals from a different data source during live execution; live decisions use Moomoo quotes and Moomoo daily bars.
- Do not claim fills that Moomoo did not acknowledge.

## References

- `references/strategy.md` — signal, ranking, regime, sizing, stops
- `references/risk-policy.md` — all limits and the 14 guard checks
- `references/decision-log.md` — JSONL schemas and audit procedure
- Repository `README.md`, `docs/RISK_POLICY.md`, `docs/DECISION_LOG.md`, `docs/CLOUD_AGENT.md`
