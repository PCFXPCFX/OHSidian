/**
 * OHSidian Obsidian kernel updater.
 *
 * Downloads the latest official Obsidian desktop release (asar), verifies its
 * SHA-256 hash and RSA-SHA256 signature the same way the built-in updater does,
 * injects the OHSidian touch-mode command into app.js, repacks the asar and
 * installs it into web_engine's resfile app directory.
 *
 * Usage:
 *   node scripts/update-obsidian.mjs            # update to latest stable
 *   node scripts/update-obsidian.mjs 1.13.7     # update to a specific version
 *   node scripts/update-obsidian.mjs 1.13.7 --repatch   # force a rebuild
 *   node scripts/update-obsidian.mjs --repatch          # rebuild the pinned kernel
 *
 * A pinned kernel version (web_engine/.../app/package.json) is resolved via
 * scripts/obsidian-artifacts.json; the downloaded asar must report exactly
 * that version or the run aborts.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import * as asar from '@electron/asar';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const APP_DIR = path.join(REPO_ROOT, 'web_engine/src/main/resources/resfile/resources/app');
const PACKAGE_JSON = path.join(APP_DIR, 'package.json');
const MAIN_JS = path.join(APP_DIR, 'main.js');
const ASAR_PATH = path.join(APP_DIR, 'obsidian.asar');
const TEMP_DIR = path.join(REPO_ROOT, 'scripts/.tmp-update');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Safari/537.36';

function log(msg) { console.log('[update] ' + msg); }
function fail(msg) { console.error('[update] FAILED: ' + msg); process.exit(1); }

async function httpGetBinary(url, redirects = 0) {
  if (redirects > 5) throw new Error('too many redirects');
  const res = await fetch(url, { headers: { 'User-Agent': UA }, redirect: 'follow' });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return Buffer.from(await res.arrayBuffer());
}

function readReleaseInfo() {
  return JSON.parse(fs.readFileSync(PACKAGE_JSON, 'utf8')).version;
}

const CERT_PEM_PATH = path.join(REPO_ROOT, 'scripts/cert-obsidian.pem');

function readCertPem() {
  // The pinned distribution cert (public key), originally embedded in the
  // wrapper main.js updater; kept in a standalone file since the dead updater
  // was removed from main.js.
  return fs.readFileSync(CERT_PEM_PATH, 'utf8').trim();
}

/* Official artifact for a pinned kernel version. desktop-releases.json only
   exposes the current stable entry, so an older pinned kernel is resolved
   from scripts/obsidian-artifacts.json (hash + RSA signature recorded there).
   Without this, --repatch downloads "latest" and installs it under the pinned
   version name - every version-specific anchor then silently misses. */
function readPinnedArtifact(version) {
  try {
    const table = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'scripts/obsidian-artifacts.json'), 'utf8'));
    return table[version] && typeof table[version] === 'object' ? table[version] : null;
  } catch (e) {
    return null;
  }
}

async function fetchReleaseJson() {
  const urls = [
    'https://raw.githubusercontent.com/obsidianmd/obsidian-releases/master/desktop-releases.json',
    'https://releases.obsidian.md/desktop-releases.json',
  ];
  for (const url of urls) {
    try {
      const buf = await httpGetBinary(url);
      return JSON.parse(buf.toString('utf8'));
    } catch (e) {
      log(`release info from ${url} failed: ${e.message}`);
    }
  }
  fail('could not fetch desktop-releases.json');
}

function parseVersion(v) {
  if (!v) return null;
  const parts = v.split('.').map(Number);
  return parts.some(isNaN) ? null : parts;
}

function isVersionLess(a, b) {
  const va = parseVersion(a) ?? [];
  const vb = parseVersion(b) ?? [];
  const len = Math.max(va.length, vb.length);
  for (let i = 0; i < len; i++) {
    const x = va[i] ?? 0, y = vb[i] ?? 0;
    if (x < y) return true;
    if (x > y) return false;
  }
  return false;
}

