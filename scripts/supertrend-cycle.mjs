#!/usr/bin/env node
// Atlas Trend unattended cycle. Spec: docs/STRATEGY_SPEC.md v1.0.0 (SuperTrend 10,3).
// Modes:
//   --mode=intraday : manage exits (stop / ST flip / time stop / portfolio limits) and, on the first
//                     run of a session, execute the prior EOD plan (outgoing sells + approved entries).
//   --mode=eod      : after the 16:00 ET close, reconcile positions, ratchet stops, plan next session.
// Reads data/raw/live-input.json (written by the scheduled agent from Moomoo MCP), daily klines,
// config/supertrend.json. Writes reports/cycle-plan.json (+ reports/plan-supertrend.json in eod mode).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { logDecision, logRejection, logEquity } from '../src/lib/ledger.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const flags = Object.fromEntries(process.argv.slice(2).filter((a) => a.startsWith('--')).map((a) => {
  const [k, v = 'true'] = a.replace(/^--/, '').split('=');
  return [k, v];
}));
const MODE = flags.mode === 'eod' ? 'eod' : 'intraday';
const DRY = flags.dry === 'true';
const NOW = flags.now ? new Date(flags.now) : new Date();

const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'supertrend.json'), 'utf8'));
const SYMS = Object.keys(cfg.sector).map((s) => s.replace(/^US\./, ''));
const KDIR = path.join(ROOT, 'data', 'raw', 'klines-moomoo');
const DATA = path.join(ROOT, 'data');
const REPORTS = path.join(ROOT, 'reports');
const CYCLE_STATE = path.join(DATA, 'cycle-state.json');
const POS_STATE = path.join(DATA, 'positions-state.json');
const PLAN_FILE = path.join(REPORTS, 'plan-supertrend.json');
const OUT_FILE = path.join(REPORTS, 'cycle-plan.json');
const LIVE_IN = path.resolve(ROOT, flags.input ?? path.join(DATA, 'raw', 'live-input.json'));

const r2 = (x) => Math.round(x * 100) / 100;
const pct = (x) => Math.round(x * 10000) / 100;
const readJson = (f, d = null) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const writeJson = (f, v) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, `${JSON.stringify(v, null, 2)}\n`); };
const nyDate = (d = NOW) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(d);
const nyTime = (d = NOW) => new Intl.DateTimeFormat('en-GB', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hour12: false }).format(d);
const iso = (d = NOW) => d.toISOString();

function log(entry) {
  if (DRY) { console.log('DRY-LOG', JSON.stringify(entry)); return; }
  logDecision({ source: 'supertrend-cycle', ...entry });
}

// ---------- indicators ----------
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

function loadBars(sym) {
  const raw = readJson(path.join(KDIR, `${sym}.json`));
  const list = raw?.kline_list ?? [];
  return list.map((b) => ({
    date: `${String(b.date).slice(0, 4)}-${String(b.date).slice(4, 6)}-${String(b.date).slice(6, 8)}`,
    o: Number(b.open_price), h: Number(b.high_price), l: Number(b.low_price), c: Number(b.close_price), v: Number(b.volume)
  })).filter((b) => Number.isFinite(b.c)).sort((x, y) => (x.date < y.date ? -1 : 1));
}

const today = nyDate();
const market = loadAll();
function loadAll() {
  const out = {};
  for (const s of SYMS) {
    const all = loadBars(`US.${s}`);
    // During the session the newest kline row is a partial bar: exclude it from signals.
    const lastIsPartial = MODE === 'intraday' && all.length && all[all.length - 1].date === today;
    const completed = lastIsPartial ? all.slice(0, -1) : all;
    const i = completed.length - 1;
    const st = superTrend(completed, cfg.signals.stPeriod, cfg.signals.stMult);
    const a = atr(completed, i, 14);
    const s200 = sma(completed, i, cfg.signals.smaTrend);
    let since = 0, k = i;
    while (k > 0 && st[k - 1] === st[i]) { k--; since++; }
    let downFlips = 0;
    for (let j = Math.max(1, i - cfg.signals.whipsawLookback); j <= i; j++) if (st[j] === false && st[j - 1] === true) downFlips++;
    out[`US.${s}`] = {
      sym: `US.${s}`, bars: completed, lastDate: completed[i]?.date, close: completed[i]?.c,
      st: st[i], since, downFlips, atr: a, sma200: s200, r20: i >= 20 ? completed[i].c / completed[i - 20].c - 1 : null
    };
  }
  return out;
}

