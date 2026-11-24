#!/usr/bin/env node
/**
 * Native engine library integrity gate (audit 2026-11-24, G-1).
 *
 * electron/libs/arm64-v8a/*.so are git-LFS objects. A checkout or CI job that
 * skipped `git lfs pull` leaves the ~132-byte LFS pointer text in the working
 * tree; hvigor then packs that pointer as if it were the engine binary. The app
 * crashes on launch, and NONE of the asar gates can see it because they only
 * read the archive.
 *
 * This gate refuses pointer files and non-ELF content, and pins sizes + sha256
 * so a truncated or substituted library is caught too. Update the table
 * deliberately when the engine binaries are upgraded (the upgrade itself should
 * be a reviewed commit, exactly like the kernel pin).
 *
 * Usage: node scripts/verify-native-libs.cjs
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const LIB_DIR = path.join(__dirname, '..', 'electron', 'libs', 'arm64-v8a');
const LFS_POINTER = 'version https://git-lfs.github.com/spec/v1';
const ELF_MAGIC = Buffer.from([0x7f, 0x45, 0x4c, 0x46]);

/* Values captured from the verified working tree (2026-11-24). libadapter.so
   size + sha256 are the LFS oid/size recorded in the audit reports. */
const EXPECTED = {
  'libadapter.so': {
    size: 1500704,
    sha256: 'a7f6e4be3fb113b40b64cfb19b2666c5e91e3bf86cf662d90f776899de5330b0',
  },
  'libc++_shared.so': {
    size: 1261960,
    sha256: '0212d0e40711b98041101dffae12c17422d80a06dbfb13bd5f0142c78b8bf1f2',
  },
  'libelectron.so': {
    size: 160722000,
    sha256: '013974e02673ada5d746adf2021e8ca7ec623d14ab4ae3a0915b5d56713b1e40',
  },
  'libextractor.so': {
    size: 1267840,
    sha256: 'c2d4409fd9bb5a45e330ff101b8a9bbfb2a2676f54e3ece2989bf1118cdf09ae',
  },
  'libffmpeg.so': {
    size: 2181032,
    sha256: '107e2d52578166a4fe58405792b0f4a234303fb3a88b5b2ab164702efc155f77',
  },
};

let failures = 0;
function check(label, cond, detail) {
  console.log((cond ? '  OK   ' : '  FAIL ') + label + (cond || !detail ? '' : ' :: ' + detail));
  if (!cond) failures++;
}

if (!fs.existsSync(LIB_DIR)) {
  console.error('NATIVE-LIBS VERIFY: FAIL - missing directory ' + LIB_DIR);
  process.exit(1);
}

const present = fs.readdirSync(LIB_DIR).filter((f) => f.endsWith('.so'));
for (const [name, want] of Object.entries(EXPECTED)) {
  const file = path.join(LIB_DIR, name);
  if (!fs.existsSync(file)) {
    check(name + ' present', false, 'file missing');
    continue;
  }
  const buf = fs.readFileSync(file);
  check(name + ' is not an LFS pointer', !buf.slice(0, 64).toString('utf8').startsWith(LFS_POINTER),
    'checked out without `git lfs pull`');
  check(name + ' is an ELF shared object', buf.length >= 4 && buf.slice(0, 4).equals(ELF_MAGIC),
    'magic=' + buf.slice(0, 4).toString('hex'));
  check(name + ' size ' + want.size, buf.length === want.size, 'got ' + buf.length);
  const sha = crypto.createHash('sha256').update(buf).digest('hex');
  check(name + ' sha256 pinned', sha === want.sha256, 'got ' + sha);
}
for (const extra of present) {
  if (!EXPECTED[extra]) check('unexpected extra library ' + extra + ' is pinned', false);
}

console.log(failures
  ? 'NATIVE-LIBS VERIFY: FAILURES (' + failures + ')'
  : 'NATIVE-LIBS VERIFY: OK (' + Object.keys(EXPECTED).length + ' libraries, ELF + size + sha256)');
process.exit(failures ? 1 : 0);
