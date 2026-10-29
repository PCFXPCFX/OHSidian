# 手写笔（华为 M-Pencil）适配

> 状态：实验功能，当前 **v39**。默认关闭，需在“设置 → 手写笔 → 手写笔模式”开启。
> 实现与变更记录见 `docs/CHANGES-2026-10.md` 第 189–194 轮；更细的真机记录已归档到该文件的旧轮次。

## 1. 目标与边界

目标：在 OHsidian（Obsidian 运行于 HarmonyOS Electron 兼容层）中提供可用的 M-Pencil 书写体验：

- 压力/倾斜墨迹、笔杆双击/轻捏；
- 笔记、PDF、Canvas 标注；
- PDF 可直接写回真实 `/Ink` 注释，保留原始文件备份；
- 手掌/手指与笔分离，笔不误触 Obsidian 自身控件；
- 平板优先：低延迟、低功耗、无持续后台重绘。

非目标：不改 Obsidian 内核、不重写编辑器、不做云同步、不做 P3 原生低延迟覆盖层。

## 2. 分层与数据流

```
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

- **ArkTS** 是唯一可靠的笔数据源（压力、tilt、Pen Kit 手势）；渲染层只消费。
- **IPC** 与视频覆盖层共用 loopback 端口，按 `action/event` 区分；不支持时只保留叠加层。
- **墨迹 sidecar 是编辑源**；PDF `/Ink` 是可移植副本，不是编辑源。

## 3. 输入仲裁（关键规则）

### 3.1 ArkTS 层

- **Pen**：永远 `HitTestMode.Default`，进入 XComponent 正常书写。
- **MOUSE / TOUCHPAD**：放行。
- **手指/手掌/Unknown**：
  - `penGuardUntil`（笔悬停/书写及之后 1.2s）内 `Block`；
  - 否则允许手指点按/滚动，但接触面积超过 `palmLimit`（笔模式 34vp / 普通 44vp）时 `Block`。
- 笔悬停 (`onHover`, sourceTool=Pen) 会提前延长 guard。
- `taskpool` 写 PDF，避免 PDFKit 同步 load/save 阻塞 UI。

### 3.2 渲染层

- **笔落在 ink surface**：画。
- **笔落在我们的工具条/菜单/清除面板**：允许点按、长按、拖滑块。
- **笔落在 Obsidian 其他 UI 或空白/边距**：`pointerdown` 即拦截，不传给 Obsidian。
- **笔的兼容 touch/mouse 事件**：笔活动窗口内吞掉；1.2s 无笔后恢复给手。
- 笔从 UI 起笔滑动 >5px：拦截并抑制 click。
- 双指/多指不用于笔手势；ArkUI PanGesture 已移除，PinchGesture 已移除。

## 4. 墨迹数据模型

### 4.1 InkDoc

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

### 4.2 Space

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
- 只支持阅读视图；Live Preview 下笔落笔会自动切阅读视图。
- 宿主被 Obsidian 清空时 `ensureAttached()` 会重新挂回；`rebind()` 复用同一 surface/doc/undo。

### 5.2 PDF

- **真实 viewer**：Obsidian 1.13.7 的链是 `view.viewer(T1) → .child(x1) → .pdfViewer(g) → .pdfViewer(pdf.js)`；`pdfViewerChain` 逐层跟随（`.pdfViewer/.viewer/.child`），`pdfJsViewerOf` 取第一个带 `getPageView` 的对象。页码用 `pageView.viewport` 转换 PDF points；页 canvas 在 `.page` 内。
- **真实 PDF 不再有 pdfdom 回退**：首次取 viewer 失败时 350ms 重试；pdfdom 只用于笔记内嵌 PDF。旧回退把 79 页都映射到第 1 页 rect，是“字迹变艺术画”的根因。
- **打开时先恢复页码**：`pagesinit` 读 `pdfjs.history`（按 document fingerprint）在首帧渲染前跳到上次页；并对距当前页 >2 页的 `pagerender` 调 `cancelRendering`，避免重的封面页阻塞渲染队列约 10s。
- **live/base 双 canvas**：`ohsidian-ink-pdf-live` 只画当前笔画，`ohsidian-ink-pdf` 只画已提交笔画；抬笔后清 live 不会清掉已提交墨迹。
- **viewport 几何复用**：pdf.js 每次 render 都给新 viewport 对象；按 width/height/scale 比较复用 entry，避免重建 canvas 留下 ghost 笔迹。
- 缩放用 `offsetWidth/offsetHeight`（布局尺寸），避免 transform 二次缩放。
- 翻页时用屏幕中心 `elementFromPoint` 定位可见 `.page`，按需创建并激活。
- **只在手写笔模式开启时挂载**；关闭后 PDF 上不保留任何叠层 canvas。
- 叠层只给视口 ±1.2 屏内的页分配，离开即释放；`dpr` 封顶 2（设备 2.249 时墨迹仍清晰）。
- **无墨迹页不分配 canvas**：`ensurePage` 先查 `pageHasInk(index)`，空白页不挂 base/live，落笔时 `surfaceAt` 以 `force=true` 才创建。真机同一段 PDF 滚动：有叠加层 39 fps（p95 66.6 ms）→ 按需分配后 60 fps（p95 16.8 ms，0 叠加层）。
- `pagerendered` 只重画事件对应的单页；页表只保留仍在 DOM 的页，翻过的页不再持有 detached canvas。
- pdf.js 自己的页 canvas 只在高 DPI 触摸设备（`dpr≥2` 且 `pointer:coarse`/触摸点）限制在一屏像素内：整窗宽 A4 约 39 MB → 21 MB；普通 PC（鼠标/触控板）保持上游 `200`，文字清晰度不变。
- `app://` 响应补 `Content-Type`（`.mjs`/`.js`/`.wasm`/字体/PDF），让 pdf.js 的 **module worker** 真正跑在 worker 线程；否则静默退回 fake worker，表现为加载慢/白页。
- 写回默认改到**离开 PDF 时**，避免替换正在打开的文件触发整页重载；写回按“脏页”批量处理，不再只写当前页。
- 注释默认用 **/PolyLine**（兼容模式），并对旧注释按 `uniqueId + title/content/subject` 标记清理，避免重复叠加成“艺术画”；可在设置切回 `/Ink`。
- 直接写入失败/不支持时仍保留叠加层。

