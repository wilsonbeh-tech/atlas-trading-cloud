#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ROOT, REPORTS, DATA, ensureDirs, readJson, writeJson, loadState, saveState,
  loadKlines, readJsonl, logDecision, logRejection, logFill, logOrder, logEquity
} from './lib/ledger.js';
import { computeSignalTable, marketRegime, normalizeBars, eligibility } from './lib/signals.js';
import { buildTargets } from './lib/allocator.js';
import { buildOrders, normalizePosition, normalizeSymbol } from './lib/planner.js';
import { evaluateRiskState, guardOrders, addTradingDays } from './lib/risk.js';
import { runBacktest } from './lib/backtest.js';
import { buildDashboard } from './lib/dashboard.js';
import { PaperBroker, pickAccount } from './lib/moomoo.js';
import { round } from './lib/indicators.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
ensureDirs();
const cfg = readJson(path.join(ROOT, 'config', 'strategy.json'));
const [cmd, ...rest] = process.argv.slice(2);
const flags = parseFlags(rest);
const FILL_STATUSES = new Set(['FILLED', 'PARTIALLY_FILLED', 'PARTIAL']);

const commands = {
  accounts, fetch, 'import-live': importLive, signals, plan, run, record, mark, backtest, dashboard, state: showState, selftest, 'snapshot-check': snapshotCheck
};

try {
  const fn = commands[cmd];
  if (!fn) {
    printUsage();
    process.exit(cmd ? 1 : 0);
  }
  await fn();
} catch (error) {
  console.error(`\n✖ ${error.message}`);
  if (process.env.DEBUG) console.error(error.stack);
  process.exit(1);
}

async function accounts() {
  const broker = await tryBroker();
  if (!broker) {
    const snapshot = readJson(path.join(DATA, 'raw', 'snapshot.json'));
    console.log(snapshot ? `Snapshot account: ${snapshot.account?.account_title} (${snapshot.account?.account_id})` : 'No snapshot and no MCP token.');
    return;
  }
  const list = await broker.accounts();
  const { account, isCompetition } = pickAccount(list, cfg);
  console.log(JSON.stringify({ accounts: list, selected: account, isCompetition }, null, 2));
}

function importLive() {
  const file = path.resolve(ROOT, flags.in ?? path.join(DATA, 'raw', 'live-input.json'));
  const raw = readJson(file);
  if (!raw) throw new Error(`Missing ${file}. Export sim_trade_account_list, sim_trade_cash_info, sim_trade_position_list and quote_stock_quote results into one JSON object.`);
  const accounts = raw.accounts ?? raw.account_list ?? [];
  const account = raw.account ?? accounts.find((a) => titleMatches(a.account_title));
  const isCompetition = Boolean(account && titleMatches(account.account_title));
  if (!account) throw new Error('No account object in live input');
  if (!isCompetition) console.warn(`⚠ Account "${account.account_title}" does not match "${cfg.account.matchTitle}". Snapshot marked as development.`);
  const cashRaw = raw.cash ?? raw.cash_info ?? {};
  const positionsRaw = Array.isArray(raw.positions) ? raw.positions : raw.positions?.positions ?? raw.position_list ?? [];
  const quotesRaw = Array.isArray(raw.quotes) ? raw.quotes : raw.quotes?.quote_list ?? raw.quote_list ?? [];
  const openRaw = Array.isArray(raw.open_orders) ? raw.open_orders : raw.open_orders?.orders ?? raw.orders_active ?? raw.active_orders ?? [];
  const quotes = {};
  for (const q of quotesRaw) {
    const code = normalizeSymbol(q.code ?? q.symbol);
    if (code) quotes[code] = { ...q, last_price: Number(q.last_price ?? q.price), suspension: Boolean(q.suspension) };
  }
  const cash = {
    ...cashRaw,
    total_asset: Number(cashRaw.total_asset) || undefined,
    balance: Number(cashRaw.balance ?? cashRaw.cash ?? cashRaw.available_cash) || undefined
  };
  if (!cash.total_asset) throw new Error('cash.total_asset missing from live input');
  if (!cash.balance) cash.balance = cash.total_asset - Number(cashRaw.long_mv ?? 0) - Number(cashRaw.short_mv ?? 0);
  const snapshot = {
    fetchedAt: new Date().toISOString(),
    account,
    isCompetition,
    cash,
    positions: positionsRaw.map(normalizePosition),
    quotes,
    openOrders: openRaw.map((o) => ({ ...o, symbol: normalizeSymbol(o.symbol ?? o.code) })),
    source: raw.source ?? 'mcp-agent',
    dataDate: quotesRaw[0]?.data_date ?? null
  };
  writeJson(path.join(DATA, 'raw', 'snapshot.json'), snapshot);
  const state = loadState();
  if (Number.isFinite(Number(raw.orders_today))) {
    state.dailyOrders[nyDate()] = Number(raw.orders_today);
    saveState(state);
  }
  console.log(`Snapshot saved: ${account.account_title} · equity $${cash.total_asset.toLocaleString()} · ${snapshot.positions.length} positions · ${Object.keys(quotes).length} quotes · competition=${isCompetition}`);
}

