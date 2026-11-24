#!/usr/bin/env node
/**
 * Content fingerprints of the shipped asar (audit 2026-11-24, G-3 / I-3).
 *
 * The archive-level sha256 of obsidian.asar is NOT reproducible across
 * environments: the asar header embeds a per-file integrity table whose
 * granularity depends on the @electron/asar version (two audit rebuilds differed
 * by ~5 KB in the header while the data payload was byte-identical). For release
 * verification and archival, record the CONTENT fingerprints instead:
 *
 *   app.js  / main.js sha256 + byte length   <- stable across toolchains
 *   obsidian.asar sha256 + size              <- auxiliary only
 *
 * Usage:
 *   node scripts/asar-fingerprint.cjs                     # installed asar
 *   OHSIDIAN_ASAR_PATH=<staged asar> node scripts/asar-fingerprint.cjs
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { extractFile } = require('@electron/asar');

const asarPath = process.env.OHSIDIAN_ASAR_PATH
  ? path.resolve(process.env.OHSIDIAN_ASAR_PATH)
  : path.join(__dirname, '..', 'web_engine/src/main/resources/resfile/resources/app/obsidian.asar');

function sha(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

if (!fs.existsSync(asarPath)) {
  console.error('ASAR FINGERPRINT: FAIL - not found: ' + asarPath);
  process.exit(1);
}
const archive = fs.readFileSync(asarPath);
const app = extractFile(asarPath, 'app.js');
const main = extractFile(asarPath, 'main.js');
const pkg = JSON.parse(extractFile(asarPath, 'package.json').toString('utf8'));
console.log('ASAR FINGERPRINT: ' + path.relative(path.join(__dirname, '..'), asarPath));
console.log('  kernel            ' + pkg.version);
console.log('  app.js            ' + app.length + ' bytes  sha256 ' + sha(app));
console.log('  main.js           ' + main.length + ' bytes  sha256 ' + sha(main));
console.log('  obsidian.asar     ' + archive.length + ' bytes  sha256 ' + sha(archive) + '  (auxiliary: depends on @electron/asar header granularity)');
