#!/usr/bin/env node
// Strategy A-H research harness on Moomoo daily bars (data/raw/klines-moomoo).
// Decision at close, fill at next open, 5bps slippage, $0.99/order, SEC fee on sells.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIR = path.join(ROOT, 'data', 'raw', 'klines-moomoo');
const START_CASH = 100000;
const SLIP = 0.0005;
const FEE = 0.99;
const SEC = 0.000166;
const MAXPOS = 0.12;
const EVAL_START = 210;

const UNIVERSE = ['SPY','QQQ','IWM','SMH','TLT','GLD','XLE','XLF','XLK','XLV','XLY','XLU','AAPL','MSFT','NVDA','AMZN','GOOGL','META','AVGO','JPM','LLY','V','COST','XOM'];

function load(sym) {
  const j = JSON.parse(fs.readFileSync(path.join(DIR, `US.${sym}.json`), 'utf8'));
  return j.kline_list.map((b) => ({ date: String(b.date), o: b.open_price, h: b.high_price, l: b.low_price, c: b.close_price, v: b.volume }));
}

const bars = Object.fromEntries(UNIVERSE.map((s) => [s, load(s)]));
const dates = bars.SPY.map((b) => b.date);
const closeAt = Object.fromEntries(UNIVERSE.map((s) => [s, Object.fromEntries(bars[s].map((b) => [b.date, b]))]));

function sma(arr, i, n) {
  if (i < n - 1) return null;
  let s = 0;
  for (let k = i - n + 1; k <= i; k++) s += arr[k].c;
  return s / n;
}
function atr(arr, i, n = 14) {
  if (i < n) return null;
  let s = 0;
  for (let k = i - n + 1; k <= i; k++) s += Math.max(arr[k].h - arr[k].l, Math.abs(arr[k].h - arr[k - 1].c), Math.abs(arr[k].l - arr[k - 1].c));
  return s / n;
}
function rsi(arr, i, n = 2) {
  if (i < n) return null;
  let g = 0, l = 0;
  for (let k = i - n + 1; k <= i; k++) {
    const d = arr[k].c - arr[k - 1].c;
    if (d > 0) g += d; else l -= d;
  }
  if (g + l === 0) return 50;
  const rs = (g / n) / (l / n || 1e-9);
  return 100 - 100 / (1 + rs);
}
function ema(values, n) {
  const k = 2 / (n + 1);
  let e = values[0];
  const out = [e];
  for (let i = 1; i < values.length; i++) { e = values[i] * k + e * (1 - k); out.push(e); }
  return out;
}
const macdCache = Object.fromEntries(UNIVERSE.map((s) => {
  const closes = bars[s].map((b) => b.c);
  const f = ema(closes, 12), slow = ema(closes, 26);
  const line = f.map((x, i) => x - slow[i]);
  const sig = ema(line, 9);
  return [s, line.map((x, i) => x - sig[i])];
}));
function superTrend(arr, period = 10, mult = 3) {
  const out = new Array(arr.length).fill(null);
  let fu = null, fl = null, trend = true;
  for (let i = 0; i < arr.length; i++) {
    const a = atr(arr, i, period);
    if (a == null) continue;
    const mid = (arr[i].h + arr[i].l) / 2;
    const bu = mid + mult * a, bl = mid - mult * a;
    if (fu == null) { fu = bu; fl = bl; out[i] = true; continue; }
    const prevC = arr[i - 1].c;
    fu = bu < fu || prevC > fu ? bu : fu;
    fl = bl > fl || prevC < fl ? bl : fl;
    trend = arr[i].c > fu ? true : arr[i].c < fl ? false : trend;
    out[i] = trend;
  }
  return out;
}
const stCache = Object.fromEntries(UNIVERSE.map((s) => [s, superTrend(bars[s])]));

