/* Builds the pandoc-on-WebAssembly assets that ship inside the HAP.
 *
 * Output (all generated, not committed):
 *   web_engine/src/main/resources/resfile/pandoc/pandoc.wasm.gz
 *   web_engine/src/main/resources/resfile/pandoc/pandoc-service.cjs
 *   web_engine/src/main/resources/resfile/pandoc/pandoc-version.txt
 *   web_engine/src/main/resources/resfile/pandoc/LICENSE-pandoc-wasm.txt
 *   web_engine/src/main/resources/resfile/pandoc/LICENSE-GPL-2.0.txt
 *   web_engine/src/main/resources/resfile/pandoc/LICENSE-browser-wasi-shim.txt
 *   web_engine/src/main/resources/resfile/pandoc/PANDOC-SOURCE.txt
 *
 * Why this shape:
 * - the WASM binary comes from the official `pandoc-wasm` npm package (same
 *   Pandoc source, GPL-2.0-or-later), gzipped because the raw file is ~56 MB;
 * - the service is a single CommonJS bundle (our service-core + pandoc-wasm's
 *   core.js + the browser_wasi_shim dependency) so the renderer can simply
 *   require() it from the app resources without a Node ESM loader;
 * - versions and hashes are pinned in scripts/pandoc-wasm.lock.json, and the
 *   script refuses to build if a tarball or output does not match the lock
 *   (use --update-lock after an intentional upgrade).
 * - the wasm output is pinned by the hash of the UNCOMPRESSED wasm plus its
 *   byte count, checked by gunzipping the shipped asset (audit NF-021): zlib's
 *   deflate stream is not reproducible across Node/zlib builds, so pinning the
 *   .gz bytes made a Node 24 build fail on a perfectly good asset. The gz size
 *   is still recorded (it has been stable in practice) but its sha256 is not a
 *   gate.
 *
 * Usage:
 *   node scripts/build-pandoc-wasm.mjs            # build + verify against lock
 *   node scripts/build-pandoc-wasm.mjs --check    # verify outputs only (CI gate)
 *   node scripts/build-pandoc-wasm.mjs --update-lock
 *   node scripts/build-pandoc-wasm.mjs --force    # rebuild even if outputs exist
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CACHE = path.join(ROOT, 'scripts/.cache/pandoc-wasm');
const TEMP = path.join(CACHE, 'build');
const RES = path.join(ROOT, 'web_engine/src/main/resources/resfile/pandoc');
const LOCK = path.join(ROOT, 'scripts/pandoc-wasm.lock.json');
const SERVICE_SRC = path.join(ROOT, 'scripts/pandoc-wasm/service-core.mjs');
/* License texts are tracked in the repo (not fetched at build time) so the
   shipped HAP always carries a copy of GPL-2.0 and the WASI shim's MIT text,
   independent of network availability (licensing round, 2026-11-22). */
const LICENSES = path.join(ROOT, 'scripts/licenses');

const PANDOC_WASM = { name: 'pandoc-wasm', version: '1.1.0' };
const WASI_SHIM = { name: '@bjorn3/browser_wasi_shim', version: '0.4.2' };

const args = new Set(process.argv.slice(2));
const optCheck = args.has('--check');
const optUpdateLock = args.has('--update-lock');
const optForce = args.has('--force');

function log(msg) { console.log('[pandoc-wasm] ' + msg); }
function fail(msg) { console.error('[pandoc-wasm] ERROR: ' + msg); process.exit(1); }
function sha256(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }
function sizeOf(buf) { return buf ? buf.length : 0; }

function tarballUrl(pkg) {
  const scope = pkg.name.startsWith('@') ? pkg.name.split('/')[0] : '';
  const base = pkg.name.startsWith('@') ? pkg.name.split('/')[1] : pkg.name;
  const prefix = scope ? scope + '/' : '';
  return 'https://registry.npmjs.org/' + pkg.name + '/-/' + base + '-' + pkg.version + '.tgz';
}

async function download(pkg) {
  fs.mkdirSync(CACHE, { recursive: true });
  const file = path.join(CACHE, pkg.name.replace(/[@/]/g, '_') + '-' + pkg.version + '.tgz');
  if (fs.existsSync(file)) return fs.readFileSync(file);
  const url = tarballUrl(pkg);
  log('downloading ' + url);
  const res = await fetch(url);
  if (!res.ok) fail('download failed (' + res.status + '): ' + url);
  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(file, buf);
  return buf;
}

