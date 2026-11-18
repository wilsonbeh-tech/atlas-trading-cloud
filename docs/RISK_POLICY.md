# Atlas Risk Policy

Version 1.1.0 · applies to the Moomoo x Qoder AI Trading Agent Challenge paper account only.

This policy is enforced in code (`src/lib/risk.js`, `src/lib/allocator.js`, `src/lib/planner.js`) and in the agent skill. Prose and code must agree; if they diverge, the code is authoritative and the discrepancy must be fixed before the next order.

## 1. Non-negotiable limits

| Limit | Value | Enforcement |
| --- | --- | --- |
| Eligible venue | US-listed stocks and ETFs | Universe allow-list; guard rejects outside symbols |
| Minimum price | $1.00 | Guard rejects |
| Instrument eligibility | Liquid large caps only | 20-day dollar volume ≥ $20M and price ≥ $1 |
| Single-name weight | soft 20%, hard **40%** of total assets | Allocator cap; post-trade guard check |
| Open positions | target 8, hard **100** | Planner selection; guard removes excess buys |
| Gross exposure | **90%** | Allocator scale; guard removes buys |
| Cash floor | **10%** of equity | Vol-target scaling and min-cash constraint |
| Orders per day | internal **40**, competition **200** | Stateful daily counter; guard stops at 40 |
| Order type | limit only | `order_type=1`; no market orders |
| Limit price deviation | ≤ **3%** from last price | Guard rejects |
| Trading session | regular session (`order_trade_time_type=1`) | Execution adapter |
| Shorting | prohibited | Guard rejects sell qty > held qty |
| Options / futures / crypto | prohibited | Universe allow-list |
| Account | competition paper only | Title match; `run --execute` aborts without `--allow-dev` |

## 2. Risk ladder

Evaluated at the start of every cycle against `data/state.json` and the current snapshot.

| Trigger | State | Action | Reset |
| --- | --- | --- | --- |
| Daily P&L ≤ **-2.5%** | `FLATTEN` | Sell all long positions, block new buys for the session | Next New York trading day |
| Drawdown ≤ **-8%** from peak | `DE_RISK` | Halve every target weight; gross target ≤45% | Drawdown recovers above -8% |
| Drawdown ≤ **-12%** from peak | `KILL` | Flatten; block new entries for **5 trading days** | `haltUntil` date passes |
| Existing stop hit | `STOP` | Sell the position | Re-entry only after a fresh signal |
| Data/quote failure | `NO_TRADE` | Do not submit; log and retry next cycle | Valid quote restored |

`peakEquity` is the high-water mark of marked equity since the competition start. `dayStartEquity` is the equity at the first cycle of the New York trading day.

### Halt semantics

- `haltUntil` is a New York calendar date computed with `addTradingDays(today, 5)`, skipping weekends.
- While halted, sells and flatten orders are allowed; buys are rejected with `risk halt active (no new buys)`.
- The agent may not clear or shorten a halt manually. Only the passage of time does.

## 3. Position-level exits

1. **Hard stop:** last price ≤ entry × (1 − 15%).
2. **Trailing stop:** last price ≤ peak close − 5 × ATR(14).
3. **Rank exit:** name is no longer in the selected target set.
4. **Trim:** current weight exceeds target by >1.5% of equity.

ATR is captured at entry and refreshed from the latest signal row when the position is recorded. If ATR is unavailable, only the hard stop applies.

## 4. Pre-trade guard sequence

Orders are evaluated in planner order (sells first). For each order:

1. Universe membership.
2. Quote exists, `last_price` finite, not suspended.
3. Price ≥ $1.
4. No duplicate symbol in the plan.
5. Integer quantity > 0.
6. Notional ≥ $500.
7. Daily order count < 40.
8. Limit deviation ≤ 3%.
9. No buys while halted.
10. Post-trade quantity ≥ 0 (no shorting).
11. Post-trade weight ≤ 40%.
12. Projected cash ≥ 0.
13. Projected gross ≤ 90%; otherwise remove buys from the end of the list.
14. Projected long positions ≤ 8; otherwise remove buys from the end of the list.

Rejections never block the rest of the plan. Every rejection is written to `data/rejections.jsonl` with the order, reason and timestamp.

## 5. Execution controls

- Only approved orders from `reports/plan.json` may be submitted.
- One order per `sim_trade_input_order` call; no batching.
- Quantity and price are sent as strings with two decimals for price.
- `text` carries a ≤100-byte reason for the audit trail.
- After submission, the agent writes actual order IDs and statuses to `reports/exec-results.json` and runs `record`; submissions update the daily counter, while only filled rows update position metadata.
- A timeout is not retried blindly: query today's orders first to avoid duplicates.

## 6. Data integrity

- Signals require ≥200 daily bars per symbol and a benchmark with ≥150 bars after warmup.
- A symbol with a stale quote (no regular-session price) is skipped.
- If the snapshot is missing or not from the competition account, the agent runs offline research only and places no orders.
- Klines used for live decisions come from Moomoo MCP. Public Yahoo data is research-only and labeled as such.

## 7. Audit and retention

- `data/decisions.jsonl` — one line per plan/risk/execution event.
- `data/rejections.jsonl` — rejected orders and reasons.
- `data/orders.jsonl` — submitted/non-filled orders with order IDs.
- `data/fills.jsonl` — filled orders with filled quantity and average price.
- `data/equity.jsonl` — marked equity per cycle.
- `data/state.json` — peak, day-start, halt date, position metadata, daily order counts.
- `reports/dashboard.html` — human-readable view of the above.

Logs are append-only JSONL. Do not edit history to improve the narrative; if a mistake is found, add a correcting decision entry.

## 8. Incident procedure

1. Stop submitting new orders.
2. Flatten if the risk ladder requires it; otherwise hold and gather quotes.
3. Record the incident in `data/decisions.jsonl` with `action: "INCIDENT"`, the observed state and the action taken.
4. If the account is not the competition account, abort immediately and notify the operator.
5. Resume only after the next clean cycle passes `selftest` and produces a plan with zero unexplained rejections.
