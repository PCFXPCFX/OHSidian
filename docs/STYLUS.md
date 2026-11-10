# 手写笔（华为 M-Pencil）：方案、评测与验收

> 状态：**v2.0.0 主线功能**，内核 `ink rev 60`。手写笔模式默认关闭，在
> **设置 → 手写笔 → 手写笔模式** 开启。
>
> 本文合并了原《手写笔适配方案》与《手写特性回归评测》：前半部分讲实现，
> 后半部分讲发版前如何验证与录制宣传素材。逐轮实现记录见
> [CHANGES-2026-10](CHANGES-2026-10.md) 第 189 轮以后。

## 1. 目标与边界

目标：在 OHsidian（Obsidian 运行于 HarmonyOS Electron 兼容层）中提供可用的
M-Pencil 书写体验：

- 压力/倾斜墨迹、笔杆双击/轻捏；
- 笔记、PDF、内嵌 PDF、Canvas 标注；
- PDF 可写回真实注释，首次写入前备份原文件；
- 手掌/手指与笔分离，笔不误触 Obsidian 自身控件；
- 平板优先：低延迟、低功耗、无持续后台重绘。

非目标：不改 Obsidian 内核、不重写编辑器、不做云同步、不做 P3 原生低延迟覆盖层。

## 2. 分层与数据流

```text
Pen Kit / ArkUI Touch
        │
        ▼
Index.ets（ArkTS 输入仲裁、压力采样、PDF IPC）
        │  newline JSON over 127.0.0.1
        ▼
ohsidian-ink.js（渲染层：事件归一化、墨迹、UI）
        │
        ▼
InkDoc 侧车 <vault>/.obsidian/ohsidian-ink/docs/<key>.json
        │
        ├─ Markdown 分块 canvas
        ├─ PDF 页 canvas / pdfdom overlay
        ├─ Canvas 分块 canvas
        └─ PdfInkWriter（PDF Kit，直接写回）
```

- **ArkTS 是唯一可靠的笔数据源**（压力、tilt、Pen Kit 手势）；渲染层只消费。
- **IPC** 与视频覆盖层共用 loopback 端口，按 `action/event` 区分；不支持时只保留叠加层。
- **墨迹侧车是编辑源**；PDF 注释是可移植副本，不是编辑源。

## 3. 输入仲裁（关键规则）

### 3.1 ArkTS 层

- **Pen**：永远 `HitTestMode.Default`，进入 XComponent 正常书写。
- **MOUSE / TOUCHPAD**：放行。
- **手指/手掌/Unknown**：
  - `penGuardUntil`（笔悬停/书写及之后 1.2s）内 `Block`；
  - 否则允许手指点按/滚动，但接触面积超过 `palmLimit`（笔模式 34vp / 普通 44vp）时 `Block`。
- 笔悬停（`onHover`, sourceTool=Pen）会提前延长 guard。
- `taskpool` 写 PDF，避免 PDFKit 同步 load/save 阻塞 UI。

### 3.2 渲染层

- **笔落在 ink surface**：画。
- **笔落在工具条/菜单/清除面板**：允许点按、长按、拖滑块。
- **笔落在 Obsidian 其他 UI 或空白/边距**：`pointerdown` 即拦截，不传给 Obsidian。
- **笔的兼容 touch/mouse 事件**：笔活动窗口内吞掉；1.2s 无笔后恢复给手。
- 笔从 UI 起笔滑动 >5px：拦截并抑制 click。
- 双指/多指不用于笔手势；ArkUI PanGesture、PinchGesture 已移除。

## 4. 墨迹数据模型

每个目标文件一个 sidecar：

```json
{
  "v": 1,
  "target": "笔记/文档.md",
  "strokes": [],
  "layout": {"hash": "...", "width": 0, "blocks": 0},
  "orphans": []
}
```

Stroke：

```js
{
  id, space, tool, color, auto, width, px?, opacity,
  device, pts: [[x,y,pressure,tiltX,tiltY,tMs]], bbox, baked?, written?
}
```

坐标空间：

| kind | space | 坐标 |
|---|---|---|
| markdown | `md:abs` | sizer 内容坐标（CSS px） |
| PDF 真实 viewer | `pdf:<page>` | PDF user space points |
| PDF DOM 回退 | `pdfdom:<file>:<page>` | 页面归一化 0–1 |
| 内嵌 PDF | `embed:<src>:<page>` | 页面归一化 0–1 |
| Canvas | `canvas` | canvas 内容坐标 |

