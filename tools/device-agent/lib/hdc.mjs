import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const DEVECO = 'D:\\program\\DevEco Studio';
const DEFAULT_HDC = path.join(DEVECO, 'sdk', 'default', 'openharmony', 'toolchains', 'hdc.exe');

export function resolveHdc(explicit) {
  const candidates = [
    explicit,
    process.env.HDC,
    process.env.HDC_PATH,
    DEFAULT_HDC,
    'hdc',
  ].filter(Boolean);
  for (const c of candidates) {
    if (c === 'hdc') return c;
    try {
      if (fs.existsSync(c)) return c;
    } catch (e) {}
  }
  return 'hdc';
}

export class Hdc {
  constructor(opts = {}) {
    this.bin = resolveHdc(opts.hdc);
    this.target = opts.target || '';
    this.timeout = opts.timeout || 60000;
    this.verbose = opts.verbose !== false;
  }

  prefix() {
    return this.target ? ['-t', this.target] : [];
  }

  run(args, opts = {}) {
    const argv = this.prefix().concat(args);
    if (this.verbose) console.log('[hdc]', this.bin, argv.join(' '));
    const res = spawnSync(this.bin, argv, {
      encoding: 'utf8',
      windowsHide: true,
      timeout: opts.timeout || this.timeout,
      maxBuffer: 32 * 1024 * 1024,
    });
    const out = (res.stdout || '') + (res.stderr || '');
    if (res.error) {
      return { ok: false, code: -1, out, error: String(res.error.message || res.error) };
    }
    return { ok: res.status === 0, code: res.status, out, error: '' };
  }

  shell(cmd, opts = {}) {
    return this.run(['shell', cmd], opts);
  }

  listTargets() {
    return this.run(['list', 'targets'], { timeout: 15000 });
  }

  waitForDevice(timeoutMs = 30000) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      const r = this.listTargets();
      if (r.ok && r.out && !/\[Empty\]/i.test(r.out)) return true;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 800);
    }
    return false;
  }

  install(hapPath) {
    return this.run(['install', '-r', hapPath], { timeout: 180000 });
  }

  uninstall(bundleName) {
    return this.run(['uninstall', bundleName], { timeout: 60000 });
  }

  start(bundleName, ability = 'EntryAbility', uri = '') {
    const cmd = `aa start -a ${ability} -b ${bundleName}` + (uri ? ` -U "${uri}"` : '');
    return this.shell(cmd, { timeout: 30000 });
  }

  stop(bundleName) {
    return this.shell(`aa force-stop ${bundleName}`, { timeout: 30000 });
  }

  clearLogs() {
    return this.shell('hilog -r', { timeout: 15000 });
  }

  dumpLogs() {
    // -x exits after dumping the buffer; without it hilog streams forever.
    return this.shell('hilog -x', { timeout: 90000 });
  }

  fileSend(local, remote) {
    return this.run(['file', 'send', local, remote], { timeout: 120000 });
  }

  fileRecv(remote, local) {
    return this.run(['file', 'recv', remote, local], { timeout: 120000 });
  }

  screenshot(localPath, remotePath = '/data/local/tmp/ohsidian-agent.jpeg') {
    // snapshot_display is present on HarmonyOS tablets; uitest screenCap is a
    // fallback for builds where it is not.
    let r = this.shell(`snapshot_display -f ${remotePath}`, { timeout: 30000 });
    if (!r.ok || !r.out || /not found|fail/i.test(r.out)) {
      r = this.shell(`uitest screenCap -p ${remotePath}`, { timeout: 30000 });
    }
    if (!r.ok) return r;
    return this.fileRecv(remotePath, localPath);
  }
}
