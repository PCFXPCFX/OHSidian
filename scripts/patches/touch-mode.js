;(function(){try{
if(window.__ohsidianTouchPatch==="22")return;window.__ohsidianTouchPatch="22";
/* Console -> main bridge (round 96b): the renderer console never reaches
   hilog natively. Opt-in via the command "OHSidian: 运行日志捕获 开/关"
   (persisted in localStorage, takes effect on the next app start): the
   console methods + global error traps are wrapped and each line is
   forwarded to the main process (ipc 'ohs-console'), which re-prints it
   with the [OHSidian:web] prefix (shows up in hilog IF the engine routes
   main-process stderr there) and appends it to
   <Documents|userData>/OHSidian/console.log (512KB single rotation,
   pullable via 文件管理 or hdc file recv). Rate-limited to 40 lines/s. */
var consoleCaptureOn=(function(){try{return localStorage.getItem("ohsidianConsoleCapture")==="1"}catch(e){return false}})();
var consoleForward=null;
if(consoleCaptureOn){
  try{
    var __ohIpc=require("@electron/remote").ipcRenderer;
    if(__ohIpc&&typeof __ohIpc.send==="function"){
      var __cfSent=0,__cfSec=0;
      consoleForward=function(level,args){
        try{
          var now=Date.now();
          if(now-__cfSec>=1000){__cfSec=now;__cfSent=0}
          if(__cfSent++>=40)return;
          var parts=[];
          for(var i=0;i<args.length&&i<8;i++){
            var a=args[i],s;
            try{s=(typeof a==="string")?a:JSON.stringify(a)}catch(e1){s=String(a)}
            if(typeof s!=="string")s=String(s);
            parts.push(s.length>2000?s.substring(0,2000)+"…":s);
          }
          __ohIpc.send("ohs-console",{level:level,text:parts.join(" ")});
        }catch(e2){}
      };
    }
  }catch(e){}
}
["log","info","warn","error","debug"].forEach(function(m){
  try{
    var orig=console[m];
    console[m]=function(){
      try{if(consoleForward)consoleForward(m,Array.prototype.slice.call(arguments))}catch(eF){}
      return orig.apply(console,arguments);
    };
  }catch(e){}
});
try{
  window.addEventListener("error",function(ev){
    try{if(consoleForward)consoleForward("error",["window.onerror: "+(ev.message||"")+" @"+(ev.filename||"")+":"+(ev.lineno||0)])}catch(e){}
  },true);
  window.addEventListener("unhandledrejection",function(ev){
    try{
      var r=ev&&ev.reason;
      if(consoleForward)consoleForward("error",["unhandledrejection: "+((r&&(r.stack||r.message))||String(r))]);
    }catch(e){}
  },true);
}catch(e){}
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
/* Resolve the user-visible Documents root ONLY when the permission is really
   granted. ArkTS publishes documentsDirGranted alongside documentsDir (Sprint
   2, 2026-10-19); older mode files (field absent) keep the previous rule so an
   upgrade does not change behaviour. */
function documentsDirPath(cfg){
  try{
    if(!cfg||typeof cfg.documentsDir!=="string"||!cfg.documentsDir)return "";
    if(cfg.documentsDirGranted===false)return "";
    return cfg.documentsDir;
  }catch(e){return ""}
}
/* Round 87 (B2): window geometry lives per window under cfg.windows[<OHOS
   window id>] - concurrent windows used to clobber each other's top-level
   insets within one 200ms poll. The renderer has no OHOS window id (the
   engine exposes no renderer-visible window identity), so it matches its
   own window by SIZE (outerWidth/outerHeight, +-2px): the geometry payload
   (insets/decor) is a pure function of fullscreen-likeness, which the rect
   size encodes - windows of equal size carry equal geometry, so size
   matching is unambiguous. Same-size windows differ in keyboard (follows
   the focused window). Round 99: within the size-matched candidates the
   order is focused-window id (published by ArkTS as cfg.focusedWindow) ->
   unique non-zero keyboard -> position (screenX/screenY, only when
   non-zero) -> first candidate. In touch mode every window is the same
   fullscreen rect at (0,0), so that last resort used to pick the OLDEST
   window - the vault-switch bug where a new window read the previous
   window's keyboard:0. Fallbacks: the single entry of a one-window
   session, then the main window's legacy top-level fields (pre-B2 shape,
   still mirrored by the main window). Returns null when nothing matches
   (callers fall back to the legacy fields). */
function resolveGeometry(cfg){
  try{
    var wins=cfg&&cfg.windows;
    if(wins&&typeof wins==="object"){
      var keys=Object.keys(wins);
      var entries=[];
      for(var i=0;i<keys.length;i++){
        var e=wins[keys[i]];
        if(e&&typeof e==="object"&&e.w>0&&e.h>0)entries.push({k:keys[i],e:e});
      }
      if(entries.length===1)return entries[0].e;
      if(entries.length>1){
        var ow=window.outerWidth||0,oh=window.outerHeight||0;
        if(ow>0&&oh>0){
          var bySize=entries.filter(function(q){
            return Math.abs(q.e.w-ow)<=2&&Math.abs(q.e.h-oh)<=2;
          });
          if(bySize.length===1)return bySize[0].e;
          if(bySize.length>1){
            /* Round 99: identity, only among candidates that already matched by
               size (so PC-mode windows of different sizes keep resolving by
               their own rect, exactly as before). The renderer has no OHOS
               window id and in touch mode EVERY window is the same fullscreen
               rect at (0,0), so this branch used to end at bySize[0] = the
               lowest key = the OLDEST window. Device-proven after a vault
               switch: windows 520/522 both 1244x818@0,0 while 522 held
               keyboard:344, so the new window read 520's keyboard:0 and the
               formatting toolbar never rose. The ArkTS side now publishes
               cfg.focusedWindow on WINDOW_ACTIVE/INACTIVE; the keyboard
               tiebreak below still covers a running HAP that predates it. */
            var focused=(cfg.focusedWindow===undefined||cfg.focusedWindow===null)?
              "":(""+cfg.focusedWindow);
            if(focused!==""){
              var byFocus=bySize.filter(function(q){return q.k===focused;});
              if(byFocus.length===1)return byFocus[0].e;
            }
            /* Only one window can own the IME at a time, so a non-zero
               keyboard is strictly better than the oldest entry's 0 while
               several same-size windows are on screen. */
            var withKb=bySize.filter(function(q){return (+q.e.keyboard||0)>0;});
            if(withKb.length===1)return withKb[0].e;
            var sx=window.screenX||0,sy=window.screenY||0;
            if(sx!==0||sy!==0){
              var byPos=bySize.filter(function(q){
                return Math.abs(q.e.l-sx)<=2&&Math.abs(q.e.t-sy)<=2;
              });
              if(byPos.length===1)return byPos[0].e;
            }
            return bySize[0].e;
          }
        }
        /* Round 100: the size gate can miss completely. Device samples of one
           fullscreen touch-mode window: 1140x724 right after boot, 1245x818
           once laid out, 1468x966 in a window whose dpr settled at 2.25 -
           against a published 1244x818 vp rect. With two windows open a miss
           means EVERY consumer falls back to the main window's mirrored
           top-level fields (keyboard 0, stale insets). Fall back to the
           focus-published entry instead: focusedEntry decides by mode whether
           the marker may be trusted without document.hasFocus(). */
        var fe=focusedEntry(cfg);
        if(fe)return fe;
        return null;
      }
    }
  }catch(e){}
  return null;
}
/* Round 100: the only window that can own the IME is the focused one, and
   ArkTS publishes that window's OHOS id as cfg.focusedWindow - so "the entry
   named by cfg.focusedWindow" is this renderer's entry. Deliberately NOT
   routed through resolveGeometry: the size gate needs window.outerWidth/
   outerHeight to equal the published vp rect, which on device only holds once
   the layout settles (1140x724 at boot, 1245x818 laid out, 1468x966 with a
   2.25 dpr), so a miss sends the consumer to the main window's mirrored
   cfg.keyboard (0). That is the reported "切换仓库后新窗口的工具栏不生效,杀掉
   旧窗口就生效" (kill the old window -> a single entry -> resolveGeometry's
   early return feeds it). Fallbacks in resolveKeyboardEntry still land on the
   IME owner for a renderer that has no focus marker: unique non-zero
   keyboard, then the largest keyboard. */
function focusedEntry(cfg){
  try{
    /* Touch mode: exactly one window is on screen at a time and it is the
       focused one, so cfg.focusedWindow can be trusted unconditionally.
       Desktop/PC mode keeps the document.hasFocus() guard because several
       windows are visible at once and a background window must not adopt the
       focused window's geometry. */
    var touch=false;
    try{touch=resolveWant(cfg)===true}catch(e0){}
    if(!touch&&!(document.hasFocus&&document.hasFocus()))return null;
    var wins=cfg&&cfg.windows;
    if(!wins||typeof wins!=="object")return null;
    var f=(cfg.focusedWindow===undefined||cfg.focusedWindow===null)?"":(""+cfg.focusedWindow);
    if(f==="")return null;
    var e=wins[f];
    if(e&&typeof e==="object"&&e.w>0&&e.h>0)return e;
  }catch(err){}
  return null;
}
function resolveKeyboardEntry(cfg){
  try{
    var wins=cfg&&cfg.windows;
    if(wins&&typeof wins==="object"){
      var fe=focusedEntry(cfg);
      if(fe)return fe;
      var keys=Object.keys(wins),entries=[];
      for(var i=0;i<keys.length;i++){
        var e=wins[keys[i]];
        if(e&&typeof e==="object"&&e.w>0&&e.h>0)entries.push(e);
      }
      if(entries.length===1)return entries[0];
      var kb=entries.filter(function(q){return (+q.keyboard||0)>0});
      if(kb.length===1)return kb[0];
      if(kb.length>1){
        /* Both windows report an IME (a stale >0 left by the window that
           lost focus before its IME closed). The height is the same IME, so
           the largest value is the safe answer for the window that is
           typing. */
        var best=kb[0];
        for(var j=1;j<kb.length;j++){if((+kb[j].keyboard||0)>(+best.keyboard||0))best=kb[j]}
        return best;
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
    var g=resolveKeyboardEntry(cfg);
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
var modePollMs=200,hiddenPollMs=1000,lastModeRaw=null;
function pollTick(){
  try{
    /* Round 100: a hidden window used to SKIP the read entirely and wait for
       a visibilitychange to resume. That assumed the engine always reports
       visibility correctly; after a vault switch the new window can stay
       document.hidden (created STARTUP_HIDE, shown later), which froze EVERY
       mode-file consumer in it - the toolbar never reacted until the old
       window died and its visibility event kicked the loop. Throttle instead
       of skip: one small read per second while hidden. */
    var dir=dataDir();
    if(dir){
      var txt=require("fs").readFileSync(dir+MODE_FILE,"utf8");
      if(txt!==lastModeRaw){
        lastModeRaw=txt;
        try{lastWant=syncFromSystem(lastWant)}catch(e){}
        /* Back gesture published by the @Entry pages (round 96). */
        try{applyBackPress()}catch(e){}
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
  }catch(e){}
  setTimeout(pollTick,document.hidden?hiddenPollMs:modePollMs);
}
document.addEventListener("visibilitychange",function(){
  if(!document.hidden){lastModeRaw=null}
});
/* Round 100: the keyboard/geometry pick now consults document.hasFocus(), so
   a focus transition must re-evaluate immediately instead of waiting for the
   next file change. */
try{
  window.addEventListener("focus",function(){
    try{lastModeRaw=null}catch(e){}
    try{applySafeArea()}catch(e){}
    try{applyKeyboard()}catch(e){}
  });
  window.addEventListener("blur",function(){
    try{applyKeyboard()}catch(e){}
  });
}catch(e){}
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
    /* Standalone media view. Clicking a video file in the vault opens a FILE
       VIEW, not an embed: there is no ".internal-embed", the <video> src is an
       app:// blob rather than file://, and the container does not carry
       "data-path" (that attribute lives on the file-explorer rows). A DOM
       attribute lookup therefore returns nothing here.
       The ACTIVE FILE is exactly that video, and that is an API fact:
       workspace.getActiveFile(). The extension guard keeps a note that merely
       embeds a video from resolving to the note itself. */
    var appObj=window.app;
    var af=(appObj&&appObj.workspace&&typeof appObj.workspace.getActiveFile==="function")
      ? appObj.workspace.getActiveFile() : null;
    var VIDEO_RE=/\.(mp4|m4v|mov|mkv|ts|webm|avi)$/i;
    if(af&&af.path&&VIDEO_RE.test(af.path)&&v&&v.adapter&&
       typeof v.adapter.getFullPath==="function"){
      try{return v.adapter.getFullPath(af.path)}catch(eAf){}
    }
    /* Last resort for a file view whose container DOES expose data-path. */
    var holder=(el&&el.closest)?el.closest("[data-path]"):null;
    var holderPath=(holder&&holder.getAttribute)?holder.getAttribute("data-path"):"";
    if(holderPath&&v&&typeof v.getAbstractFileByPath==="function"&&VIDEO_RE.test(holderPath)){
      var lf=null;
      try{lf=v.getAbstractFileByPath(holderPath)}catch(eMv){}
      if(lf&&v.adapter&&typeof v.adapter.getFullPath==="function"){
        try{return v.adapter.getFullPath(lf.path)}catch(eMv2){}
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
var __ohsidianNativeVideoSeq=0;
var __ohsidianNativeTrack=null;
/* B route: the renderer cannot create an ArkTS surface itself. Write the
   <video> rect + absolute vault path to the same userData directory the
   ArkTS side already uses for the mode file; Index.ets polls it and stacks
   NativeVideoOverlay over the WebWindow. This is the inline B prototype, not
   the rejected full-screen B-prime page.

   The tracker is deliberately rAF-based: it follows scroll/resize, sends the
   full video rect plus the safe content region, and writes a close request
   when the IME rises or an Obsidian modal opens. IPC carries every display
   frame; the file channel is only the degraded fallback. Index.ets clips the
   native surface to the visible slice (video rect AND content region) and owns
   the hit test there, so a tap on the video never reaches the page behind it. */
function ohsidianNativeKeyboard(){
  try{
    return parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--keyboard-height"))||0;
  }catch(e){return 0}
}
var __ohsidianOccludedAt=0;
var __ohsidianOccludedValue=false;
function ohsidianNativeVisible(el){
  try{
    if(!el)return false;
    var cs=getComputedStyle(el);
    if(cs.display==="none"||cs.visibility==="hidden")return false;
    if(parseFloat(cs.opacity)===0)return false;
    var r=el.getBoundingClientRect();
    return !!r&&r.width>1&&r.height>1;
  }catch(e){return false}
}
function ohsidianNativeOccluded(){
  try{
    var now=Date.now();
    if(now-__ohsidianOccludedAt<150)return __ohsidianOccludedValue;
    __ohsidianOccludedAt=now;
    // 1.13.7 mobile drawer is ".workspace-drawer" + inline display:none when
    // collapsed; it has no ".is-active" / ".is-collapsed" class on the drawer
    // container. The backdrop is appended on expand and detached on collapse,
    // but the old is-active selectors were always false. Visibility filtering
    // covers both the persistent drawer and the transient backdrop.
    var list=document.querySelectorAll(
      ".modal-container, .prompt, .menu, .suggestion-container, " +
      ".modal, .modal-bg, .workspace-drawer, .workspace-drawer-backdrop"
    );
    for(var i=0;i<list.length;i++){
      var el=list[i];
      if(!ohsidianNativeVisible(el))continue;
      if(el.classList&&el.classList.contains("workspace-drawer")&&
        el.classList.contains("is-pinned"))continue;
      __ohsidianOccludedValue=true;
      return true;
    }
    __ohsidianOccludedValue=false;
    return false;
  }catch(e){return false}
}
/* The request file is shared by every window. Resolve THIS renderer's OHOS
   window id from the same size/focus match used for geometry, so Index.ets
   can reject a request that belongs to another window instead of showing the
   overlay in whichever window polled first. */
function ohsidianNativeWindowKey(){
  try{
    var cfg=readMode();
    if(!cfg)return "";
    var wins=cfg.windows;
    var g=resolveGeometry(cfg);
    if(wins&&typeof wins==="object"&&g){
      for(var k in wins){
        if(wins[k]===g)return ""+k;
      }
    }
    if(cfg.focusedWindow!==undefined&&cfg.focusedWindow!==null)return ""+cfg.focusedWindow;
  }catch(e){}
  return "";
}
function ohsidianNativeXComponentId(){
  try{
    var cfg=readMode();
    if(!cfg)return "";
    var g=resolveGeometry(cfg);
    if(g&&g.xcomponentId)return ""+g.xcomponentId;
  }catch(e){}
  return "";
}
/* Persistent loopback IPC. The ArkTS Index publishes its ephemeral port per
   xcomponentId; one keep-alive socket replaces 25 file writes/second and the
   40ms reader wakeup. File remains the fallback if the socket cannot start. */
var __ohsidianNativeIpcSock=null;
var __ohsidianNativeIpcReady=false;
var __ohsidianNativeIpcTriedAt=0;
var __ohsidianNativeIpcIn="";
function ohsidianNativeIpcPort(){
  try{
    var xid=ohsidianNativeXComponentId();
    if(!xid)return null;
    var remote=require("@electron/remote");
    var fs=require("fs");
    var nodePath=require("path");
    var safe=xid.replace(/[^A-Za-z0-9_.-]/g,"_");
    var file=nodePath.join(remote.app.getPath("userData"),"ohsidian-native-port-"+safe+".json");
    if(!fs.existsSync(file))return null;
    var cfg=JSON.parse(fs.readFileSync(file,"utf8"));
    if(!cfg||!(cfg.port>0))return null;
    return {port:cfg.port,token:(cfg.token||"")};
  }catch(e){return null}
}
function ohsidianNativeIpcEnsure(){
  if(__ohsidianNativeIpcSock!==null&&__ohsidianNativeIpcReady)return true;
  if(__ohsidianNativeIpcSock!==null)return false;
  var now=Date.now();
  if(now-__ohsidianNativeIpcTriedAt<1500)return false;
  __ohsidianNativeIpcTriedAt=now;
  try{
    var cfg=ohsidianNativeIpcPort();
    if(!cfg||!cfg.port)return false;
    var port=cfg.port, token=cfg.token||"";
    var net=require("net");
    var s=net.createConnection({host:"127.0.0.1",port:port});
    s.setNoDelay(true);
    try{s.setKeepAlive(true,30000)}catch(eK){}
    s.on("connect",function(){
      __ohsidianNativeIpcReady=true;
      __ohsidianNativeIpcTriedAt=0;
      __ohsidianNativeIpcIn="";
      try{s.write(JSON.stringify({hello:1,token:token})+"\n")}catch(eH){}
    });
    s.on("error",function(){
      __ohsidianNativeIpcReady=false;
      try{s.destroy()}catch(eD){}
      if(__ohsidianNativeIpcSock===s)__ohsidianNativeIpcSock=null;
    });
    s.on("close",function(){
      __ohsidianNativeIpcReady=false;
      if(__ohsidianNativeIpcSock===s)__ohsidianNativeIpcSock=null;
    });
    s.on("data",function(chunk){
      try{
        __ohsidianNativeIpcIn+=chunk.toString("utf8");
        var lines=__ohsidianNativeIpcIn.split("\n");
        __ohsidianNativeIpcIn=lines.pop()||"";
        for(var i=0;i<lines.length;i++){
          var line=lines[i].trim();
          if(!line)continue;
          var msg=JSON.parse(line);
          if(msg&&msg.event==="opened"&&typeof msg.seq==="number")ohsidianConfirmNativeOpen(msg.seq);
          if(msg&&msg.event==="close")ohsidianHandleNativeClosed();
        }
      }catch(eD){}
    });
    __ohsidianNativeIpcSock=s;
  }catch(e){
    __ohsidianNativeIpcSock=null;
    __ohsidianNativeIpcReady=false;
  }
  return false;
}
function ohsidianNativeIpcSend(req){
  if(!__ohsidianNativeIpcSock||!__ohsidianNativeIpcReady)return false;
  try{
    __ohsidianNativeIpcSock.write(JSON.stringify(req)+"\n");
    return true;
  }catch(e){
    __ohsidianNativeIpcReady=false;
    try{__ohsidianNativeIpcSock.destroy()}catch(eD){}
    __ohsidianNativeIpcSock=null;
    return false;
  }
}
function ohsidianNativeGeometry(el){
  try{
    if(!el||!el.getBoundingClientRect)return null;
    var r=el.getBoundingClientRect();
    if(!r||!(r.width>0)||!(r.height>0))return null;
    if(ohsidianNativeKeyboard()>0)return null;
    var vw=window.innerWidth||r.right||0;
    var vh=window.innerHeight||r.bottom||0;
    var vv=window.visualViewport;
    if(vv&&vv.height>0)vh=Math.min(vh,vv.height+(vv.offsetTop||0));
    var rootStyle=getComputedStyle(document.documentElement);
    var safeTop=parseFloat(rootStyle.getPropertyValue("--safe-area-inset-top"))||0;
    var safeBottom=parseFloat(rootStyle.getPropertyValue("--safe-area-inset-bottom"))||0;
    var safeLeft=parseFloat(rootStyle.getPropertyValue("--safe-area-inset-left"))||0;
    var safeRight=parseFloat(rootStyle.getPropertyValue("--safe-area-inset-right"))||0;
    var topGuard=safeTop;
    // The real text clipping boundary is the current leaf's view-content, not
    // the first .view-header in the document (a background/sidebar leaf could
    // be returned by a global query and shift the top edge). Resolve the
    // container from the video element itself.
    var leaf=el.closest?el.closest(".workspace-leaf, .workspace-leaf-content"):null;
    var content=el.closest?el.closest(".view-content"):null;
    var contentRect=content&&content.getBoundingClientRect?content.getBoundingClientRect():null;
    if(contentRect&&contentRect.width>0&&contentRect.height>0&&
      contentRect.top>=0&&contentRect.top<vh*0.5){
      topGuard=Math.max(topGuard,contentRect.top);
    }
    var header=null;
    if(leaf&&leaf.querySelectorAll){
      var hdrs=leaf.querySelectorAll(".view-header, .workspace-leaf-header");
      for(var hi=0;hi<hdrs.length;hi++){
        var hc=hdrs[hi].getBoundingClientRect?hdrs[hi].getBoundingClientRect():null;
        if(hc&&hc.height>0&&hc.bottom>0&&hc.bottom<vh*0.5){header=hdrs[hi];break}
      }
    }
    if(!header&&!contentRect){
      var gh=document.querySelectorAll(".view-header, .workspace-leaf-header, .workspace-tab-header-container");
      for(var gi=0;gi<gh.length;gi++){
        var gr=gh[gi].getBoundingClientRect?gh[gi].getBoundingClientRect():null;
        if(gr&&gr.height>0&&gr.bottom>0&&gr.bottom<vh*0.5){header=gh[gi];break}
      }
    }
    if(header){
      var hr=header.getBoundingClientRect();
      if(hr&&hr.height>0&&hr.bottom>0&&hr.bottom<vh*0.5)topGuard=Math.max(topGuard,hr.bottom);
    }
    // Phone floating-nav / auto-full-screen applies a top fade to markdown:
    // linear-gradient(... #000 calc(safe-top + view-header-height + 12px)).
    // The text is only fully opaque below that line, so the native overlay's
    // top edge must use the same line. header.bottom alone is 12px too high.
    var body=document.body;
    var phoneFloating=!!(body&&body.classList&&body.classList.contains("is-phone")&&
      (body.classList.contains("is-floating-nav")||body.classList.contains("auto-full-screen")));
    var hiddenNav=!!(body&&body.classList&&body.classList.contains("is-hidden-nav"));
    var markdownLeaf=el.closest?el.closest('.workspace-leaf-content[data-type="markdown"]'):null;
    if(phoneFloating&&!hiddenNav&&markdownLeaf){
      var headerHeight=parseFloat(rootStyle.getPropertyValue("--view-header-height"))||0;
      if(!(headerHeight>0)&&header)headerHeight=header.getBoundingClientRect().height||0;
      if(headerHeight>0){
        var maskTop=safeTop+headerHeight+12;
        if(maskTop>0&&maskTop<vh*0.5)topGuard=Math.max(topGuard,maskTop);
      }
    }
    // Bottom chrome: Obsidian's mobile toolbar/navbar, plus desktop/status bar
    // variants. Only accept bars anchored in the lower half so a top header
    // with the same class cannot steal the whole viewport.
    var bottom=Math.min(vh,vh-safeBottom);
    if(contentRect&&contentRect.height>0&&contentRect.bottom>vh*0.5&&contentRect.bottom<=vh){
      bottom=Math.min(bottom,contentRect.bottom);
    }
    var bars=document.querySelectorAll(
      ".mobile-toolbar, .mobile-navbar, .workspace-status-bar, .status-bar");
    for(var i=0;i<bars.length;i++){
      var br=bars[i]&&bars[i].getBoundingClientRect?bars[i].getBoundingClientRect():null;
      if(br&&br.height>0&&br.top>vh*0.35&&br.bottom>vh*0.55)bottom=Math.min(bottom,br.top);
    }
    // The native SURFACE is clipped by Index.ets to this content region, so the
    // video rect must stay the FULL element rect. Clamping the height here (as
    // the previous version did) scaled the video to the toolbar and exposed the
    // original <video> at the bottom.
    var region={
      left:Math.max(0,safeLeft),
      top:Math.max(0,topGuard),
      width:Math.max(0,vw-safeLeft-safeRight),
      height:Math.max(0,bottom-Math.max(0,topGuard))
    };
    if(!(region.width>20)||!(region.height>20))return null;
    var ix1=Math.max(region.left,r.left),iy1=Math.max(region.top,r.top);
    var ix2=Math.min(region.left+region.width,r.right);
    var iy2=Math.min(region.top+region.height,r.bottom);
    if(!(ix2>ix1+1)||!(iy2>iy1+1))return null;
    return {
      left:r.left,
      top:r.top,
      width:r.width,
      height:r.height,
      region:region,
      dpr:window.devicePixelRatio||1
    };
  }catch(e){return null}
}
var __ohsidianThemeCache=null;
var __ohsidianThemeAt=0;
var __ohsidianThemeSentAt=0;
var __ohsidianColorCanvas=null;
function ohsidianCssColor(value){
  try{
    if(!value)return "";
    if(!__ohsidianColorCanvas){
      __ohsidianColorCanvas=document.createElement("canvas");
      __ohsidianColorCanvas.width=1;
      __ohsidianColorCanvas.height=1;
    }
    var ctx=__ohsidianColorCanvas.getContext&&__ohsidianColorCanvas.getContext("2d");
    if(!ctx)return "";
    ctx.clearRect(0,0,1,1);
    // Sentinel detects invalid colors: fillStyle keeps the previous value.
    ctx.fillStyle="#010203";
    ctx.fillStyle=value;
    var out=String(ctx.fillStyle||"").toLowerCase();
    var m;
    if(out==="#010203")return "";
    if(/^#[0-9a-f]{3}$/.test(out)){
      return "#"+out[1]+out[1]+out[2]+out[2]+out[3]+out[3];
    }
    if(/^#[0-9a-f]{4}$/.test(out)){
      // #RGBA -> ArkUI #AARRGGBB.
      return "#"+out[4]+out[4]+out[1]+out[1]+out[2]+out[2]+out[3]+out[3];
    }
    if(/^#[0-9a-f]{6}$/.test(out))return out;
    if(/^#[0-9a-f]{8}$/.test(out)){
      // Canvas normalizes 8-digit input to #RRGGBBAA; ArkUI expects AARRGGBB.
      return "#"+out.slice(7,9)+out.slice(1,7);
    }
    m=out.match(/^rgba?\(([^)]+)\)$/);
    if(m){
      var parts=m[1].split(",").map(function(x){return parseFloat(x)});
      if(parts.length<3)return "";
      var hex="#";
      for(var i=0;i<3;i++){
        var c=Math.max(0,Math.min(255,Math.round(parts[i]||0))).toString(16);
        hex+=c.length<2?"0"+c:c;
      }
      if(parts.length>3&&parts[3]<1){
        var a=Math.max(0,Math.min(255,Math.round((parts[3]||0)*255))).toString(16);
        hex="#"+ (a.length<2?"0"+a:a) + hex.slice(1);
      }
      return hex;
    }
    return "";
  }catch(e){return ""}
}
function ohsidianThemeRgba(value,alpha,fallback){
  var hex=ohsidianCssColor(value);
  // Accept both #RRGGBB and the #AARRGGBB form produced for translucent
  // semantic colors; the bar's own alpha replaces the source alpha.
  if(/^#[0-9a-f]{8}$/.test(hex))hex="#"+hex.slice(3);
  if(!/^#[0-9a-f]{6}$/.test(hex))hex=fallback;
  if(/^#[0-9a-f]{8}$/.test(hex))hex="#"+hex.slice(3);
  var a=Math.max(0,Math.min(255,Math.round(alpha*255))).toString(16);
  return "#"+(a.length<2?"0"+a:a)+hex.slice(1);
}
function ohsidianThemePx(value,fallback){
  var n=parseFloat(value);
  return isFinite(n)&&n>=0?n:fallback;
}
function ohsidianNativeTheme(){
  try{
    var now=Date.now();
    if(__ohsidianThemeCache&&now-__ohsidianThemeAt<900)return __ohsidianThemeCache;
    var body=document.body||document.documentElement;
    var cs=getComputedStyle(body);
    var v=function(name,fallback){
      try{return (cs.getPropertyValue(name)||"").trim()||fallback}catch(e){return fallback}
    };
    var bg=v("--background-secondary","");
    var panel=v("--background-primary-alt","");
    var accent=v("--interactive-accent","");
    var interactive=v("--interactive-normal","");
    var text=v("--text-normal","");
    var muted=v("--text-muted","");
    var faint=v("--text-faint","");
    var border=v("--background-modifier-border","");
    var error=v("--text-error","");
    var onAccent=v("--text-on-accent","");
    var bgHex=ohsidianCssColor(bg)||"#1e1e1e";
    var accentHex=ohsidianCssColor(accent)||"#8b7cf6";
    __ohsidianThemeCache={
      bg:bgHex,
      panel:ohsidianCssColor(panel)||bgHex,
      bar:ohsidianThemeRgba(bg,0.92,bgHex),
      interactive:ohsidianCssColor(interactive)||"#363636",
      accent:accentHex,
      onAccent:ohsidianCssColor(onAccent)||"#ffffff",
      text:ohsidianCssColor(text)||"#e8e8e8",
      muted:ohsidianCssColor(muted)||"#b9b9b9",
      faint:ohsidianCssColor(faint)||"#8a8a8a",
      border:ohsidianCssColor(border)||"#4a4168",
      error:ohsidianCssColor(error)||"#ff6b6b",
      radiusS:ohsidianThemePx(v("--radius-s",""),4),
      radiusM:ohsidianThemePx(v("--radius-m",""),8),
      radiusL:ohsidianThemePx(v("--radius-l",""),12)
    };
    __ohsidianThemeAt=now;
    return __ohsidianThemeCache;
  }catch(e){
    return {bg:"#1e1e1e",panel:"#252525",bar:"#eb1e1e1e",interactive:"#363636",
      accent:"#8b7cf6",onAccent:"#ffffff",text:"#e8e8e8",muted:"#b9b9b9",faint:"#8a8a8a",
      border:"#4a4168",error:"#ff6b6b",radiusS:4,radiusM:8,radiusL:12};
  }
}
function ohsidianWriteJsonAtomic(out,obj){
  var fs=require("fs");
  var tmp=out+".tmp-"+Date.now()+"-"+Math.random().toString(36).slice(2);
  try{
    fs.writeFileSync(tmp,JSON.stringify(obj));
    try{
      fs.renameSync(tmp,out);
    }catch(eRename){
      // Some Node/OHOS builds refuse to replace an existing target.
      if(fs.existsSync(out))fs.unlinkSync(out);
      fs.renameSync(tmp,out);
    }
    return true;
  }catch(e){
    try{if(fs.existsSync(tmp))fs.unlinkSync(tmp)}catch(eCleanup){}
    return false;
  }
}
function ohsidianWriteNativeRequest(action,el,srcPath,identity,preG,reason){
  try{
    var remote=require("@electron/remote");
    var fs=require("fs");
    var nodePath=require("path");
    var dir=remote.app.getPath("userData");
    var g=(action==="close")?null:(preG||ohsidianNativeGeometry(el));
    if(action!=="close"&&!g)action="close";
    __ohsidianNativeVideoSeq=Math.max(Date.now(),__ohsidianNativeVideoSeq+1);
    var winId=identity&&identity.windowId!==undefined?identity.windowId:ohsidianNativeWindowKey();
    var xid=identity&&identity.xcomponentId!==undefined?identity.xcomponentId:ohsidianNativeXComponentId();
    var themeOut=null;
    if(g&&(action==="open"||Date.now()-__ohsidianThemeSentAt>1000)){
      themeOut=ohsidianNativeTheme();
      __ohsidianThemeSentAt=Date.now();
    }
    var req={
      seq:__ohsidianNativeVideoSeq,
      ts:Date.now(),
      action:action,
      windowId:winId,
      xcomponentId:xid,
      path:srcPath||"",
      title:(el&&el.getAttribute&&el.getAttribute("title"))||"",
      rect:g?{left:g.left,top:g.top,width:g.width,height:g.height}:null,
      region:g?g.region:null,
      thumbFile:(el&&el.__ohsidianThumbFile)||"",
      dpr:g?g.dpr:(window.devicePixelRatio||1),
      pointer:ohsidianPointerMode(),
      mode:ohsidianModeFlag(),
      reason:reason||"",
      theme:themeOut
    };
    var out=nodePath.join(dir,"ohsidian-native-video.json");
    if(ohsidianNativeIpcSend(req))return true;
    return ohsidianWriteJsonAtomic(out,req)&&!!g;
  }catch(e){return false}
}
/* Which sample entry a local MP4 carries. Chromium here ships no HEVC decoder,
   so an hvc1/hev1 track needs the native surface; avc1/avc3 must stay on the
   plain <video> path with no poster, no button and no notice - that identity of
   flow is the point. Only the first/last 256 KiB are scanned (moov may be at
   either end); results are cached per path because the scan runs on every
   mutation batch. */
var __ohsidianCodecCache={};
function ohsidianCodecOf(srcPath){
  try{
    if(!srcPath)return "";
    if(__ohsidianCodecCache[srcPath]!==undefined)return __ohsidianCodecCache[srcPath];
    var fs=require("fs");
    var st=fs.statSync(srcPath);
    var size=st.size;
    if(!(size>0))return "";
    var chunk=262144;
    var fd=fs.openSync(srcPath,"r");
    var read=function(pos,len){
      var b=Buffer.alloc(len);
      var n=0;
      try{n=fs.readSync(fd,b,0,len,pos)}catch(eR){n=0}
      return b.slice(0,n);
    };
    var head=read(0,Math.min(chunk,size));
    var tail=(size>chunk)?read(Math.max(0,size-chunk),Math.min(chunk,size)):Buffer.alloc(0);
    fs.closeSync(fd);
    var s=head.toString("latin1")+tail.toString("latin1");
    var codec="";
    if(s.indexOf("hvc1")>=0||s.indexOf("hev1")>=0)codec="hevc";
    else if(s.indexOf("avc1")>=0||s.indexOf("avc3")>=0)codec="avc";
    __ohsidianCodecCache[srcPath]=codec;
    return codec;
  }catch(e){return ""}
}
function ohsidianEngineCanHevc(el){
  try{
    if(!el||typeof el.canPlayType!=="function")return false;
    return el.canPlayType('video/mp4; codecs="hvc1.1.6.L93.B0"')!=="";
  }catch(e){return false}
}
/* Entry surface. The earlier design put a text button in the corner plus a
   separate preview <img>; that reads as an add-on floating over the note, not
   as Obsidian's own video. The replacement is the video's own box: a poster
   (first decoded frame) fills the exact <video> rect, with one quiet play disc
   centred on it - the same affordance a native <video> shows before playback.
   One tap opens the native surface (which starts playing), so HEVC and AVC are
   entered the same way: look at the frame, tap, watch. */
/* Pointer detection lives in ArkTS: ArkUI's onHover fires for a mouse/trackpad
   and never for a finger. Chromium synthesises compatibility mouse events after
   a touch, so any JS-side probe flipped the poster and the native transport to
   the compact desktop density on a pure touch device - "icons still small"
   even after the sizes were raised. The poster therefore always uses the
   touch-sized disc, matching the native paused disc. */
function ohsidianPointerMode(){
  return false;
}
/* 0 = touch, 1 = desktop/window, -1 = unknown (mode file not ready). The
   ArkTS side hides the surface on a flip and shows it again only after the
   page has relaid out, so a mode switch never paints the old coordinates. */
function ohsidianModeFlag(){
  try{
    var cfg=readMode();
    if(!cfg)return -1;
    var want=resolveWant(cfg);
    if(want===null||want===undefined)return -1;
    return want?0:1;
  }catch(e){return -1}
}
function ohsidianEnsureNativeShell(el,srcPath){
  try{
    if(!el||!srcPath)return;
    el.__ohsidianSrc=srcPath;
    var host=el.closest?el.closest(".internal-embed"):null;
    if(!host)host=el.parentElement;
    if(!host)return;
    try{
      if(getComputedStyle(host).position==="static")host.style.position="relative";
    }catch(eP){}
    var pointer=ohsidianPointerMode();
    var shell=el.__ohsidianNativeBtn;
    if(!shell||!shell.isConnected){
      shell=document.createElement("span");
      shell.className="ohsidian-native-shell";
      // Absolute over the embed box; pointer-events only on this layer so the
      // note keeps scrolling when the finger starts on the poster.
      shell.style.cssText="position:absolute;"+
        "z-index:2147482000;display:block;cursor:pointer;pointer-events:auto;"+
        "overflow:hidden;border-radius:var(--radius-s,4px);"+
        "background:var(--background-primary);-webkit-tap-highlight-color:transparent";
      var poster=document.createElement("img");
      poster.className="ohsidian-native-poster";
      poster.alt="";
      poster.style.cssText="position:absolute!important;inset:0!important;width:100%!important;"+
        "height:100%!important;max-width:none!important;max-height:none!important;"+
        "object-fit:contain!important;display:block;pointer-events:none;"+
        "background:var(--background-primary)";
      var discSize=pointer?44:64;
      var disc=document.createElement("span");
      disc.className="ohsidian-native-disc";
      disc.style.cssText="position:absolute;left:50%;top:50%;width:"+discSize+"px;height:"+discSize+"px;"+
        "margin:"+(-discSize/2)+"px 0 0 "+(-discSize/2)+"px;border-radius:50%;background:rgba(0,0,0,.42);"+
        "display:flex;align-items:center;justify-content:center;pointer-events:none;"+
        "opacity:"+(pointer?"0":"1")+";transition:opacity .12s linear";
      var triW=Math.round(discSize*0.29);
      var triH=Math.round(discSize*0.36);
      var tri=document.createElement("span");
      // Same 13:8 optical ratio as the native paused disc.
      tri.style.cssText="width:0;height:0;border-style:solid;"+
        "border-width:"+(triH/2)+"px 0 "+(triH/2)+"px "+triW+"px;"+
        "border-color:transparent transparent transparent rgba(255,255,255,.92);margin-left:"+
        Math.max(2,Math.round(discSize*0.06))+"px";
      disc.appendChild(tri);
      shell.appendChild(poster);
      shell.appendChild(disc);
      host.appendChild(shell);
      el.__ohsidianNativeBtn=shell;
      el.__ohsidianNativePoster=poster;
      el.__ohsidianNativeDisc=disc;
      if(pointer){
        shell.addEventListener("mouseenter",function(){try{disc.style.opacity="1"}catch(e1){}});
        shell.addEventListener("mouseleave",function(){try{disc.style.opacity="0"}catch(e2){}});
      }
    }
    // Match the shell to the <video> box, not the embed container: padding,
    // borders or a caption on .internal-embed used to shift the centre, and the
    // poster disc then sat on a different axis than the native paused disc.
    try{
      var hr=host.getBoundingClientRect();
      var vr=el.getBoundingClientRect();
      if(vr.width>1&&vr.height>1){
        shell.style.left=Math.round(vr.left-hr.left-host.clientLeft)+"px";
        shell.style.top=Math.round(vr.top-hr.top-host.clientTop)+"px";
        shell.style.width=Math.round(vr.width)+"px";
        shell.style.height=Math.round(vr.height)+"px";
      }
    }catch(eG){}
    // No per-node click listener: Obsidian re-renders can clone/replace the
    // embed and drop listeners. The capture-phase document delegate below
    // reads these properties instead.
    shell.__ohsidianNativeVideo=el;
    shell.__ohsidianNativePath=srcPath;
    ohsidianRequestNativeThumb(el,srcPath,host);
  }catch(e){}
}
function ohsidianThumbMime(buf){
  try{
    if(buf&&buf.length>8&&buf[0]===0x89&&buf[1]===0x50&&buf[2]===0x4e&&buf[3]===0x47)return "image/png";
  }catch(e){}
  return "image/jpeg";
}
/* Deterministic poster cache: name = basename + size + mtime. A second render
   of the same embed (or a reopened note) finds the JPEG and paints instantly
   with no IPC round-trip, which is what made the preview appear "only after
   you open the video once". */
function ohsidianThumbCachePath(srcPath){
  try{
    var remote=require("@electron/remote");
    var fs=require("fs");
    var nodePath=require("path");
    var dir=remote.app.getPath("userData");
    var st=null;
    try{st=fs.statSync(srcPath)}catch(e0){}
    var base=(srcPath.split(/[\\/]/).pop()||"clip");
    var key=base.replace(/[^A-Za-z0-9_.-]/g,"_")+"-"+(st?st.size:0)+"-"+(st?Math.floor(st.mtimeMs):0);
    if(key.length>90)key=key.slice(key.length-90);
    return nodePath.join(dir,"ohsidian-thumb-"+key+".jpg");
  }catch(e){return ""}
}
function ohsidianShowThumbFile(img,file,fs){
  try{
    if(!img||!file)return false;
    if(!fs.existsSync(file))return false;
    if(!(fs.statSync(file).size>0))return false;
    var buf=fs.readFileSync(file);
    var mime=ohsidianThumbMime(buf);
    try{
      img.src=URL.createObjectURL(new Blob([buf],{type:mime}));
    }catch(eB){
      img.src="data:"+mime+";base64,"+buf.toString("base64");
    }
    img.__ohsidianThumbLoaded=true;
    return true;
  }catch(e){return false}
}
function ohsidianRequestNativeThumb(el,srcPath,host){
  try{
    if(!el||!srcPath||!host)return;
    var poster=el.__ohsidianNativePoster;
    if(!poster||!poster.isConnected)return;
    var remote=require("@electron/remote");
    var fs=require("fs");
    var nodePath=require("path");
    var dir=remote.app.getPath("userData");
    var file=ohsidianThumbCachePath(srcPath);
    if(!file)return;
    if(poster.__ohsidianThumbPath===file&&poster.__ohsidianThumbLoaded)return;
    if(poster.__ohsidianThumbPath!==file){
      poster.__ohsidianThumbPath=file;
      poster.__ohsidianThumbAt=Date.now();
      poster.__ohsidianThumbLoaded=false;
      el.__ohsidianThumbFile=file;
    }
    if(ohsidianShowThumbFile(poster,file,fs))return;
    if(poster.__ohsidianThumbTimer)return;
    var tries=0;
    var sentFor="";
    var timer=setInterval(function(){
      tries++;
      try{
        if(!poster.isConnected||tries>40){
          clearInterval(timer);poster.__ohsidianThumbTimer=0;return;
        }
        if(ohsidianShowThumbFile(poster,file,fs)){
          clearInterval(timer);poster.__ohsidianThumbTimer=0;return;
        }
        if(!sentFor){
          // Identity must resolve first: a thumb request without xcomponentId
          // is rejected by Index (it cannot attribute it to a window), which is
          // why the poster sometimes only appeared after the player was opened.
          var xid=ohsidianNativeXComponentId();
          if(!xid)return;
          sentFor=xid;
          var req={
            seq:Math.max(Date.now(),__ohsidianNativeVideoSeq+1),
            ts:Date.now(),
            action:"thumb",
            windowId:ohsidianNativeWindowKey(),
            xcomponentId:xid,
            path:srcPath,
            thumbFile:file,
            rect:null,
            dpr:window.devicePixelRatio||1
          };
          __ohsidianNativeVideoSeq=req.seq;
          ohsidianNativeIpcEnsure();
          if(!ohsidianNativeIpcSend(req)){
            ohsidianWriteJsonAtomic(nodePath.join(dir,"ohsidian-native-video.json"),req);
          }
          return;
        }
        if(tries%8===0)sentFor="";
      }catch(eP){}
    },250);
    poster.__ohsidianThumbTimer=timer;
  }catch(e){}
}
function ohsidianSetNativeHtmlHidden(el,hide){
  try{
    if(!el||!el.style)return;
    if(hide){
      if(!el.__ohsidianHtmlState){
        el.__ohsidianHtmlState={
          controls:el.controls,
          muted:el.muted,
          visibility:el.style.visibility||"",
          opacity:el.style.opacity||""
        };
      }
      try{
        el.controls=false;
        el.muted=true;
        el.pause();
        el.style.visibility="hidden";
        el.style.opacity="0";
      }catch(eH){}
      if(el.__ohsidianThumbImg)el.__ohsidianThumbImg.style.display="none";
      if(el.__ohsidianNativeBtn)el.__ohsidianNativeBtn.style.display="none";
    }else{
      var s=el.__ohsidianHtmlState;
      if(s){
        try{
          el.controls=s.controls;
          el.muted=s.muted;
          el.style.visibility=s.visibility;
          el.style.opacity=s.opacity;
        }catch(eR){}
        el.__ohsidianHtmlState=null;
      }
      // No saved state means this element was never hidden by us; do not
      // overwrite a plugin's own visibility/opacity.
      if(el.__ohsidianThumbImg)el.__ohsidianThumbImg.style.display="block";
      if(el.__ohsidianNativeBtn){
        var sh=el.__ohsidianNativeBtn;
        // The poster shell is a full-box block; the legacy text button was
        // inline-flex. Keep both restorable from the saved markup.
        sh.style.display=(sh.className||"").indexOf("ohsidian-native-shell")>=0?"block":"inline-flex";
      }
    }
  }catch(e){}
}
function ohsidianHandleNativeClosed(){
  if(__ohsidianNativeTrack)ohsidianStopNativeTracking(false);
}
/* OPEN acknowledgement: "write succeeded" is not "ArkTS accepted it". Index
   writes this per-window marker after it has validated identity/rect and
   installed the request; the renderer hides the HTML <video> only then. */
function ohsidianNativeAckPath(identity){
  try{
    var remote=require("@electron/remote");
    var nodePath=require("path");
    var xid=(identity&&identity.xcomponentId!==undefined)?identity.xcomponentId:ohsidianNativeXComponentId();
    if(!xid&&identity&&identity.windowId)xid="win-"+identity.windowId;
    var safe=(xid||"").replace(/[^A-Za-z0-9_.-]/g,"_");
    return nodePath.join(remote.app.getPath("userData"),"ohsidian-native-opened-"+safe+".json");
  }catch(e){return ""}
}
function ohsidianNativeAckMatches(seq,identity){
  try{
    var xid=(identity&&identity.xcomponentId!==undefined)?identity.xcomponentId:ohsidianNativeXComponentId();
    if(!xid&&identity&&identity.windowId)xid="win-"+identity.windowId;
    var fs=require("fs");
    var j=null;
    /* Primary: the per-identity file. */
    var file=ohsidianNativeAckPath(identity);
    if(file&&fs.existsSync(file)){
      try{j=JSON.parse(fs.readFileSync(file,"utf8"))}catch(eAck){j=null}
    }
    /* Fallback: the SHARED ack. The two sides can disagree on the filename
       (ArkTS keys on xcomponentId, we fall back to win-<windowId> when we have
       none), and that mismatch kept a playing surface alive for only 1.2s -
       "close reason=noack" on a loop. The shared file carries both identities,
       so accept it when either field matches what we know. */
    if(!j){
      try{
        var nodePath=require("path");
        var remote=require("@electron/remote");
        var shared=nodePath.join(remote.app.getPath("userData"),"ohsidian-native-opened.json");
        if(fs.existsSync(shared))j=JSON.parse(fs.readFileSync(shared,"utf8"));
      }catch(eShared){j=null}
    }
    if(!j||typeof j.seq!=="number"||j.seq<seq)return false;
    var xidOk=!j.xcomponentId||!xid||j.xcomponentId===xid;
    var wid=(identity&&identity.windowId)?(""+identity.windowId):"";
    var widOk=!j.windowId||!wid||(""+j.windowId)===wid;
    /* Accept when the identity we have actually matches; when neither side
       carries a matching field, the request itself was already identity-checked
       on the ArkTS side, so seq freshness is the remaining gate. */
    return xidOk||widOk;
  }catch(e){return false}
}
function ohsidianConfirmNativeOpen(seq){
  var st=__ohsidianNativeTrack;
  if(!st||st.seq!==seq||st.opened)return;
  st.opened=true;
  if(st.ackTimer){try{clearTimeout(st.ackTimer)}catch(eT){}st.ackTimer=0}
  ohsidianSetNativeHtmlHidden(st.el,true);
}
function ohsidianWaitNativeOpen(st){
  if(!st||!st.running||st.opened)return;
  if(ohsidianNativeAckMatches(st.seq,st.id)){
    ohsidianConfirmNativeOpen(st.seq);
    return;
  }
  st.ackTries++;
  if(st.ackTries>15){
    // No acknowledgement means the request was not accepted (or the ack
    // channel is broken). Keep the HTML visible and close the unconfirmed
    // native request; never trade a maybe-working native surface for a black
    // rectangle with no fallback.
    ohsidianStopNativeTracking(true,"noack");
    return;
  }
  st.ackTimer=setTimeout(function(){ohsidianWaitNativeOpen(st)},80);
}

function ohsidianStopNativeTracking(writeClose,reason){
  var st=__ohsidianNativeTrack;
  if(!st)return;
  st.running=false;
  try{cancelAnimationFrame(st.raf)}catch(e0){}
  if(st.ackTimer){try{clearTimeout(st.ackTimer)}catch(eT){}st.ackTimer=0}
  __ohsidianNativeTrack=null;
  ohsidianSetNativeHtmlHidden(st.el,false);
  if(writeClose){
    try{ohsidianWriteNativeRequest("close",st.el,st.p,st.id,null,reason||"")}catch(e1){}
  }
}
function ohsidianNativeCloseMarked(st){
  try{
    var remote=require("@electron/remote");
    var fs=require("fs");
    var nodePath=require("path");
    var file=nodePath.join(remote.app.getPath("userData"),"ohsidian-native-closed.json");
    if(!fs.existsSync(file))return false;
    var j=JSON.parse(fs.readFileSync(file,"utf8"));
    if(!(j&&j.ts&&st&&st.startedAt&&j.ts>=st.startedAt))return false;
    var id=st.id||{};
    // The close marker is a single shared file. A close in window A must not
    // stop the native player in window B, so require the identities that were
    // captured at open time to agree. Missing fields keep compatibility with
    // markers written by older builds.
    if(j.xcomponentId&&id.xcomponentId&&j.xcomponentId!==id.xcomponentId)return false;
    if(j.windowId&&id.windowId&&(j.windowId+""!==id.windowId+""))return false;
    return true;
  }catch(e){return false}
}
function ohsidianNativeRectEqual(a,b){
  if(!a||!b)return false;
  if(Math.abs(a.left-b.left)>0.35||Math.abs(a.top-b.top)>0.35)return false;
  if(Math.abs(a.width-b.width)>0.35||Math.abs(a.height-b.height)>0.35)return false;
  var ar=a.region||{},br=b.region||{};
  if(Math.abs((ar.left||0)-(br.left||0))>0.35||Math.abs((ar.top||0)-(br.top||0))>0.35)return false;
  if(Math.abs((ar.width||0)-(br.width||0))>0.35||Math.abs((ar.height||0)-(br.height||0))>0.35)return false;
  return true;
}
function ohsidianStartNativeTracking(el,srcPath,identity,seq){
  ohsidianStopNativeTracking(false);
  var st={el:el,p:srcPath,id:identity,running:true,raf:0,last:0,lastRect:null,hidden:false,
    startedAt:Date.now(),lastCloseCheck:0,lastThemeAt:0,seq:seq||0,opened:false,ackTries:0,ackTimer:0,
    writeFails:0};
  __ohsidianNativeTrack=st;
  var loop=function(){
    if(!st.running)return;
    try{
      if(!el.isConnected){ohsidianStopNativeTracking(true,"detached");return}
      if(ohsidianNativeKeyboard()>0){ohsidianStopNativeTracking(true,"keyboard");return}
      if(ohsidianNativeOccluded()){
        ohsidianStopNativeTracking(true,"occluded");return;
      }
      var now=Date.now();
      if(now-st.lastCloseCheck>400){
        st.lastCloseCheck=now;
        if(ohsidianNativeCloseMarked(st)){
          ohsidianStopNativeTracking(false);
          return;
        }
      }
      var g=ohsidianNativeGeometry(el);
      if(!g){
        // Completely outside the allowed region: release the surface instead
        // of leaving a stale frame over the header/toolbar.
        if(st.lastRect!==null){
          if(ohsidianWriteNativeRequest("close",el,srcPath,st.id,null,"offscreen")){
            st.lastRect=null;
            st.writeFails=0;
          }else{
            st.writeFails++;
          }
        }
        st.hidden=true;
      }else if(st.hidden){
        if(__ohsidianNativeIpcReady||now-st.last>=40){
          if(ohsidianWriteNativeRequest("open",el,srcPath,st.id,g)){
            st.hidden=false;
            st.lastRect=g;
            st.last=now;
            st.writeFails=0;
          }else{
            st.writeFails++;
          }
        }
      }else if(!st.opened){
        /* Hold heartbeats until ArkTS acknowledges the open. Writing 'rect' now
           races the un-acked 'open' on the file channel (one shared JSON file),
           so the open is overwritten and the overlay never appears - the
           "close reason=noack" failure. */
      }else if(!st.lastRect||!ohsidianNativeRectEqual(st.lastRect,g)){
        // IPC can carry every display frame; the file fallback stays at 40ms
        // so a degraded path does not hammer the disk.
        if(__ohsidianNativeIpcReady||now-st.last>=40){
          if(ohsidianWriteNativeRequest("rect",el,srcPath,st.id,g)){
            st.lastRect=g;
            st.last=now;
            st.writeFails=0;
          }else{
            st.writeFails++;
          }
        }
      }else if(st.opened&&now-st.lastThemeAt>=1200){
        // Geometry is stable, but the user may have switched theme. A rect
        // request is also the only carrier of the theme payload; send a
        // low-rate heartbeat so CSS variables reach the native controls.
        if(ohsidianWriteNativeRequest("rect",el,srcPath,st.id,g)){
          st.lastThemeAt=now;
          st.writeFails=0;
        }else{
          st.writeFails++;
        }
      }
      if(st.writeFails>6){
        // A permanently failing request channel would otherwise leave a stale
        // native frame over the page with no recovery.
        ohsidianStopNativeTracking(true,"writefail");
        return;
      }
      st.raf=requestAnimationFrame(loop);
    }catch(e){
      ohsidianStopNativeTracking(true,"loop");
    }
  };
  st.raf=requestAnimationFrame(loop);
}
function ohsidianOpenNativePlayer(el,srcPath){
  try{
    if(!srcPath)return;
    if(!el||!el.isConnected)return;
    try{
      var ae=document.activeElement;
      if(ae&&ae!==document.body&&(ae.isContentEditable||/^(INPUT|TEXTAREA)$/.test(ae.tagName||""))){
        ae.blur();
      }
    }catch(eB){}
    var g=ohsidianNativeGeometry(el);
    if(!g){
      var retries=el.__ohsidianOpenRetry||0;
      if(retries<2){
        el.__ohsidianOpenRetry=retries+1;
        try{el.scrollIntoView({block:"center",inline:"nearest"})}catch(eS){}
        setTimeout(function(){
          try{ohsidianOpenNativePlayer(el,srcPath)}catch(eR){}
        },220);
      }
      return;
    }
    el.__ohsidianOpenRetry=0;
    ohsidianEnsureNativeShell(el,srcPath);
    // Capture the window identity once, at open time. Recomputing it on every
    // rect would follow focusedWindow and make a background window's tracker
    // target whichever window was focused last.
    var identity={windowId:ohsidianNativeWindowKey(),xcomponentId:ohsidianNativeXComponentId()};
    if(!ohsidianWriteNativeRequest("open",el,srcPath,identity,g))return;
    var openSeq=__ohsidianNativeVideoSeq;
    ohsidianNativeIpcEnsure();
    // Do not pause/mute/hide the HTML until ArkTS acknowledges that it
    // accepted this exact request. Otherwise an identity/port mismatch leaves
    // a black rectangle with no fallback.
    ohsidianStartNativeTracking(el,srcPath,identity,openSeq);
    ohsidianWaitNativeOpen(__ohsidianNativeTrack);
  }catch(e){}
}
/* Capture-phase delegate: the button itself may be re-created by Obsidian's
   renderer, and a lost per-node click listener was the "sometimes no
   response" failure mode. */
document.addEventListener("click", function(ev){
  try{
    var t=ev.target;
    var btn=t&&t.closest?t.closest(".ohsidian-native-shell"):null;
    if(!btn)return;
    ev.preventDefault();
    ev.stopPropagation();
    var el=btn.__ohsidianNativeVideo;
    var p=btn.__ohsidianNativePath;
    if(!el){
      var host=btn.closest?btn.closest(".internal-embed"):null;
      if(host&&host.querySelector)el=host.querySelector("video");
    }
    if(el&&!el.isConnected){
      var liveHost=btn.closest?btn.closest(".internal-embed"):null;
      var liveVideo=liveHost&&liveHost.querySelector?liveHost.querySelector("video"):null;
      if(liveVideo)el=liveVideo;
    }
    if(el&&!p)p=el.__ohsidianSrc||ohsidianResolveMediaPath(el);
    if(el&&p)ohsidianOpenNativePlayer(el,p);
  }catch(e){}
}, true);
/* Re-attach the persistent entry after Obsidian replaces the embed DOM. */
var __ohsidianNativeScanTimer=0;
function ohsidianScanNativeButtons(){
  try{
    var list=document.querySelectorAll("video");
    for(var i=0;i<list.length;i++){
      var v=list[i];
      var src=v.__ohsidianSrc||ohsidianResolveMediaPath(v);
      if(!src)continue;
      if(v.__ohsidianSrc){ohsidianEnsureNativeShell(v,src);continue}
      // Fresh embed: only HEVC needs an entry. An H.264 video must keep the
      // stock <video> look, so the codec probe decides before any DOM is added.
      try{
        if(ohsidianCodecOf(src)==="hevc")ohsidianEnsureNativeShell(v,src);
      }catch(eC){}
    }
  }catch(e){}
}
function ohsidianScheduleNativeScan(){
  try{
    clearTimeout(__ohsidianNativeScanTimer);
    __ohsidianNativeScanTimer=setTimeout(ohsidianScanNativeButtons,120);
  }catch(e){}
}
try{
  if(typeof MutationObserver!=="undefined"&&document.body){
    var __ohsidianNativeObserver=new MutationObserver(function(records){
      for(var i=0;i<records.length;i++){
        var added=records[i].addedNodes||[];
        for(var j=0;j<added.length;j++){
          var n=added[j];
          if(n&&n.nodeType===1&&(n.tagName==="VIDEO"||(n.querySelector&&n.querySelector("video")))){
            ohsidianScheduleNativeScan();
            return;
          }
        }
      }
    });
    __ohsidianNativeObserver.observe(document.body,{childList:true,subtree:true});
  }
}catch(e){}
/* Wake the receiver once at startup so its 200ms fallback poll can stop. If
   the port file is not published yet, focus/open retries establish it. */
try{setTimeout(function(){try{ohsidianNativeIpcEnsure()}catch(e){}},900)}catch(e){}
try{
  window.addEventListener("focus",function(){
    try{ohsidianNativeIpcEnsure()}catch(e){}
  });
}catch(e){}
/* Editing puts Obsidian's formatting toolbar above the IME. The native
   surface is always above web content, so close it on the first editable
   focus instead of waiting for the keyboard-height update.
   A focus event alone is not proof of a user gesture: mounting/unmounting the
   native XComponent makes ArkUI move window focus, Chromium then re-focuses
   the last editable node and we would close the player that the user just
   tapped ("tap once and the video closes"). Only a focus that follows a real
   pointer/touch on the page counts. */
var __ohsidianPagePointerAt=0;
document.addEventListener("pointerdown",function(){__ohsidianPagePointerAt=Date.now()},true);
document.addEventListener("touchstart",function(){__ohsidianPagePointerAt=Date.now()},true);
document.addEventListener("focusin", function(ev){
  try{
    if(!__ohsidianNativeTrack)return;
    var t=ev.target;
    if(!t)return;
    var tag=(t.tagName||"").toUpperCase();
    if(!(t.isContentEditable||tag==="INPUT"||tag==="TEXTAREA"||tag==="SELECT"))return;
    if(Date.now()-(__ohsidianPagePointerAt||0)>1000)return;
    ohsidianStopNativeTracking(true,"focus");
  }catch(e){}
}, true);
function ohsidianOfferSystemPlayer(el){
  try{
    var p=ohsidianResolveMediaPath(el);
    var openFn=null;
    var nativeFn=null;
    var isVideo=!!(el&&el.tagName&&el.tagName.toUpperCase()==="VIDEO");
    if(p&&isVideo){
      try{ohsidianEnsureNativeShell(el,p)}catch(eB){}
      // B route owns the video failure UX now. Only suppress the Notice when
      // the persistent entry is actually present; if button creation failed,
      // keep the Notice (and its "open built-in player" button) as fallback.
      if(el&&el.__ohsidianNativeBtn&&ohsidianNativeVisible(el.__ohsidianNativeBtn))return;
      nativeFn=function(){try{ohsidianOpenNativePlayer(el,p)}catch(eN){}}
    }
    // The 5-notice cap protects against Notice spam; it must NOT be consumed
    // before the persistent video entry is created, or the 6th HEVC video
    // would have neither a button nor a Notice.
    if(__ohsidianMediaNotices>=5)return;
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
    var n=new Notice(msg,(nativeFn||openFn)?12000:6000);
    if(!n)return;
    __ohsidianMediaNotices++;
    if(nativeFn&&n&&n.noticeEl){
      var nbtn=document.createElement("button");
      nbtn.className="mod-cta";
      nbtn.textContent=zh?"用内置播放器打开（HEVC）":"Open in built-in player (HEVC)";
      nbtn.style.marginTop="6px";
      nbtn.addEventListener("click",function(){try{nativeFn()}catch(eN){}try{n.hide()}catch(eH){}});
      n.noticeEl.appendChild(nbtn);
    }
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
/* Round 95c, device-log follow-up: with the platform codec bridge engaged
   the engine's decoder init can HANG instead of reporting failure - the
   element keeps "playing" muted with zero decoded frames and NEVER fires
   an error event (hilog: OH_VideoDecoder_Configure invalid argument,
   then ~10s of MutePlaying). The error listener above can therefore stay
   silent for exactly the case it was built for. Watch local media after
   metadata: 8s with metadata but no decoded frame (video: no videoWidth;
   audio: readyState below HAVE_CURRENT_DATA) means the pipeline is hung -
   fire the same guidance. Remote/buffering cases are filtered by the
   internal-embed/file-source restriction and the 8s window. */
/* A paused local audio/video with only metadata is not a decoder hang. The 8s
   watcher must only judge media that the user/autoplay actually tried to play;
   otherwise every "preload=metadata" MP3 gets a false "unsupported" Notice. */
document.addEventListener("play",function(ev){
  try{
    var el=ev.target;
    if(el&&el.tagName&&/^(VIDEO|AUDIO)$/.test(el.tagName.toUpperCase())){
      el.__ohsidianPlayAttempted=true;
    }
  }catch(e){}
},true);
document.addEventListener("loadedmetadata",function(ev){
  try{
    var el=ev.target;
    if(!el||!el.tagName)return;
    var tag=el.tagName.toUpperCase();
    if(tag!=="VIDEO"&&tag!=="AUDIO")return;
    if(el.__ohsidianWatched)return;
    var local=!!(el.closest&&el.closest(".internal-embed"));
    var src=(el.currentSrc||el.src||"");
    if(src.indexOf("file://")===0)local=true;
    if(!local)return;
    el.__ohsidianWatched=true;
    // The persistent entry must exist before the user presses play; otherwise
    // a paused (preload=metadata) HEVC embed has neither an entry nor a Notice
    // now that the 8s watcher correctly ignores untouched paused media.
    if(tag==="VIDEO"){
      try{
        var nativePath=ohsidianResolveMediaPath(el);
        // No canPlayType gate: this engine answers optimistically for hvc1 and
        // then fails to decode, which silently dropped the poster ("even the
        // pre-entry preview disappeared"). Unknown codec waits for the
        // error/hang watcher, so an H.264 embed never gets an extra layer.
        if(nativePath&&ohsidianCodecOf(nativePath)==="hevc"){
          ohsidianEnsureNativeShell(el,nativePath);
        }
      }catch(eBtn){}
    }
    setTimeout(function(){
      try{
        if(!el.isConnected||el.error||el.__ohsidianMediaNoticed)return;
        if(el.paused&&!(el.currentTime>0)&&!el.__ohsidianPlayAttempted)return;
        var hasFrame=(el.tagName.toUpperCase()==="VIDEO")?(el.videoWidth>0):(el.readyState>=2);
        if(hasFrame)return;
        if(el.readyState<1)return; /* metadata not even there - not the hang shape */
        el.__ohsidianMediaNoticed=true;
        ohsidianOfferSystemPlayer(el);
      }catch(e){}
    },8000);
  }catch(e){}
},true);
/* Back-press consumer (round 96; ladder round 104; root exit round 105).
   The @Entry pages (Index/WindowNode) consume the system back gesture in
   onBackPress (previously the gesture DESTROYED the hosting ability - the
   reported "侧划直接退出") and publish cfg.backPress={seq,ts,windowId} into
   the mode file. Ladder, highest first (ordered the way mobile Obsidian's
   own back button behaves): close the top overlay with a synthetic Escape
   -> close the mobile tab switcher -> close the mobile drawer / sidebar ->
   Obsidian navigate-back -> report "nothing was consumed".
   Round 105 (user decision): that last case is no longer silent. The ack
   rides the same mode file (cfg.backAck={seq,handled}) and carries the
   verdict of THIS seq only, so a stale ack can never fire; the ArkTS page
   waits ~350ms for it and, when the renderer consumed nothing while in
   touch mode, tears the ability down (terminateSelf) - back at the ROOT
   exits the app like every native HarmonyOS app, which is what round 104
   left as the residual "no response".
   Identity: touch mode trusts the single visible window (the same rule
   focusedEntry() uses for the keyboard and the safe area); desktop/PC mode
   keeps the document.hasFocus() guard because several windows are visible
   and only the focused one may act. Round 104 moved the seq advance AFTER
   that gate - it used to run before, so one false focus reading dropped
   that gesture permanently.
   Notes: synthetic KeyboardEvent cannot carry keyCode (init dict ignored,
   reads back 0) - Obsidian's Scope/Modal Escape handling matches on key,
   so the event is dispatched ON the overlay element itself, which reaches
   container-scoped AND document/window-scoped listeners through the
   bubble path. lastBackSeq seeds from the file ONCE at boot (not lazily -
   a lazy seed would swallow the first gesture when the field is absent)
   so a stale entry left by a previous session never fires a phantom back;
   the ArkTS writer is monotonic against the published file, so seq keeps
   rising across restarts. Root detection reads leaf history, NOT
   view.navigation truthiness: app:go-back's checkCallback only requires a
   navigation object, and History.go(-1) with an empty backHistory neither
   loops nor navigates (it returns once n===t). */
var lastBackSeq=(function(){try{var b=(readMode()||{}).backPress;return (b&&typeof b.seq==="number")?b.seq:0}catch(e){return 0}})();
/* Publish the verdict for this gesture. RMW is safe: the ArkTS side writes
   the mode file only when it ACTS (a gesture, a geometry/focus change),
   never in a tight loop, and both sides publish with atomic rename. */
function ackBackPress(seq,handled){
  try{
    var c=readMode()||{};
    c.backAck={seq:seq,handled:!!handled,ts:Date.now()};
    writeModeFileSync(c);
  }catch(e){}
}
/* One pass of the ladder; returns true when the app consumed the gesture. */
function backLadder(touch){
  /* .lightbox = the image/media viewer (lightbox-bg/-content/-media are its
     children); it pushes a handler on the same mobile back stack as a modal,
     so it belongs in the overlay rung. Leaving it out both skipped the close
     and, since round 105, mis-reported "nothing consumed" (the page would
     have exited with the viewer open). */
  var overlay=document.querySelector('.modal-container,.modal-bg,.suggestion-container,.menu,.prompt,.lightbox');
  if(overlay){
    try{
      var e={key:'Escape',code:'Escape',bubbles:true,cancelable:true};
      var t=(overlay.querySelector&&overlay.querySelector("input,textarea"))||overlay;
      t.dispatchEvent(new KeyboardEvent('keydown',e));
      t.dispatchEvent(new KeyboardEvent('keyup',e));
    }catch(e1){}
    return true;
  }
  /* Round 104: the mobile tab switcher is a transient fullscreen overlay
     (isVisible, detached on hide). It was not in the modal selectors either,
     so back fell through to app:go-back and the switcher stayed open. */
  var sw=window.app&&window.app.mobileTabSwitcher;
  if(sw&&sw.isVisible===true){
    try{if(typeof sw.hide==="function")sw.hide();else if(typeof sw.close==="function")sw.close()}catch(eS){}
    return true;
  }
  /* Round 104: the mobile drawer / sidebar. Its open state is the workspace
     container class is-<side>-sidedock-open (SideDock and the mobile Drawer
     add it in expand()/onExpand(); collapse()/onCollapse() remove it). The
     modal selectors never matched it, so back fell through to app:go-back,
     and History.go(-1) with an empty backHistory is a silent no-op: the
     reported "侧滑完全没反应". Desktop adds this class at construction (both
     sidebars start expanded), so this branch is touch-only. */
  var ws=window.app&&window.app.workspace;
  if(touch&&ws&&ws.containerEl&&ws.containerEl.classList){
    try{
      var cl=ws.containerEl.classList;
      if(cl.contains("is-left-sidedock-open")&&ws.leftSplit&&typeof ws.leftSplit.collapse==="function"&&ws.leftSplit.collapsed!==true){ws.leftSplit.collapse();return true}
      if(cl.contains("is-right-sidedock-open")&&ws.rightSplit&&typeof ws.rightSplit.collapse==="function"&&ws.rightSplit.collapsed!==true){ws.rightSplit.collapse();return true}
    }catch(eD){}
  }
  var cmds=window.app&&window.app.commands&&window.app.commands.commands;
  if(cmds&&window.app.commands.executeCommandById){
    var id=cmds["app:go-back"]?"app:go-back":"";
    if(!id){var ks=Object.keys(cmds);for(var i=0;i<ks.length;i++){if(/go-back|navigate-back/.test(ks[i])){id=ks[i];break}}}
    if(id){
      /* Round 105: decide "did that navigate?" BEFORE executing - leaf
         history is the only truthful signal (the command itself reports
         success as long as a navigation object exists). */
      var canBack=false;
      try{
        var leaf=ws&&ws.activeLeaf;
        var hist=leaf&&(leaf.history||(leaf.view&&leaf.view.navigation));
        canBack=!!(hist&&hist.backHistory&&hist.backHistory.length>0);
      }catch(eH){}
      try{window.app.commands.executeCommandById(id)}catch(e2){}
      return canBack;
    }
  }
  return false;
}
function applyBackPress(){
  try{
    var cfg=readMode();if(!cfg)return;
    var bp=cfg.backPress;
    if(!bp||typeof bp.seq!=="number")return;
    if(bp.seq<=lastBackSeq)return;
    var touch=false;
    try{touch=resolveWant(cfg)===true}catch(e0){}
    if(!touch){try{if(!document.hasFocus())return}catch(eF){}}
    lastBackSeq=bp.seq;
    var handled=false;
    try{handled=backLadder(touch)===true}catch(eL){}
    ackBackPress(bp.seq,handled);
  }catch(e){}
}
/* Delete-dialog destination note, called from the patched dialog site
   (see APP_BODY_PATCHES). Reflects where the trash hook will actually put
   the file: the relocated Documents trash when cfg.documentsDir is
   granted, the hidden in-vault .trash otherwise - both auto-purged after
   30 days. Language follows Obsidian's localStorage language setting
   (zh default on this port); null falls back to the stock notice. */
window.__ohsidianTrashNote=function(){
  try{
    var cfg=readMode();
    var docs=documentsDirPath(cfg);
    var v=window.app&&window.app.vault;
    var name=(v&&typeof v.getName==="function"&&v.getName())||"vault";
    var lang="zh";
    try{var l=localStorage.getItem("language");if(l&&/^en/i.test(l))lang="en"}catch(eL){}
    if(docs)return "zh"===lang
      ?"文件将优先移至 文档/OHSidianTrash/"+name+"/（30 天后自动清除）；若文档回收站不可用会回退到仓库内 .trash，并提示实际去向。"
      :"Moved to Documents/OHSidianTrash/"+name+"/ when available (auto-purged after 30 days); otherwise falls back to the vault's hidden .trash with a notice.";
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
       (vault.trash updates its index once the promise resolves).

       Data-safety rewrite (2026-10-19):
       - the Documents move falls back to copyTree+remove when rename fails
         (EXDEV: a sandbox vault and /storage/Users/.../Documents are different
         mounts), instead of silently leaving the file in the hidden .trash;
       - the vault-local fallback is performed HERE too (not by the stock
         trashLocal), so EVERY moved file gets a deletion timestamp - the
         purge used the original content mtime otherwise and could unlink a
         just-deleted old note on the next launch;
       - an owner marker is written so the purge only cleans trashes that this
         feature created (never a user/plugin .trash). */
    var ad=v.adapter;
    if(!ad||typeof ad.trashLocal!=="function"||ad.__ohsidianTrashRelocate)return;
    ad.__ohsidianTrashRelocate=true;
    var origLocal=ad.trashLocal;
    var pathMod=require("path"),fsMod=require("fs");
    var metaSuffix=".ohsidian-trash-meta.json";
    var ownerFile=".ohsidian-trash-owner.json";
    var ownerStamp=function(root){
      try{
        var marker=pathMod.join(root,ownerFile);
        if(!fsMod.existsSync(marker)){
          fsMod.writeFileSync(marker,JSON.stringify({owner:"OHSidian",createdAt:Date.now()}),"utf8");
        }
      }catch(eO){}
    };
    var stampOne=function(p){
      try{var now=new Date();fsMod.utimesSync(p,now,now);return}
      catch(eU){
        try{fsMod.writeFileSync(p+metaSuffix,JSON.stringify({deletedAt:Date.now()}),"utf8")}catch(eM){}
      }
    };
    var stampTree=function(p,depth){
      if(depth>64)return;
      try{
        var st=fsMod.lstatSync(p);
        if(st.isDirectory()&&!st.isSymbolicLink()){
          var names=[];try{names=fsMod.readdirSync(p)}catch(eR){names=[]}
          for(var i=0;i<names.length;i++)stampTree(pathMod.join(p,names[i]),depth+1);
          stampOne(p);
        }else if(!st.isSymbolicLink()){
          stampOne(p);
        }
      }catch(eS){}
    };
    var uniqueDest=function(dir,name){
      var ext=pathMod.extname(name),stem=pathMod.basename(name,ext);
      var dest=pathMod.join(dir,name);
      for(var n=2;fsMod.existsSync(dest);n++){
        dest=pathMod.join(dir,stem+" ("+n+")"+ext);
      }
      return dest;
    };
    var removeTreeSync=function(p,depth){
      if(depth>64)return;
      var st;try{st=fsMod.lstatSync(p)}catch(eL){return}
      if(st.isDirectory()&&!st.isSymbolicLink()){
        var names=[];try{names=fsMod.readdirSync(p)}catch(eR){names=[]}
        for(var i=0;i<names.length;i++)removeTreeSync(pathMod.join(p,names[i]),depth+1);
        try{fsMod.rmdirSync(p)}catch(eD){}
      }else{
        try{fsMod.unlinkSync(p)}catch(eU){}
      }
    };
    var copyTreeSync=function(s,d,depth){
      if(depth>64)throw new Error("trash move: nesting too deep");
      var st=fsMod.lstatSync(s);
      if(st.isSymbolicLink()){
        /* Preserve the link itself instead of silently dropping it; if the
           platform cannot create one, throw so the caller falls back to the
           same-filesystem rename (which keeps the link). */
        var linkTarget=fsMod.readlinkSync(s);
        fsMod.symlinkSync(linkTarget,d);
        return;
      }
      if(st.isDirectory()){
        fsMod.mkdirSync(d,{recursive:true});
        var names=fsMod.readdirSync(s);
        for(var i=0;i<names.length;i++){
          copyTreeSync(pathMod.join(s,names[i]),pathMod.join(d,names[i]),depth+1);
        }
      }else{
        fsMod.copyFileSync(s,d);
        try{fsMod.utimesSync(d,st.atime,st.mtime)}catch(eT){}
      }
    };
    var moveSync=function(src,dest){
      try{fsMod.renameSync(src,dest);return true}
      catch(eR){
        try{
          var st=fsMod.lstatSync(src);
          if(st.isDirectory()&&!st.isSymbolicLink()){copyTreeSync(src,dest,0);removeTreeSync(src,0)}
          else if(st.isSymbolicLink()){return false}
          else{fsMod.copyFileSync(src,dest);fsMod.unlinkSync(src)}
          return true;
        }catch(eC){
          try{console.warn("[OHSidian] trash cross-device move failed:",eC&&eC.message||eC)}catch(eW){}
          try{removeTreeSync(dest,0)}catch(eX){}
          return false;
        }
      }
    };
    var reconcile=function(rel){
      try{
        if(typeof ad.reconcileInternalFile==="function")return ad.reconcileInternalFile(rel);
      }catch(eRc){}
      return Promise.resolve();
    };
    var stampFallbackEntry=function(relText,baseResolved){
      try{
        var dir=pathMod.join(baseResolved,".trash",pathMod.dirname(relText));
        var targetName=pathMod.basename(relText);
        var names=fsMod.readdirSync(dir);
        for(var i=0;i<names.length;i++){
          var nm=names[i];
          var looksSame=(nm===targetName||nm.indexOf(targetName+" ")===0||nm.indexOf(targetName+".")===0);
          if(!looksSame)continue;
          var fp=pathMod.join(dir,nm);
          var st=fsMod.lstatSync(fp);
          /* Only stamp entries this delete just produced (engine naming may
             differ on collisions). */
          if(Date.now()-(st.ctimeMs||0)<120000)stampTree(fp,0);
        }
      }catch(eS){}
    };
    var localFallback=function(rel,baseResolved){
      var res;
      try{res=origLocal.call(ad,rel)}catch(e){return Promise.resolve()}
      var relText=typeof rel==="string"?rel.trim():"";
      if(relText&&baseResolved)try{stampFallbackEntry(relText,baseResolved)}catch(eS){}
      if(res&&typeof res.then==="function"){
        return res.then(function(v){
          if(relText&&baseResolved)try{stampFallbackEntry(relText,baseResolved)}catch(eS){}
          return v;
        });
      }
      return res;
    };
    ad.trashLocal=function(rel){
      try{
        var base=typeof ad.getBasePath==="function"?ad.getBasePath():(ad.basePath||"");
        var relText=typeof rel==="string"?rel.trim():"";
        if(!base||!relText){
          try{console.warn("[OHSidian] trash relocate refused empty path:",rel)}catch(eW0){}
          return Promise.resolve();
        }
        var baseResolved=pathMod.resolve(base);
        var src=pathMod.resolve(baseResolved,relText);
        /* S2: canonicalize and confine STRICTLY. rel comes from vault.trash
           (normalized), but a plugin can call adapter.trashLocal directly with
           ".." segments or "."; equality with the vault root must be rejected
           too (rel="." used to rename the whole vault into the trash). */
        if(src.indexOf(baseResolved+pathMod.sep)!==0){
          try{console.warn("[OHSidian] trash relocate refused escaping path:",rel)}catch(eW){}
          return Promise.resolve();
        }
        if(!fsMod.existsSync(src))return localFallback(rel,baseResolved);
        var docs=documentsDirPath(readMode());
        if(docs){
          var name=(typeof v.getName==="function"&&v.getName())||pathMod.basename(base);
          name=String(name).replace(/[\\\/:*?\"<>|]/g,"_").replace(/^\.+$/,"_")||"vault";
          var trashRoot=pathMod.resolve(docs,"OHSidianTrash");
          var targetRoot=pathMod.resolve(trashRoot,name);
          var destDir=pathMod.join(targetRoot,pathMod.dirname(relText));
          var resolvedDest=pathMod.resolve(destDir);
          if(resolvedDest!==targetRoot&&resolvedDest.indexOf(targetRoot+pathMod.sep)!==0){
            try{console.warn("[OHSidian] trash relocate refused escaping path:",rel)}catch(eW2){}
            return Promise.resolve();
          }
          try{
            fsMod.mkdirSync(destDir,{recursive:true});
            ownerStamp(trashRoot);
            var dest=uniqueDest(destDir,pathMod.basename(src));
            if(moveSync(src,dest)){
              stampTree(dest,0);
              return reconcile(rel);
            }
          }catch(eDoc){
            try{console.warn("[OHSidian] trash relocate to Documents failed:",eDoc&&eDoc.message||eDoc)}catch(eW3){}
          }
        }
        var localRoot=pathMod.join(baseResolved,".trash");
        var localDir=pathMod.join(localRoot,pathMod.dirname(relText));
        fsMod.mkdirSync(localDir,{recursive:true});
        ownerStamp(localRoot);
        var localDest=uniqueDest(localDir,pathMod.basename(src));
        if(moveSync(src,localDest)){
          stampTree(localDest,0);
          if(docs){
            try{new Notice("OHSidian: 文档回收站不可用，文件已移至仓库内隐藏 .trash（30 天内可恢复）")}catch(eN){}
          }
          return reconcile(rel);
        }
        return localFallback(rel,baseResolved);
      }catch(e){
        try{console.warn("[OHSidian] trash relocate failed, local fallback:",e&&e.message||e)}catch(e2){}
        return localFallback(rel,baseResolved);
      }
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
/* BUG-001 guard. "The article follows the user" must never drag a MEDIA/binary
   file into a markdown leaf: Leaf.setViewState() resolves the view from
   state.type and never re-checks the extension, so a path written here is
   opened by MarkdownView/TextFileView and decoded as UTF-8 (a 334 MB video =>
   a minute-long freeze and a page full of replacement characters). A blacklist
   is used instead of a whitelist so exotic TEXT formats keep the old
   "article follows" behaviour. */
var OHSIDIAN_BINARY_EXT=",mp4,m4v,mkv,webm,ogv,ogm,mov,avi,wmv,flv,3gp,mpg,mpeg,m2ts,"+
  "mp3,m4a,aac,wav,flac,ogg,oga,opus,wma,aiff,"+
  "png,jpg,jpeg,gif,webp,bmp,tif,tiff,ico,heic,avif,svg,"+
  "pdf,epub,mobi,azw3,djvu,doc,docx,xls,xlsx,ppt,pptx,odt,ods,odp,rtf,"+
  "zip,rar,7z,gz,bz2,xz,iso,dmg,exe,msi,apk,hap,";
function ohsidianLeafAcceptsPath(p){
  try{
    var s=String(p||"");
    var i=s.lastIndexOf(".");
    if(i<0||i===s.length-1)return true;
    var ext=s.slice(i+1).toLowerCase();
    return OHSIDIAN_BINARY_EXT.indexOf(","+ext+",")<0;
  }catch(e){return true}
}
/* Writes the active path into a markdown leaf, or SCRUBS a stale binary path an
   older build already left there (the damage persists in workspace-mobile.json
   otherwise, so every touch-mode boot reopens the video as text). Returns true
   only when the layout actually changed. */
function ohsidianSetLeafFile(st,path){
  try{
    if(!st||typeof st.state!=="object"||st.state===null)return false;
    var cur=st.state.file;
    if(ohsidianLeafAcceptsPath(path)){
      if(cur===path)return false;
      st.state.file=path;
      return true;
    }
    if(typeof cur==="string"&&cur&&!ohsidianLeafAcceptsPath(cur)){
      try{delete st.state.file}catch(eD){st.state.file=null}
      try{console.warn("[OHSidian] dropped binary path from a markdown leaf:",cur)}catch(eL){}
      return true;
    }
    return false;
  }catch(e){return false}
}
/* Last line of defense for BUG-001. The damage that destroyed a ~182 MiB video
   was a text view saving its UTF-8 rendering back over the original bytes.
   Every guard above removes a known cause (extension filter on the layout
   write, scrub of stale paths, skip-save of non-text views); this one removes
   the CLASS: a write is refused when ALL of
     - the target has a media/binary extension (the blacklist above),
     - the file currently on disk is binary (a NUL byte within the first 64),
     - and the payload about to be written is text (not a single NUL byte).
   Legit saves never hit this: notes are not in the blacklist, and Obsidian
   never writes a media file as text. The write is skipped and reported, so the
   bytes on disk stay intact - a lost save is recoverable, a rewritten video
   is not. */
function ohsidianInstallWriteGuard(){
  try{
    var fsMod=require("fs");
    if(!fsMod||fsMod.__ohsidianWriteGuard)return false;
    var headIsBinary=function(p){
      try{
        var fd=fsMod.openSync(p,"r");
        try{
          var b=Buffer.alloc(64);
          var n=fsMod.readSync(fd,b,0,64,0);
          for(var i=0;i<n;i++){if(b[i]===0)return true}
          return false;
        }finally{
          try{fsMod.closeSync(fd)}catch(eC){}
        }
      }catch(e){return false}
    };
    var payloadIsText=function(data){
      try{
        var buf=null;
        if(Buffer.isBuffer(data))buf=data;
        else if(typeof data==="string")buf=Buffer.from(data,"utf8");
        else if(data instanceof Uint8Array)buf=Buffer.from(data.buffer,data.byteOffset,data.byteLength);
        else return false;
        for(var i=0;i<buf.length;i++){if(buf[i]===0)return false}
        return true;
      }catch(e){return false}
    };
    var block=function(p){
      try{console.error("[OHSidian] blocked text write over binary file:",p)}catch(e){}
      try{new Notice("OHSidian: 已阻止把文本写进媒体文件（"+p+"），文件未被改动",9000)}catch(e2){}
    };
    var check=function(p,data){
      try{
        if(typeof p!=="string"||!p)return false;
        if(ohsidianLeafAcceptsPath(p))return false;
        if(!payloadIsText(data))return false;
        if(!headIsBinary(p))return false;
        block(p);
        return true;
      }catch(e){return false}
    };
    /* Overwrite insurance (BUG-001). The write guard above only catches the
       "text over binary" signature; this one covers every OTHER way a binary
       file could be rewritten (a plugin, a future bug we cannot imagine). It
       copies the CURRENT bytes aside before the first overwrite of that path
       in this session, so a wrong write costs one restore instead of the file.
       Deduped per path, size-capped, and pruned to the newest few, because
       media files are large and rare - we are not building a version history,
       just a last-resort copy. */
    var snapshotDir="";
    var snapshotDirFor=function(){
      if(snapshotDir)return snapshotDir;
      try{
        var np=require("path"),remote=require("@electron/remote");
        snapshotDir=np.join(remote.app.getPath("userData"),"ohsidian-snapshots");
        try{fsMod.mkdirSync(snapshotDir,{recursive:true})}catch(eM){}
      }catch(e){snapshotDir=""}
      return snapshotDir;
    };
    /* Storage budget for the overwrite insurance. A snapshot is a FULL COPY, so
       the policy has to bound the directory, not just each file: one media file
       can be hundreds of megabytes and six of them would be gigabytes. Three
       numbers, all enforced together:
         SNAP_MAX_FILE - larger files are not copied (a 2 GB copy freezes the UI
                         for seconds and is not worth the space);
         SNAP_BUDGET   - total bytes across the whole directory;
         SNAP_KEEP     - newest entries kept, whatever their size.
       Plus a free-space check before copying (256 MiB headroom), so the guard
       never fills the disk on its own. Every refusal is logged. */
    var SNAP_MAX_FILE=1024*1024*1024;      /* 1 GiB per file */
    var SNAP_BUDGET=1536*1024*1024;        /* 1.5 GiB total */
    var SNAP_KEEP=3;                       /* newest entries */
    var snapshotsTaken={};
    var listSnapshots=function(dir){
      var list=[];
      try{
        var names=fsMod.readdirSync(dir);
        for(var i=0;i<names.length;i++){
          var f=dir+"/"+names[i],st=null;
          try{st=fsMod.statSync(f)}catch(e){continue}
          if(st&&st.isFile())list.push({f:f,t:st.mtimeMs||0,s:st.size||0});
        }
        list.sort(function(a,b){return b.t-a.t});
      }catch(e){}
      return list;
    };
    var pruneSnapshots=function(dir,need){
      try{
        var list=listSnapshots(dir);
        var total=0;
        for(var i=0;i<list.length;i++)total+=list[i].s;
        /* drop oldest (end of the mtime-desc list) until both bounds hold */
        for(var k=list.length-1;k>=0;k--){
          if(list.length<=SNAP_KEEP&&(total+need)<=SNAP_BUDGET)break;
          try{fsMod.unlinkSync(list[k].f)}catch(eU){}
          total-=list[k].s;
          list.pop();
        }
      }catch(e){}
    };
    var snapshotBefore=function(p){
      try{
        if(typeof p!=="string"||!p)return;
        if(ohsidianLeafAcceptsPath(p))return;      /* text targets: Obsidian owns them */
        if(snapshotsTaken[p])return;
        var st=null;
        try{st=fsMod.lstatSync(p)}catch(e){return}  /* new file: nothing to save */
        if(!st||!st.isFile()||st.size<=0)return;
        if(st.size>SNAP_MAX_FILE){
          try{console.warn("[OHSidian] snapshot skipped (too large):",p,st.size)}catch(eL){}
          snapshotsTaken[p]=1;                      /* do not retry every write */
          return;
        }
        var dir=snapshotDirFor();
        if(!dir)return;
        try{
          if(typeof fsMod.statfsSync==="function"){
            var sfs=fsMod.statfsSync(dir);
            var free=(sfs.bavail!==undefined?sfs.bavail:sfs.bfree)*(sfs.bsize||4096);
            if(free<st.size+256*1024*1024){
              try{console.warn("[OHSidian] snapshot skipped (low space):",p)}catch(eS){}
              snapshotsTaken[p]=1;
              return;
            }
          }
        }catch(eFs){}
        pruneSnapshots(dir,st.size);
        var np2=require("path");
        var dst=np2.join(dir,np2.basename(p)+"-"+Date.now()+".bak");
        fsMod.copyFileSync(p,dst);
        snapshotsTaken[p]=1;
        try{console.warn("[OHSidian] snapshot before overwrite:",p,"->",dst)}catch(eL){}
      }catch(e){}
    };
    var wrapSync=function(name){
      var orig=fsMod[name];
      if(typeof orig!=="function")return;
      fsMod[name]=function(p,data){
        if(check(p,data))return;
        snapshotBefore(p);
        return orig.apply(fsMod,arguments);
      };
    };
    wrapSync("writeFileSync");
    if(fsMod.promises&&typeof fsMod.promises.writeFile==="function"){
      var origP=fsMod.promises.writeFile;
      fsMod.promises.writeFile=function(p,data){
        if(check(p,data))return Promise.resolve();
        snapshotBefore(p);
        return origP.apply(fsMod.promises,arguments);
      };
    }
    fsMod.__ohsidianWriteGuard=1;
    try{console.log("[OHSidian] text-over-binary write guard installed")}catch(e3){}
    return true;
  }catch(e){return false}
}
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
          if(ohsidianSetLeafFile(st,active.path))changed++;
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
              if(ohsidianSetLeafFile(st,active.path))touched++;
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
                if(ohsidianSetLeafFile(st,active.path))touched++;
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
applyToolbarHitFix();
hookTrash();
applyKeyboard();
watchBodyStyles();
document.addEventListener("DOMContentLoaded",function(){applySafeArea();applyWindowDecor();applySystemFonts();applyToolbarHitFix();hookTrash();applyKeyboard()});
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
/* Touch mode is single-window by design, but the engine's vault-open IPC
   always creates a NEW BrowserWindow (a separate OHOS mission). The chooser
   window then closes itself, and HarmonyOS restores focus to the mission that
   was active BEFORE the new one - the OLD vault window - so the user is left
   looking at the vault they just left and has to swipe/switch missions by
   hand ("在仓库管理页面选择仓库,窗口没有到新开的仓库,还是旧的").
   There is no API (this SDK has no moveAbilityToForeground) to raise a
   background mission, so the deterministic fix is the one the user did by
   hand: the newly opened vault window closes its siblings. Once the old
   window is gone, focus has nowhere else to go. Only vault windows do this -
   the starter chooser (starter.html) is excluded, and desktop/PC mode keeps
   multi-window behaviour. */
function reapSiblingVaultWindows(){
  try{
    if(location.href.indexOf("starter.html")>=0)return;
    var tries=0;
    var tick=function(){
      tries++;
      var again=false;
      try{
        var cfg=readMode();
        if(!cfg||cfg.systemMode===undefined){
          /* Mode file not readable yet (ArkTS write still in flight): retry
             and never act on an unknown mode - closing windows on a guess is
             not recoverable. */
          again=tries<6;
        }else if(cfg.systemMode==="touch"){
          var rem=require("@electron/remote");
          var BW=(rem&&rem.BrowserWindow)||(rem&&rem.getGlobal&&rem.getGlobal("BrowserWindow"));
          var cur=(rem&&rem.getCurrentWindow)?rem.getCurrentWindow():null;
          if(BW&&cur&&cur.id!==undefined&&cur.id!==null){
            /* Raise ourselves first: if the engine maps show()/moveTop() onto
               a window raise, this alone fixes the foreground, and it also
               means closing the old window cannot strand focus on an empty
               desktop. */
            try{if(cur.isVisible&&!cur.isVisible())cur.show()}catch(e0){}
            try{cur.moveTop()}catch(e1){}
            try{cur.focus()}catch(e2){}
            var others=BW.getAllWindows().filter(function(w){
              try{
                if(w.id===cur.id)return false;
                var u=(w.webContents&&w.webContents.getURL)?String(w.webContents.getURL()):"";
                if(/starter\.html|help|sandbox|devtools/i.test(u))return false;
                return true;
              }catch(e3){return false}
            });
            if(others.length){
              /* Do not close while this window may still be unmapped: the
                 system plays its "app leaves, the icon flies home" exit
                 animation when the last VISIBLE window of the app goes away,
                 which is the flash seen behind the switch. Wait (bounded) until
                 this window reports itself on screen, then take the siblings
                 off screen BEFORE terminating them: terminateSelf() on an
                 already backgrounded ability has no on-screen window left to
                 animate, so the old vault disappears without the transition. */
              var onScreen=true;
              try{if(cur.isVisible)onScreen=!!cur.isVisible()}catch(e4){}
              if(!onScreen&&tries<6){
                again=true;
              }else{
                for(var i=0;i<others.length;i++){
                  try{if(others[i].hide)others[i].hide()}catch(e5){}
                }
                (function(list){
                  setTimeout(function(){
                    for(var j=0;j<list.length;j++){
                      try{
                        if(!(list[j].isDestroyed&&list[j].isDestroyed()))list[j].close();
                      }catch(e6){}
                    }
                  },350);
                })(others);
                /* Keep retrying: close() is asynchronous, a sibling may refuse
                   to close (beforeunload) or a second vault window may appear. */
                again=tries<6;
              }
            }
          }
        }
      }catch(e5){
        again=tries<6;
      }
      if(again)setTimeout(tick,400);
    };
    setTimeout(tick,400);
  }catch(e){}
}
reapSiblingVaultWindows();
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
    if(globalThis.__ohsidianMigrating){try{new Notice("OHSidian: 迁移正在进行中，请稍候")}catch(e){}return}
    /* If the current vault lives in the app sandbox (userData, wiped on
       uninstall) and the Documents root is available, offer the ONE-TAP
       default migration: copy to <documents>/OHSidian/<当前仓库名> and
       reopen. Otherwise fall back to the directory picker. */
    var remote=require("@electron/remote");
    if(!remote||!remote.dialog){try{new Notice("OHSidian: 无法调起文件夹选择器")}catch(e){}return}
    var fsMod=require("fs"),pathMod=require("path");
    var flushEditors=function(){
      try{
        if(window.app&&window.app.workspace&&typeof window.app.workspace.iterateAllLeaves==="function"){
          window.app.workspace.iterateAllLeaves(function(leaf){
            try{
              /* BUG-001: never let a text view write a media file back. If a
                 markdown leaf ever points at a video - which is what the
                 layout sync used to produce - save() re-encodes the raw bytes
                 as text, and that is exactly how a 182 MiB sample in this
                 round was destroyed. */
              var vf=(leaf&&leaf.view&&leaf.view.file&&leaf.view.file.path)?leaf.view.file.path:"";
              if(vf&&!ohsidianLeafAcceptsPath(vf)){
                try{console.warn("[OHSidian] skip save of non-text view:",vf)}catch(eL){}
                return;
              }
              if(leaf&&leaf.view&&typeof leaf.view.save==="function")leaf.view.save();
            }catch(eS){}
          });
        }
      }catch(e){}
    };
    var dirNonEmpty=function(p){
      try{
        if(!fsMod.existsSync(p))return false;
        var st=fsMod.lstatSync(p);
        if(st.isSymbolicLink())return true;
        if(!st.isDirectory())return true;
        return fsMod.readdirSync(p).length>0;
      }catch(e){return true}   /* unknown -> treat as non-empty (never overwrite) */
    };
    var safeCopyDir=function(s,d,cb){
      var copied=0,failed=0,skipped=0;
      var finished=false;
      var finish=function(err){
        if(finished)return;
        finished=true;
        cb(err,{copied:copied,failed:failed,skipped:skipped});
      };
      var walk=function(ss,dd,depth,doneDir){
        if(depth>64)return doneDir(new Error("目录嵌套过深，已停止迁移"));
        fsMod.mkdir(dd,{recursive:!0},function(eMk){
          if(eMk)return doneDir(eMk);
          fsMod.readdir(ss,function(err,items){
            if(err)return doneDir(err);
            /* Empty directory: only this branch's parent completion fires -
               the old code called the GLOBAL callback here, which made the
               migration report "done" (and open the vault) after the first
               empty directory while the rest of the tree was still copying. */
            if(!items.length)return doneDir(null);
            var pending=items.length,fail=null;
            var done=function(e2){
              if(e2){fail=fail||e2;failed++}
              if(--pending===0)doneDir(fail);
            };
            items.forEach(function(nm){
              var sp=pathMod.join(ss,nm),dp=pathMod.join(dd,nm);
              fsMod.lstat(sp,function(err2,st){
                if(err2)return done(err2);
                if(st.isSymbolicLink()){skipped++;return done(null)}
                if(st.isDirectory()){walk(sp,dp,depth+1,done)}
                else{
                  fsMod.copyFile(sp,dp,function(e3){
                    if(e3)return done(e3);
                    copied++;
                    try{
                      fsMod.utimes(dp,st.atime,st.mtime,function(){done(null)});
                    }catch(eU){done(null)}
                  });
                }
              });
            });
          });
        });
      };
      walk(s,d,0,finish);
    };
    var startMigration=function(target){
      var srcDir;
      try{srcDir=v.adapter.getFullPath("/")}catch(e){}
      if(!srcDir){try{new Notice("OHSidian: 无法定位仓库根目录")}catch(e){}return}
      var norm=function(p){try{return pathMod.resolve(p)}catch(e){return p}};
      var srcNorm=norm(srcDir),dstNorm=norm(target);
      if(dstNorm===srcNorm||dstNorm.indexOf(srcNorm+pathMod.sep)===0){
        try{new Notice("OHSidian: 目标目录在当前仓库内,请选择仓库以外的位置")}catch(e){}return;
      }
      var targetExisted=false;
      try{targetExisted=fsMod.existsSync(target)}catch(e){}
      /* Never merge into a non-empty directory: copyFile overwrites silently
         and a repeated migration would roll the copy back to the old content. */
      if(dirNonEmpty(target)){
        try{new Notice("OHSidian: 目标目录非空，请选择空目录或新建目录（已取消，未写入任何文件）")}catch(e){}return;
      }
      globalThis.__ohsidianMigrating=true;
      var opened=false;
      try{new Notice("OHSidian: 开始迁移仓库到 "+target)}catch(e){}
      safeCopyDir(srcDir,target,function(err,stats){
        globalThis.__ohsidianMigrating=false;
        if(err){
          /* Only remove a target this run created, and only if the vault was
             never opened: after sendSync("vault-open") the directory is the
             live vault (Obsidian writes .obsidian into it), so a late error
             must never rm -rf it. */
          if(!targetExisted&&!opened){try{fsMod.rmSync(target,{recursive:true,force:true})}catch(eR){}
            try{new Notice("OHSidian: 迁移失败 "+err.message+"（已清理未完成的副本）")}catch(e){}
          }else{
            try{new Notice("OHSidian: 迁移失败 "+err.message+"（目标目录内可能残留部分副本，请检查后删除）")}catch(e){}
          }
          return;
        }
        var n=(stats&&typeof stats.copied==="number")?stats.copied:0;
        var sk=(stats&&typeof stats.skipped==="number")?stats.skipped:0;
        opened=true;
        try{new Notice("OHSidian: 已复制 "+n+" 个文件到 "+target+"（跳过软链接 "+sk+" 个），正在打开新仓库…")}catch(e){}
        try{
          var r=remote.ipcRenderer.sendSync("vault-open",target,!1);
          if(r!==!0){try{new Notice("OHSidian: 打开新仓库返回 "+r)}catch(e){}}
        }catch(e){try{new Notice("OHSidian: 打开新仓库失败 "+e.message)}catch(e2){}}
      });
    };
    var pickMigration=function(){
      var docsRoot=documentsDirPath(readMode());
      var opts={properties:["openDirectory","createDirectory"],buttonLabel:"迁移仓库到这里"};
      if(docsRoot)opts.defaultPath=pathMod.join(docsRoot,"OHSidian");
      remote.dialog.showOpenDialog(opts).then(function(res){
        try{
          if(!res||!res.filePaths||!res.filePaths.length)return;
          flushEditors();
          var target=res.filePaths[0];
          setTimeout(function(){startMigration(target)},300);
        }catch(e){try{new Notice("OHSidian: 迁移失败 "+e.message)}catch(e2){}}
      },function(){/* canceled by user */});
    };
    var docsDir=documentsDirPath(readMode())||null;
    var inSandbox=false;
    try{
      var cur=v.adapter.getFullPath("/");
      var ud=require("@electron/remote").app.getPath("userData");
      var relSandbox=cur&&ud?pathMod.relative(ud,cur):"";
      inSandbox=!!(cur&&ud&&relSandbox&&relSandbox.indexOf("..")!==0&&!pathMod.isAbsolute(relSandbox));
    }catch(e){}
    if(docsDir&&inSandbox){
      /* one-tap default migration into the visible Documents root */
      var name=pathMod.basename(v.adapter.getFullPath("/"))||"Obsidian Vault";
      name=String(name).replace(/[\\\/:*?\"<>|]/g,"_").replace(/^\.+$/,"_")||"Obsidian Vault";
      var dest=pathMod.join(docsDir,"OHSidian",name);
      for(var i=2;dirNonEmpty(dest);i++){
        dest=pathMod.join(docsDir,"OHSidian",name+" ("+i+")");
      }
      flushEditors();
      try{new Notice("OHSidian: 当前仓库在应用沙箱内,卸载会丢数据。开始迁移到 "+dest+" …")}catch(e){}
      setTimeout(function(){startMigration(dest)},300);
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
/* ===== BUG-004 PROBE — TEMPORARY (remove in the version after next) =====
   The reporter's Pandoc export fails with
     /bin/sh: /storage/.../.harmonybrew/bin/pandoc: inaccessible or not found
   and toybox merges ENOENT (gone / dangling symlink) with EACCES (exists but
   not executable - which includes a SELinux denial) into that one sentence, so
   the cause cannot be read off the message. This probe separates them in one
   click: file layer (lstat / realpath / stat / access X_OK) plus one real
   execve of `--version`, then shows the whole result in a dialog.
   REMOVE this block together with its command, its settings button and its
   verify-asar marker once the reporter has run it. */
/* Pandoc environment check - a FEATURE, not a throwaway probe.
   Product shape: the path is a setting (OHSidian → 诊断), the check only runs
   when asked, results are shown in place, and nothing here fires at startup -
   a user who never opens diagnostics never notices this exists.
   Default is the harmonybrew location seen on device; anything typed in the
   settings row wins and is remembered in ohsidian-ui-prefs.json. */
var OHSIDIAN_PANDOC_DEFAULT="/storage/Users/currentUser/.harmonybrew/bin/pandoc";
function ohsidianPandocPath(){
  try{
    var p=ohsidianReadUiPrefs().pandocPath;
    if(typeof p==="string"&&p.trim())return p.trim();
  }catch(e){}
  return OHSIDIAN_PANDOC_DEFAULT;
}
function ohsidianSetPandocPath(v){
  try{
    var prefs=ohsidianReadUiPrefs();
    var s=String(v||"").trim();
    if(!s||s===OHSIDIAN_PANDOC_DEFAULT)delete prefs.pandocPath;
    else prefs.pandocPath=s;
    return ohsidianWriteUiPrefs(prefs);
  }catch(e){return false}
}
function ohsidianProbeExecutable(exePath,opt){
  opt=opt||{};
  var out={path:exePath,isLink:false,target:"",exists:false,size:0,mode:"",execBits:false,
    xOk:false,fsErr:"",verdict:"unknown",human:"",errno:"",status:null,signal:null,version:"",
    dirOk:false};
  var fs2,np;
  try{fs2=require("fs");np=require("path")}catch(e){out.verdict="no-node";out.human="渲染进程里没有 Node 的 fs";return out}
  var probePath=exePath;
  try{
    var ls=fs2.lstatSync(exePath);
    out.isLink=!!(ls.isSymbolicLink&&ls.isSymbolicLink());
    if(out.isLink){
      out.target=fs2.realpathSync(exePath);   /* dangling link throws ENOENT here */
      probePath=out.target;
    }
    var st=fs2.statSync(probePath);
    out.exists=true;
    out.size=st.size;
    out.execBits=(st.mode&0o111)!==0;
    out.mode="0"+(st.mode&0o777).toString(8);
    try{fs2.accessSync(probePath,fs2.constants.X_OK);out.xOk=true}catch(eA){out.xOk=false}
    try{fs2.statSync(np.dirname(exePath));out.dirOk=true}catch(eD){out.dirOk=false}
  }catch(e){
    out.fsErr=(e&&e.code)?e.code:String(e);
    if(out.fsErr==="ENOENT"){
      out.verdict="missing";
      out.human=out.isLink?("软链接存在但目标不存在（悬空）："+exePath):("路径不存在或上级目录不可访问："+exePath);
    }else if(out.fsErr==="EACCES"){
      out.verdict="stat-eacces";
      out.human="连 stat 都被拒（EACCES）："+exePath+" —— 文件层面就读不到，exec 更不可能";
    }else{
      out.verdict="stat-error";
      out.human="文件预检失败（"+(out.fsErr||"?")+"）："+exePath;
    }
    return out;
  }
  if(opt.fsOnly){
    out.verdict=(out.execBits&&out.xOk)?"fs-ok":"fs-suspect";
    out.human="仅文件预检：可执行位"+(out.execBits?"有":"无")+"，X_OK "+(out.xOk?"通过":"不通过")+"（不含 SELinux 裁决）";
    return out;
  }
  var cp;
  try{cp=require("child_process")}catch(e){out.verdict="no-child_process";out.human="引擎没有提供 child_process，无法做 execve 探测";return out}
  var r=null;
  try{
    r=cp.spawnSync(probePath,["--version"],{timeout:opt.timeout||2500,encoding:"utf8"});
  }catch(eS){
    out.verdict="spawn-threw";
    out.human="探测调用本身抛错："+String(eS&&eS.message||eS);
    return out;
  }
  if(!r){out.verdict="spawn-null";out.human="探测没有返回结果";return out}
  out.status=(typeof r.status==="number")?r.status:null;
  out.signal=r.signal||null;
  out.errno=(r.error&&(r.error.code||String(r.error.errno)))?r.error.code||String(r.error.errno):"";
  out.version=String(r.stdout||"").split("\n")[0].slice(0,120);
  if(out.errno==="ENOENT"){
    out.verdict="exec-enoent";
    out.human="execve 报 ENOENT：可执行文件或它的 #! 解释器不存在（软链接目标失效也算这个）";
  }else if(out.errno==="EACCES"){
    out.verdict="exec-eacces";
    out.human="execve 报 EACCES：文件存在但被拒绝执行 —— SELinux/沙箱限制，应用层绕不过去，只能换位置或换方案";
  }else if(out.errno==="ENOEXEC"){
    out.verdict="exec-noexec";
    out.human="execve 报 ENOEXEC：不是本机可执行格式（架构不符或缺解释器）";
  }else if(out.errno==="ETXTBSY"){
    out.verdict="exec-txtbusy";
    out.human="execve 报 ETXTBSY：文件正被写入/占用，稍后重试";
  }else if(out.errno==="ETIMEDOUT"){
    out.verdict="timeout";
    out.human="探测超时（"+(opt.timeout||2500)+"ms），结论不可用";
  }else if(out.status===0){
    out.verdict="ok";
    out.human="可以执行："+(out.version||"（无输出）");
  }else{
    out.verdict="exit-"+(out.status===null?("signal:"+out.signal):out.status);
    out.human="能启动，但退出码 "+(out.status===null?("signal:"+out.signal):out.status)+" —— 路径没问题，问题在这个程序内部";
  }
  return out;
}
function ohsidianPathReportLines(d){
  var L=[];
  L.push("结论: "+d.human);
  L.push("检查路径: "+d.path);
  L.push("是否软链接: "+(d.isLink?"是":"否")+(d.isLink?("  →  "+d.target):""));
  L.push("目标存在: "+(d.exists?"是":"否")+(d.exists?("  ("+d.size+" B)"):""));
  if(d.exists){
    L.push("权限位: "+d.mode+"   执行位: "+(d.execBits?"有":"无")+"   访问(X_OK): "+(d.xOk?"通过":"不通过"));
  }
  L.push("上级目录可读: "+(d.dirOk?"是":"否"));
  L.push("文件层错误: "+(d.fsErr||"无"));
  if(d.verdict!=="fs-ok"&&d.verdict!=="fs-suspect"){
    L.push("execve 结果: errno="+(d.errno||"无")+"  exit="+(d.status===null?"-":String(d.status))+
      "  signal="+(d.signal||"无"));
    L.push("程序输出首行: "+(d.version||"（无）"));
  }
  L.push("");
  if(d.verdict==="exec-eacces"){
    L.push("说明: 文件层检查通过、execve 仍被拒 → 这是系统级执行限制（不是路径写错，也不是文件损坏）。");
  }else if(d.verdict==="missing"){
    L.push("说明: 路径或软链接目标不存在 → 重新安装/修正链接即可，应用层可以顺手做路径预检。");
  }else if(d.verdict==="ok"){
    L.push("说明: 这条路径可以被执行 → 插件失败的原因在别处（例如插件里填的路径不是这一条、或 cwd/env 不同）。");
  }
  return L;
}
function ohsidianShowReportModal(title,lines){
  try{
    var d=document,body=d.body;
    var back=d.createElement("div");
    back.style.cssText="position:fixed;inset:0;z-index:2147483600;background:rgba(0,0,0,.45);"+
      "display:flex;align-items:center;justify-content:center;padding:24px";
    var panel=d.createElement("div");
    panel.style.cssText="max-width:760px;width:100%;max-height:82vh;overflow:auto;"+
      "background:var(--background-primary,#fff);color:var(--text-normal,#222);"+
      "border:1px solid var(--background-modifier-border,#ccc);border-radius:12px;"+
      "padding:18px 20px;box-shadow:0 14px 44px rgba(0,0,0,.38);font-size:13px;line-height:1.55";
    var h=d.createElement("div");
    h.style.cssText="font-weight:600;font-size:15px;margin-bottom:10px";
    h.textContent=title;
    var pre=d.createElement("pre");
    pre.style.cssText="white-space:pre-wrap;word-break:break-all;margin:0 0 14px;padding:12px;"+
      "border-radius:8px;background:var(--background-secondary,#f2f2f2);font-size:12px;"+
      "max-height:50vh;overflow:auto";
    pre.textContent=lines.join("\n");
    var row=d.createElement("div");
    row.style.cssText="display:flex;gap:8px;justify-content:flex-end";
    var btnCss="padding:6px 12px;border-radius:8px;cursor:pointer;font-size:13px;"+
      "border:1px solid var(--background-modifier-border,#ccc)";
    var copy=d.createElement("button");
    copy.textContent="复制详细信息";
    copy.style.cssText=btnCss+";background:var(--interactive-normal,#eee);color:inherit";
    copy.addEventListener("click",function(){
      try{navigator.clipboard.writeText(title+"\n"+lines.join("\n"));copy.textContent="已复制"}catch(e){copy.textContent="复制失败"}
    });
    var ok=d.createElement("button");
    ok.textContent="关闭";
    ok.style.cssText=btnCss+";background:var(--interactive-accent,#7b6cf6);color:var(--text-on-accent,#fff)";
    ok.addEventListener("click",function(){try{back.remove()}catch(e){}});
    row.appendChild(copy);row.appendChild(ok);
    panel.appendChild(h);panel.appendChild(pre);panel.appendChild(row);
    back.appendChild(panel);
    back.addEventListener("click",function(ev){if(ev.target===back){try{back.remove()}catch(e){}}});
    body.appendChild(back);
  }catch(e){
    try{new Notice(title+"\n"+lines.join("\n"),20000)}catch(e2){}
  }
}
/* Where the two pandoc plugins actually keep their configured binary.
   obsidian-pandoc (OliverBalfour): settings.pandoc, data.json key "pandoc".
   pandoc-gui (pan4ratte): platform-keyed path setting. Neither schema is
   hardcoded here - every string value that looks like a pandoc binary is
   collected, so a plugin update that renames its key cannot hide the answer. */
function ohsidianPluginPandocPaths(){
  var out=[],seen={};
  try{
    var fs2=require("fs"),np=require("path"),remote=require("@electron/remote");
    var base="";
    try{base=window.app.vault.adapter.getBasePath()}catch(eB){base=remote.app.getPath("userData")}
    var dirs=[];
    try{dirs=fs2.readdirSync(np.join(base,".obsidian","plugins"))}catch(eD){dirs=[]}
    var walk=function(v,depth,src){
      if(depth>5||v===null||v===undefined)return;
      if(typeof v==="string"){
        var s=v.replace(/^"+|"+$/g,"");
        if(/pandoc(\.exe)?$/i.test(s)&&s.length<512&&!seen[s]){seen[s]=1;out.push({path:s,source:src})}
        return;
      }
      if(typeof v==="object"){
        for(var k in v){try{walk(v[k],depth+1,src)}catch(eW){}}
      }
    };
    for(var i=0;i<dirs.length;i++){
      var p=np.join(base,".obsidian","plugins",dirs[i],"data.json");
      try{walk(JSON.parse(fs2.readFileSync(p,"utf8")),0,dirs[i]+"/data.json")}catch(eF){}
    }
  }catch(e){}
  var wanted=ohsidianPandocPath();
  if(!seen[wanted]){out.push({path:wanted,source:"OHSidian 设置里的路径"})}
  return out;
}
/* The two plugins fail in completely different places, so probe BOTH ways:
   spawn() directly (obsidian-pandoc) and /bin/sh -c "path --version"
   (pandoc-gui). One failing while the other works points at shell/quoting,
   both failing at the same errno points at the file or the platform. */
function ohsidianProbeExecModes(exePath,timeout){
  var res={direct:{errno:"",status:null,out:"",err:""},
    shell:{errno:"",status:null,out:"",err:""}};
  var cp;
  try{cp=require("child_process")}catch(e){res.direct.errno="no-child_process";res.shell.errno="no-child_process";return res}
  try{
    var r=cp.spawnSync(exePath,["--version"],{timeout:timeout||2000,encoding:"utf8"});
    res.direct.errno=(r&&r.error&&(r.error.code||String(r.error.errno)))||"";
    res.direct.status=(r&&typeof r.status==="number")?r.status:null;
    res.direct.out=String((r&&r.stdout)||"").split("\n")[0].slice(0,90);
    res.direct.err=String((r&&r.stderr)||"").split("\n")[0].slice(0,160);
  }catch(e1){res.direct.errno="throw";res.direct.err=String(e1&&e1.message||e1)}
  try{
    var q=/\s/.test(exePath)?('"'+exePath+'"'):exePath;
    var r2=cp.spawnSync("/bin/sh",["-c",q+" --version"],{timeout:timeout||2000,encoding:"utf8"});
    res.shell.errno=(r2&&r2.error&&(r2.error.code||String(r2.error.errno)))||"";
    res.shell.status=(r2&&typeof r2.status==="number")?r2.status:null;
    res.shell.out=String((r2&&r2.stdout)||"").split("\n")[0].slice(0,90);
    res.shell.err=String((r2&&r2.stderr)||"").split("\n")[0].slice(0,160);
  }catch(e2){res.shell.errno="throw";res.shell.err=String(e2&&e2.message||e2)}
  return res;
}
/* One sweep over: the path from the settings row, then whatever the installed
   plugins actually point at (so a mismatch is visible instead of guessed).
   Pure: returns {lines, report}; showing or writing is the caller's business. */
function ohsidianBuildPandocReport(){
  var lines=[],report={configured:ohsidianPandocPath(),candidates:[],at:new Date().toISOString()};
  var cands=[{path:report.configured,source:"OHSidian 设置"}];
  try{
    var extra=ohsidianPluginPandocPaths();
    for(var x=0;x<extra.length;x++){
      var dup=false;
      for(var y=0;y<cands.length;y++){if(cands[y].path===extra[x].path)dup=true}
      if(!dup)cands.push(extra[x]);
    }
  }catch(eC){}
  for(var i=0;i<cands.length;i++){
    var c=cands[i],d=null;
    lines.push("─────────────────────────────────────────");
    lines.push("候选 "+(i+1)+"／"+cands.length+"    来源: "+c.source);
    try{d=ohsidianProbeExecutable(c.path,{timeout:2000})}catch(eP){d=null}
    if(!d){lines.push("探针执行出错，跳过该候选");continue}
    var rl=ohsidianPathReportLines(d);
    for(var k=0;k<rl.length;k++)lines.push(rl[k]);
    var modes=ohsidianProbeExecModes(c.path,2000);
    lines.push("");
    lines.push("→ 直接 execve（Pandoc Plugin 的调用方式）: "+
      (modes.direct.errno?("errno="+modes.direct.errno):("exit="+(modes.direct.status===null?"-":String(modes.direct.status))))+
      (modes.direct.out?("  输出: "+modes.direct.out):"")+
      (modes.direct.err?("  stderr: "+modes.direct.err):""));
    lines.push("→ /bin/sh -c（Pandoc GUI 的调用方式）: "+
      (modes.shell.errno?("errno="+modes.shell.errno):("exit="+(modes.shell.status===null?"-":String(modes.shell.status))))+
      (modes.shell.out?("  输出: "+modes.shell.out):"")+
      (modes.shell.err?("  stderr: "+modes.shell.err):""));
    report.candidates.push({source:c.source,file:d,direct:modes.direct,shell:modes.shell});
  }
  lines.push("─────────────────────────────────────────");
  lines.push("怎么读这份结果：");
  lines.push("· Pandoc Plugin 用 spawn()，而且没有挂 error 监听 —— execve 失败时它既不报错也不结束，这就是\"没有报错原因\"的来源。");
  lines.push("· Pandoc GUI 用 exec()（/bin/sh -c），同一个失败会显示成 /bin/sh: … inaccessible or not found。");
  lines.push("· 两种方式都失败、且 errno 都是 EACCES → 系统拒绝执行该文件（SELinux 一类），应用层绕不过去。");
  lines.push("· 只有 /bin/sh 那条失败 → 问题在 shell/引号/PATH，文件本身没问题。");
  lines.push("· 文件层就报 ENOENT（软链接悬空）→ 重新安装或改链接即可。");
  return {lines:lines,report:report};
}
function ohsidianWritePandocReport(report){
  try{
    var fs2=require("fs"),np=require("path"),remote=require("@electron/remote");
    var out=np.join(remote.app.getPath("userData"),"ohsidian-pandoc-check.json");
    fs2.writeFileSync(out,JSON.stringify(report,null,2));
    try{console.warn("[OHSidian] pandoc check",JSON.stringify(report))}catch(eL){}
  }catch(eW){}
}
/* Command-palette entry: the same report, shown in a dialog. */
function ohsidianRunPandocProbe(){
  try{new Notice("OHSidian: 正在检测 pandoc…",4000)}catch(e){}
  var r=null;
  try{r=ohsidianBuildPandocReport()}catch(eB){r=null}
  if(!r){
    ohsidianShowReportModal("OHSidian 诊断: Pandoc 环境",["检测本身失败，无法生成报告。"]);
    return;
  }
  ohsidianShowReportModal("OHSidian 诊断: Pandoc 环境",r.lines);
  ohsidianWritePandocReport(r.report);
}
/* ===== end BUG-004 PROBE ===== */

/* BUG-002 user switch. "No frame => no system trio" is right by default, but
   some users WANT the native buttons while keeping Obsidian's 隐藏 frame style
   (that is exactly what a Hider-style setup gives them today). ArkTS reads this
   flag when it decides button visibility (WebAbility.keepSystemTitleButtons),
   so it applies on the next start - the same rule as the frame-style setting. */
function ohsidianUiPrefsPath(){
  try{
    var remote=require("@electron/remote"),np=require("path");
    return np.join(remote.app.getPath("userData"),"ohsidian-ui-prefs.json");
  }catch(e){return ""}
}
function ohsidianReadUiPrefs(){
  try{
    var p=ohsidianUiPrefsPath(),fs2=require("fs");
    if(!p||!fs2.existsSync(p))return {};
    var j=JSON.parse(fs2.readFileSync(p,"utf8"));
    return (j&&typeof j==="object")?j:{};
  }catch(e){return {}}
}
function ohsidianWriteUiPrefs(obj){
  try{
    var p=ohsidianUiPrefsPath();if(!p)return false;
    var fs2=require("fs");
    var tmp=p+".tmp-"+Date.now();
    fs2.writeFileSync(tmp,JSON.stringify(obj,null,2));
    try{fs2.renameSync(tmp,p)}catch(eR){try{fs2.unlinkSync(p)}catch(eU){};fs2.renameSync(tmp,p)}
    return true;
  }catch(e){return false}
}
function ohsidianSetKeepSystemTitleButtons(on){
  var prefs=ohsidianReadUiPrefs();
  prefs.keepSystemTitleButtons=!!on;
  var ok=ohsidianWriteUiPrefs(prefs);
  try{new Notice("OHSidian: 隐藏模式下"+(on?"保留":"不保留")+"系统窗口按钮 —— "+(ok?"重启应用后生效":"写入失败"),6000)}catch(e){}
  return ok;
}
/* OHSidian settings section.
   Two things had to be right, and the first attempt got both wrong:
   1) TIMING - `install(app)` runs before `app.setting` exists, so a one-shot
      registration silently did nothing and never retried;
   2) SHAPE - the settings modal renders a tab through the real `SettingTab`
      base class: it needs `containerEl` (created by that constructor) and the
      modal assigns/opens it. A bare object literal has no containerEl, so even
      when registered the pane came up empty.
   Now the tab is built from the class of an EXISTING core tab (borrowing it
   from `app.setting.settingTabs[0]`), and registration retries until the
   settings module is ready. Everything is guarded: worst case the section is
   absent and the commands still work. */
function ohsidianSettingsRows(root){
  try{
    if(!root)return;
    if(root.empty)root.empty();
    var wrap=root.createDiv?root.createDiv("ohsidian-settings"):null;
    if(!wrap)return;
    if(wrap.createEl)wrap.createEl("h2",{text:"OHSidian"});
    var mkRow=function(name,desc){
      var row=wrap.createDiv?wrap.createDiv("setting-item"):null;
      if(!row)return null;
      var info=row.createDiv?row.createDiv("setting-item-info"):null;
      if(info&&info.createDiv){
        info.createDiv("setting-item-name",{text:name});
        info.createDiv("setting-item-description",{text:desc});
      }
      var ctl=row.createDiv?row.createDiv("setting-item-control"):null;
      return ctl;
    };
    var mkToggle=function(ctl,on,onChange){
      if(!ctl||!ctl.createEl)return;
      var inp=ctl.createEl("input",{type:"checkbox"});
      if(!inp)return;
      inp.checked=!!on;
      inp.addEventListener("change",function(){onChange(!!inp.checked)});
    };
    /* 1) window buttons */
    mkToggle(mkRow("隐藏模式下保留系统窗口按钮",
      "开启：窗口边框样式选「隐藏」时仍显示鸿蒙的关闭/最大化/最小化（重启生效）。关闭：无边框时只显示 Obsidian 自己的标题栏。"),
      ohsidianReadUiPrefs().keepSystemTitleButtons,
      function(on){ohsidianSetKeepSystemTitleButtons(on)});
    /* 2) fonts inside embedded web pages */
    mkToggle(mkRow("嵌入网页跟随界面字体",
      "开启：Custom Frames / 网页视图里也用当前字体（只改正文，代码块与图标字体保持原样）。关闭：网页用系统默认字体。改动在下次打开该网页时生效。"),
      ohsidianReadUiPrefs().webviewFonts!==false,
      function(on){
        var prefs=ohsidianReadUiPrefs();
        prefs.webviewFonts=!!on;
        var ok=ohsidianWriteUiPrefs(prefs);
        try{new Notice("OHSidian: 嵌入网页字体跟随 → "+(on?"开":"关")+(ok?"（重开该网页生效）":"（写入失败）"),5000)}catch(e){}
      });
    /* --- 诊断（Diagnostics）---------------------------------------------
       Everything a user only reaches when something is broken lives under this
       heading: no ribbon icon, no startup work, no notice unless they press a
       button. New checks go here as plain rows so the section stays scannable. */
    if(wrap.createEl)wrap.createEl("h3",{text:"诊断"});
    /* 3a) pandoc path: a real setting, remembered, defaulted to the known one */
    var pathCtl=mkRow("Pandoc 路径",
      "导出 Word 时使用的 pandoc。留空或填回默认值即恢复默认：" + OHSIDIAN_PANDOC_DEFAULT);
    if(pathCtl&&pathCtl.createEl){
      var inp=pathCtl.createEl("input",{type:"text"});
      if(inp){
        inp.style.minWidth="320px";
        inp.placeholder=OHSIDIAN_PANDOC_DEFAULT;
        inp.value=ohsidianReadUiPrefs().pandocPath||"";
        var save=function(){
          var ok=ohsidianSetPandocPath(inp.value);
          try{new Notice("OHSidian: Pandoc 路径 "+(ok?"已保存":"保存失败"),4000)}catch(e){}
        };
        inp.addEventListener("change",save);
        inp.addEventListener("blur",save);
      }
    }
    /* 3b) the check itself: runs only on click, result inline (copyable) */
    var checkCtl=mkRow("Pandoc 环境检查",
      "检查路径是否存在、是否软链接、权限位，并分别用两种调用方式实测（直接 execve / 经 /bin/sh）。结果写在下方，可复制。");
    var outEl=null;
    if(checkCtl&&checkCtl.createEl){
      var btn=checkCtl.createEl("button",{text:"检查"});
      if(btn){
        if(wrap.createEl){
          outEl=wrap.createEl("pre",{cls:"ohsidian-diag-out"});
          if(outEl){
            outEl.style.display="none";
            outEl.style.whiteSpace="pre-wrap";
            outEl.style.wordBreak="break-all";
            outEl.style.maxHeight="360px";
            outEl.style.overflow="auto";
            outEl.style.fontSize="12px";
            outEl.style.background="var(--background-secondary)";
            outEl.style.padding="10px";
            outEl.style.borderRadius="8px";
          }
        }
        btn.addEventListener("click",function(){
          try{
            btn.textContent="检查中…";
            setTimeout(function(){
              try{
                var r=ohsidianBuildPandocReport();
                if(outEl){
                  outEl.textContent=r.lines.join("\n");
                  outEl.style.display="block";
                }
                ohsidianWritePandocReport(r.report);
              }catch(eR){
                if(outEl){outEl.textContent="检查失败: "+String(eR&&eR.message||eR);outEl.style.display="block"}
              }finally{
                btn.textContent="检查";
              }
            },50);
          }catch(e){btn.textContent="检查"}
        });
      }
    }
  }catch(e){}
}
function ohsidianBuildSettingsTab(){
  try{
    var s=window.app&&window.app.setting;
    if(!s)return null;
    var Base=null;
    try{
      var core=(s.settingTabs&&s.settingTabs.length)?s.settingTabs[0]:null;
      if(core&&core.constructor)Base=core.constructor;
    }catch(e1){}
    if(!Base){
      try{
        var pt=(s.pluginTabs&&s.pluginTabs.length)?s.pluginTabs[0]:null;
        if(pt&&pt.constructor)Base=pt.constructor;
      }catch(e2){}
    }
    var tab=null;
    if(Base){
      try{tab=new Base(window.app,null)}catch(e3){tab=null}
    }
    if(!tab){
      tab={};
      try{
        tab.containerEl=document.createElement("div");
        tab.containerEl.className="vertical-tab-content";
      }catch(e4){}
    }
    tab.id="ohsidian";
    tab.name="OHSidian";
    tab.display=function(){ohsidianSettingsRows(this.containerEl)};
    tab.hide=function(){};
    return (tab.containerEl||tab.navEl)?tab:null;
  }catch(e){return null}
}
function ohsidianEnsureSettingsTab(){
  try{
    var s=window.app&&window.app.setting;
    if(!s||typeof s.addSettingTab!=="function"){
      window.__ohsidianSettingsError="app.setting 不可用";
      return false;
    }
    if(window.__ohsidianSettingsTab)return true;
    var tab=ohsidianBuildSettingsTab();
    if(!tab){
      window.__ohsidianSettingsError="无法构造 SettingTab（找不到基类）";
      return false;
    }
    s.addSettingTab(tab);
    window.__ohsidianSettingsTab=tab;
    window.__ohsidianSettingsError="";
    try{console.log("[OHSidian] settings section registered")}catch(eL){}
    return true;
  }catch(e){
    window.__ohsidianSettingsError=String(e&&e.message||e);
    try{console.warn("[OHSidian] settings section failed:",window.__ohsidianSettingsError)}catch(e2){}
    return false;
  }
}
/* Registration has to happen when the settings modal can accept it: its
   container is created lazily, so a registration attempted too early throws
   inside addSettingTab and (because we must not break startup) is swallowed.
   Wrapping open() gives us the one moment where the container is guaranteed to
   exist. */
function ohsidianHookSettingsOpen(){
  try{
    var s=window.app&&window.app.setting;
    if(!s||typeof s.open!=="function"||s.__ohsidianOpenHooked)return false;
    var orig=s.open;
    s.open=function(){
      var r=orig.apply(s,arguments);
      try{ohsidianEnsureSettingsTab()}catch(e){}
      return r;
    };
    s.__ohsidianOpenHooked=1;
    return true;
  }catch(e){return false}
}
/* BUG-005 touch probe — TEMPORARY (remove once the toolbar is fixed).
   ArkTS logs already prove the touch reaches the page: the hit chain ends at
   the WebEngine XComponent and the editor gets focus. What they cannot show is
   WHICH element inside the page received it, or whether the toolbar's painted
   position differs from its layout box. This logs exactly that for touches in
   the lower part of the screen - one tap answers it.
   Needs the console bridge: run "OHSidian: 运行日志捕获 开/关" first. */
/* BUG-005 root cause (device log + obsidian's own app.css):
   `.mobile-toolbar { -webkit-app-region: drag }` marks the whole mobile toolbar
   as a WINDOW DRAG REGION, and THIS engine implements app-region - its C++ side
   calls AppWindow.StartWindowMoving the moment a pan is recognised
   (log: "PAN RACC, T: NodeContainer, DIS x 5.000000, y 2.000000" immediately
   followed by "AppWindowAdapter#startWindowMoving(1)"). A finger on the bar can
   therefore never produce a click: 5 px of travel turns it into a window drag.
   That is the entire "looks fine, does not respond" report - the native video
   overlay was a red herring.
   Fix: drop the drag region for the bar only. Moving the window keeps working
   through .titlebar and the tab header, which are separate drag regions. */
var TOOLBAR_HIT_CSS_ID="ohsidian-toolbar-hit";
function applyToolbarHitFix(){
  try{
    var css=".mobile-toolbar,.mobile-toolbar *{-webkit-app-region:no-drag!important}";
    var el=document.getElementById(TOOLBAR_HIT_CSS_ID);
    if(!el){
      if(!document.head)return;
      el=document.createElement("style");
      el.id=TOOLBAR_HIT_CSS_ID;
      document.head.appendChild(el);
    }
    if(el.textContent!==css)el.textContent=css;
  }catch(e){}
}
function ohsidianInstallTouchProbe(){
  try{
    if(window.__ohsidianTouchProbe)return false;
    window.__ohsidianTouchProbe=1;
    var handler=function(ev){
      try{
        var t=(ev.touches&&ev.touches.length)?ev.touches[0]:ev;
        if(typeof t.clientY!=="number")return;
        var vh=window.innerHeight||document.documentElement.clientHeight||0;
        if(!vh||t.clientY<vh*0.6)return;
        var el=document.elementFromPoint(t.clientX,t.clientY);
        var chain=[],n=el,guard=0;
        while(n&&guard<6){
          var cls=(n.className&&typeof n.className==="string")?
            ("."+n.className.trim().split(/\s+/).slice(0,2).join(".")):"";
          chain.push((n.tagName||"?")+cls);
          n=n.parentElement;guard++;
        }
        var tb=document.querySelector(".mobile-toolbar");
        var r=tb?tb.getBoundingClientRect():null;
        var kb="";
        try{kb=getComputedStyle(document.documentElement).getPropertyValue("--keyboard-height").trim()}catch(eK){}
        var cs=tb?getComputedStyle(tb):null;
        console.warn("[OHSidian touch]",
          "y="+Math.round(t.clientY)+"/"+Math.round(vh),
          "evt="+ev.type,
          "hit="+chain.join(" < "),
          "kb="+(kb||"(empty)"),
          "toolbar="+(r?(Math.round(r.top)+".."+Math.round(r.bottom)+" h="+Math.round(r.height)):"(none)"),
          "tbPointer="+(cs?cs.pointerEvents:"-"),
          "tbZ="+(cs?cs.zIndex:"-"),
          "inToolbar="+((r&&t.clientY>=r.top&&t.clientY<=r.bottom)?"YES":"no"));
      }catch(e){}
    };
    document.addEventListener("touchstart",handler,true);
    document.addEventListener("pointerdown",handler,true);
    try{console.log("[OHSidian touch] probe installed")}catch(eL){}
    return true;
  }catch(e){return false}
}
function ohsidianScheduleSettingsTab(){
  var tries=0;
  var tick=function(){
    tries++;
    if(ohsidianEnsureSettingsTab())return;
    if(tries<40)setTimeout(tick,500);   /* up to 20 s: settings module comes up late */
  };
  try{window.app.workspace.onLayoutReady(function(){ohsidianEnsureSettingsTab()})}catch(e){}
  try{ohsidianHookSettingsOpen()}catch(eH){}
  tick();
}
/* One-glance answer to "is the patch I am running the one we just built?".
   It reports the patch revision this file was packed with, whether the
   settings section registered (and why not), and whether the two most recent
   behavioural fixes are live. Costs nothing until someone runs it. */
var OHSIDIAN_PATCH_REV="175";
function ohsidianBuildStatusLines(){
  var L=[];
  L.push("补丁版本: "+OHSIDIAN_PATCH_REV);
  var tabState="未注册";
  if(window.__ohsidianSettingsTab)tabState="已注册";
  else if(window.__ohsidianSettingsError)tabState="未注册（"+window.__ohsidianSettingsError+"）";
  L.push("设置栏目: "+tabState);
  L.push("工具栏拖动区修复: "+(document.getElementById("ohsidian-toolbar-hit")?"已注入":"未注入"));
  L.push("写盘闸: "+(window.app&&window.app.vault?"随补丁加载（无独立开关）":"-"));
  try{
    var p=ohsidianReadUiPrefs();
    L.push("隐藏模式保留三键: "+(p.keepSystemTitleButtons===true?"开":"关"));
    L.push("嵌入网页字体: "+(p.webviewFonts===false?"关":"开"));
    L.push("Pandoc 路径: "+ohsidianPandocPath());
  }catch(e){}
  try{
    L.push("平台: desktop="+(window.app&&window.app.isMobile?"mobile":"desktop")+
      " 视口="+Math.round(window.innerWidth)+"x"+Math.round(window.innerHeight));
  }catch(e2){}
  return L;
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
    /* BUG-002 fallback entry: the settings tab above may not render in every
       layout, so the same switch also lives in the command palette. */
    app.commands.addCommand({id:"ohsidian-title-buttons",name:"OHSidian: 隐藏模式下保留系统窗口按钮 开/关 (重启生效)",
      callback:function(){
        ohsidianSetKeepSystemTitleButtons(!ohsidianReadUiPrefs().keepSystemTitleButtons);
      }});
    /* Diagnostics are namespaced on purpose: every command whose only job is
       troubleshooting starts with "OHSidian 诊断:" so it reads as a tool, and
       sits next to its siblings in the palette. */
    app.commands.addCommand({id:"ohsidian-diag-build",name:"OHSidian 诊断: 补丁与设置状态",
      callback:function(){
        var L=ohsidianBuildStatusLines();
        try{ohsidianShowReportModal("OHSidian 诊断: 补丁与设置状态",L)}catch(e){}
      }});
    app.commands.addCommand({id:"ohsidian-diag-pandoc",name:"OHSidian 诊断: Pandoc 环境",
      callback:function(){ohsidianRunPandocProbe()}});
    try{ohsidianScheduleSettingsTab()}catch(eTab){}
    /* TEMPORARY: toolbar hit-test probe (remove with the fix). */
    try{ohsidianInstallTouchProbe()}catch(eTP){}
    /* BUG-001: install the text-over-binary write guard as early as the vault
       allows - it is the only guard that covers code paths we do not know. */
    try{ohsidianInstallWriteGuard()}catch(eWG){}
    app.commands.addCommand({id:"ohsidian-console-capture",name:"OHSidian 诊断: 运行日志捕获 开/关 (重启生效)",
      callback:function(){
        try{
          var on=localStorage.getItem("ohsidianConsoleCapture")==="1";
          if(on)localStorage.removeItem("ohsidianConsoleCapture");
          else localStorage.setItem("ohsidianConsoleCapture","1");
          try{new Notice("OHSidian 运行日志捕获 → "+(on?"关闭":"开启")+" (重启应用后生效)")}catch(e){}
        }catch(e){}
      }});
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
