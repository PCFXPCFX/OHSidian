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
 * The touch-mode patch (v7):
 *  - Reads <userData>/ohsidian-mode.json (written by the ArkTS layer on tablet
 *    PC-mode switches): { systemMode: "touch"|"desktop", override: "auto"|"touch"|"desktop",
 *    insets: { top: cssPx, bottom: cssPx }, windowDecor: "system"|"none" }.
 *  - "auto" follows systemMode; "touch"/"desktop" force Obsidian's mobile layout
 *    (EmulateMobile) on/off. Applied at boot and polled, reloading on change.
 *  - Applies the REAL system-bar insets (cfg.insets) as body inline CSS vars,
 *    overriding Obsidian's simulated iPhone notch / desktop zeroing, guarded
 *    by a MutationObserver so later writes by Obsidian are corrected.
 *  - Hides Obsidian's own desktop window controls (.titlebar-button-container
 *    .mod-right) when cfg.windowDecor === "system", i.e. tablet PC-mode free
 *    windows whose caption (min/max/close) is drawn by the system - without
 *    this both sets appear stacked (two close buttons).
 *  - Routes every file deletion to Obsidian's own .trash folder: HarmonyOS
 *    exposes no system recycle-bin API to third-party apps, so the engine's
 *    "system trash" bridge either fails or (worst case) unlinks permanently.
 *    vault.trash() is forced to the local branch and getConfig("trashOption")
 *    reports "local" so the delete dialog shows the honest label.
 *  - Registers a command-palette command that cycles the override.
 */
