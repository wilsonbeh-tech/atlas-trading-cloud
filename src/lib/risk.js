import { round } from './indicators.js';

export function evaluateRiskState({ equity, peakEquity, dayStartEquity, state = {}, today, cfg }) {
  const r = cfg.risk;
  const drawdownPct = peakEquity > 0 ? equity / peakEquity - 1 : 0;
  const dailyPnlPct = dayStartEquity > 0 ? equity / dayStartEquity - 1 : 0;
  const reasons = [];
  let flatten = false;
  let deRisk = false;
  let haltUntil = state.haltUntil ?? null;

  if (haltUntil && today <= haltUntil) {
    reasons.push(`kill switch active until ${haltUntil}`);
    flatten = true;
  }
  if (dailyPnlPct <= -r.dailyLossFlattenPct) {
    reasons.push(`daily loss ${round(dailyPnlPct * 100)}% <= -${r.dailyLossFlattenPct * 100}%`);
    flatten = true;
  }
  if (drawdownPct <= -r.drawdownKillPct) {
    reasons.push(`drawdown ${round(drawdownPct * 100)}% <= -${r.drawdownKillPct * 100}%`);
    flatten = true;
    haltUntil = addTradingDays(today, r.killCooldownDays);
    reasons.push(`halt new entries until ${haltUntil}`);
  } else if (drawdownPct <= -r.drawdownDeRiskPct) {
    reasons.push(`drawdown ${round(drawdownPct * 100)}% <= -${r.drawdownDeRiskPct * 100}%`);
    deRisk = true;
  }

  return {
    drawdownPct: round(drawdownPct, 4),
    dailyPnlPct: round(dailyPnlPct, 4),
    flatten,
    deRisk,
    haltUntil,
    reasons,
    halted: Boolean(haltUntil && today <= haltUntil)
  };
}

export function addTradingDays(isoDate, days) {
  const d = new Date(`${isoDate}T00:00:00Z`);
  let added = 0;
  while (added < days) {
    d.setUTCDate(d.getUTCDate() + 1);
    const day = d.getUTCDay();
    if (day !== 0 && day !== 6) added++;
  }
  return d.toISOString().slice(0, 10);
}

export function guardOrders(orders, ctx) {
  const { cfg, equity, positions, quotes, riskState, ordersToday, universe, cash } = ctx;
  const r = cfg.risk;
  const approved = [];
  const rejected = [];
  const projected = new Map();
  for (const p of positions) projected.set(p.symbol, { qty: Number(p.qty) || 0, price: Number(p.cur_price ?? p.curPrice) || 0 });
  let projectedCash = Number(cash);
  let projectedOrderCount = ordersToday;
  const touched = new Set();

  const reject = (order, reason) => rejected.push({ ...order, reason });

  for (const order of orders) {
    const quote = quotes[order.symbol];
    if (!universe.includes(order.symbol)) { reject(order, 'symbol outside approved universe'); continue; }
    if (!quote || !Number.isFinite(quote.last_price)) { reject(order, 'no valid quote'); continue; }
    if (quote.suspension) { reject(order, 'security suspended'); continue; }
    if (quote.last_price < r.minPrice) { reject(order, `price below $${r.minPrice}`); continue; }
    if (touched.has(order.symbol)) { reject(order, 'duplicate symbol in plan'); continue; }
    if (!(order.qty > 0) || !Number.isInteger(order.qty)) { reject(order, 'invalid quantity'); continue; }
    if (order.notional < r.minNotional) { reject(order, `notional $${round(order.notional)} below $${r.minNotional}`); continue; }
    if (projectedOrderCount + approved.length >= r.maxOrdersPerDay) { reject(order, 'daily order cap reached'); continue; }
    const dev = Math.abs(order.limitPrice / quote.last_price - 1);
    if (dev > r.maxLimitDeviationPct) { reject(order, `limit price ${round(dev * 100, 2)}% away from market`); continue; }
    if (order.side === 'BUY' && riskState.halted) { reject(order, 'risk halt active (no new buys)'); continue; }

    const pos = projected.get(order.symbol) ?? { qty: 0, price: quote.last_price };
    const signedDelta = order.side === 'BUY' ? order.qty : -order.qty;
    const newQty = pos.qty + signedDelta;
    if (newQty < 0) { reject(order, `insufficient shares (held ${pos.qty})`); continue; }
    const newValue = newQty * quote.last_price;
    const weight = newValue / equity;
    if (weight > cfg.allocation.maxNameWeightHard) { reject(order, `post-trade weight ${round(weight * 100)}% exceeds hard ${cfg.allocation.maxNameWeightHard * 100}% cap`); continue; }

    const cashDelta = order.side === 'BUY' ? -order.qty * order.limitPrice : order.qty * order.limitPrice;
    if (projectedCash + cashDelta < 0) { reject(order, 'insufficient cash'); continue; }

    approved.push(order);
    touched.add(order.symbol);
    projectedCash += cashDelta;
    projected.set(order.symbol, { qty: newQty, price: quote.last_price });
  }

  const exposure = () => {
    const longs = [...projected.values()].filter((p) => p.qty > 0);
    return { longs, gross: longs.reduce((a, p) => a + p.qty * p.price, 0) / equity };
  };
  let { longs, gross } = exposure();
  for (let i = approved.length - 1; i >= 0 && gross > cfg.allocation.maxGross; i--) {
    if (approved[i].side !== 'BUY') continue;
    rejected.push({ ...approved[i], reason: `projected gross ${round(gross * 100)}% exceeds ${cfg.allocation.maxGross * 100}%` });
    projected.set(approved[i].symbol, {
      qty: projected.get(approved[i].symbol).qty - approved[i].qty,
      price: projected.get(approved[i].symbol).price
    });
    approved.splice(i, 1);
    ({ longs, gross } = exposure());
  }
  for (let i = approved.length - 1; i >= 0 && longs.length > cfg.allocation.maxPositions; i--) {
    if (approved[i].side !== 'BUY') continue;
    rejected.push({ ...approved[i], reason: `post-trade positions exceed ${cfg.allocation.maxPositions}` });
    projected.set(approved[i].symbol, {
      qty: projected.get(approved[i].symbol).qty - approved[i].qty,
      price: projected.get(approved[i].symbol).price
    });
    approved.splice(i, 1);
    ({ longs, gross } = exposure());
  }

  return {
    approved,
    rejected,
    projected: {
      cash: round(projectedCash, 2),
      positions: longs.length,
      gross: round(gross, 4),
      ordersToday: projectedOrderCount + approved.length
    }
  };
}
