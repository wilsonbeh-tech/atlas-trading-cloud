import fs from 'node:fs';
import path from 'node:path';
import { ROOT, REPORTS, readJson, readJsonl, DATA } from './ledger.js';
import { round } from './indicators.js';

const FILL_STATUSES = new Set(['FILLED', 'PARTIALLY_FILLED', 'PARTIAL']);

function isFillEvent(event) {
  const status = String(event.status ?? '').trim().toUpperCase();
  const filledQty = Number(event.filledQty ?? event.cumQty ?? event.cum_qty ?? 0);
  return FILL_STATUSES.has(status) || filledQty > 0;
}

export function buildDashboard() {
  const backtest = readJson(path.join(REPORTS, 'backtest.json'));
  const signals = readJson(path.join(REPORTS, 'signals.json'));
  const plan = readJson(path.join(REPORTS, 'plan.json'));
  const state = readJson(path.join(DATA, 'state.json'), {});
  const snapshot = readJson(path.join(DATA, 'raw', 'snapshot.json'));
  const decisions = readJsonl(path.join(DATA, 'decisions.jsonl')).slice(-60).reverse();
  const rejections = readJsonl(path.join(DATA, 'rejections.jsonl')).slice(-40).reverse();
  const fillLog = readJsonl(path.join(DATA, 'fills.jsonl'));
  const orderLog = readJsonl(path.join(DATA, 'orders.jsonl'));
  const equityLog = readJsonl(path.join(DATA, 'equity.jsonl'));
  const byTsDesc = (a, b) => String(b.ts ?? '').localeCompare(String(a.ts ?? ''));
  const dedupe = (rows, key) => {
    const seen = new Set();
    return rows.filter((row) => {
      const k = key(row);
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  };
  const allEvents = [...orderLog, ...fillLog];
  const fills = dedupe(
    allEvents.filter(isFillEvent).sort(byTsDesc),
    (e) => `${e.orderId ?? e.order_id ?? e.ts}:${e.status ?? ''}:${e.filledQty ?? e.cumQty ?? e.cum_qty ?? e.qty ?? ''}:${e.avgFillPrice ?? e.price ?? ''}`
  ).slice(0, 40);
  const submittedOrders = dedupe(
    allEvents.filter((e) => !isFillEvent(e)).sort(byTsDesc),
    (e) => `${e.orderId ?? e.order_id ?? e.ts}:${e.status ?? ''}`
  ).slice(0, 40);

  const m = backtest?.metrics ?? {};
  const bench = backtest?.benchmark?.metrics ?? null;
  const hasLive = Boolean(snapshot);
  const equity = snapshot?.cash?.total_asset ? Number(snapshot.cash.total_asset) : state.lastEquity ?? null;
  const baseline = state.startingEquity ?? 100000;
  const liveReturn = equity ? equity / baseline - 1 : null;
  const positions = snapshot?.positions ?? [];
  const positionValue = (p) => Number(p.mv ?? p.marketValue ?? p.qty * (p.cur_price ?? p.curPrice) ?? 0);
  const gross = equity ? positions.filter((p) => p.qty > 0).reduce((a, p) => a + positionValue(p), 0) / equity : 0;
  const maxName = equity ? Math.max(0, ...positions.map((p) => (p.qty > 0 ? positionValue(p) / equity : 0))) : 0;
  const ordersToday = state.dailyOrders?.[nyDate()] ?? 0;
  const dd = state.peakEquity && equity ? equity / state.peakEquity - 1 : 0;
  const competition = competitionWindow(readJson(path.join(ROOT, 'config', 'strategy.json'), {}));

  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Atlas · Moomoo x Qoder Trading Agent</title>
<style>
:root{--bg:#0b0f14;--panel:#111823;--line:#1e2a3a;--text:#e8eef7;--muted:#8ba0b8;--accent:#4f9cff;--good:#31c48d;--bad:#f36b6b;--warn:#f5b84d}
*{box-sizing:border-box}body{margin:0;background:linear-gradient(180deg,#080b10,#0b0f14 40%);color:var(--text);font:14px/1.5 ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto}
.wrap{max-width:1180px;margin:0 auto;padding:28px 22px 60px}
header{display:flex;justify-content:space-between;align-items:flex-end;gap:20px;margin-bottom:22px;flex-wrap:wrap}
h1{font-size:26px;margin:0;letter-spacing:-.02em}sub{color:var(--muted);display:block;margin-top:4px;font-size:13px}
.tag{border:1px solid var(--line);color:var(--muted);border-radius:99px;padding:6px 12px;font-size:12px}
.grid{display:grid;grid-template-columns:repeat(12,1fr);gap:14px}
.card{background:linear-gradient(180deg,#121a26,#0f1621);border:1px solid var(--line);border-radius:14px;padding:16px 18px;grid-column:span 3;min-width:0}
.card.wide{grid-column:span 12}.card.half{grid-column:span 6}.card.third{grid-column:span 4}
.k{color:var(--muted);font-size:12px;text-transform:uppercase;letter-spacing:.08em}
.v{font-size:24px;font-weight:650;margin-top:6px;letter-spacing:-.02em}
.s{color:var(--muted);font-size:12px;margin-top:2px}
.good{color:var(--good)}.bad{color:var(--bad)}.warn{color:var(--warn)}
h2{font-size:15px;margin:0 0 10px;font-weight:600}
table{width:100%;border-collapse:collapse;font-size:12.5px}
th{color:var(--muted);text-align:left;font-weight:500;padding:7px 8px;border-bottom:1px solid var(--line);white-space:nowrap}
td{padding:7px 8px;border-bottom:1px solid #16202d;white-space:nowrap}
tr:last-child td{border-bottom:none}
.mono{font-variant-numeric:tabular-nums}
.bar{height:6px;border-radius:99px;background:#1b2635;overflow:hidden;margin-top:6px}
.bar>i{display:block;height:100%;background:var(--accent)}
.bar.warn>i{background:var(--warn)}.bar.bad>i{background:var(--bad)}
.pill{display:inline-block;padding:2px 8px;border-radius:99px;font-size:11px;border:1px solid var(--line);color:var(--muted)}
.pill.buy{color:var(--good);border-color:#1d4a3a;background:#0e2a21}.pill.sell{color:var(--bad);border-color:#4d2323;background:#2a1010}
.scroll{max-height:340px;overflow:auto}
footer{color:var(--muted);font-size:12px;margin-top:26px;border-top:1px solid var(--line);padding-top:14px}
.legend{display:flex;gap:14px;color:var(--muted);font-size:12px;margin-top:8px}
.dot{width:8px;height:8px;border-radius:2px;display:inline-block;margin-right:5px}
.months{display:flex;flex-wrap:wrap;gap:8px}
.month{display:flex;flex-direction:column;gap:2px;border:1px solid var(--line);border-radius:10px;padding:8px 11px;min-width:92px}
.month.pending{opacity:.45}
.month.today{border-color:#2f4a75;background:#101a29}
@media(max-width:900px){.card{grid-column:span 6}.card.third,.card.half{grid-column:span 12}.v{font-size:21px}}
@media(max-width:640px){.wrap{padding:18px 14px 40px}.grid{grid-template-columns:1fr}.card,.card.wide,.card.half,.card.third{grid-column:span 1}h1{font-size:22px}table{font-size:11.5px}.scroll{overflow-x:auto}.col-hide{display:none}}
</style></head><body><div class="wrap">
<header>
  <div><h1>Atlas · Dual-Momentum Paper Agent</h1>
  <sub>${snapshot?.account?.account_title ?? 'No account snapshot'} · generated ${new Date().toISOString().replace('T', ' ').slice(0, 19)} UTC</sub></div>
  <div style="display:flex;gap:8px;flex-wrap:wrap">
    <span class="tag">Moomoo x Qoder Challenge</span>
    <span class="tag">${backtest ? `Backtest ${backtest.from} → ${backtest.to}` : 'No backtest yet'}</span>
    ${snapshot ? '' : '<span class="tag" style="color:var(--warn);border-color:#4a3a1d">Offline research preview</span>'}
  </div>
</header>

<div class="grid">
  ${kpi('Net assets', hasLive && equity ? usd(equity) : '—', hasLive && liveReturn !== null ? `${pct(liveReturn)} vs start` : 'awaiting account snapshot', hasLive ? liveReturn : null)}
  ${kpi('Backtest return', m.totalReturn !== undefined ? pct(m.totalReturn) : '—', bench ? `SPY ${pct(bench.totalReturn)} · Sharpe ${fmt(bench.sharpe)}` : 'net of fees & slippage', m.totalReturn)}
  ${kpi('Backtest Sharpe', fmt(m.sharpe), `${fmt(m.cagr * 100)}% CAGR · ${fmt(m.vol * 100)}% vol`, m.sharpe)}
  ${kpi('Max drawdown', m.maxDrawdown !== undefined ? pct(m.maxDrawdown) : '—', `${fmt((m.winRate ?? 0) * 100)}% win · PF ${fmt(m.profitFactor)}`, null)}

  <div class="card wide">
    <h2>Equity curve & exposure <span class="pill" style="float:right">backtest, net of fees</span></h2>
    ${equityChart(backtest?.equity ?? [], backtest?.exposure ?? [], backtest?.benchmark?.equity ?? [])}
    <div class="legend"><span><i class="dot" style="background:var(--accent)"></i>Atlas</span><span><i class="dot" style="background:#5f6b7a"></i>SPY buy &amp; hold</span><span><i class="dot" style="background:#8b6bff"></i>Exposure</span></div>
  </div>

  <div class="card half">
    <h2>Risk budget utilisation</h2>
    ${riskBar('Gross exposure', gross, 0.9, pct(gross))}
    ${riskBar('Largest position', maxName, 0.4, pct(maxName))}
    ${riskBar('Open positions', positions.filter((p) => p.qty > 0).length / 8, 1, `${positions.filter((p) => p.qty > 0).length} / 8`)}
    ${riskBar('Orders submitted today', ordersToday / 40, 1, `${ordersToday} / 40`)}
    ${riskBar('Drawdown vs kill', Math.abs(Math.min(dd, 0)) / 0.12, 1, pct(dd))}
  </div>

  <div class="card half">
    <h2>Current positions</h2>
    <div class="scroll"><table><thead><tr><th>Symbol</th><th>Qty</th><th>Avg</th><th>Last</th><th>P&L</th><th>Weight</th></tr></thead><tbody>
    ${positions.filter((p) => p.qty !== 0).map((p) => {
      const mv = positionValue(p);
      const w = equity ? mv / equity : 0;
      const pnl = Number(p.profit ?? p.unrealizedPnl ?? 0);
      const avg = p.buy_avg_price ?? p.avgPrice;
      const last = p.cur_price ?? p.curPrice;
      return `<tr><td>${p.symbol}</td><td class="mono">${p.qty}</td><td class="mono">${fmt(avg)}</td><td class="mono">${fmt(last)}</td><td class="mono ${pnl >= 0 ? 'good' : 'bad'}">${pnl >= 0 ? '+' : ''}${usd(pnl)}</td><td class="mono">${pct(w)}</td></tr>`;
    }).join('') || '<tr><td colspan="6" style="color:var(--muted)">No open positions</td></tr>'}
    </tbody></table></div>
  </div>

  <div class="card wide">
    <h2>Latest signals</h2>
    <div class="scroll"><table><thead><tr><th>#</th><th>Symbol</th><th>Score</th><th>20d</th><th>60d</th><th class="col-hide">120d</th><th>Vol</th><th>Trend</th><th class="col-hide">Close</th><th>Target w</th></tr></thead><tbody>
    ${(signals?.rows ?? []).slice(0, 15).map((r) => `<tr><td class="mono">${r.rank}</td><td>${r.symbol}</td><td class="mono">${fmt(r.score, 2)}</td><td class="mono ${r.r20 >= 0 ? 'good' : 'bad'}">${pct(r.r20)}</td><td class="mono ${r.r60 >= 0 ? 'good' : 'bad'}">${pct(r.r60)}</td><td class="mono col-hide ${r.r120 >= 0 ? 'good' : 'bad'}">${pct(r.r120)}</td><td class="mono">${pct(r.vol20)}</td><td>${r.trendPass ? '<span class="pill buy">pass</span>' : '<span class="pill sell">fail</span>'}</td><td class="mono col-hide">${fmt(r.close)}</td><td class="mono">${plan?.targets?.weights?.[r.symbol] ? pct(plan.targets.weights[r.symbol]) : '—'}</td></tr>`).join('') || '<tr><td colspan="10" style="color:var(--muted)">Run <code>signals</code> to populate</td></tr>'}
    </tbody></table></div>
  </div>

  <div class="card half">
    <h2>Recent decisions</h2>
    <div class="scroll"><table><thead><tr><th>Time</th><th>Action</th><th>Detail</th></tr></thead><tbody>
    ${decisions.map((d) => `<tr><td class="mono">${String(d.ts).slice(5, 16).replace('T', ' ')}</td><td>${d.action ?? d.type ?? ''}</td><td style="white-space:normal">${escapeHtml(d.summary ?? d.reason ?? d.detail ?? '')}</td></tr>`).join('') || '<tr><td colspan="3" style="color:var(--muted)">No decisions logged yet</td></tr>'}
    </tbody></table></div>
  </div>

  <div class="card half">
    <h2>Rejected orders <span class="pill" style="float:right">guardrails</span></h2>
    <div class="scroll"><table><thead><tr><th>Time</th><th>Symbol</th><th>Reason</th></tr></thead><tbody>
    ${rejections.map((r) => `<tr><td class="mono">${String(r.ts).slice(5, 16).replace('T', ' ')}</td><td>${r.symbol ?? '—'}</td><td style="white-space:normal">${escapeHtml(r.reason ?? '')}</td></tr>`).join('') || '<tr><td colspan="3" style="color:var(--muted)">No rejections recorded</td></tr>'}
    </tbody></table></div>
  </div>

  <div class="card wide">
    <h2>Submitted orders <span class="pill" style="float:right">not fills</span></h2>
    <div class="scroll"><table><thead><tr><th>Time</th><th>Side</th><th>Symbol</th><th>Qty</th><th>Limit</th><th>Status</th><th>Order ID</th><th>Reason</th></tr></thead><tbody>
    ${submittedOrders.map((o) => `<tr><td class="mono">${String(o.ts).slice(5, 16).replace('T', ' ')}</td><td><span class="pill ${o.side === 'BUY' ? 'buy' : 'sell'}">${escapeHtml(o.side)}</span></td><td>${escapeHtml(o.symbol)}</td><td class="mono">${o.qty}</td><td class="mono">${fmt(o.limitPrice ?? o.price)}</td><td><span class="pill">${escapeHtml(o.status ?? 'SUBMITTED')}</span></td><td class="mono">${escapeHtml(o.orderId ?? o.order_id ?? '—')}</td><td style="white-space:normal">${escapeHtml(o.reason ?? '')}</td></tr>`).join('') || '<tr><td colspan="8" style="color:var(--muted)">No submitted orders</td></tr>'}
    </tbody></table></div>
  </div>

  <div class="card wide">
    <h2>Fills <span class="pill" style="float:right">filled only</span></h2>
    <div class="scroll"><table><thead><tr><th>Time</th><th>Side</th><th>Symbol</th><th>Filled qty</th><th>Avg price</th><th>Notional</th><th>Reason</th></tr></thead><tbody>
    ${fills.map((f) => `<tr><td class="mono">${String(f.ts).slice(5, 16).replace('T', ' ')}</td><td><span class="pill ${f.side === 'BUY' ? 'buy' : 'sell'}">${escapeHtml(f.side)}</span></td><td>${escapeHtml(f.symbol)}</td><td class="mono">${f.filledQty ?? f.qty}</td><td class="mono">${fmt(f.avgFillPrice ?? f.price)}</td><td class="mono">${usd(f.notional)}</td><td style="white-space:normal">${escapeHtml(f.reason ?? '')}</td></tr>`).join('') || '<tr><td colspan="7" style="color:var(--muted)">No fills yet</td></tr>'}
    </tbody></table></div>
  </div>

  <div class="card wide">
    <h2>Daily returns <span class="pill" style="float:right">${competition.start} → ${competition.end}</span></h2>
    ${dailyReturnStrip(equityLog, competition, baseline)}
  </div>
</div>

<footer>Paper trading only. Simulated results do not predict live returns. Generated by Atlas · ${path.basename(ROOT)} · rules: max 40% single name, max 8 positions, 12% drawdown kill switch, $1 min price, US-listed only.</footer>
</div></body></html>`;

  fs.mkdirSync(REPORTS, { recursive: true });
  const out = path.join(REPORTS, 'dashboard.html');
  fs.writeFileSync(out, html);
  return out;
}

function kpi(k, v, s, tone) {
  const cls = tone === null || tone === undefined ? '' : tone >= 0 ? 'good' : 'bad';
  return `<div class="card"><div class="k">${k}</div><div class="v ${cls}">${v}</div><div class="s">${s}</div></div>`;
}

function riskBar(label, value, limit, display) {
  const ratio = Math.min(1, Math.max(0, value / limit));
  const cls = ratio > 0.9 ? 'bad' : ratio > 0.75 ? 'warn' : '';
  return `<div style="margin:12px 0"><div style="display:flex;justify-content:space-between"><span>${label}</span><span class="mono">${display}</span></div><div class="bar ${cls}"><i style="width:${ratio * 100}%"></i></div></div>`;
}

function equityChart(equity, exposure, benchmark = []) {
  if (!equity.length) return '<div style="height:220px;display:grid;place-items:center;color:var(--muted)">Run the backtest to render the curve</div>';
  const w = 1080, h = 250, pad = 34;
  const vals = equity.map((e) => e.equity);
  const benchVals = benchmark.map((b) => b.equity);
  const min = Math.min(...vals, ...benchVals) * 0.985, max = Math.max(...vals, ...benchVals) * 1.01;
  const x = (i) => pad + (i / Math.max(1, vals.length - 1)) * (w - pad * 2);
  const y = (v) => h - pad - ((v - min) / (max - min || 1)) * (h - pad * 2);
  const line = vals.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join('');
  const benchLine = benchVals.length
    ? benchVals.map((v, i) => `${i ? 'L' : 'M'}${x((i / Math.max(1, benchVals.length - 1)) * (vals.length - 1)).toFixed(1)},${y(v).toFixed(1)}`).join('')
    : '';
  const area = `${line}L${x(vals.length - 1)},${h - pad}L${x(0)},${h - pad}Z`;
  const expo = exposure.map((e) => e.exposure);
  const expLine = expo.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${(h - pad - v * (h - pad * 2) * 0.55).toFixed(1)}`).join('');
  return `<svg viewBox="0 0 ${w} ${h}" width="100%" height="${h}" role="img" aria-label="Equity curve">
  <defs><linearGradient id="g" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="#4f9cff" stop-opacity=".35"/><stop offset="1" stop-color="#4f9cff" stop-opacity="0"/></linearGradient></defs>
  ${[0, 1, 2, 3].map((i) => `<line x1="${pad}" x2="${w - pad}" y1="${pad + i * ((h - pad * 2) / 3)}" y2="${pad + i * ((h - pad * 2) / 3)}" stroke="#1b2635"/>`).join('')}
  <path d="${area}" fill="url(#g)"/><path d="${line}" fill="none" stroke="#4f9cff" stroke-width="2.2"/>
  ${benchLine ? `<path d="${benchLine}" fill="none" stroke="#5f6b7a" stroke-width="1.4"/>` : ''}
  <path d="${expLine}" fill="none" stroke="#8b6bff" stroke-width="1.2" stroke-dasharray="4 4" opacity=".8"/>
  <text x="${pad}" y="${h - 10}" fill="#8ba0b8" font-size="11">${equity[0].date}</text>
  <text x="${w - pad}" y="${h - 10}" fill="#8ba0b8" font-size="11" text-anchor="end">${equity.at(-1).date}</text>
  <text x="${pad}" y="${pad - 8}" fill="#8ba0b8" font-size="11">$${Math.round(max).toLocaleString()}</text>
  <text x="${pad}" y="${h - pad + 14}" fill="#8ba0b8" font-size="11">$${Math.round(min).toLocaleString()}</text>
</svg>`;
}

function competitionWindow(cfg) {
  const c = cfg?.competition ?? {};
  return {
    start: c.start ?? '2026-11-17',
    end: c.end ?? '2026-11-28',
    holidays: Array.isArray(c.holidays) ? c.holidays : ['2026-11-26']
  };
}

function tradingDays(start, end, holidays) {
  const skip = new Set(holidays);
  const days = [];
  const cursor = new Date(`${start}T12:00:00Z`);
  const last = new Date(`${end}T12:00:00Z`);
  while (cursor <= last) {
    const iso = cursor.toISOString().slice(0, 10);
    const dow = cursor.getUTCDay();
    if (dow !== 0 && dow !== 6 && !skip.has(iso)) days.push(iso);
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return days;
}

function nyDay(ts) {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return null;
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}

function dailyMarks(rows) {
  const marks = new Map();
  for (const row of rows) {
    const value = Number(row.equity);
    const day = nyDay(row.ts);
    if (value > 0 && day) marks.set(day, value);
  }
  return marks;
}

function fmtDay(iso) {
  return new Date(`${iso}T12:00:00Z`).toLocaleDateString('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric' });
}

function dailyReturnStrip(rows, win, baseline) {
  const days = tradingDays(win.start, win.end, win.holidays);
  if (!days.length) return '<span class="s">No competition days configured</span>';
  const marks = dailyMarks(rows);
  const today = nyDate();
  const base = Number(baseline) > 0 ? Number(baseline) : 100000;
  let prev = base;
  let marked = 0;
  let cumulative = null;
  let best = null;
  let worst = null;
  const cells = days.map((day, i) => {
    const equity = marks.get(day);
    const future = day > today;
    let ret = null;
    if (equity !== undefined) {
      ret = equity / prev - 1;
      prev = equity;
      cumulative = equity / base - 1;
      marked++;
      if (!best || ret > best.ret) best = { day, ret };
      if (!worst || ret < worst.ret) worst = { day, ret };
    }
    const value = ret === null ? (future ? 'pending' : '—') : pct(ret);
    const tone = ret === null ? '' : ret >= 0 ? 'good' : 'bad';
    const cls = `${future ? ' pending' : ''}${day === today ? ' today' : ''}`;
    return `<span class="month${cls}"><span class="k">Day ${i + 1} · ${fmtDay(day)}</span><span class="mono ${tone}">${value}</span></span>`;
  }).join('');
  const summary = `${marked} / ${days.length} trading days marked · cumulative ${cumulative === null ? '—' : pct(cumulative)}`
    + (best && marked > 1 ? ` · best ${pct(best.ret)} (${fmtDay(best.day)}) · worst ${pct(worst.ret)} (${fmtDay(worst.day)})` : '');
  return `<div class="s" style="margin:0 0 10px">${summary}</div><div class="months">${cells}</div>`;
}

function nyDate() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}

function usd(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return '—';
  return `${n < 0 ? '-' : ''}$${Math.abs(n).toLocaleString('en-US', { maximumFractionDigits: 2, minimumFractionDigits: 2 })}`;
}
function pct(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return '—';
  return `${n >= 0 ? '+' : ''}${(n * 100).toFixed(2)}%`;
}
function fmt(v, d = 2) {
  const n = Number(v);
  if (!Number.isFinite(n)) return '—';
  return n.toLocaleString('en-US', { maximumFractionDigits: d, minimumFractionDigits: d });
}
function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
