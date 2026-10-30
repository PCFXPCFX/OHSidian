# PDF 显示性能审计（只读代码，2026-10-28）

> **实施状态（同日）**：P0（墨迹 PDF 叠层不启用不挂载、可见页上限、单页重绘、页表清理、dpr≤2）
> 与 P1（高 DPI 触摸设备 `capCanvasAreaFactor:0`，PC 保持 `200`）已落地，见
> `docs/CHANGES-2026-10.md` 第 190–191 轮、`docs/STYLUS-PEN.md` v38。
> 第 193 轮进一步修复 `app://` 无 Content-Type 导致的 fake worker（B6 成立）、写回重载、
> 注释重复/填充；真机探针见 `tools/device-agent/`。P2/P3 仍未做。
> 文中 `ohsidian-ink.js` 行号为修复前（v35）位置；v38 已改动 PDF surface，定位请以函数名
> （`createPdfSurface` / `ensurePage` / `redrawPage` / `refreshPages`）为准。

> 范围：`obsidian.asar` 内 pdf.js 5.3.34 + Obsidian 的 PDF 视图胶水层 + 本仓库补丁
> （`scripts/patches/ohsidian-ink.js`、`scripts/patches/touch-mode.js`、
> `web_engine/.../app/main.js`、`ohsidian-flags.json`）。
> 方法：**只读代码与仓库文档**，不做真机调试。所有结论都给可复算的公式或可 grep 的锚点。
> 行号取自当前工作区（未提交状态），asar 内代码用 `文件@字节偏移` 或唯一子串锚定。

---

## 0. 结论摘要

| # | 现象 | 根因 | 代码位置 | 量级（本机几何） | 归属 |
|---|------|------|----------|------------------|------|
| **B1** | 打开 PDF 就慢、滚动发卡、长文档越用越占内存 | 墨迹层**无条件**给每个 PDF 页挂一张 overlay canvas（像素密度未封顶），并在每次 `pagerendered` 里**全量重画所有页**；`pages` 表从不清理 | `ohsidian-ink.js:1667` `1693-1698` `1756-1781` `1807-1815` `2556-2626` `5922-5943` | 每页**再加**一张 9.7 Mpx / 38.8 MB canvas；每次页渲染触发 N 次全画布 `clearRect`；页条目泄漏 | **本仓库缺陷**（与"手写笔开关"无关） |
| **B2** | 首屏页出现慢、翻页卡、内存高 | 每页 canvas 按 `devicePixelRatio=2.249` **全分辨率**渲染，且 pdf.js 只按"屏幕像素 ×3"设上限 | `app.js@3018413`（`maxCanvasPixels:16777216`）＋ `pdf.min.mjs@80878`（`OutputScale.pixelRatio`）＋ `capCanvasAreaFactor=200` | 整窗宽 A4 页 ≈ **9.7 Mpx / 38.8 MB**；10 页缓冲 ≈ **0.39 GB**；光栅量是 DPR 1.0 的 **5.06 倍** | 上游配置 × 本机几何，**本仓库一行可收敛** |
| **B3** | 打开瞬间"页框转圈"、模式切换/改字号后整页重画 | 容器**宽度**变化 → `page-width` 重新定标 → 全部可见页 `update({scale})` 重绘 | `app.js@3059506`（`onResize` 派发）→ `pdf.viewer.min.mjs@472614` → `@304512` → `@303146` | 每次宽度变化 = 可见页各重绘一次（每页 ~9.7 Mpx） | 上游机制 × 本仓库缩放/模式切换策略 |
| **B4** | 缩放（双指/滑杆）后更卡 | `enableDetailCanvas` 被 PDFViewer 强制 `true`，缩放超上限后每可见页再渲染一张全 dpr canvas | `pdf.viewer.min.mjs@275870` `@284460` `@200660` `@201815` | 可见页 canvas 数 ×2，渲染任务 ×2 | 上游（Obsidian 未转发该开关） |
| **B5** | 文本型 PDF 首屏更慢 | 每页 `textLayerMode:1` + `annotationMode:2` + `enableAutoLinking:true` | `pdf.viewer.min.mjs@99532` `@97934` `@228543` | 每页数百~数千 span + 链接推断 | 上游默认 |
| **B6** | 若首屏解析极慢、单页解析占用主线程 | `new Worker(...,{type:"module"})` 失败时 pdf.js **静默**退回"fake worker"（主线程） | `pdf.min.mjs@335090`（`_initialize`）、`@336114`（`Setting up fake worker.`） | 解析/字体/图像解码全部落到渲染器主线程 | 引擎能力（待证，见 §5） |
| **B7** | 标准字体 PDF 文字发糊/更慢 | `FontFace` 守卫把 `local()` 源判为不可用 → pdf.js 退化为**字形轮廓**绘制 | `web_engine/.../app/main.js:292-338` | 每页字形从"原生字体"变为路径填充，光栅量上升 | 本仓库（有取舍） |

**一句话**：`B1` 是本仓库自己引入且违反设置页承诺的缺陷，优先修；`B2` 是本机 DPR 2.249 与
pdf.js 默认上限共同造成的"每页 38 MB"放大，改 `l1` 一个字段即可减半；`B3/B4/B5` 是上游行为
被本机几何放大；`B6` 只能用代码探针确认，不能靠猜。

