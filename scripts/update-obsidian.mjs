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
const TOUCH_MODE_PATCH = `;(function(){try{
if(window.__ohsidianTouchPatch==="15")return;window.__ohsidianTouchPatch="15";
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
/* Atomic mode-file publish (H1): writeFileSync truncates first, so a crash
   (or a concurrent ArkTS reader) could observe an empty/partial file between
   truncate and write. Write the temp file first, then rename over the
   target - rename is atomic on the same filesystem, matching the ArkTS
   side's publishModeFileAtomic. */
function writeModeFileSync(cfg){
  var fsMod=require("fs");
  var dir=dataDir();if(!dir)return false;
  var p=dir+MODE_FILE,tmp=p+".tmp";
  try{
    fsMod.writeFileSync(tmp,JSON.stringify(cfg,null,2),"utf8");
    try{fsMod.renameSync(tmp,p)}catch(eR){
      fsMod.writeFileSync(p,JSON.stringify(cfg,null,2),"utf8");
      try{fsMod.unlinkSync(tmp)}catch(eU){}
    }
    return true;
  }catch(e){return false}
}
/* Round 87 (B2): window geometry lives per window under cfg.windows[<OHOS
   window id>] - concurrent windows used to clobber each other's top-level
   insets within one 200ms poll. The renderer has no OHOS window id (the
   engine exposes no renderer-visible window identity), so it matches its
   own window by SIZE (outerWidth/outerHeight, +-2px): the geometry payload
   (insets/decor) is a pure function of fullscreen-likeness, which the rect
   size encodes - windows of equal size carry equal geometry, so size
   matching is unambiguous. Same-size windows differ only in keyboard
   (follows the focused window), so those are disambiguated by position
   (screenX/screenY) when the engine reports it non-zero. Fallbacks: the
   first size match, the single entry of a one-window session, then the
   main window's legacy top-level fields (pre-B2 shape, still mirrored by
   the main window). Returns null when nothing matches (callers fall back
   to the legacy fields). */
function resolveGeometry(cfg){
  try{
    var wins=cfg&&cfg.windows;
    if(wins&&typeof wins==="object"){
      var keys=Object.keys(wins);
      var entries=[];
      for(var i=0;i<keys.length;i++){
        var e=wins[keys[i]];
        if(e&&typeof e==="object"&&e.w>0&&e.h>0)entries.push(e);
      }
      if(entries.length===1)return entries[0];
      if(entries.length>1){
        var ow=window.outerWidth||0,oh=window.outerHeight||0;
        if(ow>0&&oh>0){
          var bySize=entries.filter(function(q){
            return Math.abs(q.w-ow)<=2&&Math.abs(q.h-oh)<=2;
          });
          if(bySize.length===1)return bySize[0];
          if(bySize.length>1){
            var sx=window.screenX||0,sy=window.screenY||0;
            if(sx!==0||sy!==0){
              var byPos=bySize.filter(function(q){
                return Math.abs(q.l-sx)<=2&&Math.abs(q.t-sy)<=2;
              });
              if(byPos.length===1)return byPos[0];
            }
            return bySize[0];
          }
        }
        return null;
      }
    }
  }catch(e){}
  return null;
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
    var g=resolveGeometry(cfg);
    if(g){
      return {top:+g.insetsTop||0,bottom:+g.insetsBottom||0};
    }
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
    /* NO padding when a system caption strip is up: the engine's viewport
       already follows drawableRect, which excludes the strip (that is the
       whole point of setWindowDecorVisible(true)). Padding here would
       avoid the strip twice and leave a blank band between it and the
       content.
       Round 89: the PRIMARY avoidance for the desktop layout in a
       fullscreen-like window is the ArkTS layer HIDING the system bars
       (setWindowSystemBarEnable([]) - they kept covering content no matter
       how the CSS avoided; bars hidden -> cfg insets are 0 -> this pad
       un-injects and the content fills the window edge to edge). THIS PAD
       IS THE FALLBACK for the case the WMS rejects the hide call: insets
       stay real, and body padding pushes the whole flow (titlebar +
       app-container) below/above the bars while the fixed full-viewport
       float roots (.modal-container, .suggestion-bg) get their own box
       padding. border-box keeps height:100% elements inside the padded
       box. Only applied when the window is fullscreen-like (insets > 0)
       AND desktop layout is active; mobile layout consumes the vars
       itself, and floating windows get insets 0 so this is inert. */
    var cfg=readMode();
    var desktopLayout=!(function(){
      try{return !!(cfg&&resolveWant(cfg))}catch(e){return false}
    })();
    /* viewportAvoidsBars is retired (round 87, B1): the engine never
       subtracts the bars anymore, so the ArkTS layer writes a constant
       false. The field is still honored so a stale true left by an older
       build converges (the ArkTS writer overwrites it) instead of
       suppressing the pad forever. */
    var alreadyAvoids=!!(cfg&&cfg.viewportAvoidsBars);
    var pad=desktopLayout&&!alreadyAvoids&&(ins.top>0||ins.bottom>0);
    var SID="ohsidian-desktop-safe-pad";
    var el=document.getElementById(SID);
    if(pad&&!el&&document.head){
      el=document.createElement("style");
      el.id=SID;
      el.textContent=".modal-container{padding-top:var(--safe-area-inset-top)!important;"+
        "padding-bottom:var(--safe-area-inset-bottom)!important;box-sizing:border-box}"+
        ".suggestion-bg{padding-top:var(--safe-area-inset-top)!important;"+
        "padding-bottom:var(--safe-area-inset-bottom)!important;box-sizing:border-box}";
      document.head.appendChild(el);
    }else if(!pad&&el&&el.parentNode){
      el.parentNode.removeChild(el);
    }
    /* Only touch the body padding we set ourselves (dataset marker): the
       MutationObserver re-runs this on every body style mutation, and
       removing a padding Obsidian set would corrupt its layout. */
    if(pad){
      if(b.style.getPropertyValue("padding-top")!==ins.top+"px"){
        b.style.setProperty("padding-top",ins.top+"px","important");
      }
      if(b.style.getPropertyValue("padding-bottom")!==ins.bottom+"px"){
        b.style.setProperty("padding-bottom",ins.bottom+"px","important");
      }
      if(b.style.getPropertyValue("box-sizing")!=="border-box"){
        b.style.setProperty("box-sizing","border-box","important");
      }
      b.setAttribute("data-ohsidian-pad","1");
    }else if(b.getAttribute("data-ohsidian-pad")){
      b.style.removeProperty("padding-top");
      b.style.removeProperty("padding-bottom");
      b.style.removeProperty("box-sizing");
      b.removeAttribute("data-ohsidian-pad");
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
/* Tablet PC mode / free windows: the system caption strip (name + window
   buttons) is the only title bar that exists in every web layout, so the
   ArkTS layer keeps it visible. Obsidian's own desktop .titlebar would be
   a second bar under it, so hide the whole web bar while the system one
   is up. Fullscreen publishes decor "none" - no caption, no hiding.
   (cfg.caption is gone - round 87 C3: it never had a consumer.) */
var DECOR_STYLE_ID="ohsidian-window-decor";
function applyWindowDecor(){
  try{
    var cfg=readMode();
    var g=resolveGeometry(cfg);
    var system=!!(g?(g.decor==="system"):(cfg&&cfg.windowDecor==="system"));
    var el=document.getElementById(DECOR_STYLE_ID);
    if(system&&!el&&document.head){
      el=document.createElement("style");
      el.id=DECOR_STYLE_ID;
      el.textContent=".titlebar{display:none!important}";
      document.head.appendChild(el);
    }else if(!system&&el){
      if(el.parentNode){el.parentNode.removeChild(el)}
    }
  }catch(e){}
}
/* System font STYLE following (设置 → 显示与字体 → 字体样式). The
   decisive fact from device logs (round 67): when the user picks a style
   font, the system loads its ttf and registers it into the process text
   engine under the FIXED family name "OhosThemeFont" (RegisterTypeface
   family name: OhosThemeFont, shared memory) - NOT the font's original
   family name. So following the system style in CSS simply means putting
   "OhosThemeFont" first in the default stack; when no theme font is set
   it does not resolve and the stack falls through to HarmonyOS Sans.
   cfg.fontId (via ApplicationContext.onSystemConfigurationUpdated/
   onFontIdUpdated) still marks WHEN the style changed, and the STYLISH
   mapping/probe remain only as a diagnostic label for the cycle command.
   User-chosen fonts (--font-*-override via Obsidian settings or the
   cycle command) still win over this. */
var FONT_STYLE_ID="ohsidian-system-fonts";
var lastAppliedStack=null;
function styleFontFamilyFromCfg(cfg){
  try{
    if(!cfg||typeof cfg.fontId!=="string"||!cfg.fontId)return null;
    if(cfg.styleFonts){
      var list=JSON.parse(cfg.styleFonts);
      if(Array.isArray(list)){
        for(var i=0;i<list.length;i++){
          if(list[i]&&list[i].id===cfg.fontId&&list[i].family)return list[i].family;
        }
      }
    }
  }catch(e){}
  return null;
}
/* The theme font is registered by ArkUI's text engine (TexGine) at runtime
   and is NOT visible to the web engine's Skia font manager (which reads the
   static system font config) - CSS "OhosThemeFont" alone never resolved.
   Bridge it: ArkTS reads the active theme's font manifest from
   /data/themes/a|b/app/fonts (the same file ArkUI itself renders with -
   the public font enumeration APIs never expose it), copies the ttf into
   the app sandbox and publishes cfg.themeFontPath; here we read the bytes
   with Node (same mechanism as the mode file) and register a real FontFace
   named OhosThemeFont, which the CSS stack then resolves. Cached per path;
   an EMPTY path resets to the plain HarmonyOS Sans stack. */
var themeFontLoadedPath=null,failedThemePaths={};
/* F-N1: monotonically increasing request token. Two applyThemeFontFace runs
   may overlap when the style font flips twice within one 200ms poll - the
   first load's ok callback then fires AFTER the second request started and
   add()ed a SECOND OhosThemeFont face (CSS resolves a family to the first
   matching face, so the old font kept winning). The token invalidates the
   stale callback. */
var themeFontRequestSeq=0;
function applyThemeFontFace(cfg){
  try{
    var p=cfg&&cfg.themeFontPath;
    if(!p){
      /* Empty path = the style font was reset to default. Drop the stale
         face so the default stack falls through to HarmonyOS Sans again
         (previously the last theme font kept winning forever). Bump the
         request token too: a load still in flight would otherwise re-add
         its face AFTER this reset (round-94 self-audit). */
      themeFontRequestSeq++;
      if(themeFontLoadedPath){
        try{
          var stale=[];
          document.fonts.forEach(function(f){if(f.family==="OhosThemeFont")stale.push(f)});
          for(var di=0;di<stale.length;di++){try{document.fonts.delete(stale[di])}catch(de2){}}
        }catch(de1){}
        themeFontLoadedPath=null;lastAppliedStack=null;
      }
      return;
    }
    if(p===themeFontLoadedPath)return;
    /* A path whose stat/read/load once failed is never retried: the poll
       re-runs this every 200ms and a dead file (e.g. the stub the system
       publishes for the DEFAULT style) would be hammered forever. A real
       font switch always arrives under a NEW path (per-font copy names),
       so caching per path never blocks a legitimate load. */
    if(failedThemePaths[p])return;
    /* Remove stale faces first: FontFaceSet resolves a family to the
       FIRST matching face - without cleanup an old theme font keeps
       winning after the user switches (the reported "切换无效"). */
    try{
      var stale=[];
      document.fonts.forEach(function(f){if(f.family==="OhosThemeFont")stale.push(f)});
      for(var si=0;si<stale.length;si++){try{document.fonts.delete(stale[si])}catch(se){}}
    }catch(e0){}
    var fsMod=require("fs");
    var st=null;
    try{st=fsMod.statSync(p)}catch(se){
      console.warn("[OHSidian] themeFontPath stat failed:",p,String(se&&se.message||se));
      failedThemePaths[p]=1;
      return;
    }
    if(!st||!st.size){console.warn("[OHSidian] themeFontPath empty file:",p);failedThemePaths[p]=1;return}
    var buf;
    try{buf=fsMod.readFileSync(p)}catch(re){
      console.warn("[OHSidian] themeFontPath read failed (EACCES?):",p,String(re&&re.message||re));
      failedThemePaths[p]=1;
      return;
    }
    if(!buf||!buf.length||typeof FontFace!=="function"){console.warn("[OHSidian] themeFontPath unreadable bytes:",p);failedThemePaths[p]=1;return}
    var ff=new FontFace("OhosThemeFont",buf.buffer.slice(buf.byteOffset,buf.byteOffset+buf.byteLength));
    var reqSeq=++themeFontRequestSeq;
    var ok=function(f){
      if(reqSeq!==themeFontRequestSeq)return; /* superseded by a newer request */
      try{document.fonts.add(f)}catch(e){}
      themeFontLoadedPath=p;lastAppliedStack=null;applySystemFonts();
    };
    var bad=function(err){
      console.warn("[OHSidian] theme FontFace load rejected:",p,String(err&&err.message||err));
      failedThemePaths[p]=1;
      if(reqSeq!==themeFontRequestSeq)return; /* a newer request owns the state */
      themeFontLoadedPath=null;
    };
    var pr=ff.load();
    if(pr&&pr.then){pr.then(ok,bad)}else{ok(ff)}
  }catch(e){
    try{console.warn("[OHSidian] applyThemeFontFace error",String(e&&e.message||e))}catch(e2){}
  }
}
function applySystemFonts(){
  try{
    var cfg=readMode();
    applyThemeFontFace(cfg);
    var mapped=styleFontFamilyFromCfg(cfg); /* diagnostic only */
    /* OhosThemeFont first: resolves to the user's style font when one is
       active; silently falls through when it is not. */
    var stack='"OhosThemeFont","HarmonyOS Sans","HarmonyOS Sans SC","HarmonyOS Sans TC",ui-sans-serif,-apple-system,BlinkMacSystemFont,system-ui,"Segoe UI",Roboto,sans-serif;';
    if(stack===lastAppliedStack&&document.getElementById(FONT_STYLE_ID))return;
    lastAppliedStack=stack;
    var el=document.getElementById(FONT_STYLE_ID);
    if(!el&&document.head){
      el=document.createElement("style");
      el.id=FONT_STYLE_ID;
      document.head.appendChild(el);
    }
    /* Obsidian's app.css declares --font-default ON BODY - a :root-only
       rule is shadowed for everything inside body (the whole UI), which is
       why the OhosThemeFont stack never applied (round 74 device report).
       Declare on both html and body, and !important so the injected <style>
       wins regardless of its position relative to the app.css <link> (the
       script evaluates before the head may have finished parsing) and any
       later-injected theme styles. Obsidian's user font pick lives in the
       SEPARATE --font-interface-override inline var, so nothing collides. */
    if(el){el.textContent=":root,body{--font-default:"+stack+"!important}"}
  }catch(e){}
}
/* Pure event-driven keyboard handling (docs/window-state-machine.md §7).
   The ArkTS layer publishes the keyboard height (css px) as cfg.keyboard on
   EVERY keyboardHeightChange - each change writes the mode file. The
   renderer consumes pushes only: when the changed-file poll observes a new
   height it updates --keyboard-height and dispatches the corresponding
   event once. No keyboard-specific polling ladder exists. (Fallback for
   event-less IMEs, e.g. secure keyboards, belongs in the ArkTS layer.) */
var lastKeyboard=-1;
function applyKeyboard(){
  try{
    var cfg=readMode();
    var g=resolveGeometry(cfg);
    var kb=0;
    if(g){kb=+g.keyboard||0}
    else{kb=(cfg&&+cfg.keyboard)||0}
    if(kb===lastKeyboard)return;
    lastKeyboard=kb;
    var de=document.documentElement;
    if(de){de.style.setProperty("--keyboard-height",kb+"px")}
    try{window.dispatchEvent(new Event(kb>0?"keyboardWillShow":"keyboardWillHide"))}catch(e){}
  }catch(e){}
}
/* System font-size scale (HarmonyOS 设置 → 显示与字体 → 字体大小). The
   framework scales native fp text but the web content never sees the
   factor, so the ArkTS layer publishes cfg.fontScale and we apply it.
   Round 59 redesign: the previous approach rewrote --font-text-size /
   html font-size inline, but Obsidian's own updateFontSize() rewrites
   BOTH on every css-change (baseFontSize setting, theme load, plugin
   css) - the scaled value got clobbered immediately, which is why "字体
   还是不生效". Now we drive the ENGINE zoom instead:
   webFrame.setZoomFactor(scale) multiplies the whole page (UI + text),
   cannot be clobbered from CSS, and mirrors how system font scale feels
   on phones. User zoom (设置→缩放 slider, window:zoom-in commands) still
   composes: Obsidian stores its own zoom level; we multiply only while
   fontScale != 1 and restore 1 when neutral. */
var lastFontScale=-1;
function applyFontScale(){
  try{
    var cfg=readMode();
    /* effective scale: explicit user override (command) wins, else the
       system-published factor, else neutral 1 */
    var sc=cfg&&cfg.fontScaleOverride!==undefined?(+cfg.fontScaleOverride||1):(cfg&&+cfg.fontScale)||1;
    if(!(sc>0))sc=1;
    sc=Math.min(3.2,Math.max(0.5,sc));
    if(sc===lastFontScale)return;
    lastFontScale=sc;
    var applied=false;
    try{
      var wf=window.electron&&window.electron.webFrame;
      if(wf&&typeof wf.setZoomFactor==="function"){wf.setZoomFactor(sc);applied=true}
      else if(window.electronWindow&&typeof window.electronWindow.setFrameZoomLevel==="function"){
        window.electronWindow.setFrameZoomLevel(Math.log(sc)/Math.log(1.2));applied=true;
      }
    }catch(e){}
    if(!applied){
      /* fallback: CSS override (can be clobbered by Obsidian's own font
         updates, better than nothing on engines without webFrame) */
      var v=window.app&&window.app.vault;
      var base=16;
      try{base=v.getConfig("baseFontSize")||16}catch(e){}
      if(typeof base!=="number"||!(base>0))base=16;
      var scaled=Math.min(base*3.2,Math.max(base*0.5,Math.round(base*sc*100)/100));
      var de=document.documentElement;
      if(de){de.style.setProperty("font-size",scaled+"px")}
      if(document.body){document.body.style.setProperty("--font-text-size",scaled+"px")}
    }
  }catch(e){}
}
/* Single mode-file consumer: re-reads the file every 200ms and re-applies
   every publisher (safe area / mode switch / decor / trash / keyboard /
   font scale / system fonts) ONLY when the file content changed - one small
   readFileSync per tick, no work and no event spam when nothing moved. The
   ArkTS side writes on every keyboardHeightChange / fontScale change, so
   consumers follow within one tick without dedicated polling ladders. */
var modePollMs=200,lastModeRaw=null;
function pollTick(){
  try{
    if(document.hidden){
      /* Hidden windows skip the read entirely; visibilitychange resumes the
         loop, which re-checks immediately so nothing is missed while away.
         (Protocol deep-link polling in the main process stays on - OAuth
         callbacks arrive exactly while the app is backgrounded.) */
    }else{
      var dir=dataDir();
      if(dir){
        var txt=require("fs").readFileSync(dir+MODE_FILE,"utf8");
        if(txt!==lastModeRaw){
          lastModeRaw=txt;
          try{lastWant=syncFromSystem(lastWant)}catch(e){}
          /* Rotation / bar changes rewrite cfg.insets without touching
             systemMode - re-apply the safe area on every change too. */
          try{applySafeArea()}catch(e){}
          try{applyWindowDecor()}catch(e){}
          try{hookTrash()}catch(e){}
          try{applyKeyboard()}catch(e){}
          try{applyFontScale()}catch(e){}
          try{refreshSystemFontGlobals()}catch(e){}
          try{applyThemeFontFace(readMode())}catch(e){}
          try{applySystemFonts()}catch(e){}
        }
      }
    }
  }catch(e){}
  setTimeout(pollTick,modePollMs);
}
document.addEventListener("visibilitychange",function(){
  if(!document.hidden){lastModeRaw=null}
});
/* Bug 1 (HEVC, 2026-10-02 user report): the engine bundles the standard
   open-source Chromium ffmpeg - NO HEVC/H.265 (and some patent-pool audio)
   decoders - and the closed-source engine exposes no HarmonyOS MediaCodec
   bridge into the web <video> element, so locally recorded HEVC clips fail
   to play (the web build works because browsers call the OS codecs). The
   decoder cannot be added from this repo (libffmpeg/libelectron are closed
   binaries). What CAN be done is to say so at the exact moment the user
   hits it: capture media error events (code 3 = decode, 4 = source not
   supported - precisely the "no decoder" family), resolve the vault file
   behind the embed, and offer "open with the system player" through the
   engine's shell.openPath when that exists (feature-detected; the
   openExternal ArkTS path cannot help - its scheme allowlist blocks file://
   by design). Load/network errors (1/2) stay quiet. */
var __ohsidianMediaNotices=0;
function ohsidianResolveMediaPath(el){
  try{
    var v=window.app&&window.app.vault;
    if(v){
      /* Internal embeds: the container carries the vault-relative src. */
      var host=el&&el.closest?el.closest(".internal-embed"):null;
      var rel=host&&host.getAttribute?host.getAttribute("src"):"";
      if(rel&&typeof v.getAbstractFileByPath==="function"){
        var f=null;
        try{f=v.getAbstractFileByPath(rel)}catch(e0){}
        if(f&&v.adapter&&typeof v.adapter.getFullPath==="function"){
          try{return v.adapter.getFullPath(f.path)}catch(e1){}
        }
      }
    }
    var src=(el&&el.currentSrc)||(el&&el.src)||"";
    if(src.indexOf("file://")===0){
      var raw=src.substring("file://".length);
      try{return decodeURIComponent(raw)}catch(e2){return raw}
    }
  }catch(e){}
  return null;
}
function ohsidianOfferSystemPlayer(el){
  try{
    if(__ohsidianMediaNotices>=5)return;
    __ohsidianMediaNotices++;
    var p=ohsidianResolveMediaPath(el);
    var openFn=null;
    if(p){
      try{
        var remote=require("@electron/remote");
        if(remote&&remote.shell&&typeof remote.shell.openPath==="function"){
          openFn=function(){try{remote.shell.openPath(p)}catch(e1){}};
        }
      }catch(eR){}
    }
    var zh=true;
    try{var l=localStorage.getItem("language");if(l&&/^en/i.test(l))zh=false}catch(eL){}
    var msg=zh
      ?"OHSidian: 此视频/音频编码可能不受支持(常见于 HEVC/H.265 录制,内置解码器不含专有格式)。建议转码为 H.264/MP4 后重新插入。"
      :"OHSidian: This media codec is likely unsupported (HEVC/H.265 recordings; the bundled decoder ships no proprietary codecs). Transcode to H.264/MP4 and re-embed.";
    var n=new Notice(msg,openFn?12000:6000);
    if(openFn&&n&&n.noticeEl){
      var btn=document.createElement("button");
      btn.className="mod-cta";
      btn.textContent=zh?"用系统播放器打开":"Open with system player";
      btn.style.marginTop="6px";
      btn.addEventListener("click",function(){try{openFn()}catch(e2){}try{n.hide()}catch(e3){}});
      n.noticeEl.appendChild(btn);
    }
  }catch(e){}
}
document.addEventListener("error",function(ev){
  try{
    var el=ev.target;
    if(!el||!el.tagName)return;
    var tag=el.tagName.toUpperCase();
    if(tag!=="VIDEO"&&tag!=="AUDIO")return;
    var code=el.error?el.error.code:0;
    if(code!==3&&code!==4)return;
    if(el.__ohsidianMediaNoticed)return;
    el.__ohsidianMediaNoticed=true;
    ohsidianOfferSystemPlayer(el);
  }catch(e){}
},true);
/* Delete-dialog destination note, called from the patched dialog site
   (see APP_BODY_PATCHES). Reflects where the trash hook will actually put
   the file: the relocated Documents trash when cfg.documentsDir is
   granted, the hidden in-vault .trash otherwise - both auto-purged after
   30 days. Language follows Obsidian's localStorage language setting
   (zh default on this port); null falls back to the stock notice. */
window.__ohsidianTrashNote=function(){
  try{
    var cfg=readMode();
    var docs=cfg&&typeof cfg.documentsDir==="string"&&cfg.documentsDir;
    var v=window.app&&window.app.vault;
    var name=(v&&typeof v.getName==="function"&&v.getName())||"vault";
    var lang="zh";
    try{var l=localStorage.getItem("language");if(l&&/^en/i.test(l))lang="en"}catch(eL){}
    if(docs)return "zh"===lang
      ?"文件将移至 文档/OHSidianTrash/"+name+"/，30 天后自动清除。"
      :"Moved to Documents/OHSidianTrash/"+name+"/; auto-purged after 30 days.";
    return "zh"===lang
      ?"未授权文档目录：文件将移至仓库内 .trash（文件管理不可见），30 天后自动清除。"
      :"Documents permission not granted: moved to the vault's hidden .trash; auto-purged after 30 days.";
  }catch(e){return null}
};
/* Deletion safety net + trash relocation. vault.trash(file, system) dispatches to
   adapter.trashSystem (engine bridge; HarmonyOS has no recycle-bin API for
   apps, so it may fail silently or unlink the file outright) or to
   adapter.trashLocal (pure-JS: mkdir .trash + rename, works everywhere).
   Force the local branch and make getConfig("trashOption") report "local"
   so Obsidian's own delete dialog labels the action correctly.
   OHSidian additionally RELOCATES the local trash into the user-visible
   Documents dir (<cfg.documentsDir>/OHSidianTrash/<vault>/<relPath>): a
   vault-local ".trash" is a dot-folder that 文件管理 never shows. Only the
   fs move is replaced - vault.trash still owns the index update, and any
   failure falls back to the stock trashLocal. */
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
    /* Redirect the LOCAL trash into Documents. trashLocal receives a
       vault-relative path and must resolve only after the file has moved
       (vault.trash updates its index once the promise resolves). */
    var ad=v.adapter;
    if(ad&&typeof ad.trashLocal==="function"&&!ad.__ohsidianTrashRelocate){
      ad.__ohsidianTrashRelocate=true;
      var origLocal=ad.trashLocal;
      ad.trashLocal=function(rel){
        try{
          var base=typeof ad.getBasePath==="function"?ad.getBasePath():(ad.basePath||"");
          var cfg=readMode();
          var docs=cfg&&typeof cfg.documentsDir==="string"?cfg.documentsDir:"";
          if(!base||!docs||!rel||!rel.trim())return origLocal.call(ad,rel);
          var pathMod=require("path"),fsMod=require("fs");
          var name=(typeof v.getName==="function"&&v.getName())||pathMod.basename(base);
          name=String(name).replace(/[\\\/:*?\"<>|]/g,"_").replace(/^\.+$/,"_")||"vault";
          var src=pathMod.join(base,rel);
          if(!fsMod.existsSync(src))return origLocal.call(ad,rel);
          /* S2: canonicalize and confine. rel comes from vault.trash
             (normalized), but a plugin can call adapter.trashLocal directly
             with ".." segments; unchecked, pathMod.join would resolve them
             OUTSIDE the trash root and scatter files across Documents. The
             containment check anchors on trashRoot/<vault> (NOT trashRoot):
             rel=".." would resolve to exactly trashRoot and pass a
             root-anchored check, while src=join(base,"..") renamed the
             vault's PARENT directory into the trash. Strict containment
             also rejects rel="." (degenerate) - both fall back to the
             stock trashLocal. */
          var trashRoot=pathMod.resolve(docs,"OHSidianTrash");
          var targetRoot=pathMod.resolve(trashRoot,name);
          var resolvedTrash=pathMod.resolve(targetRoot,rel);
          if(resolvedTrash.indexOf(targetRoot+pathMod.sep)!==0){
            try{console.warn("[OHSidian] trash relocate refused escaping path, local fallback:",rel)}catch(eW){}
            return origLocal.call(ad,rel);
          }
          var destDir=pathMod.join(targetRoot,pathMod.dirname(rel));
          fsMod.mkdirSync(destDir,{recursive:true});
          var ext=pathMod.extname(src);
          var stem=pathMod.basename(src,ext);
          var dest=pathMod.join(destDir,stem+ext);
          for(var n=2;fsMod.existsSync(dest);n++){
            dest=pathMod.join(destDir,stem+" ("+n+")"+ext);
          }
          fsMod.renameSync(src,dest);
          /* Stamp deletion time: rename keeps the old mtime, and the purge
             measures age in the trash by mtime. F2: when utimesSync fails
             (readonly FS, SELinux denial) the moved file keeps its ORIGINAL
             mtime - a years-old note deleted today would be purged on the
             next startup, losing the 30-day recovery window. Record the
             deletion time in a sidecar the purge prefers over mtime. */
          try{var now=new Date();fsMod.utimesSync(dest,now,now)}
          catch(eU){
            try{console.warn("[OHSidian] utimesSync failed, writing trash meta:",eU&&eU.message||eU)}catch(eW2){}
            try{fsMod.writeFileSync(dest+".ohsidian-trash-meta.json",JSON.stringify({deletedAt:Date.now()}),"utf8")}catch(eM){}
          }
          return Promise.resolve();
        }catch(e){
          try{console.warn("[OHSidian] trash relocate failed, local fallback:",e&&e.message||e)}catch(e2){}
          return origLocal.call(ad,rel);
        }
      };
    }
    if(typeof v.getConfig==="function"){
      var origGetConfig=v.getConfig;
      v.getConfig=function(key){
        if(key==="trashOption")return "local";
        return origGetConfig.apply(this,arguments);
      };
    }
  }catch(e){}
}
/* Stock Obsidian keeps TWO separate workspace layouts:
   .obsidian/workspace.json (desktop) and .obsidian/workspace-mobile.json
   (emulated mobile). Toggling EmulateMobile reloads into the OTHER file:
   loadLayout -> setLayout restores THAT file's leaf nodes, each markdown
   leaf carrying {state:{type:"markdown",state:{file}}} and re-opening the
   file stored there (view.setState reads state.file -> loadFile). So after
   a touch<->window switch the reopened article is whatever the other
   layout last had - the reported "the article changes when switching".
   lastOpenFiles alone is useless here: it is consulted only when the
   layout has NO main split. The fix walks the TARGET layout's leaf nodes
   and rewrites the markdown view of the leaf that is marked active (falls
   back to the first markdown leaf) to the file currently being read, so
   both modes reopen the same article while keeping their own layout
   structure. Leaves that reference the same file keep working; a missing
   target layout file leaves nothing to rewrite (first switch, layout will
   be built fresh and empty-main fallback opens lastOpenFiles[0], which we
   also set). */
function syncActiveFileToTargetLayout(on,done){
  /* settle() fires exactly once, after every write chain finished (or on an
     early return with nothing to write). The caller reloads on it: a fixed
     800ms timer raced slow storage and reloaded onto the stale layout. */
  var settled=false;
  var settle=function(){if(!settled){settled=true;if(done)done()}};
  var awaitWrite=function(w){
    /* H18: a rejected write (disk full, EACCES) still settles - the reload
       keeps the mode-switch UX - but the failure is logged instead of being
       swallowed: the reload then reopens the stale layout's active file. */
    if(w&&typeof w.then==="function"){
      w.then(settle,function(e){
        try{console.warn("[OHSidian] target layout write failed, reloading anyway:",e&&e.message||e)}catch(e2){}
        settle();
      });
    }
    else{settle()}
  };
  try{
    var v=window.app&&window.app.vault;
    if(!v||!v.adapter||!v.configDir){settle();return}
    var active=null;
    try{active=window.app.workspace.getActiveFile()}catch(e){}
    if(!active||!active.path){settle();return}
    var target=on?"workspace-mobile.json":"workspace.json";
    var p=v.configDir+"/"+target;
    var rewriteLeaves=function(node){
      /* returns number of markdown leaves rewritten */
      var changed=0;
      if(!node||typeof node!=="object")return 0;
      if(node.type==="leaf"){
        var st=node.state;
        if(st&&st.type==="markdown"&&st.state&&typeof st.state==="object"){
          st.state.file=active.path;
          changed++;
        }
        return changed;
      }
      var kids=node.children;
      if(Array.isArray(kids)){
        for(var i=0;i<kids.length;i++){changed+=rewriteLeaves(kids[i])}
      }
      return changed;
    };
    var finish=function(layout){
      try{
        if(!layout||typeof layout!=="object")return;
        /* 1) point the active markdown leaf (or the first one) at the file */
        var touched=0;
        var mark=function(node){
          if(touched||!node||typeof node!=="object")return;
          if(node.type==="leaf"){
            var st=node.state;
            if(st&&st.type==="markdown"&&st.state&&typeof st.state==="object"){
              st.state.file=active.path;
              touched++;
            }
            return;
          }
          var kids=node.children;
          if(Array.isArray(kids)){for(var i=0;i<kids.length;i++)mark(kids[i])}
        };
        if(layout.active!=null){
          /* walk the whole tree, but only rewrite the node whose id matches
             the active leaf; fall back to first markdown leaf below */
          var visit=function(node){
            if(!node||typeof node!=="object")return;
            if(node.type==="leaf"&&node.id===layout.active){
              var st=node.state;
              if(st&&st.type==="markdown"&&st.state&&typeof st.state==="object"){
                st.state.file=active.path;
                touched++;
              }
              return;
            }
            var kids=node.children;
            if(Array.isArray(kids)){for(var i=0;i<kids.length;i++)visit(kids[i])}
          };
          ["main","left","right","floating"].forEach(function(k){
            if(layout[k])visit(layout[k]);
          });
        }
        if(!touched){
          ["main","left","right","floating"].forEach(function(k){
            if(layout[k]&&!touched)touched+=rewriteLeaves(layout[k]);
          });
        }
        /* 2) also head the recent list for the empty-layout first-switch case */
        var list=(layout.lastOpenFiles&&layout.lastOpenFiles.length)?layout.lastOpenFiles:[];
        list=list.filter(function(x){return x!==active.path});
        list.unshift(active.path);
        layout.lastOpenFiles=list.slice(0,26);
        return v.adapter.write(p,JSON.stringify(layout,null,2));
      }catch(e){}
    };
    v.adapter.read(p).then(function(txt){
      var layout=null;
      try{layout=txt?JSON.parse(txt):null}catch(e){}
      awaitWrite(finish(layout));
    },function(){/* target file missing: first switch. Seed a minimal
      layout marker so the empty-main fallback opens the right file. */
      try{
        var seed={lastOpenFiles:[active.path]};
        awaitWrite(v.adapter.write(p,JSON.stringify(seed,null,2)));
      }catch(e){settle()}
    });
  }catch(e){settle()}
}
function applyMobile(on,reason){
  try{
    var cur=!!localStorage.getItem(KEY);
    if(cur===on){applySafeArea();return false}
    /* Reload only after the target layout write settled - see
       syncActiveFileToTargetLayout. Mode flag + notice go out immediately. */
    syncActiveFileToTargetLayout(on,function(){window.location.reload()});
    if(on)localStorage.setItem(KEY,"1");else localStorage.removeItem(KEY);
    try{new Notice("OHSidian: "+(on?"进入触屏模式(移动布局)":"返回桌面模式")+(reason?(" ["+reason+"]"):"")+",即将重载…")}catch(e){}
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
/* Full system family list for Obsidian's settings font picker (injected
   into its candidate array by a body patch). Obsidian's own availability
   probe (app.js _ne/Wne) measures "abcdefghijklmnopqrstuvwxyz0123456789"
   and reports 系统中不存在此字体 when the width does not change - which is
   ALWAYS the case for symbol/emoji fonts (HM Symbol, HMOS Color Emoji
   Flags: no Latin glyphs at all, so selecting them is useless and only
   produces the warning). Mirror that exact probe here and filter such
   families OUT of the picker list: a font that would fail Obsidian's
   check is simply not offered (round 80, user request). */
var FONT_PROBE_SAMPLE="abcdefghijklmnopqrstuvwxyz0123456789";
function refreshSystemFontGlobals(){
  try{
    var c=readMode();
    if(c&&c.systemFonts){
      try{window.__ohsidianSystemFontsRaw=JSON.parse(c.systemFonts)}catch(e1){window.__ohsidianSystemFontsRaw=null}
    }
    if(!window.__ohsidianFontUsable)window.__ohsidianFontUsable={};
    if(!window.__ohsidianFontBridge)window.__ohsidianFontBridge={};
    var recompute=function(){
      var raw=window.__ohsidianSystemFontsRaw||[],list=[];
      for(var i=0;i<raw.length;i++){
        var f=raw[i];
        if(window.__ohsidianFontUsable[f]===false)continue;
        list.push(f);
      }
      window.__ohsidianSystemFonts=list;
    };
    recompute();
    if(c&&c.fontFiles){
      var map;try{map=JSON.parse(c.fontFiles)}catch(e){map=null}
      if(Array.isArray(map)&&map.length){
        var cv=document.createElement("canvas"),cx=cv.getContext("2d");
        var base=0;
        if(cx){cx.font="48px serif";base=cx.measureText(FONT_PROBE_SAMPLE).width}
        var usable=function(fam){
          if(!cx)return true;
          try{
            cx.font='48px "'+fam+'", serif';
            return cx.measureText(FONT_PROBE_SAMPLE).width!==base;
          }catch(e){return true}
        };
        var done=0,pending=0,dirty=false;
        var mark=function(fam,ok){window.__ohsidianFontUsable[fam]=ok;dirty=true};
        var flush=function(){if(dirty){dirty=false;recompute()}};
        for(var i=0;i<map.length&&done<400;i++){
          var fam=map[i]&&map[i].f,fp=map[i]&&map[i].p;
          if(!fam||!fp)continue;
          if(fp.indexOf('/system/fonts/')===0){
            /* /system fonts: Skia resolves them natively - no FontFace
               needed. Probe once (cached): no Latin coverage -> excluded
               from the picker (symbol/emoji fonts). */
            if(window.__ohsidianFontUsable[fam]===undefined){
              mark(fam,usable(fam));
            }
            done++;continue;
          }
          /* Sandbox-copied style/theme fonts: Skia does not see them, so
             load the FontFace unconditionally (a probe BEFORE the load
             would always say "unresolved" and the face would never
             register), then probe AFTER the load to decide picker
             visibility. */
          if(window.__ohsidianFontBridge[fam]!==undefined){
            continue; /* handled in an earlier refresh */
          }
          window.__ohsidianFontBridge[fam]=null;
          try{
            var buf=require("fs").readFileSync(fp);
            if(!buf||!buf.length||typeof FontFace!=="function"){
              console.warn("[OHSidian] font bridge unusable file:",fam,fp);
              mark(fam,false);done++;continue
            }
            var ff=new FontFace(fam,buf.buffer.slice(buf.byteOffset,buf.byteOffset+buf.byteLength));
            pending++;
            (function(fam2,fp2,face){
              face.load().then(function(f){
                  try{document.fonts.add(f)}catch(e){}
                  mark(fam2,usable(fam2));
                },
                function(err){console.warn("[OHSidian] font bridge load rejected:",fam2,fp2,String(err&&err.message||err));mark(fam2,false);})
                .then(function(){pending--;if(pending<=0){lastAppliedStack=null;flush()}});
            })(fam,fp,ff);
            done++;
          }catch(e){
            console.warn("[OHSidian] font bridge read failed:",fam,fp,String(e&&e.message||e));
            mark(fam,false);done++
          }
        }
        flush();
      }
    }
  }catch(e){}
}
refreshSystemFontGlobals();
applySafeArea();
applyWindowDecor();
applySystemFonts();
hookTrash();
applyKeyboard();
watchBodyStyles();
document.addEventListener("DOMContentLoaded",function(){applySafeArea();applyWindowDecor();applySystemFonts();hookTrash();applyKeyboard()});
pollTick();
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
/* Migrate the current vault into a user-visible folder: HarmonyOS sandboxes
   app files, so a vault inside userData (the quick-start default) and its
   .trash can never be reached from 文件管理 or a PC. There is no API to
   expose a sandbox directory to the system browser (fileShare only grants
   access to specific apps); the system folder picker (DocumentViewPicker
   FOLDER mode + FILE_ACCESS_PERSIST, wired through the engine's
   showOpenDialog) grants access to real user storage instead. Copy every
   file of the current vault there - including .trash - then open the copy. */
function migrateVaultToVisibleFolder(){
  try{
    var v=window.app&&window.app.vault;
    if(!v){try{new Notice("OHSidian: 仓库未就绪")}catch(e){}return}
    /* If the current vault lives in the app sandbox (userData, wiped on
       uninstall) and the Documents root is available, offer the ONE-TAP
       default migration: copy to <documents>/OHSidian/<当前仓库名> and
       reopen. Otherwise fall back to the directory picker. */
    var remote=require("@electron/remote");
    if(!remote||!remote.dialog){try{new Notice("OHSidian: 无法调起文件夹选择器")}catch(e){}return}
    var pickMigration=function(){remote.dialog.showOpenDialog({
      properties:["openDirectory","createDirectory"],
      buttonLabel:"迁移仓库到这里"
    }).then(function(res){
      try{
        if(!res||!res.filePaths||!res.filePaths.length)return;
        var target=res.filePaths[0];
        var fsMod=require("fs"),pathMod=require("path");
        var srcDir;
        try{srcDir=v.adapter.getFullPath("/")}catch(e){}
        if(!srcDir){try{new Notice("OHSidian: 无法定位仓库根目录")}catch(e){}return}
        /* copyDir(s,d) with s inside d (or equal) would recurse into the
           partially-copied tree and never terminate */
        var norm=function(p){try{return pathMod.resolve(p)}catch(e){return p}};
        if(norm(target)===norm(srcDir)||norm(target).indexOf(norm(srcDir)+pathMod.sep)===0){
          try{new Notice("OHSidian: 目标目录在当前仓库内,请选择仓库以外的位置")}catch(e){}return;
        }
        try{new Notice("OHSidian: 开始迁移仓库到 "+target)}catch(e){}
        var copied=0;
        var copyDir=function(s,d,cb){
          fsMod.mkdir(d,{recursive:!0},function(){
            fsMod.readdir(s,function(err,items){
              if(err)return cb(err);
              var pending=items.length,fail=null;
              if(!pending)return cb(null);
              var done=function(e2){fail=fail||e2;if(--pending===0)cb(fail)};
              items.forEach(function(name){
                var sp=pathMod.join(s,name),dp=pathMod.join(d,name);
                fsMod.stat(sp,function(err2,st){
                  if(err2)return done(err2);
                  if(st.isDirectory()){copyDir(sp,dp,done)}
                  else{fsMod.copyFile(sp,dp,function(e3){if(!e3)copied++;done(e3)})}
                });
              });
            });
          });
        };
        copyDir(srcDir,target,function(err){
          if(err){try{new Notice("OHSidian: 迁移失败 "+err.message)}catch(e){}return}
          try{new Notice("OHSidian: 已复制 "+copied+" 个文件,正在打开新仓库…")}catch(e){}
          try{
            var r=remote.ipcRenderer.sendSync("vault-open",target,!1);
            if(r!==!0){try{new Notice("OHSidian: 打开新仓库返回 "+r)}catch(e){}}
          }catch(e){try{new Notice("OHSidian: 打开新仓库失败 "+e.message)}catch(e2){}}
        });
      }catch(e){try{new Notice("OHSidian: 迁移失败 "+e.message)}catch(e2){}}
    },function(){/* canceled by user */});};
    var docsDir=null;
    try{docsDir=(readMode()||{}).documentsDir||null}catch(e){}
    var inSandbox=false;
    try{
      var cur=v.adapter.getFullPath("/");
      var ud=require("@electron/remote").app.getPath("userData");
      inSandbox=!!(cur&&ud&&cur.indexOf(ud)===0);
    }catch(e){}
    if(docsDir&&inSandbox){
      /* one-tap default migration into the visible Documents root */
      var name="Obsidian Vault";
      try{name=require("path").basename(v.adapter.getFullPath("/"))||name}catch(e){}
      var dest=require("path").join(docsDir,"OHSidian",name);
      try{new Notice("OHSidian: 当前仓库在应用沙箱内,卸载会丢数据。开始迁移到 文档/OHSidian/"+name+" …")}catch(e){}
      var fsMod=require("fs"),pathMod=require("path");
      var srcDir;
      try{srcDir=v.adapter.getFullPath("/")}catch(e){}
      if(!srcDir){try{new Notice("OHSidian: 无法定位仓库根目录")}catch(e){}return}
      var copied=0;
      var copyDir2=function(s,d,cb){
        fsMod.mkdir(d,{recursive:!0},function(){
          fsMod.readdir(s,function(err,items){
            if(err)return cb(err);
            var pending=items.length,fail=null;
            if(!pending)return cb(null);
            var done=function(e2){fail=fail||e2;if(--pending===0)cb(fail)};
            items.forEach(function(nm){
              var sp=pathMod.join(s,nm),dp=pathMod.join(d,nm);
              fsMod.stat(sp,function(err2,st){
                if(err2)return done(err2);
                if(st.isDirectory()){copyDir2(sp,dp,done)}
                else{fsMod.copyFile(sp,dp,function(e3){if(!e3)copied++;done(e3)})}
              });
            });
          });
        });
      };
      copyDir2(srcDir,dest,function(err){
        if(err){try{new Notice("OHSidian: 迁移失败 "+err.message+",可改用文件夹选择器")}catch(e){}pickMigration();return}
        try{new Notice("OHSidian: 已复制 "+copied+" 个文件到 文档/OHSidian/"+name+",正在打开新仓库…")}catch(e){}
        try{
          var r=remote.ipcRenderer.sendSync("vault-open",dest,!1);
          if(r!==!0){try{new Notice("OHSidian: 打开新仓库返回 "+r)}catch(e){}}
        }catch(e){try{new Notice("OHSidian: 打开新仓库失败 "+e.message)}catch(e2){}}
      });
    }else{
      pickMigration();
    }
  }catch(e){}
}
/* TODO 7: "system fonts" as a first-class choice. Obsidian's font settings
   write interfaceFontFamily/textFontFamily/monospaceFontFamily, which land
   as --font-*-override and beat our HarmonyOS Sans default. The command
   below clears all three overrides so the UI falls back to the (patched)
   system-font default. The out-of-the-box state already IS system fonts
   (empty overrides), so the default needs no extra plumbing. */
function restoreSystemFonts(){
  try{
    var v=window.app&&window.app.vault;
    if(!v||typeof v.setConfig!=="function"){try{new Notice("OHSidian: 仓库未就绪")}catch(e){}return}
    v.setConfig("interfaceFontFamily","");
    v.setConfig("textFontFamily","");
    v.setConfig("monospaceFontFamily","");
    try{
      var b=document.body;
      ["--font-interface-override","--font-text-override","--font-monospace-override","--font-print-override"]
        .forEach(function(k){b.style.removeProperty(k)});
    }catch(e){}
    try{window.app.workspace.trigger("css-change")}catch(e){}
    try{new Notice("OHSidian: 已恢复系统字体 (HarmonyOS Sans)")}catch(e){}
  }catch(e){}
}
var install=function(app){
  if(!app||!app.commands||typeof app.commands.addCommand!=="function")return false;
  /* Round 93 (93e): the frame default is enforced by the MAIN-PROCESS body
     patch (update-obsidian.mjs main(): Ae=D.frame==="native" becomes
     "unset counts as native"). The renderer-side migration (93b/93c/93d)
     targeted the WRONG file - frame lives in the GLOBAL config
     (<userData>/obsidian.json, the D object in main.js), NOT in the
     vault's .obsidian/app.json; vault.setConfig never touched it and the
     whole block was inert on device. Removed. */
  try{
    app.commands.addCommand({id:"ohsidian-touch-mode",name:"OHSidian: 切换触屏模式 (自动 → 触摸 → 桌面)",
      callback:function(){
        var cfg=readMode()||{};
        var cur=cfg.override||"auto";
        var next=cur==="auto"?"touch":(cur==="touch"?"desktop":"auto");
        cfg.override=next;
        var want=resolveWant(cfg);
        var label=next==="auto"?(("系统当前: "+(want?"触摸":"桌面"))):(next==="touch"?"始终触摸":"始终桌面");
        var saved=writeModeFileSync(cfg);
        try{new Notice("OHSidian 触屏模式 → "+label+(saved?"":"(写入失败,重启后失效)"))}catch(e){}
        if(want!==null){lastWant=want;applyMobile(want,"手动切换")}
      }});
    app.commands.addCommand({id:"ohsidian-vault-visible",name:"OHSidian: 迁移仓库到文件管理可见的位置",
      callback:function(){migrateVaultToVisibleFolder()}});
    app.commands.addCommand({id:"ohsidian-system-fonts",name:"OHSidian: 恢复系统字体 (HarmonyOS Sans)",
      callback:function(){restoreSystemFonts()}});
    /* Zoom-style font scale chooser: cycles 跟随系统 → 100% → 110% → 125% →
       150% → 100%... Written into the mode file as cfg.fontScaleOverride;
       the effective scale = override || cfg.fontScale (system). This gives
       the user an in-app choice without waiting for the system setting. */
    var FONT_STEPS=[0,"auto",1,1.1,1.25,1.5,1.75,2];
    app.commands.addCommand({id:"ohsidian-font-scale",name:"OHSidian: 界面文字缩放 (跟随系统/100%–200%)",
      callback:function(){
        var cfg=readMode()||{};
        var cur=cfg.fontScaleOverride!==undefined?cfg.fontScaleOverride:"auto";
        var idx=FONT_STEPS.indexOf(cur);
        if(idx<0)idx=0;
        idx=(idx+1)%FONT_STEPS.length;
        var next=FONT_STEPS[idx];
        if(next==="auto")delete cfg.fontScaleOverride;else cfg.fontScaleOverride=next;
        writeModeFileSync(cfg);
        var eff=next==="auto"?(cfg.fontScale||1):next;
        lastFontScale=-1;
        applyFontScale();
        try{new Notice("OHSidian 界面文字 → "+(next==="auto"?("跟随系统 ("+Math.round((cfg.fontScale||1)*100)+"%)"):(Math.round(next*100)+"%")))}catch(e){}
      }});
    /* Font FAMILY picker: cycle through the system font families published
       by ArkTS (cfg.systemFonts, from font.getSystemFontList). "跟随系统"
       keeps the HarmonyOS Sans default (the system resolves it to the user
       chosen style font where supported); any other pick writes that
       family into Obsidian's interfaceFontFamily + textFontFamily (via
       vault.setConfig, which triggers updateFontFamily immediately and
       persists). Run the command repeatedly to cycle; current selection
       is announced each time. */
    var ohsidianFontCycle=function(){
      try{
        var v=window.app&&window.app.vault;
        if(!v||typeof v.setConfig!=="function"){try{new Notice("OHSidian: 仓库未就绪")}catch(e){}return}
        var cfg=readMode()||{};
        var fams=["@system"];
        try{
          var list=cfg.systemFonts?JSON.parse(cfg.systemFonts):[];
          for(var i=0;i<list.length&&fams.length<60;i++){
            if(typeof list[i]==="string"&&list[i]&&fams.indexOf(list[i])<0)fams.push(list[i]);
          }
        }catch(e){}
        var curFamily=(function(){
          try{
            var val=v.getConfig("interfaceFontFamily");
            if(val)return val.split(",")[0].replace(/["]/g,"").trim();
          }catch(e){}
          return "";
        })();
        var idx=fams.indexOf(curFamily);
        var next=fams[(idx+1+fams.length)%fams.length]||"@system";
        var styleFamily=(function(){
          try{var f=styleFontFamilyFromCfg(readMode());return typeof f==="string"?f:null}catch(e){return null}
        })();
        var followLabel=styleFamily?("跟随系统("+styleFamily+")"):"跟随系统(默认栈)";
        if(next==="@system"){
          v.setConfig("interfaceFontFamily","");
          v.setConfig("textFontFamily","");
          try{
            var b=document.body;
            ["--font-interface-override","--font-text-override"].forEach(function(k){b.style.removeProperty(k)});
          }catch(e){}
          try{new Notice("OHSidian 界面字体 → "+followLabel)}catch(e){}
        }else{
          v.setConfig("interfaceFontFamily",next);
          v.setConfig("textFontFamily",next);
          try{new Notice("OHSidian 界面字体 → "+next+" (再次执行可切换下一个)")}catch(e){}
        }
      }catch(e){}
    };
    app.commands.addCommand({id:"ohsidian-font-family",name:"OHSidian: 界面字体 (跟随系统/系统字体循环)",
      callback:function(){ohsidianFontCycle()}});
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
/* CLI socket relocation: Obsidian 1.13+ binds its CLI server Unix socket to
   $XDG_RUNTIME_DIR || homedir(); homedir() here is /storage/Users/currentUser,
   which the app sandbox cannot write, so listen fails with EPERM ("CLI server
   error" on every boot, CLI server dead). Point it at the app-writable
   userData dir BEFORE main.js computes the socket path (this patch is
   prepended to main.js). app.getPath works pre-ready; on failure the socket
   stays on homedir and the old EPERM noise returns - no regression. */
if(!process.env.XDG_RUNTIME_DIR){
  try{
    process.env.XDG_RUNTIME_DIR=require("electron").app.getPath("userData");
    try{console.log("[OHSidian] CLI socket dir -> "+process.env.XDG_RUNTIME_DIR)}catch(e){}
  }catch(e){}
}
}catch(e){}})();
;(function(){try{
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
    /* Dispatch cursor lives in a SEPARATE file: this loop used to write
       lastDispatchedSeq back into the main file, and that read-modify-write
       raced the ArkTS writer - a deep link appended between our read and
       write got erased with the stale snapshot (OAuth callback lost). The
       main file is now ArkTS-write-only; this side never rewrites it. */
    var cursorPath=p+".cursor.json";
    var last;
    try{
      var cursorCfg=JSON.parse(fsMod.readFileSync(cursorPath,"utf8"));
      last=cursorCfg&&typeof cursorCfg.lastDispatchedSeq==="number"?cursorCfg.lastDispatchedSeq:0;
    }catch(e2){
      /* First tick after the cursor-file split: fall back to the legacy
         field so already-dispatched links are not re-fired. */
      last=typeof cfg.lastDispatchedSeq==="number"?cfg.lastDispatchedSeq:0;
    }
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
      try{fsMod.writeFileSync(cursorPath,JSON.stringify({lastDispatchedSeq:maxDispatched}),"utf8")}catch(e){}
    }
  }catch(e){}
},1500);
}catch(e){}})();
/* Default vault in the USER-VISIBLE Documents directory (uninstall-safe).
   The ArkTS layer publishes the sandbox-mapped Documents path (granted by
   READ_WRITE_DOCUMENTS_DIRECTORY, see WebAbility.publishDocumentsDir) into
   <userData>/ohsidian-mode.json as cfg.documentsDir. The default vault is
   <documents>/OHSidian/Obsidian Vault: visible in 文件管理 (vault AND its
   .trash), and it SURVIVES app uninstall - the old userData default was
   wiped together with the app. Falls back to userData when the Documents
   dir is unavailable (permission denied / older device), keeping the
   previous OHSidian behaviour. The legacy <userData>/Obsidian Vault is
   left untouched on disk so existing vaults keep working and can be
   migrated with the renderer-side command (no silent data moves).
   Registered on ready so this listener runs AFTER Obsidian's own and its
   returnValue wins. */
;(function(){try{
if(globalThis.__ohsidianDefaultVault)return;globalThis.__ohsidianDefaultVault=true;
var __ohDvApp=require("electron").app;
var __ohDvRegister=function(){
  try{
    var __ohDvFs=require("fs"),__ohDvPathMod=require("path");
    var __ohDvUserData=__ohDvApp.getPath("userData");
    var __ohDvResolve=function(){
      try{
        var cfg=JSON.parse(__ohDvFs.readFileSync(__ohDvPathMod.join(__ohDvUserData,"ohsidian-mode.json"),"utf8"));
        var docs=cfg&&cfg.documentsDir;
        if(typeof docs==="string"&&docs.length>0){
          try{__ohDvFs.accessSync(docs)}catch(e){return null}
          return __ohDvPathMod.join(docs,"OHSidian","Obsidian Vault");
        }
      }catch(e){}
      return null;
    };
    var __ohDvEnsure=function(p){
      try{__ohDvFs.mkdirSync(p,{recursive:true})}catch(e){}
      return p;
    };
    require("electron").ipcMain.on("get-default-vault-path",function(evt){
      try{
        var docsVault=__ohDvResolve();
        if(docsVault){evt.returnValue=__ohDvEnsure(docsVault);return}
        /* fallback: previous OHSidian behaviour (sandbox userData) */
        evt.returnValue=__ohDvEnsure(__ohDvPathMod.join(__ohDvUserData,"Obsidian Vault"));
      }catch(e){
        try{evt.returnValue=__ohDvPathMod.join(__ohDvUserData,"Obsidian Vault")}catch(e2){}
      }
    });
    try{console.log("[OHSidian] default vault root -> documents (fallback userData)")}catch(e){}
  }catch(e){}
};
if(__ohDvApp.isReady()){__ohDvRegister()}else{__ohDvApp.on("ready",__ohDvRegister)}
}catch(e){}})();
/* Trash purge: 60s after startup (and once more on will-quit, F-N16 - a
   session shorter than 60s or a multi-day background session used to miss
   the pass entirely), unlink trash entries older than 30 days. Age base:
   the <file>.ohsidian-trash-meta.json sidecar's deletedAt when present
   (F2 - written when the relocation could not utimesSync the moved file,
   whose ORIGINAL mtime would otherwise purge it immediately), else the
   entry's own mtime. Roots: the relocated Documents trash plus every
   registered vault's in-vault .trash (covers pre-relocation leftovers and
   sandbox vaults). Empty dirs are pruned, symlinks skipped, failures are
   per-entry and silent - a purge hiccup must never block startup. */
;(function(){try{
if(globalThis.__ohsidianTrashPurge)return;globalThis.__ohsidianTrashPurge=true;
var __ohTrashMaxAge=30*24*60*60*1000;
var __ohTrashMetaSuffix=".ohsidian-trash-meta.json";
var __ohTrashPurgeOnce=function(){try{
  var el=require("electron"),fsMod=require("fs"),pathMod=require("path");
  var ud=el.app.getPath("userData");
  var roots=[];
  try{
    var cfg=JSON.parse(fsMod.readFileSync(pathMod.join(ud,"ohsidian-mode.json"),"utf8"));
    if(cfg&&typeof cfg.documentsDir==="string"&&cfg.documentsDir)roots.push(pathMod.join(cfg.documentsDir,"OHSidianTrash"));
  }catch(e){}
  try{
    var oj=JSON.parse(fsMod.readFileSync(pathMod.join(ud,"obsidian.json"),"utf8"));
    var vs=(oj&&oj.vaults)||{};
    for(var k in vs){
      var p=vs[k]&&vs[k].path;
      if(typeof p==="string"&&p)roots.push(pathMod.join(p,".trash"));
    }
  }catch(e){}
  var now=Date.now();
  var purged=0;
  var walk=function(dir,depth){
    if(depth>16)return;
    var es;try{es=fsMod.readdirSync(dir,{withFileTypes:true})}catch(e){return}
    for(var i=0;i<es.length;i++){
      var en=es[i];if(!en||en.name==="."||en.name==="..")continue;
      var fp=pathMod.join(dir,en.name);
      try{
        if(en.isDirectory()){walk(fp,depth+1);try{fsMod.rmdirSync(fp)}catch(eE){}}
        else if(en.isFile()){
          var st=fsMod.statSync(fp);
          var ageBase=st.mtimeMs;
          /* F2: prefer the recorded deletion time over the file's own mtime
             (which is the ORIGINAL content mtime when utimesSync failed). */
          if(fp.slice(-__ohTrashMetaSuffix.length)!==__ohTrashMetaSuffix){
            try{
              var mc=JSON.parse(fsMod.readFileSync(fp+__ohTrashMetaSuffix,"utf8"));
              if(mc&&typeof mc.deletedAt==="number"&&mc.deletedAt>0)ageBase=mc.deletedAt;
            }catch(eM){}
          }
          if(now-ageBase>__ohTrashMaxAge){fsMod.unlinkSync(fp);purged++}
        }
      }catch(eE){}
    }
  };
  for(var i=0;i<roots.length;i++)walk(roots[i],0);
  try{console.log("[OHSidian] trash purge: roots="+roots.length+", removed="+purged)}catch(e){}
}catch(e){}};
setTimeout(__ohTrashPurgeOnce,60000);
/* F-N16: best-effort second pass at quit - covers sessions shorter than
   60s and long-running background sessions that never restart. */
try{require("electron").app.on("will-quit",function(){try{__ohTrashPurgeOnce()}catch(e){}})}catch(e){}
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
    if (appSrc.includes(dst)) {
      log('body patch already applied: ' + okMsg);
    } else if (appSrc.includes(src)) {
      appSrc = appSrc.replace(src, dst);
      log(okMsg);
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
