// Rebuild web_engine/.../obsidian.asar from scripts/patches/*.js, in place.
// The asar's app.js/main.js are extracted, stripped of the previous patch,
// prepended with the current patch text, repacked and renamed back over the
// original.
//
// Usage: node scripts/refresh-app-patch.mjs
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

// Patch bodies live verbatim in scripts/patches/*.js (split out of
// update-obsidian.mjs so they can be syntax-checked and diffed on their own).
const PATCH_DIR = path.join(REPO_ROOT, 'scripts/patches');
const readPatch = (name) => fs.readFileSync(path.join(PATCH_DIR, name), 'utf8');
const TOUCH_MODE_PATCH = readPatch('touch-mode.js');
const MAIN_PROCESS_PATCH = readPatch('main-process.js');

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
  /* The prefix of app.js is INK + TOUCH (update-obsidian.mjs prepends the ink
     layer first) and the END marker belongs to the TOUCH block, so slicing at
     it removes the ink block too - while this script can only re-prepend the
     touch block. That used to ship an app with no handwriting/PDF ink at all
     (all four ink checks in verify-asar fail, everything else looks green).
     Keep everything before the touch block verbatim; replace only that block. */
  let prefixKeep = '';
  const hasInk = file === 'app.js' && src.includes('window.__ohsidianInkPatch');
  if (hasInk) {
    /* ';(function(){try{' is the literal first line of touch-mode.js and the
       ink block never contains the touch signature (checked: 0 hits), so this
       boundary is exact. Still refuse to guess if it is not where expected. */
    const sig = src.indexOf('if(window.__ohsidianTouchPatch=');
    const head = sig >= 0 ? src.lastIndexOf(';(function(){try{', sig) : -1;
    if (at < 0 || head < 0 || sig > at) {
      console.error('[refresh] ABORT: ink layer present but the touch block boundaries are not where expected.');
      console.error('[refresh] Run `node scripts/update-obsidian.mjs --repatch` (offline, cached kernel) instead.');
      process.exit(1);
    }
    prefixKeep = src.slice(0, head);
    console.log('[refresh] ink layer preserved verbatim (' + prefixKeep.length +
      ' bytes); run update-obsidian.mjs --repatch to pick up ink patch changes');
  }
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
  // Body patches the refresh can (re)apply idempotently. Kept in sync with
  // scripts/update-obsidian.mjs APP_BODY_PATCHES.
  if (file === 'app.js') {
    const bodyPatches = [
      ['window.localStorage.setItem("mobile-selected-vault",n),location.reload()',
       'i.app.openVaultChooser()', 'vault drawer switch'],
      ['var t=["Inter","Source Code Pro"];Xne=t;',
       'var t=["Inter","Source Code Pro"].concat(window.__ohsidianSystemFonts||[]);Xne=t;',
       'settings font list injection'],
    ];
    for (const [bsrc, bdst, name] of bodyPatches) {
      // src first - see update-obsidian.mjs: the drawer dst also occurs in
      // upstream's "manage-vaults" branch.
      if (src.includes(bsrc)) {
        src = src.replace(bsrc, bdst);
        console.log('[refresh] body patch applied: ' + name);
      } else if (src.includes(bdst)) {
        console.log('[refresh] body patch already applied: ' + name);
      } else {
        console.log('[refresh] WARNING: body patch site missing: ' + name);
      }
    }
  }
  if (file === 'main.js') {
    // Round 93 (93e), kept in sync with update-obsidian.mjs main(): reverse
    // the window-frame default - an unset global frame value counts as
    // native; explicit "hidden"/"custom" keep their stock frameless
    // semantics. Idempotent via the patched form check.
    const fsrc = 'let Ae=D.frame==="native",Ue=Ae?"default":"hidden"';
    const fdst = 'let Ae=D.frame==="native"||D.frame==null,Ue=Ae?"default":"hidden"';
    if (src.includes(fdst)) {
      console.log('[refresh] body patch already applied: frame default unset=native');
    } else if (src.includes(fsrc)) {
      src = src.replace(fsrc, fdst);
      console.log('[refresh] body patch applied: frame default unset=native');
    } else {
      console.log('[refresh] WARNING: frame default site missing - windows keep the hidden-frameless default');
    }
  }
  fs.writeFileSync(full, prefixKeep + patch + src);
  console.log('[refresh] ' + file + ': new patch prepended (len ' + patch.length + ')');
}

const out = path.join(WORK, 'obsidian.patched.asar');
await createPackage(patchedDir, out);

// Verify the NEW archive while the live kernel is still untouched (audit
// NF-009): the old order replaced first and verified after, so a broken build
// was already the installed kernel - and nothing else in the local pipeline
// ever looked at "exists but corrupt".
execFileSync(process.execPath, [path.join(REPO_ROOT, 'scripts/verify-asar.cjs')], {
  cwd: path.join(REPO_ROOT, 'scripts'),
  stdio: 'inherit',
  env: { ...process.env, OHSIDIAN_ASAR_PATH: out },
});

// Replace atomically and keep the previous kernel for a manual rollback: the
// asar is gitignored, so a plain copyFile over it had no way back. The backup
// goes to .cache/, NOT next to the asar - resfile is packed into the HAP and a
// 25 MB .bak there shipped in every local build (audit N-1).
if (fs.existsSync(ASAR_PATH)) {
  try {
    const backupDir = path.join(REPO_ROOT, '.cache', 'asar-backup');
    fs.mkdirSync(backupDir, { recursive: true });
    fs.copyFileSync(ASAR_PATH, path.join(backupDir, 'obsidian.asar.bak'));
  } catch (e) {
    console.log('[refresh] WARN: could not keep the previous kernel: ' + e.message);
  }
  // Legacy location: resfile ships inside the HAP, so a stray .bak there costs
  // ~25 MB per local build (audit N-1).
  try {
    fs.rmSync(ASAR_PATH + '.bak', { force: true });
  } catch (e) {
  }
}
fs.renameSync(out, ASAR_PATH);
console.log('[refresh] replaced asar: ' + (fs.statSync(ASAR_PATH).size / 1048576).toFixed(2) + ' MiB');

// Re-verify the installed path in a fresh process (asar headers are cached per
// process!) so the file that lands in the HAP is the one that was checked.
execFileSync(process.execPath, [path.join(REPO_ROOT, 'scripts/verify-asar.cjs')], {
  cwd: path.join(REPO_ROOT, 'scripts'),
  stdio: 'inherit',
});
