export function sma(values, period) {
  if (period <= 0 || values.length < period) return null;
  let sum = 0;
  for (let i = values.length - period; i < values.length; i++) sum += values[i];
  return sum / period;
}

export function smaSeries(values, period) {
  const out = new Array(values.length).fill(null);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= period) sum -= values[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

export function stdev(values) {
  if (values.length < 2) return null;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance);
}

export function dailyReturns(closes) {
  const out = [];
  for (let i = 1; i < closes.length; i++) out.push(closes[i] / closes[i - 1] - 1);
  return out;
}

export function pctChange(closes, lookback) {
  if (closes.length <= lookback) return null;
  const prior = closes[closes.length - 1 - lookback];
  if (!prior) return null;
  return closes[closes.length - 1] / prior - 1;
}

export function atr(bars, period = 14) {
  if (bars.length < period + 1) return null;
  const trs = [];
  for (let i = 1; i < bars.length; i++) {
    const prevClose = bars[i - 1].close;
    trs.push(Math.max(
      bars[i].high - bars[i].low,
      Math.abs(bars[i].high - prevClose),
      Math.abs(bars[i].low - prevClose)
    ));
  }
  const window = trs.slice(-period);
  return window.reduce((a, b) => a + b, 0) / window.length;
}

export function rsi(closes, period = 14) {
  if (closes.length < period + 1) return null;
  let gains = 0;
  let losses = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) gains += diff;
    else losses -= diff;
  }
  if (losses === 0) return 100;
  const rs = gains / losses;
  return 100 - 100 / (1 + rs);
}

export function annualizedVol(returns, periodsPerYear = 252) {
  const sd = stdev(returns);
  return sd === null ? null : sd * Math.sqrt(periodsPerYear);
}

export function zscores(entries, key) {
  const vals = entries.map((e) => e[key]).filter((v) => Number.isFinite(v));
  if (vals.length < 2) return new Map(entries.map((e) => [e.symbol, 0]));
  const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
  const sd = stdev(vals) || 1e-9;
  return new Map(entries.map((e) => [e.symbol, (Number.isFinite(e[key]) ? (e[key] - mean) / sd : 0)]));
}

export function maxDrawdown(equity) {
  let peak = -Infinity;
  let mdd = 0;
  for (const v of equity) {
    peak = Math.max(peak, v);
    mdd = Math.min(mdd, v / peak - 1);
  }
  return mdd;
}

export function covariance(seriesA, seriesB) {
  const n = Math.min(seriesA.length, seriesB.length);
  if (n < 2) return 0;
  const a = seriesA.slice(-n);
  const b = seriesB.slice(-n);
  const ma = a.reduce((x, y) => x + y, 0) / n;
  const mb = b.reduce((x, y) => x + y, 0) / n;
  let cov = 0;
  for (let i = 0; i < n; i++) cov += (a[i] - ma) * (b[i] - mb);
  return cov / (n - 1);
}

export function clamp(value, lo, hi) {
  return Math.min(hi, Math.max(lo, value));
}

export function round(value, digits = 2) {
  const f = 10 ** digits;
  return Math.round(value * f) / f;
}
