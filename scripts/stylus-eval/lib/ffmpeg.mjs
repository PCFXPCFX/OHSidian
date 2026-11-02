// ffmpeg/ffprobe wrappers. The harness only needs four operations:
// probe, cut+normalise to H.264, GIF (two-pass palette), and turn a JPEG
// frame sequence with real timestamps into a CFR clip.
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { run, runOk, which, ensureDir, log } from "./util.mjs";

let FFMPEG = "";
let FFPROBE = "";

export function locateFfmpeg() {
  FFMPEG = process.env.OHSIDIAN_FFMPEG || which("ffmpeg");
  FFPROBE = process.env.OHSIDIAN_FFPROBE || which("ffprobe");
  if (!FFMPEG) throw new Error("ffmpeg not found on PATH (set OHSIDIAN_FFMPEG)");
  if (!FFPROBE) throw new Error("ffprobe not found on PATH (set OHSIDIAN_FFPROBE)");
  return { ffmpeg: FFMPEG, ffprobe: FFPROBE };
}

export function ffmpegPath() {
  return FFMPEG;
}

export async function probe(file) {
  if (!FFPROBE) locateFfmpeg();
  const r = await run(FFPROBE, [
    "-v", "error",
    "-select_streams", "v:0",
    "-show_entries", "stream=width,height,r_frame_rate,codec_name,nb_frames,duration",
    "-show_entries", "format=duration,size",
    "-of", "json",
    file,
  ]);
  if (r.code !== 0) return { ok: false, error: (r.err || r.out).trim().slice(0, 300) };
  let j;
  try {
    j = JSON.parse(r.out);
  } catch (e) {
    return { ok: false, error: "ffprobe json: " + e.message };
  }
  const s = (j.streams && j.streams[0]) || {};
  const f = j.format || {};
  const [num, den] = String(s.r_frame_rate || "0/1").split("/").map(Number);
  const fps = den ? num / den : 0;
  return {
    ok: true,
    width: Number(s.width) || 0,
    height: Number(s.height) || 0,
    fps: Math.round(fps * 100) / 100,
    codec: s.codec_name || "",
    frames: Number(s.nb_frames) || 0,
    duration: Number(f.duration || s.duration) || 0,
    size: Number(f.size) || (fs.existsSync(file) ? fs.statSync(file).size : 0),
  };
}

const X264 = [
  "-c:v", "libx264",
  "-preset", "veryfast",
  "-crf", "20",
  "-pix_fmt", "yuv420p",
  "-movflags", "+faststart",
  "-an",
];

/** Cut [start, start+dur) and re-encode so the clip is seekable and small. */
export async function cutMp4(src, dst, start, dur, opts = {}) {
  if (!FFMPEG) locateFfmpeg();
  await ensureDir(path.dirname(dst));
  const width = opts.width || 1080;
  const fps = opts.fps || 30;
  const vf = `scale='min(${width},iw)':-2:flags=lanczos,fps=${fps}`;
  const args = [
    "-y",
    "-ss", Math.max(0, start).toFixed(3),
    "-t", Math.max(0.2, dur).toFixed(3),
    "-i", src,
    "-vf", vf,
    ...X264,
    dst,
  ];
  const r = await run(FFMPEG, args, { timeoutMs: 180000 });
  if (r.code !== 0) throw new Error("ffmpeg cut failed: " + (r.err || r.out).trim().slice(-400));
  return probe(dst);
}

/** Normalise an arbitrary recording to a publishable H.264 MP4. */
export async function normalizeMp4(src, dst, opts = {}) {
  if (!FFMPEG) locateFfmpeg();
  await ensureDir(path.dirname(dst));
  const width = opts.width || 1080;
  const fps = opts.fps || 30;
  const vf = `scale='min(${width},iw)':-2:flags=lanczos,fps=${fps}`;
  const r = await run(FFMPEG, ["-y", "-i", src, "-vf", vf, ...X264, dst], { timeoutMs: 300000 });
  if (r.code !== 0) throw new Error("ffmpeg normalise failed: " + (r.err || r.out).trim().slice(-400));
  return probe(dst);
}

