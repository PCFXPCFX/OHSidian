# 性能结论（真机）

> 本文只保留**结论与已落地改动**，详细取证、代码锚点与公式在
> [archive/APP-PERF-AUDIT](archive/APP-PERF-AUDIT.md)、
> [archive/PDF-PERF-AUDIT](archive/PDF-PERF-AUDIT.md) 与
> [HEVC-HARDWARE-DECODE-ANALYSIS](HEVC-HARDWARE-DECODE-ANALYSIS.md)。
> 设备：BKY-W10，2800×1840，dpr 2.25，HarmonyOS 7.0.0.111。

## 1. 当前基线

| 场景 | 结果 | 结论 |
|---|---|---|
| 启动完成后空闲 | 179–180 帧 / 3 s，p95 16.8 ms | 稳定 60 fps，无后台持续重绘 |
| PDF 滚动（无墨迹页） | 176 帧 / 3 s，p95 16.8 ms | 与关闭手写层持平 |
| PDF 滚动（修复前） | 118 帧，p95 66.6 ms，33 卡顿帧 | 叠加层无条件分配导致 |
| 抽屉动画 | 110–120 fps | 首次滑出的 233–366 ms 停顿来自文件树构建 |
| 冷启动到可交互 | 4–6 s | 含 Obsidian 与插件加载，属一次性成本 |

## 2. 已修复

- **PDF 墨迹层按需分配**：`pageHasInk(index)` 为假时不挂 base/live canvas；视口 ±1.2 屏
  之外释放；`pagerendered` 只重画该页。39 fps → 60 fps。
- **PDF 单页像素上限**：高 DPI 触摸设备 `capCanvasAreaFactor=0`（一页不超过一屏），
  整窗宽 A4 约 39 MB → 21 MB；PC 保持上游 `200`。
- **pdf.js 真 worker**：`app://` 补 `Content-Type` 后 module worker 生效，不再退回
  主线程 fake worker。
- **PDF 写回不打断阅读**：默认离开 PDF 时按脏页批量写，避免替换打开中的文件导致白屏。

## 3. 已知但不在本版修

- **超长/重内容 Markdown 在编辑模式滚动**约 45 fps（p95 100 ms）。编辑模式没有我们的
  画布，关闭手写层后仍有卡顿，属 Obsidian/CM6 在该引擎上的内容渲染成本；产品层规避是
  拆分长笔记、用阅读模式、减少重插件/嵌入。
- **首次打开左右抽屉**会构建文件树（476 文件/180 文件夹），停顿 233–366 ms；预热收益
  不足且会闪抽屉，已回滚。
- **HEVC/H.265 应用内播放**：引擎 Chromium 132 只走平台解码，OHOS 移植的呈现环有缺陷；
  换引擎、开开关、软解都被证否。可行路线是原生覆盖层/W 方案，详见
  [HEVC 分析](HEVC-HARDWARE-DECODE-ANALYSIS.md)。

## 4. 复测方式

agent 构建内含 rAF/longtask 探针；滚动 PDF 采样默认**关闭**，只在显式
`window.__ohsidianPerfScroll = true` 时运行。复测步骤见
[STYLUS](STYLUS.md) 第 9 节与 [archive/APP-PERF-AUDIT](archive/APP-PERF-AUDIT.md)。
