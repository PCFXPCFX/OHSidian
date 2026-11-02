// Declarative checks over the probe event stream.
//
// Design rule: checks encode *invariants* (pressure reaches the renderer,
// width actually varies, the whole stroke disappeared, the PDF payload carries
// a highlighter, ...), not exact pixel values. Manual strokes differ every run,
// so absolute numbers are recorded as metrics for the report/baseline while
// only invariants decide pass/fail.
import { inWindow, summarize } from "./logs.mjs";

function getPath(obj, p) {
  if (!obj) return undefined;
  let cur = obj;
  for (const part of String(p).split(".")) {
    if (cur == null) return undefined;
    cur = cur[part];
  }
  return cur;
}

function cmp(a, b) {
  if (a === b) return true;
  if (typeof a === "number" || typeof b === "number") return Number(a) === Number(b);
  return String(a) === String(b);
}

function matches(ev, where) {
  if (!where) return true;
  for (const [k, v] of Object.entries(where)) {
    if (!cmp(getPath(ev.data, k), v)) return false;
  }
  return true;
}

function fmt(v) {
  if (typeof v === "number") return Number.isInteger(v) ? String(v) : v.toFixed(3);
  if (v === undefined) return "—";
  return String(v);
}

function roundMetric(v) {
  return typeof v === "number" && Number.isFinite(v) ? Math.round(v * 1000) / 1000 : v;
}

function applyAgg(values, agg) {
  const defined = values.filter((v) => v !== undefined && v !== null);
  if (!defined.length) return undefined;
  const nums = defined.filter((v) => typeof v === "number" && Number.isFinite(v));
  // Booleans/strings (mode === "multiply", ok === true) cannot be summed:
  // report the last defined value instead.
  if (nums.length !== defined.length) return defined[defined.length - 1];
  switch (agg || "max") {
    case "min":
      return Math.min(...nums);
    case "last":
      return nums[nums.length - 1];
    case "sum":
      return nums.reduce((a, b) => a + b, 0);
    case "avg":
      return nums.reduce((a, b) => a + b, 0) / nums.length;
    case "max":
    default:
      return Math.max(...nums);
  }
}

function compare(op, actual, expected) {
  if (actual === undefined) return false;
  switch (op) {
    case ">=": return actual >= expected;
    case "<=": return actual <= expected;
    case ">": return actual > expected;
    case "<": return actual < expected;
    case "==": return cmp(actual, expected);
    case "!=": return !cmp(actual, expected);
    case "between": {
      const [lo, hi] = Array.isArray(expected) ? expected : [expected, expected];
      return actual >= lo && actual <= hi;
    }
    default: return false;
  }
}

