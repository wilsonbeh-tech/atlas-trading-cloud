import { covariance, dailyReturns, clamp, round } from './indicators.js';
import { eligibility, normalizeBars } from './signals.js';

export function selection(signalRows, cfg, regimeState, currentSymbols = []) {
  const rows = signalRows.filter((r) => eligibility(r, cfg).eligible);
  const maxPositions = regimeState === 'RISK_OFF' ? cfg.allocation.riskOffPositions : cfg.allocation.maxPositions;
  const buffer = cfg.allocation.holdBuffer;
  const selected = [];
  const seen = new Set();

  for (const row of rows) {
    if (selected.length >= maxPositions) break;
    if (row.rank <= maxPositions) {
      selected.push(row);
      seen.add(row.symbol);
    }
  }
  for (const sym of currentSymbols) {
    if (selected.length >= maxPositions) break;
    if (seen.has(sym)) continue;
    const row = rows.find((r) => r.symbol === sym);
    if (row && row.rank <= maxPositions + buffer) {
      selected.push(row);
      seen.add(sym);
    }
  }
  return { selected, maxPositions, eligibleCount: rows.length };
}

export function targetWeights(selected, seriesBySymbol, cfg, regimeState) {
  if (selected.length === 0) {
    return { weights: {}, gross: 0, portfolioVol: 0, scale: 0 };
  }
  const raw = selected.map((row) => ({
    symbol: row.symbol,
    score: Math.max(row.score, 0.05),
    vol: clamp(row.vol20 ?? 0.25, 0.08, 1.2)
  }));
  const rawSum = raw.reduce((a, r) => a + r.score / r.vol, 0);
  for (const r of raw) r.weight = (r.score / r.vol) / rawSum;

  const rets = {};
  for (const r of raw) {
    const bars = normalizeBars(seriesBySymbol[r.symbol] ?? []);
    rets[r.symbol] = dailyReturns(bars.map((b) => b.close)).slice(-60);
  }
  let variance = 0;
  for (let i = 0; i < raw.length; i++) {
    for (let j = 0; j < raw.length; j++) {
      const cov = covariance(rets[raw[i].symbol], rets[raw[j].symbol]);
      variance += raw[i].weight * raw[j].weight * cov;
    }
  }
  const portfolioVol = Math.sqrt(Math.max(variance, 0)) * Math.sqrt(252);
  const targetGrossCap = regimeState === 'RISK_OFF' ? cfg.allocation.riskOffGross : cfg.allocation.maxGross;
  const scale = portfolioVol > 0
    ? clamp(cfg.allocation.targetVolAnnual / portfolioVol, cfg.allocation.minGross, targetGrossCap)
    : cfg.allocation.minGross;

  const weights = {};
  for (const r of raw) weights[r.symbol] = r.weight * scale;

  const cap = cfg.allocation.maxNameWeight;
  let total = Object.values(weights).reduce((a, b) => a + b, 0);
  for (let pass = 0; pass < 5; pass++) {
    let excess = 0;
    const uncapped = [];
    for (const [sym, w] of Object.entries(weights)) {
      if (w > cap) {
        excess += w - cap;
        weights[sym] = cap;
      } else uncapped.push(sym);
    }
    if (excess < 1e-6 || uncapped.length === 0) break;
    const base = uncapped.reduce((a, s) => a + weights[s], 0);
    for (const s of uncapped) weights[s] += excess * (weights[s] / base);
    total = Object.values(weights).reduce((a, b) => a + b, 0);
  }

  const gross = Math.min(total, targetGrossCap, 1 - cfg.allocation.minCash);
  if (total > 0 && gross !== total) {
    const k = gross / total;
    for (const s of Object.keys(weights)) weights[s] *= k;
  }
  for (const s of Object.keys(weights)) weights[s] = round(weights[s], 4);
  return { weights, gross: round(gross, 4), portfolioVol: round(portfolioVol, 4), scale: round(scale, 3) };
}

export function buildTargets(signalRows, seriesBySymbol, cfg, regime, currentSymbols) {
  const { selected, maxPositions, eligibleCount } = selection(signalRows, cfg, regime.state, currentSymbols);
  const alloc = targetWeights(selected, seriesBySymbol, cfg, regime.state);
  return {
    regime,
    selected: selected.map((r) => ({ symbol: r.symbol, rank: r.rank, score: round(r.score, 3), vol20: round(r.vol20, 4), close: r.close })),
    weights: alloc.weights,
    gross: alloc.gross,
    portfolioVol: alloc.portfolioVol,
    scale: alloc.scale,
    maxPositions,
    eligibleCount
  };
}
