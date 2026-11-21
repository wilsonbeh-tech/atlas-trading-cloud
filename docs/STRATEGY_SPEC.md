# STRATEGY_SPEC.md — Primary: "Atlas Trend (SuperTrend 10,3)"

Version 1.1.0 · 2026-11-21 · paper account 5830107 only · status: **live on paper; v1.1.0 adds the regime-gated inverse-ETF bear sleeve; hourly + EOD automation enabled**

This is the full, implementable specification. Numbers below are the only numbers the Executor may use; they are stricter than the competition limits, never looser.

## 1. Universe and data

- 24 liquid US names from `config/supertrend.json` (SPY, QQQ, IWM, SMH, TLT, GLD, XLE, XLF, XLK, XLV, XLY, XLU, AAPL, MSFT, NVDA, AMZN, GOOGL, META, AVGO, JPM, LLY, V, COST, XOM), plus the 3-name inverse sleeve of `SH`, `SQQQ`, `QID` (bear regime only, §2b). No other leveraged ETFs, no options, no shorts.
- Signals from **daily** bars only (`quote_history_kline`, forward-adjusted, 370 bars), computed after the 16:00 ET close. Live quotes via `quote_stock_quote` at every intraday check.
- If any symbol's last bar is older than the previous US session, or a quote is stale >15 minutes, that symbol is **ineligible** and a data incident is logged.

## 2. Signal (all on completed daily bars)

```
SuperTrend(period=10, multiplier=3.0)   → up | down
Trend filter   : close > SMA(200)
Whipsaw guard  : skip entry if any SuperTrend down-flip occurred in the last 8 bars
Entry window   : the current up-flip must be ≤10 sessions old
Eligibility    : all three true, symbol not in an earnings blackout (§6)
```

At the 17 Nov close this selects **MSFT (flip 9 bars ago) and AMZN (flip 9)**; everything else is either stale (>10 bars) or SuperTrend-down. This is expected: the system is allowed to hold cash, and will hold cash most of this week if no new flips occur.

## 2b. Bear sleeve — inverse ETFs (added in v1.1.0)

The challenge handbook states "Margin trading and short selling are available." We still take **no short sales**: bearish exposure is expressed by *buying* listed inverse ETFs, which needs no borrow, has bounded loss per dollar and is an ordinary long equity order under this specification.

```
Regime     : SPY close < SMA(200)  OR  SPY SuperTrend = down      (config.regime.indexSymbol)
Symbols    : US.SH (1x), US.SQQQ (3x), US.QID (3x)                 (config.inverse.symbols)
Trigger    : inverse ETF's own SuperTrend = up, and the up-leg is ≤40 sessions old
             (continuation entry — in a bear tape the flip is never "fresh")
Ranking    : 20-day return, same as the core sleeve
```

- **Why continuation, not fresh flips:** the core sleeve only enters a flip ≤10 sessions old. Under a sustained decline the inverse ETFs flip early and then trend; without a continuation window the bear sleeve could never fire. 40 sessions is the cap, and the 8-bar whipsaw guard does not apply to this sleeve (it would veto every continuation entry).
- **Caps:** ≤2 inverse names, ≤12% weight per name, ≤0.75% equity risk per trade on a 3×ATR stop, cap on total inverse exposure is the same 24% sector cap (the three ETFs share the `inverse` sector).
- **Regime exit:** when the regime test turns false (SPY back above SMA200 *and* SuperTrend up), the ETF's own SuperTrend normally flips down first and the standard exit rules close it. The regime test only gates *entries*; exits are always the §4 rules.
- **Invalidation of the sleeve:** if the bear sleeve's realised hit rate is below 40% after 6 closed trades, or one inverse position gaps through its stop by more than 1.5% of equity, disable `config.inverse.enabled` and hold cash in bear regimes instead.

## 3. Position sizing