export function evaluateScene(scene, allEvents, window, opts = {}) {
  const pad = opts.padMs ?? 1200;
  const events = inWindow(allEvents, window.start, window.end, pad);
  const checks = [];
  const metrics = { counts: summarize(events), values: {} };
  const errors = [];

  const add = (label, ok, detail) => checks.push({ label, ok, detail });

  for (const check of scene.checks || []) {
    try {
      if (check.kind === "count") {
        const list = events.filter((e) => e.name === check.event && matches(e, check.where));
        const n = list.length;
        const ok = (check.min === undefined || n >= check.min) && (check.max === undefined || n <= check.max);
        add(check.label || `${check.event} ×${n}`, ok, `${n}${check.min !== undefined ? ` (min ${check.min})` : ""}${check.max !== undefined ? ` (max ${check.max})` : ""}`);
      } else if (check.kind === "absent") {
        const n = events.filter((e) => e.name === check.event && matches(e, check.where)).length;
        add(check.label || `${check.event} absent`, n === 0, `${n}`);
      } else if (check.kind === "value") {
        const list = events.filter((e) => e.name === check.event && matches(e, check.where));
        const vals = list.map((e) => getPath(e.data, check.path));
        const actual = applyAgg(vals, check.agg);
        const ok = compare(check.op || ">=", actual, check.value);
        const key = `${check.event}.${check.path}.${check.agg || "max"}`;
        if (actual !== undefined) metrics.values[key] = roundMetric(actual);
        add(check.label || `${check.event}.${check.path} ${check.op || ">="} ${fmt(check.value)}`, ok, `actual ${fmt(actual)} over ${list.length} event(s)`);
      } else if (check.kind === "ratio") {
        const list = events.filter((e) => e.name === check.event && matches(e, check.where));
        const vals = list
          .map((e) => {
            const a = Number(getPath(e.data, check.a));
            const b = Number(getPath(e.data, check.b));
            if (!Number.isFinite(a) || !Number.isFinite(b) || b <= 0) return undefined;
            return a / b;
          })
          .filter((v) => v !== undefined);
        const actual = applyAgg(vals, check.agg);
        const ok = compare(check.op || ">=", actual, check.value);
        const key = `${check.event}.${check.a}/${check.b}.${check.agg || "max"}`;
        if (actual !== undefined) metrics.values[key] = Math.round(actual * 1000) / 1000;
        add(check.label || `${check.a}/${check.b} ${check.op || ">="} ${fmt(check.value)}`, ok, `actual ${fmt(actual)} over ${vals.length} event(s)`);
      } else if (check.kind === "probe") {
        const n = events.filter((e) => e.name === check.event).length;
        add(check.label || `probe ${check.event} present`, n > 0, `${n}`);
      } else if (check.kind === "exists") {
        const list = events.filter((e) => e.name === check.event && matches(e, check.where));
        const hits = list.filter((e) => {
          const v = getPath(e.data, check.path);
          return v !== undefined && v !== null && !(typeof v === "number" && !Number.isFinite(v));
        });
        add(check.label || `${check.event}.${check.path} exists`, hits.length > 0, `${hits.length}/${list.length}`);
      } else if (check.kind === "match") {
        const list = events.filter((e) => e.name === check.event && matches(e, check.where));
        const re = new RegExp(check.regex, check.flags || "");
        const hit = list.find((e) => re.test(String(getPath(e.data, check.path || "text") ?? e.raw)));
        add(check.label || `${check.event} ~ /${check.regex}/`, !!hit, hit ? "matched" : `no match in ${list.length} event(s)`);
      } else if (check.kind === "sequence") {
        let cursor = 0;
        let ok = true;
        for (const name of check.events || []) {
          const idx = events.findIndex((e, i) => i >= cursor && e.name === name);
          if (idx < 0) {
            ok = false;
            break;
          }
          cursor = idx + 1;
        }
        add(check.label || `order ${check.events.join(" → ")}`, ok, ok ? "ok" : "missing step");
      } else if (check.kind === "manual") {
        add(check.label || "manual", true, "manual");
      } else {
        add(`unknown check ${check.kind}`, false, "harness bug");
      }
    } catch (e) {
      errors.push(`${check.kind}: ${e.message}`);
      add(check.kind, false, e.message);
    }
  }

  // Required probes: a missing one means the build was made without --agent,
  // or a refactor silently removed the instrumentation.
  for (const name of scene.probes || []) {
    if (events.some((e) => e.name === name)) continue;
    add(`probe ${name} emitted`, false, "missing (agent build?)");
  }

  const ok = errors.length === 0 && checks.every((c) => c.ok);
  return {
    ok,
    manual: !!scene.manual,
    checks,
    errors,
    metrics,
    events,
    counts: metrics.counts,
  };
}

/** Session-level: every probe named by any scene must appear somewhere. */
export function probeCoverage(scenes, events) {
  const seen = new Set(events.map((e) => e.name));
  const missing = [];
  for (const s of scenes) {
    for (const p of s.probes || []) if (!seen.has(p)) missing.push(`${s.id}:${p}`);
  }
  return { missing, seen: [...seen].sort() };
}

export function resultLabel(res) {
  if (!res.ok) return "FAIL";
  return res.manual ? "PASS*" : "PASS";
}
