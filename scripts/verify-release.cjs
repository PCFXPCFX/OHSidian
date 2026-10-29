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
  console.log('RELEASE VERIFY: OK - no device-agent probe in app.js');
} catch (e) {
  console.error('RELEASE VERIFY: ERROR ' + e.message);
  process.exit(1);
}