### 5.3 内嵌 PDF

- 笔记中的 `.pdf-embed .page` 建立页内归一化 surface。
- 墨迹写在**笔记 sidecar**（`embed:<src>:<page>`），不写 PDF 本体。
- 页尺寸 <10px 不建层；页面重渲染后旧 surface 自动移除。

### 5.4 Canvas

- 512px 分块 canvas 挂在 `.canvas` 的 transformed layer；live 在 `.canvas-wrapper`。
- 映射用 `.canvas` rect + scale；页面缩放/平移后刷新。

## 6. 性能与功耗

按优先级：

1. **增量 live**：`drawLiveIncremental()` 只画新增段；高亮笔因 alpha 重叠仍整条重绘。
2. **提交只追加**：抬笔 `appendStroke()` 只把当前笔追加到 base canvas；`inkAfterDocChange(doc, surface)` 跳过该 surface 全量重绘。undo/redo/erase/主题仍全量。
3. **PDF 原生滚动**：pdfdom canvas 在滚动内容内，滚动零 JS 重定位。
4. **坐标缓存**：`beginStroke()` 缓存 sizer/page/canvas rect；整笔不再每点 `getBoundingClientRect()`。
5. **橡皮预览**：pointermove 只在 base canvas 上用 `destination-out` 挖圆，不扫描文档/不整页重绘；pointerup 一次性应用路径（bbox 预筛、浅拷贝）并只重绘一个 surface。
6. **撤销快照引用**：`snapshotSpace()` 存 stroke 引用，不再 JSON 深拷贝整页。
7. **保存节流**：`saveSoon` 900ms 合并；关闭/失焦 flush。
8. **光标节流**：hover ring 约 60fps；橡皮圆环与擦除半径一致。
9. **UI 效果默认省电**：毛玻璃默认关，减少动画默认开。
10. **PDF 叠层按需**：手写笔模式关闭时 0 张；开启时只给视口 ±1.2 屏分配，滚动离开即释放。
11. **单页重绘**：`pagerendered` 只清/画该页，不再每渲染一页就遍历全部页（旧实现为 N² 次全画布清除）。
12. **页表清理**：pdf.js reset 会摘掉叠层 canvas；`prunePages()` 同步删除 detached 条目，翻过的页不再占内存。
13. **内核像素上限（仅高 DPI 触摸设备）**：`capCanvasAreaFactor` 在 `dpr≥2` 且粗指针/有触摸点时取 `0`（一页不超过一屏），否则保持上游 `200`。平板整窗宽 A4 约 39→21 MB（73% 线性），窄面板几乎无损；普通 PC 不降清晰度，高 DPI 触摸 PC 按平板处理。
14. **关闭即停**：`inkEnabled=false` 时同时停止 ArkTS 的 `penSamplesOn` 采样流，避免笔继续唤醒应用。
15. **worker 真线程**：`app://` 补 MIME 后，`pdf.worker.min.mjs` 以 module worker 加载，不再退回主线程 fake worker。
16. **写回不打断阅读**：默认 `leave` 时机，只在离开 PDF/切后台时替换文件；`idle` 仍可手动选（会重载）。
17. **脏页批量写回**：按 doc 中 `!written` 的 space 与擦除/撤销/清空标记的脏页逐页写，翻过的页不会漏写。
18. **写回前校验**：PDFKit 保存后重新 load 并检查页数，坏文件不替换；注释按标记清理，避免重复堆叠。

