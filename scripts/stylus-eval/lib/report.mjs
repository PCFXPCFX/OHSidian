// Markdown generation: a technical regression report for the maintainer and a
// ready-to-post promo kit (Coolapk + Bilibili) built from the same clips.
import fs from "node:fs";
import path from "node:path";
import { esc, fmtBytes, fmtSec, writeText, ensureDir, sceneDirName } from "./util.mjs";
import { resultLabel } from "./checks.mjs";
import { PROMO } from "../manifest.mjs";

function pct(n, d) {
  return d ? Math.round((n / d) * 100) + "%" : "0%";
}

function statusIcon(r) {
  if (!r.ok) return "❌";
  return r.manual ? "⚠️" : "✅";
}

function rel(fromDir, file) {
  if (!file) return "";
  return path.relative(fromDir, file).replace(/\\/g, "/");
}

function metricList(result, limit = 6) {
  const entries = Object.entries(result.metrics.values || {}).slice(0, limit);
  if (!entries.length) return "—";
  return entries.map(([k, v]) => `\`${k}=${v}\``).join("，");
}

export function renderReport({ meta, scenes, coverage, files, error, selftest }) {
  const dir = path.dirname(files.report);
  const pass = scenes.filter((s) => s.result && s.result.ok && !s.result.manual).length;
  const fail = scenes.filter((s) => s.result && !s.result.ok && !s.result.manual).length;
  const manual = scenes.filter((s) => s.result && s.result.manual).length;
  const clips = scenes.filter((s) => s.clip).length;
  const lines = [];

  lines.push(`# 手写特性回归报告${selftest ? "（SELFTEST）" : ""}`);
  lines.push("");
  if (selftest) {
    lines.push("> ⚠️ 这是 **流水线自检** 产物：画面是 ffmpeg 的 testsrc，探针也是合成事件。");
    lines.push("> 只用来验证“录制 → 切片 → GIF → 报告”链路，**不能用于宣传**。");
    lines.push("");
  }
  lines.push(`- 版本：**${esc(meta.version)}**  ·  ink **${esc(meta.inkRev)}**`);
  lines.push(`- 时间：${esc(meta.startedAt)}  ·  用时 ${fmtSec(meta.durationSec)}  ·  模式 \`${esc(meta.mode)}\``);
  lines.push(`- 设备：\`${esc(meta.device || "—")}\`  ·  采集：\`${esc(meta.capture || "—")}\`  ·  hdc：\`${esc(meta.hdc || "—")}\``);
  lines.push(`- 结果：**${pass} 通过 / ${fail} 失败 / ${manual} 人工确认**，片段 ${clips}/${scenes.length}`);
  lines.push("");
  lines.push("> `PASS*` = 自动断言通过，但还有一项需要人眼看 GIF 确认（手感/墨点等）。");
  lines.push("");
  if (error) {
    lines.push("## ❌ 运行中断");
    lines.push("");
    lines.push("```");
    lines.push(String(error));
    lines.push("```");
    lines.push("");
  }
  if (coverage && coverage.missing && coverage.missing.length) {
    lines.push("## ⚠️ 探针缺失");
    lines.push("");
    lines.push("下列探针没有在本次会话出现，通常意味着装的是 **release 构建**（没有 `--agent`），");
    lines.push("或者代码改动删掉了探测点：");
    lines.push("");
    for (const m of coverage.missing) lines.push(`- \`${m}\``);
    lines.push("");
  }
  lines.push("## 总览");
  lines.push("");
  lines.push("| # | 场景 | 结果 | 时长 | 片段 | 关键指标 |");
  lines.push("|---|---|---|---|---|---|");
  for (const s of scenes) {
    const r = s.result;
    const clip = s.clip;
    const link = clip ? `[MP4](${rel(dir, clip.mp4)}) · [GIF](${rel(dir, clip.gif)})` : "—";
    lines.push(
      `| ${String(s.index + 1).padStart(2, "0")} | ${esc(s.scene.title)} | ${r ? statusIcon(r) + " " + resultLabel(r) : "—"} | ` +
      `${clip ? fmtSec(clip.duration) : "—"} | ${link} | ${r ? esc(metricList(r, 3)) : "—"} |`
    );
  }
  lines.push("");

  lines.push("## 与原版 Obsidian 的差异（宣传口径）");
  lines.push("");
  lines.push("| 功能 | 原版 Obsidian | 手写魔改版 |");
  lines.push("|---|---|---|");
  for (const s of scenes) {
    lines.push(`| ${esc(s.scene.title)} | ${esc(s.scene.stock)} | ${esc(s.scene.ours)} |`);
  }
  lines.push("");

  lines.push("## 逐场景");
  lines.push("");
  for (const s of scenes) {
    const sc = s.scene;
    const r = s.result;
    lines.push(`### ${String(s.index + 1).padStart(2, "0")} · ${sc.title} ${r ? statusIcon(r) : ""}`);
    lines.push("");
    lines.push(`- **原版 Obsidian**：${sc.stock}`);
    lines.push(`- **手写魔改版**：${sc.ours}`);
    if (sc.setup && sc.setup.length) {
      lines.push("- **准备**：");
      for (const step of sc.setup) lines.push(`  - ${step}`);
    }
    lines.push(`- **操作**：${sc.action}`);
    lines.push(`- **窗口**：${fmtSec((s.window.end - s.window.start) / 1000)} · 探针事件 ${r ? r.events.length : 0} 条`);
    lines.push("");
    if (r) {
      lines.push("| 检查 | 结果 | 实测 |");
      lines.push("|---|---|---|");
      for (const c of r.checks) {
        lines.push(`| ${esc(c.label)} | ${c.ok ? "PASS" : "FAIL"} | ${esc(c.detail)} |`);
      }
      lines.push("");
      if (Object.keys(r.metrics.values || {}).length) {
        lines.push("指标：");
        lines.push("");
        for (const [k, v] of Object.entries(r.metrics.values)) lines.push(`- \`${k}\` = ${v}`);
        lines.push("");
      }
      if (r.errors && r.errors.length) {
        lines.push("检查执行错误：");
        for (const e of r.errors) lines.push(`- \`${esc(e)}\``);
        lines.push("");
      }
    }
    if (s.clip) {
      const c = s.clip;
      lines.push(`![${esc(sc.title)}](${rel(dir, c.gif)})`);
      lines.push("");
      lines.push(
        `[MP4](${rel(dir, c.mp4)}) · ${fmtSec(c.duration)} · ${c.width}×${c.height} · ` +
        `${fmtBytes(c.size)}；GIF ${fmtBytes(c.gifSize)}`
      );
      lines.push("");
    } else {
      lines.push("> 本场景没有片段（`--no-video` 或录制失败）。");
      lines.push("");
    }
    const sceneDir = path.join(dir, "scenes", sceneDirName(s.index, sc.id));
    const evFile = path.join(sceneDir, "events.json");
    if (fs.existsSync(evFile)) {
      lines.push(`事件明细：\`${rel(dir, evFile)}\``);
      lines.push("");
    }
  }

  lines.push("## 证据文件");
  lines.push("");
  if (files.hilog) lines.push(`- hilog：\`${rel(dir, files.hilog)}\`（${fmtBytes(fs.statSync(files.hilog).size)}）`);
  if (files.consoleLog) lines.push(`- 渲染层 console：\`${rel(dir, files.consoleLog)}\`（已开启“运行日志捕获”时才有）`);
  if (files.metrics) lines.push(`- 指标 JSON：\`${rel(dir, files.metrics)}\``);
  if (coverage && coverage.seen) lines.push(`- 本次出现的探针：${coverage.seen.map((s) => "`" + s + "`").join("，")}`);
  lines.push("");
  lines.push("## 复现");
  lines.push("");
  lines.push("```powershell");
  lines.push("# 1) 生成带探针的安装包");
  lines.push("node scripts/update-obsidian.mjs --repatch --agent");
  lines.push("hvigorw assembleHap --mode module -p product=default -p buildMode=debug --no-daemon");
  lines.push("# 2) 安装并跑回归（按屏幕提示用笔操作）");
  lines.push("node scripts/stylus-eval/run.mjs --mode capture --version vX.Y.Z");
  lines.push("# 3) 发布前只跑断言，不录屏");
  lines.push("node scripts/stylus-eval/run.mjs --mode gate");
  lines.push("```");
  lines.push("");
  return lines.join("\n");
}

