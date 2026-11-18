import { round } from './indicators.js';

export function normalizeSymbol(symbol) {
  const s = String(symbol ?? '').toUpperCase().trim();
  return s && !s.includes('.') ? `US.${s}` : s;
}

export function normalizePosition(p) {
  return {
    symbol: normalizeSymbol(p.symbol),
    qty: Number(p.qty) || 0,
    qtyAvailable: Number(p.qty_avbl ?? p.qtyAvailable ?? p.qty) || 0,
    avgPrice: Number(p.buy_avg_price ?? p.cost_price ?? p.avgPrice) || 0,
    curPrice: Number(p.cur_price ?? p.curPrice) || 0,
    marketValue: Number(p.mv ?? p.marketValue) || 0,
    unrealizedPnl: Number(p.profit ?? p.unrealizedPnl) || 0,
    unrealizedPct: Number(p.profit_ratio ?? p.unrealizedPct) || 0
  };
}

export function stopReason(position, meta, quote, cfg) {
  if (!meta || !quote) return null;
  const close = quote.last_price;
  const r = cfg.risk;
  if (meta.entryPrice > 0 && close <= meta.entryPrice * (1 - r.stopLossPct)) {
    return `stop loss: ${round((close / meta.entryPrice - 1) * 100, 1)}% vs entry`;
  }
  if (meta.peakPrice > 0 && meta.atr > 0) {
    const trail = meta.peakPrice - r.trailingAtrMult * meta.atr;
    if (close <= trail) return `ATR trailing stop: close below ${round(trail)}`;
  }
  return null;
}

export function buildOrders({ targets, positions, quotes, equity, cfg, metaBySymbol = {}, forceFlatten = false }) {
  const r = cfg.risk;
  const orders = [];
  const currentBySymbol = new Map(positions.map((p) => [p.symbol, p]));
  const reasonBySymbol = new Map();

  const sellAll = (symbol, qty, price, reason) => {
    if (!(qty > 0) || !(price > 0)) return;
    const limitPrice = round(price * (1 - cfg.execution.limitOffsetPct), 2);
    orders.push({
      symbol, side: 'SELL', qty: Math.floor(qty), limitPrice,
      notional: round(Math.floor(qty) * price, 2), reason
    });
  };

  if (forceFlatten) {
    for (const p of positions) {
      if (p.qty > 0) sellAll(p.symbol, p.qtyAvailable, quotes[p.symbol]?.last_price ?? p.curPrice, 'risk kill switch: flatten book');
    }
    return finalize(orders, equity);
  }

  for (const p of positions) {
    const quote = quotes[p.symbol];
    const stop = stopReason(p, metaBySymbol[p.symbol], quote, cfg);
    if (stop) {
      sellAll(p.symbol, p.qtyAvailable, quote?.last_price ?? p.curPrice, stop);
      reasonBySymbol.set(p.symbol, stop);
    }
  }

  for (const p of positions) {
    if (reasonBySymbol.has(p.symbol)) continue;
    const target = targets.weights[p.symbol] ?? 0;
    if (target <= 0 && p.qty > 0) {
      sellAll(p.symbol, p.qtyAvailable, quotes[p.symbol]?.last_price ?? p.curPrice, 'exit: dropped out of target portfolio');
    }
  }

  for (const [symbol, weight] of Object.entries(targets.weights)) {
    if (reasonBySymbol.has(symbol)) continue;
    const quote = quotes[symbol];
    if (!quote) continue;
    const price = quote.last_price;
    const current = currentBySymbol.get(symbol);
    const currentQty = current?.qty ?? 0;
    const currentNotional = currentQty * price;
    const desired = equity * weight;
    const delta = desired - currentNotional;
    if (delta > r.rebalanceBandPct * equity) {
      const qty = Math.floor(delta / price);
      if (qty > 0) {
        orders.push({
          symbol, side: 'BUY', qty,
          limitPrice: round(price * (1 + cfg.execution.limitOffsetPct), 2),
          notional: round(qty * price, 2),
          reason: `add to target ${round(weight * 100, 1)}% (rank-driven rebalance)`,
          targetWeight: weight,
          currentWeight: round(currentNotional / equity, 4)
        });
      }
    } else if (delta < -r.rebalanceBandPct * equity && currentQty > 0) {
      const qty = Math.min(Math.floor(-delta / price), current?.qtyAvailable ?? currentQty);
      if (qty > 0) {
        orders.push({
          symbol, side: 'SELL', qty,
          limitPrice: round(price * (1 - cfg.execution.limitOffsetPct), 2),
          notional: round(qty * price, 2),
          reason: `trim to target ${round(weight * 100, 1)}%`,
          targetWeight: weight,
          currentWeight: round(currentNotional / equity, 4)
        });
      }
    }
  }
  return finalize(orders, equity);
}

function finalize(orders, equity) {
  const clean = orders.filter((o) => o.qty > 0 && o.notional > 0);
  clean.sort((a, b) => (a.side === b.side ? b.notional - a.notional : a.side === 'SELL' ? -1 : 1));
  return clean.map((o) => ({ ...o, weightOfEquity: round(o.notional / equity, 4) }));
}
