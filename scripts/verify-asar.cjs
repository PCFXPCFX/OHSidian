// Fresh-process asar verification: syntax-check app.js/main.js and assert
// all patch markers are present. Run from repo root:
//   node scripts/verify-asar.cjs
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { extractFile } = require('@electron/asar');

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
    'app touch patch v14': app.includes('__ohsidianTouchPatch==="14"'),
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
    'app mode-switch file sync': app.includes('syncActiveFileToTargetLayout'),
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
    'app drawer switch routed': app.includes('i.app.openVaultChooser()'),
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
