;(function(){try{
if(window.__ohsidianTouchPatch==="21")return;window.__ohsidianTouchPatch="22";
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
    setTimeout(function(){
      try{
        if(!el.isConnected||el.error||el.__ohsidianMediaNoticed)return;
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
              for(var i=0;i<others.length;i++){
                var w=others[i];
                try{if(!(w.isDestroyed&&w.isDestroyed()))w.close()}catch(e4){}
              }
              /* Keep retrying: close() is asynchronous, a sibling may refuse
                 to close (beforeunload) or a second vault window may appear. */
              again=tries<6;
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
            try{if(leaf&&leaf.view&&typeof leaf.view.save==="function")leaf.view.save()}catch(eS){}
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
    app.commands.addCommand({id:"ohsidian-console-capture",name:"OHSidian: 运行日志捕获 开/关 (重启生效)",
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
