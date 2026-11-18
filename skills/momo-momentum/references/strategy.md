# Strategy Reference — Atlas Dual-Momentum 1.1.0

## Universe (24)

```
SPY QQQ IWM SMH TLT GLD XLE XLF XLK XLV XLY XLU
AAPL MSFT NVDA AMZN GOOGL META AVGO JPM LLY V COST XOM
```

All Moomoo codes are `US.<ticker>`. The universe is fixed in `config/strategy.json`; adding a symbol is a strategy change and requires re-validation.

## Features (daily bars, ≥200 bars)

| Feature | Definition |
| --- | --- |
| `r20`, `r60`, `r120` | Close-to-close returns over 20/60/120 trading days |
| `vol20` | Annualized stdev of daily returns over 20 days (×√252) |
| `atr14` | Average true range, 14 days |
| `sma50`, `sma200` | Simple moving averages |
| `avgDollarVolume20` | Mean(close × volume, 20) |
| `rsi14` | Informational only; not used in scoring |

## Score

Cross-sectional z-scores are computed across symbols that have all features:

```
score = 0.20·z(r20) + 0.45·z(r60) + 0.35·z(r120) − 0.15·z(vol20)
```

Weights: 60-day dominates (signal), 120-day confirms (trend), 20-day adds responsiveness, volatility subtracts froth. Ties break by `r60`.

## Eligibility

A symbol is selectable only if:

- price ≥ $1.00
- `avgDollarVolume20` ≥ $20M
- `close > SMA50 > SMA200` (trend pass)

If fewer than `maxPositions` names qualify, hold fewer. Never fill the book with ineligible names.

## Regime

Measured on SPY only:

| State | Condition |
| --- | --- |
| `RISK_ON` | SPY close > SMA200 and SMA50 > SMA200 |
| `CAUTION` | SPY close > SMA200 but SMA50 ≤ SMA200 |
| `RISK_OFF` | SPY close ≤ SMA200 |

Regime changes position count and gross:
- RISK_ON: 8 positions, up to 90% gross.
- CAUTION: 8 positions, scaling continues but de-risk applies at the drawdown threshold.
- RISK_OFF: 3 positions, 30% gross.

## Selection

1. Sort eligible rows by score descending.
2. Take the top `maxPositions`.
3. Keep any currently held eligible name that is within `holdBuffer=2` ranks of the cutoff (reduces turnover).
4. Drop held names that fail eligibility or fall outside the buffer.

## Target weights

1. Raw weight = `max(score, 0.05) / vol20`, so negative or near-zero scores still receive a small allocation if selected.
2. Normalize raw weights to 100% of the investable sleeve.
3. Cap each name at `maxNameWeight=20%` of equity; redistribute the excess to uncapped names.
4. Build the 60-day covariance matrix from daily returns and compute portfolio volatility at the current gross.
5. Scale gross toward `targetVolAnnual=18%`, bounded by `minGross=30%` and `maxGross=90%`.
6. Apply `minCash=10%`.
7. If regime is RISK_OFF, cap gross at 30% and positions at 3.
8. If drawdown ≤ -8%, halve all weights.

If covariance is singular or history is short, fall back to the weighted average of individual vols (no diversification credit). Conservative is correct here.

## Orders

For each target and holding:

- If held and not targeted: sell all.
- If stop triggered: sell all.
- If target − current > 1.5% of equity: buy `floor(delta / price)`.
- If current − target > 1.5% of equity: sell `min(floor(delta / price), qtyAvailable)`.
- Limit price: last price × (1 ± 0.15%), rounded to 2 decimals.
- Sells are submitted before buys.

Minimum notional is $500; smaller deltas wait for a later cycle. Order quantity is always an integer.

## Execution assumptions (backtest)

- Signals at day `t` close; orders execute at day `t+1` open.
- A limit fills only if the next open is within 0.1% of the limit.
- Slippage 5 bps.
- Platform fee $0.99 per order; SEC fee $0.000166/share sold, capped $8.30.
- Stops fill at `min(open, stop)` when the daily low breaches the stop.
- No partial fills, no borrow costs, no market impact beyond slippage.

## Calibration

Grid: target vol {12, 15, 18, 20}% × stop {10, 15, 20}% × ATR {3, 5} × rebalance {5, 10} days. Selection used a 70/30 chronological split and favored a robust region, not the top cell. Chosen: 18% vol, 15% stop, 5 ATR, 10-day rebalance. See `scripts/sweep.mjs` and `reports/sweep.json`.

## Known weaknesses

- Long-only, US large-cap, survivorship-biased universe.
- Momentum whipsaw in choppy tapes; rank exits can lag reversals.
- Vol targeting leaves cash idle in strong bull markets; the book averaged ~53% exposure in the test window.
- Daily-loss flatten at 2.5% can trigger on a single bad session and re-enter after the next signal.
