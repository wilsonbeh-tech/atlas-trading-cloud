import fs from 'node:fs';
import path from 'node:path';

export const ROOT = path.resolve(import.meta.dirname, '..', '..');
export const DATA = path.join(ROOT, 'data');
export const RAW = path.join(DATA, 'raw');
export const KLINE_DIR = path.join(RAW, 'klines');
export const REPORTS = path.join(ROOT, 'reports');

export function ensureDirs() {
  for (const dir of [DATA, RAW, KLINE_DIR, REPORTS]) fs.mkdirSync(dir, { recursive: true });
}

export function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

export function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

export function appendJsonl(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify(value)}\n`);
}

export function readJsonl(file) {
  try {
    return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

export function loadState() {
  return readJson(path.join(DATA, 'state.json'), {
    startedAt: null,
    dayStartEquity: null,
    peakEquity: null,
    lastEquity: null,
    lastRunAt: null,
    haltUntil: null,
    positionsMeta: {},
    dailyOrders: {}
  });
}

export function saveState(state) {
  writeJson(path.join(DATA, 'state.json'), state);
}

export function loadKlines(symbols) {
  const out = {};
  for (const symbol of symbols) {
    const file = path.join(KLINE_DIR, `${symbol}.json`);
    const raw = readJson(file);
    if (!raw) continue;
    out[symbol] = Array.isArray(raw) ? raw : raw?.data?.kline_list ?? raw?.kline_list ?? [];
  }
  return out;
}

export function writeKlines(symbol, list) {
  writeJson(path.join(KLINE_DIR, `${symbol}.json`), list);
}

export function loadSnapshot() {
  return readJson(path.join(RAW, 'snapshot.json'));
}

export function saveSnapshot(snapshot) {
  writeJson(path.join(RAW, 'snapshot.json'), snapshot);
}

export function logDecision(entry) {
  appendJsonl(path.join(DATA, 'decisions.jsonl'), { ts: new Date().toISOString(), ...entry });
}

export function logRejection(entry) {
  appendJsonl(path.join(DATA, 'rejections.jsonl'), { ts: new Date().toISOString(), ...entry });
}

export function logFill(entry) {
  appendJsonl(path.join(DATA, 'fills.jsonl'), { ts: new Date().toISOString(), ...entry });
}

export function logOrder(entry) {
  appendJsonl(path.join(DATA, 'orders.jsonl'), { ts: new Date().toISOString(), ...entry });
}

export function logEquity(entry) {
  appendJsonl(path.join(DATA, 'equity.jsonl'), { ts: new Date().toISOString(), ...entry });
}
