import { maxDrawdown, stdev } from './indicators.js';

export function performance(equitySeries, { periodsPerYear = 252, riskFree = 0 } = {}) {
  const values = equitySeries.map((p) => (typeof p === 'number' ? p : p.equity)).filter((v) => Number.isFinite(v) && v > 0);
  if (values.length < 2) return emptyMetrics();
  const returns = [];
  for (let i = 1; i < values.length; i++) returns.push(values[i] / values[i - 1] - 1);
  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  const sd = stdev(returns) ?? 0;
  const downside = returns.filter((r) => r < 0);
  const downsideDev = downside.length ? Math.sqrt(downside.reduce((a, r) => a + r * r, 0) / downside.length) : 0;
  const totalReturn = values.at(-1) / values[0] - 1;
  const years = returns.length / periodsPerYear;
  const cagr = years > 0 ? (values.at(-1) / values[0]) ** (1 / years) - 1 : 0;
  const vol = sd * Math.sqrt(periodsPerYear);
  const sharpe = sd > 0 ? ((mean - riskFree / periodsPerYear) / sd) * Math.sqrt(periodsPerYear) : 0;
  const sortino = downsideDev > 0 ? ((mean - riskFree / periodsPerYear) / downsideDev) * Math.sqrt(periodsPerYear) : 0;
  const mdd = maxDrawdown(values);
  return {
    start: round4(values[0]),
    end: round4(values.at(-1)),
    totalReturn: round4(totalReturn),
    cagr: round4(cagr),
    vol: round4(vol),
    sharpe: round4(sharpe),
    sortino: round4(sortino),
    maxDrawdown: round4(mdd),
    calmar: mdd < 0 ? round4(cagr / Math.abs(mdd)) : 0,
    bestDay: round4(Math.max(...returns)),
    worstDay: round4(Math.min(...returns)),
    days: values.length
  };
}

export function tradeStats(trades) {
  const closed = trades.filter((t) => t.side === 'SELL' && Number.isFinite(t.pnl));
  const wins = closed.filter((t) => t.pnl > 0);
  const losses = closed.filter((t) => t.pnl <= 0);
  const grossWin = wins.reduce((a, t) => a + t.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((a, t) => a + t.pnl, 0));
  return {
    closedTrades: closed.length,
    winRate: closed.length ? round4(wins.length / closed.length) : 0,
    avgWin: wins.length ? round4(grossWin / wins.length) : 0,
    avgLoss: losses.length ? round4(grossLoss / losses.length) : 0,
    profitFactor: grossLoss > 0 ? round4(grossWin / grossLoss) : null,
    totalRealized: round4(closed.reduce((a, t) => a + t.pnl, 0))
  };
}

export function monthlyReturns(dates, equity) {
  const months = new Map();
  for (let i = 0; i < dates.length; i++) {
    const key = String(dates[i]).slice(0, 7);
    if (!months.has(key)) months.set(key, { first: equity[i], last: equity[i] });
    const m = months.get(key);
    m.last = equity[i];
  }
  return [...months.entries()].map(([month, m]) => ({ month, ret: round4(m.last / m.first - 1) }));
}

export function round4(v) {
  return Math.round(v * 10000) / 10000;
}

function emptyMetrics() {
  return {
    start: 0, end: 0, totalReturn: 0, cagr: 0, vol: 0, sharpe: 0, sortino: 0,
    maxDrawdown: 0, calmar: 0, bestDay: 0, worstDay: 0, days: 0
  };
}