// ---------- live input ----------
const live = readJson(LIVE_IN);
if (!live) fail('missing live input', `No ${LIVE_IN}`);
function fail(code, msg) {
  const out = { generatedAt: iso(), mode: MODE, today, blocked: true, blocker: { code, msg }, orders: [], rejected: [] };
  writeJson(OUT_FILE, out);
  console.log(JSON.stringify(out, null, 2));
  process.exit(2);
}

// Cloud migration guard: exactly one scheduler may produce plans. Cloud deployments set ATLAS_CLOUD=1.
if (process.env.ATLAS_CLOUD !== '1') fail('LOCAL_EXECUTION_DISABLED', 'Cycles run in the cloud deployment; set ATLAS_CLOUD=1 to run here.');

const account = live.account ?? (live.accounts ?? [])[0];
const title = String(account?.account_title ?? '').toLowerCase();
const gateOk = cfg.account.matchTokens.every((t) => title.includes(t));
if (!gateOk) fail('ACCOUNT_GATE', `Account "${account?.account_title}" does not match Qoder+Challenge`);

const num = (x) => (Number.isFinite(Number(x)) ? Number(x) : 0);
const cash = live.cash ?? {};
const equity = num(cash.total_asset) || num(cash.balance) + num(cash.long_mv);
const positionsRaw = live.positions?.positions ?? live.positions ?? [];
const quotesRaw = live.quotes?.quote_list ?? live.quotes ?? [];
const quotes = {};
for (const q of quotesRaw) {
  const code = String(q.code ?? q.symbol ?? '').replace(/^US\.?/, 'US.');
  if (!code.startsWith('US.')) continue;
  quotes[code] = { ...q, last: num(q.last_price ?? q.price), low: num(q.low_price), dataDate: q.data_date ?? null };
}
const positions = positionsRaw.map((p) => ({
  symbol: String(p.code ?? p.symbol ?? '').startsWith('US.') ? String(p.code ?? p.symbol) : `US.${String(p.code ?? p.symbol).replace('US.', '')}`,
  qty: num(p.qty ?? p.can_sell_qty),
  cost: num(p.cost_price ?? p.average_cost ?? p.avg_cost ?? p.nominal_price),
  last: num(p.nominal_price ?? p.last_price)
})).filter((p) => p.symbol && p.qty > 0);

// ---------- state ----------
const cstate = readJson(CYCLE_STATE, {}) ?? {};
cstate.positions ??= {};
cstate.killUntil ??= null;
cstate.peakEquity = Math.max(num(cstate.peakEquity), equity);
if (cstate.dayStart?.date !== today) cstate.dayStart = { date: today, equity };
if (equity > cstate.dayStart.equity) cstate.dayStart.equity = Math.max(cstate.dayStart.equity, equity);

const plan = readJson(PLAN_FILE);
const heldSyms = new Set(positions.map((p) => p.symbol));

// reconcile
for (const p of positions) {
  let rec = cstate.positions[p.symbol];
  if (!rec) {
    const m = market[p.symbol];
    const base = m?.close ?? p.cost;
    const stopBar = m?.atr ? r2(base - cfg.sizing.atrMult * m.atr) : r2(p.cost * 0.9);
    const planStop = plan?.picks?.find((x) => x.symbol === p.symbol)?.stop;
    rec = cstate.positions[p.symbol] = {
      symbol: p.symbol, entryDate: today, entryPrice: p.cost || base,
      initialStop: planStop ?? stopBar, stop: planStop ?? stopBar,
      peakClose: Math.max(p.cost || 0, base), sessionsHeld: 1, lastBarDate: m?.lastDate ?? null
    };
    log({ action: 'POSITION_INIT', symbol: p.symbol, qty: p.qty, entryPrice: rec.entryPrice, stop: rec.stop, reason: 'state initialised from account position' });
  }
  if (rec.qty !== p.qty) log({ action: 'POSITION_QTY_SYNC', symbol: p.symbol, from: rec.qty, to: p.qty });
  rec.qty = p.qty;
}
for (const sym of Object.keys(cstate.positions)) {
  if (!heldSyms.has(sym)) {
    log({ action: 'POSITION_CLOSED', symbol: sym, reason: 'no longer held in account' });
    delete cstate.positions[sym];
  }
}

