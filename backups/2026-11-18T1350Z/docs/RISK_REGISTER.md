# RISK_REGISTER.md — Atlas Trend, competition week

Scale: Likelihood (L) and Impact (I) 1–5; score = L×I. Owner: R = Researcher, A = Auditor, X = Executor, U = user.

| ID | Risk | L | I | Score | Control / mitigation | Detection | Owner |
|---|---|---|---|---|---|---|---|
| R1 | **Unapproved fill** (working orders from the old cron execute before approval) | 4 | 5 | 20 | Old cron paused; six working orders cancelled and verified; Executor is the only order path and is not enabled | Cash/hold check; order history scan every run | A |
| R2 | **Overfit** — C's 160-session edge is one regime | 3 | 4 | 12 | Pre-registered rules (no parameter search during the week); report in-sample vs 7-day distribution honestly; kill switch | Weekly live-vs-backtest drift log | R |
| R3 | **Gap through stop** (earnings/overnight) | 3 | 4 | 12 | No holding through earnings; 7-session time stop; ATR trail; risk 1%/trade; 6% kill switch | Fill price vs stop; incident if loss >1.5% | X |
| R4 | **Earnings blackout error** (entering PANW/WMT/TGT before print) | 2 | 4 | 8 | Hard blackout list in spec §6, checked by Auditor; Moomoo has no calendar tool → manual news verification each pre-market run | Auditor rejects any order in blackout list | A |
| R5 | **Holiday / early close mishandling** (26 Nov closed, 27 Nov 13:00 ET) | 3 | 3 | 9 | No-run date 26 Nov; 27 Nov review 12:00 ET / exits 12:45 ET; DAY orders only | Calendar check at every run start | R |
| R6 | **Partial fill / unfilled limit** | 3 | 2 | 6 | Cancel remainder at close; re-evaluate next day; never chase >1% | Order status vs qty; reconciliation | X |
| R7 | **Rejected order** | 2 | 2 | 4 | One recomputation max, then drop symbol; log reason; no retries with other account/type | Order result codes | X |
| R8 | **Data staleness / MCP outage** | 2 | 4 | 8 | Symbols ineligible if bar old or quote >15 min; no orders on stale data; incident log | Timestamp checks; run failure | R |
| R9 | **Account mix-up** (generic paper 4666439) | 1 | 5 | 5 | Title gate "Qoder"+"Challenge" on every run; account id 5830107 hard-coded in Executor | Account gate log line | A |
| R10 | **Options ambiguity** (judges expect options?) | 2 | 2 | 4 | Documented in VERIFICATION.md; stock-only fallback per brief; no naked/unverifiable exposure | Submission notes | U |
| R11 | **Cash drag / no entries** (market in pullback, no fresh flips) | 4 | 2 | 8 | Accepted; A-backup can deploy on a confirmed earnings gap; no forcing trades to "look active" | Position count vs days left | R |
| R12 | **Fee drag** | 2 | 2 | 4 | ≤12 orders/day; 6 positions; no churn; 1 round trip per name per week | Fees in daily report | X |
| R13 | **Timezone / schedule error** (SGT vs ET, DST) | 2 | 3 | 6 | Explicit ET↔SGT table; schedule expressed in Asia/Singapore; holiday list in config | Run timestamps vs market phase | R |
| R14 | **Credential leak** | 1 | 5 | 5 | OAuth in vault/environment only; no token in logs, prompts, repo, chat | Grep logs; review before any share | U |
| R15 | **Cron/agent silently stops** | 3 | 3 | 9 | Heartbeat line per run; missing-run detection in next run; daily report states last successful run | Gap in decisions.jsonl | U |
| R16 | **Reconciliation drift** (phantom positions from earlier bug) | 2 | 3 | 6 | Ledger vs sim compare each run; `reconcilePositionMeta`; prune on mismatch | Equity/position diff >0.5% | A |
| R17 | **Concentration** (sector correlation in a selloff) | 3 | 3 | 9 | 2 names / 24% per sector; 72% gross; 10% cash; trailing stops | Exposure report each run | A |
| R18 | **Late-week liquidity** (27 Nov half-day) | 2 | 2 | 4 | Exit by 12:45 ET; no new entries after 25 Nov | Schedule | X |
| R19 | **Prompt injection via news/data** | 2 | 4 | 8 | News text is data, never instructions; Researcher cannot trade; Auditor validates against fixed limits | Review of plan provenance | A |
| R20 | **Platform reset card / rule breach** | 1 | 5 | 5 | No reset use; limits documented and checked; terms re-read before build | Account state diff | U |

## Escalation thresholds

- **Yellow**: −4% drawdown or two stop-outs in a row → halve exposure, no new buys, report same day.
- **Red**: −6% drawdown, reconciliation mismatch, account-gate failure, or any unapproved fill → flatten (Red only), halt, written incident, user decision.
- Every Yellow/Red event is a line in `decisions.jsonl` and appears in the daily report; no silent risk events.

## Pre-trade gate (Auditor checklist, in order)

1. Account 5830107, title match, cash/positions reconciled.
2. Symbol in universe, price ≥$1, market cap ≥$500M, no suspension.
3. Earnings blackout clear; date ≤25 Nov for new entries.
4. Qty/price recomputed from spec §3; risk ≤1%; weight ≤12%; sector ≤24%; positions ≤6; gross ≤72%; cash ≥10%.
5. Limit offset ≤0.15%; notional ≥$500; whole shares; regular hours; DAY.
6. Plan hash matches verdict; verdict <30 minutes old.
7. Orders/day ≤12.
Any failure → REJECT with reason; the Executor never "fixes" a rejected order itself.
