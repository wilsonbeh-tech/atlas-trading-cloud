import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const OUT = path.resolve(HERE, '..', 'dist', 'qca-skills');
const TMP = path.join(HERE, 'verify');

const NAME_RE = /^[a-z0-9][a-z0-9_-]*$/;
const MAX_ZIP = 50 * 1024 * 1024;
const MAX_UNCOMPRESSED = 50 * 1024 * 1024;
const MAX_NAME = 64;
const MAX_DESC = 5120;

fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(TMP, { recursive: true });

function parseFrontmatter(text) {
  const lines = text.split(/\r?\n/);
  if (lines[0] !== '---') return { error: 'SKILL.md does not start with ---' };
  let end = -1;
  for (let i = 1; i < lines.length; i++) if (lines[i] === '---') { end = i; break; }
  if (end < 0) return { error: 'frontmatter is not closed' };
  const block = lines.slice(1, end);
  const out = {};
  for (let i = 0; i < block.length; i++) {
    const m = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(block[i]);
    if (!m) continue;
    const [, key, rest] = m;
    if (rest === '' && block[i + 1] && /^\s+\S/.test(block[i + 1])) {
      const indented = [];
      while (i + 1 < block.length && (/^\s+\S/.test(block[i + 1]) || block[i + 1].trim() === '')) {
        indented.push(block[++i]);
      }
      while (indented.length && indented[indented.length - 1].trim() === '') indented.pop();
      out[key] = indented.map((l) => l.trim()).join(' ').replace(/\s+/g, ' ').trim();
      out[key + '__style'] = 'plain-multiline';
      out[key + '__lines'] = indented.length;
    } else if (/^[>|][-+]?$/.test(rest)) {
      const folded = rest.startsWith('>');
      const indented = [];
      while (i + 1 < block.length && (/^\s+\S/.test(block[i + 1]) || block[i + 1].trim() === '')) {
        indented.push(block[++i]);
      }
      while (indented.length && indented[indented.length - 1].trim() === '') indented.pop();
      const body = indented.map((l) => l.trim());
      out[key] = folded ? body.join(' ').replace(/\s+/g, ' ').trim() : body.join('\n');
      out[key + '__style'] = rest;
      out[key + '__lines'] = indented.length;
    } else if (/^'/.test(rest)) {
      out[key] = rest.replace(/^'+|'+$/g, '');
    } else if (/^"/.test(rest)) {
      out[key] = rest.replace(/^"+|"+$/g, '');
    } else {
      out[key] = rest.trim();
    }
  }
  return out;
}

function listLinks(text) {
  const links = [];
  const re = /\[[^\]]*\]\(\s*<?([^)>\s]+)>?(?:\s+"[^"]*")?\s*\)/g;
  let m;
  while ((m = re.exec(text)) !== null) links.push(m[1]);
  return links;
}

function mdFiles(dir, base = dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...mdFiles(abs, base));
    else if (e.name.endsWith('.md')) out.push(abs);
  }
  return out;
}

function walk(dir, base = dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(abs, base));
    else out.push(path.relative(base, abs).split(path.sep).join('/'));
  }
  return out;
}

const results = [];
const zips = fs.readdirSync(OUT).filter((f) => f.endsWith('.zip')).sort();