## 5. 各表面实现

### 5.1 Markdown

- 已提交墨迹放在 `.markdown-preview-sizer` 内的 **700px 分块 canvas**（只分配含墨迹块），随文字原生滚动。
- 当前笔画用 `.markdown-reading-view` 上的 viewport live canvas。
- 只支持阅读视图；Live Preview 下落笔会自动切阅读视图。
- 宿主被 Obsidian 清空时 `ensureAttached()` 会重新挂回；`rebind()` 复用同一 surface/doc/undo。

### 5.2 PDF

- **真实 viewer**：Obsidian 1.13.7 的链是 `view.viewer(T1) → .child(x1) → .pdfViewer(g) → .pdfViewer(pdf.js)`；`pdfViewerChain` 逐层跟随，`pdfJsViewerOf` 取第一个带 `getPageView` 的对象。页码用 `pageView.viewport` 转换 PDF points。
- **真实 PDF 不再有 pdfdom 回退**：首次取 viewer 失败时 350ms 重试；pdfdom 只用于笔记内嵌 PDF。
- **打开时先恢复页码**：`pagesinit` 读 `pdfjs.history`（按 document fingerprint）在首帧渲染前跳到上次页；距当前页 >2 页的 `pagerender` 调 `cancelRendering`，避免重的封面页阻塞渲染队列。
- **live/base 双 canvas**：`ohsidian-ink-pdf-live` 只画当前笔画，`ohsidian-ink-pdf` 只画已提交笔画。
- **viewport 几何复用**：按 width/height/scale 比较复用 entry，避免重建 canvas 留下 ghost 笔迹。
- 缩放用 `offsetWidth/offsetHeight`（布局尺寸），避免 transform 二次缩放。
- 翻页时用屏幕中心 `elementFromPoint` 定位可见 `.page`，按需创建并激活。
- **只在手写笔模式开启时挂载**；关闭后不保留任何叠层 canvas。
- 叠层只给视口 ±1.2 屏内的页分配，离开即释放；`dpr` 封顶 2。
- **无墨迹页不分配 canvas**：`ensurePage` 先查 `pageHasInk(index)`，落笔时 `surfaceAt(force=true)` 才创建。真机同一段 PDF：有叠加层 39 fps（p95 66.6 ms）→ 按需分配后 60 fps（p95 16.8 ms，0 叠加层）。
- `pagerendered` 只重画事件对应的单页；页表只保留仍在 DOM 的页。
- pdf.js 自己的页 canvas 只在高 DPI 触摸设备（`dpr≥2` 且 `pointer:coarse`/触摸点）限制在一屏像素内：整窗宽 A4 约 39 MB → 21 MB；PC 保持上游 `200`。
- `app://` 响应补 `Content-Type`，让 pdf.js 的 **module worker** 真正跑在 worker 线程。
- 写回默认在**离开 PDF 时**，按“脏页”批量处理；注释默认 **/PolyLine**，可切 `/Ink`。

### 5.3 内嵌 PDF

- 笔记中的 `.pdf-embed .page` 建立页内归一化 surface。
- 墨迹写在**笔记 sidecar**（`embed:<src>:<page>`），不写 PDF 本体。
- 页尺寸 <10px 不建层；页面重渲染后旧 surface 自动移除。

### 5.4 Canvas

- 512px 分块 canvas 挂在 `.canvas` 的 transformed layer；live 在 `.canvas-wrapper`。
- 映射用 `.canvas` rect + scale；页面缩放/平移后刷新。

## 6. PDF 写回

### 6.1 触发

- 设置“直接写入 PDF（自动备份）”默认开；
- 写回时机默认“离开 PDF 时”；可选“停笔 3 秒”（会重载）或“仅手动”；
- 擦除/撤销/重做/清空会把对应页标记为脏页；
- 手动命令：`OHSidian 手写: 写入 PDF（真实注释）`。

### 6.2 流程

1. 复制原 PDF 到 cache；
2. PDF Kit 载入；
3. replace 模式删除本页 `ohsidian-` 注释，以及 `title/content/subject` 以 `ohsidian-ink` 开头的旧注释；
4. 按当前 sidecar 重加本页所有笔画（含 `baked`）；默认 `POLYLINE`，可切 `INK`；
5. 保存到 cache；重新 `loadDocument` 校验页数（坏文件不替换）；
6. 校验 `%PDF-`；
7. 首次写入前创建原始备份；
8. 复制到 PDF 同目录 `.hso-new-*.pdf`，同文件系统 swap；平台拒绝覆盖时先 `src → .hso-old-*`，再换入，失败恢复旧文件。

