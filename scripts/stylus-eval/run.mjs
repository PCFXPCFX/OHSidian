#!/usr/bin/env node
// OHsidian stylus feature evaluation harness.
//
//   node scripts/stylus-eval/run.mjs --mode list
//   node scripts/stylus-eval/run.mjs --mode capture --version v1.4.2
//   node scripts/stylus-eval/run.mjs --mode gate
//   node scripts/stylus-eval/run.mjs --selftest        # no device, pipeline check
//
// capture: guided scenes on the tablet, one screen recording per scene, MP4 +
//          GIF + REPORT.md + PROMO.md under artifacts/stylus-eval/.
// gate:    same scenes without recording, assertions only (pre-release gate).
//
// The harness never installs or reboots anything unless --install is passed.
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import readline from "node:readline/promises";
import { stdin, stdout } from "node:process";
import {
  C, log, out, sleep, ensureDir, readJson, writeJson, writeText, readText,
  stamp, fmtBytes, fmtSec, setQuiet, REPO_ROOT, EVAL_DIR, sceneDirName, localDateTime,
} from "./lib/util.mjs";
import { locateFfmpeg } from "./lib/ffmpeg.mjs";
import {
  connectDevice, loadConfig, saveConfig, listTargets, findHdc, BUNDLE,
} from "./lib/device.mjs";
import { createRecorder, FrameRecorder, FixtureRecorder } from "./lib/capture.mjs";
import { parseHilog, pullConsoleLog, writeHilog, summarize } from "./lib/logs.mjs";
import { evaluateScene, probeCoverage, resultLabel } from "./lib/checks.mjs";
import { writeReports } from "./lib/report.mjs";
import { SCENES, PROMO, scenesFor } from "./manifest.mjs";

const BASELINE = path.join(EVAL_DIR, "baseline.json");
const ARTIFACTS = path.join(REPO_ROOT, "artifacts", "stylus-eval");

function parseArgs(argv) {
  const o = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) {
      o._.push(a);
      continue;
    }
    const eq = a.indexOf("=");
    if (eq > 0) {
      o[a.slice(2, eq)] = a.slice(eq + 1);
      continue;
    }
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith("--")) {
      o[key] = next;
      i++;
    } else {
      o[key] = true;
    }
  }
  return o;
}

function splitList(v) {
  if (!v || v === true) return [];
  return String(v).split(",").map((s) => s.trim()).filter(Boolean);
}

function usage() {
  out(`OHsidian stylus feature harness

  --mode list        list scenes
  --mode capture     guided scenes + recording + MP4/GIF + report (default)
  --mode gate        guided scenes, assertions only (no video)
  --mode doctor      device capability check (hdc/hilog/screenrecord/agent build)
  --selftest         offline pipeline test (ffmpeg fixtures, no device)

  --device <id>      hdc target (default: config.local.json / single target)
  --only a,b         run only these scene ids
  --skip a,b         skip these scene ids
  --version vX.Y.Z   label for the run (default: AppScope versionName)
  --out <dir>        artifact directory
  --countdown <s>    seconds to get ready before each scene (default 3)
  --gap <s>          pause between scenes (default 1.5)
  --capture auto|native|frames
  --fps <n>          frame-capture rate when native recording is unavailable
  --no-video         do not record (gate mode)
  --yes              no Enter prompts (guided countdown only)
  --install <hap>    install this HAP before the run
  --push-fixtures    copy fixtures/vault/ink-eval into the vault (--vault)
  --vault <path>     device vault path for --push-fixtures
  --bless            save this run's metrics as baseline.json
  --strict-drift     treat baseline drift as failure (default: warn)
  --quiet
`);
}

async function ask(question) {
  const rl = readline.createInterface({ input: stdin, output: stdout });
  try {
    return await rl.question(question);
  } finally {
    rl.close();
  }
}

function appVersion() {
  try {
    const s = fs.readFileSync(path.join(REPO_ROOT, "AppScope", "app.json5"), "utf8");
    const m = /"versionName"\s*:\s*"([^"]+)"/.exec(s);
    return m ? "v" + m[1] : "v?";
  } catch (e) {
    return "v?";
  }
}

