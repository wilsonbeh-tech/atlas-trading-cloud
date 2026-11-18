# Risk Policy Reference

Authoritative implementation: `src/lib/risk.js`, `src/lib/allocator.js`, `src/lib/planner.js`. This document must match the code; if it does not, fix the code or the document before trading.

## Hard limits

| Limit | Value |
| --- | --- |
| Venue | US-listed stocks/ETFs only |
| Minimum price | $1.00 |
| Universe | 24-symbol allow-list in `config/strategy.json` |
| Single-name weight | soft 20%, hard 40% of total assets |
| Open positions | target 8, guard limit 8, competition cap 100 |
| Gross exposure | 90% |
| Cash floor | 10% |
| Orders/day | internal 40, competition 200 |
| Order type | limit only |
| Limit deviation | ≤3% from last price |
| Session | regular (`order_trade_time_type=1`) |
| Shorting | prohibited |
| Options/futures/crypto | prohibited |
| Account | competition paper only |

## Risk ladder

| Trigger | Action |
| --- | --- |
| Daily P&L ≤ -2.5% | Flatten; no buys for the rest of the New York day |
| Drawdown ≤ -8% | Halve target weights |
| Drawdown ≤ -12% | Flatten; no new entries for 5 trading days |
| Stop loss -15% | Sell position |
| Trailing stop 5×ATR(14) | Sell position |
| Rank exit | Sell position |

- `peakEquity` = high-water mark of marked equity.
- `dayStartEquity` = equity at the first cycle of the New York day.
- `haltUntil` is set with `addTradingDays(today, 5)` and cannot be cleared manually.
- While halted, sells are allowed; buys are rejected.

## The 14 guard checks

Evaluated in order, sells first, on every order:

1. Symbol is in the universe.
2. Quote exists, `last_price` is finite, security is not suspended.
3. Price ≥ $1.
4. No duplicate symbol in the same plan.
5. Quantity is a positive integer.
6. Notional ≥ $500.
7. Daily order count < 40.
8. Limit price within 3% of last price.
9. No BUY while halted.
10. Post-trade quantity ≥ 0 (no shorting).
11. Post-trade weight ≤ 40% of equity.
12. Projected cash ≥ 0.
13. Projected gross ≤ 90%; otherwise remove buys from the end of the list.
14. Projected long positions ≤ 8; otherwise remove buys from the end of the list.

A rejected order never blocks the rest of the plan. Every rejection is written to `data/rejections.jsonl`.

## Sizing and stops

- Portfolio vol target 18% annualized, min gross 30%, max gross 90%.
- Per-name soft cap 20%, hard 40%.
- Entry stop -15%; trailing 5×ATR below peak close.
- Rebalance band 1.5% of equity; cadence 10 trading days.
- Limit offset 0.15%, rounded to 2 decimals.
- Minimum order notional $500.

## Execution controls

- Submit only orders in `reports/plan.json` `approved`.
- One `sim_trade_input_order` call per order.
- On timeout: query today's orders, cancel duplicates, log `INCIDENT`; never resubmit blindly.
- After submission, write `reports/exec-results.json` and run `record`.
- Never edit `state.json` to clear a halt or lower the daily count.

## Account gate

The only eligible account title contains the tokens `Qoder` and `Challenge` (case-insensitive). If no such account appears in `sim_trade_account_list`, stop. Do not use the generic US margin paper account.

## Incident procedure

1. Stop submitting.
2. Flatten if the ladder requires it; otherwise hold and gather quotes.
3. Append `{action:"INCIDENT", summary, observed, action}` to `data/decisions.jsonl`.
4. If the account is not the competition account, abort and notify the operator.
5. Resume only after `selftest` passes and a clean plan has no unexplained rejections.