---

## 1. 链路与生效参数

### 1.1 从打开文件到上屏

```text
vault 里的 .pdf
  └─ Obsidian PDFView（app.js，VIEW_TYPE="pdf"）
       ├─ createObsidianPDFViewer({baseConfig: l1, ...})   app.js@3043884
       │    ├─ AppOptions.setAll(l1)                        ← 唯一的全局配置注入点
       │    ├─ new PDFViewer({... maxCanvasPixels: AppOptions.get(...)})   viewer@446894
       │    └─ new PDFViewer({...}) ← Obsidian 只转发部分字段（见 1.3）
       ├─ PDFPageView.draw()
       │    ├─ _createCanvas → getContext("2d",{alpha:!1, willReadFrequently:!enableHWA})
       │    └─ pdfPage.render(...)  → 在渲染器主线程把一页画进 canvas
       ├─ TextLayerBuilder / AnnotationLayer → 每页 DOM
       └─ PDFPageViewBuffer(10) → 离屏页 view.destroy()（canvas 归零）
  └─ 引擎 Chromium 渲染器 → 合成 → XComponent(SURFACE) → 屏幕
```

### 1.2 `l1` 的实际取值（asar 内，唯一子串 `enableScripting:!1,externalLinkTarget:2`）

| 字段 | 值 | 是否被 Obsidian 覆盖 | 说明 |
|------|-----|----------------------|------|
| `maxCanvasPixels` | `16777216` | — | 单页 canvas 像素上限；`rd.isMobile` 为 false，所以**没有**走 5 242 880 的移动端分支（`app.js@3042472`） |
| `capCanvasAreaFactor` | **未写** → 回落 `AppOptions` 默认 `200` | PDFViewer 未转发该字段 → `PDFPageView` 回落 `AppOptions.get()`（viewer@228543） | 实际上限 = `min(16777216, ceil(screenW×screenH×dpr²×3))` |
| `enableHWA` | 未写 → 默认 `true` | PDFViewer 转发（viewer@446894） | `willReadFrequently:false`，即**假定 GPU canvas** |
| `enableDetailCanvas` | 未写 → PDFViewer **强制 true**（`e.enableDetailCanvas??!0`，viewer@275870） | 不吃 `AppOptions` | 想关必须改 viewer 包本身 |
| `textLayerMode` | 未写 → 默认 `1`（ENABLE） | PDFViewer 转发 | 每页文本层 |
| `annotationMode` | 未写 → 默认 `2`（ENABLE_FORMS） | PDFViewer 转发 | 每页注释/表单层 |
| `defaultZoomValue` | `"page-width"` | — | 宽度变化 ⇒ 比例重算（见 B3） |
| `isEvalSupported` | `false` | — | 与性能无关 |
| `workerSrc` | `"/lib/pdfjs/pdf.worker.min.js"`（`l1` 内） | **被模块加载器的 `after` 覆盖**为 `.mjs`（`app.js@2390336`） | 实际 worker 走 `GlobalWorkerOptions` |

> `AppOptions` 的优先级是「userOptions（= `l1`）> 平台/UA 默认 > 内置默认」，所以
> **UA 是否伪装成 Windows 不影响 `maxCanvasPixels`**；而 `capCanvasAreaFactor`
> 因为 PDFViewer 显式传了 `undefined`，仍会回落 `AppOptions` —— 这两点决定了 §4 的改法。

### 1.3 本机几何（取自仓库文档，非现场调试）

| 形态 | 物理窗口 | 密度 | CSS 视口 | 出处 |
|------|----------|------|----------|------|
| 平板触摸/全屏 | 2800×1840 | 2.249 | 1244×818 | `BUG-BACKLOG.md:1238`（`2800/2.249`、`1840/2.249`） |
| 平板窗口模式 | 1650×1241 | 1.9125 | 863×649 | `CHANGES-2026-10.md:954`、`NativeVideoOverlay.ets:1261` |

PDF 面板宽度取决于布局：整窗宽（无侧栏）≈ 1204 CSS，开右栏 ≈ 900，窄分栏 ≈ 600。

---

## 2. 定量模型：一页 PDF 要多少像素

### 2.1 `page-width` 定标（viewer@304512）

```js
// _setScale("page-width")
const s = removePageBorders ? 0 : 40;              // 默认减 40px
const i = (container.clientWidth - s) / page.width * page.scale / 1;
// A4: page.width = 595.28pt ⇒ 比例 i；viewport = 595.28i × 841.89i（CSS px）
```

### 2.2 输出比例与上限（pdf.min.mjs@80878）

