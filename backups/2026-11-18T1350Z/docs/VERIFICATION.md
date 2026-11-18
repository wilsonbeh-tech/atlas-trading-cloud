# VERIFICATION.md — Step 0 gate (no trades placed)

Recorded 2026-11-18 ~13:05Z (09:05 ET) from live Moomoo MCP + CLI calls. Account: **5830107 — "Qoder AI Trading Agent Challenge"** (market 100, US margin paper). The generic "US Margin Account [Paper Trading]" (4666439) was never touched.

## 0.1 Current account state (live)

| Item | Value | Source |
|---|---|---|
| Cash (balance) | **$100,000.00** | `sim_trade_cash_info` after cancels |
| Hold (reserved for open orders) | $0.00 | same |
| Long market value | $0.00 | same |
| Total assets | $100,000.00 | same |
| Positions | **none** | `sim_trade_position_list` → `[]` |
| Fills so far | **none** | `sim_trade_history_order_list` (17–18 Nov): 6 orders, all `cum_qty 0`, status 2 |
| Working orders | **0** (6 cancelled today, see 0.2) | same |

## 0.2 Orders that existed before this plan

At 12:37Z today the hourly Atlas cycle left **six working DAY limit BUYs** (3249211–3249216: XLV 107@185.52, V 47@417.40, LLY 11@1417.67, AAPL 39@352.44, XLF 190@57.16, MSFT 16@507.00 — $87,786 reserved). They had not filled, but would have filled at the 14:30Z open.

Action taken to honour "no trade until the final plan is approved":
- Cancelled all six (`sim_trade_cancel_order`, all `ret_code 0`).
- Disabled cron **1208de8e-d0fd-46aa-9999-5689d410dc74** ("Atlas Paper Trading Cycle", manual pause, `enabled:false`, nextRunAt null).
- Logged `RISK_ACTION` in `data/decisions.jsonl`; verified cash back to $100,000, hold $0, positions 0.

No trade was placed, modified upward, or filled. Re-enable the cron only after approval (or delete it in favour of the new agent).

## 0.3 What the competition account accepts (a)

Evidence is mixed between what the handbook *permits* and what the sim MCP *can execute*:

| Instrument / order type | Status | Evidence |
|---|---|---|
| US stocks / ETFs, cash account, long only | **Verified working** | 6 limit BUYs accepted, status 2, order_type 1, regular-hours flag 1 |
| Limit orders, DAY, whole shares | **Verified** | above; `time_in_force 0` |
| Market orders | Not used; project policy is limit-only | — |
| Short selling | Handbook permits; **our rules forbid** | brief + project policy |
| Options | **Ambiguous → excluded (stock-only fallback)** | Handbook lists options as eligible, but the Moomoo MCP exposes **no options order tool** (no option-chain-to-sim path, `sim_trade_input_order` is stock-shaped) and the FAQ confirms **no historical options data**. Per brief: "if unclear, reject options and use a stock-only fallback." |
| Pre/post-hours (04:00–20:00 ET per handbook) | Available but **not used** | `quote_stock_quote` returns pre/after/overnight blocks; handbook permits extended sessions |
| Leveraged/inverse ETFs | Tradable in principle; **excluded by strategy choice** (G) | brief constraints |

Handbook limits that bind the plan: $1 min price, ≥$500M market cap, ≤200 executed orders/day, ≤100 positions, stock/ETF ≤40% of initial assets per name, $0.99/order + SEC fee on sold shares (cap $8.30), paper fills need market volume (volume×20 < qty → possible partial fill), final scoring at the **regular close of the last day**.

## 0.4 US market calendar 18–28 Nov 2026 (c)

`quote_trading_days` (US): 18 WHOLE, 19 WHOLE, 20 WHOLE, 23 WHOLE, 24 WHOLE, 25 WHOLE, **26 closed (Thanksgiving)**, **27 MORNING (early close 13:00 ET)**, 28 closed (Saturday).