function titleMatches(title) {
  const t = String(title ?? '').toLowerCase();
  const tokens = cfg.account.matchTokens ?? [cfg.account.matchTitle];
  return tokens.length > 0 && tokens.every((w) => t.includes(String(w).toLowerCase()));
}

async function fetch() {
  const broker = await requireBroker();
  const list = await broker.accounts();
  const { account, isCompetition } = pickAccount(list, cfg);
  if (!account) throw new Error('No US paper account found');
  broker.accountId = account.account_id;
  broker.marketId = account.market_id;
  const end = flags.end ?? nyDate(new Date(Date.now() - 86400000));
  const [cash, positions, quotes] = await Promise.all([broker.cash(), broker.positions(), broker.quotes(cfg.universe)]);
  const klines = {};
  for (const symbol of cfg.universe) {
    const bars = await broker.klines(symbol, end, cfg.backtest.historyBars);
    klines[symbol] = bars;
    writeJson(path.join(DATA, 'raw', 'klines', `${symbol}.json`), bars);
    process.stdout.write(`\r  fetched ${symbol} ${bars.length} bars   `);
  }
  console.log('');
  const snapshot = {
    fetchedAt: new Date().toISOString(),
    account,
    isCompetition,
    cash,
    positions,
    quotes,
    end
  };
  writeJson(path.join(DATA, 'raw', 'snapshot.json'), snapshot);
  console.log(`Saved snapshot for ${account.account_title} (competition=${isCompetition}), equity ${cash.total_asset}`);
}

function signals() {
  const series = loadKlines(cfg.universe);
  const missing = cfg.universe.filter((s) => !series[s]?.length);
  if (missing.length) console.warn(`Missing klines: ${missing.join(', ')}`);
  const rows = computeSignalTable(series, cfg);
  const regime = marketRegime(series, cfg);
  const annotated = rows.map((r) => ({ ...r, eligibility: eligibility(r, cfg) }));
  const out = { generatedAt: new Date().toISOString(), regime, dataThrough: latestDate(series), rows: annotated };
  writeJson(path.join(REPORTS, 'signals.json'), out);
  console.log(`\nRegime: ${regime.state} — ${regime.reasons.join('; ')}`);
  console.table(annotated.slice(0, 15).map((r) => ({
    rank: r.rank, symbol: r.symbol, score: round(r.score, 2), r20: pct(r.r20), r60: pct(r.r60), r120: pct(r.r120), vol: pct(r.vol20), trend: r.trendPass ? 'pass' : 'fail'
  })));
  console.log(`\nSaved ${path.relative(ROOT, path.join(REPORTS, 'signals.json'))}`);
}