// ---------- risk state ----------
const dailyPnl = cstate.dayStart.equity > 0 ? equity / cstate.dayStart.equity - 1 : 0;
const drawdown = cstate.peakEquity > 0 ? equity / cstate.peakEquity - 1 : 0;
const t = nyTime();
const earlyClose = cfg.competition.earlyClose?.[today];
const sessionEnd = earlyClose ?? '16:00';
const isFinalSession = today === cfg.competition.finalSession;
const finalFlatten = isFinalSession && t >= cfg.competition.finalFlattenET;
const killActive = Boolean(cstate.killUntil && today <= cstate.killUntil);
let flatten = finalFlatten || killActive;
let deRisk = false;
const riskReasons = [];
if (dailyPnl <= -cfg.risk.dailyLossFlattenPct) { flatten = true; riskReasons.push(`daily ${pct(dailyPnl)}%`); }
if (drawdown <= -cfg.risk.drawdownKillPct) {
  flatten = true; riskReasons.push(`drawdown ${pct(drawdown)}%`);
  if (cstate.killUntil !== addSessions(today, cfg.risk.killCooldownSessions)) {
    cstate.killUntil = addSessions(today, cfg.risk.killCooldownSessions);
    log({ action: 'RISK_KILL', drawdownPct: pct(drawdown), killUntil: cstate.killUntil });
  }
} else if (drawdown <= -cfg.risk.drawdownDeRiskPct) { deRisk = true; riskReasons.push(`drawdown ${pct(drawdown)}%`); }
if (finalFlatten) riskReasons.push('final session flatten window');

function addSessions(dateStr, n) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  let added = 0;
  while (added < n) {
    d.setUTCDate(d.getUTCDate() + 1);
    const wd = d.getUTCDay();
    const ds = d.toISOString().slice(0, 10);
    if (wd !== 0 && wd !== 6 && !cfg.competition.holidays.includes(ds)) added++;
  }
  return d.toISOString().slice(0, 10);
}

function isOpen() {
  const wd = new Date(`${today}T12:00:00Z`).getUTCDay();
  if (wd === 0 || wd === 6) return false;
  if (cfg.competition.holidays.includes(today)) return false;
  return t >= '09:30' && t < sessionEnd;
}

// ---------- orders ----------
const orders = [];
const rejected = [];
const ordersToday = num(live.orders_today);
const orderBudget = Math.max(0, cfg.risk.maxOrdersPerDay - ordersToday);

function sellQty(rec, mode) {
  if (mode === 'half') return Math.floor(rec.qty / 2);
  return rec.qty;
}

function buildSell(rec, reason, kind) {
  const q = quotes[rec.symbol];
  const last = q?.last;
  if (!q || !(last > 0)) { rejected.push({ symbol: rec.symbol, side: 'SELL', reason: 'no valid quote' }); return; }
  let ref = last;
  if (kind === 'stop') ref = Math.min(last, rec.stop);
  let limit = r2(ref * (1 - cfg.risk.sellOffset));
  if (limit < last * (1 - cfg.risk.maxLimitDeviationPct)) limit = r2(last * (1 - cfg.risk.sellOffset));
  const qty = sellQty(rec, kind === 'half' ? 'half' : 'all');
  if (qty < 1) return;
  orders.push({ symbol: rec.symbol, side: 'SELL', qty, limitPrice: limit, stop: rec.stop, reason });
}

