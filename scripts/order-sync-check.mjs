#!/usr/bin/env node
// Reports order-sync failure records from the Atlas audit logs for the window
// ending now (default 5 minutes). Read-only against data/; writes only reports/.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argIdx = process.argv.indexOf('--window-minutes');
const WINDOW_MINUTES = argIdx > -1 ? Number(process.argv[argIdx + 1]) : 5;
if (!Number.isFinite(WINDOW_MINUTES) || WINDOW_MINUTES <= 0) {
  console.error('invalid --window-minutes');
  process.exit(2);
}

const now = new Date();
const since = new Date(now.getTime() - WINDOW_MINUTES * 60_000);
const OK_STATUS = new Set(['SUBMITTED', 'ACCEPTED', 'PENDING', 'FILLED', 'FILLED_ALL', 'PARTIAL_FILLED']);

function fmt(d) {
  const t = new Date(d.getTime() + 8 * 3600_000);
  const p = (n) => String(n).padStart(2, '0');
  return `${t.getUTCFullYear()}-${p(t.getUTCMonth() + 1)}-${p(t.getUTCDate())} ${p(t.getUTCHours())}:${p(t.getUTCMinutes())}:${p(t.getUTCSeconds())}`;
}

function readJsonl(rel) {
  const p = path.join(ROOT, rel);
  if (!fs.existsSync(p)) return [];
  const rows = [];
  for (const line of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    try {
      rows.push(JSON.parse(t));
    } catch {
      // malformed line: surface as a failure so it is not silently skipped
      rows.push({ ts: null, __malformed: rel });
    }
  }
  return rows;
}

const inWindow = (ts) => {
  const t = Date.parse(ts);
  return Number.isFinite(t) && t >= since.getTime() && t <= now.getTime();
};

const failures = [];

for (const f of readJsonl('data/fills.jsonl')) {
  if (f.__malformed) {
    failures.push({ source: f.__malformed, ts: null, orderId: null, symbol: null, status: 'UNREADABLE_RECORD', reason: 'log line is not valid JSON' });
    continue;
  }
  if (!inWindow(f.ts)) continue;
  const status = String(f.status ?? 'UNKNOWN').toUpperCase();
  if (OK_STATUS.has(status)) continue;
  failures.push({
    source: 'data/fills.jsonl',
    ts: f.ts,
    orderId: f.orderId ?? f.order_id ?? null,
    symbol: f.symbol ?? null,
    status,
    reason: f.error ?? f.errorMsg ?? f.reason ?? status,
  });
}

for (const r of readJsonl('data/rejections.jsonl')) {
  if (!inWindow(r.ts)) continue;
  failures.push({
    source: 'data/rejections.jsonl',
    ts: r.ts,
    orderId: r.orderId ?? r.order_id ?? null,
    symbol: r.symbol ?? r.order?.symbol ?? null,
    status: 'REJECTED',
    reason: r.reason ?? 'order rejected by guard',
  });
}

for (const d of readJsonl('data/decisions.jsonl')) {
  if (d.action !== 'INCIDENT' || !inWindow(d.ts)) continue;
  failures.push({
    source: 'data/decisions.jsonl',
    ts: d.ts,
    orderId: d.orderId ?? null,
    symbol: null,
    status: 'INCIDENT',
    reason: [d.step, d.summary].filter(Boolean).join(': ') || 'incident logged',
  });
}

failures.sort((a, b) => (Date.parse(a.ts ?? 0) || 0) - (Date.parse(b.ts ?? 0) || 0));

const header = `Order Sync Check — ${fmt(now)} (UTC+8)`;
const windowLine = `Window: ${fmt(since)} – ${fmt(now)}  (${WINDOW_MINUTES} min)`;
const lines = [header, windowLine];

if (failures.length === 0) {
  lines.push('', 'No failure records found in this check.');
} else {
  lines.push('', `Failures: ${failures.length}`);
  failures.forEach((f, i) => {
    const id = f.orderId ? `order ${f.orderId}` : 'no order id';
    const sym = f.symbol ? ` ${f.symbol}` : '';
    lines.push(`${i + 1}. ${f.ts ?? 'unknown time'} |${sym} | ${id} | ${f.status} | ${f.reason} | ${f.source}`);
  });
}

const out = lines.join('\n');
console.log(out);

const payload = {
  checkedAt: now.toISOString(),
  checkedAtLocal: fmt(now),
  windowMinutes: WINDOW_MINUTES,
  windowStart: since.toISOString(),
  windowEnd: now.toISOString(),
  failureCount: failures.length,
  failures,
};
const rep = path.join(ROOT, 'reports');
fs.mkdirSync(rep, { recursive: true });
fs.writeFileSync(path.join(rep, 'order-sync-check.json'), JSON.stringify(payload, null, 2));
fs.appendFileSync(path.join(rep, 'order-sync-checks.jsonl'), JSON.stringify({ ts: now.toISOString(), failureCount: failures.length }) + '\n');

process.exit(0);
