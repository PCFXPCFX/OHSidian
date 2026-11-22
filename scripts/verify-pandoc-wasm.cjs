/* Behavioural gate for the bundled pandoc-on-WebAssembly service.
 *
 * Runs the generated pandoc-service.cjs (built by scripts/build-pandoc-wasm.mjs)
 * in Node and asserts that the real Pandoc engine converts documents, that the
 * CLI surface plugins rely on behaves sanely, and that unsupported paths fail
 * with an actionable message instead of hanging.
 *
 * Usage: node scripts/verify-pandoc-wasm.cjs [--allow-missing]
 *   --allow-missing: skip (exit 0) when the assets were never built (dev boxes
 *   that only touch other parts of the tree); CI always builds them first.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
const RES = path.join(ROOT, 'web_engine/src/main/resources/resfile/pandoc');
const permitMissing = process.argv.includes('--allow-missing');
let failures = 0;
function check(name, ok, detail) {
  if (!ok) failures++;
  console.log((ok ? '  OK   ' : '  FAIL ') + name + (detail ? ' - ' + detail : ''));
}
function sha256(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }

async function main() {
  const required = ['pandoc.wasm.gz', 'pandoc-service.cjs', 'pandoc-host.cjs', 'pandoc-version.txt', 'PANDOC-SOURCE.txt'];
  const missing = required.filter((f) => !fs.existsSync(path.join(RES, f)));
  if (missing.length) {
    if (permitMissing) {
      console.log('PANDOC-WASM VERIFY: SKIPPED (assets not built: ' + missing.join(', ') + ')');
      return;
    }
    console.error('PANDOC-WASM VERIFY: FAILURES\n  missing built assets: ' + missing.join(', ') +
      '\n  run: node scripts/build-pandoc-wasm.mjs');
    process.exit(1);
  }

  const lockPath = path.join(ROOT, 'scripts/pandoc-wasm.lock.json');
  let lock = null;
  try { lock = JSON.parse(fs.readFileSync(lockPath, 'utf8')); } catch (e) { lock = null; }
  check('lock file present', !!lock);

  const wasmGz = fs.readFileSync(path.join(RES, 'pandoc.wasm.gz'));
  check('wasm.gz is plausible (10-40 MB)', wasmGz.length > 10 * 1048576 && wasmGz.length < 40 * 1048576,
    (wasmGz.length / 1048576).toFixed(1) + ' MB');
  /* NF-021 (audit 2026-11-22 §4.3): the deflate stream is not reproducible
     across zlib builds, so the gate pins the GUNZIPPED wasm (what the lock is
     really protecting) instead of the .gz bytes. */
  if (lock && lock['outputs-wasm-raw'] && lock['outputs-wasm-raw'].sha256) {
    let raw = null;
    try { raw = require('zlib').gunzipSync(wasmGz); } catch (e) { raw = null; }
    check('wasm.gz gunzips', !!raw);
    if (raw) {
      check('pandoc.wasm (gunzipped) matches lock sha256',
        sha256(raw) === lock['outputs-wasm-raw'].sha256,
        (raw.length / 1048576).toFixed(1) + ' MB');
    }
  }

  const hostSrc = fs.readFileSync(path.join(RES, 'pandoc-host.cjs'));
  if (lock && lock['outputs-host'] && lock['outputs-host'].sha256) {
    check('host.cjs matches lock sha256', sha256(hostSrc) === lock['outputs-host'].sha256);
  }
  check('host.cjs drives pandoc over parentPort', hostSrc.includes('pandoc-service.cjs') &&
    hostSrc.includes('pandoc.wasm.gz'));
  const svcSrc = fs.readFileSync(path.join(RES, 'pandoc-service.cjs'));
  if (lock && lock['outputs-service'] && lock['outputs-service'].sha256) {
    check('service.cjs matches lock sha256', sha256(svcSrc) === lock['outputs-service'].sha256);
  }

  const svc = require(path.join(RES, 'pandoc-service.cjs'));
  check('service bundles pandoc core', typeof svc.createPandocInstance === 'function');
  check('service exposes createService', typeof svc.createService === 'function');
  check('service exposes CLI parser helpers',
    typeof svc.parseArgs === 'function' && typeof svc.shellSplit === 'function' &&
    typeof svc.isPandocCommand === 'function');

  check('command detection: bare name', svc.isPandocCommand('pandoc'));
  check('command detection: quoted path', svc.isPandocCommand('"/opt/bin/pandoc"'));
  check('command detection: not pandoc', !svc.isPandocCommand('node') && !svc.isPandocCommand('/bin/sh'));

  const parts = svc.shellSplit('pandoc "a b.md" -o out.docx --from=markdown --reference-doc "ref x.docx"');
  check('shellSplit keeps quoted paths', parts.length === 7 && parts[1] === 'a b.md' &&
    parts[6] === 'ref x.docx', JSON.stringify(parts));

  const parsed = svc.parseArgs(['-f', 'markdown', '-t', 'docx', '-o', 'out.docx', '-s',
    '--reference-doc', 'r.docx', '--citeproc', '--bibliography=b.bib', 'in.md']);
  check('parseArgs maps common plugin flags',
    parsed.from === 'markdown' && parsed.to === 'docx' && parsed.output === 'out.docx' &&
    parsed.standalone === true && parsed.referenceDoc === 'r.docx' &&
    parsed.bibliography === 'b.bib' && parsed.inputs.length === 1);

  const version = fs.readFileSync(path.join(RES, 'pandoc-version.txt'), 'utf8').trim();
  const service = svc.createService(svc.createPandocInstance, {
    wasmGzPath: path.join(RES, 'pandoc.wasm.gz'),
    version,
    tmpDir: os.tmpdir(),
  });

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ohsidian-pandoc-'));
  try {
    // --version must be instant: plugins call it during load; do not pay the
    // ~1 s WASM instantiation for it.
    const t0 = Date.now();
    const ver = await service.runCli({ argv: ['--version'] });
    check('--version answers quickly and parseably',
      ver.code === 0 && /^pandoc \d+\.\d+/.test(ver.stdout) && Date.now() - t0 < 500,
      Date.now() - t0 + 'ms: ' + ver.stdout.split('\n')[0]);

    const html = await service.runCli({ argv: ['-f', 'markdown', '-t', 'html', '-s'], stdin: '# hi\n\n**bold**\n', cwd: tmp });
    check('markdown -> html', html.code === 0 && /<h1/.test(html.stdout), html.code + ' ' + (html.stderr || '').slice(0, 120));

    const docx = await service.runCli({ argv: ['-f', 'markdown', '-t', 'docx', '-o', 'o.docx'], stdin: '# hi\n', cwd: tmp });
    const docxPath = path.join(tmp, 'o.docx');
    check('markdown -> docx file', docx.code === 0 && fs.existsSync(docxPath) &&
      fs.readFileSync(docxPath).subarray(0, 2).toString('latin1') === 'PK',
      docx.code + ' ' + (docx.stderr || '').slice(0, 120));

    const pdf = await service.runCli({ argv: ['-f', 'markdown', '-t', 'pdf', '-o', 'o.pdf'], stdin: '# hi\n', cwd: tmp });
    check('pdf output fails with an actionable message', pdf.code === 1 && /PDF output is not supported/.test(pdf.stderr));

    fs.writeFileSync(path.join(tmp, 'x.sh'), '#!/bin/sh\ncat\n');
    const filter = await service.runCli({ argv: ['-t', 'html', '--filter', 'x.sh'], stdin: '# hi\n', cwd: tmp });
    check('executable filters fail with an actionable message', filter.code === 1 && /Lua filter/.test(filter.stderr), filter.stderr.slice(0, 120));

    const missingInput = await service.runCli({ argv: ['-t', 'html', 'nope.md'], cwd: tmp });
    check('missing input file fails like pandoc', missingInput.code === 1 && /does not exist/.test(missingInput.stderr));

    fs.writeFileSync(path.join(tmp, 'in.md'), '# from file\n\n- a\n');
    const fromFile = await service.runCli({ argv: ['-f', 'markdown', '-t', 'docx', '-o', 'fromfile.docx', 'in.md'], cwd: tmp });
    check('input file + -o output', fromFile.code === 0 && fs.existsSync(path.join(tmp, 'fromfile.docx')),
      fromFile.code + ' ' + (fromFile.stderr || '').slice(0, 120));

    // Lua filter + reference-doc + embedded local image (the plugin patterns).
    const refDocx = path.join(tmp, 'ref.docx');
    fs.copyFileSync(docxPath, refDocx);
    fs.writeFileSync(path.join(tmp, 'filter.lua'), 'function Strong(e) return pandoc.Span(e.content) end\n');
    const png = Buffer.from(
      '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c63000100000500010d0a2db40000000049454e44ae426082', 'hex');
    fs.writeFileSync(path.join(tmp, 'img.png'), png);
    fs.writeFileSync(path.join(tmp, 'media.md'), '![x](img.png)\n\n**bold**\n');
    const withRef = await service.runCli({
      argv: ['-f', 'markdown', '-t', 'docx', '-o', 'withref.docx', '--reference-doc', 'ref.docx',
        '--lua-filter', 'filter.lua', 'media.md'], cwd: tmp,
    });
    check('reference-doc + lua filter + local image', withRef.code === 0 && fs.existsSync(path.join(tmp, 'withref.docx')),
      withRef.code + ' ' + (withRef.stderr || '').slice(0, 160));

    const st = await service.selfTest();
    check('self test reports version/html/docx', st.checks.length === 3 && st.checks.every((c) => c.ok),
      JSON.stringify(st.checks.map((c) => c.name + ':' + c.ok)));
  } catch (e) {
    check('service invocation', false, String((e && e.stack) || e));
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* ignore */ }
  }

  console.log(failures ? 'PANDOC-WASM VERIFY: FAILURES' : 'PANDOC-WASM VERIFY: OK');
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error('PANDOC-WASM VERIFY: FAILURES\n' + ((e && e.stack) || e));
  process.exit(1);
});