**坐标约定**：PDF.js `convertToPdfPoint` 返回的是**含 CropBox 原点的绝对 user space**；
PDF Kit 的 `PdfPoint` 也是页面用户坐标。不要再减 `viewport.viewBox[0..1]`——旧实现
重复相减，导致整页注释左移 84 pt、下移 116 pt（第 208 轮修复）。

真机实测（22.5 MB / 79 页）：单页 6 笔（1866 点）184 ms；离开时两页批量
233 ms + 127 ms，均 `ok=true`；写后注释计数与笔画数一致。

### 6.3 备份与恢复

- 主备份：`<vault>/.obsidian/ohsidian-ink/backups/<name>-<pathHash>.orig.pdf`
- fallback：`<file>.pdf.ohsidian-orig.pdf`
- 恢复：设置 → 手写笔 → PDF → “恢复原始 PDF”，或命令 `恢复 PDF 原始备份`。
- 首次备份不会被后续写入覆盖。

### 6.4 已知限制

- 加密/超大/损坏 PDF 可能失败；失败不替换原文件。
- pdfdom 归一化写入依赖 `getWidth/getHeight`；旋转/裁切页可能偏移。
- PDF 被其他进程锁定时最后 swap 仍可能失败；错误会带备份路径。
- Obsidian pdf.js 对 `/Ink`/`/PolyLine` 使用 `stroke="transparent"`，叠加层默认保留。
- `/PolyLine` 在部分阅读器显示为折线；需要笔锋可切 `/Ink`，但部分 PDF Kit 版本会填充。

## 7. 性能与功耗

1. **增量 live**：`drawLiveIncremental()` 只画新增段；高亮笔因 alpha 重叠仍整条重绘。
2. **提交只追加**：抬笔只把当前笔追加到 base canvas；undo/redo/erase/主题仍全量。
3. **PDF 原生滚动**：pdfdom canvas 在滚动内容内，滚动零 JS 重定位。
4. **坐标缓存**：`beginStroke()` 缓存 sizer/page/canvas rect。
5. **橡皮预览**：pointermove 只在 base canvas 上用 `destination-out` 挖圆；pointerup 一次性应用路径（bbox 预筛、浅拷贝）。
6. **撤销快照引用**：`snapshotSpace()` 存 stroke 引用，不再 JSON 深拷贝整页。
7. **保存节流**：`saveSoon` 900ms 合并；关闭/失焦 flush。
8. **光标节流**：hover ring 约 60fps；橡皮圆环与擦除半径一致。
9. **UI 效果默认省电**：毛玻璃默认关，减少动画默认开。
10. **PDF 叠层按需**：关闭时 0 张；开启时只给视口 ±1.2 屏分配。
11. **单页重绘**：`pagerendered` 只清/画该页。
12. **页表清理**：`prunePages()` 删除 detached 条目。
13. **内核像素上限（仅高 DPI 触摸设备）**：`capCanvasAreaFactor` 在 `dpr≥2` 且粗指针时取 `0`，否则保持上游 `200`。
14. **关闭即停**：`inkEnabled=false` 时同时停止 ArkTS 的 `penSamplesOn` 采样流。
15. **worker 真线程**：`app://` 补 MIME 后，`pdf.worker.min.mjs` 以 module worker 加载。
16. **写回不打断阅读**：默认 `leave` 时机；`idle` 可选（会重载）。
17. **脏页批量写回**：按 doc 中 `!written` 的 space 与擦除/撤销/清空标记逐页写。
18. **写回前校验**：PDFKit 保存后重新 load 并检查页数，坏文件不替换。

## 8. 工具、设置与诊断

- 工具条：指针 / 笔 / 高亮 / 橡皮 / 撤销 / 重做 / 5 色调色盘 / 自定义色 / 粗细 / 更多。
- 笔尖：第一下展开，第二下收起。
- 笔杆双击：默认只唤醒工具条；可选笔↔橡皮、撤销、调色盘。
- 笔杆轻捏：默认打开工具条/调色盘。
- 橡皮：圆环显示擦除范围；长按或双击橡皮按钮打开“滑动清除本页”面板。
- 调色盘：设置 → 手写笔 → 颜色 → 工具条调色盘，配置 5 个常用颜色（`inkPalette`）。
- 界面效果：毛玻璃（默认关）与减少动画（默认开）。

