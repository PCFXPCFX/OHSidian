#!/usr/bin/env node
/**
 * Ensure a patched obsidian.asar exists before the hvigor build packs it.
 *
 * The asar is not committed to the repository: it is the official Obsidian
 * artifact (SHA-256 + RSA verified at download time) with OHSidian runtime
 * patches injected. This script is called from the root hvigorfile.ts on
 * every build (DevEco GUI and hvigorw), so a fresh clone just builds:
 *
 *   - asar present  -> fast no-op (dev builds never touch an existing asar;
 *                      version upgrades are an explicit
 *                      `node scripts/update-obsidian.mjs`)
 *   - asar missing  -> install scripts deps if needed (npm ci), then run
 *                      scripts/update-obsidian.mjs --repatch (downloads the
 *                      official artifact, verifies, patches, installs)
 *
 * CI runs the same pipeline explicitly with caching (build-release.yml), so
 * this is a fast no-op there. Set OHSIDIAN_SKIP_ASAR_ENSURE=1 to disable.
 */
import { existsSync, statSync, rmSync, mkdirSync, renameSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ASAR_PATH = path.join(ROOT, 'web_engine', 'src', 'main', 'resources', 'resfile', 'resources', 'app', 'obsidian.asar');
const SCRIPTS_DIR = path.join(ROOT, 'scripts');
const ASAR_DEP = path.join(SCRIPTS_DIR, 'node_modules', '@electron', 'asar');
const BACKUP_DIR = path.join(ROOT, '.cache', 'asar-backup');
const BACKUP_PATH = path.join(BACKUP_DIR, 'obsidian.asar.bak');

/**
 * The previous kernel must not live next to the asar: EVERYTHING under
 * `web_engine/src/main/resources/resfile` is packed into the HAP verbatim, so a
 * 25 MB `obsidian.asar.bak` sitting there shipped in every local build until
 * somebody deleted it by hand (audit N-1; CI is unaffected because the file is
 * gitignored). This runs before the fast no-op exit, so any stray copy from an
 * older installer is moved out of the resource tree on the next build.
 */
function relocateLegacyBak() {
  const legacy = ASAR_PATH + '.bak';
  if (!existsSync(legacy)) return;
  if (existsSync(BACKUP_PATH)) {
    rmSync(legacy, { force: true });
    console.log('[asar-ensure] removed the legacy obsidian.asar.bak from the HAP resources');
    return;
  }
  try {
    mkdirSync(BACKUP_DIR, { recursive: true });
    renameSync(legacy, BACKUP_PATH);
    console.log('[asar-ensure] moved obsidian.asar.bak out of the HAP resources -> .cache/asar-backup');
  } catch (e) {
    try {
      rmSync(legacy, { force: true });
      console.log('[asar-ensure] removed obsidian.asar.bak from the HAP resources (' + e.message + ')');
    } catch (e2) {
      console.error('[asar-ensure] WARNING: cannot remove ' + legacy + ' - the next HAP ships an extra ~25 MB');
    }
  }
}

if (process.env.OHSIDIAN_SKIP_ASAR_ENSURE === '1') {
  console.log('[asar-ensure] skipped (OHSIDIAN_SKIP_ASAR_ENSURE=1)');
  process.exit(0);
}

relocateLegacyBak();

/**
 * "The file exists" is not "the file is good" (audit NF-009). The asar is
 * gitignored and installed by copying tens of MB, so an ENOSPC / interrupted
 * copy / half-finished repack leaves a truncated archive that this script used
 * to accept silently - every later build then packed it into the HAP and the
 * engine failed to load (white screen, dead kernel). Extracting app.js/main.js
 * with @electron/asar throws on a truncated header and costs milliseconds;
 * the marker check also catches an archive that was overwritten by an
 * unpatched one.
 */
async function asarProblem() {
  try {
    const size = statSync(ASAR_PATH).size;
    if (size < 1024 * 1024) return `only ${size} bytes`;
    const asar = await loadAsar();
    if (!asar) return '';
    const markers = {
      'app.js': ['__ohsidianTouchPatch', '__ohsidianInkPatch'],
      'main.js': ['__ohsidianConsoleBridge'],
    };
    for (const [name, needles] of Object.entries(markers)) {
      // The WHOLE file, not a prefix: app.js is ~4.4 MB and only the ink marker
      // lives in the first 256 KB - the touch marker sits at ~358 KB, so a
      // truncated window could never prove it (audit N-4). extractFile already
      // returned the full buffer.
      const body = asar.extractFile(ASAR_PATH, name).toString('utf8');
      const missing = needles.filter((needle) => !body.includes(needle));
      if (missing.length > 0) {
        return `${name} is missing patch markers: ${missing.join(', ')}`;
      }
    }
  } catch (e) {
    return e && e.message ? e.message : String(e);
  }
  return '';
}

let asarModule = null;
async function loadAsar() {
  if (asarModule) return asarModule;
  if (!existsSync(ASAR_DEP)) return null; // deps not installed: size check only
  try {
    asarModule = await import('@electron/asar');
  } catch (e) {
    asarModule = null;
  }
  return asarModule;
}

if (existsSync(ASAR_PATH)) {
  const problem = await asarProblem();
  if (!problem) {
    process.exit(0);
  }
  console.error(`[asar-ensure] existing obsidian.asar is unusable (${problem}) - rebuilding it`);
  try {
    // The previous kernel lives in .cache/asar-backup (see relocateLegacyBak),
    // so it survives this delete and is still available for a manual rollback.
    rmSync(ASAR_PATH, { force: true });
  } catch (e) {
    console.error('[asar-ensure] cannot delete the broken asar: ' + e.message);
    process.exit(1);
  }
}

console.log('[asar-ensure] obsidian.asar missing - generating it (official download, one-time per version, ~27 MB)');

if (!existsSync(ASAR_DEP)) {
  console.log('[asar-ensure] installing scripts dependencies (npm ci)');
  const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const install = spawnSync(npmCmd, ['ci', '--no-audit', '--no-fund', '--prefix', 'scripts'],
    { stdio: 'inherit', cwd: ROOT, shell: process.platform === 'win32' });
  if (install.status !== 0) {
    console.error('[asar-ensure] npm ci failed - run it manually:  npm ci --prefix scripts');
    process.exit(1);
  }
}

const patch = spawnSync(process.execPath, [path.join(SCRIPTS_DIR, 'update-obsidian.mjs'), '--repatch'],
  { stdio: 'inherit', cwd: ROOT });
if (patch.status !== 0 || !existsSync(ASAR_PATH)) {
  console.error('[asar-ensure] FAILED to generate obsidian.asar (network? disk?).');
  console.error('[asar-ensure] GitHub unreachable (common in CN networks)? Put the official');
  console.error('[asar-ensure] obsidian-<version>.asar.gz into scripts/.tmp-update/ and re-run:');
  console.error('[asar-ensure] the pipeline always verifies SHA-256 + RSA signature, so the');
  console.error('[asar-ensure] download source does not need to be trusted.');
  console.error('[asar-ensure] Run manually:  npm ci --prefix scripts && node scripts/update-obsidian.mjs --repatch');
  process.exit(1);
}
// S-N13: verify what we just built, same as CI does. Without this a broken
// or unpatched asar silently went into the local HAP (CI catches it, local
// builds did not).
const verify = spawnSync(process.execPath, [path.join(SCRIPTS_DIR, 'verify-asar.cjs')],
  { stdio: 'inherit', cwd: ROOT });
if (verify.status !== 0) {
  console.error('[asar-ensure] verify-asar FAILED - the generated asar is broken or');
  console.error('[asar-ensure] missing patch markers. Do not distribute this build.');
  process.exit(1);
}
console.log('[asar-ensure] obsidian.asar ready');
