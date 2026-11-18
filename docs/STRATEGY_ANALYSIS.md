# STRATEGY_ANALYSIS.md — Step 1 & 2 (A–H tested, scored, ranked)

Data: **live Moomoo** `quote_history_kline`, daily forward-adjusted, 370 bars/symbol, 31 names, complete through **2026-11-17**. Test window: **2026-04-01 → 2026-11-17 (160 sessions)**. Costs modelled: 5 bps slippage each side, $0.99/order, SEC $0.000166/share sold (cap $8.30). All signals at daily close, fills at next open, long only, max 12% per name, no leverage. Harness: `scripts/research-strategies.mjs`; raw output `reports/research-strategies.json` (regenerate with `bash scripts/momo-node.sh scripts/research-strategies.mjs`).

Not modelled: partial fills, extended-hours fills, borrow/short (not used), taxes. Sample = one regime (a strong 2026 uptrend into a sharp Nov pullback); it is **in-sample** evidence, not a forecast.

## 1. Results (tested, not invented)

| # | Strategy (implemented variant) | Total % | Max DD % | Sharpe | Sortino | Win % | PF | Trades | Avg hold | 7-session median % (P5 / P95) | Positive 7d |
|---|---|---|---|---|---|---|---|---|---|---|---|
| A | Post-earnings **gap-up drift**: gap ≥3% + volume, close>50d, hold 7d, 2×ATR stop | +4.63 | −3.75 | 1.36 | 2.07 | 53.3 | 2.32 | 15 | 7.1d | 0.00 (−1.19 / +1.95) | 42% |
| A- | Post-earnings **gap-down dip** (the "buy the dip" half of A) | −1.35 | −3.76 | −0.58 | −0.77 | 37.5 | 0.75 | 16 | 4.9d | 0.00 (−0.86 / +0.67) | 21% |
| B | RSI(2) snapback, leaders >200d, 2.5×ATR stop, 5d | +2.00 | −4.77 | 0.36 | 0.51 | 62.0 | 1.09 | 250 | 2.8d | +0.18 (−2.25 / +2.27) | 54% |
| B' | B without SPY regime filter | +2.68 | −4.69 | 0.46 | 0.65 | 62.0 | 1.11 | 255 | 2.8d | +0.22 (−2.24 / +2.27) | 56% |
| C | **SuperTrend(10, 3)** + close>200d, 3×ATR trail, whipsaw guard | **+18.28** | −5.65 | **2.26** | **3.59** | 46.7 | **2.67** | 30 | 24.2d | +0.19 (−2.24 / +5.29) | 58% |
| C' | C without whipsaw guard | +15.51 | −7.27 | 1.85 | 2.86 | 46.7 | 2.38 | 30 | 24.6d | +0.16 | 53% |
| C2 | C + MACD(12,26,9) confirmation | +13.49 | −5.82 | 1.81 | 2.71 | 43.3 | 2.05 | 30 | 23.0d | +0.18 (−2.08 / +4.83) | 56% |
| C+ | C with **entry window 10** + **7-session time stop** (competition fit) | +6.54 | −6.29 | 1.29 | 1.99 | 56.0 | 1.42 | 84 | 7.0d | **+0.11 (−1.68 / +3.65)** | 54% |
| C++ | C with entry window 5 + 7-session time stop | +9.95 | **−3.03** | **2.40** | 4.20 | 60.0 | 2.01 | 50 | 7.4d | +0.13 (−1.18 / +3.41) | 59% |
| C+20 | C with entry window 20 + 7-session time stop | +11.59 | −7.14 | 1.75 | 2.69 | 52.6 | 1.51 | 114 | 7.0d | +0.26 (−2.11 / +4.92) | 56% |
| C2+ | C + MACD, entry window 10, 7d stop | +8.84 | −4.55 | 1.71 | 2.70 | 57.5 | 1.59 | 80 | 7.2d | +0.11 (−1.61 / +3.71) | 58% |
| D | **MACD alone** | not deployable — tested only as a filter on C (row C2/C2+): it **reduced** return 18.3→13.5 and Sharpe 2.26→1.81 | | | | | | | | | |
| E | Moomoo-style **grid**, SPY ±2%×4 levels | +4.71 | −2.65 | 1.24 | 1.75 | n/a | n/a | 0 closed | n/a | +0.17 (−0.99 / +1.78) | 61% |
| F | Catalyst **gap-and-go**: gap ≥2% + vol ≥1.5×, SPY>200, 3d, 3% stop | −1.67 | −4.09 | −0.55 | −0.64 | 50.0 | 0.78 | 30 | 2.5d | 0.00 (−2.04 / +0.97) | 32% |
| G | Leveraged-ETF / event scalping | **excluded**: 0-DTE-style, single-print, leveraged core banned by the brief; not tested | | | | | | | | | |
| H | Options sleeve H1–H5 | **not testable**: no options sim order tool, no historical options data, naked sales banned | | | | | | | | | |
| — | SPY buy & hold (benchmark) | +11.78 | −5.99 | 1.33 | 1.90 | — | — | 0 | — | +0.40 (−2.25 / +4.23) | 61% |

