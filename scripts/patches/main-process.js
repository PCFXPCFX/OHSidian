;(function(){try{
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
        if(cfg&&cfg.documentsDirGranted===false)return null;
        var docs=cfg&&cfg.documentsDir;
        if(typeof docs==="string"&&docs.length>0){
          try{__ohDvFs.accessSync(docs)}catch(e){return null}
          return __ohDvPathMod.join(docs,"OHSidian","Obsidian Vault");
        }
      }catch(e){}
      return null;
    };
    var __ohDvWritable=function(dir){
      try{
        var probe=__ohDvPathMod.join(dir,".ohsidian-write-test-"+process.pid+"-"+Date.now());
        __ohDvFs.writeFileSync(probe,"ok","utf8");
        try{__ohDvFs.unlinkSync(probe)}catch(eU){}
        return true;
      }catch(e){return false}
    };
    var __ohDvEnsure=function(p){
      try{__ohDvFs.mkdirSync(p,{recursive:true})}catch(e){}
      if(!__ohDvWritable(p)){
        try{console.warn("[OHSidian] default vault dir not writable, falling back:",p)}catch(eW){}
        return null;
      }
      return p;
    };
    require("electron").ipcMain.on("get-default-vault-path",function(evt){
      try{
        var docsVault=__ohDvResolve();
        if(docsVault){
          var docsEnsured=__ohDvEnsure(docsVault);
          if(docsEnsured){
            evt.returnValue=docsEnsured;
            try{console.log("[OHSidian] default vault root -> documents/OHSidian")}catch(eL){}
            return;
          }
        }
        /* fallback: previous OHSidian behaviour (sandbox userData) */
        var fallback=__ohDvEnsure(__ohDvPathMod.join(__ohDvUserData,"Obsidian Vault"));
        evt.returnValue=fallback||__ohDvPathMod.join(__ohDvUserData,"Obsidian Vault");
        try{console.log("[OHSidian] default vault root -> userData (documents unavailable)")}catch(eL2){}
      }catch(e){
        try{evt.returnValue=__ohDvPathMod.join(__ohDvUserData,"Obsidian Vault")}catch(e2){}
      }
    });
  }catch(e){}
};
/* Register one tick AFTER the engine's own whenReady().then registration:
   sync IPC replies use the last writer of event.returnValue, and the engine
   registers its stock handler in a microtask after ready. A setTimeout runs
   after those microtasks, so this override is the last listener. (If the
   platform turns out to use first-writer- wins, behaviour is unchanged.) */
var __ohDvRegisterLater=function(){setTimeout(__ohDvRegister,0)};
if(__ohDvApp.isReady()){__ohDvRegisterLater()}else{__ohDvApp.on("ready",__ohDvRegisterLater)}
}catch(e){}})();
/* Console bridge main-process side (round 96b): receives renderer console
   lines (opt-in, see the TOUCH patch) and (1) re-prints them with the
   [OHSidian:web] prefix on the main process console - visible in hilog
   whenever the engine routes main stderr there, same as the other
   [OHSidian] main lines - and (2) appends them to
   <Documents|userData>/OHSidian/console.log (single 512KB rotation to
   console.old.log), pullable from 文件管理 or \`hdc file recv\` on the
   public Documents path. */