if (MODE === 'intraday' && isOpen()) {
  for (const rec of Object.values(cstate.positions)) {
    const q = quotes[rec.symbol];
    if (flatten) { buildSell(rec, `risk flatten: ${riskReasons.join('; ') || 'kill active'}`, 'flat'); continue; }
    const planned = plan?.forSession === today && (plan.outgoing ?? []).find((o) => o.symbol === rec.symbol);
    const m = market[rec.symbol];
    const sessionLow = q && q.dataDate === today ? q.low : null;
    if (planned) { buildSell(rec, `planned exit: ${planned.reason}`, 'flat'); continue; }
    if (sessionLow && sessionLow <= rec.stop) { buildSell(rec, `stop ${rec.stop.toFixed(2)} hit (low ${sessionLow})`, 'stop'); continue; }
    if (m && m.st === false) { buildSell(rec, `supertrend flip down ${m.lastDate}`, 'flat'); continue; }
    if ((rec.sessionsHeld ?? 1) >= cfg.exits.timeStopSessions) { buildSell(rec, `time stop ${rec.sessionsHeld} sessions`, 'flat'); continue; }
    if (deRisk) { buildSell(rec, `de-risk: ${riskReasons.join('; ')}`, 'half'); }
  }
}

function isoDateOnly(s) { return s; }

// entries: first intraday run of the session executes the prior EOD plan
const entriesAllowed = MODE === 'intraday' && isOpen() && !flatten && !killActive && !deRisk
  && today <= cfg.competition.noNewEntriesAfter
  && plan && plan.forSession === today && !plan.executedAt && t < '11:00';

if (entriesAllowed) {
  const held = orders.filter((o) => o.side === 'SELL').map((o) => o.symbol);
  const after = new Set([...heldSyms].filter((s) => !held.includes(s)));
  let gross = positions.filter((p) => !held.includes(p.symbol)).reduce((a, p) => a + p.qty * (quotes[p.symbol]?.last ?? p.last ?? 0), 0);
  let cashAvail = num(cash.balance) || equity - gross;
  const sectorNames = {};
  const sectorVal = {};
  for (const p of positions.filter((x) => !held.includes(x.symbol))) {
    const s = cfg.sector[p.symbol] ?? 'other';
    sectorNames[s] = (sectorNames[s] ?? 0) + 1;
    sectorVal[s] = (sectorVal[s] ?? 0) + p.qty * (quotes[p.symbol]?.last ?? p.last ?? 0);
  }
  const picks = [...(plan.picks ?? [])].sort((a, b) => (b.r20 ?? 0) - (a.r20 ?? 0));
  for (const pick of picks) {
    if (after.has(pick.symbol)) continue;
    const q = quotes[pick.symbol];
    const last = q?.last;
    const tag = { symbol: pick.symbol, side: 'BUY' };
    if (!q || !(last > 0)) { rejected.push({ ...tag, reason: 'no valid quote' }); continue; }
    if (q.suspension) { rejected.push({ ...tag, reason: 'suspended' }); continue; }
    if (last <= pick.stop) { rejected.push({ ...tag, reason: `price ${last} at/below stop ${pick.stop}` }); continue; }
    if (last > pick.limit * (1 + cfg.risk.noChasePct)) { rejected.push({ ...tag, reason: `no chase: ${last} > ${pick.limit} +1%` }); continue; }
    if (cfg.blackouts[today]?.includes(pick.symbol)) { rejected.push({ ...tag, reason: 'earnings blackout' }); continue; }
    if (after.size >= cfg.sizing.maxPositions) { rejected.push({ ...tag, reason: 'max positions' }); continue; }
    if (ordersToday + orders.length >= cfg.risk.maxOrdersPerDay) { rejected.push({ ...tag, reason: 'daily order cap' }); continue; }
    const sector = cfg.sector[pick.symbol] ?? 'other';
    const limit = r2(last * (1 + cfg.risk.buyOffset));
    let qty = Math.min(pick.qty, Math.floor((cfg.sizing.maxNameWeight * equity) / last));
    const notional = qty * limit;
    if (qty < 1 || notional < cfg.sizing.minNotional) { rejected.push({ ...tag, reason: 'size below minimum' }); continue; }
    if (notional / equity > cfg.sizing.maxNameWeight + 1e-9) { rejected.push({ ...tag, reason: 'name weight cap' }); continue; }
    if ((sectorNames[sector] ?? 0) >= cfg.sizing.maxSectorNames) { rejected.push({ ...tag, reason: `sector ${sector} name cap` }); continue; }
    if ((sectorVal[sector] ?? 0) + notional > cfg.sizing.maxSectorWeight * equity) { rejected.push({ ...tag, reason: `sector ${sector} weight cap` }); continue; }
    if (gross + notional > cfg.sizing.maxGross * equity) { rejected.push({ ...tag, reason: 'gross cap' }); continue; }
    if (cashAvail - notional < cfg.sizing.minCash * equity) { rejected.push({ ...tag, reason: 'min cash' }); continue; }
    const riskPct = (qty * (last - pick.stop)) / equity;
    if (riskPct > cfg.sizing.riskPct * 1.25) { rejected.push({ ...tag, reason: `risk ${pct(riskPct)}% too high` }); continue; }
    orders.push({ ...tag, qty, limitPrice: limit, planLimit: pick.limit, stop: pick.stop, reason: `entry: flip ${pick.barsSinceFlip ?? '?'} bars, close>200d, stop ${pick.stop}` });
    after.add(pick.symbol);
    sectorNames[sector] = (sectorNames[sector] ?? 0) + 1;
    sectorVal[sector] = (sectorVal[sector] ?? 0) + notional;
    gross += notional;
    cashAvail -= notional;
  }
  plan.executedAt = iso();
  if (!DRY) writeJson(PLAN_FILE, plan);
}