## 7. PDF 直接写入

### 7.1 触发

- 设置“直接写入 PDF（自动备份）”默认开；
- **写回时机**默认“离开 PDF 时”：记录脏页，切 leaf/后台时批量写；避免读页时替换文件导致白屏重载；
- 可选“停笔 3 秒”（会重载）或“仅手动”；
- 擦除/撤销/重做/清空标记对应页为脏页；
- 手动命令：`OHSidian 手写: 写入 PDF（真实注释）`。

### 7.2 写入流程

1. 复制原 PDF 到 cache；
2. PDF Kit 载入；
3. replace 模式删除本页 `ohsidian-` 注释，以及 `title/content/subject` 以 `ohsidian-ink` 开头的旧注释；
4. 按当前 sidecar 重加本页所有笔画（含 `baked`）；默认 `POLYLINE`，可切 `INK`；
5. 保存到 cache；重新 `loadDocument` 校验页数（坏文件不替换）；
6. 校验 `%PDF-`；
7. 首次写入前创建原始备份；
8. 复制到 PDF **同目录** `.hso-new-*.pdf`，同文件系统 swap；平台拒绝覆盖时先 `src → .hso-old-*`，再换入，失败恢复旧文件。

真机实测（22.5 MB / 79 页，平板）：单页 6 笔（1866 点）**184 ms**；离开时两页批量
233 ms + 127 ms，均 `ok=true`；写后注释计数与笔画数一致（6 笔 → 6 个 `/PolyLine`），
无重复叠加。

### 7.3 备份与恢复

- 主备份：`<vault>/.obsidian/ohsidian-ink/backups/<name>-<pathHash>.orig.pdf`
- fallback：`<file>.pdf.ohsidian-orig.pdf`
- 恢复：设置 → 手写笔 → PDF → “恢复原始 PDF”，或命令 `恢复 PDF 原始备份`。
- 首次备份不会被后续写入覆盖；如果旧版本已写过注释，备份是“当时”的文件。

### 7.4 已知限制

- 加密/超大/损坏 PDF 可能失败；失败不替换原文件。
- pdfdom 归一化写入依赖 `getWidth/getHeight`；旋转/裁切页可能偏移。
- PDF 被其他进程锁定时最后 swap 仍可能失败；错误会带备份路径。
- Obsidian pdf.js 对 `/Ink`/`/PolyLine` 使用 `stroke="transparent"` 且无对应 CSS，所以叠加层默认保留；PDF 注释主要供其他阅读器/导出使用。
- `/PolyLine` 在部分读器可能显示为折线而非笔锋；需要笔锋时可切回 `/Ink`，但部分 PDF Kit 版本会填充。
- 真机 Agent 的 `uitest` 坐标需按设备校准；不同 HarmonyOS 版本参数可能不同。

## 8. 工具与交互

- 工具条：指针 / 笔 / 高亮 / 橡皮 / 撤销 / 重做 / 5 色调色盘 / 自定义色 / 粗细 / 更多。
- 笔尖：第一下展开，第二下收起。
- 笔杆双击：默认只唤醒工具条；可选笔↔橡皮、撤销、调色盘。
- 笔杆轻捏：默认打开工具条/调色盘。
- 橡皮：圆环显示擦除范围；长按或双击橡皮按钮打开“滑动清除本页”面板，面板锚定在橡皮上方。滑条面板从 228px 缩到 168px，滑动约 130px 即到底（原约 184px），更省手腕行程。
- 调色盘：设置 → 手写笔 → 颜色 → 工具条调色盘，配置 5 个常用颜色，保存到 `inkPalette`。
- 界面效果：毛玻璃（默认关，GPU/耗电）与减少动画（默认开）。