设置项：

| 分组 | 项 |
|---|---|
| 功能 | 手写笔模式（默认关）、工具条显示/位置、安静反馈、笔尖光标、界面效果 |
| 输入与手势 | 掌托过滤、允许手指绘制、橡皮半径、笔杆双击、笔杆轻捏、边缘手势 |
| 压力 | 来源（自动/强制）、预设、死区、gamma、曲线图 |
| 颜色 | 跟随主题、自选墨色、高亮色、工具条调色盘 |
| PDF 与诊断 | 写入后叠加层、直接写入 PDF、写回时机、注释样式、恢复原始 PDF、诊断 |

命令：手写模式开/关、启用手写、笔/高亮/橡皮/指针、撤销/重做/清空本页、
写入 PDF、恢复 PDF 原始备份、导出本页 SVG、按主题重新着色、显示/隐藏工具条、手写笔诊断。

HiLog 关键标签：

```text
InkUI boot / surface / commit / gesture / nativeTool / setTool
InkUI penCompatBlocked / pdfdomOverlay / surfaceWaitTimeout
PdfInk write/restore
```

诊断面板的 `PDF叠层` 行给出叠层张数、页表页数、总字节、overlay `dpr`；关闭手写笔模式后应为 **0 张**。`PDF写回` 行给出时机/样式/次数/上次写回时间/fake worker 计数。

## 9. 回归评测（stylus-eval）

发布前跑一遍，确认这次改动没有破坏已经上线的手写功能；同时把每个功能录成
MP4 + GIF，直接用于酷安/B 站宣传。

- 脚本：`scripts/stylus-eval/`
- 场景定义：`scripts/stylus-eval/manifest.mjs`
- 产物：`artifacts/stylus-eval/<时间>-<版本>/`（已 gitignore）
- 不需要设备也能验证链路：`node scripts/stylus-eval/run.mjs --selftest`

### 9.1 术语

| 叫法 | 指什么 |
|---|---|
| **原版 Obsidian** | 官方 Obsidian（桌面/移动端），没有鸿蒙平板适配，也没有手写层 |
| **平板适配版** | 本项目早期只做触摸/窗口/避让的提交（`initial` … `window frame update`） |
| **手写魔改版** | 当前版本：在平板适配之上加了 M-Pencil、PDF 写回、一笔成形等（v2.0.0 / ink 60） |

报告里的“原版”列统一指**原版 Obsidian**；仓库里的 commit 都是本项目的平板改动，
不再用某个旧 tag 冒充原版。

### 9.2 三层验证

| 层 | 手段 | 能发现什么 |
|---|---|---|
| 行为 | 按提示用笔操作，逐场景录屏 | 手感、闪烁、错位、颜色 |
| 探针 | 渲染层 `probeHook` → ArkTS `InkUI` → hilog | 压力/线宽/事件计数/写回结果等硬指标 |
| 断言 | `manifest.mjs` 的不变量 + `baseline.json` 漂移 | 增量代码把旧功能改坏 |

人工引导是刻意的：一笔成形、点预测、压感橡皮依赖 HarmonyOS 的笔事件，脚本无法
伪造真实压力与 Pen Kit 回调。脚本负责计时、录屏、抓日志、判卷、切片。

### 9.3 探针

渲染层 console 不进 hilog，所以探针走
`window.__ohsidianNativeSend({action:"inkLog"})` → `Index.ets` → `console.info('InkUI', …)`。
每个事件带 `_ts`（渲染层 `Date.now()`），用于把事件映射到场景时间窗。