```js
class OutputScale {
  constructor(){ this.sx = this.sy = OutputScale.pixelRatio; }   // = devicePixelRatio
  limitCanvas(w,h,maxCanvasPixels,maxCanvasDim,capCanvasAreaFactor){
    const cap = OutputScale.capPixels(maxCanvasPixels, capCanvasAreaFactor);
    const r = Math.sqrt(cap / (w*h));            // 像素上限 → 比例上限
    const l = Math.min(r, ...);
    if (this.sx > l) { this.sx = this.sy = l; }
  }
  static capPixels(t, e){                        // e = capCanvasAreaFactor
    if (e >= 0) {
      const screenCap = Math.ceil(screen.availWidth * screen.availHeight * pixelRatio**2 * (1 + e/100));
      return t > 0 ? Math.min(t, screenCap) : screenCap;
    }
    return t;
  }
}
```

本机代入：`screenCap = 1244 × 818 × 2.249² × 3 ≈ 15.46 M`，`min(16.78M, 15.46M) = 15.46M`。

### 2.3 单页代价（A4，触摸/全屏，dpr 2.249）

| PDF 面板宽 | page-width 比例 | 视口（CSS） | canvas（px） | 单页字节 |
|-----------|----------------|-------------|--------------|----------|
| 1204（整窗宽） | 1.955 | 1164×1646 | 2618×3702 = **9.69 M** | **38.8 MB** |
| 900（开右栏） | 1.445 | 860×1216 | 1934×2735 = **5.29 M** | **21.2 MB** |
| 600（窄分栏） | 0.941 | 560×792 | 1259×1781 = **2.24 M** | **9.0 MB** |

三档都**未触及** 15.46 M 上限 ⇒ 全部按原生 dpr 2.249 渲染。

### 2.4 常驻总量（viewer@286850 / @290369）

```js
this.#buffer = new PDFPageViewBuffer(10);                 // 初始 10
update(){ const cap = Math.max(10, 2 * visibleViews + 1); // 每帧重算
          this.#buffer.resize(cap, visibleIds); }          // 超出即 destroy 最老页
```

`PDFPageViewBuffer._destroyFirstView()` 会 `view.destroy()`（`reset()` + `_resetCanvas()`
把 `canvas.width/height` 归零），所以**上限 10 页**在册：

| 场景 | 常驻 canvas 内存（仅 pdf.js 自己） |
|------|-----------------------------------|
| 整窗宽 A4 | 10 × 38.8 MB = **388 MB** |
| 开右栏 | 10 × 21.2 MB = **212 MB** |
| 窄分栏 | 10 × 9.0 MB = **90 MB** |

> 这解释了"大 PDF 越看越占内存、切走再回来发卡"：缓冲驱逐后回滚需要**整页重绘**
> （`update({scale})` → `reset()` → 重新 `render`），而重绘成本 ∝ 上述像素数。

### 2.5 重绘成本

pdf.js 的页渲染是"把整页画进 2D context"，成本与 canvas 像素数近似线性：
本机整窗宽一页 = 9.69 M 像素，是 DPR 1.0 桌面的 **5.06 倍**（2.249²），
是 1.9125 窗口模式的 **1.38 倍**。任何"每页重绘一次"的事件，代价都按这个倍数放大。

---

## 3. 瓶颈逐条

### B1（P0，本仓库）墨迹层对 PDF 页的无条件叠加

**设置页承诺**（`ohsidian-ink.js:5284-5285`）：

> 「手写笔模式 / 默认关闭。打开后才显示笔尖/工具条并拦截笔输入；
> **关闭后 OHSidian 完全回到普通 Obsidian**。」

**实际行为**：`state.enabled` 只控制"拦截笔输入/画不画"，**不控制挂载**。

1. `install()`（`:5922`）无条件执行：`injectCss()`、`installPenObservers()`、
   `addCommands()`，并在 `onLayoutReady` 后连打 5 次 `inkRefreshSurfaces()`
   （`:5932-5943`，150/400/900/1600ms）。
2. `inkRefreshSurfaces()`（`:2556`）没有 `state.enabled` 门；对每个 `pdf` leaf：
   - 首次：`createPdfSurface(leaf)`（`:2633`）；
   - 已存在：`existing.refreshPages()`（`:2623-2626`）——**每次布局变化都全量重挂+重画**。
3. `createPdfSurface` → `refreshPages()`（`:1798-1802`）→ 对容器内**每个**
   `.page[data-page-number]` 调 `ensurePage()`：读一次 `getComputedStyle`（`:1691`）、
   `ensureCanvas()` 建 canvas、`sizeCanvas(cv, vp.width, vp.height, this.dpr)`（`:1693-1698`）。
   其中 `this.dpr = window.devicePixelRatio || 1`（`:1667`）——**没有任何封顶**
   （对比 `pdfembed` 路径 `:2198` 是 `Math.min(dpr, 2)`）。
4. `attach()` 订阅 pdf.js 的 `pagerendered`（`:1807-1815`）：

   ```js
   var onRendered = function (e) {
     var entry = self.ensurePage(pageEl);
     if (entry) self.drawLive(entry, null);   // 整页 clearRect
     self.redraw();                            // ← 遍历所有页，每页再 clearRect
   };
   ```

   `redraw()`（`:1756-1781`）对 `this.pages` 里**每一页**做
   `ctx.clearRect(0, 0, cv.width, cv.height)` 再重画该页全部笔画。
   于是，设"当前在册（`cv.isConnected`）的页数"为 N：每渲染 1 页 → 清 N 页；
   **渲染 N 页总计 N² 次全画布清除**（N=10、整窗宽时 = 100 次 × 9.69 Mpx ≈ 0.97 Gpx 的清除量）。
   注意 `redraw()` 里对 `!cv.isConnected` 的条目会 `continue`，所以计入清屏的只有仍在 DOM 的页。
