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
 *   node scripts/update-obsidian.mjs 1.15.1     # update to a specific version
 *   node scripts/update-obsidian.mjs 1.15.1 --repatch   # force a rebuild
 *   node scripts/update-obsidian.mjs --repatch          # rebuild the pinned kernel
 *   node scripts/update-obsidian.mjs --repatch --agent  # INTERNAL: device-agent probes
 *
 * Without --agent the release build strips the probe block and every
 * probeHook(...) call; the release app.js has no agent hooks at all.
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
import { spawnSync } from 'node:child_process';
import * as asar from '@electron/asar';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPTS_DIR = path.join(REPO_ROOT, 'scripts');
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
/* rev205: built-in pandoc (WebAssembly). Prepended before touch-mode so the
   Module._load hook is in place before any plugin runs; the assets it loads
   (resources/resfile/pandoc/*) are generated by scripts/build-pandoc-wasm.mjs
   and their path is published by ArkTS as pandocDir in the mode file. */
const PANDOC_WASM_PATCH = readPatch('pandoc-wasm.js');

// The ink layer (docs/STYLUS-PEN.md P1/P2) is prepended BEFORE touch-mode.js
// so its settings/diagnostics hooks exist by the time the settings page is
// built. Both blocks live in the same app.js scope and share one IPC socket.
const INK_PATCH = readPatch('ohsidian-ink.js');

/**
 * Release builds must not contain the device-agent probe implementation.
 * Remove the marked probe-only block plus every `probeHook(...)` statement.
 * The scanner is quote/brace aware, so strings and nested object literals in
 * the probe payload do not confuse it.
 */