| 事件 | 关键字段 | 证明什么 |
|---|---|---|
| `boot` | `rev`、`inner`、`dpr` | 装的是 **agent 构建** |
| `inkStroke` | `tool`、`points`、`pressureMin/Max`、`widthMin/Max`、`ms`、`straight`、`shape`、`predict`、`blend` | 压感、线宽、拉直、形状、预测、PDF 混合模式 |
| `inkErase` | `mode`、`removed`、`changed`、`ms` | 局部/整笔/压感橡皮 |
| `inkShape` | `source`、`type`、`points`、`closed` | 一笔成形与本地兜底 |
| `inkShapeGuess` | `type` | 抬笔时的本地形状判断 |
| `inkLasso` | `points`、`selected` | 套索圈选 |
| `inkLassoAction` | `action`、`n` | 套索移动/复制/删除 |
| `inkPredict` | `firstMs` | 点预测真正被使用 |
| `inkPref` | `key`、`value` | 设置项切换 |
| `pdfBlend` / `pdfEmbedBlend` | `mode` | 浅色 PDF 页使用 `multiply` |
| `pdfPayload` | `strokes`、`hl`、`tools`、`originX/Y` | 写回载荷含荧光笔、CropBox 原点 |
| `pdfWriteEnd` | `ok`、`ms`、`bytes` | PDF 写回成功 |

release 构建由 `scripts/update-obsidian.mjs` 的 `stripDevProbeCalls()` 剥掉
`probeHook(...)` 调用与探针实现，`verify-release.cjs` 拦截残留符号。

### 9.4 18 个场景

| # | id | 功能 | 窗口 |
|---|---|---|---|
| 01 | `pen-pressure` | 压感笔迹 | 12s |
| 02 | `hold-straight` | 长按拉直 | 10s |
| 03 | `highlighter-pdf` | PDF 荧光笔（黑字不被冲淡） | 14s |
| 04 | `pdf-writeback` | PDF 标注写回与坐标 | 16s |
| 05 | `eraser-partial` | 局部橡皮 | 10s |
| 06 | `eraser-stroke` | 整笔橡皮 | 12s |
| 07 | `pressure-eraser` | 压感橡皮 | 14s |
| 08 | `shape-square` | 一笔成形：方形 | 10s |
| 09 | `shape-circle` | 一笔成形：圆形 | 10s |
| 10 | `lasso-move` | 套索选择/移动 | 14s |
| 11 | `lasso-copy-delete` | 套索复制/删除 | 22s |
| 12 | `predict` | 点预测（实验） | 12s |
| 13 | `markdown-highlighter` | Markdown 荧光笔 | 12s |
| 14 | `undo-redo` | 手写撤销 / 重做 | 16s |
| 15 | `pdf-embed` | Markdown 内嵌 PDF 手写 | 16s |
| 16 | `canvas-ink` | Canvas 白板手写 | 12s |
| 17 | `eraser-hl-only` | 只擦荧光笔 | 14s |
| 18 | `palm-rejection` | 掌托防误触 | 12s |

新增功能时**必须同时加场景**，否则 gate 不会保护它。`palm-rejection` 没有可自动
断言的探针，只做人工目视；其余场景的断言都参与 gate。

### 9.5 跑法

```powershell
# 1) 打 agent 包（只用于演示/评测，绝不发布）
node scripts/build-agent.mjs
# 产物：artifacts/agent/OHSidian-agent-<版本>-<时间>.hap

# 2) 首次联机
node scripts/stylus-eval/run.mjs --mode doctor
node scripts/stylus-eval/run.mjs --mode capture --version v2.0.0 `
  --install artifacts/agent/OHSidian-agent-2.0.0-<时间>.hap

# 3) 正式录制（PC 终端逐场景提示，按 Enter 后 3 秒倒计时）
node scripts/stylus-eval/run.mjs --mode capture --version v2.0.0

# 4) 发版门禁（只跑断言，失败退出码 1）
node scripts/stylus-eval/run.mjs --mode gate

# 5) 不联机自检
node scripts/stylus-eval/run.mjs --selftest
```

`--vault` 只需给一次，会写进 `scripts/stylus-eval/config.local.json`（已 gitignore）。
素材在 `scripts/stylus-eval/fixtures/vault/ink-eval/`：`01-pen.md`、`02-pdf.pdf`、
`03-embed.md`、`04-canvas.canvas`。评测开始前脚本会 `aa force-stop` 再启动，
确保读到本次构建的探针；没保存的笔记请先保存。

`--mode doctor` 检查 `probe:boot`、录屏/截图能力、hilog 与设备时钟偏差，结果写到
`artifacts/stylus-eval/doctor-<时间>/doctor.txt`。

### 9.6 产物

```text
artifacts/stylus-eval/20261103-193000-v2.0.0/
  REPORT.md                 # 技术报告：逐场景断言、指标、片段、复现命令
  PROMO.md                  # 宣传素材包：清单 + 酷安/B站文案
  gate.json                 # 门禁结果
  session/
    hilog.txt               # 本次会话的原始 hilog
    metrics.json            # 每场景 counts/values，供 baseline 使用
  scenes/
    01-pen-pressure/
      clip.mp4              # 1080p H.264 / yuv420p / faststart
      clip.gif              # 720px / 12fps，酷安正文预览（<10MB）
      poster.png
