// Thin hdc wrapper. Everything device-specific lives here so the rest of the
// harness can be exercised offline (--selftest) without an attached tablet.
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { run, which, ensureDir, readJson, writeJson, sleep, log, EVAL_DIR } from "./util.mjs";

export const BUNDLE = "com.mikannqaq.obsidian";
export const ABILITY = "EntryAbility";

export function findHdc() {
  if (process.env.OHSIDIAN_HDC && fs.existsSync(process.env.OHSIDIAN_HDC)) return process.env.OHSIDIAN_HDC;
  const onPath = which("hdc");
  if (onPath) return onPath;
  const roots = [
    process.env.DEVECO_SDK_HOME,
    process.env.HARMONYOS_SDK_HOME,
    process.env.OHOS_SDK_HOME,
    "D:/program/DevEco Studio/sdk",
    path.join(process.env.LOCALAPPDATA || "", "Huawei", "Sdk"),
    path.join(os.homedir(), "AppData", "Local", "Huawei", "Sdk"),
    "C:/Program Files/Huawei/DevEco Studio/sdk",
  ].filter(Boolean);
  const suffixes = [
    path.join("default", "openharmony", "toolchains", "hdc.exe"),
    path.join("openharmony", "toolchains", "hdc.exe"),
    path.join("toolchains", "hdc.exe"),
  ];
  for (const root of roots) {
    for (const suffix of suffixes) {
      const p = path.join(root, suffix);
      if (fs.existsSync(p)) return p;
    }
    // sdk/<api>/openharmony/toolchains/hdc.exe
    try {
      for (const entry of fs.readdirSync(root)) {
        for (const suffix of suffixes) {
          const p = path.join(root, entry, suffix);
          if (fs.existsSync(p)) return p;
        }
      }
    } catch (e) {}
  }
  return "";
}

export class DeviceError extends Error {}

export class Device {
  constructor(hdc, serial) {
    this.hdc = hdc;
    this.serial = serial;
    this.caps = { screenrecord: false, snapshot: "", uitest: false, timeMs: false };
  }

  async shell(cmd, opts = {}) {
    return run(this.hdc, ["-t", this.serial, "shell", cmd], { timeoutMs: opts.timeoutMs || 20000 });
  }

  async shellOk(cmd, opts = {}) {
    const r = await this.shell(cmd, opts);
    if (r.code !== 0) {
      throw new DeviceError(`hdc shell failed (${r.code}): ${cmd}\n${(r.err || r.out).trim().slice(-300)}`);
    }
    return (r.out || "").trim();
  }

  async send(local, remote) {
    const r = await run(this.hdc, ["-t", this.serial, "file", "send", local, remote], { timeoutMs: 180000 });
    if (r.code !== 0) throw new DeviceError(`hdc file send failed: ${local}\n${(r.err || r.out).trim().slice(-300)}`);
    return r.out;
  }

  async recv(remote, local) {
    await ensureDir(path.dirname(local));
    const r = await run(this.hdc, ["-t", this.serial, "file", "recv", remote, local], { timeoutMs: 180000 });
    if (r.code !== 0) throw new DeviceError(`hdc file recv failed: ${remote}\n${(r.err || r.out).trim().slice(-300)}`);
    return local;
  }

  async recvSafe(remote, local) {
    try {
      await this.recv(remote, local);
      return fs.existsSync(local) && fs.statSync(local).size > 0;
    } catch (e) {
      return false;
    }
  }

  async launch() {
    return this.shell(`aa start -a ${ABILITY} -b ${BUNDLE}`);
  }

  async forceStop() {
    return this.shell(`aa force-stop ${BUNDLE}`);
  }

  async isInstalled() {
    const r = await this.shell(`bm dump -n ${BUNDLE}`);
    return r.code === 0 && /bundleName/.test(r.out || "");
  }

  async install(hap) {
    const r = await run(this.hdc, ["-t", this.serial, "install", "-r", hap], { timeoutMs: 600000 });
    if (r.code !== 0) throw new DeviceError(`hdc install failed:\n${(r.err || r.out).trim().slice(-600)}`);
    return r.out;
  }

  /** Device epoch in ms. Prefers `date +%s%3N`; falls back to seconds. */
  async epochMs() {
    const r = await this.shell("date +%s%3N");
    const txt = (r.out || "").trim();
    if (/^\d{13}$/.test(txt)) {
      this.caps.timeMs = true;
      return Number(txt);
    }
    const r2 = await this.shell("date +%s");
    const sec = Number((r2.out || "").trim());
    if (!sec) return 0;
    return sec * 1000 + 500; // mid-second; offset is re-sampled below anyway
  }

  /**
   * deviceEpoch - hostEpoch. Used to map host scene windows onto probe
   * timestamps (probe events carry the renderer's Date.now()).
   */
  async clockOffset() {
    const samples = [];
    for (let i = 0; i < 3; i++) {
      const t0 = Date.now();
      const dev = await this.epochMs();
      const t1 = Date.now();
      if (dev) samples.push(dev - (t0 + t1) / 2);
      await sleep(120);
    }
    if (!samples.length) return 0;
    samples.sort((a, b) => a - b);
    return Math.round(samples[Math.floor(samples.length / 2)]);
  }