/* Minimal tar reader for npm .tgz packages (ustar headers). */
function untar(buf) {
  const out = [];
  let off = 0;
  while (off + 512 <= buf.length) {
    const header = buf.subarray(off, off + 512);
    let name = header.subarray(0, 100).toString('utf8').replace(/\0.*$/, '');
    const prefix = header.subarray(345, 500).toString('utf8').replace(/\0.*$/, '');
    if (prefix) name = prefix + '/' + name;
    if (!name) break;
    const sizeStr = header.subarray(124, 136).toString('utf8').replace(/\0.*$/, '').trim();
    const size = parseInt(sizeStr || '0', 8);
    const type = String.fromCharCode(header[156]);
    off += 512;
    if (type === '0' || type === '\0') {
      out.push({ name, data: buf.subarray(off, off + size) });
    } else if (type === '5') {
      out.push({ name: name.replace(/\/$/, '') + '/', dir: true });
    }
    off += Math.ceil(size / 512) * 512;
  }
  return out;
}

function extractPackage(tgzBuf, destNodeModules, pkgName) {
  const files = untar(zlib.gunzipSync(tgzBuf));
  const dest = path.join(destNodeModules, ...pkgName.split('/'));
  fs.mkdirSync(dest, { recursive: true });
  for (const f of files) {
    const rel = f.name.replace(/^package\//, '');
    if (!rel) continue;
    const target = path.join(dest, rel);
    if (f.dir) { fs.mkdirSync(target, { recursive: true }); continue; }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, f.data);
  }
}

function loadLock() {
  if (!fs.existsSync(LOCK)) return null;
  try { return JSON.parse(fs.readFileSync(LOCK, 'utf8')); } catch (e) { return null; }
}

function checkHash(kind, buf, lock) {
  if (!lock || !lock[kind] || !lock[kind].sha256) return;
  const actual = sha256(buf);
  if (actual !== lock[kind].sha256) {
    fail(kind + ' sha256 mismatch: expected ' + lock[kind].sha256 + ', got ' + actual +
      ' (if this is an intentional upgrade, rerun with --update-lock)');
  }
}

/* NF-021 (audit 2026-11-22 §4.3): the compressed wasm is NOT reproducible
   across zlib builds (same input, same length, different deflate bytes), so the
   gate compares the gunzipped wasm instead - that is the actual third-party
   content the lock is there to protect. */
function checkWasmRaw(wasmGz, lock) {
  const entry = lock && lock['outputs-wasm-raw'];
  if (!entry || !entry.sha256) return 0;
  let raw;
  try {
    raw = zlib.gunzipSync(wasmGz);
  } catch (e) {
    fail('pandoc.wasm.gz cannot be gunzipped: ' + (e && e.message ? e.message : e));
  }
  const actual = sha256(raw);
  if (actual !== entry.sha256) {
    fail('pandoc.wasm (gunzipped) sha256 mismatch: expected ' + entry.sha256 + ', got ' + actual);
  }
  if (entry.bytes && raw.length !== entry.bytes) {
    fail('pandoc.wasm (gunzipped) size mismatch: expected ' + entry.bytes + ', got ' + raw.length);
  }
  const gzEntry = lock && lock['outputs-wasm-gz'];
  if (gzEntry && gzEntry.bytes && wasmGz.length !== gzEntry.bytes) {
    log('note: pandoc.wasm.gz size differs from the recorded ' + gzEntry.bytes + ' B ' +
      '(zlib output varies; the gunzipped wasm matches the lock)');
  }
  return raw.length;
}

