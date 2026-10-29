import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { Hdc } from './hdc.mjs';

const ROOT = path.resolve(new URL('../../../', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const INK = path.join(ROOT, 'scripts/patches/ohsidian-ink.js');
const UPDATE = path.join(ROOT, 'scripts/update-obsidian.mjs');
const HAP = path.join(ROOT, 'electron/build/default/outputs/default/electron-default-signed.hap');
const HAP_AGENT = path.join(ROOT, 'electron/build/default/outputs/default/electron-default-agent.hap');

export const FIXERS = {
  'pdf-cap-50': {
    title: 'PDF 高 DPI 页面画布上限 0 → 50（1.5 屏）',
    symptom: '整窗宽 PDF 内存高、白页',
    files: [UPDATE],
    apply(src) {
      const a = src[UPDATE];
      const from = '?0:200)';
      if (!a.includes(from)) throw new Error('cap 0 anchor not found');
      return { [UPDATE]: a.replace(from, '?50:200)') };
    },
  },
  'pdf-ink': {
    title: 'PDF 注释默认样式 polyline → ink',
    symptom: '折线注释在目标阅读器不显示/不可接受',
    files: [INK],
    apply(src) {
      const a = src[INK];
      const from = 'state.pdfStyle = pref("inkPdfStyle", "polyline");';
      if (!a.includes(from)) throw new Error('pdfStyle default anchor not found');
      return { [INK]: a.replace(from, 'state.pdfStyle = pref("inkPdfStyle", "ink");') };
    },
  },
};

function read(files) {
  const out = {};
  for (const f of files) out[f] = fs.readFileSync(f, 'utf8');
  return out;
}

function writeAll(map) {
  for (const [f, v] of Object.entries(map)) fs.writeFileSync(f, v, 'utf8');
}

function run(cmd, args, opts = {}) {
  console.log('[fix]', cmd, args.join(' '));
  const res = spawnSync(cmd, args, {
    cwd: ROOT,
    stdio: 'inherit',
    shell: process.platform === 'win32',
    env: {
      ...process.env,
      DEVECO_SDK_HOME: process.env.DEVECO_SDK_HOME || 'D:\\program\\DevEco Studio\\sdk',
      PATH: [
        'D:\\program\\DevEco Studio\\tools\\node',
        'D:\\program\\DevEco Studio\\tools\\ohpm\\bin',
        'D:\\program\\DevEco Studio\\tools\\hvigor\\bin',
        process.env.PATH || '',
      ].join(path.delimiter),
    },
    ...opts,
  });
  if (res.error) throw res.error;
  if (res.status !== 0) throw new Error(`${path.basename(cmd)} exited ${res.status}`);
}

export function listFixers() {
  return Object.entries(FIXERS).map(([id, f]) => ({ id, title: f.title, symptom: f.symptom }));
}

export function applyFix(id) {
  const fixer = FIXERS[id];
  if (!fixer) throw new Error('unknown fixer: ' + id);
  const before = read(fixer.files);
  const after = fixer.apply(before);
  writeAll(after);
  return {
    id,
    before,
    after,
    revert() {
      writeAll(before);
    },
  };
}

export function rebuildAndInstall() {
  // Always build the AGENT asar for device sessions; release builds never
  // contain probe implementations.
  run('node', ['scripts/update-obsidian.mjs', '--repatch', '--agent']);
  run('hvigorw', ['assembleHap', '--mode', 'module', '-p', 'product=default',
    '-p', 'buildMode=debug', '--no-daemon']);
  if (!fs.existsSync(HAP)) throw new Error('HAP not found after build: ' + HAP);
  fs.copyFileSync(HAP, HAP_AGENT);
  return { hap: HAP_AGENT, hdc: new Hdc({ verbose: false }) };
}