5. `this.pages`（`:1681-1710`）只增不减：pdf.js 的 `PDFPageView.reset()` 会把
   **非保留子节点全部移除**（`t.remove()`，viewer 内 `reset(){let{keepAnnotationLayer...}`），
   墨迹 canvas 不在保留名单里 → 被摘出 DOM，但 `this.pages[index].cv` 仍持有它
   ⇒ 每个"曾经挂载过"的页索引都留一张 detached canvas，直到该 PDF 的 surface 卸载。
6. 缩放 `scalechanged` 后 30ms 再 `refreshPages()`（`:1816-1818`），而 scale 变化会让
   pdf.js 对每页 `reset()` → 所有墨迹 canvas 被摘除并重建一轮。

**量级**：墨迹层开启或关闭都一样，PDF 每页内存 **×2**（38.8 → 77.6 MB），
滚动时额外 N² 次全画布清除；`pages` 表让"翻过的页"继续持有内存。
这正是 `STYLUS-PEN.md` 风险表 `R9 长文档/大 PDF 性能` 与 v25/v26 记录过的同一类问题，
只是发生在"页集合"尺度。

### B2（P1）每页 canvas 按 2.249 全分辨率、上限宽到无意义

见 §2。要点：

- `maxCanvasPixels = 16 777 216`（`app.js@3018413`），而 `capCanvasAreaFactor = 200`
  让实际上限变成"屏幕像素 ×3"（≈15.46 M）——对 9.69 M 的一页**完全不设限**。
- 上游 pdf.js 的移动端默认值 5 242 880 在这台设备上**不生效**：`rd.isMobile=false`
  （`app.js@1092173` 初始化、`app.js@4301453` 桌面门），Obsidian 自己的
  `l1.maxCanvasPixels=5242880` 分支（`app.js@3042472`）进不去。
- 结果：一页 A4 在整窗宽下就是 38.8 MB，缓冲 10 页 ≈ 0.39 GB，而每页光栅量
  是 1× 桌面的 5 倍。

### B3（P2）宽度变化 ⇒ `page-width` 重定标 ⇒ 全部可见页重绘

```text
Obsidian PDFView.onResize()          app.js@3059506
  └─ pdfViewer.eventBus.dispatch("resize")
       └─ pdf.js onResize(e)          viewer@472614
            currentScaleValue = "page-width"   // 重算比例
            pdfViewer.update()
              └─ _setScale("page-width")       viewer@304512
                   _setScaleUpdatePages()      viewer@303146
                     --scale-factor 改写 + refresh(!0,{scale})
                       └─ 每页 update({scale}) → reset() → 重绘
```

本仓库里会改变"PDF 容器宽度"的路径：

| 路径 | 代码 | 影响 |
|------|------|------|
| 系统字体大小 / 命令覆盖 | `touch-mode.js:613-644` `webFrame.setZoomFactor(sc)` | **改变 CSS 视口宽度**（zoom），PDF 面板宽度随之变化 ⇒ 全可见页重绘 |
| 触摸 ↔ 窗口模式切换 | 密度 2.249 ↔ 1.9125 | 视口尺寸变化 ⇒ 同上 |
| 窗口拖动/缩放、侧栏开合 | Obsidian 自身 | 同上 |
| ArkTS 视口重推 | `WebAbility.ets:1220-1249`（150ms 去重 + 300ms 补偿） | 只在真实几何事件后触发，不会自激 |

`minDurationToUpdateCanvas`（默认 500，viewer@195416 一带）的语义是**不是"限流"而是"跳过"**：
距上次画布更新不足 500ms 时，新建页画布的分支直接 `return`（不 append 新 canvas），
页面继续显示旧画布/加载态：

```js
if (!isDetail && minDurationToUpdateCanvas > 0) {
  if (Date.now() - lastCanvasUpdate < minDurationToUpdateCanvas) return;   // 直接放弃本次
  ...
}
```

而 `lastCanvasUpdate` 在每次画布完成与 `drawImage(prevCanvas)` 时都会被刷新。于是
"打开/切换/改字号"引发的连续重定标会让后面的几次重绘被判为过近而**丢弃**，
表现为页框持续转圈或停在旧画面，直到下一次事件把它们拉开——这正是
`main.js` 里那段"页号框还在加载样式"的观感来源（只是那里是字体卡住，这里是节流）。

### B4（P3）缩放后的 detail canvas 双画布

`PDFPageView.updateVisibleArea()`（viewer@232413）在 `enableDetailCanvas` 为真、
且主 canvas 被像素上限压过（`Ea===true`）时创建 `PDFPageDetailView`：