export function renderPromo({ meta, scenes }) {
  const dir = path.dirname(meta.promoPath || path.join("PROMO.md"));
  const lines = [];
  const withClips = scenes.filter((s) => s.clip);
  lines.push("# OHSidian 手写特性 · 发布素材包");
  lines.push("");
  lines.push(`> ${PROMO.tagline}`);
  lines.push("");
  lines.push(`版本 **${esc(meta.version)}** · ink **${esc(meta.inkRev)}** · 设备 \`${esc(meta.device || "—")}\``);
  lines.push("");
  lines.push(`项目：${PROMO.repo}`);
  lines.push("");
  lines.push("## 素材清单");
  lines.push("");
  lines.push("| # | 功能 | 一句话 | 时长 | 尺寸 | MP4 | GIF |");
  lines.push("|---|---|---|---|---|---|---|");
  for (const s of scenes) {
    if (!s.clip) continue;
    const c = s.clip;
    lines.push(
      `| ${String(s.index + 1).padStart(2, "0")} | ${esc(s.scene.promo.title)} | ${esc(s.scene.promo.hook)} | ` +
      `${fmtSec(c.duration)} | ${c.width}×${c.height} | [打开](${rel(dir, c.mp4)}) ${fmtBytes(c.size)} | ` +
      `[打开](${rel(dir, c.gif)}) ${fmtBytes(c.gifSize)} |`
    );
  }
  lines.push("");
  lines.push("## 预览");
  lines.push("");
  for (const s of withClips) {
    lines.push(`### ${s.scene.promo.title}`);
    lines.push("");
    lines.push(`![${esc(s.scene.promo.title)}](${rel(dir, s.clip.gif)})`);
    lines.push("");
    lines.push(`*${esc(s.scene.promo.caption)}*`);
    lines.push("");
  }
  lines.push("## 酷安文案");
  lines.push("");
  lines.push(`**标题**：${PROMO.coolapk.title}`);
  lines.push("");
  lines.push("```text");
  lines.push(PROMO.coolapk.body);
  lines.push("```");
  lines.push("");
  lines.push(`**话题**：${PROMO.coolapk.tags.map((t) => "#" + t).join(" ")}`);
  lines.push("");
  lines.push("## B 站文案");
  lines.push("");
  lines.push(`**标题**：${PROMO.bilibili.title}`);
  lines.push("");
  lines.push("**简介**：");
  lines.push("");
  lines.push("```text");
  lines.push(PROMO.bilibili.desc);
  lines.push("```");
  lines.push("");
  lines.push(`**标签**：${PROMO.bilibili.tags.join("、")}`);
  lines.push("");
  lines.push("## 发布建议");
  lines.push("");
  lines.push("1. B 站投 1080p：直接上传 `clip.mp4`（已统一 H.264 / yuv420p / faststart，无需再转码）。");
  lines.push("2. 酷安用 GIF 做正文预览，单张控制在 10 MB 以内（脚本已按 720px/12fps 压过）。");
  lines.push("3. 每个 GIF 配一句 `一句话` 文案，按“笔 → PDF → 橡皮 → 一笔成形 → 套索 → 实验”顺序排。");
  lines.push("4. 录屏里出现真实笔记/文件名时，先确认没有隐私信息再发布。");
  lines.push("");
  return lines.join("\n");
}

export async function writeReports({ outDir, meta, scenes, coverage, files, error, selftest }) {
  await ensureDir(outDir);
  const reportPath = path.join(outDir, "REPORT.md");
  const promoPath = path.join(outDir, "PROMO.md");
  files.report = reportPath;
  const promoMeta = { ...meta, promoPath };
  await writeText(reportPath, renderReport({ meta, scenes, coverage, files, error, selftest }));
  await writeText(promoPath, renderPromo({ meta: promoMeta, scenes }));
  return { reportPath, promoPath };
}