// ---------- eod ----------
let nextSession = null;
if (MODE === 'eod') {
  nextSession = addSessions(today, 1);
  const outgoing = [];
  for (const rec of Object.values(cstate.positions)) {
    const m = market[rec.symbol];
    if (!m) continue;
    const barsSinceEntry = m.bars.filter((b) => b.date >= rec.entryDate).length;
    rec.sessionsHeld = Math.max(rec.sessionsHeld ?? 1, barsSinceEntry);
    const fresh = m.lastDate === today;
    if (!fresh) {
      log({ action: 'DATA_INCIDENT', symbol: rec.symbol, reason: `no bar for ${today}, last ${m.lastDate}; stop left unchanged` });
      continue;
    }
    rec.peakClose = Math.max(rec.peakClose ?? 0, m.close);
    const candidate = r2((rec.peakClose ?? m.close) - cfg.sizing.atrMult * m.atr);
    const oldStop = rec.stop;
    if (candidate > rec.stop) rec.stop = candidate;
    rec.lastBarDate = m.lastDate;
    rec.updatedAt = iso();
    log({ action: 'STOP_RECOMPUTE', symbol: rec.symbol, oldStop, newStop: rec.stop, peakClose: r2(rec.peakClose), atr: r2(m.atr), bar: m.lastDate });
    if (m.st === false) outgoing.push({ symbol: rec.symbol, reason: `supertrend flip down ${m.lastDate}` });
    else if (rec.sessionsHeld >= cfg.exits.timeStopSessions) outgoing.push({ symbol: rec.symbol, reason: `time stop ${rec.sessionsHeld} sessions` });
    else if (cfg.blackouts[nextSession]?.includes(rec.symbol)) outgoing.push({ symbol: rec.symbol, reason: 'earnings blackout next session' });
  }
  const stalls = SYMS.filter((s) => market[`US.${s}`]?.lastDate !== today).map((s) => `US.${s}`);
  const canAdd = nextSession <= cfg.competition.noNewEntriesAfter && !killActive && !deRisk
    && !cfg.competition.holidays.includes(nextSession) && nextSession !== cfg.competition.finalSession
    && stalls.length === 0;
  const leaving = new Set(outgoing.map((o) => o.symbol));
  const heldAfter = positions.filter((p) => !leaving.has(p.symbol));
  let gross = heldAfter.reduce((a, p) => a + p.qty * (market[p.symbol]?.close ?? p.last ?? 0), 0);
  let cashAvail = num(cash.balance) || equity - gross;
  const sectorNames = {}, sectorVal = {};
  for (const p of heldAfter) {
    const s = cfg.sector[p.symbol] ?? 'other';
    sectorNames[s] = (sectorNames[s] ?? 0) + 1;
    sectorVal[s] = (sectorVal[s] ?? 0) + p.qty * (market[p.symbol]?.close ?? p.last ?? 0);
  }
  const picks = [];
  if (canAdd) {
    const rows = SYMS.map((s) => market[`US.${s}`]).filter(Boolean)
      .filter((m) => m.st === true && m.sma200 != null && m.close > m.sma200 && m.since < cfg.signals.entryWindow && m.downFlips === 0)
      .filter((m) => !leaving.has(m.sym) && !heldSyms.has(m.sym) && !cfg.blackouts[nextSession]?.includes(m.sym))
      .sort((a, b) => (b.r20 ?? -9) - (a.r20 ?? -9));
    for (const m of rows) {
      if (picks.length + heldAfter.length >= cfg.sizing.maxPositions) break;
      const sector = cfg.sector[m.sym] ?? 'other';
      if ((sectorNames[sector] ?? 0) >= cfg.sizing.maxSectorNames) continue;
      const stop = r2(m.close - cfg.sizing.atrMult * m.atr);
      const qty = Math.min(
        Math.floor((cfg.sizing.riskPct * equity) / (m.close - stop)),
        Math.floor((cfg.sizing.maxNameWeight * equity) / m.close)
      );
      if (qty < 1) continue;
      const notional = qty * m.close;
      if ((sectorVal[sector] ?? 0) + notional > cfg.sizing.maxSectorWeight * equity) continue;
      if (gross + notional > cfg.sizing.maxGross * equity) continue;
      if (cashAvail - notional < cfg.sizing.minCash * equity) continue;
      picks.push({
        symbol: m.sym, close: m.close, stop, qty, limit: r2(m.close * (1 + cfg.risk.buyOffset)),
        barsSinceFlip: m.since, r20: m.r20 == null ? null : pct(m.r20),
        weightPct: pct(notional / equity), riskPct: pct((qty * (m.close - stop)) / equity)
      });
      sectorNames[sector] = (sectorNames[sector] ?? 0) + 1;
      sectorVal[sector] = (sectorVal[sector] ?? 0) + notional;
      gross += notional; cashAvail -= notional;
    }
  }
  const out = {
    generatedAt: iso(), strategy: cfg.name, version: cfg.version, spec: cfg.spec, mode: 'eod',
    forSession: nextSession, equity, orders: [], outgoing, picks,
    market: {
      breadthUp: SYMS.filter((s) => market[`US.${s}`]?.st).length, breadthTotal: SYMS.length,
      spy: { close: market['US.SPY']?.close, superTrend: market['US.SPY']?.st ? 'UP' : 'DOWN', barsSinceFlip: market['US.SPY']?.since }
    },
    warnings: stalls.length ? [`no bar for ${today}: ${stalls.join(', ')}`] : []
  };
  if (!DRY) writeJson(PLAN_FILE, out);
  for (const o of outgoing) log({ action: 'EXIT_PLANNED', symbol: o.symbol, forSession: nextSession, reason: o.reason });
  for (const p of picks) log({ action: 'ENTRY_PLANNED', symbol: p.symbol, forSession: nextSession, qty: p.qty, limit: p.limit, stop: p.stop });
}