  async probeCapabilities() {
    const has = async (cmd) => {
      const r = await this.shell(`command -v ${cmd}`);
      return r.code === 0 && (r.out || "").trim().length > 0;
    };
    this.caps.screenrecord = await has("screenrecord");
    this.caps.snapshot = (await has("snapshot_display")) ? "snapshot_display" : "";
    this.caps.uitest = await has("uitest");
    if (!this.caps.snapshot && this.caps.uitest) {
      const r = await this.shell("uitest screenCap --help");
      if (/screenCap/.test((r.out || "") + (r.err || ""))) this.caps.snapshot = "uitest";
    }
    if (this.caps.screenrecord) {
      const h = await this.shell("screenrecord --help");
      const txt = (h.out || "") + (h.err || "");
      this.caps.screenrecordTime = /--time/.test(txt) ? "--time" : /(^|\s)-t(\s|,)/.test(txt) ? "-t" : "--time";
      this.caps.screenrecordHelp = txt.slice(0, 400);
    }
    return this.caps;
  }

  screenrecordArgs(seconds, remote) {
    const flag = this.caps.screenrecordTime || "--time";
    return ["screenrecord", flag, String(Math.max(1, Math.ceil(seconds))), remote];
  }

  screenshotArgs(remote) {
    if (this.caps.snapshot === "uitest") return ["uitest", "screenCap", "-p", remote];
    return ["snapshot_display", "-f", remote];
  }

  /** One screenshot; returns the local path (or throws). Used as a capability test. */
  async screenshot(remote, local) {
    const args = this.screenshotArgs(remote);
    const cmd = args.map((a) => (/[\s"']/.test(a) ? `"${a}"` : a)).join(" ");
    // snapshot_display returns before the JPEG is fully flushed on some builds;
    // recv immediately after the shell call produced 0-byte files in doctor.
    await this.shell(`rm -f ${remote}`);
    const r = await run(this.hdc, ["-t", this.serial, "shell", cmd], { timeoutMs: 20000 });
    if (r.code !== 0) throw new DeviceError(`screenshot failed: ${(r.err || r.out).trim().slice(-200)}`);
    for (let attempt = 0; attempt < 3; attempt++) {
      await sleep(attempt === 0 ? 250 : 350);
      try {
        await this.recv(remote, local);
      } catch (e) {
        if (attempt === 2) throw e;
      }
      if (fs.existsSync(local) && fs.statSync(local).size > 512) return local;
    }
    throw new DeviceError("screenshot is empty after 3 attempts");
  }

  async mkdir(remote) {
    await this.shell(`mkdir -p "${remote}"`);
  }

  async pushTree(localDir, remoteDir) {
    await this.mkdir(remoteDir);
    const files = [];
    const walk = async (dir, rel) => {
      for (const entry of await fsp.readdir(dir, { withFileTypes: true })) {
        const r = rel ? `${rel}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
          await this.mkdir(`${remoteDir}/${r}`);
          await walk(path.join(dir, entry.name), r);
        } else if (entry.isFile()) {
          await this.send(path.join(dir, entry.name), `${remoteDir}/${r}`);
          files.push(r);
        }
      }
    };
    await walk(localDir, "");
    return files;
  }
}

export async function listTargets(hdc) {
  const r = await run(hdc, ["list", "targets"], { timeoutMs: 15000 });
  return (r.out || "")
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter((s) => s && !/^\[?Empty\]?$/i.test(s));
}

export async function connectDevice({ hdc, serial, retries = 1 } = {}) {
  const bin = hdc || findHdc();
  if (!bin) throw new DeviceError("hdc not found: install DevEco Studio or set OHSIDIAN_HDC");
  let target = serial || "";
  for (let attempt = 0; attempt <= retries; attempt++) {
    const targets = await listTargets(bin);
    if (!targets.length) {
      if (attempt < retries) {
        log.warn("no device in `hdc list targets`, retrying in 3s...");
        await sleep(3000);
        continue;
      }
      throw new DeviceError("no device: `hdc list targets` is empty (connect USB / wireless debugging)");
    }
    if (!target) {
      if (targets.length > 1) {
        throw new DeviceError("multiple devices: pass --device <id>. Found: " + targets.join(", "));
      }
      target = targets[0];
    } else if (!targets.includes(target)) {
      // Wireless debugging sometimes needs an explicit connect first.
      await run(bin, ["tconn", target], { timeoutMs: 15000 });
      const again = await listTargets(bin);
      if (!again.includes(target)) {
        throw new DeviceError(`device ${target} not in list: ${again.join(", ") || "(empty)"}`);
      }
    }
    const dev = new Device(bin, target);
    const r = await dev.shell("echo ohsidian-eval");
    if (r.code === 0 && /ohsidian-eval/.test(r.out || "")) return dev;
    if (attempt < retries) await sleep(2000);
  }
  throw new DeviceError(`cannot run shell on ${target} (unauthorized? accept the debugging prompt)`);
}

export async function loadConfig() {
  return readJson(path.join(EVAL_DIR, "config.local.json"), {});
}

export async function saveConfig(cfg) {
  const p = path.join(EVAL_DIR, "config.local.json");
  await writeJson(p, cfg);
  return p;
}