class Book {
  constructor() { this.cash = START_CASH; this.pos = new Map(); this.pending = []; this.trades = []; this.eq = []; }
  equityAt(i) {
    let mv = 0;
    for (const [s, p] of this.pos) mv += p.qty * bars[s][i].c;
    return this.cash + mv;
  }
  submit(o) { this.pending.push(o); }
  fillPending(i) {
    for (const o of this.pending) {
      const b = bars[o.sym][i];
      if (!b) continue;
      if (o.side === 'BUY') {
        const px = b.o * (1 + SLIP);
        if (o.limit && px > o.limit * 1.01) continue;
        const cap = this.equityAt(i) * MAXPOS;
        let qty = Math.floor(Math.min(cap, this.cash - FEE) / px);
        if (o.qty) qty = Math.min(qty, o.qty);
        if (qty <= 0 || qty * px < 500) continue;
        this.cash -= qty * px + FEE;
        this.pos.set(o.sym, { qty, entry: px, peak: px, stop: o.stop, days: 0 });
      } else {
        const p = this.pos.get(o.sym);
        if (!p) continue;
        const px = b.o * (1 - SLIP);
        this.cash += p.qty * px - FEE - Math.min(p.qty * SEC, 8.3);
        this.trades.push({ sym: o.sym, side: 'BUY', entry: p.entry, exit: px, qty: p.qty, days: p.days, pnl: (px - p.entry) * p.qty - 2 * FEE });
        this.pos.delete(o.sym);
      }
    }
    this.pending = [];
  }
  stopCheck(i) {
    for (const [s, p] of this.pos) {
      const b = bars[s][i];
      if (b.l <= p.stop) {
        const px = Math.min(p.stop, b.o) * (1 - SLIP);
        this.cash += p.qty * px - FEE - Math.min(p.qty * SEC, 8.3);
        this.trades.push({ sym: s, side: 'BUY', entry: p.entry, exit: px, qty: p.qty, days: p.days, pnl: (px - p.entry) * p.qty - 2 * FEE, reason: 'stop' });
        this.pos.delete(s);
      }
    }
  }
}

function metrics(name, eq, trades, note = '') {
  const rets = eq.slice(1).map((v, k) => v / eq[k] - 1);
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
  const sd = Math.sqrt(rets.reduce((a, b) => a + (b - mean) ** 2, 0) / (rets.length - 1));
  const dn = Math.sqrt(rets.filter((r) => r < 0).reduce((a, b) => a + b * b, 0) / rets.length);
  let peak = eq[0], dd = 0;
  for (const v of eq) { peak = Math.max(peak, v); dd = Math.min(dd, v / peak - 1); }
  const wins = trades.filter((t) => t.pnl > 0), losses = trades.filter((t) => t.pnl <= 0);
  const gp = wins.reduce((a, t) => a + t.pnl, 0), gl = -losses.reduce((a, t) => a + t.pnl, 0);
  const roll = [];
  for (let k = 7; k < eq.length; k++) roll.push(eq[k] / eq[k - 7] - 1);
  roll.sort((a, b) => a - b);
  const q = (p) => roll.length ? +(roll[Math.floor((roll.length - 1) * p)] * 100).toFixed(2) : null;
  return {
    strategy: name, note,
    totalReturnPct: +((eq.at(-1) / eq[0] - 1) * 100).toFixed(2),
    maxDrawdownPct: +(dd * 100).toFixed(2),
    sharpe: +(mean / (sd || 1e-9) * Math.sqrt(252)).toFixed(2),
    sortino: +(mean / (dn || 1e-9) * Math.sqrt(252)).toFixed(2),
    annVolPct: +(sd * Math.sqrt(252) * 100).toFixed(1),
    winRatePct: trades.length ? +(wins.length / trades.length * 100).toFixed(1) : null,
    profitFactor: gl > 0 ? +(gp / gl).toFixed(2) : null,
    trades: trades.length,
    avgHoldDays: trades.length ? +(trades.reduce((a, t) => a + t.days, 0) / trades.length).toFixed(1) : null,
    roll7MeanPct: roll.length ? +(roll.reduce((a, b) => a + b, 0) / roll.length * 100).toFixed(2) : null,
    roll7MedPct: q(0.5), roll7P05: q(0.05), roll7P95: q(0.95), roll7PosPct: roll.length ? +(roll.filter((r) => r > 0).length / roll.length * 100).toFixed(0) : null
  };
}

const spy = bars.SPY;
const spyUp = (i) => { const s = sma(spy, i, 200); return s != null && spy[i].c > s; };