function stripDevProbeCalls(src) {
  let s = String(src || '');
  s = s.replace(/\/\* OHSIDIAN_DEV_PROBE_START \*\/[\s\S]*?\/\* OHSIDIAN_DEV_PROBE_END \*\//g, '');
  s = s.replace(/^[ \t]*if \(!window\.__ohsidianProbeHooks\) return;\r?\n/gm, '');
  s = s.replace(/\n[ \t]*if \(window\.__ohsidianProbeHooks\) \{\s*self\.rendered\+\+;\s*\}/g, '');
  s = s.replace(/^[ \t]*probeCount: 0,\r?\n/gm, '');
  let out = '';
  let i = 0;
  while (true) {
    const start = s.indexOf('probeHook(', i);
    if (start < 0) {
      out += s.slice(i);
      break;
    }
    let j = start + 'probeHook('.length;
    let depth = 1;
    let quote = '';
    let esc = false;
    for (; j < s.length; j++) {
      const c = s[j];
      if (quote) {
        if (esc) { esc = false; continue; }
        if (c === '\\') { esc = true; continue; }
        if (c === quote) { quote = ''; }
        continue;
      }
      if (c === '"' || c === "'" || c === '`') { quote = c; continue; }
      if (c === '(') depth++;
      else if (c === ')') {
        depth--;
        if (depth === 0) break;
      }
    }
    if (j >= s.length) {
      out += s.slice(i);
      break;
    }
    let end = j + 1;
    while (end < s.length && (s[end] === ' ' || s[end] === '\t')) end++;
    if (s[end] === ';') end++;
    // Remove indentation before the statement so the release source stays tidy.
    let lineStart = out.lastIndexOf('\n');
    if (lineStart >= 0 && /^[ \t]*$/.test(out.slice(lineStart + 1))) {
      out = out.slice(0, lineStart + 1);
    }
    out += s.slice(i, start);
    i = end;
  }
  // After probeHook(...) calls are gone the surrounding if-block is empty.
  out = out.replace(/\n[ \t]*if \(window\.__ohsidianProbeHooks\) \{\s*self\.rendered\+\+;\s*\}/g, '');
  return out;
}
// DEVICE AGENT PROBE: injected only with --agent. Release builds have no
// __ohsidianProbeHooks implementation, so probeHook() calls are no-ops.
// Read lazily: the file is export-ignored from release source archives.
function readProbePatch() {
  const p = path.join(PATCH_DIR, 'ohsidian-probe.js');
  if (!fs.existsSync(p)) {
    throw new Error('agent build requested but scripts/patches/ohsidian-probe.js is missing');
  }
  return fs.readFileSync(p, 'utf8');
}

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
  const agentBuild = process.argv.includes('--agent');
  const versionArg = process.argv.slice(2).find(a => a !== '--repatch' && a !== '--agent');
  const currentVersion = readReleaseInfo();
  log(`current Obsidian version: ${currentVersion}`);

  // --repatch without a version rebuilds the CURRENTLY PINNED kernel (what
  // hvigor/ensure-obsidian-asar and local rebuilds want); the plain path
  // without --repatch upgrades to latest stable as documented.
  //
  // Offline repatch: the pinned artifact already records hash + signature, and
  // the download is cached under scripts/.tmp-update. Fetching the live release
  // JSON is therefore unnecessary (and makes repatching impossible without a
  // network), so skip it when we are rebuilding the pinned kernel.
  let release = null;
  if (!repatch) {
    release = await fetchReleaseJson();
  }
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
  if (repatch) {
    entry = readPinnedArtifact(targetVersion);
    if (!entry) {
      fail(`no pinned artifact for Obsidian ${targetVersion}; add it to scripts/obsidian-artifacts.json ` +
        '(offline repatch needs the pinned hash + signature to validate the cached download)');
    }
    log(`offline repatch: using pinned artifact for ${targetVersion}`);
  } else if (release.beta && versionArg === release.beta.latestVersion) {
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
  log('injecting ink layer + touch-mode command into app.js');
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
  // 1.15.1 renamed the drawer pane local from `n` to `t.path` and added the
  // async-persistence dual write `Bm(t.path),` in front of it (see the kernel
  // notes in docs/PLATFORM-ADAPTATION.md). Keep that prefix and route only the
  // localStorage+reload tail: `(Bm(t.path),i.app.openVaultChooser())`.
  const drawerSwitchSrc = 'window.localStorage.setItem("mobile-selected-vault",t.path),location.reload()';
  const drawerSwitchDst = 'i.app.openVaultChooser()';
  const drawerSwitchApplied = '(Bm(t.path),i.app.openVaultChooser())';
  // The settings-page vault <select> carries the SAME dead end (write the
  // mobile key, reload, desktop shell ignores it). 1.15.1 already calls
  // `this.app.openVaultChooser()` for its "manage-vaults" option in the same
  // arrow handler, so `this.app` is proven in scope right at the patch site.
  const drawerSelectSrc = 'window.localStorage.setItem("mobile-selected-vault",u),location.reload()';
  const drawerSelectDst = 'this.app.openVaultChooser()';
  const drawerSelectApplied = '(Bm(u),this.app.openVaultChooser())';
  // Obsidian's font picker candidates (Zne): a hardcoded seed list plus a
  // desktop-font probe table that mostly misses on HarmonyOS, and the
  // engine does not implement the get-fonts module - so settings show
  // only Inter / Source Code Pro. Inject the full system family list
  // (published by ArkTS as cfg.systemFonts, surfaced at boot as
  // window.__ohsidianSystemFonts).
  // 1.15.1 moved this into the lazy font loader `ele()` (seed `let o=[...]`).
  const fontListSrc = 'let o=["Inter","Source Code Pro"];$A=o;';
  const fontListDst = 'let o=["Inter","Source Code Pro"].concat(window.__ohsidianSystemFonts||[]);$A=o;';
  // The delete confirmation dialog shows a stock "moved to your .trash
  // folder" notice on the local branch (trashOption is forced "local" by
  // the trash hook). Swap that notice for the OHSidian destination note:
  // window.__ohsidianTrashNote (injected patch) builds the text at
  // dialog-open time and returns null on any error, in which case the
  // stock notice still renders.
  // 1.15.1 minified the local branch to `r==="local"?l.createEl(...)`.
  const deleteNoteSrc = 'r==="local"?l.createEl("p",{text:w.dialogue.labelMoveToVaultTrash()}):';
  const deleteNoteDst = 'r==="local"?l.createEl("p",{text:window.__ohsidianTrashNote?window.__ohsidianTrashNote():w.dialogue.labelMoveToVaultTrash()}):';
  // PDF page canvases: Obsidian pins maxCanvasPixels=16 MiB but leaves
  // capCanvasAreaFactor at the upstream default 200 (screen pixels x3), i.e.
  // ~15.4 Mpx on this 2.249-density tablet - never a constraint for an A4
  // page. On high-DPI touch devices (tablet/phone, including 2-in-1s used as
  // tablets) cap one page at one screen's pixels. Desktop PCs at normal DPI
  // keep the upstream 200: their page canvas is small enough and full text
  // sharpness matters more than the memory saving.
  const pdfCanvasSrc = 'maxCanvasPixels:16777216,';
  const pdfCanvasDst = 'maxCanvasPixels:16777216,capCanvasAreaFactor:(window.devicePixelRatio>=2&&((window.matchMedia&&window.matchMedia("(pointer: coarse)").matches)||navigator.maxTouchPoints>0)?0:200),';
  // Plugin `require` must not be gated by the mobile emulation.
  //
  // Obsidian's loadPlugin hands each plugin a require() shim:
  //     a = document.body.hasClass("emulate-mobile"),
  //     s = function (e) { ...whitelist... : a ? (Notice + null) : sf(e) }
  // where sf() is the real `window.require`. The whitelist only carries
  // `obsidian` + CodeMirror 6 + Lezer, so on a REAL phone (no Node at all) the
  // `a` branch turns a Node require into a clean "attempted to load NodeJS
  // package" + null. Touch mode sets EmulateMobile, so this port inherited that
  // branch - but this renderer is Electron with full Node (window.require is the
  // very channel the kernel uses for fs/electron itself, and the diagnostics in
  // touch-mode.js spawnSync through it), so the null was a false negative: every
  // plugin with a top-level `require("fs"/"path"/"electron"/...)` threw and the
  // user got "插件加载失败" - only in touch mode, i.e. exactly the reported
  // "模式一换插件就坏". Force `a` to false: the whitelist still resolves first,
  // everything else falls through to the real require, and `rd.isMobile` (the
  // actual mobile LAYOUT) is untouched.
  // 1.15.1 also rewrote loadPlugin(): the emulate-mobile flag is now `l` and
  // the whitelist shim is `c=p=>Object.hasOwn(_oe,p)?`.
  const pluginRequireSrc = 'l=document.body.hasClass("emulate-mobile"),c=p=>Object.hasOwn(_oe,p)?';
  const pluginRequireDst = 'l=!1,c=p=>Object.hasOwn(_oe,p)?';

  /* -------------------------------------------------------------------------
     NF-015 (report 2026-11-22): plugin downloads used to be written to disk
     with ZERO validation. The upstream request wrapper retries through the
     release proxy when the request THROWS, but a peer that resets mid-body
     while the stack still reports success hands installPlugin a truncated
     main.js; it is written verbatim and every later loadPlugin() eval dies
     with SyntaxError -> the generic 563 "插件加载失败" notice, forever, with no
     trace in any log (the audit caught a deterministic truncation point at
     1,548,288 bytes; nutstore-sync 1.6.2, 4,182,455 bytes, is exactly the kind
     that hits it). 1.13.x had this spread over the tslib state machine of
     installPlugin (`case 1` / `case 2` / `case 12`); Obsidian 1.15.1 collapsed
     the whole download into one helper `UEe()`, so the patch is now a single
     function replacement: fetch the manifest, fetch main.js, PARSE it exactly
     the way loadPlugin will (`replace(TV,"")+IV` evaluated as a function
     body), retry once through the release proxy when the body does not parse,
     and throw a marked "incomplete" error instead of letting a doomed plugin
     reach disk. Parsing 4 MB costs ~100 ms, once, at install time only.
     ------------------------------------------------------------------------- */
  const PLUGIN_FETCH_SRC = 'async function UEe(o,t){let e=await sr(Xm(o,t,$h)).text,i=await sr(Xm(o,t,UT)).text;i=i.replace(TV,"")+IV;let r=null;try{r=await sr(Xm(o,t,qT)).text}catch(n){if(!(n instanceof kp))throw n}return{manifest:e,main:i,styles:r}}';
  /* The sentinels let scripts/verify-plugin-install.cjs slice this function out
     of the shipped app.js and drive it against synthetic downloads, so a patch
     that is present but inert fails the gate instead of shipping. */
  const PLUGIN_FETCH_DST = [
    '/*OHSIDIAN-PLUGIN-FETCH*/',
    'async function UEe(o,t){',
    'let e=await sr(Xm(o,t,$h)).text;',
    'var ohParses=function(v){try{new Function(String(v).replace(TV,"")+IV);return true}catch(err){return false}};',
    'var ohIncomplete=function(v){var err=new Error("plugin main.js incomplete ("+(v?String(v).length:0)+" chars)");err.__ohsidianPluginDownloadIncomplete=true;return err};',
    'var ohUrl=Xm(o,t,UT);',
    'var ohMain=await sr(ohUrl).text;',
    'if(!ohParses(ohMain)||String(ohMain).length<64){',
    'try{console.warn("[OHSidian] plugin main.js looks truncated, retrying through the release proxy:",ohUrl)}catch(eW){}',
    'var ohRetry=null;',
    'try{ohRetry=await sr("https://releases.obsidian.md/proxy?url="+encodeURIComponent(ohUrl)).text}catch(eR){throw ohIncomplete(ohMain)}',
    'if(!ohParses(ohRetry)||String(ohRetry).length<64)throw ohIncomplete(ohRetry);',
    'ohMain=ohRetry;',
    '}',
    'var i=ohMain.replace(TV,"")+IV;',
    'let r=null;try{r=await sr(Xm(o,t,qT)).text}catch(n){if(!(n instanceof kp))throw n}',
    'return{manifest:e,main:i,styles:r}}',
    '/*OHSIDIAN-PLUGIN-FETCH-END*/',
  ].join('\n');
  /* installPlugin() failure surface (1.15.1 shape):
     `catch(d){return console.error(d),l(zo.msgFailedToInstallPlugin({name:a}))}`
     where `l()` is the local notice helper (drop is-loading, auto-hide 3 s). */
  const pluginInstallFailSrc = 'catch(d){return console.error(d),l(zo.msgFailedToInstallPlugin({name:a}))}';
  const pluginInstallFailDst = 'catch(d){return console.error(d),l((d&&(d.__ohsidianPluginDownloadIncomplete===true||d instanceof SyntaxError))?"安装失败：插件文件下载不完整（疑似网络截断），请更换网络后重试":zo.msgFailedToInstallPlugin({name:a}))}';
  /* A plugin that is ALREADY broken on disk (installed before this fix) keeps
     failing at loadPlugin's eval with SyntaxError. Give that failure its own
     actionable notice instead of the generic 563 so support can tell the two
     apart: 563 + SyntaxError = the file itself is incomplete. */
  const pluginLoadSyntaxSrc = 'catch(n){return this.loadingPluginId=null,new R(w.interface.msgFailedToLoadPlugin({plugin:e})),console.error("Plugin failure: "+e,n),!1}';
  const pluginLoadSyntaxDst = 'catch(n){return this.loadingPluginId=null,new R(w.interface.msgFailedToLoadPlugin({plugin:e})),(n instanceof SyntaxError)&&(new R("插件「"+e+"」的 main.js 无法解析：文件可能下载不完整。请在插件市场卸载后更换网络重新安装。",12e3),console.error("[OHSidian] plugin file unparsable (truncated download?): "+e+" :: "+(n&&n.message))),console.error("Plugin failure: "+e,n),!1}';
  /* NF-018 (report 2026-11-22): the kernel's desktop secretStorage adapter
     reads window.electron.remote.safeStorage, which this engine does not
     implement (0 hits in the wrapper main.js and the ArkTS tree). Giving it
     the kernel's mobile semantics - plaintext passthrough, encryption
     "unavailable" - is what makes BRAT 2.2.0's token migration complete. The
     fallback object itself comes from the touch-mode patch
     (window.__ohsidianSafeStorageFallback); this patch only makes the adapter
     prefer it when the engine value is missing or incomplete.
     1.15.1 shape: a constructor class field
     `this.safeStorage=window.electron.remote.safeStorage}` (1.13.x used the
     `n.safeStorage=...,n}` comma expression), so the closing brace stays. */
  const secretStorageAdapterSrc = 'this.safeStorage=window.electron.remote.safeStorage}';
  const secretStorageAdapterDst = 'this.safeStorage=(function(){var s=null;try{s=window.electron&&window.electron.remote&&window.electron.remote.safeStorage}catch(e){s=null}if(s&&typeof s.isEncryptionAvailable==="function"&&typeof s.encryptString==="function"&&typeof s.decryptString==="function"&&typeof s.getSelectedStorageBackend==="function")return s;try{console.warn("[OHSidian] engine has no remote.safeStorage - secretStorage uses plaintext passthrough (NF-018)")}catch(eW){}return window.__ohsidianSafeStorageFallback||{isEncryptionAvailable:function(){return false},getSelectedStorageBackend:function(){return "basic_text"},encryptString:function(v){return String(v)},decryptString:function(v){return String(v)}}})()}';
  /* rev203: settings-definition keys. The kernel derives a definition key as
     `type:heading` (or `type#index` without a heading, `type:id:<id>` when the
     definition carries an id). A plugin that emits two groups with the SAME
     heading (nutstore-sync 1.6.2 has two 模块开关: groups) produces colliding
     keys: the kernel logs 'duplicate setting key' and the keyed re-render diff
     may reuse one group's DOM for the other. Append the position index to the
     heading / plain branches so every key is unique and still stable across
     re-renders (re-renders keep the definition order); id-keyed definitions
     are already unique and keep their upstream key. 1.15.1 minified the helper
     to `AEe`. */
  const settingsDefKeySrc = 'function AEe(o,t){return o.id?o.type+":id:"+o.id:o.heading?o.type+":"+o.heading:o.type+"#"+t}';
  const settingsDefKeyDst = 'function AEe(o,t){return o.id?o.type+":id:"+o.id:(o.heading?o.type+":"+o.heading:o.type)+"#"+t}';
  const APP_BODY_PATCHES = [
    [drawerSwitchSrc, drawerSwitchDst, drawerSwitchApplied, 'vault drawer switch routed to openVaultChooser',
      'vault drawer switch site not found (app.js layout changed?); ' +
      'drawer vault switching will silently no-op in touch mode'],
    [drawerSelectSrc, drawerSelectDst, drawerSelectApplied, 'settings-page vault switch routed to openVaultChooser',
      'settings vault-select site not found (app.js layout changed?); ' +
      'switching vault from the settings dropdown will silently no-op'],
    [fontListSrc, fontListDst, fontListDst, 'system font list injected into the settings font picker',
      'font picker seed site not found (app.js layout changed?); ' +
      'settings will show only Inter / Source Code Pro'],
    [deleteNoteSrc, deleteNoteDst, deleteNoteDst, 'delete dialog shows the OHSidian trash destination',
      'delete dialog notice site not found (app.js layout changed?); ' +
      'the delete dialog keeps the stock ".trash folder" wording'],
    [pdfCanvasSrc, pdfCanvasDst, pdfCanvasDst, 'PDF page canvas capped at one screen on high-DPI touch devices',
      'PDF canvas config site not found (app.js layout changed?); ' +
      'wide PDF pages keep the full-resolution canvas (~39 MB/page on the tablet)'],
    [pluginRequireSrc, pluginRequireDst, pluginRequireDst, 'plugin require() no longer gated by EmulateMobile (touch mode)',
      'loadPlugin require-shim site not found (app.js layout changed?); ' +
      'touch mode will keep failing every plugin that requires a Node module'],
    // NF-015: plugin install integrity (report 2026-11-22). 1.15.1's single
    // download helper UEe() carries the whole defence in one replacement.
    [PLUGIN_FETCH_SRC, PLUGIN_FETCH_DST, '/*OHSIDIAN-PLUGIN-FETCH*/',
      'plugin install: manifest+main.js parsed and retried before any write',
      'plugin download helper UEe() site not found (app.js layout changed?); ' +
      'a truncated plugin main.js will still be written unchecked'],
    [pluginInstallFailSrc, pluginInstallFailDst, '插件文件下载不完整（疑似网络截断）',
      'plugin install: incomplete download gets an explicit message',
      'installPlugin failure site not found (app.js layout changed?); truncated installs keep the generic message'],
    [pluginLoadSyntaxSrc, pluginLoadSyntaxDst, '[OHSidian] plugin file unparsable',
      'plugin load: SyntaxError gets a "file may be truncated" notice',
      'enablePlugin failure site not found (app.js layout changed?); a truncated plugin keeps the generic notice'],
    // NF-018: secretStorage on a desktop-form package without engine safeStorage.
    [secretStorageAdapterSrc, secretStorageAdapterDst, 'engine has no remote.safeStorage',
      'secretStorage desktop adapter falls back to plaintext (engine has no safeStorage)',
      'k6 safeStorage site not found (app.js layout changed?); BRAT-style secretStorage plugins will keep failing silently'],
    // rev203: plugins with duplicate settings-group headings (nutstore-sync) must
    // not collide in the definition-key diff.
    [settingsDefKeySrc, settingsDefKeyDst, settingsDefKeyDst, 'settings definition keys unique by position',
      'settings keying site not found (app.js layout changed?); plugins with duplicate group headings keep logging duplicate-setting-key warnings'],
  ];
  for (const [src, dst, appliedNeedle, okMsg, warnMsg] of APP_BODY_PATCHES) {
    // src FIRST: several dst tokens already exist elsewhere in upstream's code
    // (the drawer's `i.app.openVaultChooser()` prefix, `this.app.openVaultChooser()`
    // in the manage-vaults option), so testing dst first makes a pristine app.js
    // look "already applied" and silently skips the real replacement. The
    // explicit appliedNeedle can only exist after this specific patch.
    if (appSrc.includes(src)) {
      appSrc = appSrc.replace(src, dst);
      log(okMsg);
    } else if (appSrc.includes(appliedNeedle)) {
      log('body patch already applied: ' + okMsg);
    } else {
      log('WARNING: ' + warnMsg);
    }
  }

  const releaseInkPatch = agentBuild ? INK_PATCH : stripDevProbeCalls(INK_PATCH);
  const probePatch = agentBuild ? readProbePatch() : '';
  fs.writeFileSync(appJs, releaseInkPatch + probePatch + PANDOC_WASM_PATCH + TOUCH_MODE_PATCH + appSrc);
  log(agentBuild ? 'device agent probes ENABLED (--agent build)' : 'release build: device agent probes excluded');

  const asarMainJs = path.join(extractedDir, 'main.js');
  if (fs.existsSync(asarMainJs)) {
    let mainSrc = fs.readFileSync(asarMainJs, 'utf8');
    log('injecting IPC guard + version-floor bypass into main.js');
    /* Belt-and-suspenders for the "Electron major < 21" gate: the runtime
       process.versions shim may be silently ignored if the engine made the
       object read-only, so also patch the gate's definition textually. The
       parsed major has exactly two consumers (verified by string search:
       `$t>=29` for plugin-script-root, `$t<21` for the gate), so flooring it
       at 28 is safe and keeps every later logic branch on the same side.
       1.15.1 renamed the minified pair (fo/bo -> fi/$t); the value `28.2.3`
       and the gate semantics are unchanged - do NOT raise the shim. */
    const GATE_DEF = '$t=parseInt(fi.split(".")[0])';
    if (mainSrc.includes(GATE_DEF)) {
      mainSrc = mainSrc.replace(GATE_DEF, '$t=Math.max(parseInt(fi.split(".")[0]),28)');
      log('version-floor gate patched ($t floored at 28)');
    } else if (mainSrc.includes('no longer supported')) {
      log('WARNING: version-floor gate pattern not found - upstream may have changed it; investigate manually');
    }
    /* Disable the auto-updater: on HarmonyOS there is nothing to update
       into (HAPs are distributed through this repo's Releases), and the
       updater would only burn battery checking obsidian.md. main.js gates
       the updater on (workBuild || config.updateDisabled) and emits "disable"
       when set - force the flag so every boot starts with updates off,
       regardless of what the global config says. 1.15.1 renamed the minified
       pair (at/D -> no/k) and the flag now lives on the config object `k`. */
    const UPDATER_DISABLE_SRC = '(no||k.updateDisabled)&&(e.emit("disable",!0)';
    // NOTE: `||` binds tighter than `=`, so the assignment MUST get its own
    // parens - `(no||k.updateDisabled=!0)` would parse as
    // `(no||k.updateDisabled)=!0` and fail with "Invalid left-hand side".
    const UPDATER_DISABLE_DST = '(no||(k.updateDisabled=!0))&&(e.emit("disable",!0)';
    if (mainSrc.includes(UPDATER_DISABLE_SRC)) {
      mainSrc = mainSrc.replace(UPDATER_DISABLE_SRC, UPDATER_DISABLE_DST);
      log('auto-updater force-disabled (updateDisabled latched true)');
    } else {
      log('WARNING: updater gate pattern not found - auto-update stays controllable from settings');
    }
    /* The app:// protocol handler sets Range/Length/ACAO/Last-Modified but no
       Content-Type. Module scripts and module workers (pdf.js 5 uses
       `new Worker(url,{type:"module"})` for pdf.worker.min.mjs) are rejected
       without a JavaScript MIME type; pdf.js then silently falls back to a
       "fake worker" on the UI thread, which is exactly the slow/white PDF
       loading path. Set a small extension->MIME map on the same response.
       1.15.1 handle branch: path variable `s`, header object `E` (Headers). */
    const APP_MIME_SRC = 'return E.set("Access-Control-Allow-Origin","*")';
    const APP_MIME_DST = 'let _ohExt=String(s).toLowerCase();let _ohDot=_ohExt.lastIndexOf(".");_ohExt=_ohDot>=0?_ohExt.slice(_ohDot):"";let _ohMap={".mjs":"text/javascript; charset=utf-8",".js":"text/javascript; charset=utf-8",".wasm":"application/wasm",".css":"text/css; charset=utf-8",".json":"application/json",".html":"text/html; charset=utf-8",".pdf":"application/pdf",".svg":"image/svg+xml",".ttf":"font/ttf",".otf":"font/otf",".woff":"font/woff",".woff2":"font/woff2"};if(_ohMap[_ohExt])E.set("Content-Type",_ohMap[_ohExt]);return E.set("Access-Control-Allow-Origin","*")';
    // Electron still exposes registerFileProtocol; when that branch wins the
    // handler builds a callback object instead of a Response. Patch both.
    // 1.15.1 file-protocol branch: path `d`, headers object `T`.
    const APP_MIME_FILE_SRC = 's({path:d,headers:T})';
    const APP_MIME_FILE_DST = '(function(){let _ohExt=String(d).toLowerCase();let _ohDot=_ohExt.lastIndexOf(".");_ohExt=_ohDot>=0?_ohExt.slice(_ohDot):"";let _ohMap={".mjs":"text/javascript; charset=utf-8",".js":"text/javascript; charset=utf-8",".wasm":"application/wasm",".css":"text/css; charset=utf-8",".json":"application/json",".html":"text/html; charset=utf-8",".pdf":"application/pdf",".svg":"image/svg+xml",".ttf":"font/ttf",".otf":"font/otf",".woff":"font/woff",".woff2":"font/woff2"};if(_ohMap[_ohExt])T["Content-Type"]=_ohMap[_ohExt]})(),s({path:d,headers:T})';
    if (mainSrc.includes(APP_MIME_DST)) {
      log('app:// MIME map already present (module worker can load)');
    } else if (mainSrc.includes(APP_MIME_SRC)) {
      mainSrc = mainSrc.replace(APP_MIME_SRC, APP_MIME_DST);
      log('app:// Content-Type map added (protocol.handle branch)');
    } else {
      log('WARNING: app:// response anchor not found - pdf.js may fall back to a fake worker (slow/white PDF)');
    }
    if (mainSrc.includes(APP_MIME_FILE_DST)) {
      log('app:// file-protocol MIME map already present');
    } else if (mainSrc.includes(APP_MIME_FILE_SRC)) {
      mainSrc = mainSrc.replace(APP_MIME_FILE_SRC, APP_MIME_FILE_DST);
      log('app:// Content-Type map added (registerFileProtocol branch)');
    } else {
      log('WARNING: app:// file-protocol anchor not found');
    }
    /* Round 93 (93e): default the window frame to NATIVE. Upstream reads
       the GLOBAL config (1.13.x `D`, 1.15.1 `k` = <userData>/obsidian.json)
       once at startup: `Ke=k.frame==="native"` -> every unset value (the stock
       "hidden" frameless) creates frameless windows whose WMS min/max/close
       buttons float over the content and collide with Obsidian's own top-right
       controls on this device (hidden was unverifiable-by-settings too:
       the frame UI and the window construction both key off the same field, so
       only the main-process default could fix it - renderer-side
       migrations 93b/93d wrote the wrong file and were inert). Reversing
       the default keeps explicit choices intact: "hidden"/"custom" still
       produce frameless windows, an unset value now means native. */
    const FRAME_DEFAULT_SRC = 'Ke=k.frame==="native",vt=Ke?"default":"hidden"';
    const FRAME_DEFAULT_DST = 'Ke=k.frame==="native"||k.frame==null,vt=Ke?"default":"hidden"';
    if (mainSrc.includes(FRAME_DEFAULT_DST)) {
      log('frame default already patched (unset -> native)');
    } else if (mainSrc.includes(FRAME_DEFAULT_SRC)) {
      mainSrc = mainSrc.replace(FRAME_DEFAULT_SRC, FRAME_DEFAULT_DST);
      log('frame default reversed: unset global frame value now means native');
    } else {
      log('WARNING: frame default pattern not found - windows keep the hidden-frameless default; ' +
        'set 窗口边框样式 = 原生 manually in settings if the caption collides');
    }
    /* R1 (kernel-upgrade audit 2026-11-23): 1.15.1 main.js reads
       `r.nativeTheme.shouldUseDarkColors` on the window-creation path (starter
       window `systemTheme`, appearance following). The engine's main-process
       shim does not implement a nativeTheme module, so an unguarded dereference
       throws a TypeError while the first window is being built (possible white
       screen). One-line guard: an absent module simply means "not dark".
       The long-term fix belongs in the engine (NativeThemeAdapter already
       exists renderer-side); this keeps the app bootable until then. */
    const NATIVE_THEME_SRC = 'ro=()=>r.nativeTheme.shouldUseDarkColors?"theme-dark":"theme-light"';
    const NATIVE_THEME_DST = 'ro=()=>((r.nativeTheme&&r.nativeTheme.shouldUseDarkColors)?"theme-dark":"theme-light")';
    if (mainSrc.includes(NATIVE_THEME_DST)) {
      log('nativeTheme guard already present');
    } else if (mainSrc.includes(NATIVE_THEME_SRC)) {
      mainSrc = mainSrc.replace(NATIVE_THEME_SRC, NATIVE_THEME_DST);
      log('nativeTheme guard added (engine has no nativeTheme module)');
    } else {
      log('WARNING: nativeTheme use site not found - first-window theme detection may throw on this engine');
    }
    fs.writeFileSync(asarMainJs, MAIN_PROCESS_PATCH + mainSrc);
  }

  const patchedAsar = path.join(TEMP_DIR, `obsidian-${targetVersion}.patched.asar`);
  await asar.createPackage(extractedDir, patchedAsar);

  // --- install ---
  // Never copy straight over the live kernel: an ENOSPC, a disk hiccup or a
  // Ctrl-C in the middle leaves a truncated obsidian.asar, and the file is
  // gitignored, so nothing can roll it back - worse, every later build used to
  // treat "the file exists" as "the file is good" (audit NF-009). Verify the
  // staged archive first, keep the previous kernel as .bak, rename into place,
  // and only then record the version - so the version pin can never describe an
  // asar that failed to install.
  const stageCheck = spawnSync(process.execPath, [path.join(SCRIPTS_DIR, 'verify-asar.cjs')], {
    stdio: 'inherit',
    cwd: SCRIPTS_DIR,
    env: { ...process.env, OHSIDIAN_ASAR_PATH: patchedAsar },
  });
  if (stageCheck.status !== 0) {
    throw new Error('staged asar failed verify-asar - refusing to install it');
  }
  // Stage OUTSIDE resfile as well (audit N-1's neighbour): a copy left behind by
  // a crash between copy and rename would otherwise be packed into the HAP just
  // like the .bak was. .cache is on the same volume, so the swap stays a rename.
  const stageDir = path.join(REPO_ROOT, '.cache', 'asar-stage');
  fs.mkdirSync(stageDir, { recursive: true });
  const staged = path.join(stageDir, 'obsidian.asar');
  fs.copyFileSync(patchedAsar, staged);
  const stagedSize = fs.statSync(staged).size;
  if (stagedSize !== fs.statSync(patchedAsar).size) {
    fs.rmSync(staged, { force: true });
    throw new Error(`staged asar is truncated (${stagedSize} bytes vs ${fs.statSync(patchedAsar).size})`);
  }
  if (fs.existsSync(ASAR_PATH)) {
    // NOT next to the asar: everything under resfile is packed into the HAP, so
    // a 25 MB .bak there would ship in every local build (audit N-1). Keep the
    // previous kernel in the gitignored build cache instead.
    try {
      const backupDir = path.join(REPO_ROOT, '.cache', 'asar-backup');
      fs.mkdirSync(backupDir, { recursive: true });
      fs.copyFileSync(ASAR_PATH, path.join(backupDir, 'obsidian.asar.bak'));
    } catch (e) {
      log('WARN: could not keep the previous kernel as .cache/asar-backup/obsidian.asar.bak: ' + e.message);
    }
    // Drop a legacy .bak from an older installer: resfile is packed into the HAP
    // verbatim, so leaving it there adds ~25 MB to every local build (audit N-1).
    try {
      fs.rmSync(ASAR_PATH + '.bak', { force: true });
    } catch (e) {
    }
  }
  fs.renameSync(staged, ASAR_PATH);
  const pkg = JSON.parse(fs.readFileSync(PACKAGE_JSON, 'utf8'));
  pkg.version = targetVersion;
  fs.writeFileSync(PACKAGE_JSON, JSON.stringify(pkg, null, '\t') + '\n');

  log(`installed ${targetVersion} (${(fs.statSync(ASAR_PATH).size / 1048576).toFixed(1)} MiB) -> ${path.relative(REPO_ROOT, ASAR_PATH)}`);
  log('done. Build the HAP and test on device; revert with `git checkout -- web_engine/src/main/resources/resfile/resources/app/` if anything breaks.');
}

main().catch(e => fail(e.stack || e.message));