function statusText(ok, manual) {
  if (!ok) return C.red("FAIL");
  return manual ? C.yellow("PASS*") : C.green("PASS");
}

function printSceneHeader(scene, index) {
  out("");
  out(C.bold(`──────────────────────────────────────────────────────────────`));
  out(C.bold(`${String(index + 1).padStart(2, "0")} · ${scene.title}`) + C.dim(`  [${scene.group}]`));
  out(C.dim(`原版：${scene.stock}`));
  out(C.dim(`我们：${scene.ours}`));
  if (scene.setup && scene.setup.length) {
    out(C.cyan("准备："));
    for (const s of scene.setup) out("  · " + s);
  }
  out(C.cyan("操作：") + scene.action);
  out(C.dim(`窗口：${scene.window}s`));
}

async function sleepUnless(ms, state) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (state.aborted) return;
    await sleep(Math.min(150, end - Date.now()));
  }
}

async function waitForBoot(device, timeoutMs = 30000) {
  const started = Date.now();
  let lastLines = 0;
  while (Date.now() - started < timeoutMs) {
    const r = await device.shell("hilog -x", { timeoutMs: 30000 });
    if (r.code === 0) {
      const parsed = parseHilog(r.out || "");
      lastLines = parsed.lines;
      const boot = parsed.events.find((e) => e.name === "boot");
      if (boot) return { boot, events: parsed.events };
    }
    await sleep(1500);
  }
  return { boot: null, lines: lastLines };
}

async function ensureAgentBuild(device, opts) {
  log.step("preflight: look for the ink probe (agent build)");
  if (opts.install) {
    log.info("installing " + opts.install);
    await device.install(opts.install);
  }
  await device.forceStop();
  await sleep(600);
  await device.shell("hilog -r");
  await sleep(300);
  const launched = await device.launch();
  if (launched.code !== 0) log.warn("aa start returned " + launched.code + ": " + (launched.err || "").slice(0, 200));
  const { boot } = await waitForBoot(device);
  if (!boot) {
    throw new Error(
      "no `probe:boot` in hilog within 30s.\n" +
      "  · 当前安装包大概是 release 构建（探针被剥离）；\n" +
      "  · 重新构建：node scripts/update-obsidian.mjs --repatch --agent && hvigorw assembleHap ...\n" +
      "  · 再安装：node scripts/stylus-eval/run.mjs --mode capture --install <hap>"
    );
  }
  log.ok(`agent build, ink rev ${boot.data.rev}, ${boot.data.inner[0]}x${boot.data.inner[1]} @${boot.data.dpr}x`);
  return boot.data;
}

