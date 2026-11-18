# Decision Log Reference

## Files

| File | Contents |
| --- | --- |
| `data/decisions.jsonl` | Plan, risk action and execution-record events |
| `data/rejections.jsonl` | One line per rejected order |
| `data/orders.jsonl` | One line per submitted/non-filled order |
| `data/fills.jsonl` | One line per actual fill |
| `data/equity.jsonl` | Marked equity per cycle |
| `data/state.json` | Peak, day-start, halt date, position metadata, daily order counts |

Append-only JSONL, UTC timestamps. Trading dates use `America/New_York`.

## Plan event

```json
{
  "ts": "2026-11-16T12:44:31.182Z",
  "action": "PLAN",
  "summary": "RISK_ON · equity $100000 · 6 targets · 6 approved / 0 rejected · gross 87.9%",
  "regime": "RISK_ON",
  "equity": 100000,
  "risk": { "drawdownPct": 0, "dailyPnlPct": 0, "flatten": false, "deRisk": false,
            "haltUntil": null, "reasons": [], "halted": false },
  "targets": { "US.XLV": 0.2, "US.V": 0.2 },
  "approved": [ { "symbol": "US.XLV", "side": "BUY", "qty": 105, "limitPrice": 189.13,
                  "notional": 19829.25, "reason": "add to target 20% (rank-driven rebalance)" } ],
  "rejected": []
}
```

## Rejection event

```json
{ "ts": "…", "symbol": "US.NVDA", "side": "BUY", "qty": 60, "limitPrice": 182.4,
  "notional": 10944, "reason": "post-trade weight 41% exceeds hard 40% cap",
  "account": "Qoder AI Trading Agent Challenge Paper Trading Account" }
```

## Fill event

```json
{ "ts": "…", "symbol": "US.XLV", "side": "BUY", "qty": 105, "price": 189.13,
  "notional": 19858.65, "reason": "add to target 20%", "orderId": "123456789",
  "status": "FILLED", "source": "mcp-agent" }
```

`status`: `SUBMITTED` or `FILLED`. `source`: `mcp-agent` or `moomoo-mcp-http`.

## Audit procedure

1. Read the last `PLAN` event.
2. Compare targets with `reports/signals.json` ranks and the regime.
3. Compare approved orders with `reports/plan.json`.
4. Check `rejections.jsonl` at the same timestamp.
5. Match `orders.jsonl` and `fills.jsonl` order IDs.
6. Verify `equity.jsonl`, `state.json` peak/day-start/halt.
7. Re-run `plan` with the same klines and snapshot; orders must match.

Do not edit historical lines. Corrections are new events with `action:"INCIDENT"`, `action:"RECONCILIATION"` or `action:"EXECUTION_RECORDED"`.
