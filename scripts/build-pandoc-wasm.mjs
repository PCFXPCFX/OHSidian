/* Builds the pandoc-on-WebAssembly assets that ship inside the HAP.
 *
 * Output (all generated, not committed):
 *   web_engine/src/main/resources/resfile/pandoc/pandoc.wasm.gz
 *   web_engine/src/main/resources/resfile/pandoc/pandoc-service.cjs
 *   web_engine/src/main/resources/resfile/pandoc/pandoc-version.txt
 *   web_engine/src/main/resources/resfile/pandoc/LICENSE-pandoc-wasm.txt
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

function writeSourceNotice() {
  return [
    'Pandoc (WebAssembly build) - third-party component bundled with OHSidian',
    '',
    'Pandoc source: https://github.com/jgm/pandoc',
    'Version: ' + (fs.existsSync(path.join(RES, 'pandoc-version.txt'))
      ? fs.readFileSync(path.join(RES, 'pandoc-version.txt'), 'utf8').trim() : '(see pandoc-version.txt)'),
    'WASM wrapper: https://github.com/pandoc/pandoc-wasm (npm package pandoc-wasm@' + PANDOC_WASM.version + ')',
    'WASI shim: @bjorn3/browser_wasi_shim@' + WASI_SHIM.version,
    '',
    'Pandoc is licensed under GPL-2.0-or-later. The npm package and the bundled',
    'pandoc.wasm are distributed under GPL-2.0-or-later as well.',
    'The complete corresponding source is available at the URLs above; the',
    'OHSidian source (including the build script that produced these files) is',
    'at the project repository.',
    '',
    'Offline conversion only: the WASM build cannot fetch URLs or execute',
    'external programs, and cannot produce PDF (needs LaTeX/Typst).',
    '',
  ].join('\n');
}

async function main() {
  fs.mkdirSync(RES, { recursive: true });
  const lock = loadLock();

  if (optCheck) {
    const files = ['pandoc.wasm.gz', 'pandoc-service.cjs', 'pandoc-version.txt'];
    for (const f of files) {
      const p = path.join(RES, f);
      if (!fs.existsSync(p)) fail('missing built asset ' + p + ' (run npm run build:pandoc-wasm)');
    }
    const wasmGz = fs.readFileSync(path.join(RES, 'pandoc.wasm.gz'));
    checkHash('outputs-wasm-gz', wasmGz, lock);
    const svc = fs.readFileSync(path.join(RES, 'pandoc-service.cjs'));
    checkHash('outputs-service', svc, lock);
    log('check OK: wasm.gz ' + (wasmGz.length / 1048576).toFixed(1) + ' MB, service ' +
      (svc.length / 1024).toFixed(0) + ' KB');
    return;
  }

  const wasmTap = await download(PANDOC_WASM);
  const shimTap = await download(WASI_SHIM);
  checkHash('pandoc-wasm', wasmTap, lock);
  checkHash('wasi-shim', shimTap, lock);

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
  fs.writeFileSync(path.join(RES, 'pandoc-version.txt'), pandocVersion + '\n', 'utf8');
  const licenseSrc = path.join(nm, 'pandoc-wasm', 'LICENSE');
  if (fs.existsSync(licenseSrc)) fs.copyFileSync(licenseSrc, path.join(RES, 'LICENSE-pandoc-wasm.txt'));
  fs.writeFileSync(path.join(RES, 'PANDOC-SOURCE.txt'), writeSourceNotice(), 'utf8');

  const service = fs.readFileSync(path.join(RES, 'pandoc-service.cjs'));
  log('pandoc ' + pandocVersion + ' (wasm)');
  log('pandoc.wasm: ' + (wasmRaw.length / 1048576).toFixed(1) + ' MB raw -> ' +
    (wasmGz.length / 1048576).toFixed(1) + ' MB gzip');
  log('pandoc-service.cjs: ' + (service.length / 1024).toFixed(0) + ' KB');
  log('output: ' + path.relative(ROOT, RES));

  if (optUpdateLock || !lock) {
    const next = {
      serviceSchema: 1,
      pandocWasm: { version: PANDOC_WASM.version, sha256: sha256(wasmTap) },
      wasiShim: { version: WASI_SHIM.version, sha256: sha256(shimTap) },
      'outputs-wasm-gz': { sha256: sha256(wasmGz), bytes: wasmGz.length },
      'outputs-service': { sha256: sha256(service), bytes: service.length },
    };
    fs.writeFileSync(LOCK, JSON.stringify(next, null, 2) + '\n', 'utf8');
    log('lock written: ' + path.relative(ROOT, LOCK));
  } else {
    checkHash('outputs-wasm-gz', wasmGz, lock);
    checkHash('outputs-service', service, lock);
    log('outputs match scripts/pandoc-wasm.lock.json');
  }
}

main().catch((e) => fail(e && e.stack ? e.stack : String(e)));