## 9. 设置项（设置 → 手写笔）

| 分组 | 项 |
|---|---|
| 功能 | 手写笔模式（默认关）、工具条显示/位置、安静反馈、笔尖光标、界面效果 |
| 输入与手势 | 掌托过滤、允许手指绘制、橡皮半径、笔杆双击、笔杆轻捏、边缘手势 |
| 压力 | 来源（自动/强制）、预设、死区、gamma、曲线图 |
| 颜色 | 跟随主题、自选墨色、高亮色、工具条调色盘 |
| PDF 与诊断 | 写入后叠加层（默认保留）、直接写入 PDF、写回时机（离开/3s/手动）、注释样式（PolyLine/Ink）、恢复原始 PDF、诊断 |

## 10. 命令与诊断

命令：

- 手写模式开/关（指针 ↔ 笔）
- 启用手写（切阅读视图并选笔）
- 笔 / 高亮 / 橡皮 / 指针
- 撤销/重做/清空本页
- 写入 PDF / 恢复 PDF 原始备份
- 导出本页 SVG
- 按主题重新着色
- 显示/隐藏工具条
- 手写笔诊断

HiLog 关键标签：

```text
InkUI boot / surface / commit / gesture / nativeTool / setTool
InkUI penCompatBlocked / pdfdomOverlay / surfaceWaitTimeout
PdfInk write/restore
```

`InkUI commit` 包含 `space/points/color/width/tiles/hostH`，用于判断写入与宽度。

诊断面板的 `PDF叠层` 行给出：叠层 canvas 张数、页表页数、总字节、overlay `dpr`。
关闭手写笔模式后应为 **0 张**；开启后应只随可见页数增长，而不是随文档页数增长。
`PDF写回` 行给出时机/样式/次数/上次写回时间/fake worker 计数。

## 11. 文件

| 文件 | 作用 |
|---|---|
| `electron/src/main/ets/pages/Index.ets` | 笔/手指仲裁、压力采样、PDF/恢复 IPC、taskpool |
| `web_engine/src/main/ets/adapter/StylusAdapter.ets` | Pen Kit 双击/轻捏订阅与广播 |
| `web_engine/src/main/ets/common/PenSampleTap.ets` | TouchEvent + historical points 压力采样 |
| `web_engine/src/main/ets/adapter/PdfInkWriter.ets` | PDF `/Ink` 写入、replace、备份、恢复 |
| `scripts/patches/ohsidian-ink.js` | 渲染层：输入、surface、墨迹、工具条、设置 |
| `scripts/patches/touch-mode.js` | 设置页/独立“手写笔”tab、IPC 端口 |
| `scripts/update-obsidian.mjs` | 内核补丁：`capCanvasAreaFactor:0`（PDF 页 canvas 一屏上限） |
| `scripts/verify-asar.cjs` | 校验 P0/P1/MIME 标记与 asar 语法 |
| `scripts/verify-release.cjs` | 断言 release `app.js` 不含设备探针 |
| `electron/src/main/module.json5` | VIBRATE 权限 |

## 12. 验收清单

1. 开启手写笔模式；笔尖/工具条出现。
2. 笔在正文、PDF、Canvas、内嵌 PDF 上书写；换页/滚动/缩放后墨迹对齐。
3. 橡皮圆环可见；快速擦除时墨迹即时消失，抬手不卡。
4. 长按/双击橡皮打开清除面板；滑到底清空本页。
5. 笔可点工具条/色块/滑块；笔不触发 Obsidian 侧栏/控件。
6. 手指在笔离开 1.2s 后正常点按/滚动；手掌不误触。
7. 双击笔杆只唤醒工具条；可配置为笔↔橡皮。
8. 调色盘 5 色可在设置修改；工具条立即更新。
9. PDF 自动写入成功；备份位于主目录或 PDF 同目录；恢复可用。
10. 关闭手写笔模式后完全回到普通 Obsidian：PDF 无叠层 canvas，诊断 `PDF叠层` 为 0 张。
11. 开启后滚动/翻页只挂载可见页；长 PDF 内存不随页数线性增长，页面重渲染只重画本页。
12. PDF 打开/翻页应无持续白页；诊断 `PDF写回` 的 `fake worker=0`，`pdfDocLoaded` 有读数。
13. 写到第 3 页、翻到第 5 页再离开：第 3/5 页都写回；写回后叠加层仍在，页面不长时间白屏。