function plan() {
  const ctx = buildContext();
  const result = makePlan(ctx);
  printPlan(result);
}

async function run() {
  const ctx = buildContext();
  const result = makePlan(ctx);
  printPlan(result);
  if (!flags.execute) {
    console.log('\nDry run only. Pass --execute to send orders through Moomoo MCP.');
    return;
  }
  const broker = await requireBroker();
  const list = await broker.accounts();
  const { account, isCompetition } = pickAccount(list, cfg);
  if (!isCompetition && !flags['allow-dev']) {
    throw new Error(`Selected account "${account?.account_title}" is not the competition account. Use --allow-dev for development trading.`);
  }
  broker.accountId = account.account_id;
  broker.marketId = account.market_id;
  const submitted = [];
  for (const order of result.guard.approved) {
    const res = await broker.placeLimitOrder({
      symbol: order.symbol, side: order.side, qty: order.qty, price: order.limitPrice, note: order.reason
    });
    const orderId = res?.data?.order_id ?? res?.data?.orderId ?? null;
    submitted.push({ ...order, orderId, status: 'SUBMITTED' });
    await sleep(250);
  }
  applyExecutions(submitted, { source: 'moomoo-mcp-http', defaultStatus: 'SUBMITTED' });
  writeJson(path.join(REPORTS, 'submitted.json'), { ts: new Date().toISOString(), account, submitted });
  console.log(`\nSubmitted ${submitted.length} orders.`);
}

function record() {
  if (!flags.results) throw new Error('Pass --results reports/exec-results.json');
  const results = readJson(path.resolve(ROOT, flags.results));
  if (!Array.isArray(results)) throw new Error('Results file must be a JSON array');
  const counts = applyExecutions(results, { source: 'mcp-agent', defaultStatus: 'SUBMITTED' });
  console.log(`Recorded ${counts.submitted} submissions, ${counts.filled} fills. Daily order count: ${loadState().dailyOrders[nyDate()]}.`);
}

function normalizeExecutionStatus(value, fallback = 'SUBMITTED') {
  return String(value ?? '').trim().toUpperCase() || fallback;
}

function filledQtyFor(row, status) {
  const reported = Number(row.filledQty ?? row.cumQty ?? row.cum_qty ?? 0);
  if (reported > 0) return reported;
  return status === 'FILLED' ? Number(row.qty) || 0 : 0;
}

function isFillRecord(row, status) {
  return FILL_STATUSES.has(status) || filledQtyFor(row, status) > 0;
}

