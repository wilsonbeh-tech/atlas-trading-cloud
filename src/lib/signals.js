import { sma, smaSeries, pctChange, atr, annualizedVol, dailyReturns, zscores, rsi, round } from './indicators.js';

export function normalizeBars(rawBars) {
  return rawBars
    .map((b) => ({
      date: String(b.date ?? b.time_key),
      open: Number(b.open),
      high: Number(b.high),
      low: Number(b.low),
      close: Number(b.close),
      volume: Number(b.volume ?? 0)
    }))
    .filter((b) => Number.isFinite(b.close) && b.close > 0)
    .sort((a, b) => a.date.localeCompare(b.date));
}

export function computeFeatures(bars, cfg) {
  const closes = bars.map((b) => b.close);
  const returns = dailyReturns(closes);
  const [w20, w60, w120] = cfg.signals.returnWindows;
  const vol = annualizedVol(returns.slice(-cfg.signals.volLookback));
  return {
    close: closes.at(-1),
    r20: pctChange(closes, w20),
    r60: pctChange(closes, w60),
    r120: pctChange(closes, w120),
    vol20: vol,
    atr14: atr(bars, cfg.signals.atrLookback),
    sma50: sma(closes, cfg.signals.trendFast),
    sma200: sma(closes, cfg.signals.trendSlow),
    rsi14: rsi(closes, 14),
    avgDollarVolume20: bars.slice(-20).reduce((a, b) => a + b.close * b.volume, 0) / Math.min(20, bars.length)
  };
}

export function computeSignalTable(seriesBySymbol, cfg) {
  const rows = [];
  for (const [symbol, bars] of Object.entries(seriesBySymbol)) {
    if (bars.length < cfg.signals.trendSlow + 5) continue;
    const f = computeFeatures(bars, cfg);
    if (!Number.isFinite(f.r60) || !Number.isFinite(f.vol20)) continue;
    rows.push({
      symbol,
      ...f,
      aboveFast: f.close > f.sma50,
      aboveSlow: f.close > f.sma200,
      trendPass: f.close > f.sma50 && f.sma50 > f.sma200
    });
  }
  const z20 = zscores(rows, 'r20');
  const z60 = zscores(rows, 'r60');
  const z120 = zscores(rows, 'r120');
  const zVol = zscores(rows, 'vol20');
  const w = cfg.signals.weights;
  for (const row of rows) {
    row.score = w.r20 * z20.get(row.symbol) + w.r60 * z60.get(row.symbol) + w.r120 * z120.get(row.symbol) - 0.15 * zVol.get(row.symbol);
  }
  rows.sort((a, b) => b.score - a.score);
  rows.forEach((row, i) => { row.rank = i + 1; });
  return rows;
}

export function marketRegime(seriesBySymbol, cfg) {
  const benchmark = normalizeBars(seriesBySymbol[cfg.benchmark] ?? []);
  if (benchmark.length < cfg.signals.trendSlow + 2) {
    return { state: 'NEUTRAL', reasons: ['insufficient benchmark history'], spyClose: null, spySma50: null, spySma200: null };
  }
  const closes = benchmark.map((b) => b.close);
  const s50 = smaSeries(closes, cfg.signals.trendFast);
  const s200 = smaSeries(closes, cfg.signals.trendSlow);
  const close = closes.at(-1);
  const sma50 = s50.at(-1);
  const sma200 = s200.at(-1);
  const reasons = [];
  let state = 'RISK_ON';
  if (close < sma200) {
    state = 'RISK_OFF';
    reasons.push(`${cfg.benchmark} close ${round(close)} below SMA200 ${round(sma200)}`);
  } else if (sma50 < sma200) {
    state = 'CAUTION';
    reasons.push(`${cfg.benchmark} SMA50 below SMA200`);
  } else {
    reasons.push(`${cfg.benchmark} above SMA200 with SMA50 > SMA200`);
  }
  return { state, reasons, spyClose: close, spySma50: sma50, spySma200: sma200 };
}

export function eligibility(signal, cfg) {
  const reasons = [];
  if (!(signal.close >= cfg.risk.minPrice)) reasons.push(`price ${signal.close} below $${cfg.risk.minPrice}`);
  if (!(signal.avgDollarVolume20 >= 20_000_000)) reasons.push('20d dollar volume below $20M');
  if (!signal.trendPass) reasons.push('trend filter failed (close>SMA50>SMA200)');
  return { eligible: reasons.length === 0, reasons };
}