```js
const o = w * h * OutputScale.pixelRatio ** 2;          // viewer@200660
const l = (Math.sqrt(capPixels(maxCanvasPixels, capCanvasAreaFactor) / o) - 1) / 2;
// 以 full pixelRatio 再建一张 canvas（viewer@201815）
n.width = c.width * u; n.height = c.height * u;         // u = pixelRatio
```

Obsidian 没有转发 `enableDetailCanvas`，PDFViewer 又把它默认成 `true`
（`e.enableDetailCanvas??!0`，viewer@275870），所以**这个功能在本移植里是强制开启的**。
放大到超过上限后，每个可见页 = 主 canvas + detail canvas，渲染任务翻倍。

### B5（P4）每页文本层/注释层/自动链接

`textLayerMode:1`（viewer@99532）、`annotationMode:2`（viewer@97934）、
`enableAutoLinking` 默认真（viewer@228543）。文本型 PDF 每页会生成大量
`<span>`（每段文本一个，带 `transform: scaleX()`），并做链接推断。
这是"文本 PDF 比扫描 PDF 首屏更慢"的常见原因，且每次 `B3` 的重绘都要重建一遍 DOM。

### B6（待证，引擎）worker 是否真的在 worker 线程

pdf.js 5 的 worker 启动路径（`pdf.min.mjs@335090`）：

```js
const e = new Worker(t, { type: "module" });     // t = GlobalWorkerOptions.workerSrc
i.on("error", () => terminateEarly());           // 任何失败
function _setupFakeWorker(){ warn("Setting up fake worker."); /* 主线程跑解析 */ }
```

失败即**静默**退回 `_setupFakeWorker()`（只在 console 里 `warn` 一行）。
`app://` 处理器（asar `main.js@205410` 一带）只设
`Accept-Ranges/Content-Length/Content-Range/ACAO/Last-Modified`，**不设
`Content-Type`**；模块脚本/模块 worker 对 MIME 有硬要求，是否被引擎按扩展名补齐，
代码里看不出来。若 worker 成立，解析、字体、图像解码都在 worker；
若不成立，全部落渲染器主线程——这会让大 PDF 首屏和滚动直接降一个数量级。

`B6` 与 `B2` 是**独立**的两条：即使 worker 正常，每页 9.69 Mpx 的光栅仍然在主线程。

### B7（次要）FontFace 守卫把标准字体退化成字形轮廓

`web_engine/.../app/main.js:292-338` 的守卫把 `local(...)` 源的 `FontFace` 换成
立即 reject 的桩，pdf.js 的 `loadSystemFont()` catch 后（`pdf.min.mjs@186704`）
不再用系统字体。好处是修掉了"页渲染任务卡死"，代价是该类 PDF 的**文字变成字形路径**，
光栅量上升、文本层与画布对不齐的风险上升。只影响引用标准字体（非内嵌）的 PDF。

---

## 4. 修复清单（按性价比）

### P0 — 修墨迹层的 PDF 表面（本仓库，收益最大、风险最低）

四处最小改动（都在 `scripts/patches/ohsidian-ink.js`）：

1. **不启用就不挂载**（对齐设置页承诺）

   ```js
   // inkRefreshSurfaces(): 已存在分支
   } else if (existing.kind === "pdf") {
     if (state.enabled) existing.refreshPages();     // ← 原来是无条件
   }
   // 创建分支
   else if (type === "pdf") created = state.enabled ? createPdfSurface(leaf) : null;
   ```
   并把 `install()` 里的 5 次盲刷（`:5936`）改成"仅在 `state.enabled` 时"。

2. **`pagerendered` 只重画本页**（把 O(N) 降成 O(1)）

   ```js
   var onRendered = function (e) {
     var pageEl = e && e.source && e.source.div;
     if (!pageEl) return;
     var entry = self.ensurePage(pageEl);
     if (!entry) return;
     self.drawLive(entry, null);
     self.redrawPage(entry);        // 新增：只画这一页
   };
   ```
   `redraw()` 拆成 `redrawPage(entry)` + 对所有页循环调用，行为不变。

3. **像素密度封顶 + 只给可见页分配**

   ```js
   dpr: Math.min(window.devicePixelRatio || 1, 2),   // 与 pdfembed 路径一致（:2198）
   ```
   `refreshPages()` 里跳过 `rect.bottom < -innerHeight || rect.top > 2*innerHeight` 的页
   （只保留"当前屏 ±1 屏"）。

4. **清理 `pages` 表**

   ```js
   for (var key in this.pages) {
     var e = this.pages[key];
     if (!e || !e.cv.isConnected || !e.pageEl.isConnected) delete this.pages[key];
   }
   ```
   放在 `refreshPages()` 开头；同时把 `ensurePage` 里的
   `getComputedStyle(pageEl).position` 换成一次性标记（`pageEl.dataset.ohsidianPos`）。

**预期**：手写笔关闭时 PDF 每页内存回到 1×、滚动不再有 N² 全画布清除；
开启时也只对可见页付代价，且有界。

### P1 — 收敛每页像素上限（本仓库一行锚点，收益第二大）

在 `scripts/update-obsidian.mjs` 的 `APP_BODY_PATCHES` 增加一条
（`scripts/verify-asar.cjs` 加一条断言）：

