// Shared helpers for the stylus regression harness. No third-party deps:
// the harness has to run on a maintainer machine that only has Node + ffmpeg.
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

export const HERE = path.dirname(fileURLToPath(import.meta.url));
export const EVAL_DIR = path.resolve(HERE, "..");
export const REPO_ROOT = path.resolve(EVAL_DIR, "..", "..");

const color = process.env.NO_COLOR ? false : process.stdout.isTTY !== false;
const paint = (code) => (s) => (color ? `\u001b[${code}m${s}\u001b[0m` : s);
export const C = {
  dim: paint("2"),
  bold: paint("1"),
  green: paint("32"),
  yellow: paint("33"),
  red: paint("31"),
  cyan: paint("36"),
  magenta: paint("35"),
};

let quiet = false;
export function setQuiet(v) {
  quiet = !!v;
}
export function out(line = "") {
  if (!quiet) process.stdout.write(line + "\n");
}
export const log = {
  step: (s) => out(C.cyan("==> ") + s),
  info: (s) => out("    " + s),
  ok: (s) => out("  " + C.green("OK ") + s),
  warn: (s) => out("  " + C.yellow("!! ") + s),
  err: (s) => process.stderr.write("  " + C.red("XX ") + s + "\n"),
  raw: (s) => out(s),
};

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Spawn a process and collect UTF-8 stdout/stderr. Never throws: callers get
 * a result object so a missing hdc/ffmpeg can be reported with context.
 */
export function run(cmd, args = [], opts = {}) {
  const { cwd, env, timeoutMs = 0, input } = opts;
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, args, {
        cwd,
        env: env || process.env,
        windowsHide: true,
        shell: false,
      });
    } catch (e) {
      resolve({ code: -1, out: "", err: String(e && e.message ? e.message : e), timedOut: false });
      return;
    }
    let outp = "";
    let errp = "";
    let settled = false;
    let timer = 0;
    const finish = (code, timedOut = false) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve({ code, out: outp, err: errp, timedOut });
    };
    child.stdout?.on("data", (d) => (outp += d.toString("utf8")));
    child.stderr?.on("data", (d) => (errp += d.toString("utf8")));
    child.on("error", (e) => finish(-1));
    child.on("close", (code) => finish(typeof code === "number" ? code : -1));
    if (input !== undefined) {
      try {
        child.stdin.end(input);
      } catch (e) {}
    }
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch (e) {}
        finish(-2, true);
      }, timeoutMs);
    }
  });
}

export async function runOk(cmd, args, opts) {
  const r = await run(cmd, args, opts);
  if (r.code !== 0) {
    const tail = (r.err || r.out || "").trim().split(/\r?\n/).slice(-3).join(" | ");
    throw new Error(`${path.basename(cmd)} failed (${r.code}): ${tail || "no output"}`);
  }
  return r;
}

export function which(bin) {
  const exts = process.platform === "win32"
    ? (process.env.PATHEXT || ".EXE;.CMD;.BAT").split(";").filter(Boolean)
    : [""];
  const dirs = (process.env.PATH || "").split(path.delimiter).filter(Boolean);
  for (const d of dirs) {
    for (const ext of exts) {
      const p = path.join(d, bin + ext.toLowerCase());
      if (fs.existsSync(p)) return p;
      const p2 = path.join(d, bin + ext);
      if (fs.existsSync(p2)) return p2;
    }
  }
  return "";
}

export async function ensureDir(p) {
  await fsp.mkdir(p, { recursive: true });
  return p;
}

export async function readJson(p, fallback) {
  try {
    return JSON.parse(await fsp.readFile(p, "utf8"));
  } catch (e) {
    if (fallback !== undefined) return fallback;
    throw e;
  }
}

export async function writeJson(p, obj) {
  await ensureDir(path.dirname(p));
  await fsp.writeFile(p, JSON.stringify(obj, null, 2) + "\n", "utf8");
}

export async function writeText(p, text) {
  await ensureDir(path.dirname(p));
  await fsp.writeFile(p, text, "utf8");
}

export async function readText(p, fallback = "") {
  try {
    return await fsp.readFile(p, "utf8");
  } catch (e) {
    return fallback;
  }
}

export function stamp(d = new Date()) {
  const p = (n, w = 2) => String(n).padStart(w, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

export function localDateTime(d = new Date()) {
  const p = (n, w = 2) => String(n).padStart(w, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

export function fmtBytes(n) {
  const b = Number(n) || 0;
  if (b >= 1024 * 1024) return (b / (1024 * 1024)).toFixed(1) + " MB";
  if (b >= 1024) return (b / 1024).toFixed(0) + " KB";
  return b + " B";
}

export function fmtSec(n) {
  return (Number(n) || 0).toFixed(1) + "s";
}

export function esc(s) {
  return String(s == null ? "" : s).replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

/** Stable, human-readable scene directory name: 01-pen-pressure */
export function sceneDirName(index, id) {
  return `${String(index + 1).padStart(2, "0")}-${id}`;
}

export function fraction(n, d) {
  if (!d) return 0;
  return Math.round((n / d) * 1000) / 1000;
}
