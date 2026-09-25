// One-off: build scripts/cert-obsidian.pem from the pinned cert in git HEAD's wrapper main.js.
const fs = require('fs');
const { execSync } = require('child_process');

const src = execSync('git show HEAD:web_engine/src/main/resources/resfile/resources/app/main.js', { encoding: 'utf8' });
const m = src.match(/const SIGNATURE_CERT = ((?:'[^']*'\s*\+?\s*)+);/);
if (!m) throw new Error('cert not found in HEAD main.js');
const segs = [...m[1].matchAll(/'([^']*)'/g)].map(s => s[1]);
const pem = segs.join('').replace(/\\n/g, '\n').trim();
if (!pem.startsWith('-----BEGIN CERTIFICATE-----') || !pem.endsWith('-----END CERTIFICATE-----')) {
  throw new Error('rebuild failed');
}
fs.writeFileSync('scripts/cert-obsidian.pem', pem + '\n');
console.log('pem lines:', pem.split('\n').length);
