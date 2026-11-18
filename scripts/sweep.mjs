#!/usr/bin/env node
// Parameter calibration on a train/test split. No live effect; writes reports/sweep.json.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runBacktest } from '../src/lib/backtest.js';
import { performance } from '../src/lib/metrics.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const base = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'strategy.json'), 'utf8'));
const klineDir = path.join(ROOT, 'data', 'raw', 'klines');
const series = Object.fromEntries(base.universe.map((s) => [
  s, JSON.parse(fs.readFileSync(path.join(klineDir, `${s}.json`), 'utf8'))
]));

const grid = [];
for (const targetVolAnnual of [0.12, 0.15, 0.18, 0.20]) {
  for (const stopLossPct of [0.10, 0.15, 0.20]) {
    for (const trailingAtrMult of [3, 5]) {
      for (const rebalanceEvery of [5, 10]) grid.push({ targetVolAnnual, stopLossPct, trailingAtrMult, rebalanceEvery });
    }
  }
}

const rows = [];
for (const params of grid) {
  const cfg = structuredClone(base);
  cfg.allocation.targetVolAnnual = params.targetVolAnnual;
  cfg.risk.stopLossPct = params.stopLossPct;
  cfg.risk.trailingAtrMult = params.trailingAtrMult;
  cfg.backtest.rebalanceEvery = params.rebalanceEvery;
  const bt = runBacktest(series, cfg);
  const eq = bt.equity.map((e) => e.equity);
  const split = Math.floor(eq.length * 0.7);
  const train = performance(eq.slice(0, split));
  const test = performance(eq.slice(split));
  const exposure = bt.exposure.map((e) => e.exposure);
  rows.push({
    ...params,
    ret: bt.metrics.totalReturn,
    sharpe: bt.metrics.sharpe,
    maxDD: bt.metrics.maxDrawdown,
    trainSharpe: train.sharpe,
    testSharpe: test.sharpe,
    testRet: test.totalReturn,
    avgExposure: exposure.reduce((a, x) => a + x, 0) / exposure.length,
    sells: bt.trades.filter((t) => t.side === 'SELL').length
  });
}

rows.sort((a, b) => b.testSharpe - a.testSharpe);
fs.mkdirSync(path.join(ROOT, 'reports'), { recursive: true });
fs.writeFileSync(path.join(ROOT, 'reports', 'sweep.json'), JSON.stringify(rows, null, 2));
console.table(rows.slice(0, 15).map((r) => ({
  vol: r.targetVolAnnual, stop: r.stopLossPct, atr: r.trailingAtrMult, reb: r.rebalanceEvery,
  ret: pct(r.ret), sharpe: r.sharpe, dd: pct(r.maxDD), trainSh: r.trainSharpe, testSh: r.testSharpe, testRet: pct(r.testRet), expo: pct(r.avgExposure), sells: r.sells
})));

function pct(v) {
  return `${(v * 100).toFixed(1)}%`;
}