function run(name, note, step) {
  const b = new Book();
  const eq = [];
  for (let i = EVAL_START; i < dates.length; i++) {
    b.fillPending(i);
    b.stopCheck(i);
    step(b, i);
    for (const p of b.pos.values()) p.days++;
    eq.push(b.equityAt(i));
  }
  return metrics(name, eq, b.trades, note);
}

// B: RSI(2) snapback on momentum leaders, ATR stop
const B = (withRegime) => run(`B RSI2 snapback${withRegime ? ' +SPY>200' : ''}`,
  'leaders close>200d, 50d>200d; entry RSI2<10; exit RSI2>65 or 5d; stop 2.5ATR',
  (b, i) => {
    if (withRegime && !spyUp(i)) { for (const s of b.pos.keys()) b.submit({ side: 'SELL', sym: s }); return; }
    for (const [s, p] of b.pos) {
      const arr = bars[s];
      if (rsi(arr, i) > 65 || p.days >= 5) b.submit({ side: 'SELL', sym: s });
    }
    if (b.pos.size >= 6) return;
    for (const s of UNIVERSE) {
      if (b.pos.has(s)) continue;
      const arr = bars[s];
      const s200 = sma(arr, i, 200), s50 = sma(arr, i, 50), r = rsi(arr, i), a = atr(arr, i);
      if (!s200 || !s50 || r == null || !a) continue;
      if (arr[i].c > s200 && s50 > s200 && r < 10) {
        b.submit({ side: 'BUY', sym: s, stop: arr[i].c - 2.5 * a });
      }
    }
  });

// C: SuperTrend(10,3) + SMA200 + whipsaw guard
const C = (useMacd, guard) => run(`C SuperTrend10,3${useMacd ? ' +MACD' : ''}${guard ? ' +whipsaw guard' : ''}`,
  'flip-up with close>200d; exit flip-down; trail 3ATR; guard: skip flip after recent flip-down',
  (b, i) => {
    for (const [s, p] of b.pos) {
      const arr = bars[s];
      b.pos.get(s).peak = Math.max(p.peak, arr[i].c);
      b.pos.get(s).stop = Math.max(p.stop, p.peak - 3 * (atr(arr, i) ?? 0));
      if (stCache[s][i] === false) b.submit({ side: 'SELL', sym: s });
    }
    if (b.pos.size >= 6) return;
    for (const s of UNIVERSE) {
      if (b.pos.has(s)) continue;
      const arr = bars[s], st = stCache[s];
      if (st[i] !== true || st[i - 1] !== false) continue;
      const s200 = sma(arr, i, 200);
      if (!s200 || arr[i].c <= s200) continue;
      if (guard) {
        let flips = 0;
        for (let k = Math.max(1, i - 8); k <= i; k++) if (st[k] === false && st[k - 1] === true) flips++;
        if (flips > 0) continue;
      }
      if (useMacd && !(macdCache[s][i] > 0)) continue;
      b.submit({ side: 'BUY', sym: s, stop: arr[i].c - 3 * (atr(arr, i) ?? 0) });
    }
  });

// A: post-earnings drift proxy (gap up >3%, hold 7d)
const A = (dir, minGap, hold) => {
  const up = dir > 0;
  return run(`A ${up ? 'post-earnings gap-up drift' : 'post-earnings gap-down dip'} (${minGap}%)`,
    `gap ${up ? '>=' : '<='} ${minGap}% proxy for earnings; hold ${hold}d; stop 2ATR`,
    (b, i) => {
      for (const [s, p] of b.pos) if (p.days >= hold) b.submit({ side: 'SELL', sym: s });
      if (b.pos.size >= 4) return;
      for (const s of UNIVERSE) {
        if (b.pos.has(s)) continue;
        const arr = bars[s];
        if (i < 25) continue;
        const gap = arr[i].o / arr[i - 1].c - 1;
        let v20 = 0;
        for (let k = i - 19; k <= i; k++) v20 += arr[k].v;
        v20 /= 20;
        const s50 = sma(arr, i, 50), s200 = sma(arr, i, 200);
        if (!s50 || !s200) continue;
        const rng = arr[i].h - arr[i].l || 1e-9;
        const posInRange = (arr[i].c - arr[i].l) / rng;
        const ok = up
          ? gap >= minGap / 100 && arr[i].c > s50 && posInRange > 0.5 && arr[i].v > v20
          : gap <= -minGap / 100 && arr[i].c > s200 && posInRange > 0.6;
        if (ok) b.submit({ side: 'BUY', sym: s, stop: arr[i].c - 2 * (atr(arr, i) ?? 0) });
      }
    });
};