async function deviceModel(device) {
  const r = await device.shell("param get const.product.model");
  const name = (r.out || "").trim().split(/\r?\n/).pop();
  return name && !/^\[/.test(name) ? name : "";
}

async function startRecording(device, dir, opts) {
  let rec = await createRecorder({
    device,
    dir,
    mode: opts.capture,
    fps: Number(opts.fps) || 3,
    leadMs: 350,
  });
  try {
    await rec.start((opts.window || 12) + 4);
    return rec;
  } catch (e) {
    log.warn(`${rec.kind} capture failed: ${e.message}`);
    if (rec.kind === "native") {
      log.warn("falling back to screenshot frames for this scene");
      rec = new FrameRecorder(device, dir, { fps: Number(opts.fps) || 3 });
      await rec.start();
      return rec;
    }
    throw e;
  }
}

async function runGuided({ args, scenes, device, boot, outDir, version }) {
  const state = { aborted: false };
  const onSigint = async () => {
    if (state.aborted) process.exit(130);
    state.aborted = true;
    log.warn("中断：收尾并生成已有片段...");
  };
  process.on("SIGINT", onSigint);

  const meta = {
    version,
    inkRev: boot.rev,
    mode: args.mode || "capture",
    device: device.serial,
    model: await deviceModel(device),
    capture: device.caps.screenrecord ? "screenrecord" : "snapshot frames",
    hdc: device.hdc,
    startedAt: localDateTime(),
    durationSec: 0,
    host: process.env.COMPUTERNAME || "host",
  };

  log.step("capture capabilities");
  log.info(`screenrecord: ${device.caps.screenrecord ? "yes (" + device.caps.screenrecordTime + ")" : "no"}`);
  log.info(`screenshot: ${device.caps.snapshot || "none"}`);

  const offset = await device.clockOffset();
  log.info(`device clock offset: ${offset} ms`);

  if (device.caps.snapshot) {
    try {
      const test = path.join(outDir, "session", "capability.jpg");
      await device.screenshot("/data/local/tmp/ohs-eval-cap.jpg", test);
      log.ok("screenshot probe ok: " + fmtBytes(fs.statSync(test).size));
      await device.shell("rm -f /data/local/tmp/ohs-eval-cap.jpg");
    } catch (e) {
      log.warn("screenshot probe failed: " + e.message);
    }
  }

  const noVideo = args["no-video"] === true || meta.mode === "gate";
  if (noVideo) meta.capture = "none (gate)";
  const countdown = Number(args.countdown ?? (meta.mode === "gate" ? 2 : 3));
  const gap = Number(args.gap ?? 1.5);

  out("");
  out(C.bold("本次计划："));
  for (let i = 0; i < scenes.length; i++) {
    out(`  ${String(i + 1).padStart(2, "0")} ${scenes[i].title} (${scenes[i].window}s)`);
  }
  out(`  录制：${noVideo ? "关闭" : meta.capture}，倒计时 ${countdown}s，场景间隔 ${gap}s`);
  if (!args.yes) {
    const a = await ask(C.cyan("\n准备好后按 Enter 开始（Ctrl+C 中止）... "));
    if (a === undefined) state.aborted = true;
  }

  await device.shell("hilog -r");
  const results = [];
  const tAll = Date.now();

  for (let i = 0; i < scenes.length; i++) {
    if (state.aborted) break;
    const scene = scenes[i];
    printSceneHeader(scene, i);
    if (!args.yes) {
      await ask(C.cyan("  按 Enter 开始倒计时... "));
    }
    for (let c = countdown; c > 0 && !state.aborted; c--) {
      out(`  ${C.yellow(String(c))}...`);
      await sleepUnless(1000, state);
    }
    if (state.aborted) break;

    const dir = path.join(outDir, "scenes", sceneDirName(i, scene.id));
    await ensureDir(dir);
    let recorder = null;
    let clip = null;
    let captureError = "";
    const w0 = Date.now();
    try {
      if (!noVideo) {
        recorder = await startRecording(device, path.join(dir, "session"), { ...args, capture: args.capture, window: scene.window });
        await sleepUnless(1200, state);
        out(C.green("  ● 开始") + `  ${scene.window}s —— 用笔操作`);
      } else {
        out(C.green("  ● 开始") + `  ${scene.window}s —— 用笔操作（不录屏）`);
      }
      await sleepUnless(scene.window * 1000, state);
      const w1 = Date.now();
      out("  ■ 停");
      if (recorder) {
        await recorder.stop();
        clip = await recorder.clip(w0, w1, dir, { pad: 0.35 });
        log.ok(`clip ${fmtSec(clip.duration)} · mp4 ${fmtBytes(clip.size)} · gif ${fmtBytes(clip.gifSize)}`);
      }
      results.push({ scene, index: i, window: { start: w0, end: w1 }, capture: recorder ? recorder.kind : "none", clip });
    } catch (e) {
      captureError = e.message;
      log.err("scene capture failed: " + e.message);
      results.push({ scene, index: i, window: { start: w0, end: Date.now() }, capture: recorder ? recorder.kind : "none", clip, error: captureError });
    }
    if (i < scenes.length - 1) await sleepUnless(gap * 1000, state);
  }

  log.step("collect device evidence");
  const dump = await device.shell("hilog -x", { timeoutMs: 90000 });
  const hilogText = dump.out || "";
  const sessionDir = path.join(outDir, "session");
  await ensureDir(sessionDir);
  const hilogFile = await writeHilog(sessionDir, hilogText);
  log.info(`hilog: ${fmtBytes(hilogFile.bytes)}`);

  const parsed = parseHilog(hilogText);
  log.info(`probe events: ${parsed.events.length}, native lines: ${parsed.native.length}`);

  const consoleLog = path.join(sessionDir, "console.log");
  const pulled = await pullConsoleLog(device, consoleLog);
  if (pulled.ok) log.ok("renderer console.log pulled (" + fmtBytes(pulled.size) + ")");

  // Scene windows are host time; probe events are device time.
  const events = parsed.events.map((e) => ({ ...e, ts: e.ts - offset }));
  for (const r of results) {
    r.result = evaluateScene(r.scene, events, r.window, { padMs: 1200 });
    if (r.result) {
      // Full window events for post-mortem: counts alone are not enough when
      // a check fails and the next step is to see what the device emitted.
      try {
        await writeJson(
          path.join(outDir, "scenes", sceneDirName(r.index, r.scene.id), "events.json"),
          {
            scene: r.scene.id,
            window: r.window,
            padMs: 1200,
            events: r.result.events.slice(0, 300).map((e) => ({ name: e.name, ts: e.ts, data: e.data })),
          }
        );
      } catch (e) {}
    }
  }
  const coverage = probeCoverage(scenes, events);

  meta.durationSec = (Date.now() - tAll) / 1000;
  const metricsFile = path.join(sessionDir, "metrics.json");
  await writeJson(metricsFile, {
    meta,
    offsetMs: offset,
    scenes: results.map((r) => ({
      id: r.scene.id,
      ok: r.result ? r.result.ok : false,
      manual: r.result ? r.result.manual : false,
      counts: r.result ? r.result.counts : {},
      values: r.result ? r.result.metrics.values : {},
      capture: r.capture,
    })),
    coverage,
    nativeTags: summarize(parsed.native.map((n) => ({ name: n.tag }))),
  });

  const reports = await writeReports({
    outDir,
    meta,
    scenes: results,
    coverage,
    files: { hilog: hilogFile.path, consoleLog: pulled.ok ? consoleLog : "", metrics: metricsFile },
    error: "",
    selftest: false,
  });

  printSummary(results, coverage);
  const gate = await evaluateGate({ args, results, coverage, meta, baselinePath: BASELINE });
  await writeJson(path.join(outDir, "gate.json"), gate);
  out("");
  log.info("report: " + reports.reportPath);
  log.info("promo:  " + reports.promoPath);
  if (args.bless) {
    await writeJson(BASELINE, snapshotBaseline(results, meta));
    log.ok("baseline updated: " + BASELINE);
  }
  return gate;
}

function printSummary(results, coverage) {
  out("");
  out(C.bold("结果："));
  for (const r of results) {
    const res = r.result;
    out(
      `  ${String(r.index + 1).padStart(2, "0")} ${r.scene.title.padEnd(22, " ")} ` +
      `${res ? statusText(res.ok, res.manual) : C.red("ERROR")}  ` +
      C.dim(`${res ? res.events.length : 0} events`)
    );
    if (res && !res.ok) {
      for (const c of res.checks.filter((x) => !x.ok)) out("      " + C.red("✗ ") + `${c.label}: ${c.detail}`);
    }
  }
  if (coverage && coverage.missing.length) {
    out(C.yellow("探针缺失：") + coverage.missing.join(", "));
  }
}

function snapshotBaseline(results, meta) {
  const scenes = {};
  for (const r of results) {
    if (!r.result) continue;
    scenes[r.scene.id] = {
      counts: r.result.counts,
      values: r.result.metrics.values,
    };
  }
  return { version: meta.version, inkRev: meta.inkRev, savedAt: new Date().toISOString(), scenes };
}

async function evaluateGate({ args, results, coverage, meta, baselinePath }) {
  const failures = [];
  const warnings = [];
  for (const r of results) {
    if (!r.result) {
      failures.push(`${r.scene.id}: no evaluation (${r.error || "capture failed"})`);
      continue;
    }
    if (!r.result.ok) failures.push(`${r.scene.id}: failed checks`);
    if (r.error) warnings.push(`${r.scene.id}: ${r.error}`);
  }
  if (coverage.missing.length) failures.push("missing probes: " + coverage.missing.join(", "));

  let drift = [];
  const base = await readJson(baselinePath, null);
  if (base && base.scenes) {
    for (const r of results) {
      const b = base.scenes[r.scene.id];
      if (!b || !r.result) continue;
      for (const [k, v] of Object.entries(b.values || {})) {
        const cur = r.result.metrics.values[k];
        if (typeof cur !== "number" || !v) continue;
        const delta = Math.abs(cur - v) / Math.abs(v);
        if (delta > 0.5) drift.push(`${r.scene.id} ${k}: ${v} -> ${cur} (${(delta * 100).toFixed(0)}%)`);
      }
    }
  } else if (!args.bless) {
    warnings.push("no baseline.json yet: run once with --bless to record reference metrics");
  }
  if (drift.length && args["strict-drift"]) failures.push("baseline drift: " + drift.join("; "));
  else warnings.push(...drift.map((d) => "drift " + d));

  const ok = failures.length === 0;
  out("");
  out(C.bold(ok ? C.green("GATE PASS") : C.red("GATE FAIL")) +
    `  ${results.filter((r) => r.result && r.result.ok).length}/${results.length}`);
  for (const f of failures) out("  " + C.red("✗ ") + f);
  for (const w of warnings) out("  " + C.yellow("! ") + w);
  return { ok, failures, warnings, drift, meta, at: new Date().toISOString() };
}

// ---------------------------------------------------------------------------
// Self test: no tablet. Generates synthetic frames and a fake hilog, then runs
// the real parser -> checks -> clip -> GIF -> report path.
// ---------------------------------------------------------------------------
async function runSelftest(args) {
  locateFfmpeg();
  const outDir = args.out
    ? path.resolve(String(args.out))
    : path.join(ARTIFACTS, "selftest-" + stamp());
  await ensureDir(outDir);
  log.step("selftest: synthetic capture + fake probe stream");
  const rec = new FixtureRecorder(outDir, { seconds: 12, fps: 10 });
  await rec.start();

  const base = rec.t0;
  const raw = [];
  const emit = (name, ts, data) => {
    raw.push(`11-02 21:00:00.000  4242  4242 I A00000/InkUI: probe:${name} ${JSON.stringify({ ...data, _ts: ts })}`);
  };
  emit("boot", base, { rev: "selftest", dpr: 2, inner: [720, 1080], screen: [720, 1080], touch: 10, coarse: true, fakeWorker: 0, enabled: true });
  emit("inkStroke", base + 1200, {
    tool: "pen", space: "md:0", points: 64, pressureMin: 0.12, pressureMax: 0.74,
    widthMin: 1.1, widthMax: 3.2, width: 2.4, ms: 900, straight: false, shape: 0, predict: 0, blend: "",
  });
  emit("inkStroke", base + 2500, {
    tool: "highlighter", space: "pdf:0", points: 42, pressureMin: 0.5, pressureMax: 0.5,
    widthMin: 16, widthMax: 16, width: 16, ms: 700, straight: false, shape: 0, predict: 0, blend: "multiply",
  });
  emit("pdfBlend", base + 2600, { page: 0, mode: "multiply" });
  emit("pdfPayload", base + 3000, { page: 0, strokes: 2, hl: 1, tools: { pen: 1, highlighter: 1 }, originX: 0, originY: 0, pts: 106 });
  emit("pdfWriteEnd", base + 3400, { page: 0, ok: true, ms: 180, bytes: 123456 });
  emit("inkShape", base + 5200, { source: "local", type: 6, points: 4, closed: true });
  emit("inkLasso", base + 6600, { points: 12, selected: 2 });
  emit("inkLassoAction", base + 6900, { action: "move", n: 2 });
  emit("inkErase", base + 7600, { mode: "stroke", changed: true, removed: 1, points: 8, ms: 500 });
  await writeText(path.join(outDir, "session", "hilog.txt"), raw.join("\n") + "\n");

  const parsed = parseHilog(raw.join("\n"));
  log.ok(`parser: ${parsed.events.length} probe events, ${parsed.errors.length} errors`);

  const demoScenes = [
    {
      id: "demo-pen",
      title: "流水线自检 · 笔",
      group: "selftest",
      tool: "pen",
      stock: "selftest",
      ours: "selftest",
      setup: [],
      action: "无需操作，合成数据",
      window: 4,
      probes: ["inkStroke"],
      checks: [
        { kind: "count", event: "inkStroke", where: { tool: "pen" }, min: 1, label: "笔迹事件" },
        { kind: "value", event: "inkStroke", path: "pressureMax", agg: "max", op: ">=", value: 0.5, label: "压力" },
        { kind: "ratio", event: "inkStroke", a: "widthMax", b: "widthMin", agg: "max", op: ">=", value: 1.5, label: "线宽变化" },
      ],
      promo: { title: "自检 · 笔", hook: "selftest", caption: "selftest" },
    },
    {
      id: "demo-pdf",
      title: "流水线自检 · PDF",
      group: "selftest",
      tool: "highlighter",
      stock: "selftest",
      ours: "selftest",
      setup: [],
      action: "无需操作，合成数据",
      window: 5,
      probes: ["pdfPayload", "pdfBlend", "pdfWriteEnd"],
      checks: [
        { kind: "value", event: "pdfBlend", path: "mode", op: "==", value: "multiply", label: "multiply" },
        { kind: "value", event: "pdfPayload", path: "hl", agg: "max", op: ">=", value: 1, label: "含荧光笔" },
        { kind: "value", event: "pdfWriteEnd", path: "ok", agg: "max", op: "==", value: true, label: "写回成功" },
      ],
      promo: { title: "自检 · PDF", hook: "selftest", caption: "selftest" },
    },
  ];

  const results = [];
  for (let i = 0; i < demoScenes.length; i++) {
    const scene = demoScenes[i];
    const start = base + (i === 0 ? 500 : 2000);
    const end = start + scene.window * 1000;
    const dir = path.join(outDir, "scenes", sceneDirName(i, scene.id));
    const result = evaluateScene(scene, parsed.events, { start, end }, { padMs: 200 });
    const clip = await rec.clip(start, end, dir);
    results.push({ scene, index: i, window: { start, end }, capture: "fixture", clip, result });
    log.ok(`${scene.id}: ${resultLabel(result)} · ${fmtSec(clip.duration)} · gif ${fmtBytes(clip.gifSize)}`);
  }

  // Negative control: the harness must notice a failed invariant.
  const negative = evaluateScene(
    { id: "negative-control", checks: [{ kind: "value", event: "inkStroke", path: "pressureMax", agg: "max", op: ">=", value: 3, label: "不可能满足" }] },
    parsed.events,
    { start: base, end: base + 9000 },
    { padMs: 0 }
  );
  const negativeOk = !negative.ok;
  log.ok(`negative control: ${negativeOk ? "fails as expected" : "DID NOT FAIL (bug!)"}`);

  const coverage = probeCoverage(demoScenes, parsed.events);
  try {
    // The fixture frames are only an input for the clip encoder; keep the
    // artifact folder small (a real 12 fps run would add hundreds of MB).
    await fsp.rm(path.join(outDir, "frames"), { recursive: true, force: true });
  } catch (e) {}
  const meta = {
    version: "selftest",
    inkRev: "selftest",
    mode: "selftest",
    device: "",
    capture: "fixture (testsrc2)",
    hdc: "",
    startedAt: localDateTime(),
    durationSec: 1,
    host: process.env.COMPUTERNAME || "host",
  };
  const reports = await writeReports({
    outDir,
    meta,
    scenes: results,
    coverage,
    files: { hilog: path.join(outDir, "session", "hilog.txt"), metrics: "" },
    error: "",
    selftest: true,
  });
  const allPass = results.every((r) => r.result.ok) && coverage.missing.length === 0 && negativeOk;
  out("");
  out(C.bold(allPass ? C.green("SELFTEST PASS") : C.red("SELFTEST FAIL")));
  out("  report: " + reports.reportPath);
  out("  promo:  " + reports.promoPath);
  if (!allPass) process.exitCode = 1;
}

// ---------------------------------------------------------------------------
async function main() {
  const args = parseArgs(process.argv.slice(2));
  setQuiet(!!args.quiet);
  if (args.help || args.h) {
    usage();
    return;
  }
  const mode = String(args.mode || (args.selftest ? "selftest" : "capture"));
  if (mode === "list") {
    out(C.bold("场景："));
    for (let i = 0; i < SCENES.length; i++) {
      const s = SCENES[i];
      out(`  ${String(i + 1).padStart(2, "0")} ${s.id.padEnd(22)} ${s.title}  (${s.window}s, ${s.group})`);
    }
    out(`共 ${SCENES.length} 个场景；promo: ${PROMO.tagline}`);
    return;
  }
  locateFfmpeg();
  const cfg = await loadConfig();
  if (mode === "selftest") {
    await runSelftest(args);
    return;
  }

  const scenes = scenesFor({ only: splitList(args.only), skip: splitList(args.skip) });
  if (!scenes.length) throw new Error("no scenes selected");
  const version = String(args.version || cfg.version || appVersion());
  const outDir = args.out
    ? path.resolve(String(args.out))
    : path.join(ARTIFACTS, `${stamp()}-${version.replace(/[^\w.-]/g, "_")}`);

  const device = await connectDevice({ hdc: args.hdc || cfg.hdc, serial: args.device || cfg.device });
  await saveConfig({ ...cfg, device: device.serial, hdc: device.hdc });
  log.ok(`device ${device.serial}`);
  if (!(await device.isInstalled())) {
    throw new Error(`${BUNDLE} is not installed (or bm dump failed). Install the agent HAP first.`);
  }
  const boot = await ensureAgentBuild(device, args);

  if (mode === "doctor") {
    const dir = args.out ? path.resolve(String(args.out)) : path.join(ARTIFACTS, "doctor-" + stamp());
    await ensureDir(dir);
    await device.probeCapabilities();
    out("");
    out(C.bold("doctor"));
    out(`  device      ${device.serial}`);
    out(`  model       ${await deviceModel(device)}`);
    out(`  agent build ink ${boot.rev} · ${boot.inner[0]}x${boot.inner[1]} @${boot.dpr}x`);
    out(`  screenrecord ${device.caps.screenrecord ? "yes (" + device.caps.screenrecordTime + ")" : "NO (will use frames)"}`);
    out(`  screenshot   ${device.caps.snapshot || "NO (cannot record)"}`);
    out(`  clock offset ${await device.clockOffset()} ms`);
    const h = await device.shell("hilog -x", { timeoutMs: 30000 });
    out(`  hilog dump   ${(h.out || "").split(/\r?\n/).length} lines`);
    if (device.caps.snapshot) {
      const shot = path.join(dir, "screen.jpg");
      try {
        await device.screenshot("/data/local/tmp/ohs-eval-doctor.jpg", shot);
        out(`  screenshot   ok · ${fmtBytes(fs.statSync(shot).size)} -> ${shot}`);
      } catch (e) {
        out(`  screenshot   FAILED: ${e.message}`);
      }
    }
    out("");
    out(`capability file: ${path.join(dir, "doctor.txt")}`);
    await writeText(path.join(dir, "doctor.txt"), JSON.stringify({ ...device.caps, boot, serial: device.serial }, null, 2));
    return;
  }
  if (args["push-fixtures"]) {
    const vault = args.vault || cfg.vault;
    if (!vault) throw new Error("--push-fixtures needs --vault <device vault path> (once; saved to config.local.json)");
    log.step("push fixtures");
    const files = await device.pushTree(path.join(EVAL_DIR, "fixtures", "vault", "ink-eval"), `${vault}/ink-eval`);
    await saveConfig({ ...cfg, device: device.serial, hdc: device.hdc, vault });
    log.ok(`pushed ${files.length} fixture files to ${vault}/ink-eval`);
  }
  await device.probeCapabilities();
  await ensureDir(outDir);
  const gate = await runGuided({ args, scenes, device, boot, outDir, version });
  if (!gate.ok) process.exitCode = 1;
}

main().catch((e) => {
  log.err(e && e.stack ? e.stack : String(e));
  process.exitCode = 1;
});
