# Atlas — Dual-Momentum Paper-Trading Agent

**Moomoo x Qoder AI Trading Agent Challenge submission.** A runnable trading agent that ranks liquid US ETFs and megacaps on multi-horizon momentum, rotates into the strongest names, sizes positions by volatility, and wraps every order in deterministic risk guardrails. Paper trading only.

> **Status: research-complete, execution starts 17 Nov.** The challenge paper-trading window is **17–28 November 2026**, with submissions due **30 November**. The strategy, backtest, guardrails, logs, dashboard and agent skill are implemented and tested. At build time (16 Nov, before the window opened) the dedicated competition account was **not yet exposed** by `sim_trade_account_list` (only the seven standard paper accounts were visible). The agent refuses to trade any other account and will re-scan automatically on the first cycle after the window opens. See [Troubleshooting](docs/TROUBLESHOOTING.md).

| Evidence | Result |
| --- | --- |
| Backtest window | 2025-05-27 → 2026-11-13, daily bars, $100k start |
| Net return | **+21.52%** after $0.99/order platform fees, SEC fees and 5 bps slippage |
| CAGR / vol | +14.20% / 11.04% |
| Sharpe / Sortino | **1.26** / 1.12 |
| Max drawdown | **-6.81%** (limit -12%) |
| Win rate / profit factor | 61.1% / 2.08 over 72 closed trades |
| SPY same window | +29.73% return, 12.72% vol, Sharpe 1.46, -8.89% max DD |
| Rule checks | 9/9 deterministic self-tests pass |
| Live fills | none yet — competition window opens 17 Nov 2026 |