function writeSourceNotice(meta) {
  const v = meta && meta.pandocVersion ? meta.pandocVersion : '3.10';
  return [
    'Pandoc (WebAssembly build) - third-party components bundled with OHSidian',
    '=======================================================================',
    '',
    'OHSidian ships a built-in, fully offline Pandoc conversion engine. No part',
    'of it is downloaded at runtime. This file is the licensing notice required',
    'by the licenses of the components below; full license texts travel next to',
    'it in the application resources (resources/resfile/pandoc/).',
    '',
    '1. Pandoc (conversion engine, compiled to WebAssembly)',
    '   Version: ' + v,
    '   Files: pandoc.wasm (shipped gzipped as pandoc.wasm.gz)',
    '   License: GPL-2.0-or-later (GNU General Public License, version 2 or later)',
    '   Copyright (C) 2006-2024 John MacFarlane <jgm at berkeley dot edu> and the',
    '   Pandoc contributors. Pandoc embeds some third-party code under',
    '   GPL-compatible licenses; see the COPYRIGHT file in the Pandoc source.',
    '   License texts shipped with this application:',
    '     resources/resfile/pandoc/LICENSE-GPL-2.0.txt',
    '     resources/resfile/pandoc/LICENSE-pandoc-wasm.txt',
    '   Corresponding source (preferred form for modification):',
    '     https://hackage.haskell.org/package/pandoc-' + v + '/pandoc-' + v + '.tar.gz',
    '     https://github.com/jgm/pandoc/tree/' + v,
    '',
    '2. pandoc-wasm (JavaScript WebAssembly loader; bundled into pandoc-service.cjs)',
    '   Version: ' + PANDOC_WASM.version,
    '   License: MIT License',
    '   Copyright (c) Tweag I/O Limited, Johannes Wilm, and pandoc-wasm',
    '   contributors.',
    '   Source (npm tarball, contains src/):',
    '     https://registry.npmjs.org/pandoc-wasm/-/pandoc-wasm-' + PANDOC_WASM.version + '.tgz',
    '     sha256: ' + (meta && meta.pandocTgzSha ? meta.pandocTgzSha : '(see scripts/pandoc-wasm.lock.json)'),
    '     https://github.com/pandoc/pandoc-wasm',
    '',
    '3. browser_wasi_shim (WASI runtime shim; bundled into pandoc-service.cjs)',
    '   Version: ' + WASI_SHIM.version,
    '   License: MIT OR Apache-2.0 (this application complies under the MIT option)',
    '   Copyright (c) bjorn3 and browser_wasi_shim contributors.',
    '   License text shipped:',
    '     resources/resfile/pandoc/LICENSE-browser-wasi-shim.txt',
    '   Source:',
    '     https://registry.npmjs.org/@bjorn3/browser_wasi_shim/-/browser_wasi_shim-' + WASI_SHIM.version + '.tgz',
    '     sha256: ' + (meta && meta.shimTgzSha ? meta.shimTgzSha : '(see scripts/pandoc-wasm.lock.json)'),
    '     https://github.com/bjorn3/browser_wasi_shim',
    '',
    '4. OHSidian glue code (not third-party)',
    '   scripts/build-pandoc-wasm.mjs, scripts/pandoc-wasm/service-core.mjs and',
    '   scripts/pandoc-wasm/pandoc-host.cjs are part of OHSidian and are',
    '   distributed under the project BSD 3-Clause license (see LICENSE).',
    '   Project: https://github.com/PCFXPCFX/OHSidian',
    '',
    'GPL-2.0 source-availability statement',
    '------------------------------------',
    'The complete corresponding source code for the GPL-covered Pandoc engine is',
    'available at the exact versions and URLs listed above. The build is',
    'reproducible from those pinned sources with the public build script named',
    'above; the tarballs are pinned by sha256 in scripts/pandoc-wasm.lock.json.',
    'A written offer for a machine-readable copy of the corresponding source is',
    'available through https://github.com/PCFXPCFX/OHSidian/issues and is valid',
    'for at least three years from the release date. The GPL-covered engine is a',
    'separate, self-contained component loaded from its own files and, where the',
    'renderer has no WebAssembly, executed in a separate utility process (see',
    'docs/PLATFORM-ADAPTATION.md section 6.11).',
    '',
    'Chinese summary / 中文摘要',
    '---------------------------',
    '本应用内置离线 Pandoc ' + v + ' 转换引擎（WebAssembly），不在运行时下载任何组件。',
    '引擎本体为 GPL-2.0-or-later（Copyright (C) 2006-2024 John MacFarlane 及 Pandoc',
    '贡献者）；pandoc-wasm 封装为 MIT；browser_wasi_shim 为 MIT OR Apache-2.0',
    '（本应用按 MIT 履行）。上述许可证全文与精确源码地址随应用资源',
    'resources/resfile/pandoc/ 一同提供；对应源码以上面锁定的上游版本提供，构建',
    '脚本公开。详见项目 LICENSE 的「第三方组件」一节。',
    '',
    'Limitations of the built-in engine: no PDF output (needs LaTeX/Typst), no',
    'network access, Lua filters only (executable filters are rejected).',
    '',
  ].join('\n');
}