```js
const PDF_CANVAS_SRC = 'maxCanvasPixels:16777216,';
const PDF_CANVAS_DST =
  'maxCanvasPixels:16777216,capCanvasAreaFactor:(window.devicePixelRatio>=2&&' +
  '((window.matchMedia&&window.matchMedia("(pointer: coarse)").matches)||' +
  'navigator.maxTouchPoints>0)?0:200),';
```

> 锚点唯一性已核对：当前 asar 的 `app.js` 里 `maxCanvasPixels:16777216` 出现 **1 次**
> （另一处移动端分支写的是 `l1.maxCanvasPixels=5242880`，不会误伤）。

> **落地时按设备分流**：只有 `dpr≥2` 且粗指针/有触摸点的高 DPI 触摸设备才取 `0`；
> 鼠标/触控板为主的 PC 保持 `200`，避免横屏大窗口把 A4 页压到 82% 而损失文字清晰度。
> 如果目标机把 `screen.avail*` 报成物理像素，`0` 会先撞 `maxCanvasPixels:16.7M`，
> P1 失效但不回归。

原理与代价（§1.2 已证 `capCanvasAreaFactor` 会回落 `AppOptions`，所以 `l1` 能改到）：

| `capCanvasAreaFactor` | 实际上限 | 整窗宽 A4 输出比例 | 单页 px / MB | 观感 |
|---|---|---|---|---|
| `200`（现状） | 15.46 M | 2.249（原生） | 9.69 M / 38.8 MB | 最锐 |
| `50`（温和） | 7.73 M | 2.008（89%） | 7.73 M / 30.9 MB | 几乎无感 |
| `0`（高 DPI 触摸设备） | 5.15 M（一屏） | 1.639（73%） | 5.15 M / 20.6 MB | 阅读距离可接受，**窄面板几乎无损**（900 宽时 2.219 vs 2.249） |

`0` 的语义很干净：**"任何一页的 canvas 不超过一屏的像素数"**——正好只在
"整窗宽、超高页"这种最费内存的场景生效。PC 端保留 `200`；若要更保守可用 `50`。

### P2 — 抑制"宽度变化 ⇒ 重定标"的连锁

- 打开 PDF 的 300ms 内不要触发 `webFrame.setZoomFactor` / 窗口 rect 推送
  （`touch-mode.js:613` 与 `WebAbility.ets:1220` 两处都已有"值变化才应用"的门，
  缺的是"PDF 正在首次渲染"这一个条件；给 `applyFontScale` 加一个
  `document.querySelector(".pdfViewer") && 距离上次 pagerendered < 400ms` 的延迟即可）。
- `enableDetailCanvas` 目前被强制 true；若要关，只能改 viewer 包
  （`enableDetailCanvas:e.enableDetailCanvas??!0` → `??!1`，asar 内
  `lib/pdfjs/pdf.viewer.min.mjs@275870`）。**该文件是上游构建产物，锚点脆弱，建议放最后。**

### P3 — 若怀疑 canvas 未真正 GPU 加速（与 B6 一起验证）

`l1` 已经能控 `enableHWA`（PDFViewer 转发，viewer@446894）。两种取值各跑一次即可判定：

- `enableHWA:true`（现状）→ `willReadFrequently:false`，假定 GPU canvas；
- `enableHWA:false` → `willReadFrequently:true`，CPU 位图 + 读回语义。

若引擎实际是软件合成，后者通常**明显更快**（避免每次绘制后的上传/回读）。
判定方法见 §5，不要凭感觉改默认值。

### P4 — 不建议的方向

- 把 `--force-device-scale-factor` 调到 1.5（`ohsidian-flags.json:4`，现为 `0`）：
  能一次把 PDF 像素降 56%，但**整个 UI 会变小**（CSS 视口从 1244 变 1867），
  不只是 PDF。属"全局取舍"，不应为了 PDF 默认打开。
- 自绘原生 PDF 渲染（第二个 XComponent）：收益上限高，但等于重写 pdf.js 的
  排版/文本层/注释层，且和现有墨迹写回（`PdfInkWriter`）耦合，不建议在本阶段启动。

---

## 5. 验证口径（都可在代码里加，不需要外部调试）

建议在既有"诊断"命令里加一组 PDF 读数（`ohsidian-ink.js` 的 `diagnosticLines` 或
`touch-mode.js` 的诊断块）：

| 指标 | 取法 | 期望 |
|------|------|------|
| `dpr` / `screen.availWidth×availHeight` | `window.devicePixelRatio`、`screen` | 2.249 / 1244×818 |
| 每页 canvas 尺寸与上下文属性 | `eventBus.on("pagerendered", e => e.source.canvas.width/height/getContextAttributes())` | 记录 `willReadFrequently`、实际 px |
| 页 canvas 总数 / 总字节 | 遍历 `.page canvas` 求和 | 修复后 ≤ 可见页数 |
| 叠层 canvas 数 | `document.querySelectorAll("canvas.ohsidian-ink-pdf").length` | 手写笔关闭时应为 **0** |
| `pagerendered` 次数与耗时 | `performance.now()` 包住首个事件 | 单页首绘基线 |
| worker 是否 fake | 拦截 `console.warn` 里的 `Setting up fake worker.` 计数 | **应为 0**；非 0 即 B6 成立 |
| 重定标次数 | 包一层 `pdfViewer.currentScaleValue` 的 setter 或监听 `scalechanging` | 打开后 1s 内 ≤ 2 次 |

