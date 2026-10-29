#!/usr/bin/env node
/**
 * OHSidian device agent.
 *
 * Commands:
 *   doctor
 *   install [--hap path]
 *   launch [--uri obsidian://...]
 *   logs [--out file]
 *   run --scenario pdf-scroll [--profile tablet] [--no-launch]
 *   fix --list
 *   fix --apply <id> --scenario pdf-scroll
 *
 * No third-party dependencies. See README.md.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Hdc } from './lib/hdc.mjs';
import { makeInput, runSteps } from './lib/scenarios.mjs';
import { parseLogText, summarize, diagnose } from './lib/logs.mjs';
import { writeReport, ensureDir } from './lib/report.mjs';
import { listFixers, applyFix, rebuildAndInstall } from './lib/fixers.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const RELEASE_HAP = path.join(ROOT, 'electron/build/default/outputs/default/electron-default-signed.hap');
const AGENT_HAP = path.join(ROOT, 'electron/build/default/outputs/default/electron-default-agent.hap');
const DEFAULT_HAP = fs.existsSync(AGENT_HAP) ? AGENT_HAP : RELEASE_HAP;

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) {
        out[key] = next;
        i++;
      } else {
        out[key] = true;
      }
    } else {
      out._.push(a);
    }
  }
  return out;
}

function readJson(file, dflt) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return dflt; }
}

function profile(name) {
  const file = path.join(HERE, 'profiles', `${name || 'tablet'}.json`);
  const p = readJson(file, null);
  if (!p) throw new Error('profile not found: ' + file);
  return p;
}

function scenario(name) {
  const direct = path.isAbsolute(name) || name.endsWith('.json') ? name : path.join(HERE, 'scenarios', `${name}.json`);
  const s = readJson(direct, null);
  if (!s) throw new Error('scenario not found: ' + direct);
  return s;
}

function hdcFrom(opts) {
  return new Hdc({
    hdc: opts.hdc,
    target: opts.target,
    verbose: opts.verbose !== 'false',
  });
}

function outDirFor(label) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  return ensureDir(path.join(ROOT, 'reports', `${stamp}-${label}`));
}

function logFilter(text) {
  const keep = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    if (/InkUI|PdfInkWriter|PdfInk\b|fake worker|OHSidian|Chromium.*pdf|pdf\.js/i.test(line)) {
      keep.push(line);
    }
  }
  return keep;
}

async function collect(hdc, dir, rawName = 'hilog.txt') {
  const raw = hdc.dumpLogs();
  const file = path.join(dir, rawName);
  fs.writeFileSync(file, raw.out || '', 'utf8');
  return { file, raw: raw.out || '', ok: raw.ok };
}

function printMetrics(summary) {
  console.log('\n=== metrics ===');
  console.log('fakeWorker      ', summary.fakeWorker);
  console.log('docLoaded(ms)   ', summary.docLoaded ? summary.docLoaded.ms : '-');
  console.log('firstPage(ms)   ', summary.firstPageMs);
  console.log('maxPage(ms)     ', summary.maxPageMs);
  console.log('whitePages      ', `${summary.whitePages}/${summary.pageCount}`);
  console.log('reloads         ', summary.reloads);
  console.log('viewerReplaced  ', summary.viewerReplaced);
  console.log('write           ', summary.write ? `${summary.write.ms}ms ok=${summary.write.ok}` : '-');
}

async function cmdRun(opts, scenarioObj) {
  const prof = profile(opts.profile);
  const hdc = hdcFrom(opts);
  if (!hdc.waitForDevice(Number(opts.waitDeviceMs) || 15000)) {
    throw new Error('no device; check hdc list targets');
  }
  const dir = outDirFor(scenarioObj.name || 'run');
  if (opts['no-launch'] !== true) {
    hdc.clearLogs();
    hdc.stop(prof.bundle);
    hdc.start(prof.bundle, prof.ability, opts.uri || '');
    await new Promise((r) => setTimeout(r, Number(opts.bootWait) || 3500));
  } else if (opts.clear !== false) {
    hdc.clearLogs();
  }
  if (scenarioObj.waitBefore) {
    await new Promise((r) => setTimeout(r, Number(scenarioObj.waitBefore) || 0));
  }
  const input = makeInput(hdc, prof);
  const shots = await runSteps(hdc, input, scenarioObj.steps || [], {
    screenshotDir: dir,
    tag: scenarioObj.name || 'run',
  });
  await new Promise((r) => setTimeout(r, Number(scenarioObj.waitAfter ?? opts.waitAfter) || 3000));
  const collected = await collect(hdc, dir);
  const events = parseLogText(collected.raw);
  const summary = summarize(events);
  const issues = diagnose(summary, scenarioObj.expect || {});
  const report = writeReport(dir, {
    scenario: scenarioObj,
    profile: prof,
    summary,
    issues,
    logLines: logFilter(collected.raw),
    screenshots: shots.map((s) => s.file),
    meta: { hap: opts.hap || DEFAULT_HAP, rawLog: collected.file },
  });
  printMetrics(summary);
  console.log('issues:', issues.length);
  for (const it of issues) console.log(` [${it.severity}] ${it.code}: ${it.message}`);
  console.log('report:', report.mdPath);
  return { dir, report, summary, issues, events };
}

function cmdDoctor(opts) {
  const prof = profile(opts.profile);
  const hdc = hdcFrom(opts);
  const t = hdc.listTargets();
  console.log('hdc:', hdc.bin);
  console.log(t.out.trim());
  console.log('bundle:', prof.bundle, 'ability:', prof.ability);
  console.log('agent hap:', AGENT_HAP, fs.existsSync(AGENT_HAP) ? 'OK' : 'MISSING');
  console.log('release hap:', RELEASE_HAP, fs.existsSync(RELEASE_HAP) ? 'OK' : 'MISSING');
  console.log('install target:', opts.hap || DEFAULT_HAP,
    fs.existsSync(opts.hap || DEFAULT_HAP) ? 'OK' : 'MISSING');
  console.log('profile:', prof.name, prof.screen, 'dpr', prof.dpr);
}

function score(summary) {
  let s = 0;
  s += (summary.fakeWorker || 0) * 10000;
  s += (summary.whiteRate || 0) * 5000;
  s += (summary.whitePages || 0) * 400;
  s += (summary.reloads || 0) * 300;
  s += (summary.viewerReplaced || 0) * 300;
  s += (summary.docLoaded ? summary.docLoaded.ms : 8000) / 10;
  s += (summary.firstPageMs == null ? 3000 : summary.firstPageMs) / 5;
  s += (summary.maxPageMs || 0) / 20;
  if (summary.write && !summary.write.ok) s += 5000;
  if (summary.write && summary.write.ms) s += summary.write.ms / 20;
  return Math.round(s);
}

async function cmdFix(opts) {
  if (opts.list === true || !opts.apply) {
    for (const f of listFixers()) console.log(`${f.id}\t${f.title}\t(${f.symptom})`);
    return;
  }
  const id = String(opts.apply);
  const hdc = hdcFrom(opts);
  if (!hdc.waitForDevice(15000)) throw new Error('no device');
  const s = scenario(opts.scenario || 'pdf-smoke');
  let baseline = null;
  try {
    baseline = await cmdRun({ ...opts }, s);
    console.log('[fix] baseline score', score(baseline.summary));
  } catch (e) {
    console.warn('[fix] baseline failed (continuing):', e.message);
  }
  const fix = applyFix(id);
  try {
    const { hap } = rebuildAndInstall();
    const inst = hdc.install(hap);
    if (!inst.ok) throw new Error('install failed: ' + inst.out);
    const after = await cmdRun({ ...opts, hap }, s);
    const afterScore = score(after.summary);
    console.log('[fix] applied score', afterScore, 'report', after.report.mdPath);
    if (baseline && afterScore >= score(baseline.summary)) {
      console.warn('[fix] not better than baseline -> reverting');
      fix.revert();
      try {
        const rebuilt = rebuildAndInstall();
        const r2 = hdc.install(rebuilt.hap);
        if (!r2.ok) console.error('[fix] reinstall after revert failed');
      } catch (e2) {
        console.error('[fix] rebuild after revert failed:', e2.message);
      }
    }
  } catch (e) {
    console.error('[fix] failed:', e.message);
    fix.revert();
    try {
      const rebuilt = rebuildAndInstall();
      const r2 = hdc.install(rebuilt.hap);
      if (!r2.ok) console.error('[fix] reinstall after revert failed');
      console.error('[fix] source reverted and rebuilt');
    } catch (e2) {
      console.error('[fix] rebuild after revert failed:', e2.message);
    }
    process.exitCode = 1;
  }
}

async function main() {
  const argv = process.argv.slice(2);
  const opts = parseArgs(argv);
  const cmd = opts._[0] || 'help';
  if (cmd === 'doctor') return cmdDoctor(opts);
  if (cmd === 'install') {
    const hdc = hdcFrom(opts);
    if (!hdc.waitForDevice(30000)) throw new Error('no device');
    const r = hdc.install(opts.hap || DEFAULT_HAP);
    console.log(r.out);
    process.exitCode = r.ok ? 0 : 1;
    return;
  }
  if (cmd === 'launch') {
    const prof = profile(opts.profile);
    const hdc = hdcFrom(opts);
    hdc.clearLogs();
    hdc.stop(prof.bundle);
    const r = hdc.start(prof.bundle, prof.ability, opts.uri || '');
    console.log(r.out);
    process.exitCode = r.ok ? 0 : 1;
    return;
  }
  if (cmd === 'logs') {
    const dir = outDirFor('logs');
    const hdc = hdcFrom(opts);
    const c = await collect(hdc, dir);
    const events = parseLogText(c.raw);
    const summary = summarize(events);
    printMetrics(summary);
    const reports = writeReport(dir, {
      scenario: { name: 'logs' },
      profile: profile(opts.profile),
      summary,
      issues: diagnose(summary, {}),
      logLines: logFilter(c.raw),
      screenshots: [],
      meta: { rawLog: c.file },
    });
    console.log('report:', reports.mdPath);
    return;
  }
  if (cmd === 'run') {
    const s = scenario(opts.scenario || 'pdf-smoke');
    await cmdRun(opts, s);
    return;
  }
  if (cmd === 'fix') return cmdFix(opts);
  console.log(`usage:
  node tools/device-agent/agent.mjs doctor
  node tools/device-agent/agent.mjs install [--hap path]
  node tools/device-agent/agent.mjs launch [--uri obsidian://...]
  node tools/device-agent/agent.mjs logs
  node tools/device-agent/agent.mjs run --scenario pdf-scroll [--profile tablet] [--no-launch]
  node tools/device-agent/agent.mjs fix --list
  node tools/device-agent/agent.mjs fix --apply pdf-cap-50 --scenario pdf-scroll
`);
}

main().catch((e) => {
  console.error('[agent] ERROR', e && e.stack || e);
  process.exitCode = 1;
});