async function main() {
  fs.mkdirSync(RES, { recursive: true });
  const lock = loadLock();

  if (optCheck) {
    const files = ['pandoc.wasm.gz', 'pandoc-service.cjs', 'pandoc-host.cjs', 'pandoc-version.txt',
      'LICENSE-pandoc-wasm.txt', 'LICENSE-GPL-2.0.txt', 'LICENSE-browser-wasi-shim.txt', 'PANDOC-SOURCE.txt'];
    for (const f of files) {
      const p = path.join(RES, f);
      if (!fs.existsSync(p)) fail('missing built asset ' + p + ' (run npm run build:pandoc-wasm)');
    }
    /* Licensing gate (2026-11-22): the shipped copy of the GPL text must be the
       real license, and the notice must name the pinned upstream sources. */
    const gpl = fs.readFileSync(path.join(RES, 'LICENSE-GPL-2.0.txt'), 'utf8');
    if (!gpl.includes('GNU GENERAL PUBLIC LICENSE') || !gpl.includes('Version 2, June 1991')) {
      fail('LICENSE-GPL-2.0.txt does not look like the GNU GPL version 2 text');
    }
    const shimLic = fs.readFileSync(path.join(RES, 'LICENSE-browser-wasi-shim.txt'), 'utf8');
    if (!shimLic.includes('Permission is hereby granted, free of charge')) {
      fail('LICENSE-browser-wasi-shim.txt does not contain the MIT license text');
    }
    const notice = fs.readFileSync(path.join(RES, 'PANDOC-SOURCE.txt'), 'utf8');
    if (!notice.includes('GPL-2.0-or-later') || !notice.includes('pandoc-wasm') ||
      !notice.includes('sha256:') || !notice.includes('browser_wasi_shim')) {
      fail('PANDOC-SOURCE.txt is missing the pinned source/licensing statement');
    }
    const wasmGz = fs.readFileSync(path.join(RES, 'pandoc.wasm.gz'));
    const rawBytes = checkWasmRaw(wasmGz, lock);
    if (!rawBytes) fail('lock has no outputs-wasm-raw entry (run --update-lock after upgrading)');
    const svc = fs.readFileSync(path.join(RES, 'pandoc-service.cjs'));
    checkHash('outputs-service', svc, lock);
    const host = fs.readFileSync(path.join(RES, 'pandoc-host.cjs'));
    checkHash('outputs-host', host, lock);
    log('check OK: wasm ' + (rawBytes / 1048576).toFixed(1) + ' MB raw (' +
      (wasmGz.length / 1048576).toFixed(1) + ' MB gz), service ' +
      (svc.length / 1024).toFixed(0) + ' KB, licenses present');
    return;
  }

  const wasmTap = await download(PANDOC_WASM);
  const shimTap = await download(WASI_SHIM);
  checkHash('pandocWasm', wasmTap, lock);
  checkHash('wasiShim', shimTap, lock);

  const wasmEntry = untar(zlib.gunzipSync(wasmTap)).find((f) => f.name === 'package/src/pandoc.wasm');
  if (!wasmEntry) fail('pandoc.wasm not found inside the pandoc-wasm tarball');
  const versionEntry = untar(zlib.gunzipSync(wasmTap)).find((f) => f.name === 'package/pandoc-version.txt');
  const pandocVersion = versionEntry ? versionEntry.data.toString('utf8').trim() : '3.10';
  const wasmRaw = wasmEntry.data;
  const wasmGz = zlib.gzipSync(wasmRaw, { level: 9 });

  fs.rmSync(TEMP, { recursive: true, force: true });
  const nm = path.join(TEMP, 'node_modules');
  extractPackage(wasmTap, nm, PANDOC_WASM.name);
  extractPackage(shimTap, nm, WASI_SHIM.name);
  fs.copyFileSync(SERVICE_SRC, path.join(TEMP, 'service-core.mjs'));
  const entry = [
    'import { createPandocInstance } from "./node_modules/pandoc-wasm/src/core.js";',
    'export { createPandocInstance };',
    'export * from "./service-core.mjs";',
    '',
  ].join('\n');
  fs.writeFileSync(path.join(TEMP, 'entry.mjs'), entry, 'utf8');

  await build({
    entryPoints: [path.join(TEMP, 'entry.mjs')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    outfile: path.join(RES, 'pandoc-service.cjs'),
    legalComments: 'eof',
    logLevel: 'warning',
    banner: {
      js: '/* Generated by scripts/build-pandoc-wasm.mjs - pandoc ' + pandocVersion +
        ' via pandoc-wasm@' + PANDOC_WASM.version + ' (GPL-2.0-or-later). Do not edit. */',
    },
  });

  fs.writeFileSync(path.join(RES, 'pandoc.wasm.gz'), wasmGz);
  const hostSrc = path.join(ROOT, 'scripts/pandoc-wasm/pandoc-host.cjs');
  const hostDst = path.join(RES, 'pandoc-host.cjs');
  fs.copyFileSync(hostSrc, hostDst);
  fs.writeFileSync(path.join(RES, 'pandoc-version.txt'), pandocVersion + '\n', 'utf8');
  const licenseSrc = path.join(nm, 'pandoc-wasm', 'LICENSE');
  if (fs.existsSync(licenseSrc)) fs.copyFileSync(licenseSrc, path.join(RES, 'LICENSE-pandoc-wasm.txt'));
  /* Licensing round (2026-11-22): ship the FULL GPL-2.0 text (not just the
     notice) and the WASI shim's MIT text, both tracked in scripts/licenses/ so
     the build never depends on the network for licensing material. */
  const trackedLicenses = [
    [path.join(LICENSES, 'GPL-2.0.txt'), 'LICENSE-GPL-2.0.txt'],
    [path.join(LICENSES, 'browser-wasi-shim-LICENSE-MIT.txt'), 'LICENSE-browser-wasi-shim.txt'],
  ];
  for (const [src, name] of trackedLicenses) {
    if (!fs.existsSync(src)) fail('missing tracked license text ' + src);
    fs.copyFileSync(src, path.join(RES, name));
  }
  fs.writeFileSync(path.join(RES, 'PANDOC-SOURCE.txt'), writeSourceNotice({
    pandocVersion: pandocVersion,
    pandocTgzSha: sha256(wasmTap),
    shimTgzSha: sha256(shimTap),
  }), 'utf8');

  const service = fs.readFileSync(path.join(RES, 'pandoc-service.cjs'));
  const host = fs.readFileSync(hostDst);
  log('pandoc ' + pandocVersion + ' (wasm)');
  log('pandoc.wasm: ' + (wasmRaw.length / 1048576).toFixed(1) + ' MB raw -> ' +
    (wasmGz.length / 1048576).toFixed(1) + ' MB gzip');
  log('pandoc-service.cjs: ' + (service.length / 1024).toFixed(0) + ' KB');
  log('pandoc-host.cjs: ' + (host.length / 1024).toFixed(1) + ' KB (utility process host)');
  log('output: ' + path.relative(ROOT, RES));

  if (optUpdateLock || !lock) {
    const next = {
      serviceSchema: 2,
      pandocWasm: { version: PANDOC_WASM.version, sha256: sha256(wasmTap) },
      wasiShim: { version: WASI_SHIM.version, sha256: sha256(shimTap) },
      'outputs-wasm-raw': { sha256: sha256(wasmRaw), bytes: wasmRaw.length },
      /* size only: the gzip stream itself is not reproducible (NF-021) */
      'outputs-wasm-gz': { bytes: wasmGz.length },
      'outputs-service': { sha256: sha256(service), bytes: service.length },
      'outputs-host': { sha256: sha256(host), bytes: host.length },
    };
    fs.writeFileSync(LOCK, JSON.stringify(next, null, 2) + '\n', 'utf8');
    log('lock written: ' + path.relative(ROOT, LOCK));
  } else {
    checkWasmRaw(wasmGz, lock);
    checkHash('outputs-service', service, lock);
    checkHash('outputs-host', host, lock);
    log('outputs match scripts/pandoc-wasm.lock.json');
  }
}

main().catch((e) => fail(e && e.stack ? e.stack : String(e)));
