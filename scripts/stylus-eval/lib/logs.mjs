// Ingests the device-side evidence:
//   * hilog lines forwarded by the native InkUI logger (`console.info('InkUI', ...)`)
//   * renderer probe events (`probe:<name> {...}`) with the renderer's `_ts`
//   * native PdfInk / ShapeIpc / PredictIpc / StylusIpc lines for context
//
// Renderer console does not reach hilog by itself; scripts/patches/ohsidian-ink.js
// forwards probe events through window.__ohsidianNativeSend, and Index.ets
// re-prints them as `InkUI probe:<name> <json>`.
import path from "node:path";
import { readText, writeText, ensureDir, fmtBytes, log } from "./util.mjs";

const PROBE_RE = /\bprobe:([A-Za-z0-9_]+)\s+(\{[\s\S]*\})\s*$/;
const TIME_RE = /\b(\d{2})-(\d{2})\s+(\d{2}):(\d{2}):(\d{2})\.(\d{3})\b/;

function hilogTimeToEpoch(line, year) {
  const m = TIME_RE.exec(line);
  if (!m) return 0;
  const mon = Number(m[1]);
  const day = Number(m[2]);
  const h = Number(m[3]);
  const mi = Number(m[4]);
  const s = Number(m[5]);
  const ms = Number(m[6]);
  let t = new Date(year, mon - 1, day, h, mi, s, ms).getTime();
  // A capture spanning New Year: the first digit group is the month, so a
  // December timestamp read in January belongs to the previous year.
  const now = Date.now();
  if (t - now > 36 * 3600 * 1000) t = new Date(year - 1, mon - 1, day, h, mi, s, ms).getTime();
  return t;
}

/**
 * Parse the raw `hilog -x` dump. Returns probe events sorted by time plus
 * native diagnostic lines. Never throws on malformed JSON: keep the raw line
 * so the report can show exactly what the device emitted.
 */
export function parseHilog(text, opts = {}) {
  const year = opts.year || new Date().getFullYear();
  const events = [];
  const native = [];
  const errors = [];
  const lines = String(text || "").split(/\r?\n/);
  for (const line of lines) {
    if (!line) continue;
    const p = PROBE_RE.exec(line);
    if (p) {
      let data = {};
      try {
        data = JSON.parse(p[2]);
      } catch (e) {
        errors.push({ line: line.slice(0, 240), error: e.message });
        continue;
      }
      const ts = Number(data._ts) || hilogTimeToEpoch(line, year) || 0;
      events.push({ name: p[1], data, ts, raw: line });
      continue;
    }
    const m = /\b(PdfInk|ShapeIpc|PredictIpc|StylusIpc|PenProbe|InkUI)\b[:\s]\s*(.*)$/.exec(line);
    if (m) {
      native.push({
        tag: m[1],
        msg: m[2].trim(),
        ts: hilogTimeToEpoch(line, year) || 0,
        raw: line,
      });
    }
  }
  events.sort((a, b) => a.ts - b.ts);
  return { events, native, errors, lines: lines.length };
}

/** Convenience for checks: names only, within [start, end] (ms, device clock). */
export function inWindow(events, start, end, padMs = 0) {
  const a = start - padMs;
  const b = end + padMs;
  return events.filter((e) => e.ts >= a && e.ts <= b);
}

export function summarize(events) {
  const counts = {};
  for (const e of events) counts[e.name] = (counts[e.name] || 0) + 1;
  return counts;
}

export async function pullConsoleLog(device, dest, candidates) {
  const list = candidates && candidates.length
    ? candidates
    : [
        "/storage/Users/currentUser/Documents/OHSidian/console.log",
        "/data/storage/el2/base/files/OHSidian/console.log",
        "/storage/media/100/local/files/Docs/OHSidian/console.log",
      ];
  for (const remote of list) {
    const ok = await device.recvSafe(remote, dest);
    if (ok) return { ok: true, remote, size: (await readText(dest)).length };
  }
  return { ok: false };
}

export async function writeHilog(dir, text) {
  await ensureDir(dir);
  const p = path.join(dir, "hilog.txt");
  await writeText(p, text);
  return { path: p, bytes: Buffer.byteLength(text, "utf8") };
}

export function reportParse(parsed) {
  log.info(`hilog lines: ${parsed.lines}, probe events: ${parsed.events.length}, native lines: ${parsed.native.length}`);
  if (parsed.errors.length) log.warn(`probe JSON errors: ${parsed.errors.length}`);
}