/**
 * The touch-mode patch (v13):
 *  - Reads <userData>/ohsidian-mode.json (written by the ArkTS layer on tablet
 *    PC-mode switches): { systemMode: "touch"|"desktop", override: "auto"|"touch"|"desktop",
 *    windows: { [<OHOS window id>]: { l,t,w,h, insetsTop, insetsBottom, decor, keyboard } },
 *    insets: { top, bottom }, windowDecor: "system"|"none", keyboard: cssPx }.
 *    Round 87 (B2): window geometry moved under cfg.windows - concurrent
 *    windows used to clobber each other's top-level insets within one poll.
 *    The renderer size-matches itself against the entries (outerWidth/
 *    outerHeight +-2px; equal-size windows carry equal geometry) and falls
 *    back to the legacy top-level fields, which the MAIN window keeps
 *    mirroring for the main-process patch and single-window sessions.
 *  - "auto" follows systemMode; "touch"/"desktop" force Obsidian's mobile layout
 *    (EmulateMobile) on/off. Applied at boot and polled, reloading on change.
 *  - Applies the REAL system-bar insets as body inline CSS vars,
 *    overriding Obsidian's simulated iPhone notch / desktop zeroing, guarded
 *    by a MutationObserver so later writes by Obsidian are corrected.
 *  - Round 87 (B1): the CSS desktop-safe-pad is now THE avoidance path for
 *    every desktop-layout window in a fullscreen-like rect - touch devices
 *    switched in-app AND maximized PC windows alike (the engine viewport no
 *    longer subtracts the bars, which left a dead background strip at the
 *    bottom of maximized windows). cfg.viewportAvoidsBars still suppresses
 *    it if a stale build ever writes true.
 *  - windowDecor controls the title-bar layout: "system" = free window, the
 *    SYSTEM caption strip (name + min/max/close) is the title bar - hide the
 *    web .titlebar entirely (the engine viewport already follows
 *    drawableRect below the strip, so no extra padding is applied);
 *    "none" = fullscreen, no caption involved. (cfg.caption is gone -
 *    round 87 C3: it never had a consumer.)
 *  - Routes every file deletion to Obsidian's own trash flow: HarmonyOS
 *    exposes no system recycle-bin API to third-party apps, so the engine's
 *    "system trash" bridge either fails or (worst case) unlinks permanently.
 *    vault.trash() is forced to the local branch and getConfig("trashOption")
 *    reports "local" so the delete dialog shows the honest label. The local
 *    branch itself is RELOCATED to <Documents>/OHSidianTrash/<vault>/: a
 *    vault-local ".trash" is a dot-folder that 文件管理 never shows, so
 *    deleted notes were unreachable without a PC. Falls back to the stock
 *    local trash on any fs error (e.g. cross-device renames from sandbox
 *    vaults), so Obsidian's index handling stays intact either way.
 *  - The main-process patch purges both the relocated trash and every
 *    registered vault's .trash 60s after startup: entries whose mtime is
 *    older than 30 days are unlinked (relocation stamps deletion time).
 *  - Publishes the IME height as --keyboard-height on
 *    documentElement and dispatches keyboardWillShow/keyboardWillHide:
 *    Obsidian's mobile formatting toolbar positions itself with
 *    top: calc(100vh - var(--keyboard-height) - toolbar-height) and the
 *    engine never sets that variable. The renderer is purely push-driven:
 *    the ArkTS layer writes the per-window entry's keyboard on every
 *    keyboardHeightChange and the changed-file poll (200ms, no-op when the
 *    file is unchanged) fans the new value out.
 *  - Prefers HarmonyOS system fonts (HarmonyOS Sans) in the default font
 *    stacks - the engine's SkFontMgr_OHOS exposes /system/fonts, so they
 *    resolve; user-chosen fonts still override this. A command-palette
 *    command restores the system-font default by clearing the overrides.
 *  - Registers command-palette commands (touch-mode cycle, vault
 *    migration, system fonts).
 */
// Patch bodies are kept verbatim in scripts/patches/*.js. They are read as
// raw text - the text IS the JavaScript injected into app.js / main.js, so do
// not wrap it in a template literal (that would interpret \n, \\ and friends).
const PATCH_DIR = path.join(REPO_ROOT, 'scripts/patches');
const readPatch = (name) => fs.readFileSync(path.join(PATCH_DIR, name), 'utf8');

const TOUCH_MODE_PATCH = readPatch('touch-mode.js');

/**
 * IPC guard patch for the asar's main process (main.js):
 * wraps ipcMain.on/handle/... so handlers that touch an already-destroyed
 * BrowserWindow/WebContents (benign shutdown race, e.g. closing a window while
 * a "create/open vault" IPC is in flight) no longer pop the
 * "TypeError: Object has been destroyed" error dialog.
 */
const MAIN_PROCESS_PATCH = readPatch('main-process.js');