const TOUCH_MODE_PATCH = `;(function(){try{
if(window.__ohsidianTouchPatch==="7")return;window.__ohsidianTouchPatch="7";
/* Keep the renderer's view of the Electron major consistent with the main
   process shim: app.js requires >= 28.2.3 (Iie) before it stops showing the
   "manual update" notice. Replace the whole versions object - mutating the
   existing one can be silently ignored if it is read-only. */
try{
  var __ohEvVer=String(process.versions&&process.versions.electron||"");
  var __ohEvMajor=parseInt(__ohEvVer.split(".")[0]);
  if(!__ohEvMajor||__ohEvMajor<28){
    process.versions=Object.assign({},process.versions,{electron:"28.2.3"});
  }
}catch(e){}
var KEY="EmulateMobile";
var MODE_FILE="/ohsidian-mode.json";
function dataDir(){
  try{return require("@electron/remote").app.getPath("userData")}catch(e){}
  try{return require("electron").remote.app.getPath("userData")}catch(e){}
  return null;
}
function readMode(){
  try{
    var dir=dataDir();if(!dir)return null;
    var txt=require("fs").readFileSync(dir+MODE_FILE,"utf8");
    return JSON.parse(txt);
  }catch(e){return null}
}
function resolveWant(cfg){
  if(!cfg)return null;
  var o=cfg.override||"auto";
  if(o==="touch")return true;
  if(o==="desktop")return false;
  if(o==="auto")return cfg.systemMode==="touch";
  return null;
}
/* The window runs layout fullscreen (official immersive pattern): the app
   background extends under the visible status bar / navigation indicator and
   the WEB CONTENT must avoid them. Obsidian hardcodes a simulated iPhone
   notch for the emulated mobile layout
   (body.emulate-mobile { --safe-area-inset-top: 59px; --safe-area-inset-bottom: 34px })
   and zeroes these vars on desktop (isDesktopApp) - both are wrong here.
   The ArkTS layer publishes the REAL system-bar insets (CSS px) into
   ohsidian-mode.json (cfg.insets); apply them as body inline styles, which
   beat the stylesheet rule, and keep re-asserting them (MutationObserver +
   mode poll) so Obsidian's own desktop zeroing cannot wipe them. */
function readInsets(){
  try{
    var cfg=readMode();
    if(cfg&&cfg.insets){
      return {top:+cfg.insets.top||0,bottom:+cfg.insets.bottom||0};
    }
  }catch(e){}
  return {top:0,bottom:0};
}
function applySafeArea(){
  try{
    var b=document.body;
    if(!b)return;
    var ins=readInsets();
    var want={"--safe-area-inset-top":ins.top+"px","--safe-area-inset-bottom":ins.bottom+"px",
      "--safe-area-inset-left":"0px","--safe-area-inset-right":"0px"};
    for(var k in want){
      if(b.style.getPropertyValue(k)!==want[k]){b.style.setProperty(k,want[k])}
    }
  }catch(e){}
}
function watchBodyStyles(){
  try{
    if(!window.MutationObserver)return;
    var mo=new MutationObserver(function(){applySafeArea()});
    var hook=function(){var b=document.body;if(b){mo.observe(b,{attributes:true,attributeFilter:["style"]})}};
    hook();
    document.addEventListener("DOMContentLoaded",hook);
  }catch(e){}
}
/* Tablet PC mode runs free windows whose caption (minimize/maximize/close)
   is drawn by the SYSTEM. The desktop web UI would render its own duplicate
   controls on top of it (two close buttons), so when the ArkTS layer
   publishes cfg.windowDecor === "system", hide Obsidian's
   .titlebar-button-container.mod-right. Fullscreen/touch layout has no
   titlebar at all and non-PC-mode windows keep their controls (decor
   "none"), so the rule is toggled off again by the same channel. */
var DECOR_STYLE_ID="ohsidian-window-decor";
function applyWindowDecor(){
  try{
    var cfg=readMode();
    var system=!!(cfg&&cfg.windowDecor==="system");
    var el=document.getElementById(DECOR_STYLE_ID);
    if(system&&!el&&document.head){
      el=document.createElement("style");
      el.id=DECOR_STYLE_ID;
      el.textContent=".titlebar-button-container.mod-right{display:none!important}";
      document.head.appendChild(el);
    }else if(!system&&el){
      if(el.parentNode){el.parentNode.removeChild(el)}
    }
  }catch(e){}
}
/* Deletion safety net. vault.trash(file, system) dispatches to
   adapter.trashSystem (engine bridge; HarmonyOS has no recycle-bin API for
   apps, so it may fail silently or unlink the file outright) or to
   adapter.trashLocal (pure-JS: mkdir .trash + rename, works everywhere).
   Force the local branch and make getConfig("trashOption") report "local"
   so Obsidian's own delete dialog labels the action correctly. */
function hookTrash(){
  try{
    var v=window.app&&window.app.vault;
    if(!v||v.__ohsidianTrashHook)return;
    if(typeof v.trash!=="function")return;
    v.__ohsidianTrashHook=true;
    var origTrash=v.trash;
    v.trash=function(file,system){
      try{return origTrash.call(this,file,false)}
      catch(e){return origTrash.call(this,file,system)}
    };
    if(typeof v.getConfig==="function"){
      var origGetConfig=v.getConfig;
      v.getConfig=function(key){
        if(key==="trashOption")return "local";
        return origGetConfig.apply(this,arguments);
      };
    }
  }catch(e){}
}
function applyMobile(on,reason){
  try{
    var cur=!!localStorage.getItem(KEY);
    if(cur===on){applySafeArea();return false}
    if(on)localStorage.setItem(KEY,"1");else localStorage.removeItem(KEY);
    try{new Notice("OHSidian: "+(on?"进入触屏模式(移动布局)":"返回桌面模式")+(reason?(" ["+reason+"]"):"")+",即将重载…")}catch(e){}
    setTimeout(function(){window.location.reload()},800);
    return true;
  }catch(e){return false}
}
function syncFromSystem(lastWant){
  var cfg=readMode();
  var want=resolveWant(cfg);
  if(want===null)return lastWant;
  if(lastWant===null||want!==lastWant){applyMobile(want,"跟随系统")}
  return want;
}
var lastWant=null;
try{lastWant=syncFromSystem(lastWant)}catch(e){}
applySafeArea();
applyWindowDecor();
hookTrash();
watchBodyStyles();
document.addEventListener("DOMContentLoaded",function(){applySafeArea();applyWindowDecor();hookTrash()});
setInterval(function(){try{lastWant=syncFromSystem(lastWant)}catch(e){}try{applyWindowDecor()}catch(e){}try{hookTrash()}catch(e){}},5000);
/* The touch-mode drawer exposes the vault switcher as a <select> whose
   options are rendered through an engine-native popup. That popup's render
   is filtered by the engine (a blank one-row strip, size 536x61) and its
   options can never be picked, so neither vault switching nor "manage
   vaults" is reachable in touch mode. Intercept taps on that select and
   open the desktop vault chooser window (starter) instead - it routes
   through the working createWindow path. */
function hookVaultSelect(){
  try{
    var handling=false;
    var isVaultSelect=function(el){
      try{
        return !!(el&&el.tagName==="SELECT"&&el.querySelector('option[value="manage-vaults"]'));
      }catch(e){return false}
    };
    var onCapture=function(ev){
      try{
        if(!isVaultSelect(ev.target))return;
        ev.preventDefault();ev.stopPropagation();
        if(handling)return;
        handling=true;
        setTimeout(function(){handling=false},800);
        try{window.app.openVaultChooser()}catch(e){}
      }catch(e){}
    };
    document.addEventListener("touchstart",onCapture,true);
    document.addEventListener("mousedown",onCapture,true);
    document.addEventListener("click",onCapture,true);
  }catch(e){}
}
hookVaultSelect();
var install=function(app){
  if(!app||!app.commands||typeof app.commands.addCommand!=="function")return false;
  try{
    app.commands.addCommand({id:"ohsidian-touch-mode",name:"OHSidian: 切换触屏模式 (自动 → 触摸 → 桌面)",
      callback:function(){
        var cfg=readMode()||{};
        var cur=cfg.override||"auto";
        var next=cur==="auto"?"touch":(cur==="touch"?"desktop":"auto");
        cfg.override=next;
        var saved=true;
        try{require("fs").writeFileSync(dataDir()+MODE_FILE,JSON.stringify(cfg,null,2),"utf8")}catch(e){saved=false}
        var want=resolveWant(cfg);
        var label=next==="auto"?(("系统当前: "+(want?"触摸":"桌面"))):(next==="touch"?"始终触摸":"始终桌面");
        try{new Notice("OHSidian 触屏模式 → "+label+(saved?"":"(写入失败,重启后失效)"))}catch(e){}
        if(want!==null){lastWant=want;applyMobile(want,"手动切换")}
      }});
    return true;
  }catch(e){return false}
};
if(window.app&&install(window.app))return;
var tries=0,timer=setInterval(function(){
  tries++;
  if(window.app&&install(window.app)){clearInterval(timer)}
  else if(tries>120){clearInterval(timer)}
},250);
}catch(e){}})();/*OHSIDIAN-PATCH-END*/
`;