if (!DRY) writeJson(CYCLE_STATE, cstate);
if (!DRY && MODE === 'eod') {
  logEquity({ source: 'supertrend-cycle', equity, positions: positions.length, drawdownPct: pct(drawdown), dayPnlPct: pct(dailyPnl) });
}

const out = {
  generatedAt: iso(), mode: MODE, today, etTime: t, marketOpen: isOpen(), equity,
  dayPnlPct: pct(dailyPnl), drawdownPct: pct(drawdown),
  risk: { flatten, deRisk, killActive, killUntil: cstate.killUntil, reasons: riskReasons },
  positions: Object.values(cstate.positions).map((p) => ({ symbol: p.symbol, qty: p.qty, entryDate: p.entryDate, stop: p.stop, peakClose: r2(p.peakClose ?? 0), sessionsHeld: p.sessionsHeld })),
  plan: plan ? { forSession: plan.forSession, executedAt: plan.executedAt ?? null, picks: plan.picks?.length ?? 0, outgoing: plan.outgoing?.length ?? 0 } : null,
  ordersToday, orderBudget, orders, rejected, nextSession
};
if (!DRY) {
  writeJson(OUT_FILE, out);
  for (const r of rejected) logRejection({ source: 'supertrend-cycle', ...r });
}
console.log(JSON.stringify(out, null, 2));
