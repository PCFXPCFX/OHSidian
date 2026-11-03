#!/usr/bin/env node
/**
 * Docs link check: every relative Markdown link in README*.md and docs/**.md
 * must resolve to an existing file. Anchors, http(s), mailto and absolute
 * paths are skipped. Exits 1 on the first broken link (prints all).
 *
 * Usage: node scripts/check-docs.cjs
 */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const SKIP_DIRS = new Set(['node_modules', '.git', '.cache', 'oh_modules', 'artifacts', 'reports', '.dsh-tmp']);
const SKIP_FILES = new Set([
  'CHANGES-2026-09.md',
  'CHANGES-2026-10.md',
  'HEVC-HARDWARE-DECODE-ANALYSIS.md',
  'B-NATIVE-OVERLAY.md',
]);

function walk(dir, out) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ent.name.startsWith('.') && ent.name !== '.github') continue;
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      if (SKIP_DIRS.has(ent.name)) continue;
      walk(p, out);
    } else if (ent.isFile() && ent.name.endsWith('.md')) {
      if (!SKIP_FILES.has(ent.name)) out.push(p);
    }
  }
  return out;
}

const files = [path.join(ROOT, 'README.md'), path.join(ROOT, 'README_EN.md')];
if (fs.existsSync(path.join(ROOT, 'docs'))) walk(path.join(ROOT, 'docs'), files);

const LINK_RE = /\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
const REF_RE = /^\[[^\]]+\]:\s*(\S+)/gm;
let broken = 0;
let checked = 0;

for (const file of files) {
  const text = fs.readFileSync(file, 'utf8');
  const targets = [];
  for (const m of text.matchAll(LINK_RE)) targets.push(m[1]);
  for (const m of text.matchAll(REF_RE)) targets.push(m[1]);
  for (const raw of targets) {
    let t = raw.replace(/^<|>$/g, '');
    if (!t || t.startsWith('#') || /^(https?:|mailto:|tel:|data:)/i.test(t)) continue;
    if (t.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(t)) continue;
    t = t.split('#')[0].split('?')[0];
    if (!t) continue;
    try { t = decodeURI(t); } catch { /* keep as-is */ }
    const target = path.resolve(path.dirname(file), t.replace(/\//g, path.sep));
    checked++;
    let ok = false;
    try { ok = fs.statSync(target).isFile() || fs.statSync(target).isDirectory(); } catch { ok = false; }
    if (!ok) {
      broken++;
      console.error(`BROKEN  ${path.relative(ROOT, file)} -> ${raw}`);
    }
  }
}

console.log(`docs links: ${checked} checked, ${broken} broken, ${files.length} files`);
process.exit(broken ? 1 : 0);