/**
 * IPC guard patch for the asar's main process (main.js):
 * wraps ipcMain.on/handle/... so handlers that touch an already-destroyed
 * BrowserWindow/WebContents (benign shutdown race, e.g. closing a window while
 * a "create/open vault" IPC is in flight) no longer pop the
 * "TypeError: Object has been destroyed" error dialog.
 */
const MAIN_PROCESS_PATCH = `;(function(){try{
/* The closed-source engine reports an old Electron major (e.g. "5.0.0");
   Obsidian 1.13 gates on it twice: main.js refuses to start below 18,
   and the renderer requires >= 28.2.3 (constant Iie in app.js) before it
   stops showing the "manual update" notice. The engine is Chromium 132
   (= Electron 34 era), so report 28.2.3 - above both floors, conservative
   enough not to branch into APIs beyond the renderer's own expectations. */
try{
  var __ohEvVer=String(process.versions&&process.versions.electron||"");
  var __ohEvMajor=parseInt(__ohEvVer.split(".")[0]);
  if(!__ohEvMajor||__ohEvMajor<28){
    /* Replace the whole versions object: mutating the existing object can be
       silently ignored if the engine made it read-only. */
    process.versions=Object.assign({},process.versions,{electron:"28.2.3"});
    try{console.log("[OHSidian] shimmed process.versions.electron "+__ohEvVer+" -> 28.2.3")}catch(e){}
  }
}catch(e){}
var electron=require("electron");
var ipcMain=electron&&electron.ipcMain;
if(ipcMain&&!ipcMain.__ohsidianIpcGuard){
  ipcMain.__ohsidianIpcGuard=true;
  ["on","once","addListener","handle"].forEach(function(method){
    var orig=ipcMain[method];
    if(typeof orig!=="function")return;
    ipcMain[method]=function(channel,listener){
      if(typeof listener!=="function")return orig.call(this,channel,listener);
      var guarded=function(){
        try{return listener.apply(this,arguments)}
        catch(e){
          if(e&&e.message&&e.message.indexOf("Object has been destroyed")!==-1){
            try{console.warn("[OHSidian] suppressed destroyed-object IPC error on '"+channel+"'")}catch(e2){}
            return undefined;
          }
          throw e;
        }
      };
      return orig.call(this,channel,guarded);
    };
  });
}
}catch(e){}})();
/* Deep-link bridge: when the OS hands the running app an obsidian:// link
   (OAuth callbacks, e.g. Remotely Save / 坚果云 browser login), the ArkTS layer
   queues {uri, seq} entries into <userData>/ohsidian-protocol.json. Feed new
   entries (seq > lastDispatchedSeq) into Obsidian's own protocol handling so
   plugin callbacks fire as on desktop. Seq-based, immune to clock changes. */
;(function(){try{
if(globalThis.__ohsidianDeepLink)return;globalThis.__ohsidianDeepLink=true;
var __ohApp=require("electron").app;
setInterval(function(){
  try{
    var p=__ohApp.getPath("userData")+"/ohsidian-protocol.json";
    var fsMod=require("fs");
    if(!fsMod.existsSync(p))return;
    var cfg=JSON.parse(fsMod.readFileSync(p,"utf8"));
    if(!cfg)return;
    var items=cfg.items||[];
    var last=typeof cfg.lastDispatchedSeq==="number"?cfg.lastDispatchedSeq:0;
    var maxDispatched=0;
    for(var i=0;i<items.length;i++){
      var it=items[i];
      if(!it||!it.uri||typeof it.seq!=="number"||it.seq<=last){continue}
      var done=false;var ev={preventDefault:function(){}};
      try{
        var ls=__ohApp.listeners("open-url");
        for(var j=0;j<ls.length;j++){try{ls[j](ev,it.uri);done=true}catch(e){}}
      }catch(e){}
      if(!done){
        try{
          var ls2=__ohApp.listeners("second-instance");
          for(var k=0;k<ls2.length;k++){try{ls2[k](ev,[it.uri]);done=true}catch(e){}}
        }catch(e){}
      }
      if(done){
        if(it.seq>maxDispatched)maxDispatched=it.seq;
        try{console.log("[OHSidian] dispatched deep link:",it.uri)}catch(e){}
      }
    }
    if(maxDispatched>last){
      try{cfg.lastDispatchedSeq=maxDispatched;fsMod.writeFileSync(p,JSON.stringify(cfg),"utf8")}catch(e){}
    }
  }catch(e){}
},1500);
}catch(e){}})();/*OHSIDIAN-IPC-GUARD-END*/
`;

