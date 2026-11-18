import fs from 'node:fs';
import path from 'node:path';
import { crc32 } from 'node:zlib';

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const HUB = path.join(HERE, 'hub');
const STAGE = path.join(HERE, 'stage');
const OUT = path.resolve(HERE, '..', 'dist', 'qca-skills');

const SKILL_DIRS = [
  'skills/quote-trade-skills/moomoo-crypto',
  'skills/quote-trade-skills/moomoo-quote',
  'skills/quote-trade-skills/moomoo-sim-trading',
  'skills/quote-trade-skills/moomoo-trading',
  'skills/search-skills/moomoo-comment-sentiment',
  'skills/search-skills/moomoo-news-search',
  'skills/search-skills/moomoo-stock-digest',
  'skills/strategy-skills/moomoo-grid-strategy',
  'skills/unusual-skills/moomoo-unusual-capital-flows',
  'skills/unusual-skills/moomoo-unusual-derivatives-activity',
  'skills/unusual-skills/moomoo-unusual-technical-signal-alerts',
];

const EXCLUDE = new Set(['.git', '.DS_Store', '__MACOSX', '.gitignore', '.env', '.env.local']);

const SHARED_UNUSUAL = 'skills/unusual-skills/references/cli-runtime.md';
const SHARED_WS_DOC = 'docs/websocket-quote-push.md';

function rmrf(p) { fs.rmSync(p, { recursive: true, force: true }); }

function walk(dir, base = dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (EXCLUDE.has(e.name)) continue;
    const abs = path.join(dir, e.name);
    const rel = path.relative(base, abs).split(path.sep).join('/');
    if (e.isDirectory()) out.push(...walk(abs, base));
    else if (e.isFile()) out.push({ abs, rel });
  }
  return out;
}

function rewrite(file, pairs) {
  let text = fs.readFileSync(file, 'utf8');
  for (const [from, to] of pairs) {
    if (!text.includes(from)) throw new Error(`link pattern not found in ${file}: ${from}`);
    text = text.split(from).join(to);
  }
  fs.writeFileSync(file, text);
}

// ---- build package folders ----
rmrf(STAGE);
fs.mkdirSync(STAGE, { recursive: true });
fs.mkdirSync(OUT, { recursive: true });

const built = [];
for (const rel of SKILL_DIRS) {
  const src = path.join(HUB, rel);
  const name = path.basename(rel);
  const dest = path.join(STAGE, name);
  fs.mkdirSync(dest, { recursive: true });

  for (const f of walk(src)) {
    const target = path.join(dest, f.rel.split('/').join(path.sep));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(f.abs, target);
  }

  // shared unusual runtime guide -> references/cli-runtime.md
  if (name.startsWith('moomoo-unusual-')) {
    const refDir = path.join(dest, 'references');
    fs.mkdirSync(refDir, { recursive: true });
    fs.copyFileSync(path.join(HUB, SHARED_UNUSUAL), path.join(refDir, 'cli-runtime.md'));
    rewrite(path.join(dest, 'SKILL.md'), [['../references/cli-runtime.md', 'references/cli-runtime.md']]);
  }

  // shared websocket hub doc -> references/websocket-quote-push.md
  if (name === 'moomoo-quote') {
    const refDir = path.join(dest, 'references');
    fs.copyFileSync(path.join(HUB, SHARED_WS_DOC), path.join(refDir, 'websocket-quote-push.md'));
    const toLocal = '../../../../docs/websocket-quote-push.md';
    rewrite(path.join(dest, 'SKILL.md'), [[toLocal, 'references/websocket-quote-push.md']]);
    rewrite(path.join(refDir, 'websocket-push.md'), [[toLocal, 'websocket-quote-push.md']]);
    rewrite(path.join(refDir, 'websocket-quote-push.md'), [
      ['(./upgrade-from-opend.md)', '(https://github.com/MoomooOpen/moomoo-agent-hub/blob/main/docs/upgrade-from-opend.md)'],
      ['(./migration-gaps-and-rest-api.md)', '(https://github.com/MoomooOpen/moomoo-agent-hub/blob/main/docs/migration-gaps-and-rest-api.md)'],
      ['[Futu hub guide](../futu-agent-hub/docs/websocket-quote-push.md) (Chinese)', 'Futu hub guide (Chinese, in the separate futu-agent-hub repository)'],
    ]);
  }

  built.push({ name, dir: path.join(STAGE, name) });
}

// ---- minimal ZIP writer (stored entries, UTF-8 names) ----
function dosTime(d) {
  return {
    time: ((d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2)) & 0xffff,
    date: (((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()) & 0xffff,
  };
}

function zipDir(rootDir, zipPath) {
  const entries = [];
  const top = path.basename(rootDir);
  entries.push({ name: `${top}/`, data: Buffer.alloc(0), isDir: true });
  for (const f of walk(rootDir)) {
    entries.push({ name: `${top}/${f.rel}`, data: fs.readFileSync(f.abs), isDir: false });
  }

  const now = new Date();
  const { time, date } = dosTime(now);
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const e of entries) {
    const nameBuf = Buffer.from(e.name, 'utf8');
    const crc = e.isDir ? 0 : crc32(e.data) >>> 0;
    const size = e.data.length;

    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(0x0800, 6);
    lh.writeUInt16LE(0, 8);
    lh.writeUInt16LE(time, 10);
    lh.writeUInt16LE(date, 12);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(size, 18);
    lh.writeUInt32LE(size, 22);
    lh.writeUInt16LE(nameBuf.length, 26);
    lh.writeUInt16LE(0, 28);

    locals.push(lh, nameBuf, e.data);

    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(0x0800, 8);
    ch.writeUInt16LE(0, 10);
    ch.writeUInt16LE(time, 12);
    ch.writeUInt16LE(date, 14);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(size, 20);
    ch.writeUInt32LE(size, 24);
    ch.writeUInt16LE(nameBuf.length, 28);
    ch.writeUInt16LE(0, 30);
    ch.writeUInt16LE(0, 32);
    ch.writeUInt16LE(0, 34);
    ch.writeUInt16LE(0, 36);
    ch.writeUInt32LE(e.isDir ? 0x10 : 0, 38);
    ch.writeUInt32LE(offset, 42);
    centrals.push(ch, nameBuf);

    offset += 30 + nameBuf.length + size;
  }

  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  fs.writeFileSync(zipPath, Buffer.concat([...locals, cd, eocd]));
  return entries.filter((e) => !e.isDir).length;
}

for (const s of built) {
  const zipPath = path.join(OUT, `${s.name}.zip`);
  const n = zipDir(s.dir, zipPath);
  console.log(`${s.name}: ${n} files -> ${zipPath}`);
}