The backtest is a research estimate, not a promise. The agent did **not** beat SPY on raw return; it delivered roughly half the drawdown with lower volatility. Honest attribution is in [What worked / failed](#what-worked--failed).

---

## 1. What the agent does

Every trading cycle:

1. **Verify the account** — only the account whose title matches *Qoder AI Trading Agent Challenge* is eligible.
2. **Pull data** — cash, positions, quotes and daily bars through Moomoo MCP.
3. **Score the universe** — 20/60/120-day returns, z-scored across the universe, minus a volatility penalty; trend filter `close > SMA50 > SMA200`.
4. **Set regime** — SPY above/below SMA200 and SMA50/SMA200 decide `RISK_ON`, `CAUTION` or `RISK_OFF`.
5. **Build targets** — top 8 names (3 in risk-off), inverse-vol × score weights, 20% soft cap, 90% gross cap, 18% portfolio-vol target.
6. **Plan orders** — exits, stops, trims and buys with a 1.5% rebalance band.
7. **Pass guardrails** — deterministic checks (below) approve or reject each order.
8. **Execute** — approved orders are placed as limit orders in the competition paper account.
9. **Log and mark** — decisions, rejections, fills, equity and state are persisted; the dashboard is regenerated.
10. **Monitor risk** — 2.5% daily loss flattens; 8% drawdown halves gross; 12% drawdown flattens and halts new entries for 5 trading days.

The agent may act autonomously *inside* the guardrails. It cannot widen them.

## 2. Competition compliance

| Rule | Implementation |
| --- | --- |
| US-listed stocks/ETFs only | Universe contains only `US.*` ETFs and megacaps; guard rejects anything outside it |
| $1 minimum price, no sub-$500M companies | Guard rejects price < $1; universe is large-cap only |
| Single stock ≤ 40% of total assets | Soft 20% target cap, hard 40% post-trade check; excess buys removed |
| ≤ 100 positions | `maxPositions=8`, hard check in guard |
| ≤ 200 executed orders/day | Internal cap 40/day, checked before submission |
| Regular/extended session 04:00–20:00 ET | `order_trade_time_type=1` (regular session) for predictable fills |
| Final scoring at last regular close | State and equity are marked from the last regular-session snapshot |
| Only the competition paper account | Account title gate; `run --execute` aborts without `--allow-dev` |
| No live capital | All orders use `sim_trade_input_order`; no live trading tool is called |

## 3. Quick start

Requires Node 20+. On this machine `node` is not on PATH; wrapper scripts use Qoder's embedded Node.

```bash
# deterministic unit checks
scripts/momo-node.sh src/cli.js selftest

# download 2y of daily bars for the 24-symbol universe (public Yahoo chart API)
scripts/momo-node.sh scripts/fetch-yahoo.mjs

# score the universe, then build a dry-run plan
scripts/momo-node.sh src/cli.js signals
scripts/momo-node.sh src/cli.js plan

# historical simulation + dashboard
scripts/momo-node.sh src/cli.js backtest
```

Outputs:

- `reports/signals.json` — scores, regime, eligibility
- `reports/plan.json` — targets, orders, approved/rejected, projected exposure
- `reports/backtest.json` — metrics, equity curve, trades, monthly returns, benchmark
- `reports/dashboard.html` — submission dashboard
- `data/decisions.jsonl`, `data/rejections.jsonl`, `data/orders.jsonl`, `data/fills.jsonl`, `data/equity.jsonl`

On Windows use `scripts\momo-node.cmd` with the same arguments.

## 4. Two execution paths

### A. Qoder agent + Moomoo MCP tools (local)

The Qoder agent is the broker adapter. It calls `sim_trade_*` tools directly. The handoff is file-based so every order is auditable:

```
MCP reads → data/raw/live-input.json
         → cli import-live   (normalize snapshot)
         → cli signals + plan
         → reports/plan.json (approved orders only)
         → sim_trade_input_order per approved order
         → reports/exec-results.json
         → cli record
```

Exact tool parameters, account gate and failure handling are in [skills/momo-momentum/SKILL.md](skills/momo-momentum/SKILL.md).

### B. HTTP MCP transport (Cloud Agents)

```bash
export MOOMOO_MCP_URL=https://mcp.moomoo.com/mcp
export MOOMOO_MCP_TOKEN=...       # OAuth access token, never commit
node src/cli.js fetch             # account + quotes + 370 daily bars
node src/cli.js signals
node src/cli.js run --execute     # plans, guards, submits limit orders
```

`run --execute` re-checks the account title at submission time and refuses a development account unless `--allow-dev` is passed. Token handling and Cloud setup: [docs/CLOUD_AGENT.md](docs/CLOUD_AGENT.md).

## 5. Strategy

### Universe (24)

Sector/style ETFs: SPY, QQQ, IWM, SMH, TLT, GLD, XLE, XLF, XLK, XLV, XLY, XLU.
Megacaps: AAPL, MSFT, NVDA, AMZN, GOOGL, META, AVGO, JPM, LLY, V, COST, XOM.

ETFs give the book breadth and defensive rotation; megacaps supply idiosyncratic momentum. TLT/GLD are the only non-equity sleeves and can be selected when their trend and relative strength beat equities.

### Signal

For each symbol with ≥ 200 bars:

```
raw = 0.20·z(r20) + 0.45·z(r60) + 0.35·z(r120) − 0.15·z(vol20)
trendPass = close > SMA50 > SMA200
eligible = price ≥ $1 AND avg 20d $volume ≥ $20M AND trendPass
```

Weights favor the 60-day horizon (less noise than 20d, more responsive than 120d). The volatility penalty avoids buying a single high-vol spike. Ties break by 60-day return.

### Regime and allocation

| Regime | Condition | Positions | Gross |
| --- | --- | --- | --- |
| RISK_ON | SPY > SMA200 and SMA50 > SMA200 | up to 8 | up to 90% |
| CAUTION | SPY > SMA200, SMA50 ≤ SMA200 | up to 8, de-risked | 30–90% |
| RISK_OFF | SPY < SMA200 | 3 | 30% |

Selection keeps current holdings within two ranks of the cutoff to reduce turnover. Target weights are inverse-vol × score, scaled to an 18% annual portfolio-vol target using a 60-day covariance matrix, capped at 20% per name with redistribution, and floored by a 10% cash buffer.

### Stops and exits

- Hard stop: **-15%** from entry.
- Trailing stop: **5 × ATR(14)** below the peak close.
- Target exit: name drops out of the target set.
- Trim band: only trade if |current − target| > **1.5%** of equity.
- Rebalance cadence: every **10** trading days, plus stop/daily-loss triggers.

### Risk ladder

| Trigger | Action |
| --- | --- |
| Daily P&L ≤ -2.5% | Flatten book, no new buys for the rest of the session |
| Drawdown ≤ -8% from peak | Halve all target weights |
| Drawdown ≤ -12% | Flatten, halt new entries for 5 trading days |
| Any order > 40% post-trade weight | Rejected |
| Projected gross > 90% | Buys removed until compliant |
| Orders today ≥ 40 | Further orders rejected |

## 6. Guardrails (deterministic, pre-trade)

`src/lib/risk.js:guardOrders` rejects an order if any check fails:

1. Symbol outside the approved universe.
2. Missing/invalid quote or suspended security.
3. Price below $1.
4. Duplicate symbol in the same plan.
5. Non-integer or non-positive quantity.
6. Notional below $500.
7. Daily order cap reached (40).
8. Limit price more than 3% from the last price.
9. New buy while the kill switch is active.
10. Sell quantity greater than the held quantity (no shorting).
11. Post-trade weight above the 40% hard cap.
12. Negative projected cash.
13. Projected gross above 90% (buys removed).
14. More than 8 long positions after the plan (buys removed).

The agent cannot edit these checks at runtime. Rejected orders are written to `data/rejections.jsonl` with the reason.

## 7. Results

Backtest: 2025-05-27 → 2026-11-13, 371 trading days, daily bars, next-open execution, 5 bps slippage, $0.99 platform fee per order, SEC fee on sells (capped $8.30). Signal warmup is 130 bars; the first months are flat by construction.

| Metric | Atlas | SPY buy & hold |
| --- | --- | --- |
| Total return | +21.52% | +29.73% |
| CAGR | +14.20% | — |
| Annualized vol | 11.04% | 12.72% |
| Sharpe | 1.26 | 1.46 |
| Sortino | 1.12 | — |
| Max drawdown | -6.81% | -8.89% |
| Calmar | 2.08 | — |
| Win rate | 61.1% | — |
| Profit factor | 2.08 | — |
| Closed trades | 72 | — |

Daily competition returns (17–28 Nov, marked from live equity) are in the dashboard; monthly backtest returns stay in `reports/backtest.json`. July 2026 was the worst backtest month (-4.25%); September–October 2025 was flat while the book waited for trend confirmation.

### Calibration protocol

The initial design (12% vol target, 10% stop, 3 ATR trail, 5-day rebalance) averaged only 42% exposure and returned +9.9% with a 0.83 Sharpe. I ran a 4×3×2×2 grid over vol target, stop, ATR multiple and rebalance cadence, scored on a 70/30 chronological train/test split, and selected a **robust region**, not the single best cell: 18% vol target, 15% stop, 5 ATR, 10-day rebalance. Full grid: `reports/sweep.json`; script: `scripts/sweep.mjs`.

This is parameter calibration, not a claim of out-of-sample predictive power. The test slice is short and the universe is survivorship-biased.

## 8. What worked / failed

**Worked**

- Vol targeting plus the trend filter cut max drawdown to 6.8% while keeping a 1.26 Sharpe. The daily-loss kill switch fired twice (-3.48% and -2.52% days) and flattened the book; the 12% drawdown halt never triggered.
- The 5 ATR trailing stop (vs 3 ATR) reduced whipsaw: stop exits fell from 70 to 24, win rate rose from 46% to 61%, and profit factor from 1.43 to 2.08.
- A 10-day rebalance with a 1.5% band cut turnover and fee drag versus 5-day rebalancing.
- Deterministic guardrails made every plan auditable; no order bypassed the 40% name cap or 90% gross cap.
- The same core runs offline on local files and online over MCP, so research and execution cannot drift.

**Failed / limitations**

- **Raw return trailed SPY** (+21.5% vs +29.7%). The 90% gross cap, 10% cash floor and 18% vol target deliberately give up upside; the book was ~53% exposed on average, not fully invested.
- **Sharpe also trailed SPY** (1.26 vs 1.46). The strategy earned its keep on drawdown and win rate, not on risk-adjusted excess return in this strong bull window.
- **Only 24 symbols, all survivors.** This is a narrow, liquid, large-cap universe; results do not generalize to small caps or bear markets.
- **No live competition fills yet.** The dedicated competition account was not returned by `sim_trade_account_list`; the agent correctly refused to use the unrelated US paper account, which also contains legacy positions and ~$786k.
- **Momentum whipsaw remains.** Sector rotation produced 18 rank-drop exits; in choppy tapes the 10-day cadence can lag reversals. The 2.5% daily-loss flatten also fired twice, once on a day that was only -2.52%, which risks selling a temporary dip.
- **Backtest assumptions are optimistic.** Next-open fills only when the open is within 0.1% of the limit, no partial fills, no borrow/short issues, no market-impact model beyond 5 bps.

## 9. Repository map

```
config/strategy.json        all tunable strategy, risk and fee parameters
src/cli.js                  accounts, fetch, import-live, signals, plan, run, record, backtest, dashboard, selftest
src/lib/signals.js          features, cross-sectional z-scores, trend filter, regime
src/lib/allocator.js        selection, inverse-vol weights, covariance vol targeting, caps
src/lib/risk.js             daily/drawdown state machine, order guardrails
src/lib/planner.js          stops, exits, trims, buys, limit prices
src/lib/backtest.js         event-driven daily simulation with fees and slippage
src/lib/metrics.js          Sharpe, Sortino, drawdown, Calmar, trade stats
src/lib/moomoo.js           MCP JSON-RPC/SSE client + paper broker adapter
src/lib/ledger.js           state, klines, snapshot, JSONL logs
src/lib/dashboard.js        self-contained HTML dashboard
skills/momo-momentum/       reusable Cloud Agent skill + runbooks
docs/                       risk policy, decision log, cloud runbook, troubleshooting
scripts/                    Node wrapper, data loader, calibration sweep
```

## 10. Cloud Agents and reusability

`skills/momo-momentum/SKILL.md` (packaged as `dist/momo-momentum.zip`) documents the daily loop, account gate, risk invariants and execution handoff. It is deliberately broker-thin: any agent with the Moomoo MCP tools can run it.

- Deploy as a Qoder Cloud Agent with the Moomoo MCP connector authorized in the cloud workspace.
- Schedule a Forward Mode task every 30 minutes during **09:35–15:55 ET, Mon–Fri** (the 10-day cadence means most runs are no-ops; inner-loop stops are checked daily).
- Optional Slack notification after each run with the decision summary and dashboard link.

Cloud setup, token handling, scheduled-task prompt and Slack payload: [docs/CLOUD_AGENT.md](docs/CLOUD_AGENT.md). The packaged skill is `dist/momo-momentum.zip` (top folder `momo-momentum/`).

## 11. Security and reproducibility

- Tokens live only in `.env` or the Cloud Vault; `.env` and runtime data are gitignored.
- No token, account number or order ID is printed by the CLI except in local JSON logs.
- `scripts/fetch-yahoo.mjs` is research-only; live decisions use Moomoo quotes.
- `scripts/momo-node.sh` uses system Node if present, otherwise Qoder's embedded Node (`ELECTRON_RUN_AS_NODE=1`).
- Self-test covers signal math, regime, weight caps, guard rejection, kill switch and backtest plumbing: `scripts/momo-node.sh src/cli.js selftest`.

## 12. Disclaimer

Paper trading only. Simulated results do not predict live performance. Nothing in this repository is investment advice. The competition account is the only account this agent is authorized to trade.
