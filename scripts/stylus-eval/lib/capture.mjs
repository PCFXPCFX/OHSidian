// Screen capture strategies.
//
//  native : `hdc shell screenrecord` — smooth, one long file, cut per scene.
//  frames : `snapshot_display`/`uitest screenCap` polling — choppy but works
//           on builds without screenrecord; clips keep real timing because
//           every frame carries its wall-clock timestamp.
//  fixture: no device, synthetic testsrc frames (--selftest only).
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { run, ensureDir, sleep, log, fmtBytes, fmtSec } from "./util.mjs";
import { cutMp4, framesToMp4, makeGif, poster, probe, ffmpegPath } from "./ffmpeg.mjs";

const REMOTE_DIR = "/data/local/tmp";

function gifName(dir) {
  return path.join(dir, "clip.gif");
}

async function encodeClipFromMp4(srcMp4, outDir, opts = {}) {
  await ensureDir(outDir);
  const clipMp4 = path.join(outDir, "clip.mp4");
  const info = await probe(srcMp4);
  if (!info.ok) throw new Error("source mp4 is unreadable: " + info.error);
  const start = Math.max(0, opts.start || 0);
  const dur = Math.min((opts.dur || info.duration), Math.max(0.2, info.duration - start));
  await cutMp4(srcMp4, clipMp4, start, dur, { width: opts.width || 1080, fps: 30 });
  return finishGallery(clipMp4, outDir, { duration: dur });
}

async function finishGallery(clipMp4, outDir, opts = {}) {
  const info = await probe(clipMp4);
  const gif = gifName(outDir);
  let gifInfo = { size: 0 };
  try {
    gifInfo = await makeGif(clipMp4, gif, {
      fps: 12,
      width: 720,
      dur: Math.min(7, Math.max(0.5, (info.duration || opts.duration || 3) - 0.1)),
    });
    if (gifInfo.size > 9.5 * 1024 * 1024) {
      gifInfo = await makeGif(clipMp4, gif, { fps: 10, width: 540, colors: 96 });
    }
  } catch (e) {
    log.warn("GIF encode failed: " + e.message);
  }
  let posterFile = "";
  try {
    posterFile = await poster(clipMp4, path.join(outDir, "poster.png"), Math.min(0.6, (info.duration || 2) / 2));
  } catch (e) {}
  return {
    mp4: clipMp4,
    gif,
    poster: posterFile,
    duration: info.duration || 0,
    size: info.size || fs.statSync(clipMp4).size,
    width: info.width || 0,
    height: info.height || 0,
    gifSize: gifInfo.size || 0,
  };
}

export class NativeRecorder {
  constructor(device, dir, opts = {}) {
    this.kind = "native";
    this.device = device;
    this.dir = dir;
    this.opts = opts;
    this.remote = `${REMOTE_DIR}/ohsidian-eval-${Date.now()}.mp4`;
    this.proc = null;
    this.t0 = 0;
    this.leadMs = opts.leadMs ?? 350;
    this.out = "";
    this.err = "";
  }

  async start(maxSeconds) {
    if (!this.device.caps.screenrecord) throw new Error("screenrecord not available");
    const args = this.device.screenrecordArgs(maxSeconds, this.remote);
    const full = ["-t", this.device.serial, "shell", ...args];
    log.info(`capture: screenrecord ${maxSeconds}s -> ${this.remote}`);
    this.proc = spawn(this.device.hdc, full, { windowsHide: true });
    this.t0 = Date.now();
    this.proc.stdout?.on("data", (d) => (this.out += d.toString("utf8")));
    this.proc.stderr?.on("data", (d) => (this.err += d.toString("utf8")));
    this.exited = new Promise((resolve) => {
      this.proc.on("close", (code) => resolve(code));
      this.proc.on("error", () => resolve(-1));
    });
    await sleep(700);
    if (this.proc.exitCode !== null && this.proc.exitCode !== 0) {
      throw new Error("screenrecord failed immediately: " + (this.err || this.out).slice(-300));
    }
    return this;
  }