;(function(){try{
if(globalThis.__ohsidianConsoleBridge)return;globalThis.__ohsidianConsoleBridge=true;
var __cbEl=require("electron"),__cbFs=require("fs"),__cbPath=require("path");
var __cbLogPath=null;
var __cbResolve=function(){
  if(__cbLogPath)return __cbLogPath;
  try{
    var ud=__cbEl.app.getPath("userData");
    var docs=null;
    try{
      var cfg=JSON.parse(__cbFs.readFileSync(__cbPath.join(ud,"ohsidian-mode.json"),"utf8"));
      if(cfg&&typeof cfg.documentsDir==="string"&&cfg.documentsDir&&cfg.documentsDirGranted!==false)docs=cfg.documentsDir;
    }catch(e0){}
    var base=docs?__cbPath.join(docs,"OHSidian"):ud;
    try{__cbFs.mkdirSync(base,{recursive:true})}catch(e1){}
    __cbLogPath=__cbPath.join(base,"console.log");
    return __cbLogPath;
  }catch(e){return null}
};
var __cbAppend=function(line){
  try{
    var p=__cbResolve();if(!p)return;
    var st=null;try{st=__cbFs.statSync(p)}catch(e2){st=null}
    if(st&&st.size>512*1024){try{__cbFs.renameSync(p,p+".old.log")}catch(e3){}}
    __cbFs.appendFileSync(p,"["+new Date().toISOString()+"] "+line+"\n","utf8");
  }catch(e){}
};
__cbEl.ipcMain.on("ohs-console",function(_evt,payload){
  try{
    var level=(payload&&payload.level)||"log";
    var text=(payload&&payload.text)||"";
    if(typeof text!=="string")text=String(text);
    if(text.length>4000)text=text.substring(0,4000)+"…";
    var m=(level==="warn"||level==="error"||level==="info"||level==="debug")?level:"log";
    try{console[m]("[OHSidian:web] "+text)}catch(e1){}
    __cbAppend("[OHSidian:web]["+m+"] "+text);
  }catch(e){}
});
try{console.log("[OHSidian] console bridge ready (renderer opt-in: 命令面板 → 运行日志捕获)")}catch(e2){}
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
var __ohTrashOwnerFile=".ohsidian-trash-owner.json";
var __ohTrashPurgeOnce=function(){try{
  var el=require("electron"),fsMod=require("fs"),pathMod=require("path");
  var ud=el.app.getPath("userData");
  var roots=[];
  try{
    var cfg=JSON.parse(fsMod.readFileSync(pathMod.join(ud,"ohsidian-mode.json"),"utf8"));
    var docs=cfg&&typeof cfg.documentsDir==="string"&&cfg.documentsDir&&cfg.documentsDirGranted!==false?cfg.documentsDir:"";
    if(docs)roots.push(pathMod.join(docs,"OHSidianTrash"));
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
  var recentGuard=10*60*1000;
  var purged=0,touched=0;
  var seen={};
  var owned=function(root){
    try{return fsMod.existsSync(pathMod.join(root,__ohTrashOwnerFile))}catch(e){return false}
  };
  var walk=function(dir,depth){
    if(depth>64)return;
    var es;try{es=fsMod.readdirSync(dir,{withFileTypes:true})}catch(e){return}
    for(var i=0;i<es.length;i++){
      var en=es[i];if(!en||en.name==="."||en.name==="..")continue;
      if(en.name===__ohTrashOwnerFile)continue;
      var fp=pathMod.join(dir,en.name);
      try{
        if(en.isDirectory()){walk(fp,depth+1);try{fsMod.rmdirSync(fp)}catch(eE){}}
        else if(en.isFile()){
          /* Sidecars are removed together with their file, never on their own. */
          if(fp.slice(-__ohTrashMetaSuffix.length)===__ohTrashMetaSuffix)continue;
          var st=fsMod.statSync(fp);
          /* A concurrent purge in another process could observe the entry
             between rename and utimes (old mtime, new ctime); never touch a
             freshly changed entry. */
          if(now-(st.ctimeMs||0)<recentGuard)continue;
          var ageBase=st.mtimeMs;
          /* F2: prefer the recorded deletion time over the file's own mtime
             (which is the ORIGINAL content mtime when utimesSync failed). */
          try{
            var mc=JSON.parse(fsMod.readFileSync(fp+__ohTrashMetaSuffix,"utf8"));
            if(mc&&typeof mc.deletedAt==="number"&&mc.deletedAt>0)ageBase=mc.deletedAt;
          }catch(eM){}
          /* Do not purge what another window may have just moved in: the
             rename -> utimes window used to expose the original mtime. */
          if(now-ageBase<recentGuard)continue;
          if(now-ageBase>__ohTrashMaxAge){
            try{fsMod.unlinkSync(fp);purged++}catch(eU){}
            try{fsMod.unlinkSync(fp+__ohTrashMetaSuffix)}catch(eS){}
          }
        }
      }catch(eE){}
    }
  };
  for(var r=0;r<roots.length;r++){
    var root=roots[r];
    /* Only clean trashes this feature created. A user/plugin-created .trash
       (or an OHSidianTrash from before this marker existed) is left alone. */
    if(!owned(root))continue;
    if(seen[root])continue;
    seen[root]=1;
    touched++;
    walk(root,0);
  }
  try{console.log("[OHSidian] trash purge: roots="+roots.length+", owned="+touched+", removed="+purged)}catch(e){}
}catch(e){}};
setTimeout(__ohTrashPurgeOnce,60000);
/* F-N16: best-effort second pass at quit - covers sessions shorter than
   60s and long-running background sessions that never restart. */
try{require("electron").app.on("will-quit",function(){try{__ohTrashPurgeOnce()}catch(e){}})}catch(e){}
}catch(e){}})();/*OHSIDIAN-IPC-GUARD-END*/
;(function(){try{
/* Touch mode is single-window by design, and the engine's vault-open listener
   always creates a NEW window (one OHOS mission per ability). Closing the old
   vault window AFTER that new window is on screen makes the system play its
   "app leaves, the icon flies home" exit animation over the switch - the flash
   the user reports when switching vaults. Close the old windows HERE instead:
   ipcMain listeners run in registration order and this patch is prepended to
   main.js, so this fires BEFORE the engine creates the new window - while the
   vault chooser (same app, still on screen) is the visible window. The app
   therefore never loses its last visible window, so no exit animation is
   drawn; the chooser then closes itself onto the freshly created window.
   Desktop/PC mode is NOT touched (multi-window behaviour stays). */
if(globalThis.__ohsidianVaultReap)return;globalThis.__ohsidianVaultReap=true;
var __vrEl=require("electron"),__vrFs=require("fs"),__vrPath=require("path");
var __vrTouch=function(){
  try{
    var ud=__vrEl.app.getPath("userData");
    var cfg=JSON.parse(__vrFs.readFileSync(__vrPath.join(ud,"ohsidian-mode.json"),"utf8"));
    return !!(cfg&&cfg.systemMode==="touch");
  }catch(e){return false}
};
var __vrSenderWindow=function(ev){
  try{
    var BW=__vrEl.BrowserWindow;
    if(BW&&BW.fromWebContents&&ev&&ev.sender){
      var w=BW.fromWebContents(ev.sender);
      if(w)return w;
    }
  }catch(e){}
  try{
    var all=__vrEl.BrowserWindow.getAllWindows();
    for(var i=0;i<all.length;i++){
      if(all[i].webContents&&ev&&ev.sender&&all[i].webContents.id===ev.sender.id)return all[i];
    }
  }catch(e){}
  return null;
};
__vrEl.ipcMain.on("vault-open",function(ev){
  try{
    if(!__vrTouch())return;
    var self=__vrSenderWindow(ev);
    var all=__vrEl.BrowserWindow.getAllWindows();
    var killed=0;
    for(var i=0;i<all.length;i++){
      var w=all[i];
      try{
        if(self&&w.id===self.id)continue;
        var u=(w.webContents&&w.webContents.getURL)?String(w.webContents.getURL()):"";
        if(/starter\.html|help|sandbox|devtools/i.test(u))continue;
        if(w.isDestroyed&&w.isDestroyed())continue;
        /* destroy(): immediate - close() defers the real destroy by 3 s in the
           engine ("close" handler setTimeout), which is what previously left
           the old window on screen behind the switch. */
        if(w.destroy)w.destroy();else w.close();
        killed++;
      }catch(e){}
    }
    try{console.log("[OHSidian] vault-open: closed "+killed+" old vault window(s) behind the chooser")}catch(e){}
  }catch(e){}
});
}catch(e){}})();
;(function(){try{
/* BUG-002: the frame style over IPC.
   The renderer decides its title bar with
       var t = ipcRenderer.sendSync("frame") || "hidden";
       if (t !== "native") frameDom = new ObsidianFrameDom(...);
   and the main process answers with the RAW config value - null when the user
   never picked one. Our round-93 patch makes an UNSET value mean NATIVE when the
   window is created, so answering null built Obsidian's own titlebar on a
   natively framed window: two sets of window buttons (device log
   17:12:13.545 [1,1,1] -> 13.546 [0,0,0] -> 14.204 [1,1,1]).
   Answer with the EFFECTIVE style so both sides agree. */
var __ohEl=require("electron");
var __ohApp=__ohEl&&__ohEl.app;
var __ohIpc=__ohEl&&__ohEl.ipcMain;
if(__ohApp&&__ohIpc&&typeof __ohIpc.on==="function"){
  var __ohEffectiveFrame=function(){
    try{
      var fs2=require("fs"),np=require("path");
      var p=np.join(__ohApp.getPath("userData"),"obsidian.json");
      if(!fs2.existsSync(p))return "native";
      var j=JSON.parse(fs2.readFileSync(p,"utf8"));
      var f=j&&j.frame;
      if(f==="native"||f==="custom"||f==="hidden")return f;
      return "native";   /* unset -> native, same rule as window creation */
    }catch(e){return "native"}
  };
  var __ohInstallFrameIpc=function(){
    try{
      if(__ohIpc.__ohsidianFrameIpc)return;
      try{__ohIpc.removeAllListeners("frame")}catch(eR){}
      __ohIpc.on("frame",function(event){
        try{event.returnValue=__ohEffectiveFrame()}catch(e){}
      });
      __ohIpc.__ohsidianFrameIpc=1;
      try{console.log("[OHSidian] frame IPC -> "+__ohEffectiveFrame()+" (unset counts as native)")}catch(e){}
    }catch(e){}
  };
  if(__ohApp.isReady&&__ohApp.isReady()){
    __ohInstallFrameIpc();
  }else if(typeof __ohApp.whenReady==="function"){
    __ohApp.whenReady().then(__ohInstallFrameIpc).catch(function(){});
  }else{
    setTimeout(__ohInstallFrameIpc,0);
  }
}
}catch(e){}})();/*OHSIDIAN-MAIN-PATCH-END*/
