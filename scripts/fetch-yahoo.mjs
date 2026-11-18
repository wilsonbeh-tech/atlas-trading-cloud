#!/usr/bin/env node
// Backtest data loader. Live signals and execution use Moomoo MCP; this fills
// history for reproducible research when the Moomoo HTTP transport is not configured.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'strategy.json'), 'utf8'));
const outDir = path.join(ROOT, 'data', 'raw', 'klines');
fs.mkdirSync(outDir, { recursive: true });

const symbols = cfg.universe;
const failures = [];

for (const symbol of symbols) {
  const ticker = symbol.replace(/^US\./, '').replace(/\./g, '-');
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?range=2y&interval=1d&events=div%2Csplits`;
  try {
    const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    const result = json?.chart?.result?.[0];
    if (!result?.timestamp) throw new Error(json?.chart?.error?.description ?? 'no timestamps');
    const q = result.indicators.quote[0];
    const adj = result.indicators.adjclose?.[0]?.adjclose;
    const bars = [];
    for (let i = 0; i < result.timestamp.length; i++) {
      if (!q.close?.[i] || !q.open?.[i]) continue;
      const date = new Date(result.timestamp[i] * 1000).toISOString().slice(0, 10);
      const close = adj?.[i] ?? q.close[i];
      bars.push({
        date,
        open: round2(q.open[i] * (close / q.close[i])),
        high: round2(q.high[i] * (close / q.close[i])),
        low: round2(q.low[i] * (close / q.close[i])),
        close: round2(close),
        volume: q.volume?.[i] ?? 0
      });
    }
    const file = path.join(outDir, `${symbol}.json`);
    fs.writeFileSync(file, JSON.stringify(bars));
    process.stdout.write(`\r  ${symbol}: ${bars.length} bars (${bars.at(0)?.date} → ${bars.at(-1)?.date})      \n`);
  } catch (error) {
    failures.push(`${symbol}: ${error.message}`);
    console.error(`  ${symbol}: ${error.message}`);
  }
}

if (failures.length) {
  console.error(`\n${failures.length} symbol(s) failed.`);
  process.exit(1);
}
console.log(`\nSaved ${symbols.length} symbols to ${path.relative(ROOT, outDir)}`);

function round2(n) {
  return Math.round(n * 100) / 100;
}