function applyExecutions(entries, { source, defaultStatus = 'SUBMITTED' }) {
  const state = loadState();
  state.positionsMeta ??= {};
  const today = nyDate();
  const signalsFile = readJson(path.join(REPORTS, 'signals.json'));
  const atrBySymbol = new Map((signalsFile?.rows ?? []).map((r) => [normalizeSymbol(r.symbol), r.atr14]));
  const prior = [
    ...readJsonl(path.join(DATA, 'fills.jsonl')),
    ...readJsonl(path.join(DATA, 'orders.jsonl'))
  ];
  const countedOrderIds = new Set();
  const seenEvents = new Set();
  for (const event of prior) {
    const orderId = String(event.orderId ?? event.order_id ?? '');
    const status = normalizeExecutionStatus(event.status);
    if (isFillRecord(event, status)) {
      seenEvents.add(`${orderId || event.ts}:${status}:${filledQtyFor(event, status)}:${event.avgFillPrice ?? event.price ?? ''}`);
    } else {
      if (orderId) countedOrderIds.add(orderId);
      seenEvents.add(`${orderId || event.ts}:${status}`);
    }
  }

  let submitted = 0;
  let filled = 0;
  for (const r of entries) {
    const symbol = normalizeSymbol(r.symbol);
    const orderQty = Number(r.qty);
    if (!symbol || !r.side || !(orderQty > 0)) continue;
    const orderId = String(r.orderId ?? r.order_id ?? '');
    const status = normalizeExecutionStatus(r.status, defaultStatus);
    const reason = r.reason ?? 'executed via Moomoo MCP';

    if (isFillRecord(r, status)) {
      const filledQty = filledQtyFor(r, status);
      const fillPrice = Number(r.avgFillPrice ?? r.avg_fill_price ?? r.price ?? r.limitPrice);
      if (!(filledQty > 0) || !(fillPrice > 0)) continue;
      const key = `${orderId || r.ts || ''}:${status}:${filledQty}:${fillPrice}`;
      if (seenEvents.has(key)) continue;
      seenEvents.add(key);
      logFill({
        symbol, side: r.side, qty: filledQty, orderQty, price: fillPrice,
        notional: round(filledQty * fillPrice, 2), reason, orderId: orderId || null,
        status, filledQty, avgFillPrice: fillPrice, source
      });
      const meta = state.positionsMeta[symbol] ?? {};
      if (r.side === 'BUY') {
        state.positionsMeta[symbol] = {
          entryPrice: meta.entryPrice ?? fillPrice,
          entryDate: meta.entryDate ?? today,
          peakPrice: Math.max(fillPrice, Number(meta.peakPrice) || 0),
          atr: meta.atr ?? atrBySymbol.get(symbol) ?? 0
        };
      } else if (/exit|stop|flatten|kill/i.test(reason) || r.full === true) {
        delete state.positionsMeta[symbol];
      }
      if (orderId && !countedOrderIds.has(orderId)) {
        state.dailyOrders[today] = (state.dailyOrders[today] ?? 0) + 1;
        countedOrderIds.add(orderId);
      }
      filled++;
      continue;
    }

    const limitPrice = Number(r.limitPrice ?? r.price);
    if (!(limitPrice > 0)) continue;
    const key = `${orderId || r.ts || ''}:${status}`;
    if (seenEvents.has(key)) continue;
    seenEvents.add(key);
    logOrder({
      symbol, side: r.side, qty: orderQty, orderQty, limitPrice,
      reason, orderId: orderId || null, status, source
    });
    if (!orderId || !countedOrderIds.has(orderId)) {
      state.dailyOrders[today] = (state.dailyOrders[today] ?? 0) + 1;
      if (orderId) countedOrderIds.add(orderId);
    }
    submitted++;
  }

  saveState(state);
  if (submitted) logDecision({ action: 'ORDERS_SUBMITTED', summary: `${submitted} orders submitted (${source})` });
  if (filled) logDecision({ action: 'EXECUTION_RECORDED', summary: `${filled} fills recorded (${source})` });
  return { submitted, filled };
}

function reconcilePositionMeta(state, positions, quotes, signalRows, today) {
  state.positionsMeta ??= {};
  const live = new Map(positions.filter((p) => Number(p.qty) > 0).map((p) => [p.symbol, p]));
  for (const symbol of Object.keys(state.positionsMeta)) {
    if (!live.has(symbol)) delete state.positionsMeta[symbol];
  }
  const atrBySymbol = new Map(signalRows.map((r) => [normalizeSymbol(r.symbol), r.atr14]));
  for (const p of live.values()) {
    const meta = state.positionsMeta[p.symbol] ?? {};
    const mark = Number(p.avgPrice) || Number(p.curPrice) || Number(quotes[p.symbol]?.last_price) || 0;
    if (!(mark > 0) && !(Number(meta.entryPrice) > 0)) continue;
    const entryPrice = mark > 0 ? mark : Number(meta.entryPrice);
    const current = Number(p.curPrice) || Number(quotes[p.symbol]?.last_price) || entryPrice;
    state.positionsMeta[p.symbol] = {
      entryPrice,
      entryDate: meta.entryDate ?? today,
      peakPrice: Math.max(Number(meta.peakPrice) || 0, current, entryPrice),
      atr: Number(meta.atr) || atrBySymbol.get(p.symbol) || 0
    };
  }
}

