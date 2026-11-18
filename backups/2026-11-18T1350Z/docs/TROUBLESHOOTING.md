# Troubleshooting and Open Blockers

## Blocker: competition paper account is not exposed

**Challenge timeline (official post):** build and paper-trade **17–28 Nov 2026**, submit by **30 Nov**, finalists present **8 Dec**. Approved participants get a dedicated paper-trading tab; the kickoff workshop is **16 Nov, 6–9pm SGT** at NUS.

**Observed on 16 Nov (before the window opened):** `sim_trade_account_list` returns seven standard paper accounts (US margin, HK, SG, JP, US futures, SG futures, KR margin) and no account whose title contains *Qoder AI Trading Agent Challenge*. The US margin paper account (`4666439`) is unrelated: it started with a different balance and contains legacy positions (NVDA, a short NOW, BAOS), so Atlas refuses to trade it.

**Why this matters:** the challenge requires trades in the dedicated competition book. Trading the generic US paper account would invalidate the submission and mix unrelated positions into the results.

**What to do in the Moomoo app:**

1. Confirm you are approved for the challenge and have the dedicated paper-trading tab. Registration was limited to the first 500 participants.
2. On **17 Nov**, open the challenge tab and switch the active paper account to the competition book.
3. Return to Qoder and re-run `sim_trade_account_list`.
4. If the account still does not appear, disconnect and reconnect the Moomoo MCP connector in Qoder settings so the server refreshes the account list. Re-authorize if prompted.
5. If it still does not appear, the competition account may be app-only (not exposed by the public Moomoo MCP account API). In that case Atlas cannot place orders through MCP; keep the research pipeline running and report the API gap to the organizers.

**What Atlas does while blocked:**

- Runs offline research (`signals`, `plan`, `backtest`, `dashboard`) using Moomoo/Yahoo daily bars.
- Refuses `run --execute` unless the account title matches or `--allow-dev` is explicitly passed.
- Logs no fills, so the dashboard clearly shows an empty execution history instead of implying live results.

## `node` is not on PATH

Use the wrappers:

```bash
scripts/momo-node.sh  src/cli.js selftest
scripts\momo-node.cmd src\cli.js selftest
```

They run system Node if present; otherwise they use Qoder's embedded Node via `ELECTRON_RUN_AS_NODE=1`. Override with `QODER_EXE=/path/to/Qoder.exe`.

## `fetch` fails with HTTP 401

`MOOMOO_MCP_TOKEN` is missing, expired or from a different workspace. The local Qoder client and a Cloud Agent do not share tokens. Re-authorize the Moomoo connector in the environment that will run the agent, or use the agent-mediated path in `skills/momo-momentum/SKILL.md`.

Never paste a token into a prompt, issue, commit or screenshot.

## `import-live` says `cash.total_asset missing`

The live input must contain the raw `sim_trade_cash_info` payload under `cash` (or `cash_info`). Minimum fields:

```json
{
  "account": { "account_id": "…", "account_title": "…", "market_id": 100 },
  "cash": { "total_asset": "100000", "balance": "100000", "long_mv": "0", "short_mv": "0" },
  "positions": [],
  "quotes": [ { "code": "US.SPY", "last_price": 754.37, "suspension": false } ],
  "open_orders": [],
  "orders_today": 0
}
```

`positions` may be the raw `data.positions` array, and `quotes` may be the raw `data.quote_list` array. Symbols without a market prefix are normalized to `US.*`.

## Quotes look stale or pre-market

`quote_stock_quote` includes `data_date`, `last_price`, `pre_market`, `after_market` and `suspension`. Atlas uses `last_price` and skips suspended names. During pre-market, `last_price` is the prior regular close; that is intentional for planning, but do not assume the limit will fill until the regular session opens.

## Plan approves nothing

Check, in order:

1. `reports/signals.json` — are enough names eligible (price, dollar volume, trend)?
2. Regime — `RISK_OFF` limits the book to 3 names / 30% gross.
3. `data/state.json` — is `haltUntil` in the future?
4. `guard.rejected` in `reports/plan.json` — the reasons are explicit.
5. Snapshot equity and cash — a stale snapshot can make every buy fail the cash check.

## Backtest returns differ from a previous run

Inputs are deterministic. Differences usually come from:

- A different kline window (`scripts/fetch-yahoo.mjs` refreshes to the latest bars).
- A config change (`config/strategy.json` version).
- Adjusted closes changing after a dividend or split.

Record the config version and data window with every reported result.

## Dashboard shows an offline preview

That is expected when `data/raw/snapshot.json` is absent. The KPI shows `—` for net assets and an "Offline research preview" tag. No live equity is implied.

## Order timeout / unknown result

Do **not** resubmit. Call `sim_trade_history_order_list` for today, match symbol/side/qty/price, cancel duplicates with `sim_trade_cancel_order`, and log an `INCIDENT` decision. See `docs/RISK_POLICY.md` §8.