```

录制策略：优先 `screenrecord`；本机没有该命令时自动降级为 `snapshot_display`
截图帧（约 2–5 fps）。GIF 超过 9.5MB 自动降到 540px / 10fps 再编一次。

### 9.7 判卷规则与限制

- 断言只写不变量：压力必须到达渲染层、线宽比 >1.35、整笔橡皮 `removed>=1`、
  PDF 载荷 `hl>=1` 且写回 `ok=true` 等；绝对值只进报告。
- 缺探针 = 失败：说明装错构建，或者改动把探针删了。
- `manual` 检查只标 ⚠️，不参与 gate；需要人看 GIF。
- 基线只做漂移提示；需要严格时加 `--strict-drift`。
- 设备与 PC 时钟只对到秒级，场景窗两侧各留 1.2s 余量。
- 首帧/末帧可能包含终端倒计时，切片时各留 0.35s。
- 录屏会出现真实笔记内容，发布前自行检查隐私。

## 10. 发布前验收清单

代码与门禁：

1. `node scripts/build-agent.mjs` 成功，`artifacts/agent/` 有包；
2. 设备安装 agent 包，`--mode doctor` 全绿；
3. `--mode gate` 全绿（或明确记录 `manual` 项的人工结论）；
4. release asar 已恢复，`node scripts/verify-release.cjs` 与
   `node scripts/verify-asar.cjs` 都通过；
5. release HAP 的 `module.json` 为 `versionName=2.0.0`、`versionCode=2000000`、
   `minAPIVersion=60002022`，且 asar 内无 `probeHook`。

真机手写（逐项）：

1. 开启手写笔模式；笔尖/工具条出现。
2. 笔在正文、PDF、Canvas、内嵌 PDF 上书写；换页/滚动/缩放后墨迹对齐。
3. 橡皮圆环可见；快速擦除时墨迹即时消失，抬手不卡。
4. 长按/双击橡皮打开清除面板；滑到底清空本页。
5. 笔可点工具条/色块/滑块；笔不触发 Obsidian 侧栏/控件。
6. 手指在笔离开 1.2s 后正常点按/滚动；手掌不误触。
7. 双击笔杆只唤醒工具条；可配置为笔↔橡皮。
8. 调色盘 5 色可在设置修改；工具条立即更新。
9. PDF 写回成功；备份位于主目录或 PDF 同目录；恢复可用。
10. 关闭手写笔模式后完全回到普通 Obsidian：PDF 无叠层 canvas，诊断 `PDF叠层` 为 0。
11. 长 PDF 滚动/翻页只挂载可见页，内存不随页数线性增长。
12. PDF 打开/翻页无持续白页；`PDF写回` 的 `fake worker=0`。
13. 写到第 3 页、翻到第 5 页再离开：两页都写回；写回后叠加层仍在，页面不长时间白屏。

## 11. 文件

| 文件 | 作用 |
|---|---|
| `electron/src/main/ets/pages/Index.ets` | 笔/手指仲裁、压力采样、PDF/恢复 IPC、taskpool |
| `web_engine/src/main/ets/adapter/StylusAdapter.ets` | Pen Kit 双击/轻捏订阅与广播 |
| `web_engine/src/main/ets/common/PenSampleTap.ets` | TouchEvent + historical points 压力采样 |
| `web_engine/src/main/ets/adapter/PdfInkWriter.ets` | PDF 注释写入、replace、备份、恢复 |
| `scripts/patches/ohsidian-ink.js` | 渲染层：输入、surface、墨迹、工具条、设置 |
| `scripts/patches/touch-mode.js` | 设置页/独立“手写笔”tab、IPC 端口 |
| `scripts/update-obsidian.mjs` | 内核补丁：`capCanvasAreaFactor:0` |
| `scripts/build-agent.mjs` | 临时注入探针、构建 agent 包、恢复 release asar |
| `scripts/stylus-eval/` | 评测/录制/报告流水线 |
| `scripts/verify-asar.cjs` | 校验补丁标记与 asar 语法 |
| `scripts/verify-release.cjs` | 断言 release 不含设备探针 |