  async stop() {
    if (!this.proc) return { kind: this.kind, t0: this.t0 };
    let code = null;
    const race = await Promise.race([
      this.exited.then((c) => ({ done: true, c })),
      sleep(this.opts.stopTimeoutMs || 20000).then(() => ({ done: false })),
    ]);
    if (!race.done) {
      log.warn("screenrecord did not exit; stopping the device process");
      await this.device.shell(`pkill -f screenrecord`);
      await Promise.race([this.exited, sleep(3000)]);
    } else {
      code = race.c;
    }
    const local = path.join(this.dir, "session.mp4");
    await this.device.recv(this.remote, local);
    const info = await probe(local);
    if (!info.ok) throw new Error("recorded mp4 is unreadable: " + info.error);
    log.ok(`session video: ${fmtSec(info.duration)}, ${fmtBytes(info.size)} (exit ${code})`);
    await this.device.shell(`rm -f ${this.remote}`);
    return { kind: this.kind, t0: this.t0, leadMs: this.leadMs, file: local, ...info };
  }

  async clip(startMs, endMs, outDir, opts = {}) {
    const pad = opts.pad ?? 0.35;
    const start = (startMs - this.t0) / 1000 - pad;
    const dur = (endMs - startMs) / 1000 + pad * 2;
    return encodeClipFromMp4(path.join(this.dir, "session.mp4"), outDir, {
      start: Math.max(0, start),
      dur,
      width: opts.width || 1080,
    });
  }
}

export class FrameRecorder {
  constructor(device, dir, opts = {}) {
    this.kind = "frames";
    this.device = device;
    this.dir = dir;
    this.opts = opts;
    this.fps = Math.max(1, Number(opts.fps) || 3);
    this.frames = [];
    this.running = false;
    this.errors = 0;
    this.t0 = 0;
    this.ext = device.caps.snapshot === "uitest" ? "png" : "jpeg";
  }

  async start() {
    await ensureDir(path.join(this.dir, "frames"));
    this.running = true;
    this.t0 = Date.now();
    this.loop = this.captureLoop();
    log.info(`capture: ${this.device.caps.snapshot || "snapshot"} frames at ~${this.fps} fps`);
    return this;
  }

  async captureLoop() {
    let n = 0;
    while (this.running) {
      const t = Date.now();
      const remote = `${REMOTE_DIR}/ohs-eval-frame.${this.ext}`;
      const local = path.join(this.dir, "frames", `f_${String(n).padStart(5, "0")}.${this.ext}`);
      try {
        await this.device.screenshot(remote, local);
        this.frames.push({ file: local, t });
        this.errors = 0;
        n++;
      } catch (e) {
        this.errors++;
        if (this.errors === 1) log.warn("screenshot failed: " + e.message);
        if (this.errors >= 5) {
          this.running = false;
          this.fatal = e;
          break;
        }
      }
      const spent = Date.now() - t;
      await sleep(Math.max(0, Math.round(1000 / this.fps) - spent));
    }
  }

  async stop() {
    this.running = false;
    try {
      await this.loop;
    } catch (e) {}
    log.ok(`captured ${this.frames.length} frames` + (this.fatal ? ` (stopped: ${this.fatal.message})` : ""));
    return { kind: this.kind, t0: this.t0, frames: this.frames.length };
  }

  async clip(startMs, endMs, outDir, opts = {}) {
    const padMs = (opts.pad ?? 0.35) * 1000;
    const picked = this.frames.filter((f) => f.t >= startMs - padMs && f.t <= endMs + padMs);
    if (picked.length < 2) throw new Error("not enough frames for this scene (capture too slow?)");
    await ensureDir(outDir);
    const clipMp4 = path.join(outDir, "clip.mp4");
    const info = await framesToMp4(picked, clipMp4, { fps: opts.outFps || 15, width: opts.width || 1080 });
    const realDur = Math.min(30, (picked[picked.length - 1].t - picked[0].t) / 1000);
    return finishGallery(clipMp4, outDir, { duration: realDur || info.duration });
  }
}