其中"worker 是否 fake"这一条**只需要一次启动日志**，不涉及反复真机试验；
它决定 B6 是否要把"worker 资源/MIME"作为下一个修复对象。

---

## 6. 风险与回退

| 改动 | 风险 | 回退 |
|------|------|------|
| P0 墨迹层（不启用不挂载） | 手写笔用户从"打开 PDF 即就绪"变为"第一次落笔前挂载"，可能有几十毫秒准备时间（已有 `inkAwaitSurface` 250ms 重试链兜底） | 只回退 `state.enabled` 判断即可 |
| P0 `dpr` 封顶 2 | 2.249 屏上墨迹略软（1.6×→2× 差异） | 恢复 `window.devicePixelRatio`，或改成 2.5 |
| P1 `capCanvasAreaFactor:0` | 整窗宽超高页文字变软约 27%（线性分辨率） | 改回 `200`，或改 `50` |
| P1 若改用 `maxCanvasPixels` 显式值 | 同一改动影响缩略图（`PDFThumbnailViewer` 也读 `AppOptions`） | 同上 |
| P2 `enableDetailCanvas:false` | 放大后清晰度下降（这是该功能的唯一目的） | 改回 `??!0` |
| P3 `enableHWA:false` | 若引擎其实 GPU 加速好，会退步 | 一行回退 |

---

## 附录 A：锚点速查

| 主题 | 位置 |
|------|------|
| Obsidian PDF 基础配置 `l1` | asar `app.js@3018413` |
| 移动端像素分支（本机不生效） | asar `app.js@3042472` |
| `createObsidianPDFViewer` 构造 PDFViewer | asar `app.js@3043884`、`lib/pdfjs/pdf.viewer.min.mjs@446894` |
| `PDFViewer` 是否转发 `capCanvasAreaFactor` | `pdf.viewer.min.mjs@275870`（不转发）、`@284460`（传给 PDFPageView） |
| `PDFPageView` 回落 `AppOptions` | `pdf.viewer.min.mjs@228543` |
| `OutputScale` / `capPixels` | `pdf.min.mjs@80878` |
| `_computeScale` → `limitCanvas` | `pdf.viewer.min.mjs@245470` |
| `_createCanvas` 上下文属性 | `pdf.viewer.min.mjs@195416` |
| detail canvas | `pdf.viewer.min.mjs@200660`、`@201815`、`@232413` |
| 页缓冲 | `pdf.viewer.min.mjs@286850`、`@290369`、`@271209` |
| `onResize` → 重定标 | `app.js@3059506` → `pdf.viewer.min.mjs@472614`、`@304512`、`@303146` |
| worker 启动 / fake worker | `pdf.min.mjs@335090`、`@336114` |
| 墨迹 PDF 表面 | `scripts/patches/ohsidian-ink.js:1622`（创建）、`1667`（dpr）、`1756`（redraw）、`1807`（pagerendered）、`2556`（注册表）、`5922`（install） |
| 字体守卫 | `web_engine/src/main/resources/resfile/resources/app/main.js:292-338` |
| 引擎 flags | `web_engine/.../app/ohsidian-flags.json`、`web_engine/src/main/ets/utils/EngineFlags.ets:56-111` |

## 附录 B：算式

```text
screenCap        = ceil(availW * availH * dpr^2 * (1 + factor/100))
                   = 1244 * 818 * 2.249^2 * 3  ≈ 15.46e6          (factor=200 → ×3)
outputScale      = min(dpr, sqrt(screenCap / (wCSS * hCSS)))
A4 page-width    = (panelW - 40) / 595.28
canvasPx         = (595.28*s * outputScale) * (841.89*s * outputScale)
bytes            = canvasPx * 4
bufferBytes      = min(10, ...) * bytes
rasterRatio(dpr) = (2.249 / dpr)^2     // 2.249 → 5.06× vs 1.0；1.38× vs 1.9125
```

---

## 7. 真机复测（2026-10-29，v39）

本轮在真机（2800×1840，dpr 2.25，HarmonyOS）上把 PDF 链路跑通，结论修正了此前
“主要瓶颈是 canvas 像素”的假设：

