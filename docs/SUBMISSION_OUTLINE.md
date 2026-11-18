# SUBMISSION_OUTLINE.md — how to present this to the judges

## 1. One-liner
A three-agent paper-trading system (Researcher → Risk Auditor → Executor) that trades a volatility-scaled SuperTrend trend model on 24 US names, with every order gated by an independent auditor and every decision logged.

## 2. What was verified before a single order (VERIFICATION.md)
- Competition account 5830107, flat at $100,000 after cancelling six pre-existing working buys and pausing the old cron.
- Stocks/ETFs, limit, DAY, whole shares, regular hours work; options are not verifiable in this environment → stock-only.
- 7 sessions left: 18, 19, 20, 23, 24, 25, 27 Nov; 26 closed; 27 early close.
- Earnings map for the week: TGT/LOW/TJX today, PANW tonight, WMT tomorrow.

## 3. How the strategy was chosen (STRATEGY_ANALYSIS.md)
A–H implemented and tested on 160 sessions of live Moomoo daily bars with slippage and fees. C scored 85/100 (Sharpe 2.26, PF 2.67, DD 5.7%); A 62; B/D/F 47–48; E 39; G 25; H 23. MACD (D) was tested as a filter and **subtracted** value — reported as such. Options (H) could not be tested, so it was scored down rather than given a story.

## 4. What the system trades (STRATEGY_SPEC.md)
SuperTrend(10,3) flip inside 10 sessions + close above the 200-day + whipsaw guard; 1% risk per trade via 3×ATR stops, 12% max per name, 6 positions, 72% gross; exits on flip, trail, or 7 sessions; no earnings holds; no new entries after 25 Nov; everything out by 27 Nov 12:45 ET.

## 5. How the agents work (AGENT_PLAN.md)
Forward Mode: researcher produces a hashed plan, auditor approves/rejects each order against fixed limits (sole veto), executor can only act on a fresh APPROVE matching the hash. The coordinator rule — *never let the Executor act on the Researcher's output without the Auditor's approval* — is enforced cryptographically, not by convention.

## 6. Risk story (RISK_REGISTER.md)
20 identified risks with controls; −1.5% daily halt, −4% de-risk, −6% kill switch; account gate; blackout list; reconciliation each run; unapproved-fill protection proven today (R1 executed: orders cancelled, cron paused).

## 7. Evidence to show
- `reports/research-strategies.json` — the full A–H metric table.
- `data/decisions.jsonl` — including the RISK_ACTION line proving the no-trade gate was enforced.
- Dashboard screenshot with daily competition returns.
- Contract note: tests used forward-adjusted bars, next-open fills, 5 bps slippage, $0.99/order.

## 8. Limitations stated up front
One regime, in-sample; 7-session expected return is small (median ≈ 0.1%, range −1.7% to +3.7%); options excluded; no extended-hours trading; partial fills not modelled. The case is about process, risk control and judgeability — not a promised return.

## 9. Suggested 3-slide narrative
1. Gate first: what we refused to do (no options, no headline trades, no unapproved fill).
2. Evidence: A–H table, why C, what failed.
3. Control: three agents, veto, limits, log — and what happens when it loses.