/**
 * Offline recorder used by --selftest. Generates a testsrc video with ffmpeg,
 * then decodes it to timestamped frames so the exact same frame->clip path as
 * FrameRecorder is exercised.
 */
export class FixtureRecorder {
  constructor(dir, opts = {}) {
    this.kind = "fixture";
    this.dir = dir;
    this.opts = opts;
    this.frames = [];
    this.t0 = 0;
    this.seconds = opts.seconds || 12;
  }

  async start() {
    await fsp.rm(path.join(this.dir, "frames"), { recursive: true, force: true });
    await ensureDir(path.join(this.dir, "frames"));
    const source = path.join(this.dir, "fixture-source.mp4");
    const fps = this.opts.fps || 10;
    const w = 720;
    const h = 1080;
    const r = await run(ffmpegPath(), [
      "-y", "-f", "lavfi",
      "-i", `testsrc2=size=${w}x${h}:rate=${fps}:duration=${this.seconds}`,
      "-vf", `drawtext=text='OHSIDIAN SELFTEST':fontcolor=white:fontsize=28:x=24:y=24:box=1:boxcolor=black@0.5`,
      "-pix_fmt", "yuvj420p",
      path.join(this.dir, "frames", "f_%05d.jpg"),
    ], { timeoutMs: 180000 });
    if (r.code !== 0) {
      // drawtext may miss a font; retry without it.
      const r2 = await run(ffmpegPath(), [
        "-y", "-f", "lavfi",
        "-i", `testsrc2=size=${w}x${h}:rate=${fps}:duration=${this.seconds}`,
        "-pix_fmt", "yuvj420p",
        path.join(this.dir, "frames", "f_%05d.jpg"),
      ], { timeoutMs: 180000 });
      if (r2.code !== 0) throw new Error("cannot generate selftest frames: " + (r2.err || "").slice(-300));
    }
    const names = (await fsp.readdir(path.join(this.dir, "frames"))).filter((f) => f.endsWith(".jpg")).sort();
    this.t0 = Date.now() - 1000;
    this.frames = names.map((f, i) => ({
      file: path.join(this.dir, "frames", f),
      t: this.t0 + i * (1000 / fps),
    }));
    try {
      await fsp.unlink(source);
    } catch (e) {}
    log.info(`fixture: ${this.frames.length} synthetic frames (${this.seconds}s)`);
    return this;
  }

  async stop() {
    return { kind: this.kind, t0: this.t0, frames: this.frames.length };
  }

  async clip(startMs, endMs, outDir, opts = {}) {
    const picked = this.frames.filter((f) => f.t >= startMs && f.t <= endMs);
    await ensureDir(outDir);
    const clipMp4 = path.join(outDir, "clip.mp4");
    const info = await framesToMp4(picked, clipMp4, { fps: 15, width: 1080 });
    return finishGallery(clipMp4, outDir, { duration: info.duration });
  }
}

export async function createRecorder({ device, dir, mode = "auto", fps = 3, leadMs = 350 }) {
  await ensureDir(dir);
  if (mode === "fixture") return new FixtureRecorder(dir, { seconds: 12, fps: 10 });
  if (mode === "frames") return new FrameRecorder(device, dir, { fps });
  if (mode === "native" || (mode === "auto" && device.caps.screenrecord)) {
    return new NativeRecorder(device, dir, { leadMs });
  }
  return new FrameRecorder(device, dir, { fps });
}

export function planSeconds(scenes, opts = {}) {
  const countdown = opts.countdown ?? 3;
  const gap = opts.gap ?? 1.5;
  const total = scenes.reduce((n, s) => n + (s.window || 8) + countdown + gap, 0);
  return Math.ceil(total + 15);
}