Two honest observations: (1) the sample is kind to trend following and hostile to dip-buying — B, C+RSI2 (PF 1.04) and the gap-down dip all lost money; (2) E's +4.71% is not a grid edge, it is 40–80% SPY exposure with no exit logic (0 closed trades, adds down four times — conflicts with "no averaging down more than once").

## 2. Live state of the primary signal (17 Nov close)

SPY SuperTrend **DOWN** for 12 bars, RSI(2)=0, −4.8% over 20d; SMH −15.8%/20d; QQQ below its 200-day. Names with SuperTrend UP **and** close>200d: XLF (flip 22 bars ago), XLV (24), XLY (27), AAPL (54), **MSFT (9)**, **AMZN (9)**, JPM (13), LLY (24), V (27), COST (30). With the 10-session entry window only **MSFT and AMZN** qualify at the 17 Nov close; every other trend is stale. NVDA is +2.7% pre-market but SuperTrend-DOWN and below the 200-day → not eligible.

## 3. Scoring against the judging criteria

Weights: Risk-adjusted return 25%, Qoder & Cloud Agent usage 30%, Strategy & risk design 30%, Reusability 15%. Sub-scores 0–10, total /100.

| # | Risk-adj (25%) | Qoder/Agent (30%) | Design (30%) | Reuse (15%) | **Total** | Basis |
|---|---|---|---|---|---|---|
| **C** | 8 | 8 | 9 | 9 | **85** | Sharpe 2.26 / Sortino 3.59 / PF 2.67 tested; every entry has an ATR stop, trend filter, whipsaw guard, time stop; deterministic daily rule set is reproducible by agents; parameterised for any liquid universe |
| A | 6 | 6 | 6 | 7 | **62** | PF 2.32 and DD 3.75% tested, but 15 trades, proxy for earnings dates, single-print dependence; fits 7 sessions and has real catalysts (PANW/WMT) |
| B | 3 | 6 | 4 | 7 | **48** | 250 trades, PF 1.09 — fees eat the edge; ATR stop is the only design virtue |
| D | 3 | 5 | 5 | 6 | **47** | Not standalone; as a filter it subtracted 4.8 pts of return and 0.45 Sharpe |
| F | 2 | 6 | 5 | 6 | **47** | −1.67%, PF 0.78; 32% positive 7-day windows; gap chase without edge |
| E | 3 | 5 | 3 | 5 | **39** | No exit, no stop, adds down 4×; return is beta, not strategy; would fail risk-design review |
| G | 2 | 3 | 2 | 3 | **25** | Excluded by constraints; leveraged/0-DTE core is exactly what the brief penalises |
| H | 2 | 2 | 3 | 2 | **23** | Unverifiable execution and pricing in this environment; verdict cannot be audited |

## 4. Decision

**PRIMARY: C — SuperTrend(10, 3) trend system, competition variant:**
entry on/after a flip-up within 10 sessions while close > SMA200 and no flip-down in the prior 8 bars; initial stop 3×ATR(14), trailing; exit on flip-down, on the trailing stop, or after 7 sessions; max 6 names, 12% cap, 1% risk per trade. Tested on the competition-fit variant: **+6.54% / DD −6.29% / Sharpe 1.29 / PF 1.42** (C++ variant with a 5-session window: **+9.95% / DD −3.03% / Sharpe 2.40 / PF 2.01** — tighter but sits in cash more often). Expected for the 7 remaining sessions: **median ≈ +0.1%, mean ≈ +0.3%, 5–95% range −1.7% to +3.7%** — small because only 2 names qualify today and the window is one week.

**BACKUP: A — post-earnings gap-up drift**, armed only for a confirmed beat that gaps ≥3% with above-average volume and closes above its 50-day: 7-session hold, 2×ATR stop, 4 names max. Candidates on the calendar: WMT (19 Nov), the PANW reaction (19 Nov), TGT/LOW/TJX (19 Nov reaction).

Why not more than one primary: the brief asks for 1 + 1; running C and A concurrently would blur attribution and double the single-print risk in a week with four earnings events. A is dormant unless its trigger fires; when it fires it uses the same risk budget (1% risk, 12% cap) and the same Auditor veto.

**What would falsify C:** two entries stopped out by opening gaps larger than 2×ATR before 25 Nov; or portfolio drawdown >4% → de-risk; >6% → kill switch (see RISK_REGISTER). If that happens, we stop, report, and do not "try the other one" mid-week.

**Why not B/E/F:** tested evidence is negative or fee-dominated (PF 1.09 / 0.78 / beta-only). **Why not H:** cannot be verified in this account — an unverifiable strategy scores near zero on judgeability no matter how good the story is.
