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
    'IME insert path records the candidate': ime.includes('this.imeLastInsertText = text'),
    'IME insert path tops up an under-delete': ime.includes('this.nativeContext.DeleteBackCallback(deficit)'),
    'IME delete path forwards the original length first': ime.includes('this.nativeContext.DeleteBackCallback(length)'),
    'IME revision window + prefix guard': ime.includes('IME_REVISION_WINDOW_MS') && ime.includes('imePrefixRelated'),
    'IME other input events clear the segment': ime.includes('resetImeSegmentState'),
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