function mark() {
  const equity = Number(flags.equity);
  if (!Number.isFinite(equity) || equity <= 0) throw new Error('Pass --equity <number>');
  const state = loadState();
  const today = nyDate();
  if (state.lastEquityDate !== today) {
    state.dayStartEquity = equity;
    state.lastEquityDate = today;
  }
  state.startingEquity ??= equity;
  state.lastEquity = equity;
  state.peakEquity = Math.max(state.peakEquity ?? equity, equity);
  saveState(state);
  logEquity({ equity, source: 'manual' });
  console.log(`Equity marked at $${equity.toLocaleString()}.`);
}

function backtest() {
  const series = loadKlines(cfg.universe);
  const missing = cfg.universe.filter((s) => !series[s]?.length);
  if (missing.length) throw new Error(`Missing klines for: ${missing.join(', ')}`);
  const result = runBacktest(series, cfg);
  writeJson(path.join(REPORTS, 'backtest.json'), result);
  const m = result.metrics;
  console.log(`\nBacktest ${result.from} → ${result.to} (${m.days} days, net of fees & slippage)`);
  console.table([{
    totalReturn: pct(m.totalReturn), cagr: pct(m.cagr), vol: pct(m.vol), sharpe: m.sharpe, sortino: m.sortino,
    maxDD: pct(m.maxDrawdown), calmar: m.calmar, winRate: pct(m.winRate), trades: m.closedTrades, profitFactor: m.profitFactor
  }]);
  console.log(`Monthly: ${result.monthly.map((x) => `${x.month} ${pct(x.ret)}`).join(' · ')}`);
  const dash = buildDashboard();
  console.log(`\nSaved ${path.relative(ROOT, path.join(REPORTS, 'backtest.json'))} and ${path.relative(ROOT, dash)}`);
}

function dashboard() {
  const out = buildDashboard();
  console.log(`Dashboard: ${out}`);
}

function showState() {
  const state = loadState();
  const equity = state.lastEquity ?? null;
  const risk = equity ? evaluateRiskState({
    equity, peakEquity: state.peakEquity ?? equity, dayStartEquity: state.dayStartEquity ?? equity, state, today: nyDate(), cfg
  }) : null;
  console.log(JSON.stringify({ state, risk }, null, 2));
}

function snapshotCheck() {
  const series = loadKlines(cfg.universe);
  const snapshot = readJson(path.join(DATA, 'raw', 'snapshot.json'));
  const rows = cfg.universe.map((symbol) => ({
    symbol, bars: series[symbol]?.length ?? 0, lastDate: series[symbol]?.at(-1)?.date ?? '—', quote: snapshot?.quotes?.[symbol]?.last_price ?? '—'
  }));
  console.table(rows);
  console.log(`Snapshot: ${snapshot ? `${snapshot.account?.account_title}, equity ${snapshot.cash?.total_asset}` : 'missing'}`);
}