| 现象 | 真机证据 | 根因 | 状态 |
|---|---|---|---|
| 打开 10+ 秒白页 | `pdfPage page:1 ms:10843`，当前页 6 被串行队列阻塞 | 该 PDF 第 1 页封面含大图，单页渲染约 10.8s；打开时 pdf.js 先排第 1 页 | 恢复页码时在 `pagesinit` 先跳页 + 对远景页 `cancelRendering`；恢复场景首屏 468ms |
| 写回后白页/重载 | `pdfReload afterWrite:393ms`，重载后当前页 86ms 重绘 | 回退 `pdfdom` 时 79 页共用第 1 页 rect；写回坐标错 | 移除真实 PDF 的 pdfdom 回退；按 fingerprint 先跳页 |
| 墨迹提交后消失 | 抬笔后 canvas 被 `clearLiveAfterPaint` 清空 | live 与 committed 共用一张 canvas | 拆 `ohsidian-ink-pdf-live` |
| 平行重影笔迹 | 同一页 2–3 条偏移线 | pdf.js 每次 render 换 viewport 对象，entry/canvas 被重建，旧 canvas 未删 | 按 width/height/scale 复用 entry |
| 写回耗时 | 6 笔 1866 点：184ms；两页批量：233+127ms | PDF Kit parse/save/swap 本身很快 | 无需再调超时/批量 |
| 注释叠加 | `total:6, PolyLine:6` | replace + marker 清理生效 | 通过 |
| fake worker | `fakeWorker=0` | `app://` MIME 修复生效 | 通过 |

剩余内容型瓶颈：**首次打开就停在第 1 页**时，封面单页仍需约 10.8s。该耗时与画布
尺寸无关（0.643 与 0.8 缩放均约 10.7s），更像大图解码/绘制；后续若要继续优化，
方向是 worker 侧图片尺寸上限或封面低清预渲染，而不是继续降 canvas 像素。

---

## 8. 首开 10 s 的真正瓶颈（2026-10-30 真机）

**不是文件读取，也不是 IPC**：

- 22.5 MB PDF 读取 + 解析：`pdfDocLoaded 317 ms`；
- 第 1 页 pdf.js 栅格：`pdfPage page:1 10.2–10.4 s`；
- 第 1 页 PDF Kit 原生栅格：`pdfPreviewProbe 268–300 ms`；
- 单页 6 笔写回：`PdfInk ms=184`。

第 1 页 operator list 只有 14 项，含两张图：`2559×1440` 与
`5816×2044 / DCTDecode / SMask 247 0 R`（压缩后 432 KB）。耗时在这张
12 MP JPEG + 12 MP 软掩码的解码/绘制，而不是磁盘或 socket。

验证过的方案与结果：

| 方案 | 结果 |
|---|---|
| `maxImageSize` 限制 | pdf.js 直接**删除**超限图片（"Image exceeded maximum allowed size and was removed"），不能降采样显示 |
| worker 内 `createImageBitmap` resize 后再传主线程 | 首屏仍 ~10 s，瓶颈不在主线程缩放 |
| 原生 PDF Kit 预览 + JS `<img>` 覆盖 | 原生 300 ms，但 pdf.js 绘制占满主线程，IPC 回包延迟到 ~8.4 s 后才到，覆盖图来不及显示 |
| 恢复页码时先跳页（已上线） | 非第 1 页恢复从 10 s 降到 ~0.5 s |

结论：要修“首次就停在第 1 页”，必须让预览**不依赖 Web 主线程**——用 ArkUI
原生 `Image` + PDF Kit `PixelMap` 覆盖在 XComponent 上；或者替换 pdf.js 的
JPEG 解码路径。纯 JS 层覆盖已被真机数据证伪。

---

## 9. 图片解码：能试的都试完了（2026-10-30 真机）

第 1 页在 release 下 `pdfPageRendered` 约 **8.8 s**，第 2 页 **0.3–0.7 s**。
把 worker 的 `buildPaintImageXObject` 直接 return（所有图片跳过）后，第 1 页
**58 ms**、第 2 页 **64 ms**——慢的 100% 是图片，不是文字/字体/画布/IO。

逐项真机结果：

| 改动 | 第 1 页 | 画面 |
|---|---:|---|
| 基线 | 8.8 s | 正确 |
| `drawWidth` 封顶 2048（等比） | 9.2 s | 正确但无收益 |
| 再加 SMask base 按 2048 解码 | 5.8 s | **白页/图坏**（alpha 合成尺寸不匹配） |
| 忽略 SMask（诊断） | 4.0 s | 图可见但无透明 |
| worker 前置 `ImageDecoder` shim（`createImageBitmap`） | 4.1 s | 无收益，worker 里拿不到原生解码 |
| 打开 `isOffscreenCanvasSupported` | 11.4 s | 正确但更慢 |
| 跳过所有图片（诊断） | 58 ms | 图缺失 |

结论：pdf.js 在 worker 里用**纯 JS `JpegImage` + 逐像素 SMask 合成**处理
`5816×2044 / DCTDecode / SMask`，439 KB 的 JPEG 仍要熵解码 12M 系数，约 4 s；
SMask 合成再加约 0.8 s。封顶尺寸会破坏 alpha，不能上线；worker 没有原生
`ImageDecoder`/`createImageBitmap`，shim 也不生效。

在“不换渲染器、不预处理 PDF”的前提下，没有安全的优化空间。要真正解决只有
两条路：

1. **一次性预处理**：用 ImageKit 原生解码大图，降采样后重写 image XObject
   流（或生成显示用副本），保留原文件做写回；
2. **换栅格器**：用 PDF Kit 按屏幕分辨率/瓦片渲染页面，替换 pdf.js 的图片
   解码与绘制。

以上实验补丁均已回滚，release 保持“正确但首屏慢”。