async function main() {
  const repatch = process.argv.includes('--repatch');
  const versionArg = process.argv.slice(2).find(a => a !== '--repatch');
  const currentVersion = readReleaseInfo();
  log(`current Obsidian version: ${currentVersion}`);

  const release = await fetchReleaseJson();
  const targetVersion = versionArg || release.latestVersion;
  log(`target Obsidian version: ${targetVersion}${repatch ? ' (repatch)' : ''}`);

  if (!repatch) {
    if (targetVersion === currentVersion) { log('already up to date'); return; }
    if (!versionArg && !isVersionLess(currentVersion, targetVersion)) {
      log(`local version ${currentVersion} is not older than ${targetVersion}; nothing to do`);
      return;
    }
  }

  const entry = release.beta && versionArg === release.beta.latestVersion ? release.beta : release;
  const { downloadUrl, hash, signature } = entry;
  if (!downloadUrl || !hash || !signature) fail('release entry incomplete');

  fs.mkdirSync(TEMP_DIR, { recursive: true });

  const gzPath = path.join(TEMP_DIR, `obsidian-${targetVersion}.asar.gz`);
  let compressed;
  if (fs.existsSync(gzPath) && fs.statSync(gzPath).size > 1024 * 1024) {
    log('using previously downloaded ' + gzPath);
    compressed = fs.readFileSync(gzPath);
  } else {
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
  if (appSrc.includes(drawerSwitchSrc)) {
    appSrc = appSrc.replace(drawerSwitchSrc, drawerSwitchDst);
    log('vault drawer switch routed to openVaultChooser');
  } else {
    log('WARNING: vault drawer switch site not found (app.js layout changed?); ' +
      'drawer vault switching will silently no-op in touch mode');
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