function selftest() {
  const results = [];
  const check = (name, cond) => { results.push({ name, pass: Boolean(cond) }); if (!cond) console.error(`  ✖ ${name}`); };
  const bars = syntheticBars(260);
  const rows = computeSignalTable({ 'US.TEST': bars }, cfg);
  check('signals compute', rows.length === 1 && Number.isFinite(rows[0].score));
  const regime = marketRegime({ [cfg.benchmark]: bars }, cfg);
  check('regime computes', ['RISK_ON', 'CAUTION', 'RISK_OFF'].includes(regime.state));

  const fakeSeries = { 'US.A': bars, 'US.B': bars.map((b) => ({ ...b, close: b.close * 0.9 })) };
  const targets = buildTargets(rows, fakeSeries, cfg, { state: 'RISK_ON', reasons: [] }, []);
  const weights = Object.values(targets.weights);
  check('weights <= 20% cap', weights.every((w) => w <= cfg.allocation.maxNameWeight + 1e-6));
  check('gross <= 90%', targets.gross <= cfg.allocation.maxGross + 1e-6);

  const orders = buildOrders({
    targets: { weights: { 'US.A': 0.25 } },
    positions: [{ symbol: 'US.A', qty: 0, qtyAvailable: 0, curPrice: 100, cur_price: 100 }],
    quotes: { 'US.A': { last_price: 100 } },
    equity: 100000, cfg
  });
  const guard = guardOrders(orders, {
    cfg, equity: 100000, positions: [], quotes: { 'US.A': { last_price: 100 } }, cash: 100000,
    riskState: { halted: false }, ordersToday: 0, universe: ['US.A']
  });
  check('guard rejects >40% single name', guard.approved.every((o) => o.notional / 100000 <= 0.4));
  check('planner emits orders', orders.length > 0);

  const haltedGuard = guardOrders(orders, {
    cfg, equity: 100000, positions: [], quotes: { 'US.A': { last_price: 100 } }, cash: 100000,
    riskState: { halted: true }, ordersToday: 0, universe: ['US.A']
  });
  check('kill switch blocks buys', haltedGuard.approved.length === 0);
  check('cooldown date advances', addTradingDays('2026-11-13', 1) === '2026-11-16');

  const bt = runBacktest({ [cfg.benchmark]: bars, 'US.TEST': bars }, cfg);
  check('backtest produces equity curve', bt.equity.length > 10 && Number.isFinite(bt.metrics.totalReturn));

  const passed = results.filter((r) => r.pass).length;
  console.log(`\n${passed}/${results.length} checks passed`);
  if (passed !== results.length) process.exit(1);
}

function buildContext() {
  const series = loadKlines(cfg.universe);
  if (!series[cfg.benchmark]?.length) throw new Error('No klines. Run fetch (HTTP) or place kline files in data/raw/klines.');
  const snapshot = readJson(path.join(DATA, 'raw', 'snapshot.json'));
  const signalsOut = readJson(path.join(REPORTS, 'signals.json')) ?? computeSignalTable(series, cfg);
  const rowList = signalsOut.rows ?? signalsOut;
  const signalRows = rowList.map((r) => ({ ...r, eligibility: undefined }));
  const regime = signalsOut.regime ?? marketRegime(series, cfg);
  const state = loadState();
  const positions = (snapshot?.positions ?? []).map(normalizePosition);
  const equity = Number(snapshot?.cash?.total_asset ?? state.lastEquity ?? cfg.account.startingEquity);
  const quotes = {};
  for (const symbol of cfg.universe) {
    const q = snapshot?.quotes?.[symbol];
    const lastClose = normalizeBars(series[symbol] ?? []).at(-1)?.close;
    quotes[symbol] = { last_price: Number(q?.last_price ?? lastClose) || undefined, suspension: Boolean(q?.suspension) };
  }
  const today = nyDate();
  if (state.lastEquityDate !== today) {
    state.dayStartEquity = state.lastEquity ?? equity;
    state.lastEquityDate = today;
  }
  return { series, snapshot, signalRows, regime, state, positions, equity, quotes, today };
}

function projectOrders({ approved, positions, quotes, cash, equity, ordersToday }) {
  const qtyBySymbol = new Map(positions.map((p) => [p.symbol, Number(p.qty) || 0]));
  let projectedCash = Number(cash);
  for (const order of approved) {
    const signed = order.side === 'BUY' ? order.qty : -order.qty;
    qtyBySymbol.set(order.symbol, (qtyBySymbol.get(order.symbol) ?? 0) + signed);
    projectedCash += order.side === 'BUY' ? -order.qty * order.limitPrice : order.qty * order.limitPrice;
  }
  const longs = [...qtyBySymbol.entries()].filter(([, qty]) => qty > 0);
  const gross = longs.reduce((a, [symbol, qty]) => a + qty * (quotes[symbol]?.last_price ?? 0), 0) / equity;
  return {
    cash: round(projectedCash, 2),
    positions: longs.length,
    gross: round(gross, 4),
    ordersToday: ordersToday + approved.length
  };
}

