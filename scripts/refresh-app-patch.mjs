// Rebuild web_engine/.../obsidian.asar from the current update-obsidian.mjs
// patches, in place. The asar's app.js/main.js are extracted, prepended
// with the current patch text, repacked and renamed back over the original.
//
// Usage: node scripts/refresh-app-patch.cjs
//
// IMPORTANT (see CHANGES round 43): the @electron/asar module caches archive
// headers per process - verification MUST run in a fresh node process, hence
// the child_process spawn at the bottom.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ASAR_PATH = path.join(REPO_ROOT, 'web_engine/src/main/resources/resfile/resources/app/obsidian.asar');
const WORK = path.join(REPO_ROOT, 'scripts/.tmp-refresh');

const { TOUCH_MODE_PATCH, MAIN_PROCESS_PATCH } = await (async () => {
  // update-obsidian.mjs is an ESM module that runs main() on import; grab
  // the patch strings by evaluating it in a sandboxed way is overkill - so
  // this script re-imports it and aborts if main() would try to download.
  // Simplest robust path: read the file and eval only the two const decls.
  const src = fs.readFileSync(path.join(REPO_ROOT, 'scripts/update-obsidian.mjs'), 'utf8');
  const grab = (name) => {
    const m = src.match(new RegExp('const ' + name + '\\s*=\\s*`'));
    if (!m) throw new Error(name + ' not found');
    const start = m.index + m[0].length;
    const end = src.indexOf('`;', start);
    if (end < 0) throw new Error(name + ' terminator not found');
    return src.slice(start, end);
  };
  return { TOUCH_MODE_PATCH: grab('TOUCH_MODE_PATCH'), MAIN_PROCESS_PATCH: grab('MAIN_PROCESS_PATCH') };
})();

fs.rmSync(WORK, { recursive: true, force: true });
fs.mkdirSync(WORK, { recursive: true });

// eslint-disable-next-line no-undef
const { createPackage, extractAll } = await import('@electron/asar');

const patchedDir = path.join(WORK, 'extracted');
extractAll(ASAR_PATH, patchedDir);

// Prepending must be idempotent: strip any previous patch first.
for (const [file, patch, marker] of [
  ['app.js', TOUCH_MODE_PATCH, '/*OHSIDIAN-PATCH-END*/'],
  ['main.js', MAIN_PROCESS_PATCH, '/*OHSIDIAN-IPC-GUARD-END*/'],
]) {
  const full = path.join(patchedDir, file);
  if (!fs.existsSync(full)) {
    console.log('[refresh] WARN: ' + file + ' missing, skipped');
    continue;
  }
  let src = fs.readFileSync(full, 'utf8');
  const at = src.indexOf(marker);
  if (at >= 0) {
    console.log('[refresh] ' + file + ': previous patch found at ' + at + ', stripping');
    src = src.slice(at + marker.length);
  } else {
    console.log('[refresh] ' + file + ': no previous patch marker (fresh file)');
  }
  // This script only re-prepends the patch blocks. The textual replacements
  // (version gate, drawer vault switch, updater latch) are applied once by
  // update-obsidian.mjs and are NOT redone here - on a never-processed asar
  // they would be missing and the app would die at startup ("manual update
  // required") behind a seemingly-successful refresh. Abort loudly instead.
  const requiredMarks = {
    'app.js': [['drawer vault switch (openVaultChooser)', 'i.app.openVaultChooser()']],
    'main.js': [
      ['version-floor gate (bo=Math.max)', 'bo=Math.max(parseInt(fo.split(".")[0]),28)'],
      ['updater disable latch', '(at||(D.updateDisabled=!0))&&(e.emit("disable",!0)'],
    ],
  };
  const missing = (requiredMarks[file] || [])
    .filter(([, needle]) => !src.includes(needle))
    .map(([name]) => name);
  if (missing.length > 0) {
    console.error('[refresh] ABORT: ' + file + ' is missing textual patches: ' + missing.join(', '));
    console.error('[refresh] Run `node scripts/update-obsidian.mjs` (full patcher) instead of refresh-app-patch.mjs.');
    process.exit(1);
  }
  fs.writeFileSync(full, patch + src);
  console.log('[refresh] ' + file + ': new patch prepended (len ' + patch.length + ')');
}

const out = path.join(WORK, 'obsidian.patched.asar');
await createPackage(patchedDir, out);

// Replace: copy back over the original (same volume rename safe).
fs.copyFileSync(out, ASAR_PATH);
console.log('[refresh] replaced asar: ' + (fs.statSync(ASAR_PATH).size / 1048576).toFixed(2) + ' MiB');

// Fresh-process verification (asar headers are cached per process!): the
// standalone scripts/verify-asar.cjs does the syntax + marker checks.
const { execFileSync: ex } = await import('node:child_process');
ex('node', [path.join(REPO_ROOT, 'scripts/verify-asar.cjs')], {
  cwd: path.join(REPO_ROOT, 'scripts'),
  stdio: 'inherit',
});
