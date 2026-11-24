// Release guard: the shipped asar must not contain the device-agent probe.
// Run after `update-obsidian.mjs --repatch` (without --agent):
//   node scripts/verify-release.cjs
const fs = require('fs');
const path = require('path');
const { extractFile } = require('@electron/asar');

const asarPath = path.join(__dirname, '..',
  'web_engine/src/main/resources/resfile/resources/app/obsidian.asar');
const forbidden = [
  '__ohsidianProbeHooks',
  'probeHook',
  'InkProbe',
  'canvasWhiteSample',
  'fakeWorker',
  'probeCount',
];
try {
  const app = extractFile(asarPath, 'app.js').toString('utf8');
  const hits = forbidden.filter((k) => app.includes(k));
  if (hits.length) {
    console.error('RELEASE VERIFY: FAIL - agent probe remnants: ' + hits.join(', '));
    process.exit(1);
  }
  if (!app.includes('OHSIDIAN_INK_REV')) {
    console.error('RELEASE VERIFY: FAIL - ink layer missing');
    process.exit(1);
  }
  /* Issue #2 (handwriting IME duplication) mitigation guard: the ArkTS
     candidate-segment accounting is compiled into the HAP's ets/modules.abc,
     not into the asar, so nothing else in the gate chain would notice a silent
     revert - and a release note that says "IME mitigation" would then be
     advertising code that is not there. */
  const imePath = path.join(__dirname, '..', 'web_engine/src/main/ets/adapter/IMFAdapter.ets');
  let ime = '';
  try { ime = fs.readFileSync(imePath, 'utf8'); } catch (e) {
    console.error('RELEASE VERIFY: FAIL - cannot read IMFAdapter.ets: ' + e.message);
    process.exit(1);
  }
  const imeChecks = {
    'IME accounting switch present': ime.includes('IME_SEGMENT_CORRECTION_ENABLED'),
    'IME insert path records the candidate': ime.includes('imeSegment.lastInsertText = text'),
    'IME insert path tops up an under-delete': ime.includes('this.imeDeleteBack(deficit)'),
    'IME delete path forwards the original length': ime.includes('this.imeDeleteBack(length)'),
    // Device HiLog 2026-11-24: the pinned engine ignores DeleteBackward's count
    // (DeleteLeft length 2 moved the caret one char), so a multi-character
    // candidate revision left text behind and handwriting accumulated
    // (我 我我 我我爱 ...). The count must be emulated with single deletes.
    'IME multi-delete emulated (engine ignores the count)':
      ime.includes('IME_EMULATE_MULTI_DELETE') &&
      ime.includes('this.nativeContext.DeleteBackCallback(1)') &&
      ime.includes('IME multi-delete emulated:'),
    'IME revision window + prefix guard': ime.includes('IME_REVISION_WINDOW_MS') && ime.includes('imePrefixRelated'),
    'IME other input events clear the segment': ime.includes('resetImeSegmentState'),
    // Audit B-4: IMFAdapter is resolved through Inject.getOrCreate() with the
    // default (transient) inversify scope, so state MUST be module-level or it
    // resets on every callback and the listener flag re-registers listeners.
    'IME state is module-scoped (DI-transient safe)':
      ime.includes('const imeSegment: ImeSegmentState') && ime.includes('class ImeSegmentState'),
    'IME listener registration is guarded once': ime.includes('if (imeSegment.listenBound)'),
    // Audit B-1: guess-correction must not run where UTF-16 code units and the
    // platform's character count can diverge (surrogate pairs).
    'IME surrogate-pair segments skip the correction': ime.includes('imeHasSurrogate(prev)'),
  };
  const imeFail = Object.entries(imeChecks).filter(([, v]) => !v).map(([k]) => k);
  if (imeFail.length) {
    console.error('RELEASE VERIFY: FAIL - Issue #2 ArkTS accounting missing: ' + imeFail.join(', '));
    process.exit(1);
  }
  console.log('RELEASE VERIFY: OK - no device-agent probe in app.js');
  console.log('RELEASE VERIFY: OK - Issue #2 ArkTS candidate-segment accounting present');
} catch (e) {
  console.error('RELEASE VERIFY: ERROR ' + e.message);
  process.exit(1);
}
