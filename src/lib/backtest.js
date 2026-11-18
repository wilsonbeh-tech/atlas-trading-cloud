import { computeSignalTable, marketRegime, normalizeBars } from './signals.js';
import { buildTargets } from './allocator.js';
import { buildOrders } from './planner.js';
import { performance, tradeStats, monthlyReturns, round4 } from './metrics.js';

export function runBacktest(rawSeries, cfg) {
  const series = Object.fromEntries(Object.entries(rawSeries).map(([s, bars]) => [s, normalizeBars(bars)]));
  const bench = series[cfg.benchmark];
  if (!bench || bench.length < cfg.backtest.warmupBars + 20) {
    throw new Error(`Benchmark history too short (${bench?.length ?? 0} bars)`);
  }
  const dates = bench.map((b) => b.date);
  const aligned = {};
  for (const [symbol, bars] of Object.entries(series)) {
    const map = new Map(bars.map((b) => [b.date, b]));
    aligned[symbol] = dates.map((d) => map.get(d) ?? null);
  }

  let cash = cfg.backtest.startCash;
  const positions = new Map();
  let pending = [];
  let peakEquity = cfg.backtest.startCash;
  let prevEquity = cfg.backtest.startCash;
  let haltUntilIdx = -1;
  const equitySeries = [];
  const exposureSeries = [];
  const trades = [];
  const planLog = [];

  const barsUpTo = (symbol, idx) => {
    const out = [];
    const arr = aligned[symbol];
    if (!arr) return out;
    for (let i = 0; i <= idx; i++) if (arr[i]) out.push(arr[i]);
    return out;
  };

  const markToMarket = (idx) => {
    let mv = 0;
    for (const [symbol, p] of positions) {
      const bar = aligned[symbol]?.[idx];
      if (bar) mv += p.qty * bar.close;
    }
    return { equity: cash + mv, mv };
  };

  const execute = (order, idx, reason) => {
    const bar = aligned[order.symbol]?.[idx];
    if (!bar) return;
    const open = bar.open;
    if (order.side === 'BUY' && open > order.limitPrice * 1.001) return;
    if (order.side === 'SELL' && open < order.limitPrice * 0.999) return;
    const slip = order.side === 'BUY' ? 1 + cfg.execution.slippageBps / 10000 : 1 - cfg.execution.slippageBps / 10000;
    const fill = round4(open * slip);
    let qty = order.qty;
    if (order.side === 'BUY') {
      qty = Math.min(qty, Math.floor((cash - cfg.execution.platformFeePerOrder) / fill));
      if (qty <= 0) return;
      const notional = qty * fill;
      const fee = cfg.execution.platformFeePerOrder;
      cash -= notional + fee;
      const existing = positions.get(order.symbol);
      if (existing) {
        const totalQty = existing.qty + qty;
        existing.avg = (existing.avg * existing.qty + notional) / totalQty;
        existing.qty = totalQty;
        existing.peak = Math.max(existing.peak, fill);
        existing.atr = order.atr ?? existing.atr;
      } else {
        positions.set(order.symbol, { qty, avg: fill, peak: fill, atr: order.atr ?? 0, entryDate: dates[idx] });
      }
      trades.push({ date: dates[idx], side: 'BUY', symbol: order.symbol, qty, price: fill, notional: round4(notional), fee, reason });
    } else {
      const p = positions.get(order.symbol);
      if (!p) return;
      qty = Math.min(qty, p.qty);
      if (qty <= 0) return;
      const notional = qty * fill;
      const secFee = Math.min(qty * cfg.execution.secFeePerShareSold, cfg.execution.secFeeCap);
      const fee = round4(cfg.execution.platformFeePerOrder + secFee);
      const pnl = round4((fill - p.avg) * qty - fee);
      cash += notional - fee;
      p.qty -= qty;
      trades.push({ date: dates[idx], side: 'SELL', symbol: order.symbol, qty, price: fill, notional: round4(notional), fee, pnl, reason: reason ?? order.reason });
      if (p.qty === 0) positions.delete(order.symbol);
    }
  };

  for (let i = cfg.backtest.warmupBars; i < dates.length; i++) {
    const prevIdx = i - 1;

    for (const [symbol, p] of [...positions]) {
      const bar = aligned[symbol]?.[i];
      if (!bar) continue;
      const stop = Math.max(p.avg * (1 - cfg.risk.stopLossPct), p.atr > 0 ? p.peak - cfg.risk.trailingAtrMult * p.atr : -Infinity);
      if (bar.low <= stop) {
        const fill = Math.min(bar.open, stop);
        execute({ symbol, side: 'SELL', qty: p.qty, limitPrice: fill, notional: p.qty * fill, reason: 'stop exit' }, i, 'stop exit');
      }
    }

    if (pending.length) {
      for (const order of pending.filter((o) => o.side === 'SELL')) execute(order, i);
      for (const order of pending.filter((o) => o.side === 'BUY')) execute(order, i);
      pending = [];
    }

    for (const [symbol, p] of positions) {
      const bar = aligned[symbol]?.[i];
      if (bar) p.peak = Math.max(p.peak, bar.close);
    }
    const { equity, mv } = markToMarket(i);
    peakEquity = Math.max(peakEquity, equity);
    const dd = equity / peakEquity - 1;
    const dayPnl = equity / prevEquity - 1;
    equitySeries.push({ date: dates[i], equity: round4(equity) });
    exposureSeries.push({ date: dates[i], exposure: equity > 0 ? round4(mv / equity) : 0, positions: positions.size });

    if (i === haltUntilIdx) {
      for (const [symbol, p] of [...positions]) {
        execute({ symbol, side: 'SELL', qty: p.qty, limitPrice: -Infinity, notional: p.qty * (aligned[symbol]?.[i]?.open ?? 0), reason: 'kill switch flatten' }, i);
      }
    } else if (dd <= -cfg.risk.drawdownKillPct || dayPnl <= -cfg.risk.dailyLossFlattenPct) {
      planLog.push({ date: dates[i], action: 'KILL_SWITCH', drawdown: round4(dd), dayPnl: round4(dayPnl) });
      for (const [symbol, p] of [...positions]) {
        execute({ symbol, side: 'SELL', qty: p.qty, limitPrice: aligned[symbol]?.[i]?.close ?? 0, notional: p.qty * (aligned[symbol]?.[i]?.close ?? 0), reason: 'kill switch flatten' }, i);
      }
      if (dd <= -cfg.risk.drawdownKillPct) haltUntilIdx = i + cfg.risk.killCooldownDays;
      peakEquity = cash;
    } else if ((i - cfg.backtest.warmupBars) % cfg.backtest.rebalanceEvery === 0 && i > haltUntilIdx) {
      const subset = {};
      for (const symbol of cfg.universe) subset[symbol] = barsUpTo(symbol, i);
      const signalRows = computeSignalTable(subset, cfg);
      const regime = marketRegime(subset, cfg);
      let targets = buildTargets(signalRows, subset, cfg, regime, [...positions.keys()]);
      if (dd <= -cfg.risk.drawdownDeRiskPct) {
        targets = { ...targets, weights: Object.fromEntries(Object.entries(targets.weights).map(([s, w]) => [s, w * 0.5])), gross: targets.gross * 0.5, deRisked: true };
      }
      const quotes = {};
      for (const [symbol, p] of positions) quotes[symbol] = { last_price: aligned[symbol]?.[i]?.close };
      for (const row of signalRows) quotes[row.symbol] = { last_price: row.close };
      const meta = Object.fromEntries([...positions.entries()].map(([s, p]) => [s, { entryPrice: p.avg, peakPrice: p.peak, atr: p.atr }]));
      const orders = buildOrders({
        targets,
        positions: [...positions.entries()].map(([symbol, p]) => ({ symbol, qty: p.qty, qtyAvailable: p.qty, curPrice: quotes[symbol]?.last_price ?? 0, cur_price: quotes[symbol]?.last_price ?? 0 })),
        quotes,
        equity,
        cfg,
        metaBySymbol: meta
      });
      for (const o of orders) {
        const row = signalRows.find((r) => r.symbol === o.symbol);
        pending.push({ ...o, atr: row?.atr14 ?? 0 });
      }
      planLog.push({ date: dates[i], action: 'REBALANCE', regime: regime.state, dd: round4(dd), orders: orders.length, gross: targets.gross });
    }
    prevEquity = equity;
  }

  const equityValues = equitySeries.map((e) => e.equity);
  const metrics = performance(equityValues);
  const stats = tradeStats(trades);
  const benchWindow = bench.slice(cfg.backtest.warmupBars);
  const benchBase = benchWindow[0]?.close ?? 1;
  const benchmarkEquity = benchWindow.map((b) => ({ date: b.date, equity: round4((cfg.backtest.startCash * b.close) / benchBase) }));
  const benchmark = { metrics: performance(benchmarkEquity.map((b) => b.equity)), equity: benchmarkEquity };
  return {
    config: cfg.name,
    from: dates[cfg.backtest.warmupBars],
    to: dates.at(-1),
    metrics: { ...metrics, ...stats },
    benchmark,
    monthly: monthlyReturns(equitySeries.map((e) => e.date), equityValues),
    equity: equitySeries,
    exposure: exposureSeries,
    trades,
    plans: planLog,
    finalPositions: [...positions.entries()].map(([symbol, p]) => ({
      symbol, qty: p.qty, avg: round4(p.avg), last: aligned[symbol]?.at(-1)?.close ?? null, peak: round4(p.peak)
    }))
  };
}
