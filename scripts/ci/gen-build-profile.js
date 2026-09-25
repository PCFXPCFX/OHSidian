#!/usr/bin/env node
/**
 * CI helper: generates build-profile.json5 from build-profile.example.json5.
 * - Strips the placeholder signing config (produces an UNSIGNED build target)
 *   unless SIGNING_JSON is set, in which case that JSON is used verbatim as
 *   app.signingConfigs and products[0].signingConfig points at it.
 * - Pins the locally tested SDK combination: compatible 6.0.2(22),
 *   target 6.1.1(24) (override via TARGET_SDK env if ever needed).
 */
// ESM: scripts/package.json declares "type": "module".
import fs from 'node:fs';

const src = fs.readFileSync('build-profile.example.json5', 'utf8');
// Strip line comments (json5 superset). Only full-line // comments are used
// in the example file, so a conservative regex is enough - string values like
// "~/.ohos/config/x.cer" must not be touched.
const stripped = src.replace(/^[ \t]*\/\/.*$/gm, '');
const cfg = eval('(' + stripped + ')'); // repo-controlled file, no user input

cfg.app.signingConfigs = [];
delete cfg.app.products[0].signingConfig;

if (process.env.SIGNING_JSON) {
  const signing = JSON.parse(process.env.SIGNING_JSON);
  cfg.app.signingConfigs = [signing];
  cfg.app.products[0].signingConfig = signing.name;
}

cfg.app.products[0].compatibleSdkVersion =
  process.env.COMPATIBLE_SDK || '6.0.2(22)';
cfg.app.products[0].targetSdkVersion = process.env.TARGET_SDK || '6.1.1(24)';

fs.writeFileSync('build-profile.json5', JSON.stringify(cfg, null, 2));
console.log(
  'build-profile.json5 generated:',
  'signing=' + (process.env.SIGNING_JSON ? 'ci' : 'unsigned') +
  ', target=' + cfg.app.products[0].targetSdkVersion
);
