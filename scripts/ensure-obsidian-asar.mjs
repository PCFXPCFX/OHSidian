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
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ASAR_PATH = path.join(ROOT, 'web_engine', 'src', 'main', 'resources', 'resfile', 'resources', 'app', 'obsidian.asar');
const SCRIPTS_DIR = path.join(ROOT, 'scripts');
const ASAR_DEP = path.join(SCRIPTS_DIR, 'node_modules', '@electron', 'asar');

if (process.env.OHSIDIAN_SKIP_ASAR_ENSURE === '1') {
  console.log('[asar-ensure] skipped (OHSIDIAN_SKIP_ASAR_ENSURE=1)');
  process.exit(0);
}

if (existsSync(ASAR_PATH)) {
  process.exit(0);
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
console.log('[asar-ensure] obsidian.asar ready');