async function main() {
  const repatch = process.argv.includes('--repatch');
  const versionArg = process.argv.slice(2).find(a => a !== '--repatch');
  const currentVersion = readReleaseInfo();
  log(`current Obsidian version: ${currentVersion}`);

  const release = await fetchReleaseJson();
  // --repatch without a version rebuilds the CURRENTLY PINNED kernel (what
  // hvigor/ensure-obsidian-asar and local rebuilds want); the plain path
  // without --repatch upgrades to latest stable as documented.
  const targetVersion = versionArg || (repatch ? currentVersion : release.latestVersion);
  log(`target Obsidian version: ${targetVersion}${repatch ? ' (repatch)' : ''}`);

  if (!repatch) {
    if (targetVersion === currentVersion) { log('already up to date'); return; }
    if (!versionArg && !isVersionLess(currentVersion, targetVersion)) {
      log(`local version ${currentVersion} is not older than ${targetVersion}; nothing to do`);
      return;
    }
  }

  // Resolve the artifact for EXACTLY the target version. The live release
  // JSON has one stable entry (current latest); a pinned older kernel must
  // come from the pinned table, otherwise --repatch silently downloads and
  // installs "latest" under the pinned version name.
  let entry;
  if (release.beta && versionArg === release.beta.latestVersion) {
    entry = release.beta;
  } else if (targetVersion === release.latestVersion) {
    entry = release;
  } else {
    entry = readPinnedArtifact(targetVersion);
    if (!entry) {
      fail(`no pinned artifact for Obsidian ${targetVersion} (current stable is ${release.latestVersion}); ` +
        'add it to scripts/obsidian-artifacts.json when changing the kernel pin');
    }
    log(`using pinned artifact for ${targetVersion} (current stable is ${release.latestVersion})`);
  }
  const { downloadUrl, hash, signature } = entry;
  if (!downloadUrl || !hash || !signature) fail('release entry incomplete');

  fs.mkdirSync(TEMP_DIR, { recursive: true });

  const gzPath = path.join(TEMP_DIR, `obsidian-${targetVersion}.asar.gz`);
  let compressed = null;
  if (fs.existsSync(gzPath) && fs.statSync(gzPath).size > 1024 * 1024) {
    const cached = fs.readFileSync(gzPath);
    const cachedHash = crypto.createHash('SHA256').update(cached).digest('base64');
    if (cachedHash === hash) {
      log('using previously downloaded ' + gzPath);
      compressed = cached;
    } else {
      // A cache written by an older/buggy run must never be patched as if it
      // were the pinned kernel: discard it and download again.
      log(`cached download does not match the pinned hash - discarding ${gzPath}`);
      try { fs.unlinkSync(gzPath); } catch (e) { /* re-downloaded below */ }
    }
  }
  if (!compressed) {
    log('downloading ' + downloadUrl);
    try {
      compressed = await httpGetBinary(downloadUrl);
      fs.writeFileSync(gzPath, compressed);
    } catch (e) {
      const fallback = `https://releases.obsidian.md/release/obsidian-${targetVersion}.asar.gz`;
      log(`primary download failed (${e.message}), trying ${fallback}`);
      compressed = await httpGetBinary(fallback);
      fs.writeFileSync(gzPath, compressed);
    }
  }
  log(`downloaded ${(compressed.length / 1048576).toFixed(1)} MiB`);

  const actualHash = crypto.createHash('SHA256').update(compressed).digest('base64');
  if (actualHash !== hash) fail(`hash mismatch (expected ${hash}, got ${actualHash})`);
  log('sha256 ok');

  const pem = readCertPem();
  const verified = crypto.createVerify('RSA-SHA256').update(compressed).verify(pem, signature, 'base64');
  if (!verified) fail('signature verification failed');
  log('signature ok');

  const asarBuffer = zlib.gunzipSync(compressed);
  const downloadedAsar = path.join(TEMP_DIR, `obsidian-${targetVersion}.asar`);
  fs.writeFileSync(downloadedAsar, asarBuffer);

  // --- inject touch-mode command + IPC guard ---
  log('injecting touch-mode command into app.js');
  const extractedDir = path.join(TEMP_DIR, 'extracted');
  fs.rmSync(extractedDir, { recursive: true, force: true });
  asar.extractAll(downloadedAsar, extractedDir);
  // Refuse to patch an artifact that is not the requested kernel: a newer or
  // older app.js misses every textual anchor, and the mismatch would only
  // surface in verify-asar after the asar is already installed.
  let extractedVersion = '';
  try {
    extractedVersion = JSON.parse(fs.readFileSync(path.join(extractedDir, 'package.json'), 'utf8')).version || '';
  } catch (e) { /* reported below */ }
  if (String(extractedVersion) !== String(targetVersion)) {
    fail(`downloaded artifact is Obsidian ${extractedVersion || '(unknown)'} but the target is ${targetVersion}; ` +
      'refusing to install a mismatched kernel (check scripts/obsidian-artifacts.json and the pinned version)');
  }
  log(`kernel version confirmed: ${extractedVersion}`);
  const appJs = path.join(extractedDir, 'app.js');
  if (!fs.existsSync(appJs)) fail('app.js not found in asar');
  let appSrc = fs.readFileSync(appJs, 'utf8');

  // Touch-mode vault drawer: picking a vault name (not just "manage-vaults")
  // must open the desktop vault chooser. The mobile flow writes the
  // `mobile-selected-vault` localStorage key and reloads, but only the real
  // mobile shell honors that key - the desktop main process does not, so the
  // reload silently keeps the current vault. Route both to openVaultChooser,
  // which opens the starter (vault chooser) window via the working
  // desktop/createWindow path.
  const drawerSwitchSrc = 'window.localStorage.setItem("mobile-selected-vault",n),location.reload()';
  const drawerSwitchDst = 'i.app.openVaultChooser()';
  // Obsidian's font picker candidates (Zne): a hardcoded seed list plus a
  // desktop-font probe table that mostly misses on HarmonyOS, and the
  // engine does not implement the get-fonts module - so settings show
  // only Inter / Source Code Pro. Inject the full system family list
  // (published by ArkTS as cfg.systemFonts, surfaced at boot as
  // window.__ohsidianSystemFonts).
  const fontListSrc = 'var t=["Inter","Source Code Pro"];Xne=t;';
  const fontListDst = 'var t=["Inter","Source Code Pro"].concat(window.__ohsidianSystemFonts||[]);Xne=t;';
  // The delete confirmation dialog shows a stock "moved to your .trash
  // folder" notice on the local branch (trashOption is forced "local" by
  // the trash hook). Swap that notice for the OHSidian destination note:
  // window.__ohsidianTrashNote (injected patch) builds the text at
  // dialog-open time and returns null on any error, in which case the
  // stock notice still renders.
  const deleteNoteSrc = '"local"===i?o.createEl("p",{text:bd.dialogue.labelMoveToVaultTrash()}):';
  const deleteNoteDst = '"local"===i?o.createEl("p",{text:window.__ohsidianTrashNote?window.__ohsidianTrashNote():bd.dialogue.labelMoveToVaultTrash()}):';
  const APP_BODY_PATCHES = [
    [drawerSwitchSrc, drawerSwitchDst, 'vault drawer switch routed to openVaultChooser',
      'vault drawer switch site not found (app.js layout changed?); ' +
      'drawer vault switching will silently no-op in touch mode'],
    [fontListSrc, fontListDst, 'system font list injected into the settings font picker',
      'font picker seed site not found (app.js layout changed?); ' +
      'settings will show only Inter / Source Code Pro'],
    [deleteNoteSrc, deleteNoteDst, 'delete dialog shows the OHSidian trash destination',
      'delete dialog notice site not found (app.js layout changed?); ' +
      'the delete dialog keeps the stock ".trash folder" wording'],
  ];
  for (const [src, dst, okMsg, warnMsg] of APP_BODY_PATCHES) {
    // src FIRST: the drawer dst token ("i.app.openVaultChooser()") also exists
    // in upstream's "manage-vaults" branch, so testing dst first makes a
    // pristine app.js look "already applied" and silently skips the real
    // replacement (touch-mode vault switching then stays on reload()).
    if (appSrc.includes(src)) {
      appSrc = appSrc.replace(src, dst);
      log(okMsg);
    } else if (appSrc.includes(dst)) {
      log('body patch already applied: ' + okMsg);
    } else {
      log('WARNING: ' + warnMsg);
    }
  }

  fs.writeFileSync(appJs, TOUCH_MODE_PATCH + appSrc);

  const asarMainJs = path.join(extractedDir, 'main.js');
  if (fs.existsSync(asarMainJs)) {
    let mainSrc = fs.readFileSync(asarMainJs, 'utf8');
    log('injecting IPC guard + version-floor bypass into main.js');
    /* Belt-and-suspenders for the "Electron major < 18" gate: the runtime
       process.versions shim may be silently ignored if the engine made the
       object read-only, so also patch the gate's definition textually. The
       parsed major has exactly one consumer (verified by string search), so
       flooring it at 22 is safe and keeps any later logic consistent. */
    const GATE_DEF = 'bo=parseInt(fo.split(".")[0])';
    if (mainSrc.includes(GATE_DEF)) {
      mainSrc = mainSrc.replace(GATE_DEF, 'bo=Math.max(parseInt(fo.split(".")[0]),28)');
      log('version-floor gate patched (bo floored at 28)');
    } else if (mainSrc.includes('no longer supported')) {
      log('WARNING: version-floor gate pattern not found - upstream may have changed it; investigate manually');
    }
    /* Disable the auto-updater: on HarmonyOS there is nothing to update
       into (HAPs are distributed through this repo's Releases), and the
       updater would only burn battery checking obsidian.md. main.js gates
       the updater on (workBuild || D.updateDisabled) and emits "disable"
       when set - force the flag so every boot starts with updates off,
       regardless of what the global config says. */
    const UPDATER_DISABLE_SRC = '(at||D.updateDisabled)&&(e.emit("disable",!0)';
    // NOTE: `||` binds tighter than `=`, so the assignment MUST get its own
    // parens - `(at||D.updateDisabled=!0)` would parse as
    // `(at||D.updateDisabled)=!0` and fail with "Invalid left-hand side".
    const UPDATER_DISABLE_DST = '(at||(D.updateDisabled=!0))&&(e.emit("disable",!0)';
    if (mainSrc.includes(UPDATER_DISABLE_SRC)) {
      mainSrc = mainSrc.replace(UPDATER_DISABLE_SRC, UPDATER_DISABLE_DST);
      log('auto-updater force-disabled (updateDisabled latched true)');
    } else {
      log('WARNING: updater gate pattern not found - auto-update stays controllable from settings');
    }
    /* Round 93 (93e): default the window frame to NATIVE. Upstream reads
       the GLOBAL config (D = <userData>/obsidian.json) once at startup:
       `Ae=D.frame==="native"` -> every unset value (the stock "hidden"
       frameless) creates frameless windows whose WMS min/max/close buttons
       float over the content and collide with Obsidian's own top-right
       controls on this device (hidden was unverifiable-by-settings too:
       the frame UI and the window construction both key off D.frame, so
       only the main-process default could fix it - renderer-side
       migrations 93b/93d wrote the wrong file and were inert). Reversing
       the default keeps explicit choices intact: "hidden"/"custom" still
       produce frameless windows, an unset value now means native. */
    const FRAME_DEFAULT_SRC = 'let Ae=D.frame==="native",Ue=Ae?"default":"hidden"';
    const FRAME_DEFAULT_DST = 'let Ae=D.frame==="native"||D.frame==null,Ue=Ae?"default":"hidden"';
    if (mainSrc.includes(FRAME_DEFAULT_DST)) {
      log('frame default already patched (unset -> native)');
    } else if (mainSrc.includes(FRAME_DEFAULT_SRC)) {
      mainSrc = mainSrc.replace(FRAME_DEFAULT_SRC, FRAME_DEFAULT_DST);
      log('frame default reversed: unset global frame value now means native');
    } else {
      log('WARNING: frame default pattern not found - windows keep the hidden-frameless default; ' +
        'set 窗口边框样式 = 原生 manually in settings if the caption collides');
    }
    fs.writeFileSync(asarMainJs, MAIN_PROCESS_PATCH + mainSrc);
  }

  const patchedAsar = path.join(TEMP_DIR, `obsidian-${targetVersion}.patched.asar`);
  await asar.createPackage(extractedDir, patchedAsar);

  // --- install ---
  fs.copyFileSync(patchedAsar, ASAR_PATH);
  const pkg = JSON.parse(fs.readFileSync(PACKAGE_JSON, 'utf8'));
  pkg.version = targetVersion;
  fs.writeFileSync(PACKAGE_JSON, JSON.stringify(pkg, null, '\t') + '\n');

  log(`installed ${targetVersion} (${(fs.statSync(ASAR_PATH).size / 1048576).toFixed(1)} MiB) -> ${path.relative(REPO_ROOT, ASAR_PATH)}`);
  log('done. Build the HAP and test on device; revert with `git checkout -- web_engine/src/main/resources/resfile/resources/app/` if anything breaks.');
}

main().catch(e => fail(e.stack || e.message));
