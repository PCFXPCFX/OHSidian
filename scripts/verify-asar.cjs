// Fresh-process asar verification: syntax-check app.js/main.js and assert
// all patch markers are present. Run from repo root:
//   node scripts/verify-asar.cjs
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { extractFile } = require('@electron/asar');
const { spawnSync } = require('child_process');

// The OB wrapper main.js ships inside the HAP (resfile), NOT inside the asar,
// so it must be verified by reading the file directly.
const wrapperPath = path.join(__dirname, '..', 'web_engine/src/main/resources/resfile/resources/app/main.js');
let wrapper = '';
try { wrapper = fs.readFileSync(wrapperPath, 'utf8'); } catch (e) {
  console.log('  WARN wrapper main.js unreadable:', e.message);
}

const asarPath = process.env.OHSIDIAN_ASAR_PATH
  ? path.resolve(process.env.OHSIDIAN_ASAR_PATH)
  : path.join(__dirname, '..', 'web_engine/src/main/resources/resfile/resources/app/obsidian.asar');
try {
  const app = extractFile(asarPath, 'app.js').toString('utf8');
  const main = extractFile(asarPath, 'main.js').toString('utf8');
  // index.html is upstream-owned (the OHSidian pipeline never rewrites it), and
  // no other gate reads it. Two surfaces depend on it: the enhancement hook
  // (enhance.js, where an optional renderer-side fix would have to attach) and
  // the 1.15.x scriptless startup-snapshot iframe that runs before app.js.
  // An upstream change to either would otherwise ship silently (audit G-2).
  const indexHtml = extractFile(asarPath, 'index.html').toString('utf8');
  try { new vm.Script(app); console.log('  OK  app.js syntax'); } catch (e) {
    console.log('  FAIL app.js syntax:', e.message);
    const m = e.stack && e.stack.match(/<anonymous>:(\d+):(\d+)/);
    if (m) {
      const lines = app.split('\n');
      const line = +m[1];
      console.log('  context:', JSON.stringify((lines[line - 1] || '').slice(0, 200)));
    }
    process.exit(1);
  }
  try { new vm.Script(main); console.log('  OK  main.js syntax'); } catch (e) {
    console.log('  FAIL main.js syntax:', e.message);
    process.exit(1);
  }
  const checks = {
    'app touch patch marker': /__ohsidianTouchPatch==="\d+"/.test(app),
    // Ink layer (docs/STYLUS-PEN.md P1/P2). These markers prove the block was
    // injected, the sidecar store + pressure side-channel are wired, and the
    // shared loopback socket was extended for stylus/pen messages.
    'app ink layer marker': app.includes('__ohsidianInkPatch') && app.includes('OHSIDIAN_INK_REV'),
    'app ink store + pressure tap': app.includes('.obsidian/ohsidian-ink') && app.includes('penSamplesOn'),
    'app ink surfaces + pdf write': app.includes('ohsidian-ink-base') && app.includes('inkWritePdf') &&
      app.includes('pdfInk'),
    'app ink settings + diagnostics hooks': app.includes('__ohsidianInkHooks') &&
      app.includes('buildSettings'),
    // Upstream mount surface (audit G-2, kernel 1.15.1).
    'upstream index.html keeps the enhance.js hook':
      indexHtml.includes('<script type="text/javascript" defer src="enhance.js">'),
    'upstream index.html keeps the startup snapshot':
      indexHtml.includes("frame.id = 'startup-snapshot'") &&
      indexHtml.includes("performance.measure('startup-snapshot-wait'"),
    // rev62: the pen must not narrate routine actions. Tool/view switches,
    // shape application and selection changes are visible on screen; only
    // failures and blockers may speak. "减少提示" off restores the old chatter.
    'app ink routine feedback is silent': app.includes('function inkQuietStatus(') &&
      !app.includes('notice("手写工具激活中'),
    'app ink one-time intro hint': app.includes('pref("inkIntroSeen"') &&
      app.includes('笔：写画 · 手指：操作界面 · 双击笔杆：工具条'),
    // P0 (docs/PDF-PERF-AUDIT.md): the PDF overlay is opt-in, bounded to the
    // visible pages, capped at 2x, redrawn per page, and its page table is
    // pruned instead of retaining detached canvases.
    'app ink pdf overlay bounded (P0)': app.includes('prunePages: function') &&
      app.includes('observePages: function') && app.includes('redrawPage: function') &&
      app.includes('if (!state.enabled) {'),
    // P1: cap each pdf.js page canvas at one screen's pixels, only on
    // high-DPI touch devices; desktop PCs keep the upstream 200.
    'app pdf canvas cap (P1)': app.includes(
      'maxCanvasPixels:16777216,capCanvasAreaFactor:(window.devicePixelRatio>=2&&((window.matchMedia&&window.matchMedia("(pointer: coarse)").matches)||navigator.maxTouchPoints>0)?0:200),'),
    'app native message fanout': app.includes('ohsidian-native-message') && app.includes('__ohsidianNativeSend'),
    // Round 98r revert: the vdec-shim experiment is shelved (see
    // docs/CHANGES-2026-09.md HEVC verdict); assert the toggle is GONE.
    'app video-hw toggle removed (98r revert)': !app.includes('ohsidian-video-hw'),
    // Round 96b bridge, error-default since NF-016. The ipcRenderer handle is
    // part of the gate: the original wiring used @electron/remote, which does
    // not export ipcRenderer, so the bridge was dead until the 2026-11-22 fix.
    'app console bridge (errors by default since NF-016)':
      app.includes('ohsidianConsoleCapture') && app.includes('ohsidianIpcRenderer'),
    'main console bridge (round 96b)': main.includes('__ohsidianConsoleBridge'),
    // pdf.js 5 loads pdf.worker.min.mjs as a module worker. Without a
    // JavaScript Content-Type the module worker is rejected and pdf.js
    // silently runs parsing on the UI thread (slow/white PDF pages).
    'main app:// MIME map (pdf worker)': main.includes('".mjs":"text/javascript; charset=utf-8"') &&
      main.includes('E.set("Content-Type",_ohMap[_ohExt])') &&
      main.includes('T["Content-Type"]=_ohMap[_ohExt]'),
    'app media hang watchdog (round 95c)': app.includes('loadedmetadata') && app.includes('__ohsidianWatched'),
    'app back-press consumer (round 96)': app.includes('applyBackPress'),
    // Round 104: back press must close the mobile drawer / tab switcher, and
    // its identity gate must run in touch mode before the seq advance.
    'app back-press ladder (round 104)':
      app.includes('is-left-sidedock-open') && app.includes('mobileTabSwitcher'),
    'app back-press touch identity (round 104)':
      app.includes('if(!touch){try{if(!document.hasFocus())return}catch(eF){}}'),
    // Round 105: root back press reports "nothing consumed" back to the page
    // (which exits the ability), and the media-viewer lightbox joins the
    // overlay rung so an open viewer is closed instead of exiting. Audit NF-010:
    // the ack is published through the field-owned merge, never by rewriting a
    // whole stale snapshot of the mode file.
    'app back-press root ack (round 105)':
      app.includes('patchModeFile({backAck:{seq:seq,handled:!!handled') && app.includes('.lightbox'),
    'app back-press ladder fn (round 105)': app.includes('handled=backLadder(touch)===true'),
    'app media codec guidance (round 95 bug 1)': app.includes('ohsidianOfferSystemPlayer'),
    'app atomic mode-file write (H1)': app.includes('writeModeFileSync'),
    'app trash meta sidecar (F2)': app.includes('.ohsidian-trash-meta.json'),
    'main trash purge will-quit pass (F-N16)': main.includes('__ohTrashPurgeOnce'),
    'main frame default unset=native (round 93e)': main.includes('k.frame==null'),
    'app per-window geometry match (round 87 B2)': app.includes('resolveGeometry'),
    'app event-driven keyboard (modePollMs=200)': app.includes('modePollMs=200'),
    'app system fonts style': app.includes('ohsidian-system-fonts'),
    'app restore-fonts command': app.includes('restoreSystemFonts'),
    'app vault migrate cmd': app.includes('ohsidian-vault-visible'),
    'app trash hook': app.includes('__ohsidianTrashHook'),
    // 2026-10-19 file-management safety patch: one timestamped move for both
    // trash destinations, an owner marker so the purge only cleans our own
    // trash, granted-aware documentsDir and a non-empty migration target guard.
    'app trash unified move + owner marker': app.includes('stampTree') && app.includes('.ohsidian-trash-owner.json'),
    'app migration non-empty target guard': app.includes('safeCopyDir') && app.includes('targetExisted'),
    // 2026-10-19 second audit: one completion callback (empty dirs used to
    // fire it early), strict trash containment, fallback stamping, symlink
    // preservation on cross-device moves, purge ctime race guard.
    'app migration single completion (2nd audit)': app.includes('if(!items.length)return doneDir(null)') && app.includes('var finish=function(err){'),
    'app trash strict containment (2nd audit)': app.includes('if(src.indexOf(baseResolved+pathMod.sep)!==0){'),
    'app trash fallback stamping (2nd audit)': app.includes('stampFallbackEntry') && app.includes('fsMod.symlinkSync(linkTarget,d)'),
    'main purge ctime guard (2nd audit)': main.includes('st.ctimeMs||0'),
    'app documentsDirGranted gate': app.includes('documentsDirPath') && app.includes('documentsDirGranted'),
    'main default vault writable probe': main.includes('__ohDvWritable'),
    'main purge owner marker': main.includes('__ohTrashOwnerFile'),
    'app mode-switch file sync': app.includes('syncActiveFileToTargetLayout'),
    // BUG-001: the layout sync must never write a media/binary path into a
    // markdown leaf (Leaf.setViewState trusts state.type and never re-checks the
    // extension, so the file would be opened as UTF-8 text). Guard + stale-path
    // scrub must survive every re-pack.
    'app binary-path guard (markdown leaf)': app.includes('ohsidianSetLeafFile') && app.includes('OHSIDIAN_BINARY_EXT'),
    // BUG-001: the last-ditch guard - a text write onto a file that is binary
    // on disk is refused. This is what would have saved the 182 MiB sample.
    'app text-over-binary write guard': app.includes('ohsidianInstallWriteGuard') && app.includes('headIsBinary'),
    // BUG-003: fonts inside an embedded <webview> (Custom Frames / Web viewer).
    // The guest is a separate webContents, so the top-document bridge cannot
    // reach it; the WRAPPER (HAP resfile) pushes insertCSS + a data: FontFace.
    'wrapper embedded webview font injector': wrapper.includes('installEmbeddedFontInjector') && wrapper.includes('embedFontDataUrl'),
    'wrapper FontFace guard retained': wrapper.includes('installFontFaceGuard'),
    // BUG-002: user switch that keeps the system window buttons in 隐藏 mode.
    'app title-buttons switch (settings + command)': app.includes('ohsidianEnsureSettingsTab') && app.includes('keepSystemTitleButtons'),
    // The tab must be constructed with the settings modal as its `setting`:
    // addSettingTab() calls tab.update(), and the base update() dereferences
    // this.setting.refreshSearch(). Passing null (rounds 168-176) killed the
    // registration with a message that pointed at the search component instead.
    'app settings tab constructed with the modal': app.includes('new Base(window.app,s)') && app.includes('ohsidianSettingsTabBase'),
    // Pandoc diagnostics: permanent feature (introduced as the BUG-004 probe,
    // promoted after the 2026-11-17 handover audit). The verdict table must keep
    // the two shapes that audit found missing: EPERM (platform refusal of an
    // adhoc binary) and a directory target (a Cellar keg is not a binary).
    'app pandoc environment check (feature)': app.includes('ohsidianBuildPandocReport') && app.includes('ohsidianPandocPath'),
    'app pandoc probe EPERM verdict': app.includes('execve 报 EPERM'),
    'app pandoc probe directory target': app.includes('target-is-directory') && app.includes('isDirectory&&'),
    // Handover HB-8/9/10/11 + WS-4a: EACCES split by the exec-bit evidence, the
    // EPERM "what to do next" block, the verdict index at the top of the report,
    // the shell probe passing the path as argv ($0) instead of pasting it into
    // the command string, and exec only for absolute paths.
    'app pandoc probe exec-bit EACCES split': app.includes('exec-eacces-perm'),
    'app pandoc report index': app.includes('"▍外部"') && app.includes('"候选: "+cands.length'),
    'app pandoc shell probe passes path as argv': app.includes('"$0" --version'),
    'app pandoc probe absolute paths only': app.includes('execve: skipped (relative)'),
    'app pandoc path input restored': app.includes('itemEl(pandocGroup,"外部路径"') &&
      app.includes('ohsidianSetPandocPath'),
    // Weak-sandbox decision (HB-1 ④, 2026-11-18): ArkTS publishes the measured
    // sandbox type into the shared mode file, the probe reads it, and EPERM in a
    // weak-sandbox build gets the B-WS-6 wording instead of the signature story.
    'app sandbox mode read from mode file': app.includes('function ohsidianSandboxMode') && app.includes('cfg.sandbox'),
    'app pandoc probe weak-sandbox EPERM text': app.includes('当前是弱沙箱（CUSTOM_SANDBOX 已授予）'),
    'app pandoc report sandbox line': app.includes('"沙箱: "+(sandbox||"unknown")'),
    // Round 195 (patch rev 195), both markers are unique to this patch (the
    // ohsidian prefix keeps them out of upstream's minified names):
    // ① the inline Pandoc check row got its own copy button (the command-
    //   palette report already had one), sharing one clipboard helper whose
    //   fallback covers the embedded renderer refusing navigator.clipboard;
    // ② the 跟随系统 layout flip is merged over a 2000ms window so ONE window
    //   action causes at most ONE reload (state machine §九 / invariant I9).
    'app diag reports copyable': app.includes('ohsidianCopyText') && app.includes('ohsidianShowReportModal'),
    'app layout flip debounce': app.includes('ohsidianFlipSettleMs=2000') &&
      app.includes('ohsidianFlipSettleRun'),
    // BUG-005: the mobile toolbar must not be a window drag region - this
    // engine implements -webkit-app-region and turned every tap into a move.
    'app toolbar not a drag region': app.includes('ohsidian-toolbar-hit') && app.includes('applyToolbarHitFix'),
    // BUG-002: the frame IPC must answer with the EFFECTIVE style (unset ->
    // native), otherwise the renderer builds its own titlebar on a natively
    // framed window and the user sees two sets of window buttons.
    'main frame ipc answers effective style': main.includes('__ohsidianFrameIpc') && main.includes('removeAllListeners("frame")'),
    'app platform class fallback': app.includes('applyPlatformClassFix') && app.includes('mod-linux'),
    // Mobile layout has no desktop title bar: with frame=hidden/custom the
    // bootstrap still builds frameDom and body.is-frameless reserves 30px for
    // it, which stacked on top of the status-bar inset (68.67px blank).
    'app mobile layout drops the desktop titlebar': app.includes('body.is-mobile.is-frameless{padding-top:0!important}'),
    // The borrowed tab class renders its own page into our container (the
    // OHSidian tab opened showing 关于): update() must be neutralised and
    // display() must clear the container first.
    'app settings tab owns its container': app.includes('__ohsidianSettingsPre') && app.includes('this.settingItems=[];return this'),
    // Settings switches must be built like Obsidian's own ToggleComponent
    // (`<label class="checkbox-container"><input type=checkbox></label>`). The
    // theme gives the real input `opacity:0` at ~15px in the container's
    // top-left corner and lets the visible thumb pass taps through, so only a
    // <label> forwards a tap on the knob to the input; with a <div> an enabled
    // row (thumb on the right) could not be turned off at all.
    'app settings switches are labels': app.includes('function ohsidianMakeToggle') &&
      app.includes('var box=document.createElement("label")') &&
      (app.match(/var toggleEl=ohsidianMakeToggle/g) || []).length === 2 &&
      !app.includes('mk("div","checkbox-container'),
    // Self-report command: proves which patch revision is actually running and
    // why the settings section did or did not register.
    'app build/settings status report': app.includes('ohsidianBuildStatusLines') && app.includes('ohsidianShowStatusReport'),
    // BUG-005 touch probe — TEMPORARY as well: logs what a bottom-of-screen
    // touch actually hits inside the page. Remove with the toolbar fix.
    'app touch probe (temporary)': app.includes('ohsidianInstallTouchProbe'),
    // rev201 task 2: the ink toolbar/menu/clear/selection chrome must be
    // non-interactive while any Obsidian overlay (settings modal, file/outline
    // drawer, menu, suggestion) is open.
    'app ink chrome blocked under overlays':
      app.includes('ohsidian-overlay-open') && app.includes('function overlayOpenNow()') &&
      app.includes('refreshOverlayGuard'),
    // rev202: drawers are signalled on workspace.containerEl and by a visible
    // .workspace-drawer element (the body-class/`.is-open` check never matched).
    'app ink overlay sees drawers':
      app.includes('var wsOpen = wsEl.classList.contains("is-left-sidedock-open")') &&
      app.includes('querySelectorAll(".workspace-drawer")'),
    // rev202: plugin setting tabs are registered by plugin id and de-duplicated.
    'app plugin setting tabs deduped':
      app.includes('function ohsidianDedupePluginSettingTabs(') &&
      app.includes('重复设置页已清理'),
    // rev201 task 1: generic plugin troubleshooting surface (error recorder +
    // persisted plugin-errors.json + generalised report + clear command).
    'app plugin error recorder':
      app.includes('ohsidianRecordConsoleError') && app.includes('plugin-errors.json') &&
      app.includes('OHSIDIAN_PLUGIN_ERR_MAX'),
    'app plugin troubleshooting report':
      app.includes('插件诊断') &&
      app.includes('ohsidianRunPluginIntegrityProbe') &&
      app.includes('插件错误（最近 12 条）'),
    // rev203: settings-page diagnostics hub, console.log in the status report,
    // sandbox diagnosis (declared / ACL / API) and the kernel settings-key fix.
    // rev210: three fact-only cards with one layout; diagnostics live only here.
    // rev211: native setting rows only; dedicated Pandoc section + Logs section
    // at the bottom; one action per row; single diagnostic at a time.
    'app settings sections are native rows':
      app.includes('newGroup("Pandoc")') &&
      app.includes('newGroup("诊断")') &&
      app.includes('newGroup("日志")') &&
      app.includes('diagRunRow(diag,"通用诊断"') &&
      app.includes('diagRunRow(diag,"Pandoc 诊断"') &&
      app.includes('diagRunRow(diag,"插件诊断"'),
    'app advanced sections hidden by default':
      app.includes('showDiagnostics') && app.includes('显示高级信息'),
    'app path rows are copy buttons':
      app.includes('addCopyRow(') && app.includes('复制失败'),
    'app single diagnostic at a time':
      app.includes('__ohsidianDiagBusy') && app.includes('ohsidianDiagRunWithLock'),
    'app diagnostics commands removed':
      !app.includes('id:"ohsidian-diag-') &&
      !app.includes('id:"ohsidian-console-capture"'),
    'app diagnostics are fact-only':
      app.includes('function ohsidianCompactLines') &&
      app.includes('补丁: "+OHSIDIAN_PATCH_REV') &&
      app.includes('内核: "+kernel'),
    'app logs have their own section':
      app.includes('itemEl(logGroup,"日志捕获"') && app.includes('itemEl(logGroup,"日志详情"') && app.includes('refreshLogPreview'),
    'app status report carries console log':
      app.includes('function ohsidianLogTailLines(') &&
      app.includes('ohsidian-log-preview'),
    // rev204: the log tail is current-session only (older boot records look like
    // live defects on a support screenshot) and the renderer log can be cleared.
    'app log tail is session-only':
      app.includes('window.__ohsidianBootAt=Date.now()') &&
      app.includes('已折叠更早会话'),
    'app clear renderer log':
      app.includes('function ohsidianClearConsoleLog()') &&
      app.includes('itemEl(logGroup,"清空当前日志"'),
    'app sandbox diagnosis explains strong':
      app.includes('function ohsidianSandboxMeta()') &&
      app.includes('本包未声明 CUSTOM_SANDBOX') &&
      app.includes('签名 profile 缺 CUSTOM_SANDBOX ACL'),
    'kernel settings definition keys unique':
      app.includes('function AEe(o,t){return o.id?o.type+":id:"+o.id:(o.heading?o.type+":"+o.heading:o.type)+"#"+t}'),
    // rev205: built-in pandoc (WebAssembly) - renderer loader + child_process
    // shim + settings/status/command surface.
    'app built-in pandoc wasm patched in':
      app.includes('window.__ohsidianPandocPatchRev = 213') &&
      app.includes('pandoc-service.cjs') &&
      app.includes('__ohsidianPandocWrapped'),
    // rev213 / audit NF-019 (F-1): the hook used to fabricate a result for
    // EVERY sync child_process call, so plugins lost real execSync/spawnSync
    // (direction of the 2574d04 "restore full Node" fix) and the external-path
    // probe reported "能启动，但退出码 127 —— 路径没问题，问题在这个程序内部"
    // about a binary that never ran. Non-pandoc calls must reach the real API;
    // only a pandoc sync call answers the explicit async-only error.
    'app pandoc hook passes non-pandoc sync through':
      app.includes('origExecSync.apply(cp, arguments)') &&
      app.includes('origSpawnSync.apply(cp, arguments)') &&
      !app.includes('execSync is unavailable in this sandbox'),
    // rev213 / audit NF-019 (F-2): the probes need the unwrapped module, and
    // the report must name the execution surface it measured.
    'app pandoc hook exposes real child_process':
      app.includes('cpReal = mod') && app.includes('get realChildProcess()') &&
      app.includes('__ohsidianPandocReal'),
    'app pandoc probes measure the real execution surface':
      app.includes('function ohsidianRealChildProcess') &&
      app.includes('ohsidianPandocExecSurface') &&
      app.includes('执行面: ') &&
      app.includes('probe-taken-over'),
    // rev213 / audit NF-022 (F-5): an unlisted BRAT build is not evidence of a
    // repackaged bundle - only the "is not a function" failure is.
    'app brat fingerprint wording is non-accusatory':
      app.includes('未收录的构建') && !app.includes('判定: 非官方/未知构建'),
    'app built-in pandoc wired to diagnostics':
      app.includes('ohsidianBuiltinPandocLabel') &&
      app.includes('function ohsidianRunPandocDiag') &&
      app.includes('addInfoValue(pandocGroup,"版本"'),
    'app pandoc default is the builtin engine':
      app.includes('ohsidianBuiltinPandocDir') && app.includes('类型: 内置(WASM)'),
    // rev206: device first run could not locate the assets, so the loader now
    // probes candidate layouts and the self-test/probe surfaces the tried dirs.
    'app pandoc asset path probe':
      app.includes('pandocDirTried') &&
      app.includes('function pandocProbe()') &&
      app.includes('ohsidianPandocProbeLines'),
    // rev207: the engine renderer has no WebAssembly, so the service falls back
    // to the main process over IPC; host diagnostics report both processes.
    'app pandoc main-process fallback':
      app.includes('ohs-pandoc-call') &&
      app.includes('createMainService') &&
      app.includes('wasmRenderer') &&
      app.includes('ohsidianPandocShowFailure'),
    // rev208: V8 is jitless on this engine, so pandoc runs in a utility
    // process started with --no-jitless; diagnostics expose host capability.
    'app pandoc host diagnostics':
      app.includes('ohs-pandoc-host') &&
      app.includes('工具进程: wasm='),
    'app font scale follower': app.includes('applyFontScale'),
    'app style-font follower (OhosThemeFont)': app.includes('"OhosThemeFont","HarmonyOS Sans"'),
    'app documents-dir migration': app.includes('pickMigration') && app.includes('当前仓库在应用沙箱内'),
    'app migration self-copy guard': app.includes('目标目录在当前仓库内'),
    'app font family cycle command': app.includes('ohsidian-font-family'),
    'app desktop safe-pad (viewportAware)': app.includes('viewportAvoidsBars'),
    'app round-88 body pad (titlebar avoidance)': app.includes('data-ohsidian-pad'),
    'app round-88 float-root pad': app.includes('.suggestion-bg{padding-top'),
    'main documents vault default': main.includes('__ohDvResolve'),
    'app font picker list injection': app.includes('window.__ohsidianSystemFonts||[]'),
    'app theme font face bridge': app.includes('applyThemeFontFace'),
    'app no adaptive keyboard poll': !app.includes('isEditing()?'),
    'main IPC guard': main.includes('__ohsidianIpcGuard'),
    // rev207: pandoc service host in the main process (renderer has no WebAssembly).
    'main pandoc service host': main.includes('__ohsidianPandocService') &&
      main.includes('ohs-pandoc-call') && main.includes('ohs-pandoc-host'),
    // rev208: dedicated utility process with --no-jitless + child_process fallback.
    'main pandoc utility host': main.includes('--no-jitless') &&
      main.includes('pandoc-host.cjs') && main.includes('utilityProcess') &&
      main.includes('__ohPandocUtil'),
    'main updater disabled': main.includes('(no||(k.updateDisabled=!0))'),
    // R1 (kernel-upgrade audit 2026-11-23): 1.15.1 reads
    // r.nativeTheme.shouldUseDarkColors on the first-window path, but this
    // engine's main-process shim has no nativeTheme module. The guard must stay
    // (an unguarded dereference is a boot-time TypeError).
    'main nativeTheme guard': main.includes('r.nativeTheme&&r.nativeTheme.shouldUseDarkColors'),
    // The renderer gate constant must stay exactly 28.2.3: raising it switches
    // 1.15.x onto engine-untested plugin-script-root / clipboard branches, and
    // the main-process floor must stay below the gate (28 >= 21).
    'app renderer floor const intact': app.includes('Ix="28.2.3"'),
    'main gate floor 21 intact': main.includes('if($t<21)'),
    // The two most load-bearing textual patches: if upstream re-minifies and
    // these go silently unmatched, the app crashes at startup (version gate)
    // or touch-mode vault switching dead-ends (drawer). Verify the patched
    // forms explicitly instead of trusting update-obsidian.mjs warnings.
    'main version-floor gate patched': main.includes('$t=Math.max(parseInt(fi.split(".")[0]),28)'),
    // src-first body patch: 'openVaultChooser()' alone also occurs in
    // upstream's "manage-vaults" branch, so assert the patched call sites
    // (drawer + settings select) and that the unpatched reload handlers are gone.
    'app drawer switch routed': app.includes('(Bm(t.path),i.app.openVaultChooser())'),
    'app settings vault select routed': app.includes('(Bm(u),this.app.openVaultChooser())'),
    'app drawer switch source replaced':
      !app.includes('setItem("mobile-selected-vault",t.path),location.reload()') &&
      !app.includes('setItem("mobile-selected-vault",u),location.reload()'),
    'main deeplink cursor file (no main-file rewrite)': main.includes('.cursor.json'),
    'main default vault fix': main.includes('__ohsidianDefaultVault'),
    'main deeplink bridge': main.includes('__ohsidianDeepLink'),
    // Audit NF-010: the mode file is a read-modify-write shared with ArkTS. Only
    // a field-preserving merge keeps the renderer from rolling back the native
    // keyboard/geometry fields it does not own.
    'app mode file field-owned merge': app.includes('function patchModeFile') &&
      app.includes('patchModeFile({backAck:') &&
      !app.includes('c.backAck={seq:seq,handled:!!handled,ts:Date.now()};'),
    // Audit NF-006/O-13: migration must wait for the editor saves it triggered.
    'app migration waits for editor saves': app.includes('var flushThen=function(cb)') &&
      app.includes('flushThen(function(){startMigration('),
    // Audit NF-012: "restore original PDF" has to clear written/baked/pdfHl.
    'app pdf restore resets written flags': app.includes('function resetPdfWrittenFlags') &&
      app.includes('resetPdfWrittenFlags(s)'),
    // Audit N-7: the renderer enforces the writer's page budget before shipping
    // the (up to several MB) request over the loopback IPC.
    'app pdf write page budget precheck': app.includes('var INK_PDF_MAX_POINTS = 80000') &&
      app.includes('if (totalPts > INK_PDF_MAX_POINTS)'),
    // Audit NF-008: the sidecar rename migration must be atomic (tmp+rename) and
    // must cancel the debounced save armed for the old key.
    'app ink rename migration atomic': app.includes('var waitIdle = function (fn)') &&
      app.includes('var timer = store.timers[oldKey];') &&
      app.includes('var tmp = dest + ".tmp";'),
    // The plugin require() shim must never take the emulate-mobile branch: this
    // renderer has full Node, and that branch returns null for every
    // non-whitelisted module (top-level require -> TypeError -> "插件加载失败",
    // in touch mode only). Assert the patched form positively AND the upstream
    // test negatively, so a skipped body patch is loud instead of silent.
    'app plugin require not gated by emulate-mobile':
      app.includes('l=!1,c=p=>Object.hasOwn(_oe,p)?') &&
      !app.includes('l=document.body.hasClass("emulate-mobile"),c=p=>Object.hasOwn(_oe,p)?'),
    // NF-015 on the 1.15.1 shape: the whole download lives in the single
    // helper UEe(); the patch replaces it and marks the sentinels the
    // behavioural gate in verify-plugin-install.cjs slices out.
    'app plugin download helper patched':
      app.includes('/*OHSIDIAN-PLUGIN-FETCH*/') &&
      app.includes('/*OHSIDIAN-PLUGIN-FETCH-END*/') &&
      app.includes('__ohsidianPluginDownloadIncomplete=true') &&
      app.includes('releases.obsidian.md/proxy?url='),
  };
  let ok = true;
  for (const [k, v] of Object.entries(checks)) {
    if (!v) ok = false;
    console.log((v ? '  OK  ' : '  FAIL') + ' ' + k);
  }
  /* Behavioural gate for the plugin-install / secretStorage patches
     (report 2026-11-22 NF-015/NF-018). Marker strings prove the patch is
     present; this proves the SHIPPED helper still does its job (validate a
     plugin body before writing it, recover a truncated body through the
     release proxy, fall back to plaintext secretStorage). Fixtures are
     synthetic, so it needs no network and no plugin files. */
  /* NF-020 (audit 2026-11-22 §6.2): interaction gate for the pandoc hook.
     Each gate used to test only its own half (WASM service behaviour, marker
     presence), so a hook that broke its NEIGHBOURS stayed green. This harness
     evaluates the shipped patch source with a fake module system and asserts
     the two contracts the probes depend on: non-pandoc sync calls reach the
     real platform API, and the original module is reachable. */
  {
    const patchPath = path.join(__dirname, 'patches/pandoc-wasm.js');
    const hookChecks = {};
    let harnessError = '';
    try {
      const patchSrc = fs.readFileSync(patchPath, 'utf8');
      const calls = [];
      const realCp = {
        exec: function () { calls.push('exec'); return 'orig-exec'; },
        execFile: function () { calls.push('execFile'); return 'orig-execFile'; },
        spawn: function () { calls.push('spawn'); return 'orig-spawn'; },
        execSync: function (cmd) { calls.push('execSync:' + cmd); return 'orig-execSync:' + cmd; },
        spawnSync: function (file) {
          calls.push('spawnSync:' + file);
          return { pid: 1, status: 0, signal: null, stdout: 'orig-spawnSync', stderr: '', output: [null, '', ''] };
        },
      };
      const fakeModule = {
        _load: function (request) { return request === 'child_process' ? realCp : {}; },
      };
      const fakeWindow = {};
      const sandbox = {
        window: fakeWindow,
        Buffer,
        console: { log() { }, warn() { }, error() { } },
        setTimeout,
        clearTimeout,
        process: { platform: 'linux', execPath: '/usr/bin/node', cwd: () => '/tmp', versions: {} },
        WebAssembly: undefined,
        require: (name) => {
          if (name === 'fs') return { readFileSync() { throw new Error('no fs in harness'); }, existsSync() { return false; } };
          if (name === 'path') return path;
          if (name === 'events') return require('events');
          if (name === 'module') return fakeModule;
          return {};
        },
      };
      vm.runInNewContext(patchSrc, sandbox, { filename: 'pandoc-wasm.js' });
      const wrapped = fakeModule._load('child_process');
      hookChecks['hook wraps child_process'] = wrapped !== realCp && wrapped.__ohsidianPandocWrapped === true;
      hookChecks['hook exposes the real module'] = wrapped.__ohsidianPandocReal === realCp &&
        !!fakeWindow.__ohsidianPandoc && fakeWindow.__ohsidianPandoc.realChildProcess === realCp;
      hookChecks['non-pandoc execSync passes through'] =
        wrapped.execSync('git status') === 'orig-execSync:git status';
      hookChecks['non-pandoc spawnSync passes through'] = (() => {
        const r = wrapped.spawnSync('git', ['status']);
        return !!r && r.stdout === 'orig-spawnSync';
      })();
      hookChecks['non-pandoc exec/spawn still delegate'] =
        wrapped.exec('/bin/ls') === 'orig-exec' && wrapped.spawn('/bin/ls') === 'orig-spawn';
      const syncErr = (() => { try { wrapped.execSync('pandoc --version'); return ''; } catch (e) { return String((e && e.message) || e); } })();
      hookChecks['pandoc execSync stays async-only'] = /只支持异步/.test(syncErr);
      const ps = (() => { try { return wrapped.spawnSync('pandoc', ['--version']); } catch (e) { return null; } })();
      hookChecks['pandoc spawnSync is a clear async-only result'] =
        !!ps && ps.status === 127 && /只支持异步/.test(String((ps.error && ps.error.message) || ''));
    } catch (e) {
      harnessError = String((e && e.stack) || e);
    }
    if (harnessError) { ok = false; console.log('  FAIL pandoc hook harness threw: ' + harnessError); }
    for (const [k, v] of Object.entries(hookChecks)) {
      if (!v) ok = false;
      console.log((v ? '  OK  ' : '  FAIL') + ' ' + k);
    }
    if (Object.keys(hookChecks).length < 7) {
      ok = false;
      console.log('  FAIL pandoc hook harness did not run every assertion (' + Object.keys(hookChecks).length + '/7)');
    }
  }
  const installGate = spawnSync(process.execPath, [path.join(__dirname, 'verify-plugin-install.cjs')], {
    stdio: 'inherit', cwd: __dirname, env: { ...process.env, OHSIDIAN_ASAR_PATH: asarPath },
  });
  if (installGate.status !== 0) ok = false;
  console.log(ok ? 'FRESH-PROCESS VERIFY: SYNTAX OK | all markers present' : 'FRESH-PROCESS VERIFY: FAILURES');
  process.exit(ok ? 0 : 1);
} catch (e) {
  console.error('FRESH-PROCESS VERIFY: ERROR ' + e.message);
  process.exit(1);
}