| Rule | Value |
|---|---|
| Risk per trade (to initial stop) | **1.0% of current equity** |
| Initial stop distance | **3 × ATR(14)** |
| Max weight per name | **12.0% of equity** (hard; the brief's ">12% needs a written reason" is never used) |
| Max concurrent positions | **6** (newest entries ranked by 20-day return) |
| Max sector exposure | **2 names / 24%** per sector (XL* ETFs = their own sector) |
| Max gross exposure | **72%** |
| Min cash | **10%** |
| Min notional / whole shares | $500 / integer shares only |
| Inverse sleeve override | risk **0.75%**, stop **3×ATR(14)**, ≤2 names, ≤12% each (never looser than the core) |

`qty = min( floor(0.01 × equity / (close − stop)), floor(0.12 × equity / close) )`, then `qty × price ≥ 500`.

## 4. Exits (whichever first)

1. **Trailing stop**: `peak_close − 3×ATR(14)`, ratcheted up only (never down), initialised at entry − 3×ATR. Intraday low ≤ stop → sell with limit at `stop × 0.9985`; if unfilled 10 minutes before the close, sell at the close with a limit at last × 0.9985.
2. **SuperTrend flip down** at the close → exit at next open.
3. **Time stop: 7 sessions** → exit at next open (fits the competition; prevents dead positions into 27 Nov).
4. **Earnings**: exit by the close one session before a held name reports (no holding through prints in the primary).
5. **Portfolio rules** (§5) can override all of the above.

## 5. Portfolio risk limits (exact)

| Trigger | Action |
|---|---|
| Intraday equity −1.5% vs start-of-day | Flatten all, no new buys until next US session, log `DAILY_LOSS_HALT` |
| Peak-to-trough drawdown 4% | Halve every position (limit sells), no new buys until a positive session closes |
| Peak-to-trough drawdown 6% | **Kill switch**: flatten all, no new buys for 5 sessions, written report, Auditor sign-off to resume |
| Realised loss on one trade > 1.5% of equity (gap through stop) | Incident review; pause new entries for one session |
| 2 rejected orders for one symbol in a day | Symbol blacklisted for the day; no retry |
| Reconciliation mismatch (sim vs ledger) >0.5% of equity | Halt trading, reconcile, INCIDENT log |

Hard competition limits we stay inside: ≤12 orders/day (platform 200), ≤6 positions (100), ≤12% per name (40%), $1+ price, ≥$500M cap.

## 6. Calendar rules (competition-specific)

- **Today, 18 Nov**: TGT/LOW/TJX report pre-open, PANW after the close → no entries in any of them today; their gap reactions are evaluated only at the 19 Nov close.
- **19 Nov**: WMT reports pre-open → no entry in WMT before the close; PANW reaction eligible at the close only if it passes the normal filter (gap alone is not an entry in the primary).
- **20–24 Nov**: normal operation.
- **Wed 25 Nov (last full session)**: **no new positions after this close** unless the Risk Auditor approves in writing, naming the specific catalyst (brief rule).
- **Thu 26 Nov**: market closed (Thanksgiving). Agent does not run; no GTC orders exist (all orders DAY).
- **Fri 27 Nov (early close 13:00 ET)**: no new entries; all positions reviewed by **12:00 ET**; exit everything by 12:45 ET unless the Auditor approved a written hold to the 13:00 close. This satisfies "close or review ALL positions by 1:00pm ET".

## 7. Execution rules

- **Limit orders only**, `order_type=1`, `order_trade_time_type=1` (regular hours), `time_in_force=DAY`, whole shares.
- Buy limit = last × 1.0015, rounded to the cent; sell limit = last × 0.9985.
- **No chase**: if the open is >1% above the buy limit, the entry is skipped for the day.
- If the open is below the stop (gap-through), do not enter.
- Max 3% deviation from the last price (platform rule); our offsets are 0.15%.
- All six orders cancelled today were DAY orders; the account starts clean at $100,000.

## 8. Failure handling

| Situation | Behaviour |
|---|---|
| Partial fill | Keep the filled part with its stop; cancel the remainder at the close; log both |
| Buy unfilled by close | Cancel; signal stays valid only while the flip is ≤10 sessions old |
| Order rejected | Log reason, no blind retry, max 2 recomputations, then drop the symbol for the day |
| MCP/quote outage | No new orders; existing stops handled at the next successful check; incident log |
| Cron missed | Next run performs the EOD reconciliation; missed intraday checks are logged, not back-filled |
| Account gate fails (title lacks "Qoder"+"Challenge") | Submit nothing, INCIDENT, stop |

## 9. Expected performance (label: backtest estimate, not a forecast)

From the 160-session Moomoo window, competition-fit variant (entry window 10, 7-session stop): total **+6.54%**, max DD **−6.29%**, Sharpe **1.29**, PF **1.42**, 84 trades, 56% win. Rolling 7-session windows: median **+0.11%**, mean **+0.29%**, P5 **−1.68%**, P95 **+3.65%**, 54% positive. Tighter variant (window 5): +9.95% / DD −3.03% / Sharpe 2.40 but qualifies in cash more often. For the remaining 7 sessions, expect **small positive drift with a realistic worst case near −2% and a good case near +3.5%**; the primary value in this window is capital preservation plus judgeable process.

## 10. Determinism checklist (what the Auditor verifies every run)

1. Signal inputs reproducible from the same bars (hash of the kline file).
2. Every order traces to a signal row, a stop price, a qty formula and a risk check.
3. No order exceeds 12% weight, 1% risk, 6 positions, 24% sector, 72% gross.
4. No order in a name with earnings inside the blackout, or after the 25 Nov cutoff.
5. Every rejection and every skipped entry has one log line with a reason.
