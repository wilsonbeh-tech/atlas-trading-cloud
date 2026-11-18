#!/usr/bin/env node
// Deterministic plan for Atlas Trend (SuperTrend 10,3) per docs/STRATEGY_SPEC.md v1.0.0.
// Inputs: data/raw/klines-moomoo/US.*.json (daily, through last close) + data/raw/moomoo-quotes.json.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const flags = Object.fromEntries(process.argv.slice(2).filter((a) => a.startsWith('--')).map((a) => {
  const [k, v = 'true'] = a.replace(/^--/, '').split('=');
  return [k, v];
}));
const equity = Number(flags.equity ?? 100000);
const blackout = new Set(String(flags.blackout ?? '').split(',').filter(Boolean));
const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'strategy.json'), 'utf8'));
const SYMS = cfg.universe.map((s) => s.replace('US.', ''));

function load(sym) {
  const j = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'raw', 'klines-moomoo', `US.${sym}.json`), 'utf8'));
  return j.kline_list.map((b) => ({ date: String(b.date), o: b.open_price, h: b.high_price, l: b.low_price, c: b.close_price, v: b.volume }));
}
function sma(a, i, n) { if (i < n - 1) return null; let s = 0; for (let k = i - n + 1; k <= i; k++) s += a[k].c; return s / n; }
function atr(a, i, n = 14) {
  if (i < n) return null;
  let s = 0;
  for (let k = i - n + 1; k <= i; k++) s += Math.max(a[k].h - a[k].l, Math.abs(a[k].h - a[k - 1].c), Math.abs(a[k].l - a[k - 1].c));
  return s / n;
}
function superTrend(a, period = 10, mult = 3) {
  const out = new Array(a.length).fill(null);
  let fu = null, fl = null, trend = true;
  for (let i = 0; i < a.length; i++) {
    const x = atr(a, i, period);
    if (x == null) continue;
    const mid = (a[i].h + a[i].l) / 2, bu = mid + mult * x, bl = mid - mult * x;
    if (fu == null) { fu = bu; fl = bl; out[i] = true; continue; }
    const pc = a[i - 1].c;
    fu = bu < fu || pc > fu ? bu : fu;
    fl = bl > fl || pc < fl ? bl : fl;
    trend = a[i].c > fu ? true : a[i].c < fl ? false : trend;
    out[i] = trend;
  }
  return out;
}

const quotes = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'raw', 'moomoo-quotes.json'), 'utf8'));
const qList = quotes.quote_list ?? quotes.quotes ?? quotes;
const quoteBy = Object.fromEntries(qList.map((q) => [q.code.replace('US.', ''), q]));

const rows = [];
for (const s of SYMS) {
  const a = load(s);
  const i = a.length - 1;
  const st = superTrend(a);
  const s200 = sma(a, i, 200);
  const A = atr(a, i);
  let since = 0, k = i;
  while (k > 0 && st[k - 1] === st[i]) { k--; since++; }
  let downFlips8 = 0;
  for (let j = Math.max(1, i - 8); j <= i; j++) if (st[j] === false && st[j - 1] === true) downFlips8++;
  const q = quoteBy[s];
  const pre = Number(q?.pre_market?.price) || null;
  const regular = Number(q?.last_price) || null;
  const ref = pre ?? regular ?? a[i].c;
  const passed = st[i] === true && s200 != null && a[i].c > s200 && since < 10 && downFlips8 === 0 && !blackout.has(`US.${s}`);
  const stop = a[i].c - 3 * A;
  const riskQty = Math.floor((equity * 0.01) / (a[i].c - stop));
  const capQty = Math.floor((equity * 0.12) / ref);
  const rawQty = Math.min(riskQty, capQty);
  const r20 = a[i].c / a[i - 20].c - 1;
  rows.push({
    symbol: `US.${s}`, close: a[i].c, regularLast: regular, preMarket: pre, ref: +ref.toFixed(2), r20: +(r20 * 100).toFixed(1),
    superTrend: st[i] ? 'UP' : 'DOWN', barsSinceFlip: since, aboveSma200: s200 ? a[i].c > s200 : false,
    atr: +A.toFixed(2), stop: +stop.toFixed(2), stopPct: +((a[i].c - stop) / a[i].c * 100).toFixed(2),
    riskQty, capQty, qty: passed ? rawQty : 0,
    limit: passed ? +(ref * 1.0015).toFixed(2) : null,
    weightPct: passed ? +(rawQty * ref / equity * 100).toFixed(2) : 0,
    riskPct: passed ? +(rawQty * (a[i].c - stop) / equity * 100).toFixed(2) : 0,
    eligible: passed, reason: !st[i] ? 'supertrend down' : !s200 || a[i].c <= s200 ? 'below sma200' : since >= 10 ? `flip stale (${since})` : downFlips8 ? 'whipsaw guard' : blackout.has(`US.${s}`) ? 'earnings blackout' : 'ok'
  });
}

const picks = rows.filter((r) => r.eligible && r.qty > 0 && r.qty * r.ref >= 500)
  .sort((x, y) => y.r20 - x.r20)
  .slice(0, 6);

const out = {
  generatedAt: new Date().toISOString(),
  strategy: 'Atlas Trend SuperTrend(10,3) v1.0.0',
  spec: 'docs/STRATEGY_SPEC.md',
  equity, blackout: [...blackout],
  market: {
    spyClose: rows.find((r) => r.symbol === 'US.SPY')?.close,
    spySuperTrend: rows.find((r) => r.symbol === 'US.SPY')?.superTrend,
    spyBarsSinceFlip: rows.find((r) => r.symbol === 'US.SPY')?.barsSinceFlip,
    breadthUp: rows.filter((r) => r.superTrend === 'UP').length,
    breadthTotal: rows.length
  },
  picks, all: rows
};
fs.mkdirSync(path.join(ROOT, 'reports'), { recursive: true });
fs.writeFileSync(path.join(ROOT, 'reports', 'plan-supertrend.json'), JSON.stringify(out, null, 2));
console.table(rows.map(({ symbol, close, preMarket, superTrend, barsSinceFlip, aboveSma200, atr, stop, qty, limit, weightPct, riskPct, reason }) => ({ symbol, close, preMarket, superTrend, barsSinceFlip, aboveSma200, atr, stop, qty, limit, weightPct, riskPct, reason })));
console.log('PICKS:', JSON.stringify(out.picks.map(({ symbol, qty, limit, stop, weightPct, riskPct }) => ({ symbol, qty, limit, stop, weightPct, riskPct })), null, 1));