/**
 * GIF for Coolapk/Bilibili previews. Two-pass palette (single filter graph)
 * keeps colour banding out of yellow highlighters; 720 px / 12 fps keeps the
 * file under the 10 MB upload limit for a 3-6 s clip.
 */
export async function makeGif(src, dst, opts = {}) {
  if (!FFMPEG) locateFfmpeg();
  await ensureDir(path.dirname(dst));
  const fps = opts.fps || 12;
  const width = opts.width || 720;
  const colors = opts.colors || 128;
  const start = Number(opts.start || 0);
  const dur = Number(opts.dur || 0);
  const vf =
    `fps=${fps},scale=${width}:-2:flags=lanczos,split[s0][s1];` +
    `[s0]palettegen=max_colors=${colors}:stats_mode=diff[p];` +
    `[s1][p]paletteuse=dither=bayer:bayer_scale=3:diff_mode=rectangle`;
  const args = ["-y"];
  if (dur > 0) args.push("-t", dur.toFixed(3));
  if (start > 0) args.push("-ss", start.toFixed(3));
  args.push("-i", src, "-vf", vf, "-loop", "0", dst);
  const r = await run(FFMPEG, args, { timeoutMs: 180000 });
  if (r.code !== 0) throw new Error("ffmpeg gif failed: " + (r.err || r.out).trim().slice(-400));
  const st = fs.statSync(dst);
  return { ok: true, size: st.size, width, fps };
}

export async function poster(src, dst, at = 0.6, width = 720) {
  if (!FFMPEG) locateFfmpeg();
  await ensureDir(path.dirname(dst));
  const r = await run(FFMPEG, [
    "-y", "-ss", String(Math.max(0, at)), "-i", src,
    "-frames:v", "1", "-vf", `scale=${width}:-2`, dst,
  ], { timeoutMs: 60000 });
  if (r.code !== 0) throw new Error("ffmpeg poster failed: " + (r.err || r.out).trim().slice(-300));
  return dst;
}

function concatLine(file) {
  return "file '" + file.replace(/\\/g, "/").replace(/'/g, "'\\''") + "'";
}

/**
 * frames: [{file, t}] with wall-clock ms. Convert to a CFR clip: each frame
 * lasts until the next one (clamped 40..1500 ms) so the clip keeps real time
 * even when hdc screenshots arrive at an uneven rate.
 */
export async function framesToMp4(frames, dst, opts = {}) {
  if (!FFMPEG) locateFfmpeg();
  if (!frames.length) throw new Error("framesToMp4: no frames");
  await ensureDir(path.dirname(dst));
  const listFile = path.join(path.dirname(dst), "frames.concat.txt");
  const lines = [];
  for (let i = 0; i < frames.length; i++) {
    const cur = frames[i];
    const next = frames[i + 1];
    let dur = next ? (next.t - cur.t) / 1000 : 0.2;
    dur = Math.min(1.5, Math.max(0.04, dur));
    lines.push(concatLine(cur.file));
    lines.push("duration " + dur.toFixed(3));
  }
  // concat demuxer needs the last file repeated without a duration.
  lines.push(concatLine(frames[frames.length - 1].file));
  await fsp.writeFile(listFile, lines.join("\n") + "\n", "utf8");
  const fps = opts.fps || 15;
  const width = opts.width || 1080;
  const vf = `scale='min(${width},iw)':-2:flags=lanczos,fps=${fps}`;
  const r = await run(FFMPEG, [
    "-y", "-f", "concat", "-safe", "0", "-i", listFile,
    "-vf", vf, "-fps_mode", "cfr", ...X264, dst,
  ], { timeoutMs: 300000 });
  if (r.code !== 0) throw new Error("ffmpeg frames->mp4 failed: " + (r.err || r.out).trim().slice(-400));
  try {
    await fsp.unlink(listFile);
  } catch (e) {}
  return probe(dst);
}

export function gifBudgetOk(size, limit = 9.5 * 1024 * 1024) {
  if (size <= limit) return { ok: true };
  log.warn(`GIF is ${(size / 1024 / 1024).toFixed(1)} MB (> ${(limit / 1024 / 1024).toFixed(1)} MB)`);
  return { ok: false, size };
}