function makePlan(ctx) {
  const { series, snapshot, signalRows, regime, state, positions, equity, quotes, today } = ctx;
  if (snapshot) reconcilePositionMeta(state, positions, quotes, signalRows, today);
  const stateForRisk = { haltUntil: state.haltUntil };
  let riskState = evaluateRiskState({
    equity, peakEquity: state.peakEquity ?? equity, dayStartEquity: state.dayStartEquity ?? equity, state: stateForRisk, today, cfg
  });
  const targets = buildTargets(signalRows, series, cfg, regime, positions.map((p) => p.symbol));
  if (riskState.deRisk) {
    targets.weights = Object.fromEntries(Object.entries(targets.weights).map(([s, w]) => [s, round(w * 0.5, 4)]));
    targets.gross = round(targets.gross * 0.5, 4);
    targets.deRisked = true;
  }
  const orders = buildOrders({
    targets, positions, quotes, equity, cfg,
    metaBySymbol: state.positionsMeta ?? {},
    forceFlatten: riskState.flatten
  });
  const cash = Number(snapshot?.cash?.balance ?? equity);
  const guard = guardOrders(orders, {
    cfg, equity, positions, quotes, cash, riskState,
    ordersToday: state.dailyOrders?.[today] ?? 0, universe: cfg.universe
  });
  const openSymbols = new Set((snapshot?.openOrders ?? []).map((o) => o.symbol).filter(Boolean));
  if (openSymbols.size) {
    const stillApproved = [];
    for (const order of guard.approved) {
      if (openSymbols.has(order.symbol)) guard.rejected.push({ ...order, reason: 'open order already exists for this symbol' });
      else stillApproved.push(order);
    }
    guard.approved = stillApproved;
    guard.projected = projectOrders({
      approved: stillApproved, positions, quotes, cash, equity,
      ordersToday: state.dailyOrders?.[today] ?? 0
    });
  }

  const planOut = {
    generatedAt: new Date().toISOString(),
    account: snapshot?.account ?? null,
    isCompetition: snapshot?.isCompetition ?? null,
    equity,
    cash,
    regime,
    risk: riskState,
    targets: { weights: targets.weights, gross: targets.gross, selected: targets.selected, portfolioVol: targets.portfolioVol },
    orders,
    approved: guard.approved,
    rejected: guard.rejected,
    projected: guard.projected
  };
  writeJson(path.join(REPORTS, 'plan.json'), planOut);

  state.startingEquity ??= equity;
  state.lastEquity = equity;
  state.peakEquity = Math.max(state.peakEquity ?? equity, equity);
  state.lastRunAt = planOut.generatedAt;
  state.haltUntil = riskState.haltUntil;
  saveState(state);
  if (snapshot) logEquity({ equity, source: 'snapshot' });

  logDecision({
    action: 'PLAN',
    summary: `${regime.state} · equity $${round(equity, 2)} · ${targets.selected.length} targets · ${guard.approved.length} approved / ${guard.rejected.length} rejected · gross ${round(targets.gross * 100, 1)}%`,
    regime: regime.state,
    equity,
    risk: riskState,
    targets: targets.weights,
    approved: guard.approved,
    rejected: guard.rejected
  });
  for (const r of guard.rejected) logRejection({ ...r, account: snapshot?.account?.account_title ?? null });
  return { ...planOut, guard };
}