// F: catalyst momentum (gap-and-go, 3d)
const F = () => run('F catalyst gap-and-go', 'gap>=2% + vol>=1.5x avg20 + SPY>200; 3d hold; 3% stop',
  (b, i) => {
    for (const [s, p] of b.pos) {
      const arr = bars[s];
      b.pos.get(s).peak = Math.max(p.peak, arr[i].c);
      if (p.days >= 3 || arr[i].c < p.entry * 0.97) b.submit({ side: 'SELL', sym: s });
    }
    if (b.pos.size >= 4 || !spyUp(i)) return;
    for (const s of UNIVERSE) {
      if (b.pos.has(s)) continue;
      const arr = bars[s];
      if (i < 25) continue;
      const gap = arr[i].o / arr[i - 1].c - 1;
      let v20 = 0;
      for (let k = i - 19; k <= i; k++) v20 += arr[k].v;
      v20 /= 20;
      const s50 = sma(arr, i, 50);
      if (!s50) continue;
      if (gap >= 0.02 && arr[i].v >= 1.5 * v20 && arr[i].c > s50) {
        b.submit({ side: 'BUY', sym: s, stop: arr[i].c * 0.97 });
      }
    }
  });

// E: grid on SPY
const E = () => {
  const b = new Book();
  const eq = [];
  let anchor = null, lots = [];
  for (let i = EVAL_START; i < dates.length; i++) {
    const px = spy[i].c;
    if (anchor == null) {
      anchor = px;
      const qty = Math.floor(START_CASH * 0.4 / px);
      b.cash -= qty * px + FEE;
      lots.push({ px, qty, lvl: 0 });
    }
    for (let lvl = 1; lvl <= 4; lvl++) {
      const trigger = anchor * (1 - 0.02 * lvl);
      if (px <= trigger && !lots.some((l) => l.lvl === lvl)) {
        const qty = Math.floor(START_CASH * 0.1 / px);
        if (b.cash > qty * px + FEE) { b.cash -= qty * px + FEE; lots.push({ px, qty, lvl }); }
      }
    }
    for (const l of lots.slice()) {
      if (l.lvl > 0 && px >= l.px * 1.02) {
        b.cash += l.qty * px - FEE; lots = lots.filter((x) => x !== l);
        b.trades.push({ sym: 'SPY', entry: l.px, exit: px, qty: l.qty, days: 0, pnl: (px - l.px) * l.qty - 2 * FEE });
      }
    }
    eq.push(b.cash + lots.reduce((a, l) => a + l.qty * px, 0));
  }
  return metrics('E Moomoo-style grid (SPY +-2%x4)', eq, b.trades, 'static anchor, no stop, grid fills only');
};

// C variants: entry window since flip, optional 7-session time stop (competition fit)
function runC(entryWindow, timeStop, useMacd = false) {
  return run(`C ST10,3 w=${entryWindow}${timeStop ? ` t${timeStop}` : ''}${useMacd ? ' +MACD' : ''}`,
    `entry if flip <=${entryWindow} bars ago; exit flip-down${timeStop ? ` or ${timeStop}d` : ''}; trail 3ATR; whipsaw guard`,
    (b, i) => {
      for (const [s, p] of b.pos) {
        const arr = bars[s];
        b.pos.get(s).peak = Math.max(p.peak, arr[i].c);
        b.pos.get(s).stop = Math.max(p.stop, p.peak - 3 * (atr(arr, i) ?? 0));
        if (stCache[s][i] === false || (timeStop && p.days >= timeStop)) b.submit({ side: 'SELL', sym: s });
      }
      if (b.pos.size >= 6) return;
      for (const s of UNIVERSE) {
        if (b.pos.has(s)) continue;
        const arr = bars[s], st = stCache[s];
        if (st[i] !== true) continue;
        let since = 0, k = i;
        while (k > 0 && st[k - 1] === true) { k--; since++; }
        if (since >= entryWindow) continue;
        const s200 = sma(arr, i, 200);
        if (!s200 || arr[i].c <= s200) continue;
        let flips = 0;
        for (let j = Math.max(1, i - 8); j <= i; j++) if (st[j] === false && st[j - 1] === true) flips++;
        if (flips > 0) continue;
        if (useMacd && !(macdCache[s][i] > 0)) continue;
        b.submit({ side: 'BUY', sym: s, stop: arr[i].c - 3 * (atr(arr, i) ?? 0) });
      }
    });
}

