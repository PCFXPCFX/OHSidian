#!/usr/bin/env node
/**
 * Weak-sandbox (CUSTOM_SANDBOX) switch for the OHSidian module manifest.
 *
 * Decision record: 2026-11-18, HB-1 ④ from the audit handover package — the app
 * may execve external binaries (harmonybrew's adhoc pandoc, HNP payloads) only
 * from a weak sandbox, which is an ACL'd, system_grant permission:
 *
 *   ohos.permission.CUSTOM_SANDBOX        system_basic / system_grant / since 18
 *   ohos.permission.READ_WRITE_USER_FILE  system_basic / system_grant / since 13
 *
 * (metadata: SDK toolchains/lib/PermissionDefinitions.json)
 *
 * Declaring them in module.json5 is NOT enough: the signing profile must carry
 * the same names in its `acls` list, otherwise the token manager answers DENIED,
 * the app reports sandbox=strong, and nothing changes except a manifest entry.
 *
 *   node scripts/weak-sandbox.mjs status   # what the manifest currently says
 *   node scripts/weak-sandbox.mjs apply    # add both entries (idempotent)
 *   node scripts/weak-sandbox.mjs revert   # remove them again (byte-identical)
 *
 * The manifest edit is deliberately NOT part of the default build: a package
 * that declares an ACL permission without carrying it in the profile is not a
 * shippable release package.
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const MANIFEST = path.join(ROOT, 'electron/src/main/module.json5');

const BLOCK = [
  '      {',
  '        // Handover HB-1 ④ (weak sandbox, decided 2026-11-18): system_basic /',
  '        // system_grant ACL permission. It only takes effect when the signing',
  '        // profile carries the same name in its `acls` list - see',
  '        // docs/PLATFORM-ADAPTATION.md §五. Without the ACL nothing changes:',
  '        // checkAccessToken answers DENIED and the app reports sandbox=strong.',
  '        "name": "ohos.permission.CUSTOM_SANDBOX"',
  '      },',
  '      {',
  '        // An execve-ed binary reads/writes the user-home paths the plugin',
  '        // configures (pandoc input/output, ~/.pandoc data dir); same ACL rule.',
  '        "name": "ohos.permission.READ_WRITE_USER_FILE"',
  '      }',
].join('\n');

// The VIBRATE entry is the current LAST element of requestPermissions; the new
// entries are inserted right after it, so the manifest keeps one flat list.
const VIBRATE_BLOCK = [
  '      {',
  '        // Barrel double-tap / squeeze feedback (docs/STYLUS-PEN.md §7.12).',
  '        // Normal permission; devices without a motor simply reject the call.',
  '        "name": "ohos.permission.VIBRATE"',
  '      }',
].join('\n');
const TAIL = '\n    ],';
const INSERT = ',\n' + BLOCK;

// module.json5 is stored with CRLF; every match below runs on LF-normalised
// text and the result is written back with CRLF, so the file stays byte-for-byte
// identical outside the inserted block.
function readManifest() {
  return fs.readFileSync(MANIFEST, 'utf8').replace(/\r\n/g, '\n');
}

function writeManifest(text) {
  fs.writeFileSync(MANIFEST, text.replace(/\n/g, '\r\n'), 'utf8');
}

function hasEntry(text, name) {
  return text.includes(`"name": "${name}"`);
}

function applyBlock() {
  let text = readManifest();
  if (hasEntry(text, 'ohos.permission.CUSTOM_SANDBOX')) {
    console.log('weak sandbox: already declared in module.json5 (no change)');
    return false;
  }
  const anchorIndex = text.indexOf(VIBRATE_BLOCK);
  if (anchorIndex < 0) {
    console.error('weak sandbox: VIBRATE anchor not found in module.json5 - refusing to edit');
    process.exit(1);
  }
  const after = anchorIndex + VIBRATE_BLOCK.length;
  if (!text.startsWith(TAIL, after)) {
    console.error('weak sandbox: unexpected manifest shape after the VIBRATE entry - refusing to edit');
    process.exit(1);
  }
  text = text.slice(0, after) + INSERT + text.slice(after);
  writeManifest(text);
  console.log('weak sandbox: declared CUSTOM_SANDBOX + READ_WRITE_USER_FILE in module.json5');
  return true;
}

function revertBlock() {
  let text = readManifest();
  if (!hasEntry(text, 'ohos.permission.CUSTOM_SANDBOX')) {
    console.log('weak sandbox: not declared in module.json5 (no change)');
    return false;
  }
  if (!text.includes(INSERT)) {
    console.error('weak sandbox: declared but the block was edited by hand - remove the entries manually');
    process.exit(1);
  }
  text = text.replace(INSERT, '');
  writeManifest(text);
  console.log('weak sandbox: removed the two ACL permission entries from module.json5');
  return true;
}

function status() {
  const text = readManifest();
  const declared = hasEntry(text, 'ohos.permission.CUSTOM_SANDBOX');
  const userFile = hasEntry(text, 'ohos.permission.READ_WRITE_USER_FILE');
  console.log('module.json5: CUSTOM_SANDBOX=' + (declared ? 'declared' : 'absent') +
    ', READ_WRITE_USER_FILE=' + (userFile ? 'declared' : 'absent'));

  // The profile is the half that actually grants the permission. It is a
  // Huawei-signed PKCS#7 with the JSON payload embedded in clear, so its ACL list
  // can be read locally - no device, no IDE. Signing it again is NOT possible
  // offline (only AGC can), so this is a read-only check.
  const prof = profileInfo();
  console.log('');
  if (!prof) {
    console.log('signing profile: not declared in build-profile.json5 (automatic signing?)');
  } else if (!prof.exists) {
    console.log('signing profile: ' + prof.path + ' (missing on disk)');
  } else {
    const hasSandbox = prof.acls.includes('ohos.permission.CUSTOM_SANDBOX');
    const hasUserFile = prof.acls.includes('ohos.permission.READ_WRITE_USER_FILE');
    console.log('signing profile: ' + prof.path);
    console.log('  acls CUSTOM_SANDBOX       : ' + (hasSandbox ? 'YES' : 'NO'));
    console.log('  acls READ_WRITE_USER_FILE : ' + (hasUserFile ? 'YES' : 'NO'));
    console.log('  acls 现有 ' + prof.acls.length + ' 条: ' + prof.acls.join(', '));
    if (!hasSandbox || !hasUserFile) {
      console.log('  => 该 profile 重签出的包只会是 sandbox=strong：先用 IDE/AGC 把缺的 ACL 加进');
      console.log('     profile 再重新下载，然后重签，否则清单改了也不生效。');
      console.log('     注意：CUSTOM_SANDBOX 不在 DevEco 自动签名支持的 ACL 清单里');
      console.log('     （READ_WRITE_USER_FILE 在），自动签名会报 Unsupported restricted ACL');
      console.log('     permission；需手动签名 + 在 AGC 申请受限 ACL（按特殊场景审核，可能被拒）。');
    }
  }

  console.log('');
  console.log('To get sandbox=weak on device, ALL of these must hold:');
  console.log('  1. module.json5 declares both names            (node scripts/weak-sandbox.mjs apply)');
  console.log('  2. the signing profile lists them under acls   (see above)');
  console.log('  3. the HAP was rebuilt and re-signed afterwards');
  console.log('  4. the device runs API >= 18 (CUSTOM_SANDBOX since)');
  console.log('  5. docs/PLATFORM-ADAPTATION.md §五 V-WS-1..7 passed');
  console.log('');
  console.log('Profile: DevEco 26.0.0+ can request ACLs from the IDE (automatic');
  console.log('signing profile -> ACL). Older toolchains: add the two names to the');
  console.log('`acls` object of the unsigned profile template, re-sign, reinstall:');
  console.log('  ' + path.join('sdk', 'default', 'openharmony', 'toolchains', 'lib', 'UnsgnedDebugProfileTemplate.json'));
  console.log('  node scripts/weak-sandbox.mjs apply && then rebuild the HAP');
}

function profileInfo() {
  const profilePath = 'build-profile.json5';
  let bp = null;
  try {
    bp = fs.readFileSync(path.join(ROOT, profilePath), 'utf8');
  } catch (e) {
    return null;
  }
  const m = bp.match(/"profile"\s*:\s*"((?:[^"\\]|\\.)*)"/);
  if (!m) return null;
  const p = m[1].replace(/\\\\/g, '\\');
  if (!fs.existsSync(p)) return { path: p, exists: false, acls: [] };
  const raw = fs.readFileSync(p).toString('latin1');
  const at = raw.indexOf('allowed-acls');
  let acls = [];
  if (at >= 0) {
    const end = raw.indexOf(']', at);
    const seg = end > at ? raw.slice(at, end) : raw.slice(at);
    const re = /ohos\.permission\.[A-Za-z0-9_.]+/g;
    let hit;
    while ((hit = re.exec(seg)) !== null) {
      if (!acls.includes(hit[0])) acls.push(hit[0]);
    }
  }
  return { path: p, exists: true, acls };
}

const cmd = (process.argv[2] || 'status').toLowerCase();
if (cmd === 'apply') {
  applyBlock();
  status();
} else if (cmd === 'revert') {
  revertBlock();
  status();
} else if (cmd === 'status') {
  status();
} else {
  console.error('usage: node scripts/weak-sandbox.mjs [status|apply|revert]');
  process.exit(1);
}