for (const zf of zips) {
  const zipPath = path.join(OUT, zf);
  const skillFromZip = zf.slice(0, -4);
  const r = { zip: zf, checks: [], fail: [], warn: [] };
  const ok = (msg) => r.checks.push(msg);
  const bad = (msg) => r.fail.push(msg);

  // integrity
  try {
    execFileSync('unzip', ['-tqq', zipPath], { stdio: 'pipe' });
    ok('zip integrity (unzip -t)');
  } catch (e) {
    bad(`zip integrity FAILED: ${String(e.stderr || e.message).slice(0, 300)}`);
  }

  const entries = execFileSync('unzip', ['-Z1', zipPath], { encoding: 'utf8' })
    .split('\n').map((s) => s.trim()).filter(Boolean);

  const tops = new Set(entries.map((e) => e.split('/')[0]));
  if (tops.size !== 1) bad(`expected exactly 1 top-level dir, found ${tops.size}: ${[...tops].join(', ')}`);
  const top = [...tops][0];
  if (top !== skillFromZip) bad(`top-level dir "${top}" != zip name "${skillFromZip}"`);
  else ok('single top-level dir matches zip filename');

  if (entries.includes(`${top}/SKILL.md`)) ok('SKILL.md at package root');
  else bad('SKILL.md missing at package root');

  const junk = entries.filter((e) => /(^|\/)(\.git|\.DS_Store|__MACOSX|\.env)(\/|$)/.test(e));
  if (junk.length) bad(`forbidden entries: ${junk.join(', ')}`);
  else ok('no .git/.DS_Store/__MACOSX/.env entries');

  const zipSize = fs.statSync(zipPath).size;
  if (zipSize > MAX_ZIP) bad(`zip too large: ${zipSize}`);
  else ok(`zip size ${zipSize} B <= ${MAX_ZIP}`);

  // extract
  const exDir = path.join(TMP, skillFromZip);
  fs.mkdirSync(exDir, { recursive: true });
  execFileSync('unzip', ['-qq', '-o', zipPath, '-d', exDir], { stdio: 'pipe' });
  const pkg = path.join(exDir, top);

  const files = walk(pkg);
  const uncompressed = files.reduce((a, f) => a + fs.statSync(path.join(pkg, f.split('/').join(path.sep))).size, 0);
  if (uncompressed > MAX_UNCOMPRESSED) bad(`uncompressed too large: ${uncompressed}`);
  else ok(`uncompressed ${uncompressed} B <= ${MAX_UNCOMPRESSED} (${files.length} files)`);

  // frontmatter
  const skillMd = fs.readFileSync(path.join(pkg, 'SKILL.md'), 'utf8');
  const fm = parseFrontmatter(skillMd);
  if (fm.error) bad(`frontmatter: ${fm.error}`);
  else {
    const name = fm.name;
    if (!name) bad('frontmatter name missing');
    else if (name.length > MAX_NAME) bad(`name too long: ${name.length}`);
    else if (!NAME_RE.test(name)) bad(`name fails ^[a-z0-9][a-z0-9_-]*$: "${name}"`);
    else if (name !== top) bad(`frontmatter name "${name}" != package dir "${top}"`);
    else ok(`frontmatter name "${name}" valid and matches package dir`);

    const desc = fm.description;
    if (!desc || !desc.trim()) bad('frontmatter description missing/empty');
    else if (desc.length > MAX_DESC) bad(`description too long: ${desc.length}`);
    else ok(`frontmatter description ${desc.length} chars <= ${MAX_DESC}`);
  }

  // links
  let linkCount = 0;
  const broken = [];
  for (const f of mdFiles(pkg)) {
    const text = fs.readFileSync(f, 'utf8');
    for (const raw of listLinks(text)) {
      if (/^(https?:|mailto:|#|wss?:)/i.test(raw)) continue;
      linkCount++;
      const clean = decodeURIComponent(raw.split('#')[0]);
      const target = path.resolve(path.dirname(f), clean);
      const rel = path.relative(exDir, target);
      if (rel.startsWith('..')) broken.push(`${path.relative(pkg, f)} -> ${raw} (escapes package)`);
      else if (!fs.existsSync(target)) broken.push(`${path.relative(pkg, f)} -> ${raw} (missing)`);
    }
  }
  if (broken.length) bad(`broken local links: ${broken.join(' | ')}`);
  else ok(`${linkCount} local links resolve inside package`);

  // credential heuristic
  const credRe = /(sk-[A-Za-z0-9]{20,}|ghp_[A-Za-z0-9]{20,}|xox[bap]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY-----)/;
  const hits = [];
  for (const f of walk(pkg)) {
    const t = fs.readFileSync(path.join(pkg, f.split('/').join(path.sep)), 'utf8');
    if (credRe.test(t)) hits.push(f);
  }
  if (hits.length) bad(`possible credentials in: ${hits.join(', ')}`);
  else ok('no credential-shaped strings found');

  results.push(r);
}

let failed = 0;
for (const r of results) {
  const status = r.fail.length ? 'FAIL' : 'PASS';
  if (r.fail.length) failed++;
  console.log(`\n[${status}] ${r.zip}`);
  for (const c of r.checks) console.log(`   ok   ${c}`);
  for (const f of r.fail) console.log(`   FAIL ${f}`);
}
console.log(`\n${results.length - failed}/${results.length} packages passed local validation.`);
if (failed) process.exitCode = 1;
