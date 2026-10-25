// Fresh-process asar verification: syntax-check app.js/main.js and assert
// all patch markers are present. Run from repo root:
//   node scripts/verify-asar.cjs
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { extractFile } = require('@electron/asar');

// The OB wrapper main.js ships inside the HAP (resfile), NOT inside the asar,
// so it must be verified by reading the file directly.
const wrapperPath = path.join(__dirname, '..', 'web_engine/src/main/resources/resfile/resources/app/main.js');
let wrapper = '';
try { wrapper = fs.readFileSync(wrapperPath, 'utf8'); } catch (e) {
  console.log('  WARN wrapper main.js unreadable:', e.message);
}

const asarPath = path.join(__dirname, '..', 'web_engine/src/main/resources/resfile/resources/app/obsidian.asar');
try {
  const app = extractFile(asarPath, 'app.js').toString('utf8');
  const main = extractFile(asarPath, 'main.js').toString('utf8');
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
    // Round 98r revert: the vdec-shim experiment is shelved (see
    // docs/CHANGES-2026-09.md HEVC verdict); assert the toggle is GONE.
    'app video-hw toggle removed (98r revert)': !app.includes('ohsidian-video-hw'),
    'app console bridge opt-in (round 96b)': app.includes('ohsidianConsoleCapture'),
    'main console bridge (round 96b)': main.includes('__ohsidianConsoleBridge'),
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
    // overlay rung so an open viewer is closed instead of exiting.
    'app back-press root ack (round 105)':
      app.includes('c.backAck={seq:seq,handled:!!handled') && app.includes('.lightbox'),
    'app back-press ladder fn (round 105)': app.includes('handled=backLadder(touch)===true'),
    'app media codec guidance (round 95 bug 1)': app.includes('ohsidianOfferSystemPlayer'),
    'app atomic mode-file write (H1)': app.includes('writeModeFileSync'),
    'app trash meta sidecar (F2)': app.includes('.ohsidian-trash-meta.json'),
    'main trash purge will-quit pass (F-N16)': main.includes('__ohTrashPurgeOnce'),
    'main frame default unset=native (round 93e)': main.includes('D.frame==null'),
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
    // BUG-004 probe — TEMPORARY: ships so the reporter can answer "ENOENT vs
    // EACCES" in one click. Remove this marker together with the probe code,
    // its command and its settings button in the version after next.
    'app pandoc environment check (feature)': app.includes('ohsidianBuildPandocReport') && app.includes('ohsidianPandocPath'),
    // BUG-005: the mobile toolbar must not be a window drag region - this
    // engine implements -webkit-app-region and turned every tap into a move.
    'app toolbar not a drag region': app.includes('ohsidian-toolbar-hit') && app.includes('applyToolbarHitFix'),
    // BUG-002: the frame IPC must answer with the EFFECTIVE style (unset ->
    // native), otherwise the renderer builds its own titlebar on a natively
    // framed window and the user sees two sets of window buttons.
    'main frame ipc answers effective style': main.includes('__ohsidianFrameIpc') && main.includes('removeAllListeners("frame")'),
    'app platform class fallback': app.includes('applyPlatformClassFix') && app.includes('mod-linux'),
    // Self-report command: proves which patch revision is actually running and
    // why the settings section did or did not register.
    'app build/settings status command': app.includes('ohsidianBuildStatusLines') && app.includes('ohsidian-diag-build'),
    // BUG-005 touch probe — TEMPORARY as well: logs what a bottom-of-screen
    // touch actually hits inside the page. Remove with the toolbar fix.
    'app touch probe (temporary)': app.includes('ohsidianInstallTouchProbe'),
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
    'main updater disabled': main.includes('(at||(D.updateDisabled=!0))'),
    // The two most load-bearing textual patches: if upstream re-minifies and
    // these go silently unmatched, the app crashes at startup (version gate)
    // or touch-mode vault switching dead-ends (drawer). Verify the patched
    // forms explicitly instead of trusting update-obsidian.mjs warnings.
    'main version-floor gate patched': main.includes('bo=Math.max(parseInt(fo.split(".")[0]),28)'),
    // src-first body patch: 'i.app.openVaultChooser()' alone also occurs in
    // upstream's "manage-vaults" branch, so assert the patched call site and
    // that the unpatched drawer handler is gone.
    'app drawer switch routed': app.includes('(Wf(n),i.app.openVaultChooser())'),
    'app drawer switch source replaced': !app.includes('setItem("mobile-selected-vault",n),location.reload()'),
    'main deeplink cursor file (no main-file rewrite)': main.includes('.cursor.json'),
    'main default vault fix': main.includes('__ohsidianDefaultVault'),
    'main deeplink bridge': main.includes('__ohsidianDeepLink'),
  };
  let ok = true;
  for (const [k, v] of Object.entries(checks)) {
    if (!v) ok = false;
    console.log((v ? '  OK  ' : '  FAIL') + ' ' + k);
  }
  console.log(ok ? 'FRESH-PROCESS VERIFY: SYNTAX OK | all markers present' : 'FRESH-PROCESS VERIFY: FAILURES');
  process.exit(ok ? 0 : 1);
} catch (e) {
  console.error('FRESH-PROCESS VERIFY: ERROR ' + e.message);
  process.exit(1);
}
