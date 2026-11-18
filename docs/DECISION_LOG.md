# Decision Log

Atlas records every decision before and after execution. The goal is to make the agent's behavior reconstructable without reading source code: what it saw, what it chose, what it refused, and why.

## Files

| File | Written by | Contents |
| --- | --- | --- |
| `data/decisions.jsonl` | `plan`, `record`, risk events | One JSON object per plan, risk action or execution record |
| `data/rejections.jsonl` | `plan` | One JSON object per rejected order |
| `data/orders.jsonl` | `record`, `run --execute` | One JSON object per submitted or non-filled order |
| `data/fills.jsonl` | `record` | One JSON object per actual fill |
| `data/equity.jsonl` | `plan`, `mark` | Marked equity per cycle |
| `data/state.json` | all commands | Peak, day-start, halt date, position metadata, daily order count |

All JSONL files are append-only. Timestamps are UTC ISO-8601; trading dates in state are New York dates (`America/New_York`).

## Decision record

```json
{
  "ts": "2026-11-16T12:44:31.182Z",
  "action": "PLAN",
  "summary": "RISK_ON · equity $100000 · 6 targets · 6 approved / 0 rejected · gross 87.9%",
  "regime": "RISK_ON",
  "equity": 100000,
  "risk": {
    "drawdownPct": 0,
    "dailyPnlPct": 0,
    "flatten": false,
    "deRisk": false,
    "haltUntil": null,
    "reasons": [],
    "halted": false
  },
  "targets": {
    "US.XLV": 0.2,
    "US.V": 0.2,
    "US.LLY": 0.169,
    "US.AAPL": 0.14,
    "US.XLF": 0.109,
    "US.MSFT": 0.082
  },
  "approved": [
    {
      "symbol": "US.XLV",
      "side": "BUY",
      "qty": 105,
      "limitPrice": 189.13,
      "notional": 19829.25,
      "reason": "add to target 20% (rank-driven rebalance)",
      "targetWeight": 0.2,
      "currentWeight": 0,
      "weightOfEquity": 0.1983
    }
  ],
  "rejected": []
}
```

Fields:

- `action` — `PLAN`, `KILL_SWITCH`, `ORDERS_SUBMITTED`, `EXECUTION_RECORDED`, `INCIDENT`, `RECONCILIATION`.
- `summary` — one-line human audit string.
- `risk` — full output of `evaluateRiskState`, including drawdown, daily P&L, halt date and reasons.
- `targets` — final target weights after regime/de-risk scaling.
- `approved` / `rejected` — exact orders after guardrails. Rejected orders are duplicated in `rejections.jsonl` with `ts`, `reason`, `account`.

## Rejection record

```json
{
  "ts": "2026-11-16T12:44:31.180Z",
  "symbol": "US.NVDA",
  "side": "BUY",
  "qty": 60,
  "limitPrice": 182.4,
  "notional": 10944,
  "reason": "post-trade weight 41% exceeds hard 40% cap",
  "account": "Qoder AI Trading Agent Challenge Paper Trading Account"
}
```

Common reasons and what they mean:

| Reason prefix | Meaning | Agent response |
| --- | --- | --- |
| `symbol outside approved universe` | Not in the 24-symbol allow-list | Ignore; do not add ad-hoc symbols |
| `no valid quote` / `security suspended` | Data problem | Skip the symbol this cycle |
| `price below $1` | Competition ineligibility | Remove from consideration |
| `notional ... below $500` | Order too small to be worth fees | Wait for a larger rebalance delta |
| `daily order cap reached` | 40 orders already submitted | Stop for the day |
| `limit price ... away from market` | Quote moved or bad input | Re-plan; never widen the 3% limit |
| `risk halt active` | Kill switch | Sells only; no new buys |
| `insufficient shares` | Sell exceeds holding | Re-read positions; never short |
| `post-trade weight ... exceeds hard 40% cap` | Concentration | Trim the target |
| `projected gross ... exceeds 90%` | Leverage creep | Remove marginal buys |
| `post-trade positions exceed 8` | Too many names | Remove marginal buys |

## Fill record

```json
{
  "ts": "2026-11-16T14:31:02.004Z",
  "symbol": "US.XLV",
  "side": "BUY",
  "qty": 105,
  "price": 189.13,
  "notional": 19858.65,
  "reason": "add to target 20% (rank-driven rebalance)",
  "orderId": "123456789",
  "status": "FILLED",
  "source": "mcp-agent"
}
```

`status` is `SUBMITTED` for limit orders acknowledged by Moomoo, or `FILLED` when the agent has confirmed the fill. `source` is `mcp-agent` (local Qoder tools) or `moomoo-mcp-http` (Cloud Agent broker adapter).

## Reconstruction checklist

To audit any cycle:

1. Read the last `PLAN` entry in `decisions.jsonl`.
2. Compare `targets` with `reports/signals.json` ranks and the regime.
3. Compare `approved` with `reports/plan.json`.
4. Check `rejections.jsonl` for that timestamp.
5. Check `fills.jsonl` for matching order IDs.
6. Recompute equity from `equity.jsonl` and confirm `state.json` peak/day-start/halt.
7. Re-run `plan` offline to confirm determinism (same klines + snapshot → same orders).

## Sample audit (offline)

At 2026-11-16 12:44 UTC the agent saw `RISK_ON`, selected six names, and produced six buys totaling $87,894 with 12.1% cash. All six passed guardrails. The largest target was XLV at 20.0% of equity, exactly at the soft cap and half the hard cap. No rejections. This was a dry run: `state.dailyOrders` was not incremented and `fills.jsonl` remained empty.