function printPlan(result) {
  console.log(`\nAccount: ${result.account?.account_title ?? 'offline'} (${result.isCompetition ? 'competition' : 'development'})`);
  console.log(`Equity: $${round(result.equity, 2)} · Regime: ${result.regime.state} · Targets: ${result.targets.selected.map((s) => s.symbol).join(', ') || 'none'}`);
  if (result.risk.reasons.length) console.log(`Risk: ${result.risk.reasons.join('; ')}`);
  console.log(`\nOrders (${result.guard.approved.length} approved / ${result.guard.rejected.length} rejected):`);
  if (result.guard.approved.length) console.table(result.guard.approved.map((o) => ({ side: o.side, symbol: o.symbol, qty: o.qty, limit: o.limitPrice, notional: o.notional, reason: o.reason.slice(0, 60) })));
  if (result.guard.rejected.length) {
    console.log('Rejected:');
    console.table(result.guard.rejected.map((o) => ({ symbol: o.symbol, side: o.side, reason: o.reason })));
  }
  console.log(`Projected: cash $${result.projected.cash}, positions ${result.projected.positions}, gross ${round(result.projected.gross * 100, 1)}%, orders today ${result.projected.ordersToday}`);
  console.log(`\nSaved ${path.relative(ROOT, path.join(REPORTS, 'plan.json'))}`);
}

async function tryBroker() {
  const url = process.env.MOOMOO_MCP_URL;
  const token = process.env.MOOMOO_MCP_TOKEN;
  if (!url || !token) return null;
  const client = await PaperBroker.connect({ url, token });
  return new PaperBroker(client, { accountId: null, marketId: cfg.account.marketId });
}

async function requireBroker() {
  const broker = await tryBroker();
  if (!broker) throw new Error('HTTP transport not configured. Set MOOMOO_MCP_URL=https://mcp.moomoo.com/mcp and MOOMOO_MCP_TOKEN, or use the Qoder MCP tools with the skills/momo-momentum workflow.');
  return broker;
}

function syntheticBars(count) {
  const out = [];
  const start = Date.UTC(2025, 0, 6);
  for (let i = 0, cursor = start; out.length < count; i++) {
    const d = new Date(cursor);
    const day = d.getUTCDay();
    if (day !== 0 && day !== 6) {
      const close = 100 + out.length * 0.2;
      out.push({
        date: d.toISOString().slice(0, 10),
        open: close - 0.5, high: close + 1, low: close - 1, close, volume: 5_000_000
      });
    }
    cursor += 86400000;
  }
  return out;
}

function nyDate(d = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}

function latestDate(series) {
  const dates = Object.values(series).flatMap((bars) => bars.map((b) => String(b.date ?? b.time_key)));
  return dates.sort().at(-1) ?? null;
}

function pct(v) {
  const n = Number(v);
  return Number.isFinite(n) ? `${n >= 0 ? '+' : ''}${(n * 100).toFixed(2)}%` : '—';
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseFlags(args) {
  const out = { _: [] };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = args[i + 1];
      if (next && !next.startsWith('--')) {
        out[key] = next;
        i++;
      } else out[key] = true;
    } else out._.push(a);
  }
  return out;
}

function printUsage() {
  console.log(`Atlas dual-momentum paper agent

Commands:
  accounts                      List Moomoo paper accounts and select the competition account
  fetch [--end YYYY-MM-DD]      Fetch account, quotes and klines over MCP HTTP (needs MOOMOO_MCP_TOKEN)
  signals                       Compute momentum signals and regime from local klines
  plan                          Build target portfolio, orders and guardrail checks
  run [--execute] [--allow-dev] Plan and optionally submit orders over MCP HTTP
  record --results <file>       Log executions returned by the Qoder MCP tools and update position metadata
  mark --equity <number>        Mark current account equity for drawdown tracking
  backtest                      Run the historical backtest and regenerate the dashboard
  dashboard                     Regenerate reports/dashboard.html
  snapshot-check                Verify kline and snapshot inputs
  state                         Show persisted risk state
  selftest                      Run deterministic unit checks
`);
}