// C-trend + RSI2 pullback trigger (deploys in established uptrends)
function runTrendDip(timeStop, rsiEntry = 10, rsiExit = 65) {
  return run(`C+RSI2 pullback t${timeStop}`,
    `uptrend (ST up, close>200d); buy RSI2<${rsiEntry}; exit RSI2>${rsiExit}, ST flip or ${timeStop}d; trail 3ATR`,
    (b, i) => {
      for (const [s, p] of b.pos) {
        const arr = bars[s];
        b.pos.get(s).peak = Math.max(p.peak, arr[i].c);
        b.pos.get(s).stop = Math.max(p.stop, p.peak - 3 * (atr(arr, i) ?? 0));
        if (stCache[s][i] === false || rsi(arr, i) > rsiExit || p.days >= timeStop) b.submit({ side: 'SELL', sym: s });
      }
      if (b.pos.size >= 6) return;
      for (const s of UNIVERSE) {
        if (b.pos.has(s)) continue;
        const arr = bars[s];
        const s200 = sma(arr, i, 200), r = rsi(arr, i);
        if (!s200 || r == null) continue;
        if (stCache[s][i] === true && arr[i].c > s200 && r < rsiEntry) {
          b.submit({ side: 'BUY', sym: s, stop: arr[i].c - 3 * (atr(arr, i) ?? 0) });
        }
      }
    });
}

const variantResults = [runC(5, 7), runC(10, 7), runC(10, 0), runC(15, 7), runC(20, 7), runC(10, 7, true), runTrendDip(7), runTrendDip(5), runTrendDip(7, 15)];

const signalTable = UNIVERSE.map((s) => {
  const i = bars[s].length - 1;
  const st = stCache[s];
  let since = 0, k = i;
  while (k > 0 && st[k - 1] === st[i]) { k--; since++; }
  const s200 = sma(bars[s], i, 200), s50 = sma(bars[s], i, 50);
  const r20 = bars[s][i].c / bars[s][i - 20].c - 1;
  const r60 = bars[s][i].c / bars[s][i - 60].c - 1;
  return {
    symbol: s, close: +bars[s][i].c.toFixed(2), superTrend: st[i] ? 'UP' : 'DOWN', barsSinceFlip: since,
    aboveSma200: s200 ? bars[s][i].c > s200 : null, sma50Above200: s50 && s200 ? s50 > s200 : null,
    rsi2: +rsi(bars[s], i).toFixed(1), atrPct: +(atr(bars[s], i) / bars[s][i].c * 100).toFixed(2),
    r20Pct: +(r20 * 100).toFixed(1), r60Pct: +(r60 * 100).toFixed(1)
  };
});

const results = [B(true), B(false), C(false, true), C(false, false), C(true, true), A(1, 3, 7), A(-1, 3, 5), F(), E(), ...variantResults];
const spyEq = dates.slice(EVAL_START).map((d, k) => START_CASH * (spy[EVAL_START + k].c / spy[EVAL_START].c));
const bench = metrics('SPY buy & hold', spyEq, [], 'benchmark');
const out = { generatedAt: new Date().toISOString(), source: 'Moomoo quote_history_kline (forward-adjusted, daily, 370 bars)', window: { start: dates[EVAL_START], end: dates.at(-1), sessions: dates.length - EVAL_START }, costs: { slippageBps: 5, feePerOrder: FEE, secFeePerShareSold: SEC }, results, bench, signalTable };
fs.mkdirSync(path.join(ROOT, 'reports'), { recursive: true });
fs.writeFileSync(path.join(ROOT, 'reports', 'research-strategies.json'), JSON.stringify(out, null, 2));
console.table([...results, bench]);
console.table(signalTable);
console.log(`window ${out.window.start}..${out.window.end} (${out.window.sessions} sessions)`);
