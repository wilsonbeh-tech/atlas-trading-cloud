#!/usr/bin/env node
// Merges daily bars fetched through the moomoo MCP quote_cur_kline tool into the
// committed kline files, so cloud runs do not depend on the local moomoo CLI.
// Usage: node scripts/klines-apply.mjs [--incoming DIR] [--require-date YYYY-MM-DD]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'supertrend.json'), 'utf8'));
const SYMS = Object.keys(cfg.sector);

const arg = (name, dflt = null) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
};
const INCOMING = path.resolve(ROOT, arg('incoming', path.join(ROOT, 'data', 'raw', 'klines-moomoo', '_incoming')));
const REQUIRE_DATE = arg('require-date');
const KEEP_BARS = 400;

function barsOf(payload) {
  let v = payload;
  for (let i = 0; i < 5; i++) {
    if (Array.isArray(v)) return v;
    if (v && Array.isArray(v.kline_list)) return v.kline_list;
    if (v && Array.isArray(v.content)) {
      const t = v.content.find((c) => c && c.type === 'text');
      if (!t) return null;
      v = JSON.parse(t.text);
      continue;
    }
    if (v && v.data) { v = v.data; continue; }
    if (v && v.result) { v = v.result; continue; }
    return null;
  }
  return null;
}

const dateStr = (b) => {
  const d = b.date ?? (b.time_key ? new Date(Number(b.time_key)).toISOString().slice(0, 10).replace(/-/g, '') : null);
  return d == null ? null : String(d).replace(/-/g, '').slice(0, 8);
};

const normalise = (b) => {
  const date = dateStr(b);
  const o = Number(b.open_price), h = Number(b.high_price), l = Number(b.low_price), c = Number(b.close_price);
  if (!date || !/^\d{8}$/.test(date) || ![o, h, l, c].every(Number.isFinite)) return null;
  const out = { ...b, date: Number(date), open_price: o, high_price: h, low_price: l, close_price: c, volume: Number(b.volume ?? 0) };
  return out;
};

let ok = 0;
const problems = [];
for (const sym of SYMS) {
  const file = path.join(ROOT, 'data', 'raw', 'klines-moomoo', `${sym}.json`);
  const incoming = path.join(INCOMING, `${sym}.json`);
  if (!fs.existsSync(incoming)) { problems.push(`${sym}: no incoming file`); continue; }
  let bars;
  try { bars = barsOf(JSON.parse(fs.readFileSync(incoming, 'utf8'))); } catch (e) { problems.push(`${sym}: unreadable payload (${e.message})`); continue; }
  const fresh = (bars ?? []).map(normalise).filter(Boolean);
  if (!fresh.length) { problems.push(`${sym}: no valid bars in payload`); continue; }

  const book = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : { kline_list: [] };
  const list = Array.isArray(book.kline_list) ? book.kline_list : [];
  const byDate = new Map(list.map((b) => [String(dateStr(b)), b]));
  const before = [...byDate.keys()].sort().at(-1) ?? null;

  for (const b of fresh) {
    const d = String(dateStr(b));
    if (before && d < before && !byDate.has(d)) { problems.push(`${sym}: ${d} predates history (${before}), skipped`); continue; }
    byDate.set(d, b);
  }
  const merged = [...byDate.entries()].sort((x, y) => (x[0] < y[0] ? -1 : 1)).map(([, b]) => b).slice(-KEEP_BARS);
  book.kline_list = merged;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(book, null, 2)}\n`);

  const last = merged[merged.length - 1];
  console.log(`${sym} bars=${merged.length} ${before ?? 'none'}->${dateStr(last)} close=${last.close_price}`);
  if (REQUIRE_DATE && dateStr(last) !== REQUIRE_DATE.replace(/-/g, '')) problems.push(`${sym}: newest bar ${dateStr(last)} != required ${REQUIRE_DATE}`);
  else { ok++; fs.rmSync(incoming, { force: true }); }
}

console.log(`klines-apply: ${ok}/${SYMS.length} applied${problems.length ? `, ${problems.length} problem(s)` : ''}`);
for (const p of problems) console.log(`PROBLEM ${p}`);
process.exit(problems.length ? 1 : 0);