Remaining competition sessions: **7** — 18, 19, 20, 23, 24, 25, 27 Nov. 17 Nov (day 1) is already closed with the account flat, so the race starts at 0.00%.

## 0.5 Earnings calendar for candidates (d)

Source: Moomoo news feed (Benzinga / MT Newswires / Futunn). The Moomoo MCP has **no earnings-calendar tool**, so these are news-verified, not IR-verified.

| Date | Name | Timing | Result / expectation | Live pre-market (13:00Z 18 Nov) |
|---|---|---|---|---|
| Tue 17 Nov | HD | pre-open | Beat: rev $43.4B vs $42.8B, EPS $3.86 vs $3.84; CFO change announced | −0.9% |
| Tue 17 Nov | DIS | pre-open | Beat: EPS $1.77 vs $1.68, rev $25.95B vs $25.16B; SVOD OI doubled | +0.7% |
| Tue 17 Nov | NVDA | after close | Beat; stock +2.7% pre-market, +4.8% after-hours print | **+2.7%** |
| **Wed 18 Nov** | LOW | 06:00 ET | Consensus EPS $2.86–2.88 (−7% y/y), rev $223.8B; Stifel cut to Sell | **−4.0%** |
| **Wed 18 Nov** | TGT | 06:30 ET | Consensus EPS ~$2.04–2.06, rev $264–265B; options imply ±8.2% | −0.6% |
| **Wed 18 Nov** | TJX | 07:30 ET | Consensus EPS $1.33, rev $158.4B; 8/8 beats | **+4.9%** |
| **Wed 18 Nov** | PANW | 16:05 ET (after close) | Consensus EPS $0.97, rev $3.31B; options imply **±10.1%** | +1.2% |
| Thu 19 Nov | WMT | pre-open | Consensus EPS $0.63–0.64, rev ~$187.2B; last quarter fell 8.9% on a beat | −1.3% |

Implication for the plan: **no new position in PANW or WMT before their prints**; TGT/LOW/TJX reactions are today (no entry — gap not confirmed until the close). NVDA is the only confirmed positive catalyst, but it trades below its 200-day and its SuperTrend is DOWN, so it is not eligible for the primary trend system.

## 0.6 Conflicts and assumptions (must be explicit)

1. **Session times conflict.** The brief says paper fills only in the regular session; the handbook says 4:00–20:00 ET trading. Decision: submit only `order_trade_time_type=1` (regular hours) so both rules are satisfied. Costs one pre-market edge; removes a class of rejected-order risk.
2. **Options conflict.** Handbook permits them; the sim MCP cannot verify price, chain or execution, and there is no historical options data. Decision: stock/ETF only. **Confirmed by the account owner on 2026-11-18.** If a working options path is later demonstrated, H is re-evaluated, not before.
3. **Backtest data.** Moomoo `quote_history_kline` daily bars are **forward-adjusted** (autype 1), 370 bars max (30 May 2025 → 17 Nov 2026). Adjusted prices are consistent for indicators and stops but are not the literal trade prices of past days. All backtests use next-open fills, 5 bps slippage, $0.99/order and the SEC sold-share fee.
4. **No historical fill simulation.** The paper engine matches against volume (volume×20); our backtest assumes full fills at open±slippage. Real partial fills are handled in the runbook, not modelled.
5. **Estimates vs tested.** Everything in STRATEGY_ANALYSIS marked "backtest" was computed on the 160-session Moomoo window (2026-04-01 → 2026-11-17). Everything about the next 7 sessions is an estimate from that window's distribution, not a forecast.

## 0.7 Gate verdict

- Instruments verified: stocks/ETFs, limit DAY, regular hours, long-only, no options.
- Account verified flat and funded at $100,000; nothing working; nothing filled.
- Calendar and earnings verified sufficiently to write a plan.
- **Step 0 complete. Step 1 and Step 2 are in STRATEGY_ANALYSIS.md. No order may be submitted until the user approves the final plan.**
