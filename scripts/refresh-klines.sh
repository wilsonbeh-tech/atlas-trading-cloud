#!/usr/bin/env bash
# Refresh daily klines for the SuperTrend universe using the quote-only moomoo CLI.
# Writes data/raw/klines-moomoo/US.<SYM>.json in moomoo kline shape. Keeps last good file on failure.
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DIR="$ROOT/data/raw/klines-moomoo"
mkdir -p "$DIR"
SYMS="SPY QQQ IWM SMH TLT GLD XLE XLF XLK XLV XLY XLU AAPL MSFT NVDA AMZN GOOGL META AVGO JPM LLY V COST XOM"
ok=0; fail=0
for s in $SYMS; do
  tmp="$DIR/US.$s.json.tmp"
  if moomoo kline "US.$s" -n 370 -f json > "$tmp" 2>/dev/null && grep -q kline_list "$tmp"; then
    mv "$tmp" "$DIR/US.$s.json"
    ok=$((ok+1))
  else
    rm -f "$tmp"
    fail=$((fail+1))
  fi
done
echo "klines refreshed: $ok ok, $fail failed at $(date -u +%Y-%m-%dT%H:%M:%SZ)"
[ "$fail" -eq 0 ]
