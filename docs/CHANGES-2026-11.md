# OHSidian 变更记录（2026-11）

承接 `docs/CHANGES-2026-10.md`：格式、真机取证习惯（hilog / 模式文件 / 探针）、
六维审计标准（必要性/正确性/安全性/代码质量/架构/耗电性）与 10 月一致。
2026-11 起收录第 196 轮及之后（2.0.1 → 2.1.x → 2.2.0 线的审计、内核升级与 Issue #2 修复）。

## 第 196 轮 (2026-11-02): 手写笔交互回归修复（v40：双击/直线/荧光笔/跳页/写回颜色）

**背景**：M-Pencil 在 PDF 上连续书写后反馈 6 个问题：笔迹停留不变直、荧光笔不是
直线且随压力变粗、跨页滑动偶发回到上一页顶部、字迹出现圆形空缺、双击不再切换
橡皮、笔停在屏幕上会“变成橡皮”。逐条读码定位，均为补丁层可控。

### 一、根因与修复

| # | 现象 | 根因 | 修复 |
|---|---|---|---|
| 1 | 笔迹停留不变直 | 没有直线识别；`smoothPoints` 只做位置平滑 | 新增 **停留变直**：笔尖在笔画末端停约 0.4 s，且整条笔画与首尾连线的最大偏离 ≤ max(8px, 18%) 时，实时吸附为首尾两点直线；提交时写回同样的两点，侧车与 PDF 注释一致。设置里可关 |
| 2 | 荧光笔不是直线、随压力变粗 | `widthFor()` 对所有工具都套压力曲线；高亮笔按采样点描边 | 荧光笔改为**等宽 + 首尾直线**（默认开，可关）：`widthFor` 对 highlighter 直接返回固定宽度；`stroke.straight` 让绘制、侧车、PDF 注释都只保留首尾点 |
| 3 | 跨页缝隙滑动偶发跳回 a 页顶部 | `pagechanging` 里为“恢复页预跳”写的同步 `scrollTop = pageEl.offsetTop` 对**手指滚动同样生效**；反向跨页时 `to = a` 就把滚动条拉回 a 页顶 | 删除 `pagechanging` 中的强制滚动；保留 `pagesinit` 的预跳（只作用于恢复页），探针保留 |
| 4 | 字迹出现圆形空缺（压力大时更明显） | ① `button 5 / buttons & 32` 被无条件当成“笔尾橡皮”，HarmonyOS 笔尖偶尔带出该位，于是这一笔变成**临时橡皮**，用小半径擦出圆洞，抬笔后又变回笔；② 掌托看门狗 2.6 s 无 move 就强制提交，笔尖还压在屏上时会截断笔画 | ① 笔事件只有 `button === 5` **且压力 ≈ 0**（真正的硬件橡皮）才转橡皮；笔尖有压力时永远画；② 看门狗在 `penNativeActive`（原生只在真实抬笔时为 false）期间不触发，超时放宽到 4.5 s |
| 5 | 双击切换笔/橡皮失效 | v20 迁移把默认值从 `pen-eraser` 改成了 `wake`，工具条已展开时双击看起来完全没反应 | 新增一次性 `inkDoubleTapRestore` 迁移恢复 `pen-eraser`；设置选项默认同步；笔画进行中收到的双击/轻捏直接忽略，避免写一半切橡皮 |
| 6 | 写入 PDF 后荧光笔变蓝色、与手写层叠成两色 | PDF Kit 的 `lineColor` 文档是 **0xBBGGRR**（0xFF0000 = 蓝），补丁直接送了 CSS 的 0xRRGGBB：黄色 `#ffd54a` 被解释成蓝紫色 | 新增 `hexToPdfColor()` 做 RGB→BGR 转换后再发；旧注释可用设置里的 **“重写本页标注”** 按钮重写为正确颜色 |

### 二、实现细节

- 直线识别只在“接近直线”时生效，写字时在笔画中间停顿不会把字替换成一条斜线。
- 荧光笔的直线是“起笔 → 当前点”的等宽线段，绘制过程中实时增长；关闭设置后恢复
  自由手绘，但宽度仍不随压力变化。
- 双击恢复后：`eraser → lastPenTool`，其他工具 → `eraser`；`setTool()` 在
  `state.active` 期间拒绝切换，双击/轻捏在笔画中或抬笔 220 ms 内也忽略。
- 写回颜色只改发送给 PDF Kit 的整数值，侧车仍存 CSS 颜色，回读/再写回不受影响。

### 三、产物与验证

| 产物 | 大小/时间 | SHA-256 |
|---|---|---|
| `electron-default-signed.hap`（release，无探针，ink v40） | 121,033,683 B / 2026-11-02 12:16:24 | `707FBFD2B7B17BF0F051192F6C38C06EFBFC2038F3444454FA01F66347F463EE` |

- `node --check scripts/patches/ohsidian-ink.js` OK。
- `update-obsidian --repatch` + `verify-asar` 全绿；`verify-release` →
  `RELEASE VERIFY: OK - no device-agent probe in app.js`。
- 构建时设备（10.0.0.104）离线，**尚未装机复测**；真机回归清单见下。

### 四、待真机回归

1. 画一条略弯的长线，末端停住 → 应吸附为直线；写字中途停顿不应触发。
2. 荧光笔划过一行字 → 等宽直线，用力压不会变粗；关闭“荧光笔直线”后恢复手绘。
3. 在 a、a+1 页之间来回慢滑 → 不再跳回 a 页顶部。
4. 用力连续写字 → 不应出现圆形缺口；笔停在屏上数秒后继续写，笔画应继续而不是消失。
5. 双击笔杆 → 笔↔橡皮切换；写到一半双击不应切换。
6. 在旧页面点“重写本页标注” → 蓝色荧光笔恢复为黄色；或在设置里把“写入 PDF 后”
   改为“隐藏叠加层”，只显示 PDF 注释。

## 第 197 轮 (2026-11-02): 压感橡皮擦（华为笔记同款，v41）

**背景**：上一轮把“笔停屏上一会儿变橡皮”当成 bug 修掉了；用户指出这是华为笔记
的**压感橡皮擦**功能，要求保留并做成可配置 feature。

### 一、华为笔记的官方行为（已核对）

- 华为支持页《在笔记应用中自定义书写样式》：
  > **压感橡皮擦**：连接手写笔后，连续两次点击橡皮擦图标进入设置界面，开启压感
  > 橡皮擦开关并调整灵敏度；书写过程中按压屏幕并稍作停顿即可触发橡皮擦，擦除
  > 内容后抬起手写笔即可继续书写。
- 华为支持页《华为平板笔记在手写笔书写状态下无法触发压感橡皮擦》补充：
  > 需要触发时，用笔点击屏幕**不要移动一段距离**，否则会被判定为书写状态；
  > 压力敏感度 0–100，数值越高越容易触发。

来源：
- https://consumer.huawei.com/cn/support/content/zh-cn16064147/
- https://consumer.huawei.com/cn/support/content/zh-cn15936802/

### 二、实现

- **触发条件**：笔尖按下后（`device === "pen"`，笔/荧光笔工具）满足
  - 距按下点的最大位移 ≤ 9 CSS px（“不要移动一段距离”）；
  - 持续按住 ≥ 0.38–0.7 s（随灵敏度）；
  - 实时压力 ≥ 0.27–0.82 阈值（随灵敏度）；
  - 只在**真实压力**下启用（`pressureMode === "real"` 或样本 `real`）。没有压感的
    设备在停笔时模拟压力会升到 ~0.9，若不拦住会把每次停顿都当橡皮。
- **触发后**：丢弃尚未提交的当前笔画并清空 live 层（避免停顿时留下墨点），把
  `state.active` 原地切换成 `erase` 手势，继续走已有的 `erasePts → eraseAt →
  pushHistory → 标记 PDF 脏页` 链路；抬笔自动回到原笔工具。擦除半径使用设置的
  橡皮半径，可撤销。
- **不会误擦写完的线条**：一旦笔画移动超过 9 px，该笔的监听立即停止；因此在
  线条末尾停顿不会把线擦掉（上一轮“圆形空缺”的主因之一）。
- **设置**：`输入与手势 → 压感橡皮擦`（默认开）与 `压感橡皮灵敏度`（0–100，
  默认 60）。诊断里显示 `压感橡皮=开(60)`。
- 灵敏度映射：阈值 `0.82 − 0.0055×sens`，等待 `700 − 3.2×sens` ms。

### 三、产物

`electron-default-signed.hap`（ink v41）：121,041,872 B / 2026-11-02 12:28:07，SHA-256 `515E0EDF936B3901685F9370AFDF6039A5D596CC05BCAC0437EE7C1DBBBB10C0`。`verify-asar` / `verify-release` 全绿。


## 第 198 轮 (2026-11-02): v40/v41 审计与加固

**审计范围**：`c506c97..b65a739`，`scripts/patches/ohsidian-ink.js` 397 行改动，
覆盖停留变直、荧光笔直线/等宽、跨页跳页、笔停断笔、双击恢复、PDF 写回颜色、
压感橡皮擦与相关设置。

### 一、审计方法

- 逐 hunk 复核指针生命周期、定时器清理、撤销快照、PDF 脏页、设置迁移。
- `node --check`；`update-obsidian --repatch`；`verify-asar` / `verify-release` 全绿。
- 从构建后的 `obsidian.asar` 里解出 `app.js`，确认 `REV=41`、`hexToPdfColor`、
  `pressureEraser`、`inkDoubleTapRestore` 等标记确实进包。
- 对照华为官方“压感橡皮擦”条件（按住不动、压力门槛、抬笔恢复）复核实现。

### 二、发现并修复

| # | 级别 | 问题 | 修复 |
|---|---|---|---|
| 1 | 中 | 硬件橡皮判定仍偏宽：`button===5` 且压力≈0 就转橡皮。部分引擎在**正常笔尖第一帧**会先给 `button=5`、压力尚未上报（0），可能把起笔误判成橡皮 | 笔事件改为 `button===5 && (buttons & 32) && pressure<=0.01` 三条同时成立；普通笔尖有压力时永远绘制。非笔事件保持原逻辑 |
| 2 | 低 | `pagechanging` 强制滚动删除后，`forcingScroll` 标记已无消费者，仍留两处赋值 | 删除两处赋值，避免后来维护者误以为还有同步滚动路径 |
| 3 | 文档 | 第 196 轮只写了“`button===5` 且压力≈0”，与加固后的三条件不一致 | 以本节为准；三条件已写进代码注释 |

### 三、确认无问题的点

- **压感橡皮不会擦掉写完的线条**：`maxTravel > 9 CSS px` 立即停表；线条末尾停顿不触发。
- **定时器无泄漏**：抬笔、`pointercancel`、`blur`、`forceReleaseActive`、触发橡皮五条路径
  都会清理 `holdTimer` / `pressureTimer`；旧 stroke 被替换时定时器也会在 70 ms 内自停。
- **撤销正确**：压感橡皮的 `before` 快照在丢弃未提交笔画之后才拍，undo 回到擦除前，
  不会把等待期间画的那一小段恢复出来。
- **整笔跳转路径**：删除的只是 `pagechanging` 的同步滚动；`pagesinit` 的恢复页预跳保留。
- **写回颜色**：只在 IPC payload 里做 RGB→BGR，侧车仍存 CSS 颜色，回读/再写回不受影响。
- **双击迁移**：只覆盖 `wake`，用户之后在设置里显式改的值不会被再次覆盖。
- **压感橡皮只在真实压力下启用**：避免无压感设备停笔时模拟压力升到 ~0.9 导致误擦。

### 四、仍未真机验证（设备离线）

- 压感橡皮的实际触发手感、双击手势上报、跨页不跳、写回颜色，均需装机复测。
- 风险点：若 WebEngine 在笔尖完全静止时不派发 `pointermove`，压力只在按下瞬间可读；
  灵敏度调低/调高可绕过，后续可接入 ArkTS 压力样本做兜底。
- 本次审计的源改动已随 v46/v47 功能包一起出包（见第 199/200 轮），审计结论对应的 HAP 为 v47。

## 第 199 轮 (2026-11-02): 整笔橡皮 + 一笔成形（鸿蒙）+ 点预测（v46）

### 一、整笔橡皮

- 新增 `inkEraserMode`（`partial` / `stroke`）与 `inkEraserOnlyHl`：
  - **局部擦除**：沿用原来的按半径切分笔迹；
  - **整笔擦除**：橡皮圆碰到哪一笔，整条删除（华为笔记的“擦除整个笔划”）；
  - **仅擦荧光笔**：以上两种模式都只作用于 highlighter。
- **整笔 / 仅荧光笔**模式不再用 `destination-out` 只挖一个圆（那会暂时擦掉下面不该动的笔迹）：按下/移动时直接改 `doc.strokes` 并重绘当前页，
  抬笔时统一写历史；撤销、PDF 脏页、离开时写回都复用原链路。
- 压感橡皮（按住变橡皮）也读取该模式；整笔模式下同样即时删除整笔。
- 设置：`输入与手势 → 擦除方式 / 仅擦荧光笔`；诊断里显示 `橡皮 方式=整笔 · 仅荧光笔=否 · 半径=…`。

### 二、一笔成形（接入鸿蒙 Pen Kit）

- 原生 `electron/src/main/ets/pages/Index.ets`：
  - 新增 `InstantShapeGenerator`（`@kit.Penkit`，API 12+），`setPauseTime(500)`；
  - 只在 renderer 打开 shape 模式时把 `onPageTouch` 的笔事件喂给 `processTouchEvent`；
  - `onShapeRecognized` 只把 **`shapeType`** 通过 IPC `{event:'shape'}` 发回，避免把 ArkUI
    的 `Path2D` 塞进 Web 层；
  - `aboutToDisappear` 时 `release()`；`stylusInfo` 新增 `shape` 支持位。
- 渲染层新增 `buildShapePoints()`：根据 `shapeType` + 当前笔画点集重建几何，支持
  **直线、圆/椭圆、矩形、平行四边形、菱形、等腰/等边三角形、五角星、五边形、抛物线、
  单/双箭头直线、单/双箭头抛物线**（type 1/2/6/7/9/10/11/12/13/14/15–20）。
  - 矩形/椭圆用 PCA 求主轴，支持倾斜；
  - 图形宽度统一（`widthFor` 对 `stroke.shape` 返回固定宽度），不再受压力影响；
  - 识别后 `a.shapeApplied=true`，后续移动不再追加自由点；抬笔按普通笔画提交，
    sidecar 与 PDF 写回都是标准折线；
  - shape 模式与“停留变直”“压感橡皮”互斥：驻留手势留给鸿蒙识别，避免同一停顿触发两种行为。
- 入口：工具条新增 **△ 一笔成形** 按钮（可随时开关），设置里同一开关；默认关闭。
- 诊断：`一笔成形=开/事件数`、`系统 … 一笔成形=支持/不支持`。

### 三、点预测（PointPredictor）

- 原生 `PointPredictor`（`@kit.Penkit`）：笔移动时按 ≥12 ms 节流取预测点，IPC 发
  `{event:'penPredict', x, y}`；`predict` 支持位随 `stylusInfo` 上报。
- 渲染层只在 **live 层** 画预测尾巴：
  - 由 `requestLiveFrame` 把预测点转成 surface 坐标后拼在真实点后临时绘制；
  - 上限 18 surface 单位、后退方向丢弃、80 ms 过期自动清掉；
  - **不写入** `stroke.pts` / sidecar / PDF，实点到达即被真实笔迹替换；
  - `pdfembed`（归一化坐标）暂不启用，避免单位混用。
- 设置：`输入与手势 → 笔迹预测（实验）`，默认关闭；诊断显示 `预测=开/事件数`。

### 四、构建与验证

- `node --check` OK；`update-obsidian --repatch` + `verify-asar` + `verify-release` 全绿。
- HAP（release，无探针）：

| 产物 | 大小/时间 | SHA-256 |
|---|---|---|
| `electron-default-signed.hap`（ink v46） | 121,065,492 B / 2026-11-02 16:14:06 | `F3924351281AC4C1E4D928A7ED2DB42160D0C5BFF9DD62707E7A2EF3236092D1` |

- 设备仍离线（10.0.0.104 不通），**未装机验证**。

### 五、待真机确认

1. 整笔橡皮：局部/整笔/仅荧光笔三种组合，撤销与 PDF 写回是否一致。
2. 一笔成形：△ 打开后画线/圆/矩形/箭头，停顿半秒是否变标准图形；若原生识别不出，
   看诊断 `一笔成形` 事件数是否增加（增加=分类到了但几何被拒；不增加=引擎没回调）。
3. 点预测：打开后跟手是否改善、是否出现回弹/尾巴滞后；不好用就保持关闭。
4. 已知限制：几何由本地拟合而非原生 `shapeString`，旋转矩形/椭圆已用 PCA，但三角形/星形
   仍是正立；如需完全复刻鸿蒙形状，后续再解析 `shapeString`。

## 第 200 轮 (2026-11-02): 套索选择 / 移动 / 副本 / 删除（v47）

### 一、行为

- 工具条新增 **◌ 套索**。用笔或手指圈住笔迹后：
  - 选中笔迹出现虚线选框，右上角浮出 **副本 / 删除 / 取消**；
  - 在选框内拖动即可整组移动；
  - 副本偏移复制、删除整组、取消只清选择；全部可撤销。
- 只选中**同一页/同一手写空间**的笔迹；高亮笔、普通笔、已写回 PDF 的笔迹都可以选。
- 选择在以下时机自动清除：切换工具、滚动/缩放、切叶子、撤销/重做、清空本页、表面重建。
- 套索路径用 CSS 分辨率的全屏虚线画布，不分配设备像素比大小的画布；选框用 DOM 定位，
  不参与页面重绘。

### 二、实现要点

- `spaceToClient` / `clientToSpace` 按表面类型分流：PDF 用 `entry.viewport` + 页面 rect；
  Markdown/Canvas 用 `toCanvasPoint` + 根节点 rect；PDF Embed 用页面 rect。
- 命中：多边形内点占比 ≥50% 或点集中心在圈内；选中后自动补 `id`（兼容旧侧车）。
- **移动不原地改已提交 stroke**：历史快照存的是引用，所以每次移动手势第一次真正位移时，
  把选中笔迹替换成新 id 的克隆再平移；`before` 快照仍指向原对象，undo 能正确恢复，
  多次移动也不会污染更早的 redo `after`。
- 副本/删除/移动都会 `pushHistory` + `saveSoon`，PDF 标记脏页并在离开时重写；
  PDF Embed 只调度写回，不走 `pdf:` 脏页表。
- 移动时按 16 ms 节流重绘当前页；选框同步跟手。

### 三、构建与验证

- `node --check` OK；`update-obsidian --repatch` + `verify-asar` + `verify-release` 全绿。
- HAP（release，无探针）：

| 产物 | 大小/时间 | SHA-256 |
|---|---|---|
| `electron-default-signed.hap`（ink v47） | 121,081,876 B / 2026-11-02 16:31:55 | `B3BACF0C49B3860E421A580FA1C184938E35BA04384C01A9CFCDE1119C54A857` |

- 设备仍离线（10.0.0.104 不通），**未装机验证**。

### 四、已知限制 / 待真机

- 套索只选**墨迹**，不选 PDF 文本或 Markdown 文字（文本仍用指针工具）；
- 不支持跨页/跨文档选择，也不支持旋转/缩放选框；
- 滚动会清除选择（避免选框与页面脱节）；
- 真机重点看：PDF 页面套索坐标是否准、移动后写回是否只更新本页、指纹/笔尖在
  “副本/删除/取消”按钮上是否能正常点击。

## 第 201 轮 (2026-11-02): 高亮笔写回宽度与双层叠色修复（v49）

### 一、根因

1. **双层叠色**：`inkWritePdf` 成功后只把 `written=true`，从未把 `baked=true`。`redrawPage`
   里 `if (st.baked && !showBaked) continue` 永远不生效，所以叠加层一直画着高亮笔，
   同时 PDF 注释的 appearance stream 也被 pdf.js 画出来 → 0.38 的透明色叠成两层，
   明显变深。
2. **宽度不匹配**：高亮笔之前写成 `/PolyLine`，`borderWidth` 交给 PDF Kit 生成
   appearance stream。pdf.js 实际显示的是这份 appearance，不是 polyline 的 SVG
   （pdf.js 把 polyline 的 `stroke` 固定成 `transparent`）。appearance 的线宽与叠加层
   的 `widthFor()` 不是同一套换算，于是屏幕和 PDF 的宽度对不上。
3. **旧注释**：v48 以前写出的高亮笔都是 polyline，没有记录“已改成 quad”的标记。

### 二、修复

- **PDF 侧改成 `/Highlight` quad 条带**（`PdfInkWriter.highlightQuads()`）：
  - 每个线段按法线扩半个笔宽，生成 `UL, UR, LL, LR` 四点；
  - 宽度直接用 `stroke.width`（PDF 单位），和叠加层 `stroke.width * viewport.scale`
    完全同源，因此宽度精确一致；
  - 只对 `highlighter && !normalized` 使用；单点退化时回退 polyline；
  - payload 新增 `tool`，native `PdfInkStroke` 同步。
- **写入成功后标记 baked / pdfHl**：
  - `written=true`、`baked=true`；高亮笔另加 `pdfHl=true`；
  - `redrawPage` 只在 `annotationFresh`（pdf.js 已加载新注释层）时跳过已 baked 的
    高亮笔；普通笔迹仍按设置保留叠加层；
  - 擦除/套索/移动时强制显示 baked 高亮笔，保证预览和选择可见；
  - 写入后把 `annotationFresh=false`，避免“文件已换、pdf.js 还是旧注释层”时把
    刚写的荧光笔从叠加层里藏掉；下次 `pagesinit`（重新加载 PDF）恢复 true。
- **旧高亮笔自动迁移**：侧车里 `highlighter + written && !pdfHl` 的笔画会被标记为
  `written=false`、`baked=false`，下一次离开/后台写回时用 quad 重写；重写后
  `pdfHl=true`，再加载即只显示 PDF 注释。也可用设置里的 **“重写本页标注”** 立即触发。
- 设置文案同步：高亮笔写回后只显示 PDF 的 `/Highlight`，不再和叠加层叠色；普通笔迹
  仍可选“保留/隐藏叠加层”。

### 三、产物

| 产物 | 大小/时间 | SHA-256 |
|---|---|---|
| `electron-default-signed.hap`（ink v49） | 121,095,537 B / 2026-11-02 19:29:42 | `12DE220325470BE731FAB7070F8114591F0BF52B5FBCF409BDC2C000EF139F5D` |

- `node --check`、`update-obsidian --repatch`、`verify-asar`、`verify-release` 全绿。
- 按你的要求，**没有安装/操作设备**；未做真机验证。

### 四、使用 / 待确认

1. 旧页面：打开 PDF → 设置 → PDF 与诊断 → **重写本页标注**，然后离开/重开 PDF；
   或直接离开 PDF 让自动写回在后台转换。转换后叠加层不再画高亮笔，只剩 PDF 注释。
2. 新画的高亮笔：写回后重开 PDF，应只有一份、宽度与屏幕上一致、颜色不加深。
3. 如果重开后高亮笔**完全不可见**，说明该阅读器不显示 `/Highlight` appearance，
   把诊断和现象发我，我再改成“隐藏 PDF 注释 + 只留叠加层”的路线。
4. 普通笔迹的双层是黑色不透明，视觉上无叠色；如果也想只留一份，把“写入 PDF 后”
   设为“全部只显示 PDF 注释”。

## 第 202 轮 (2026-11-02): 设置开关“按半天没反应”——手写开关不是 `<label>`，热区只有左上角 15px（补丁 190）

**用户报告**：设置里那个开关按钮点不动；原本的开关按动都正常，新加的这个按半天没反应。

### 一、真因（读 asar 内 app.js + 内核 app.css 确认）

Obsidian 自己的开关（`app.js` 里 `ToggleComponent`）是这么造的：

```js
controlEl.createEl("label", {cls:"checkbox-container", attr:{tabIndex:0}}, e => {
  e.createEl("input", {attr:{type:"checkbox", tabIndex:-1}});
  e.addEventListener("change", ...);
})
```

我们手写的开关是 `<div class="checkbox-container">`，其余完全一样。**差别就是热区**：

| 规则 | 位置（内核解包 app.css） | 后果 |
|---|---|---|
| `.checkbox-container input[type='checkbox']{position:absolute;opacity:0;left:0}` | 10100 | 真 input 被压到**左上角**且透明 |
| `input[type=checkbox]{width:var(--checkbox-size);…}`；`.modal{--checkbox-size:var(--font-ui-medium)}` | 14009 / 8928 | 该 input 只有**约 15×15** |
| `.modal .checkbox-container{width:var(--toggle-width);height:…}`；`.is-mobile{--toggle-width:52px;--toggle-thumb-height:26px}` | 10151 / 18836 | 开关本体是 **52×30** |
| `.checkbox-container:after{pointer-events:none}` | 10122 | 看得见的圆钮**不吃点击**，直接穿透到容器 |

于是 `<div>` 版整行只有左上角那块看不见的 15×15 能命中；点在圆钮上等于点在背景上。
`<label>` 会把落在它身上**任意位置**的点击转发给内部 input —— 这就是原生开关“点哪儿
都灵”的全部秘密，没有任何额外 JS。

**为什么“旧的正常、新加的没反应”**：圆钮在**关**状态位于左侧，正好压在 input 上，
点圆钮能开；一旦打开，圆钮移到右侧，而 input 仍在左上角，可见的圆钮就**永远点不到**。
所有手写行其实都是坏的，用户卡在“已经是开”的那一个上（新加的那个多半刚被点开过，
或者本来默认就是开）。

**排除项**：

- 不是事件没绑上：`change` 一直在 input 上，且 `is-enabled` 的类名更新在回调**之前**，
  所以“连视觉都不变”只能是点击没落到 input。
- 不是 BUG-005 那种拖动区吞点击：`.checkbox-container` 自带 `-webkit-app-region:no-drag`
  （app.css:10086）。
- 同一模态里原生开关能用 == 该引擎的 label 激活行为可用，而这正是本修复依赖的机制
  （也是唯一与该引擎有关的假设）。

### 二、修复

| 文件 | 改动 |
|---|---|
| `scripts/patches/touch-mode.js` | 新增 `ohsidianMakeToggle()`：`<label class="checkbox-container" tabindex="0"><input type="checkbox" tabIndex="-1"></label>` + `change` + 空格/回车，与 `ToggleComponent` 完全对齐。OHSidian 页与「手写笔」页（`ctx.toggleEl` 交给 `buildSettings`）**共用**它，两处手写副本删除 |
| `scripts/patches/touch-mode.js` | `OHSIDIAN_PATCH_REV` 189 → **190**（诊断里“补丁 190”即本版） |
| `scripts/verify-asar.cjs` | 新门禁 `app settings switches are labels`：helper 在、两处调用点都在（`===2`）、旧 `mk("div","checkbox-container` 为 0 |
| `scripts/refresh-app-patch.mjs` | 顺带修掉一个会静默丢功能的缺陷（见下） |

**`refresh-app-patch.mjs` 的缺陷**（本轮使用它时触发）：`app.js` 前缀是 `INK + TOUCH`，
而 `/*OHSIDIAN-PATCH-END*/` 是 **TOUCH 块**的结束标记，脚本按它切片就会把 ink 块一起
切掉，然后只重新拼 TOUCH —— 出来的 app **完全没有手写/PDF 墨迹**，只有 `verify-asar`
的四条 ink 检查会报红（且 `verify-asar` 是在 asar 已被覆盖之后才跑，坏包已经落盘）。
现改为“原样保留 ink 前缀、只替换 touch 块”，边界找不到就 abort。

### 三、审计（六维）

| 维度 | 结论 |
|---|---|
| 必要性 | 症状是“点不动”，根因在 DOM 结构；改回调或加 `onClick` 都是治标，label 才是与主题 CSS 配套的正确结构 |
| 正确性 | 与 `ToggleComponent` 的标记、焦点归属（label `tabindex=0` / input `tabIndex=-1`）、键盘绑定逐项对齐；`is-enabled`、`change`、`onChange(on)` 语义未变 |
| 安全性 | 不改任何 `onChange` 回调与偏好读写；不做全局监听；回退只需 revert 该文件并 repack |
| 代码质量 | 两处重复实现合并为一个 helper（原来 main 页与手写笔页各写一份，正是这类分叉导致行为不一致）；注释带 CSS/源码出处 |
| 架构 | helper 由 `ohsidianSettingsRows` 与 `buildStylusTab` 共用，后续新增开关不会再各写一遍；verify-asar 门禁防止回退 |
| 耗电 | 每个开关多 1 个 keydown 监听、无定时器、无重绘；设置页一次性创建，页面关闭即随 DOM 回收 |

**逐项核对**：

- **不会双触发**：直接点在 input 上时，浏览器不会再把 label 的激活转发一次；键盘路径用
  `e.target!==box` 排除“输入框已聚焦时空格被原生机理处理”的情况。
- **布局**：`.checkbox-container` 自带 `display:inline-block`，`label` 默认 `inline` 被覆盖；
  行容器、`mod-toggle` 类、间距都不变。
- **无障碍**：仍是内嵌 `input[type=checkbox]`，role/checked 状态不丢；多了 label 焦点环
  （`app.css:10133` 的 `:focus-visible`）。
- **`onChange` 抛错**：类名先更新、异常照旧上抛（不加 try/catch，避免把坏设置吞掉）；
  与改动前一致，没有新增失败点。
- **影响面**：仅 OHSidian 与「手写笔」两页的开关；其它 UI、工具条、笔输入链路未动。
- **全仓库盘点**：`checkbox-container` 只有这两处手写实现，均已收敛到 helper。

### 四、构建与验证

- `node --check`：`touch-mode.js` / `ohsidian-ink.js` / `verify-asar.cjs` / `refresh-app-patch.mjs` 全 OK。
- `node scripts/update-obsidian.mjs --repatch`（离线，用缓存的 1.13.7 内核）→ 安装成功。
- `verify-asar`：全绿，含新门禁 `app settings switches are labels`（`SYNTAX OK | all markers present`）。
- `verify-release`：`OK - no device-agent probe in app.js`。
- 包内实证（解 asar 读 app.js）：`ohsidianMakeToggle` 存在、`var toggleEl=ohsidianMakeToggle`
  两处、`mk("div","checkbox-container` 0 处、`OHSIDIAN_PATCH_REV="190"`、`OHSIDIAN_INK_REV="49"`。
- **未出 HAP**：本轮只改渲染层补丁与构建脚本，asar 已刷新；仍需按平常流程构建 HAP 才能上机。

### 五、待真机确认

1. 手指点开关的**圆钮/轨道任意位置**都应立即翻转并落盘（这是本轮的直接验收点）。
2. 键盘：Tab 到开关后空格/回车能切换。
3. 若“还是没反应”，先确认是不是**用笔尖**点的：笔落在设置面板上被
   “笔不误触 Obsidian 自身控件”策略拦截（`ohsidian-ink.js` 里 `isExcluded` 的笔分支，
   `docs/STYLUS-PEN.md:13`），属设计行为，请用手指；如需设置面板接受笔点，需另行
   修改该策略（一行判定），本轮未动。

## 第 203 轮 (2026-11-02): 工具条精简 / 颜色收敛 / 一笔成形正方形修复（v54）

### 一、工具条精简与可配置

- 默认工具条现在只有 **笔、高亮笔、橡皮、颜色、⋯、收起**；指针、一笔成形、套索、
  撤销/重做、笔宽滑杆默认隐藏，符合 Obsidian 的克制风格。
- 设置新增 **“工具条”** 分组，可逐项显示：笔、高亮笔、橡皮、颜色按钮、指针、一笔成形、
  套索、撤销、重做、笔宽滑杆。
- 隐藏的工具仍可从工具条的 **⋯** 菜单打开（菜单按当前 barItems 自动补齐缺失项），
  所以不会出现“关掉后找不回来”。
- 笔宽/高亮笔宽度从工具条移到设置，避免默认占据横向空间；仍可选显示滑杆。

### 二、颜色收敛与默认色显示

- 调色盘从 5 色减到 **3 色**：黑、红、蓝；设置里也是 3 个色块。
- 工具条不再排一行色点，改为 **一个颜色按钮**：
  - 圆点显示当前笔/高亮笔颜色；
  - 自动跟随主题时显示半黑半白圆点 + 右下角小 **A** 徽标；
  - 点按在“自动 → 3 个预设”之间轮换；
  - 长按打开系统取色器（自定义色）。
- 高亮笔另有 3 个预设（黄、绿、蓝），同样由这个按钮轮换；自定义色仍在设置里。
- 修复旧实现每次重建工具条都会往 body 追加一个隐藏 `<input type=color>` 的泄漏。

### 三、一笔成形（正方形/矩形）

- **根因 1：PCA 对正方形退化**。正方形协方差两个特征值相等，主轴角度任意，
  之前“旋转矩形”会把正方形画成斜的/菱形。改用 **凸包 + 最小面积矩形（旋转卡壳）**，
  矩形会贴合实际边；菱形也用同一个 OBB。
- **根因 2：`notifyAreaChange(1000,1000)` 把 3:2 平板当成正方形**。已按实际宽高比
  改成 `1000 × round(1000*h/w)`，让引擎在正确的坐标系里判定形状。
- 若鸿蒙把闭合方框识别成“折线（type 3）”，现在会检测首尾闭合并按矩形重建；
  type 0 的闭合笔画也走同一兜底。
- 原生回调晚于抬笔时，渲染层还有一层**本地兜底**：闭合且四个角都有笔迹 → 矩形；
  闭合且径向方差小 → 圆/椭圆。这样即使鸿蒙没来得及回调，正方形也不会还原成手绘。
- 保留 `shapeString` 未解析的现状：目前只用原生 `shapeType` 分类，几何在本地重建。

### 四、代码审计发现并修复

| # | 问题 | 修复 |
|---|---|---|
| 1 | `applyNativeShape` 的前置条件把 type 0 挡掉了，闭合兜底永远不会执行 | 改为只要求 `shapeMode`，type 0/3 再按闭合判定 |
| 2 | 原生面积固定 1000×1000，正方形在 3:2 屏幕上被压扁 | `onAreaChange` 传 `1000 × h/w` |
| 3 | 旧高亮注释标记 `written=false` 后没有任何调度，永远不会重写 | PDF surface 创建时检查待重写高亮笔并 `schedulePdfWrite` |
| 4 | 颜色按钮长按后 pointerup 仍会轮换一次颜色 | `cycleColor` 检查并消费 `_inkLongPress` |
| 5 | 每次 `buildToolbar` 都新建隐藏 color input | 固定 id，只创建一次 |
| 6 | `rebuildToolbar` 后 `menuOpen` 可能残留 | 重建时复位 |
| 7 | 工具条内容全部关掉会没有绘图入口 | 启动时保证至少一个笔类工具；⋯ 菜单始终补齐隐藏工具 |

### 五、产物

| 产物 | 大小/时间 | SHA-256 |
|---|---|---|
| `electron-default-signed.hap`（ink v54） | 121,111,296 B / 2026-11-02 20:03:11 | `5F0F27C1CFB39739C7260312164E7DD7804150902D28C14FE73FB315DD2A6980` |

- `node --check`、`update-obsidian --repatch`、`verify-asar`、`verify-release` 全绿。
- 按你的要求未安装、未操作设备；以下项需真机确认：
  1. 工具条默认外观、设置逐项开关、⋯ 菜单补齐；
  2. 颜色按钮点按/长按、自动色 A 徽标；
  3. 画正方形/矩形是否贴合、旋转矩形是否保持角度；
  4. 旧高亮页重写后是否单层且宽度一致。

## 第 204 轮 (2026-11-02): 荧光笔置底/PDF 文字混合、注释偏移与坐标原点（v57）

### 一、荧光笔覆盖黑色笔迹变淡

**根因**：所有表面的 `redraw` 都按 `doc.strokes` 的插入顺序绘制。后画的高亮笔
（`globalAlpha=0.38`）会盖在之前的黑色笔迹上，屏幕合成后黑色就发灰/发黄。

**修复**：所有落盘绘制改成两遍：

1. 先画 `tool === "highlighter"`；
2. 再画笔/其他。

覆盖 PDF 页、Markdown 瓦片、Markdown 旧单画布、Canvas 瓦片、PDF Embed 底图。
PDF Embed 的 `appendStroke()` 遇到高亮笔返回 `false`，强制整页有序重绘，避免
增量追加时又盖到黑字上。

PDF 写回 payload 也把高亮笔排到最前面，外部阅读器里高亮注释同样位于笔迹下方。

**补充：PDF 内文字的黑字**。如果黑色是 PDF 页面里的印刷文字，两遍绘制并不能解决——整块墨迹画布仍然以 source-over 盖在 PDF 页面上。现在 PDF 页的 base/live 画布在**浅色页面**上设置
`mix-blend-mode: multiply`：黑色文字乘荧光色仍是黑色，只有白纸被染色；高亮笔在 PDF
文字上不再像蒙了一层黄膜。深色页面保持 `normal`（否则浅色自动墨会变黑），PDF Embed
也同步。是否浅色由页面背景亮度判断（`--pdf-page-background`/`backgroundColor`）。

### 二、笔迹与 PDF 注释偏移

**根因 1**：`toSpaceOn()` 用 `pageEl.getBoundingClientRect()` 计算落笔坐标，
但墨迹 canvas 位于 page 的内容盒（`left:0;top:0`）。页面一旦有 border/padding
或 CSS transform，就把整页注释整体推移 1–2px。

**修复**：统一以 `entry.cv.getBoundingClientRect()` 为基准，并用
`entry.w / rect.width` 处理缩放；`_spaceRect`、PDF 橡皮预览、套索选框的
`spaceToClient()` 全部同步。这样屏幕笔迹和写回坐标来自同一个画布矩形。

**根因 2**：PDF.js 返回的是含 CropBox 原点的绝对 PDF 坐标，而 PDF Kit 的
`PdfPage` 坐标从 `0,0` 起。CropBox 原点非零时，写出的注释会整体偏移。

**修复**：写回时读取 `pageView.viewport.viewBox[0..1]`，从每个点减去原点
（`originX/originY`，通常为 0；只有 PDF 才有）。旧注释用“重写本页标注”重写
一次即可归位。

### 三、审计

- 两遍绘制覆盖了所有会长期保留笔迹的 canvas；live 层仍是当前笔，抬笔后整页重绘。
- `appendStroke` 的高亮笔回退路径已检查：`inkAddStroke` 收到 false 后会
  `inkAfterDocChange` 全量重绘。
- `toSpaceOn` / `erasePreview` / `spaceToClient` 三处坐标基准已统一，避免只修一处。
- `viewBox` 读取失败时 `origin=0`，保持旧行为，不会把正常 PDF 推偏。
- `origin` 只作用于 `isPdf` 的 vector payload，不影响 PDF Embed 的 normalized 坐标。

### 四、产物

| 产物 | 大小/时间 | SHA-256 |
|---|---|---|
| `electron-default-signed.hap`（ink v57） | 121,115,390 B / 2026-11-02 20:28:33 | `323AEC81FBD0B3725AEB7C4CAF110D7634A6D2C2A44F398D981E39F75E9FB83D` |

- `node --check`、`update-obsidian --repatch`、`verify-asar`、`verify-release` 全绿。
- 按你的要求未安装、未操作设备；需真机确认：
  1. 荧光笔盖住黑色笔迹时黑色不再变淡；
  2. PDF 写回后笔迹与注释是否重合；
  3. 旧页面重写后是否归位。

## 第 205 轮 (2026-11-02): 手写特性回归评测 + 宣传素材流水线（ink v58）

### 一、目标

发版前手动跑一遍，确认增量代码没有破坏既有手写功能；同时把每个功能录成
MP4 + GIF，自动生成酷安/B 站可直接用的文案与素材清单。

### 二、实现

新增 `scripts/stylus-eval/`：

| 文件 | 作用 |
|---|---|
| `run.mjs` | CLI：`list` / `capture` / `gate` / `--selftest`；人工引导逐场景录制 |
| `manifest.mjs` | 12 个场景：原版行为、我们的行为、操作步骤、探针、断言、宣传文案 |
| `lib/device.mjs` | hdc 封装：设备发现、launch/force-stop、install、file send/recv、时钟偏差、能力探测 |
| `lib/capture.mjs` | 录制策略：`screenrecord` / `snapshot_display` 帧 / fixture；切片、GIF、封面 |
| `lib/logs.mjs` | hilog 解析：`probe:<name> {json}` + `PdfInk` 等原生行，按 `_ts` 归档 |
| `lib/checks.mjs` | 声明式断言：count / value / ratio / exists / absent / sequence / manual |
| `lib/report.mjs` | `REPORT.md`（技术报告）+ `PROMO.md`（酷安/B 站文案与素材清单） |
| `fixtures/` | 测试仓库：空白练习页 + 手写生成的上半页印刷黑字 PDF |

### 三、新增探针（release 构建由 stripDevProbeCalls 剥离）

`inkStroke`（压力/线宽/点数/时长/straight/shape/predict/blend）、`inkErase`
（mode/removed/changed/ms）、`inkShape` + `inkShapeGuess`、`inkLasso` +
`inkLassoAction`、`inkPredict`、`inkTool`、`inkPref`、`pdfBlend`、
`pdfEmbedBlend`；`pdfPayload` 补 `hl`/`tools`/`originX/Y`。

`probeHook()` 统一写入 `_ts`（渲染层 `Date.now()`），解决 hilog 前缀只有
秒级设备时间、无法把事件映射到场景窗口的问题。

### 四、门禁与基线

- 断言只写不变量（压力到达渲染层、线宽比 >1.35、整笔橡皮 removed>=1、
  PDF 载荷 hl>=1 且写回 ok=true 等），绝对值只进报告。
- 缺探针直接失败：防止装错 release 构建或改动删掉探测点。
- `--bless` 记录 `baseline.json`，之后 gate 对偏差 >50% 打警告；
  `--strict-drift` 升级为失败。
- 录制自动降级：无 `screenrecord` 时用截图帧（带真实时间戳），
  GIF >9.5MB 自动降分辨率重编。

### 五、验证

- `node scripts/stylus-eval/run.mjs --selftest`：合成 120 帧 + 伪造 10 条探针，
  跑通“解析 → 断言 → 切片 → GIF → 报告”，负向用例按预期失败 → `SELFTEST PASS`。
  产物 `artifacts/stylus-eval/selftest/`（仅链路验证，不能宣传）。
- 场景清单与断言见 `scripts/stylus-eval/manifest.mjs`；使用说明见
  `docs/STYLUS-EVAL.md`。
- 按你的要求**没有联机设备**：真机 `--mode capture` / `--mode gate` 尚未执行。

### 六、注意

- `docs/RELEASE.md` 的发布步骤已加入手写回归门禁。
- `artifacts/` 与 `scripts/stylus-eval/config.local.json` 已 gitignore。
- 本轮只改了探针与评测脚本，未重新构建 HAP；发版前仍需按常规流程构建，
  并用 `verify-release.cjs` 确认 release asar 无探针残留。

## 第 206 轮 (2026-11-02): 平板全屏窗口被浮窗记忆尺寸撑不满（BUG-003）

### 一、现象

真机（BKY-W10，2800×1840，dpr 2.25）冷启动后 Obsidian 只占左上
`1960×1593` 物理像素，右侧和下方露出桌面；顶部只剩系统浮窗的三点手柄，
没有标题栏/最大化按钮。用户描述为“画面不全屏”。

### 二、诊断（hilog + WMS + 文件）

- `window_pcmode_switch_status` 读出 `false`，所以 ArkTS 走触摸分支：
  `layout fullscreen true applied for pcMode=false`、`decor=none`、隐藏系统标题栏。
- 但 WMS 明确是自由多窗：`NotifyFreeMultiWindowModeResume: IsPcMode 1`。
- 引擎把 BrowserWindow 尺寸记在 `<filesDir>/<vaultId>.json`：
  `{"x":142,"y":137,"width":869,"height":706,"isMaximized":false}`。
  869×706 是 **DIP**，×2.25 正好是 1955×1588 ≈ 1960×1593。
- 引擎启动时 `setBounds skipped: window 1 is fullscreen on touch form factor`，
  于是窗口矩形是 2800×1840、内容却按记忆的 869×706 DIP 创建；
  ArkUI `windowRect` 与 `getWindowStatus()` 都报全屏，掩盖了真实内容尺寸。

### 三、修复

1. 新增 `inWindowForm()`：`pcModeEnabled || getWindowStatus() 为
   FLOATING/SPLIT_SCREEN`。decor、视口、`forceFullscreenWindow()`、
   `setWindowLayoutFullScreen()`、`ohsidian-mode.json` 的 `systemMode`
   全部改为按这个形态判断，避免“系统是浮窗、我们按触摸全屏处理”。
2. 新增 `repairTouchWindowState()`：在 `loadContent` 启动引擎**之前**，
   仅当 `deviceType=tablet`、非 PC 模式、窗口状态不是 FLOATING/SPLIT 时，
   把**当前打开仓库**的 `<vaultId>.json` 校正为
   `x/y=0`、`width=display.width/dpr`、`height=display.height/dpr`、
   `isMaximized=true`。这里必须写 DIP：上一版误写 2800×1840，
   引擎按 2800 CSS px 建页，`innerWidth=2800 @dpr 2.25`，整个 UI 被放大裁切。
3. 自由窗口形态下跳过 `enforceFrameStyle()` 的 1s 复位，系统标题栏
   （拖动/最大化入口）不会被应用自绘边框样式重新藏掉。

### 四、验证

- 冷启动 hilog：
  `touch window state repaired: 2800x1840 -> 1244x818 dip (2800x1840 px @2.25)`
  → `InkUI boot ... "viewport":[1244,820],"dpr":2.25`
- 截图：内容铺满 2800×1840，文字尺寸恢复正常，桌面不再露出。
- 连续两次冷启动均正常（状态文件已是 `1244x818/isMaximized:true`）。
- HAP：121,129,970 B / 2026-11-02 22:52:22，
  SHA-256 `31FF899A15F2A060A7DEB0CD5771B1394531599F23B9586BA8F4964E889E7C64`。

### 五、注意

- 该状态文件是 Electron 的 DIP 单位；以后改窗口尺寸不要写物理像素。
- 真正的自由窗口（`getWindowStatus()` = FLOATING）不校正，保留用户尺寸。
- 本轮 HAP 仍是 release 构建（探针被剥离）；手写回归需要另做 `--agent` 构建。

## 第 207 轮 (2026-11-02): 2in1 安全复核 + 手写评测扩到 18 场景

### 一、窗口修改的 2in1 / PC 复核

第 206 轮的 `freeWindowForm()` 用了 `getWindowStatus()`，但 `pcModeEnabled`
在 2in1 上本来就是 false（H15 跳过读取），如果直接把 FLOATING 当平板自由窗口，
会带来三处桌面回归：

1. `pushSafeAreaInsets()` 走 caption 分支，强制系统标题栏盖掉 Obsidian 自绘标题栏
   （BUG-002 的双标题栏）；
2. `computeViewportBound()` 从 windowRect 改为 drawableRect，底部/右侧视口变化；
3. `enforceFrameStyle()` 的 1s 复位被跳过，用户选的「隐藏边框」失效。

修复：`freeWindowForm()` 只对 `tablet`/`phone` 生效；`forceCaption` 只在
`freeWindowForm() && !pcModeEnabled` 时为 true；`enforceFrameStyle()` 的跳过
也加了 `!pcModeEnabled`。2in1 上 `inWindowForm()` 恒等于 `pcModeEnabled`，
decor/视口/边框复位全部回落到修复前的分支。没有 2in1 真机，属静态审查；
平板（BKY-W10）复测全屏正常，`viewport:[1244,820] dpr:2.25`。

### 二、评测场景 12 → 18

新增：

| id | 功能 | 关键探针 |
|---|---|---|
| `markdown-highlighter` | Markdown 荧光笔（非 PDF） | `inkStroke` |
| `undo-redo` | 手写墨迹撤销/重做 | `inkHistory`（新增） |
| `pdf-embed` | Markdown 内嵌 PDF 手写 | `pdfEmbedBlend`、`pdfPayload` |
| `canvas-ink` | Canvas 白板手写 | `inkStroke` |
| `eraser-hl-only` | 只擦荧光笔 | `inkErase(mode=hl)` |
| `palm-rejection` | 掌托防误触 | 人工目视 |

配套探针：`inkUndo`/`inkRedo` 发 `inkHistory{op,n,left}`，清空本页发
`inkClear{space,removed}`。素材新增 `03-embed.md`（内嵌 PDF）与
`04-canvas.canvas`。

### 三、真机链路

- `--agent` 包安装后 `--mode doctor` 全绿：
  `agent build ink 58 · 1244x820 @2.25x`、`screenshot snapshot_display`、
  `clock offset ~735 ms`、hilog 5–7k 行、截图 201 KB。
- 修正 `snapshot_display` 只接受 `.jpeg` 后缀（`.jpg` 报 invalid），
  并在 `Device.screenshot()` 加重试，避免刚写完就 recv 拿到 0 字节。
- 本机 `screenrecord` 不存在，录制自动降级为 `snapshot_display` 帧模式。

### 四、产物

- release HAP：121,133,855 B / 2026-11-02 23:12:13，
  SHA-256 `C6ABF8639A572DC2E7DC92D426E96D691AB1C23499835512625BAF7F93E07C19`。
- `verify-release` / `verify-asar` 全绿。
- 设备上当前装的是 `--agent` 包（供评测），release 包需另装。

## 第 208 轮 (2026-11-03): PDF 写回整体左下偏移——停止重复减 CropBox 原点

### 一、现象与证据

用户报告：荧光笔和画笔写回 PDF 后，墨迹整体**向左下**移动，距离很大。
真机 hilog（BKY-W10，16:07）显示该书页：

- CSS 画布 `w=1230,h=1759 @scale=2.881` → PDF 页面 **427×610 pt**；
- 427 = 595 − 84×2，610 = 842 − 116×2，说明页面是
  `MediaBox 595×842` + `CropBox [84,116,511,726]` 的裁切书页；
- `pdfAnnoInfo` 里既有 `/Highlight` 也有 `/PolyLine`，两类注释同时偏移，
  排除 quad 顺序问题。

根因：`inkWritePdf` 的 payload 先 `convertToPdfPoint`（得到含 CropBox 原点的
**绝对**用户坐标），又减了一次 `viewport.viewBox[0..1]`。PDF Kit 的
`PdfPoint` 本身就是页面用户坐标，于是每条注释都被减掉 (84,116)，表现为
**左移 84 pt、下移 116 pt**，且两类工具共用同一段代码。

### 二、修复

- payload 不再减 `originX/originY`，保留这两个值只用于 `pdfPayload` 探针；
- 旧注释的 sidecar 点本来就是绝对坐标，下一次“写回本页/重写标注”会用
  同样的绝对坐标重建注释，不需要迁移；
- 新增 2.0.0 版本号（`versionCode=2000000`），这是手写线独立成 v2.x 的起点。

### 三、验证

- `old subtract=false / new push=true`（asar 检查）；
- agent 包已安装，等待真机复测：同一 PDF 页画一笔，写回后应不再偏移。
- 若仍有偏移，下一步给 `pdfPage` 探针加 `MediaBox/CropBox/Rotate` 原值，
  直接确认是页面盒还是旋转问题，不再猜。

## 第 209 轮 (2026-11-03): PDF 自己往下滑 = 性能探针；agent 包独立打包

### 一、“PDF 自己往下滑”的根因

不是写回坐标，也不是 PDF.js 自己滚，是 **agent 构建里的性能探针**：

`install()` 启动 12s 后，如果当前表面是 PDF，会跑一段 `pdfscroll` 采样：

```js
var timer = setInterval(function () { el.scrollTop += 240; }, 50);
```

连续 3s，关掉墨迹层后再来 3s，最后才 `el.scrollTop = origin`。这段代码
原本写的是 `if (window.__ohsidianPerfScroll !== false)`，也就是 **agent 包默认开启**。
用户一打开 PDF 看两页，12 秒后它就开始把页面往下推；高倍缩放时还会落到空白页，
看起来像“PDF 自己滑走 / 页面白了”。日志里 `pdfPage` 每 100ms 一条、`scale`
从 2.888 跳到 5.28/6.227/9，就是这段采样在跑。

**修复**：改成 `if (window.__ohsidianPerfScroll === true)`，只有显式打开才跑。
普通写作、评测、演示都不会再动 PDF 滚动位置。

### 二、agent 包独立出来

新增 `scripts/build-agent.mjs`：

1. `update-obsidian.mjs --repatch --agent`；
2. 构建 HAP；
3. 复制到 `artifacts/agent/OHSidian-agent-<版本>-<时间>.hap`，**不覆盖 release 包**；
4. `finally` 里无条件 repatch 回 release 并跑 `verify-release`。

release HAL 与 agent 包从此路径分离：日常发版直接 `hvigorw`，需要演示/评测时
才跑 `node scripts/build-agent.mjs`；脚本结束工作区已经回到 release asar。

### 三、产物

- agent 包：`OHSidian-agent-2.0.0-20261103-165144.hap`
  121,150,237 B / SHA-256 `BFE81A06857A54AE87B4D9152E4CD251FA332C45C26DCEFA229DBB99A0CD0699`
- release asar 已恢复，`verify-release` 通过（`probeHook` 0）。
- `docs/STYLUS-EVAL.md` / README 的安装命令改为 `build-agent.mjs` + `artifacts/agent/`。

## 第 210 轮 (2026-11-10): 外部回归审计（HEAD 3ac0c56）——13 项未修复缺陷逐条复核并修复

> 来源：外部审计《OHSidian 手写笔引入以来回归审计报告》（2026-11-09，审计 HEAD `3ac0c56`）。
> 处理方式：**逐条回到代码复核，再改**。13 项"未修复"缺陷在本地 HEAD 全部成立（编号、行号、因果链一致，无一项是误报）；本轮全部修复，另修 3 项流程性缺口。
> 未处理：报告 §六 的 22 项观察项（O-1~O-17、V-1~V-5，均为设计权衡或窄边界窗口，报告也只是"留档/顺手修"建议）与 O-14（CHANGES 文件 BOM+CRLF，整文件重写的伪差异代价大于收益）。

### 一、F-001（P1）鼠标滚轮/捏合转发被整体删除

**真因复核**：`051b05f` 在 `MultiInputAdapter.isPanEventValid` 里加了 `SourceTool.Pen → false`（**这已经足够**），同时又删掉了 `WebWindow` / `WebSubWindow` / `WebEmbeddedWindow` 的 `.gesture(PanGesture/PinchGesture)`。`OnPanEvent` 是引擎唯一的滚轮入口（`MultiInputAdapter` 注释 + `docs/window-state-machine.md`），删掉手势等于掐断 MOUSE 滚轮/触控板捏合；`WebWindowNode`（BrowserAbility）没被删，所以同应用内行为不一致。三个组件里的 `multiInputAdapter` 保留成死代码，"看起来接了、实际没接"。

**修复**：三处恢复与 `WebWindowNode` 一致的手势转发（`WebWindow`/`WebEmbeddedWindow` 含 Pan+Pinch，`WebSubWindow` 只恢复它原本就有的 Pan），并写明"笔的过滤在适配器里、手势是唯一滚轮来源"的注释。O-5 的 `fingerList[0].id===0` 判据保持原样（报告明确要求勿动）。

### 二、NF-001（P1）`shell.trashItem` 旁路不盖删除时间

**真因复核**：`resfile/.../main.js` 的 `moveToVaultTrash` 直接 `renameSync` 返回；rename 保留**内容原始 mtime**，而 purge 无 sidecar 时按 mtime 判龄 → 一个"上次编辑于一个月前"的笔记经插件 `shell.trashItem`（或 hookTrash 回退）进回收站后，下次启动 60s 被永久删除。10-19 的 STO-02 只修了渲染层 trashLocal 这一条路径。

**修复**：`moveToVaultTrash` 成功后对目标（含目录树）执行与渲染层 `stampOne` 同语义的时间戳：`utimesSync(now)`，失败写 `<file>.ohsidian-trash-meta.json` 的 `deletedAt`。purge 侧第二道防线：无 sidecar 时判龄基准改为 `max(mtime, ctime)`——rename 把 ctime 推到"进回收站那一刻"，旧内容 mtime 再老也不会被误清。

### 三、NF-002（P1）切仓 `destroy()` 丢未落盘编辑与布局

**真因复核**：`vault-open` 收割窗口用 `w.destroy()`，不触发 beforeunload/unload，而 Obsidian 的编辑保存是约 2s 防抖、布局写 `workspace.json` 也在该时机。注释自认是为了绕开 `close()` 的 3s 退出动画。

**修复**：改为"先让渲染层 flush，再 destroy"：对每个待收割窗口 `webContents.executeJavaScript` 一段脚本，遍历 `app.workspace.iterateAllLeaves` 调 `view.save()` 并 `Promise.all`，随后 `saveLayout()/requestSaveLayout()`；脚本 resolve 后立即 destroy，另加 1.2s 看门狗（写死的 save 不会拖住切仓）。chooser 全程是可见窗口，退出动画仍不会出现，观感不变。

### 四、NF-003 / NF-004 / NF-005（P2）PDF 写回三处

- **NF-003 备份键碰撞**：备份名原为 `basename + FNV-1a 32 位`，"已有备份就跳过创建"意味着第二个同名 PDF 会认领第一个的原件。改为双 32 位哈希（FNV-1a + djb2，约 62 位）；**保留旧键读取**（`findBackup`/写回路径先试新键再试旧键），升级后老用户的现有备份仍可恢复，且不会被"重新快照一份带注释的文件"顶掉。
- **NF-004 restore 回退截断**：rename 失败后的 `fileIo.copyFileSync(tmp, src)` 是 `O_TRUNC` 语义，中途失败就把当前 PDF 截断——与函数自身注释相反。改为"同级临时名 copy → rename 覆盖"，rename 被拒时走 write 主链路同款的"旧文件移开→rename→失败回滚"。
- **NF-005 跨窗口交换竞态**：`Index.ets` 的 `pdfInkBusy` 是每窗口实例字段，两个窗口打开同一 PDF 时两段 taskpool 写可并发进入"移开旧文件→rename 新文件"。新增**跨窗口交换锁**：`<pdf>.hso-lock` 目录（fileIo 没有 O_EXCL，mkdir 是唯一的原子独占原语），覆盖交换段，finally 释放，60s 陈旧自解（崩溃写者不会把该 PDF 永久锁死），最多等 5s 后返回明确错误"另一个窗口正在写入此 PDF"。渲染层收到失败会把该页重新标脏，下次写回自愈。

### 五、NF-007（P2）IPC 1MB 行上限 vs 写回 3MB

**真因复核**：`consumeNativeIpc` 在 `nativeBuffer.length > 1048576` 时整段清空且不回执；写回是"整页一行 JSON"，`MAX_POINTS=80000` × 约 30–38 字节 ≈ 3MB，26000 点处就先撞上限 → 该页写回永久超时。

**修复**：上限提到 16MB（`NATIVE_IPC_MAX_LINE`，注释明确要求与 `PdfInkWriter.MAX_POINTS` 一起推理）；超限不再静默：回一帧 `pdfInkResult{seq:0,ok:false,error:'…超过 16MB 上限…'}`，渲染层 `resolvePdfResult` 识别 `seq===0` 后弹 Notice 并复位 `pdfInFlight`（不再干等 90s）。

### 六、NF-008（P2）onRename 墨迹迁移的三处问题

- **定时器竞争**：`saveSoon` 以改名前 `inkKey` 注册 900ms 定时器，`onRename` 既不清也不等。改为：迁移前先 `clearTimeout(store.timers[oldKey])`，再用 `waitIdle` 最多等 2s 让 `store.saving[oldKey]` 的在飞写落定。
- **非原子写**：`ad.write(newPath,…)` 直写（全部墨迹写入点里唯一不 tmp+rename 的）→ 改为 tmp + rename，rename 被拒回退直写并清理 tmp。
- **静默失败**：外层 `.catch(function(){})` 改为 `warn` + Notice（"墨迹随文件改名迁移失败：…"）。
- 缓存里若有打开中的 doc，直接以内存态 `saveDoc` 到新键（sidecar 可能滞后 900ms），而不是回读磁盘旧内容——那正是丢尾部笔画的那条路径。
- **未做**：`beforeunload/pagehide` 兜底 flush（报告的可选建议）。改名后未再书写即关闭应用仍可能丢尾部笔画，属跨层设计改动，留待单独一轮。

### 七、NF-009（P2）asar 安装非原子 + "存在即可信"

四个脚本统一为"验证 → 保留 .bak → 临时名 rename"：
- `update-obsidian.mjs`：安装前用 `OHSIDIAN_ASAR_PATH` 指向**待装包**跑一次 `verify-asar`（新增环境变量支持），失败拒绝安装；`copyFileSync` 到 `.new` → 校验字节数 → 旧内核存 `obsidian.asar.bak` → `rename` 覆盖；**版本号写入放在安装成功之后**（不再留下"新 asar + 旧版本钉"组合）。
- `refresh-app-patch.mjs`：由"先替换再校验"改为"先校验新包、再 .bak + rename"，最后对已安装路径再跑一次校验。
- `repack-b-native-asar.mjs`：原先 `copyFileSync` 后**无任何验证**，补校验 + .bak + rename。
- `ensure-obsidian-asar.mjs`：`existsSync` 即 no-op 改为完整性闸门——用 `@electron/asar` 抽 `app.js`/`main.js`（截断包会直接抛错），并要求补丁标记存在；判定不可用则**删除并自动重建**，绝不再把坏包静默打进 HAP。

### 八、NF-010（P2）模式文件双侧无锁 RMW

**真因复核**：`ackBackPress`（每次返回手势）、触屏模式命令、字号命令都是 `readMode → 改一个字段 → 整文件回写`。tmp+rename 只保证单次写不撕裂，不保证 RMW 不丢更新；ArkTS 侧 12 处 `publishModeFileAtomic`（键盘高度/insets/focusedWindow）在这些窗口期被回退成旧值。

**修复**：新增 `patchModeFile(patch, removeKeys)`——写前**重新读盘**，只覆盖调用方拥有的字段（`override`/`fontScaleOverride`/`backAck`/`systemFontOverride`），原生字段保持原值；三处调用点改为只提交自己的字段；并修正注释里"原子 rename ⇒ RMW 安全"的错误论证。`verify-asar` 增加门禁，禁止 `c.backAck={…}` 这种整快照写法回归。

### 九、NF-006（P3）迁移固定 300ms 抢跑

`flushEditors()` 收集每个 `view.save()` 的 Promise，新增 `flushThen(cb)`（全部完成或 3s 上限后回调），两处迁移入口改为 `flushThen(...→startMigration)`，不再用固定 `setTimeout(300)`。

### 十、NF-011（P3）pdfembed 套索副本 dy 未归一化

`duplicateSelection` 里 `dx` 有 pdfembed 分支（0.02）而 `dy` 没有，克隆笔画整体 `y += 18`（归一化单位 = 18 个页高）落到页面外，再被写回成 PDF 垃圾注释。改为 pdfembed 分支 `dx = dy = 0.02`（pdf 分支保持原样：`dx=14/scale`，`dy=18` 用户坐标点）。

### 十一、NF-012（P2）恢复原始 PDF 后 written/baked/pdfHl 未重置

新增 `resetPdfWrittenFlags(surface)`：恢复成功回调里清掉该 doc 全部 `written/baked/pdfHl`，提示语改为"PDF 内注释已清除，再次书写会按需重建"，并触发一次 `inkRefreshSurfaces()`。
为什么这样就够：`pdfDirtyPages()` 本来就把 `written===false` 的笔画按页收集，所以"下次任意写回"会自动重建注释；**故意不在恢复后立刻 schedulePdfWrite**——那会把用户刚恢复的 PDF 马上重新写满注释，等于让"恢复原始"失效。清 `baked` 则让荧光笔/普通笔迹重新回到叠加层，不再"从屏幕上消失"。

### 十二、E-001（P3）IPC 会话按单例而非按连接

`server.on('connect')` 原先把 `nativeClient/nativeAuthorized/nativeBuffer` 整体重置，第二条回环连接就能踢掉当前会话授权。改为：**授权后不再接受新连接**（直接 close 并记日志）；未授权的连接可以被替换（真实渲染层重连不受影响），被替换的旧连接主动关闭；`close` 回调按连接身份过滤，迟到的 close 不会清掉新会话。

### 十三、验证

- `node --check` 通过：`scripts/patches/{touch-mode,ohsidian-ink,main-process}.js`、`resfile/resources/app/main.js`、`verify-asar.cjs`、四个 `.mjs`。
- `node scripts/update-obsidian.mjs --repatch`（离线缓存内核）+ `verify-asar`：**全绿**（新增 5 条门禁：模式文件字段化合并、迁移等待保存、恢复重置标志、onRename 原子迁移、设置开关 label）。补丁版本 `190 → 191`，墨迹版本 `58 → 59`。
- 安装路径已确认：`obsidian.asar`（25.2 MiB）+ 旧内核 `obsidian.asar.bak`；`*.asar.bak` 已加入 `.gitignore`。
- **未做真机验证**：本轮无 HAP 构建（本机无 DevEco/SDK 环境）。需要真机回归的点：① 外接鼠标在主窗/子窗/内嵌窗滚动与捏合，且笔迹书写不拖页；② 插件路径删除 31 天前的文件 → 重启 → 60s purge 后文件仍在；③ 切仓前 1 秒内输入文字，切回后内容完整；④ 写回两页（含荧光笔）→ 恢复原始 → 高亮笔仍可见、PDF 内注释已清；⑤ 双窗口打开同一 PDF 同时写回不报错/不互相覆盖；⑥ 设置页开关仍可正常点灭（补丁 191）。

## 第 211 轮 (2026-11-10): 发版终审报告复核——N-1/N-4/N-6/N-7 属实并修复，N-2/N-3/N-5 接受

> 来源：外部《OHSidian 发版终审报告（Release Gate Audit）》，审计对象 `7779d4b`，结论"有条件 GO"，新发现 N-1~N-7（均 P3）。
> 本轮先逐条复核，再动手：**N-1、N-4、N-6 属实且必须修**（前两项会让本地包多带 25MB 且闸门存在盲区，N-6 存在永久卡死路径）；N-7 顺手补上发送端预检；N-2、N-3 属已接受的有界/罕见行为，只做小加固；N-5 为 P3 已知限制，见下。

### 一、N-1（属实，已修）`obsidian.asar.bak` 落在 resfile → 本地 HAP 多带 25MB

**复核**：`web_engine/src/main/resources/resfile/` 下的一切都会被 hvigor 原样打进 HAP（仓库里既有证据：`docs/PLATFORM-ADAPTATION.md` 记着 `@electron/remote` 整包"随 HAP"、`verify-asar.cjs` 注释写"包装层 main.js 随 HAP 打包"）。上一轮新增的 `.bak` 就在这个目录，实测 26,386,094 B；本地每次构建都会带上，CI 因文件被 gitignore 不受影响。CI 无感 → 只有开发者机器会中，正是那种"没人发现"的问题。

**修复**：
- 三个安装脚本（`update-obsidian` / `refresh-app-patch` / `repack-b-native-asar`）的上一版内核备份改写到 `<repo>/.cache/asar-backup/obsidian.asar.bak`（gitignore 覆盖），并顺手删除 resfile 里的旧位置 `.bak`；
- **同一类问题的另一半**：`update-obsidian.mjs` 的暂存文件原本是 `asar 路径 + ".new"`，也在 resfile 里（copy 与 rename 之间崩溃就会留下一个 25MB 垃圾文件进包）。改为 `.cache/asar-stage/obsidian.asar`（同卷，rename 仍是原子的）；
- `ensure-obsidian-asar.mjs` 新增 `relocateLegacyBak()`，在**快速 no-op 退出之前**执行：老机器上残留的 `obsidian.asar.bak` 会被移到 `.cache/asar-backup/`（已有则直接删），保证任何一次构建都不会把它打进包。
- 坏包重建路径不再连带删除备份（备份已在 resfile 之外，留着还能手工回滚）。

**验证**：`--repatch` 后 `resfile/resources/app/` 只剩 `node_modules icon.png main.js obsidian.asar ohsidian-flags.json package.json`；`ensure` 实跑输出 `removed the legacy obsidian.asar.bak from the HAP resources`；`.cache/asar-backup/obsidian.asar.bak` 存在。

### 二、N-4（属实，已修）ensure 闸门的 touch 标记检查是盲区

**复核**：实测 app.js 4,435,040 字符，`__ohsidianInkPatch` 在 902，`__ohsidianTouchPatch` 在 **358,075**——而闸门只 `toString('utf8', 0, 262144)`。即"ink 在、touch 丢了"的半补丁包永远判绿。

**修复**：去掉截断，对 `extractFile` 返回的完整内容做标记检查（多读约 4.4MB，仍在毫秒级）。四个安装点的安装前校验本来就走全文件检查的 `verify-asar.cjs`，盲区只在 ensure 的快速体检。

### 三、N-6（属实，已修）锁目录可见 + 非空即永久卡死

**复核**：`<pdf>.hso-lock` 会被 Obsidian 文件树列出、可能被同步插件带走；释放与陈旧自解都只用 `rmdirSync`，一旦目录里出现任何文件（同步冲突文件、用户误放），`rmdir` 永久 `ENOTEMPTY` 且被静默吞掉 → 该 PDF 的写回/恢复**永久失败**，60s 陈旧自解对"非空"这一形态无效。

**修复**（`PdfInkWriter`）：
- 锁名改为隐藏形式 `<dir>/.<basename>.hso-lock`，Obsidian 默认忽略点开头条目，不再出现在文件树；
- 新增 `removeLockDir()`：先递归清空目录内容（子目录递归、文件 unlink），再 `rmdir`；若锁名被一个普通文件占住则 `unlink`——释放与陈旧自解都走它，任何形态都能自愈。

### 四、N-7（建议，已采纳）发送端缺页预算预检

渲染层 `pdfWritePage` 发送前统计本页点数/笔画数：超 `80000` 点或 `1500` 笔立即本地失败并给出明确文案，不再白跑一次多MB IPC 往返再被写回端拒绝。常量注释明确要求与 `PdfInkWriter.MAX_POINTS/MAX_STROKES` 同步，`verify-asar` 新增门禁 `app pdf write page budget precheck` 锁住两侧。

### 五、N-2 / N-3（接受，仅加固）

- **N-2**：抢锁忙等上限 5s，主路径在 taskpool 工作线程；只有 taskpool 失败降级到 UI 线程时才会冻结，属有界、罕见、可自愈。保持现状。
- **N-3**：`waitIdle` 的等待上限从 40×50ms（2s）提到 **200×50ms（10s）**，覆盖任何现实 sidecar 写；超时后仍按原语义继续迁移（最坏只是旧键留下一个过期孤儿文件，**不丢数据**）。

### 六、N-5（未修，记为已知限制）

`resetPdfWrittenFlags` 只重置**当前窗口**的内存态：同一 PDF 在第二个窗口打开时，该窗口仍认为笔画已烘焙 → 高亮笔在那一侧从屏幕消失，直到它重新载入该文档（重载即从 sidecar 读到 `written=false` 自愈），无数据丢失。
为什么不在本轮修：两个窗口是独立渲染进程，现有唯一的跨进程通道是按窗口分配的回环 IPC 端口（无广播能力），要新增"渲染层 → 主进程 → 其它窗口"的广播通道属设计层改动，且无法在本机验证（无 DevEco/SDK），风险高于收益。已在文档中登记，留待有真机验证条件的单独一轮。

### 七、验证

- `node --check`：`ohsidian-ink.js` / 三个安装脚本 / `verify-asar.cjs` / `ensure-obsidian-asar.mjs` 全通过。
- `node scripts/update-obsidian.mjs --repatch` → `verify-asar` **全绿**（新增 1 条门禁，共 6 条本轮相关门禁）；`node scripts/verify-release.cjs` → `RELEASE VERIFY: OK - no device-agent probe in app.js`（NF-012 新增的 `probeHook("inkPdfRestore")` 仍被剥离器正确处理）。
- 墨迹版本 `59 → 60`（本轮只改 ink 层与构建脚本，补丁版本保持 191）。
- `resfile/resources/app/` 已确认无 `.bak` / `.new`；`obsidian.asar` 25.2 MiB。
- 仍未做真机验证，放行门禁仍为第 210 轮列出的 6 项（终审报告 §6 原样采纳）。

## 第 212 轮 (2026-11-10): CI 编译失败——`fileIo.readdirSync` 不存在；本地 SDK 编译验证通过，并实证 N-1

> 触发：CI `CompileArkTS` 报 `Error Message: Property 'readdirSync' does not exist on type 'typeof fileIo'. Did you mean 'readSync'? At … PdfInkWriter.ets:882`。

### 一、真因
第 211 轮 N-6 的"递归清空锁目录"按 Node `fs` 的习惯写了 `fileIo.readdirSync`。但 HarmonyOS 的 `@ohos.file.fs` 没有这个成员，目录列举 API 是 **`listFileSync`**（本机 SDK 核对：`@ohos.file.fs.d.ts:1637 declare function listFileSync(path: string, options?: ListFileOptions): string[]`）。

顺带核对本轮用到的其它成员，全部存在：`mkdirSync(path)`(1890) / `mkdirSync(path, recursion)`(1918) / `rmdirSync(path)`(3159)。仓库里 `WebAbility.ets:2063`、`DragParamManager.ets:544` 早已在用 `listFileSync`——本该照着抄。

### 二、修复
`PdfInkWriter.removeLockDir` 改用 `fileIo.listFileSync`，并把"清不掉"的兜底补完整（原实现若 `rmdir` 失败就到此为止，仍留永久卡死路径）：
1. 递归清空（子目录递归、文件 `unlink`）；
2. `rmdirSync`；
3. 仍失败 → `renameSync` 把整个锁目录挪到 `<lock>.stale-<ts>`（rename 对**非空目录**有效），锁路径立刻释放；
4. 若锁名被普通文件占据 → `unlink`。
新增 `isDirectory()` 小工具（`statSync().isDirectory()` 包在 try 里）。

### 三、本地编译验证（本轮新增能力）
本机确有 DevEco SDK（`D:\program\DevEco Studio\sdk`），之前判断"无 SDK"有误。已用它跑真实构建：

```
DEVECO_SDK_HOME="D:\program\DevEco Studio\sdk"
node "D:\program\DevEco Studio\tools\hvigor\bin\hvigorw.js" --mode module \
     -p product=default -p module=electron@default assembleHap --no-daemon
→ Finished :electron:default@CompileArkTS ... 12 s 272 ms
→ BUILD SUCCESSFUL in 41 s 357 ms   exit=0
```

`electron/build/default/outputs/default/electron-default-signed.hap`（121,164,850 B）产出成功，`SignHap` 也通过。

### 四、顺带实证 N-1（发版终审报告的新发现）
直接解开上一步构建的 HAP 看 `resources/resfile/` 条目：

| HAP 内路径 | 大小 |
| --- | --- |
| `resources/resfile/resources/app/obsidian.asar` | 26,387,501 |
| `resources/resfile/resources/app/main.js` | 21,303 |
| `resources/resfile/resources/app/icon.png` | 1,606,146 |
| `resources/resfile/resources/app/node_modules/…` | 逐文件打包 |
| **`resources/resfile/resources/app/obsidian.asar.bak`** | **不存在** |

两点结论：① "resfile 下一切都会进 HAP"**由产物直接证实**（连 `node_modules` 都逐文件进去了），N-1 的前提成立、确实是真缺陷；② 修复生效——`.bak` 已不在包内（否则 HAP 会多 26MB）。

### 五、教训
新增 ArkTS 文件系统/系统 API 调用前，先在本机 SDK 的 `.d.ts` 里核对成员名与签名，不要按 Node/浏览器习惯推；仓库里已用过的成员优先。

验证：`node --check`（4 个补丁 JS + 构建脚本）不变；本地 `assembleHap` 通过；`git status` 只剩本次 ArkTS 修复。

## 第 213 轮 (2026-11-11): 触屏模式下插件加载失败（N-13）——require 被移动模拟门控，判据常量化为 false

> 来源：外部《OHSidian「触屏模式 × 插件冲突」根因分析（合并版）》，对象 `e528275`。本轮**先逐条取证再动手**，主链确认属实并修复；辅链 A 按报告建议只加可感知性提示（不改吞没语义）。

### 一、取证（与报告逐字对账）

出货 asar 解包后 app.js 4,436,149 字符，`loadPlugin` 的 require shim 逐字如下（`scripts/.tmp-probe-emulate.cjs` 实测）：

```js
o=e,a=document.body.hasClass("emulate-mobile"),
s=function(e){return u4.hasOwnProperty(e)?(...):c4.hasOwnProperty(e)?c4[e]
  :a?(new Aw("".concat(o,' attempted to load NodeJS package: "')...),console.error(...),null)
  :sf(e)},                      // sf(e) = window.require
```

- 白名单 `c4`/`u4` 实测只有 `obsidian` + `@codemirror/*` + `@lezer/*`，**没有 Node 内置模块、没有 `electron`**；
- 真实通道 `var af=window.require; function sf(e){return af&&af(e)}` 同一文件内存在（内核自己也用它取 `fs`/`electron`）；
- `emulate-mobile` 全文 4 处：启动翻转、`loadPlugin` shim、诊断文本、app.css 安全区变量 —— 与报告一致；
- 触屏模式确实是通过 `localStorage.EmulateMobile` 翻转（`touch-mode.js` 的 `applyMobile`），因此 `a` 在触屏模式下恒真。

结论：报告主链成立。本移植的渲染层有完整 Node，`null` 是**按真手机处境写的策略**，在此处为误判：顶层 `require("fs"/"path"/"electron"…)` 的插件抛 TypeError → `enablePlugin` catch →「插件加载失败」；懒加载的则设置页 `display()` 抛错、tab 空白。**与模式强相关**（桌面模式 `a=false` 走真实 require）。

### 二、修复（选项 B / 改法一）

把判据常量化为 false，白名单仍优先，其余一律走真实 `window.require`：

```js
// update-obsidian.mjs APP_BODY_PATCHES（+ refresh-app-patch.mjs 同步）
src: 'a=document.body.hasClass("emulate-mobile"),s=function(e){return u4.hasOwnProperty(e)?'
dst: 'a=!1,s=function(e){return u4.hasOwnProperty(e)?'
```

- 只动 `require` 语义：`rd.isMobile`/`isTablet`/`isPhone`、`emulate-mobile` 类、移动工具栏/导航/抽屉/设置页分支**全部不变**（实测三个翻转锚点仍在）；
- `verify-asar` 新增正/负断言 `app plugin require not gated by emulate-mobile`：既要求 `a=!1,…`，也要求上游式 `a=document.body.hasClass("emulate-mobile"),s=function` 不存在 —— 以后 body patch 被跳过或回滚会直接 FAIL（此前 verify-asar 对 loadPlugin 零断言）；
- 升级内核时若锚点变化，`update-obsidian.mjs` 会打出 WARNING（既有机制），门禁同时 FAIL，不会静默。

### 三、辅链 A：笔尖点不开设置页（只加提示，不改语义）

`isExcluded` + 非「指针」工具 + 非自绘件时，笔的 pointerdown 在 window 捕获阶段被吞是**设计如此**（掌托/笔误触防护依赖它，报告 §2.5 也用代码排除了"手指也点不开"）。问题只是**完全无反馈**，与"设置页坏了"不可区分。

新增 `penChromeHint()`：同一条件首次吞没时给一次 Notice（20 秒限频）——
`手写工具激活中：笔尖只画不点界面。请用手指操作，或把工具切回「指针」`。吞没逻辑一行未改；ink rev 60 → 61。

### 四、报告其余结论的核对与处置

| 报告项 | 处置 |
| --- | --- |
| §1.6 四条失败文案判别（563 = 主链，565/566/567 = 内核黑名单） | 采纳，作为支持话术；未改代码 |
| §5 排除清单 13 项 | 抽查一致（尤其 #3 `isDesktopOnly` 不触发、#7 touch-mode 只有 3 处窄域 preventDefault、#10 app-region 不覆盖设置弹窗） |
| §8 选项 A/C/D | 未采用：A 与本次修复方向相反；C（解耦布局与插件语义）改动面过大；D 属附加提示，主链修好后无必要 |
| §8 选项 F（补 verify-asar 断言） | 已做 |
| §6 建议登记 NF-013 / NF-014 | 记入本轮与 `docs/PLATFORM-ADAPTATION.md` A5 行（`docs/BUG-BACKLOG.md` 仍未纳入版本库，未改动） |

### 五、验证

- `node --check`：`ohsidian-ink.js` / `update-obsidian.mjs` / `refresh-app-patch.mjs` / `verify-asar.cjs` 全通过；
- `node scripts/update-obsidian.mjs --repatch`：输出 `plugin require() no longer gated by EmulateMobile (touch mode)`，`verify-asar` **全绿**（新增门禁在列）；
- 出货 asar 实测：`a=!1,…` 出现 **1** 次、上游式 **0** 次、`emulate-mobile` 由 4 处降为 **3** 处；三个布局翻转锚点、白名单两项、`af=window.require`、笔提示文本均在；
- 本地 `assembleHap` 通过（HAP 25.2 MiB asar 打入，`module.json` 仍是 2.0.0 / 2000000）。

### 六、真机回归点（本轮无法覆盖）

1. 触屏模式下重载 → 之前"插件加载失败"的 Node 依赖插件应正常加载，开关不再弹回；
2. 桌面模式对照：同一批插件行为不变；
3. 插件设置页（懒加载 Node 的）能正常打开并渲染；
4. 触屏模式布局不变（移动工具栏/导航/抽屉仍在，`--safe-area-inset-*` 仍按真实系统条生效）；
5. 笔选任意绘图工具后点设置齿轮 → 出现一次提示，手指点击仍正常；
6. 反向风险观察：个别按 `Platform.isMobile` 分支的插件现在拿到 Node 后是否有异常行为（报告 §8 点名的风险项）。

## 第 214 轮 (2026-11-11): 发布 2.0.1（插件 require 修复）——版本、文档与出货包审计

> 2.0.0 已于 2026-11-10 发布（tag 指向 `bfae43a`，两个图标的 HAP 已在 Release），**不含**第 213 轮的插件修复，故本次以补丁版本 2.0.1 发出。

### 一、版本与文档

- `AppScope/app.json5`：`versionName 2.0.1` / `versionCode 2000001`（按 `主*1e6+次*1e4+修订`）；
- `docs/CHANGELOG.md`：新增 `## 2.0.1（插件修复）`——主修复（触屏模式插件 require）、手写笔提示、已知问题（含"仍会失败的插件面"）；2.0.0 段保留为历史（`ink rev 60`）；
- `docs/RELEASE.md`：适用版本、versionCode 示例、关于页版本、tag 命令、HAP 命名示例改为 2.0.1；
- `docs/STYLUS.md`：状态行与验收条目 → `v2.0.1 / ink rev 61`、`versionName=2.0.1 / versionCode=2000001`；
- `scripts/ci/release-notes-template.md`：Release 正文改为 2.0.1 的修复说明 + "仍存在的插件失败面（内核策略）" + 已知问题。

### 二、审计（全部以出货产物为对象）

| 审计项 | 方法 | 结果 |
| --- | --- | --- |
| 补丁唯一性 | 解出**构建产物 HAP** 内的 `obsidian.asar` → app.js，计数 | `a=!1,s=function(e){return u4.hasOwnProperty(e)?` = **1** 处；上游式 `a=document.body.hasClass("emulate-mobile"),s=function(` = **0** 处 |
| 布局不受影响 | 同上，检查三个翻转锚点 | `rd.isMobile=!0,rd.isDesktop=!1`、`o.addClass("emulate-mobile")`、`rd.isTablet=i.matches,rd.isPhone=!i.matches` 均在 |
| 影响面收敛 | `emulate-mobile` 计数 | 4 → **3**（正好少了 shim 那一处，其余三处原样） |
| 白名单与真实通道 | 同上 | `code4` 白名单 `obsidian:d` / CodeMirror 仍在；`var af=window.require` 仍在（shim 现在总是落到它） |
| 幂等性 | 跑 `refresh-app-patch.mjs`（对已打补丁的 asar 再施加一遍） | 输出 `body patch already applied: plugin require unrestricted in touch mode`，随后 `verify-asar` 全绿；再跑 `update-obsidian.mjs --repatch` 复原标准产物 |
| 出货包门禁 | 把 HAP 内的 asar 抽出来，用 `OHSIDIAN_ASAR_PATH` 指向它跑 `verify-asar` | **全绿**，含新门禁 `app plugin require not gated by emulate-mobile` |
| 版本落地 | 读 HAP 的 `module.json` | `versionName=2.0.1` / `versionCode=2000001` / `minAPIVersion=60002022` / `targetAPIVersion=60101024` |
| 包卫生 | 列 HAP 的 `resources/resfile/resources/app/*` | 只有 `icon.png` / `main.js` / `obsidian.asar`(25.2 MiB) / `ohsidian-flags.json` / `package.json`，**无 `.bak`**（N-1 不复现） |
| 探针 | `verify-release.cjs` + 在出货 app.js 里搜 `probeHook("inkPdfRestore"` | `RELEASE VERIFY: OK`；出货 asar 内该探针调用**不存在**（已被剥离，符合预期） |
| 版本号一致性 | 出货 app.js | `OHSIDIAN_PATCH_REV=191`、`OHSIDIAN_INK_REV=61`，与 CHANGELOG/STYLUS 声明一致 |
| 文档链接 | `check-docs.cjs` | 73 链接、0 失效、21 文件 |
| 编译 | `assembleHap`（本机 DevEco SDK） | `BUILD SUCCESSFUL`，exit 0 |

### 三、结论

第 213 轮的修复**确实进入了本次要发布的二进制**（不是在源码里成立、包里没有）；改动只作用于插件 `require` 语义，布局与白名单未受影响；重复施加补丁安全；包内无历史遗留的备份文件。

### 四、未覆盖（真机回归，发版后仍需确认）

1. 触屏模式重启 → 原先「插件加载失败」的 Node 依赖插件开关不再弹回；
2. 桌面窗口模式对照：同一批插件行为不变；
3. 懒加载 Node 的插件设置页不再空白；
4. 触屏模式布局（移动工具栏/导航/抽屉/安全区）与 2.0.0 一致；
5. 绘图工具激活时笔尖点界面 → 出现一次提示，手指操作正常；
6. 反向风险：个别按 `Platform.isMobile` 分支的插件拿到 Node 后是否有异常行为。
## 第 215 轮 (2026-11-18): 接收 2026-11-17 审计移交包——窗口/布局线与 pandoc 线的落地项与延后项

**输入**：外部审计移交包（8 份报告，审计基线 HEAD `e528275`）：线 A 窗口/布局（Bug1 最大化→自动重启变移动端、G-1~G-7、DB-1~12、三层状态机规格），线 B pandoc/鸿蒙能力（三候选 errno 定性、能力面全景、弱沙箱路线、WS-1~8）。本轮先逐条对当前 HEAD（`c5705d4`，2.0.1）复核锚点，再按"低风险先落、行为变化单独隔离"的顺序落地。

### 一、已落地（8 项）

| 编号 | 内容 | 代码位置 | 为什么安全 |
| --- | --- | --- | --- |
| WM-3（=Bug1 R2 / D1） | 2in1 的模式发布值常量化 + 启动自愈：`windowStatusChange` 的 MAXIMIZE/FULL_SCREEN 分支不再按 `window_pcmode_switch_status` 发布；启动时按档案常量回写一次，修掉旧版本留下的 `systemMode='touch'` | `WebAbility.ets` `writeTouchModeFile()` + `onWindowStageCreate` 启动分支 | **报障设备是鸿蒙电脑，其 `deviceInfo.deviceType` 就是 `'2in1'`**（不是"平板 + 键盘"专属形态，也不是"平板 PC 关 + 自由多窗"场景）。2in1 上该键不保证存在（H15），旧代码在**第一次最大化**时把 `systemMode` 写成 `touch`，而启动路径根本不写——这正是"最大化→重载→移动布局"的确定性成因。改后发布值与启动默认一致（desktop）；启动自愈保证**已被旧版本污染的机器**升级后立刻恢复（否则 `resolveWant` 仍会读到 `touch`，用户看不到修复效果）；渲染层 `override` 仍可强制任一布局，用户意图不丢失 |
| WM-2（=G-1 入口 4 / DB-1） | `setFullScreen` / `setSimpleFullScreen` 补形态守卫 | `AppWindowAdapter.ets` | 与既有 maximize/minimize/setBounds 守卫同向：触摸形态下窗口本身就是整屏，`ENTER_IMMERSIVE` 只会再产生一次 MAXIMIZE/FULL_SCREEN 事件（Bug1 那条"事件→模式文件→重载"链路）。守卫用**实时窗口状态**判据（FULL_SCREEN/MAXIMIZE 才算"已经是整屏"），平板 PC 关下的真实自由窗（FLOATING）仍可进沉浸；状态读失败保持原行为 |
| WM-5（=G-4） | 五枚举全覆盖：`SPLIT_SCREEN` 归入自由窗族发布 desktop（手机除外），`MINIMIZE`/未知值显式不发布 | `WebAbility.ets` 状态监听器 | 分屏在平板本就属于自由窗形态（`freeWindowForm()` 对 SPLIT 已返回 true），旧代码只是没把它放进白名单，导致分屏后沿用上一形态的发布值；最小化/未知值按"不改变"方向显式留空 |
| WM-10（=DB-3） | 4 处"引擎不实现 `-webkit-app-region`"的过时注释更正 | `WebAbility.ets` ×2、`AppWindowAdapter.ets`、`docs/window-state-machine.md` | 第 182/183 轮真机已定案：引擎**会**把 web 侧 app-region 转成窗口移动，只是仅限无边框路径。旧注释会把后来人引向错误的兜底方案 |
| HB-2 | pandoc 诊断探针补 `EPERM` 分支 | `scripts/patches/touch-mode.js`（patch rev 192） | 旧模板把 EPERM 落到"能启动但退出码非零"的兜底句，等于告诉用户"问题在这个程序内部"——实际程序从未启动。新文案写明这是内核裁决（强制代码签名 + 应用执行域），应用层无解 |
| HB-3 | 探针补"目标是目录"特判 | 同上 | 已拿到 `stat` 却未查 `isDirectory()`：Cellar keg 目录被 execve 必然 EACCES，旧文案把锅甩给 SELinux。现在直接给"目标类型: 目录"+ 正确写法（`.../Cellar/pandoc/<版本>/bin/pandoc`），并跳过无意义的 execve 实测 |
| HB-5 | 探针身份转正 | 探针头注释 + `verify-asar.cjs` | 它早已是用户可见的设置项/命令（不是一次性探针），注释里的 "TEMPORARY / REMOVE" 与门禁里 "remove in the version after next" 都是会误导维护者的死约定；本轮统一为永久特性，门禁改为断言 EPERM/目录两条分支 |
| HB-4① | `http/https` 外呼改 `openLink`（保留隐式 Want 兜底） | `ExternalProtocolAdapter.ets` | 官方自 API 12 起推荐应用链接方式；失败/不支持时仍走原 `startAbility`，行为单调降级，不会比 2.0.1 更差；`mailto/tel/obsidian` 保持 Deep Linking 语义不动 |

### 二、明确延后（以及为什么）

1. **WM-1（=Bug1 R1，平板 PC 关 + 自由多窗下的最大化）**：状态机规格 D4 要求把 S4（最大化）发布为 desktop。但当前实现里 `writeTouchModeFile` 的"实时读形态"同时承担了一个**自愈**职责：平板关闭自由多窗回到整屏时，只能靠"此刻不是 FLOATING"把发布值翻回 touch。若只把 MAXIMIZE 改成 desktop 而不引入转移起点状态（规格第 2 层 + I2），会出现"关掉自由多窗后仍停在移动布局"的回退。**没有真机验证窗口的前提下不落这一项**；规格 §6.2（发布函数）/§6.3（转移表）已具备，待有设备可回归时按步 2 整体落地（同批含 WM-4 多窗仲裁、WM-6 中间态）。
2. **WM-9/11/12/13/14（装饰子机、SetMovable 收编、辅助窗口线）**：属状态机步 3 的结构性收敛，改动面横跨按钮可见性四个写点与三条辅助窗口线，验收矩阵 B1-B12 全在真机。单独落风险大于收益。
3. **HB-1（pandoc 产品路线）**：四条出路里 ① HNP / ④ 弱沙箱都涉及构建变体、签名身份与包体（pandoc ~273MB），是产品决策 + 工程立项，不是本轮代码改动。诊断面板按 HB-2/HB-3 修好文案后，正好可作为 ④ 快验的判定工具。
4. **HB-6（插件 `spawn()` 无 error 监听）**：在渲染进程给 `child_process.spawn` 打全局猴补丁影响所有插件；以"诊断面板可感知"替代更稳。

### 三、复核与门禁

- 锚点复核：移交包基线 `e528275` 与当前 HEAD 差两个版本（2.0.0→2.0.1），`WebAbility.ets` / `AppWindowAdapter.ets` / `touch-mode.js` 行号已漂移，全部按唯一子串重定位后再改。
- `verify-asar.cjs` 新增两条断言：`app pandoc probe EPERM verdict`、`app pandoc probe directory target`。
- `node scripts/update-obsidian.mjs --repatch` → `verify-asar` 全绿；`verify-release` / `check-docs` 全绿；`assembleHap` BUILD SUCCESSFUL。
- 真机仍需确认（本机不可替代）：① 鸿蒙电脑（deviceType 2in1）隐藏标题栏 → 最大化不再重载、布局不变，且**旧版本已污染的机器**升级后冷启动即为桌面布局；② 平板 PC 关自由窗最大化行为与 2.0.1 一致（本轮**未**改这条）；③ F11/菜单全屏在触摸形态被忽略且日志可见；④ 平板分屏后发布 desktop、手机分屏仍移动布局；⑤ pandoc 诊断面板对 Cellar 目录与 EPERM 两条候选给出正确结论。
## 第 216 轮 (2026-11-18): 移交包第二批——线 A 三处收尾（含 215 轮自己引入的回归）+ 线 B 诊断面补全

**背景**：215 轮落地后，用三个只读子代理分别复核线 A 残项、线 B 残项与 215 提交的回归风险。本轮修掉复核出的**一个自己引入的回归**与一处**死代码**，并把线 B 诊断面按报告补齐。另更正一条事实口径：**报障设备是鸿蒙电脑，其 `deviceInfo.deviceType` 就是 `'2in1'`**——不是"平板 + 键盘"专属形态，也不是"平板 PC 关 + 自由多窗"场景（215 轮的 WM-3 正对着它）。

### 一、线 A 收尾（1 个回归修复 + 1 处死代码 + 3 项守卫补全）

| 编号 | 内容 | 为什么必须改 |
| --- | --- | --- |
| 回归修复（215 轮引入） | WM-2 守卫原对 `setFullScreen(true)` 与 `setFullScreen(false)` 一视同仁：平板 PC 关下的自由窗经 F11 进入沉浸（S5）后，**退出调用被同一个守卫吞掉，窗口再也退不回来**。改为按窗口 id 记录"由本桥进入的沉浸"（`bridgeImmersiveId`）：进入方向照旧守卫，退出方向放行自己开的那次；触摸 S1 窗口（不是本桥开的）仍然不可退出 | 215 轮把"防误发布"的守卫加成了双向，制造了"进得去、出不来"。F11 按两下就能复现 |
| WM-5 死代码 | 215 轮的 `SPLIT_SCREEN` 分支写在 `if (MAXIMIZE \|\| FULL_SCREEN \|\| FLOATING)` 的**内层**，永远不可达。改为同级 `else if`，只做发布、不重跑自由窗几何阶梯（rect/inset 由 rect/size 事件负责） | 外层三值白名单挡住 SPLIT，所谓"五枚举覆盖"实际只覆盖三值 |
| 16000067 兜底放宽 | `showWindow` 的 MINIMIZE 兜底原被 `isTouchFormFactorStrict()` 门住 → 桌面窗口（2in1 / 平板 PC 模式）最小化后若 `showAbility` 被 16000067 拒，只剩一句 "left as-is"，窗口停在最小化。改为**形态无关 + MINIMIZE 白名单**（启动期那 3 次 show 的冗余仍被排除） | 规格 §十 怪癖表要求"P-全部"；Round 111 的约束是"仅 MINIMIZE"，不是"仅触摸" |
| restore() 守卫（DB-6） | 触摸形态 + **非最小化**的 `restore()` 直接忽略 | 该组合会把窗口还原成浮窗，而触摸态应用本身就该是 display；Round 111 不变式 1 的漏项。`bringWindowToFront` 内部直接调 `windowClass.restore()`，不受影响 |
| I7 裸读补 try | `maximize()` 的幂等读与 `getWindowStatus` 桥都在 try 外，异常会冒到引擎；改为读失败按"未最大化 / UNDEFINED"继续（不改变方向） | 同文件其他消费点都已包 try，这两处是唯一裸调 |

**顺带记一条定性**：WM-2 现在的覆盖面是"**已经是整屏**的触摸窗口"，自由窗**起点**（平板 PC 关下的 FLOATING → F11 进沉浸）仍然开放，因为 `MAXIMIZE/FULL_SCREEN` 事件在平板仍是 `touch`（WM-1 待转移起点状态）。要彻底闭环只能等状态机步 2。

另外两处必须一起记档：

1. **2in1 的可见副作用（正确方向）**：桌面布局恢复后，2in1 上"根返回退出应用"与"切换仓库关闭兄弟窗口"不再发生——这两条本来就是触摸分支的行为，对既有 2in1 用户是**行为变化**，写 release note 时要说明；确实要移动布局的用户仍可用模式命令把 override 置为 touch。
2. **仍未闭环的封堵面**：`AppWindow.Restore` / `AppWindow.UnMaximize` 的直接 binding 仍可能把触摸窗变成浮窗（本轮只守了 `setFullScreen*` 与 `restore()`；`unMaximize` 刻意不加盲守卫——它是 S5→S2 的正常退出通道）。

### 二、线 B 诊断面补全（patch rev 192→193）

| 编号 | 内容 | 用户可见差别 |
| --- | --- | --- |
| HB-7 | 设置项分组 `导出` → `Pandoc 诊断`，文案改为"只用于本页环境检查，本应用不执行导出，插件读它自己的配置" | 之前用户以为改这里能修导出，改完再报"还是不行" |
| HB-8 | `EACCES` 按文件层证据分化：缺执行位 / X_OK 不过 → `exec-eacces-perm`（**可修**：chmod 或重装）；权限位正常才判沙箱/ACL | 之前把可修问题说成"应用层绕不过去，只能换位置或换方案" |
| HB-9 | EPERM 结论后补"下一步三件事"（HiShell 自证执行域差异 / 对齐插件 `data.json` 路径 / 导出 Markdown 绕行）+ 报告落盘路径 | 之前只给 HNP、HiShell 两个开发者术语，用户不知道下一步做什么 |
| HB-10 | 报告顶部加"结论汇总"（每个候选一行 verdict）+ 报告文件路径 | 三个候选各说各话，要通读完才知道主因 |
| HB-11 | shell 模式改 `/bin/sh -c '"$0" --version' <path>`，路径作为 argv 传入 | 含引号/分号/`$()` 的插件路径不再被 shell 解释；同时消除"直接能跑、shell 不能跑"的**假分叉**（R5） |
| WS-4a | 只对**绝对路径**候选做 execve 实测；相对路径/基名只做文件层并明确标注"未实测" | 收窄"插件 `data.json` 决定执行面"，是 HB-1 ④ 弱沙箱前的最低成本准备 |
| WS-6a（部分） | `ETIMEDOUT` 文案改为"超时 ≠ 文件有问题，大文件首次执行含签名校验/冷启动，建议再点一次" | 超时不再被误判成坏文件 |

### 三、仍然不做 / 待决策

同 215 轮：WM-1/4/6/7/8/9/11/12/13/14、HB-1（产品路线）、WS-1/2b/5/6b/7/8、HB-4②、HB-6。另记录两处"**无证据不动**"：

1. 手机 `FLOATING` 目前会发布 desktop（`if (status === FLOATING)` 无设备门），与手机小窗/悬浮窗语义可能冲突——但手机小窗是否真以上报 FLOATING 无证据，等取证；
2. DB-7（801 `capFailed` 终态化）：需要 801 拒绝设备的现场证明"永久性"，否则会把瞬时失败固化成"永不自绘标题栏"。

### 四、验证

- patch rev **193**；`update-obsidian.mjs --repatch` → `verify-asar` 全绿，新增 5 条断言：`app pandoc probe exec-bit EACCES split`、`app pandoc report verdict index`、`app pandoc shell probe passes path as argv`、`app pandoc probe absolute paths only`、`app pandoc settings row is diagnostics-only`。
- `assembleHap` BUILD SUCCESSFUL；HAP 内 `obsidian.asar` 复核 rev 193 与新文案，`modules.abc` 复核 `bridgeImmersiveId` / `windowIsMinimized` 已编入。
- `verify-release` / `check-docs` 全绿。
## 第 217 轮 (2026-11-18): 决策弱沙箱（HB-1 ④）——`CUSTOM_SANDBOX` 落地、沙箱形态自检与诊断分化

**决策**：采纳移交包 HB-1 的**第 ④ 条**——申请 ACL 权限 `ohos.permission.CUSTOM_SANDBOX`，让应用域可以 execve harmonybrew 的 adhoc 产物（pandoc 等）。理由是四条路线里唯一**零随包体积、直接复用 brew 生态**的一条；① HNP 随包（离线导出独有优势）与 ③ 云端/桌面侧导出保留为备选。代价是沙箱强度降级，属产品级取舍，已记档。

### 一、权限事实（SDK `toolchains/lib/PermissionDefinitions.json` 实测，不靠推测）

| 权限 | grantMode | availableLevel | since |
| --- | --- | --- | --- |
| `ohos.permission.CUSTOM_SANDBOX` | `system_grant` | `system_basic`（**ACL**） | 18 |
| `ohos.permission.READ_WRITE_USER_FILE` | `system_grant` | `system_basic`（**ACL**） | 13 |

两条都是 `system_grant`：**没有授权弹窗**，授予与否只看签名 profile 的 `acls`。
所以"装完没效果"的唯一成因就是 profile 没挂 ACL（B-WS-5），这也正是本轮要在诊断里把沙箱形态显式化（WS-5）的原因。

### 二、已落地（4 项）

| 编号 | 内容 | 位置 |
| --- | --- | --- |
| 清单开关 | `apply` / `revert` / `status` 三个动作，幂等、CRLF 安全（apply 后 revert 逐字节还原）；`status` 打印"生效五条件 + profile 模板路径" | `scripts/weak-sandbox.mjs`（新增） |
| WS-5 运行时自检 | 启动时 `checkAccessTokenSync(tokenID, 'ohos.permission.CUSTOM_SANDBOX')`，把 `sandbox: "weak"|"strong"` 写进 `ohsidian-mode.json`（**字段自有合并**，不动 systemMode/override/insets 等任何其它字段）；任何异常一律答 `strong` | `WebAbility.publishSandboxField()` / `sandboxMode()` |
| WS-1 消费侧 | 渲染层读该字段：设置→诊断显示「沙箱形态」一行；pandoc 报告顶部显示「沙箱形态」 | `touch-mode.js` `ohsidianSandboxMode()` / `ohsidianSandboxLabel()` |
| B-WS-6 文案分化 | **弱沙箱下 EPERM 不再讲签名故事**（那层裁决已放开），改为查 noexec/损坏/架构并提示"先确认 ACL 真生效"；强沙箱下保留原文案并补"申请弱沙箱"这一出路 | `touch-mode.js` `ohsidianProbeExecutable()` EPERM 分支 |

### 三、默认包不变（发版纪律）

- 默认构建**不带**这两条权限：声明了却拿不到 ACL 的包不能当发行包；
- 已验证：`apply` 后构建的 HAP，`module.json` 里两名都在（打包器接受）；`revert` 后重建的默认 HAP 里两名都不在（`IndexOf = -1`）；
- 弱沙箱包必须由"带 ACL 的 profile 重签"产生，装完先在诊断里确认 `沙箱形态: 弱沙箱`。

### 四、验证

- `weak-sandbox.mjs` apply → `assembleHap` BUILD SUCCESSFUL（manifest 合法）→ revert → 重建 BUILD SUCCESSFUL；
- HAP `ets/modules.abc` 内确认 `publishSandboxField` / `sandboxMode` 已编入；
- HAP 内 `obsidian.asar`：`OHSIDIAN_PATCH_REV=194`、`ohsidianSandboxMode`、弱沙箱 EPERM 文案均在；
- `verify-asar` 新增 3 条断言全绿：`app sandbox mode read from mode file`、`app pandoc probe weak-sandbox EPERM text`、`app pandoc report sandbox line`；`verify-release` / `check-docs` 全绿。

### 五、后续（本轮不做）

1. **profile ACL 由用户侧配置**：DevEco 26.0.0+ 在 IDE 里申请；老工具链改 `UnsgnedDebugProfileTemplate.json` 的 `acls` 后重签——步骤写进 `docs/PLATFORM-ADAPTATION.md` §五 5.2；
2. **WS-2 环境仿真段 / WS-6 探针异步化与超时分层 / WS-4 执行面收口**：都要弱沙箱包在手才能取数（V-WS-2/4/7），V-WS 矩阵已补进 §五 5.5；
3. **WS-3 自有导出 `spawn` 纪律**：现在没有自有导出实现，先作规范保留。
## 第 218 轮 (2026-11-18): 窗口状态机落地（三层 + E9 守卫表，手机不做）+ 诊断复制按钮 + 布局翻转合并窗

**范围**：交付移交包《跨设备窗口与布局状态机规格》的**第 1/2/3 层与 E9 守卫表**，并按用户指令**把手机整列剔除**（`module.json5` 的 `deviceTypes` 只有 `2in1`/`tablet`，手机装不上）。渲染层侧同时补"诊断结果一键复制"与 §九 的翻转合并窗（I9）。

### 一、新模块（纯逻辑，零 WMS 调用）

`web_engine/src/main/ets/common/WindowShapeMachine.ets`：

- **第 1 层 `LayoutProfile`**：`TABLET / PC2IN1 / OTHER`，构造时按 `deviceInfo.deviceType` 锁定一次；**无 PHONE**（规格 P-PHONE 作废，手机映射为 OTHER → 恒 desktop）。
- **第 2 层 `WindowShape`（8 态）** + `onStatus()`：**只消费事件值 + 当前形状**（转移起点语义 I2），**不读** `getWindowStatus()`——Bug1 的"事件里现读状态"结构上不可能再发生。
- **第 3 层 `PublishMode { KEEP, DESKTOP, TOUCH }`**：发布值只由形状派生（I1），`KEEP` = 不写盘（I3/I7）。
- **E9 守卫表**：`allowMaximize / allowEnterImmersive / allowExitImmersive / allowMinimize / allowRestore / allowSetBounds`。
- 每个窗口一个机器实例；**主窗**把实例 bind 到进程级句柄供 Adapter 查询（I5 结构部分）。

### 二、接线点（行为变化都在这几处）

| 位置 | 变化 |
| --- | --- |
| `WebAbility.onWindowStageCreate` | 主窗 `bind` + `seedStatus(实时状态)`（S0→S1/S2，不发布）+ 启动日志 |
| `windowStatusChange` | `onStatus(event)` → 形状迁移日志 → `applyShapePublish(result.publish)`；Round 153 自愈边改为 `result.correctTouchFullscreen`（形状条件，不再现读） |
| 启动读 / PC 开关观察者 | `setPcMode(on)` → 机器给发布值；2in1 常量、H15 豁免、BUG-003 自由窗语义全部收在机器里 |
| 多窗（I5） | `shouldPublishLayout()`：**焦点窗发布**（`WINDOW_ACTIVE` 时记录 `focusedInstance`、bind 它的机器并重新发布）；无焦点信息时主窗；无主窗存活时才轮到子窗（G-3 的文件层竞争从结构上消失） |
| `AppWindowAdapter` 六桥 | `maximize / minimize / restore / setFullScreen / setSimpleFullScreen` 全部问机器；**未绑定时回落原判据**（启动早期调用行为不变） |

**由此关闭的缺陷**：

- **WM-1（Bug1 的平板变体）**：平板 PC 关 + 自由多窗下最大化 → 形状是 `FREE_FLOAT → MAXIMIZED` → 发布 **desktop**，不再整页重载进移动布局；触摸态（S1）收到 MAXIMIZE/FLOATING 仍是 `TOUCH_FULL` + 只做整屏自愈（I6）。
- **G-1 入口 3/4 / Round 153**：自愈边由形状条件驱动，不再依赖"此刻不是自由窗"的现读。
- **G-3**：主窗单写者。
- **G-4 最小化**：`MINIMIZE → KEEP`（可见性变化，恢复事件按返回形状发布）；未知值 KEEP（I7）。

### 三、渲染层（§九 / I9）

- **诊断结果一键复制**：设置 → 诊断 → Pandoc 环境检查，内联结果旁新增「复制结果」按钮（无结果时隐藏；`navigator.clipboard` 优先，`textarea+execCommand("copy")` 兜底；成功「已复制」/失败「复制失败」，1.5s 复原）。命令面板弹窗原有的「复制详细信息」保持不变。
- **布局翻转合并窗（I9）**：`ohsidianFlipSettleMs=2000`，只作用于 auto（跟随系统）路径——200ms 轮询读到翻转后先挂起，窗口内再翻转只保留最新值；到期若已兜回渲染值则**什么都不做**（不 reload、不弹 Notice）；启动首读立即应用；手动切换命令立即生效并取消待定窗。**一次窗口动作最多一次 reload。**

### 四、与规格的差异（如实记录）

1. **手机不实现**（见上），旧 `deviceType === 'phone'` 分支保留原样、不再维护；
2. **override（I8）仍在渲染层**：ArkTS 照写 `systemMode`，渲染层以 override 优先，语义与改造前一致；
3. **横切 A（装饰）/ 横切 B（insets）未迁移**：`pushSafeAreaInsets`、`ensureSystemCaption`、`applyLayoutFullscreenForMode`、`forceFullscreenWindow` 仍用 `inWindowForm()/freeWindowForm()`（后者仍读实时状态），但它们**不参与发布判定**，I1 成立；迁移留到步 3；
4. **SPLIT 只发布**，rect/inset 交给 `windowRectChange/windowSizeChange`；
5. **焦点仲裁已实现**：`windowEvent` 的 `WINDOW_ACTIVE/INACTIVE` 复用 Round 99 的焦点通道，切窗即按该窗形状重新发布。

### 五、验证

- `WindowShapeMachine.ets` 编译通过；HAP 的 `ets/modules.abc` 内确认 `WindowShapeMachine / publishSystemMode / allowEnterImmersive / shouldPublishLayout` 已编入。
- `--repatch` 后 `verify-asar` 全绿（新增 `app diag copy button`、`app layout flip debounce` 两条断言）；HAP 内 `obsidian.asar` 确认 `OHSIDIAN_PATCH_REV=195`、复制 helper、合并窗常量均在。
- `assembleHap` BUILD SUCCESSFUL；`verify-release` / `check-docs` 全绿。
- 真机取证锚点：`window shape <旧> -> <新> (<原因>)`、`touch mode file updated: systemMode=…, profile=…, pcMode=…, shape=…`、`maximize/minimize/restore/… ignored (…)`。

### 六、真机验收（重点）

1. 平板 PC 关 + 自由多窗最大化/恢复 → **无 reload**、布局保持桌面（V4）；
2. 触摸态被 WMS 铺满（reason:1）→ 只有整屏自愈与一条日志，无发布写盘（V5）；
3. 2in1 最大化/恢复/沉浸 → 发布恒 desktop、无 reload（V1/V2）；
4. 折叠/旋转/连续拖拽改尺寸 → 布局最多翻转一次（合并窗），不出现连续 reload（I9）；
5. 设置页点「复制结果」→ 剪贴板拿到完整报告（若两条剪贴板路径都被拒，按钮显示「复制失败」，退回命令面板「复制详细信息」）。

## 第 219 轮 (2026-11-22): 插件加载失败定谳落地（NF-015~018）——安装完整性、`secretStorage` 明文兜底、错误日志默认落盘、decor 能力缓存（补丁 rev 196→212）

输入：外部审计《OHSidian-坚果云与 BRAT 插件加载失败——合并定谳报告》（审计对象 `main @ e528275`）。
报告结论：**两个插件不是同一种死法，也都不是 2.0 的代码改动杀的**——坚果云 1.6.2 的 4.18 MB
`main.js` 在不稳链路被中段截断（审计实测确定性断点 1,548,288 B）→ `eval` SyntaxError → 563
弹窗；BRAT 2.2.0 的设置页注册在吞错异步链末端，迁移必经 `app.secretStorage.setSecret` →
内核桌面适配器读 `window.electron.remote.safeStorage` → 引擎零实现 → TypeError 被
`.catch(console.error)` 吞掉 → 注册永不执行。本轮落地报告 NF-015/016/017/018 四条。
（报告"2.0 无关"的增量考古见原报告第三部分；本轮**不动**插件 require 白名单——报告 §1.3
已证对坚果云全版本无收益。）

### 一、NF-015：插件安装完整性（P1）

- 根因链（上游 `app.js` 逐字）：`zy()` 只在请求**抛异常**时才代理重试；半截响应被当成成功
  时，`installPlugin` 把残缺 `main.js` 原样落盘、零校验，之后每次 `loadPlugin` 的 `eval`
  必 SyntaxError。
- 新流程：`Plugins.prototype.__ohsidianFetchPluginBundle` **先下载后写盘**（manifest+main.js
  在插件目录创建前预取），对 main.js 做 `new Function(text.replace(f4,"")+v4)`（与
  `loadPlugin` 同一语法门槛），失败经 `releases.obsidian.md/proxy` 重试一次，仍失败则
  **未写任何文件**并显示「安装失败：插件文件下载不完整（疑似网络截断），请更换网络后重试」；
  代理自身失败不吞掉"截断"结论。
- 已装坏的插件：`enablePlugin` 的 catch 对 `SyntaxError` 追加专用 Notice
  （「main.js 无法解析：文件可能下载不完整…」），与普通加载失败区分。
- 不用 `content-length`：gzip 后长度不可比，误判会弄坏**好插件**。语法探测对审计实测截断点
  （1.0/1.5/2/3/4 MB）全部命中；**残余**：切在语句边界、仍可解析的截断（随机切点实测约 3%）
  语法门槛拦不住，会以"加载后 No exports detected → 通用 563"出现——如实记录，未覆盖。
- 边界：预取失败会中止整单安装（旧代码 main.js 下载失败仍继续写 manifest）；ID 不匹配时会
  多下载一次 main.js（先校验后落盘）。
- 成本：4 MB 解析约 100 ms，仅安装时一次；正常插件零额外行为。

### 二、NF-018：`secretStorage` 明文兜底（P1，安全取舍已记录）

- 断链点：内核 `k6` 构造 `n.safeStorage=window.electron.remote.safeStorage`；引擎无
  `safeStorage`，于是 `isEncryptionAvailable()` TypeError → 内核 catch 吞掉 → `adapter=null`
  → `setSecret()` 抛 "Secure storage is not available." → BRAT 迁移失败且无提示、每启动复发。
- 两侧补丁：`touch-mode.js` 前置定义 `window.__ohsidianSafeStorageFallback`（加密不可用、
  明文透传、`basic_text` 后端）；`update-obsidian.mjs` 把 `k6` 构造改为「引擎四方法
  （`isEncryptionAvailable`/`encryptString`/`decryptString`/`getSelectedStorageBackend`）齐全
  才用，否则用兜底」。明文保存与内核移动端 `C6` 相同；`isEncryptionAvailable()=false` 比 C6
  更诚实（C6 路径下内核返回 true、不弹警告），因此本补丁会触发内核自带的「密钥未加密」警告。
- **取舍**：密钥明文落盘（localStorage `secrets-encrypted`）。移动端内核本来如此，不是本轮新增
  暴露面；引擎将来提供真 `safeStorage` 时自动改用。不改 SELinux/签名/文件权限。

### 三、NF-016：渲染层错误日志默认落盘（P2，T2-9）

- 三态：不存在 = **仅错误（默认）**（`console.error` + `window.onerror` +
  `unhandledrejection`）；`"1"` = 全量；`"0"` = 关闭。命令面板「运行日志捕获
  (仅错误/全量/关闭, 重启生效)」循环切换；诊断状态页「调试」段新增「日志捕获」行。
- 主进程侧不变（`<Documents|userData>/OHSidian/console.log`，512 KB 轮转，40 行/s 限流），
  ready 日志文案改为「error lines always captured」。
- 目的：本案 21 秒日志零渲染层输出，插件失败只能靠代码考古；现在开机即有据。
- **P1 修复（独立审查发现）**：round-96b 的桥接用 `require("@electron/remote").ipcRenderer`，
  但该 renderer 模块只导出模块 getter、**不导出 ipcRenderer** → 恒 undefined → 旧桥自上线起
  一行未发、`console.log` 从未产生。改为 `window.electron.ipcRenderer ||
  require("electron").ipcRenderer`（内核自身同通道），门禁新增接线断言；同一根因的
  「迁移仓库到可见文件夹」最后一步 `remote.ipcRenderer.sendSync("vault-open")` 也一并修复。
- 隐私面：默认档把 `console.error` 原文写入公共 Documents 下的 `console.log`（Documents
  不可用时落 userData），错误串可能含路径/URL/token；要停用切「关闭」档（显式 opt-out）。

### 四、NF-017：WMS decor 能力缓存（P3，T2-2）

- 新增 `web_engine/src/main/ets/common/WindowDecorCapability.ets`：按 kind 缓存 801，
  首次一条 info，之后重复 801 降 debug；非 801 错误保持 warn。**不跳过调用**——801 可能
  与形态相关（同一进程里触摸全屏窗没有标题条，另一扇自由窗仍需要），跳过会让后开的自由窗
  少配置一项，属有回归风险的优化；噪声削减来自下面的调用点门控。
- 启动装饰块：标题条族只在 `inWindowForm()` 调用（Round 154「decor 是形态属性」同一结论），
  触屏全屏不再发这些注定 801 的调用；`ensureSystemCaption` 既有语义（返回 false + latch）不变。
- `AppWindowAdapter` 的 8 处 decor 调用（title buttons ×2、topmost、setUseNativeFrame ×2、
  movable、resizable、modal）全部收口到缓存；`WebAbility.enforceFrameStyle` 同样收口。

### 五、顺带：机上可用的插件完整性诊断

命令面板新增「OHSidian 诊断: 插件完整性与安全存储」——报告 §五的控制台探针在平板上无法输入，
改为应用内一键出报告（可复制）：
① `secretStorage` 适配器与 `isEncryptionAvailable()`；② 引擎 `safeStorage` 缺口；
③ 逐个插件的 `main.js` 字节数 + 与 `loadPlugin` 同构的解析结果（BAD = 截断实锤）；
④ BRAT 迁移标记是否存在。只读；插件体逐个解析（不并发读入内存）、上限 20 个。

### 六、验证（本机，2026-11-22）

- 新增 `scripts/verify-plugin-install.cjs`（由 `verify-asar.cjs` 调用，CI 自动覆盖）：
  从**出货 asar** 取 helper 与机上诊断函数，用合成下载/合成仓库跑 5 个下载行为用例、
  4 个 `safeStorage` 兜底用例、7 个诊断输出断言，另加 installPlugin case1/2/10/12 精确接线、
  IPC 句柄与内核真实 `f4`/`v4` 提取断言；不是只查 marker。
- `--repatch` → 内嵌 verify-asar 全绿；HAP 内 `ets/modules.abc` 含 `WindowDecorCapability` /
  `decor API answered 801`；HAP 内 asar 复核 rev 212、四条 NF 标记、错误默认档、复制按钮仍在。
- `assembleHap` **BUILD SUCCESSFUL**；`verify-release` / `check-docs`（73 链接）全绿。
- 文档：`docs/PLATFORM-ADAPTATION.md` §六（机制/取舍/支持话术/真机步骤）、`docs/RELEASE.md`
  §6 两条 FAQ、`docs/window-state-machine.md` §8.3/§8.5 补 NF-017 边界与取证锚点。

### 七、真机验收清单（新）

1. **BRAT 2.2.0**：重装 → 设置页出现；诊断里「BRAT 迁移标记: 存在」；`secretStorage` 行
   `WARN … isEncryptionAvailable=false（明文模式）`；重启不再复现。
2. **坚果云 1.6.2**：市场卸载 → 重装 → 加载成功、设置页出现；`main.js` = 4,182,455 B；
   弱网/断网重试时若弹「下载不完整」= NF-015 按预期拦截（旧行为是装个坏的）。
3. **触屏冷启动**：decor 801 噪声从 6+ 条降到**每个 kind ≤1 条 info**
   （`decor API answered 801 …`；触屏预计 ≥2 个 kind：`modal` + `setUseNativeFrame` 路径的
   `titleMove`/`titleButtons`）；WMS 原生打印只对未被门控的那几次调用保留。
4. **渲染层取证**：默认档下 `console.log` 出现 `[OHSidian:web][error] Plugin failure: …`；
   命令切「全量」重启后 log/info 才有。
5. **诊断命令**：报告弹窗可复制；BAD/OK 与真实文件一致。
6. **不回归**：2in1 最大化/恢复/沉浸、平板自由窗标题条拖动/三键、设置页开关仍正常
   （NF-017 只改"何时调/怎么记日志"，2in1 上这些能力都是 supported，不会触发缓存）。

### 八、未做

- 引擎网络栈对截断体的语义仍无法从仓库闭环；手动放置/BRAT 自装插件只能事后诊断，
  未做"加载失败→引导重装"的自动修复；
- 真加密（引擎补齐 `safeStorage`）仍是 NF-018 长期项；
- `GetTitleButtonVisible` 等引擎内部 decor 调用应用层管不到；
- 本轮未提版本号（仍 2.0.1），发版时再定 2.0.2。

### 九、独立审查（2026-11-22 二次）与修复

只读审查（对照冻结态代码 + 出货 asar 逐字，独立于本机门禁）结论：NF-015/017/018 实现无
P1/P2；NF-016 有 1 个 P1 与 3 个 P2，全部已修，并复跑全部门禁：

- **P1**：console bridge 的 `@electron/remote.ipcRenderer` 恒 undefined（见 §三），已改真实
  IPC 句柄并加门禁；同一根因的 vault-open 迁移失败一并修。
- **P2-1 门禁假保障**：`verify-plugin-install` 原先自带 f4/v4、只查 marker。现改为**从出货
  asar 提取内核真实 f4/v4** 实例化 helper，并断言 installPlugin 的 case1/2/10/12 精确接线、
  IPC 接线、safeStorage 四方法判定；另加机上诊断 7 项行为断言。
- **P2-2 文档入口不存在**：原来只有命令面板入口。现设置页「诊断」组新增「插件完整性与安全
  存储」行（组名 `Pandoc 诊断` → `诊断`），文档与命令面板两个入口都成立。
- **P2-3 验收锚点与实现不符**："最多 1 条 info" 改为"每个 kind 至多 1 条"，并说明 WMS 原生行。
- **P3 处置**：C6 语义措辞、四方法 vs 三方法（代码补第 4 个校验）、随机截断残余比例、
  2in1 启动门控改用 `captionForm()`（`inWindowForm()` 在 2in1 恒 false）、
  `enforceFrameStyle` latch 只在实际成功时置位、机上诊断 >6 MB 标 SKIP 并单独计数、
  BRAT 迁移路径改用 `vault.configDir`、NF-016 隐私面补记。

### 十、P0 回归（2026-11-22，真机首启报错）

**症状**：装 rev 196 HAP 后冷启动，Obsidian 启动页显示
「加载 Obsidian 时发生错误。 TypeError: i.app.plugins.on is not a function」。

**根因**：NF-015 的 helper 用文本补丁插在压缩类的**方法链**里。该内核把类成员写成一条逗号
表达式：`var m4=function(e){function t(t){…}return v(t,e),method1=…,method2=…,t}(FD)`。
helper 以 `};` 结尾，这个 `;` 在方法链中**提前结束了 return**：类工厂不再返回类 `t`，而是返回
helper 函数本身；`s=this.plugins=new m4(this)` 变成用 helper 当构造器 → 返回 `Promise.all(...)`，
`app.plugins` 成了 Promise；紧接着 `this.setting=new Aie(this)` 构造社区插件设置页时执行
`i.app.plugins.on("changed",…)` → TypeError，启动中止。

**影响**：整包无法启动（P0）。所有既有 marker/语法门禁都发现不了——语法合法、字符串齐全；
v195/196 之前的补丁没有往类方法链里插过成员，这是第一次。

**修复**：helper 改为以 `}` 结尾、用 `,` 与后续方法连接（`update-obsidian.mjs` 的
`PLUGIN_INSTALL_HELPER_DST`），补丁 rev 196→197；重建 asar 与 HAP。

**门禁补强**（这次必须能拦住）：`verify-plugin-install.cjs` 新增两类断言——
① 结构：helper 必须由 `,t.prototype.installPlugin` 连接、不得出现 `};t.prototype.installPlugin`；
② **运行时**：从出货 asar 中提取 PluginManager 类工厂，在桩环境里 `with` 求值，断言返回值
是类且 `installPlugin/enablePlugin/checkForUpdates/__ohsidianFetchPluginBundle` 都在原型上。
已用 rev 196 的坏 asar 复现该门禁失败，修复后全绿。

**教训**：对压缩内核做文本补丁时，"插进去的代码语法合法"不等于"宿主类仍然完整"；凡插入到
`return a,b,c` 这类逗号表达式内部的补丁，都要有运行时/结构双门禁。

### 十一、BRAT 设置页仍缺失（2026-11-22 真机续）：诊断补齐 + 设置页自愈（rev 198）

**真机现象（rev197）**：BRAT 迁移已成功（诊断显示迁移标记存在、`main.js` 可解析、
`secretStorage` 为明文模式），但设置页仍不出现，并且启动时提示
「插件 “obsidian42-brat” 在加载时遇到错误」。

**判定**：这条提示来自 Obsidian 的 layout-ready 循环——插件用
`workspace.onLayoutReady(cb)` 注册的回调抛错时会 `console.error(e)` 并按 `pluginId` 弹提示。
BRAT 2.2.0 的 `addSettingTab(this.settingsTab)` 正好在这个回调里：回调一抛，设置页就永远
注册不上；而该错误此前在 console.log 里被记成 `{}`（`JSON.stringify(Error)`），拿不到栈。

**rev 198 落地**：
- 渲染层 console bridge 保留 `Error.stack`（不再退化成 `{}`），layout-ready 回调的错误栈
  可以落进 `<Documents|userData>/OHSidian/console.log`；
- 机上诊断新增「插件加载状态」段：BRAT manifest 版本、插件实例是否加载、`loadingPluginId`、
  **已注册插件设置页列表**、**设置页自愈结果**；末尾追加 **console.log 尾部**（最多 40 行）——
  一次诊断即可拿到错误栈，不必连电脑；
- 兼容补丁 `ohsidianRepairPluginSettingTabs()`：在 layout-ready 后 1.5s、以及每次打开设置页
  （含 80/300/800/1600/3000ms 重试链）时，把"已加载插件已构造但未注册"的 settingsTab 补注册；
  失败时把每个插件的栈写进日志并在诊断里显示。对 BRAT 这类"回调抛错导致 tab 丢失"的插件，
  补注册成功后设置页立即出现（临时兜底，不等于根因修复）。

**rev 199（拿到栈之后）**：根因在**插件文件本身**。真机栈为
`je.getSettingDefinitions → R is not a function`；BRAT 的 `R` 就是 `getTranslations`（i18n 模块）。
设备上的 `obsidian42-brat/main.js` = **214 KB / ≥85 行**，而官方 2.2.0 release 是
**138,873 B / 45 行**且含 `function R(...)`（sha256 前 16 位 `d2fb579d4e83162a`）——语法可解析但内部函数缺失，
正是 NF-015 文档里记录的"残余坏构建"（语法门槛放行、运行时才炸），且它不在市场安装链上（BRAT 自我更新/镜像站），
NF-015 拦不到。**内核侧无需改**：处置是重装官方插件。为此 rev199 给诊断补两段——
「BRAT main.js 指纹」（字节/行数/sha256 + 官方 2.2.0 / 2.3.0-beta.1 对照）与
「BRAT 失败位置」（按栈的行/列打印源码窗口、`getSettingDefinitions` 附近代码、i18n 函数是否存在），
让同类问题一次定位到文件而不是内核。设置页补注册兜底保留（对完整 bundle 有效）。

**rev 200（真机复测）**：用户从官方仓库重装后，诊断显示 `main.js` = 138,891 B/46 行/`44956ba123c4d1a1`——
这正是**官方 2.2.0 资产经内核 `installPlugin` 处理后的形态**（安装会追加 `/* nosourcemap */` 标记：
+18 B、+1 行）。rev199 的指纹表只存了原始资产哈希（138,873 B/45 行/`d2fb579d4e83162a`），
因此把合法安装误判成「非官方构建」——rev200 先按安装规则归一化再比对，并同时接受两种哈希。
同一次诊断还显示 `已注册插件设置页(11)` 已含 `obsidian42-brat`、自愈无待办：**设置页已注册成功**，
日志里 03:48 的 `R is not a function` 来自重装前启动的旧实例（控制台日志是累积的）。
rev200 因此再加一段「BRAT 文件时效」：`main.js` 修改时间晚于本会话启动时间就判「当前运行的是旧代码」，
提示必须**完全退出应用**（不是切后台）再启动。结论：本例根因是旧/残缺构建 + 重装后未重启，
内核无需改动。
**仍未完成**（原记）：
BRAT settingsTab 的 `update()/display()` 在本端口抛错、或 `registerObsidianProtocolHandler` 抛错；
拿到栈后再决定是补平台 API 还是继续用补注册兜底。

### 十二、rev 201：插件排查面泛化 + 手写笔浮层守卫

**任务 1：插件诊断泛化**（保留并加强 console.log 能力）

- 错误采集独立于日志档位：`console.error`、`window.onerror`、`unhandledrejection` 三类都进
  `ohsidianRecordConsoleError()`；按内核 `Plugin failure: <id>`、我们的
  `plugin setting tab registration failed: <id>`、以及 `Error.stack` 中的
  `plugin:<id>:<line>:<col>` sourceURL 归属到插件，连续相同错误合并 `×N`；
- 持久化 `<Documents|userData>/OHSidian/plugin-errors.json`（最多 60 条），重启/下次会话仍可见；
- 报告改名「插件排查（清单 / 错误 / 日志）」，新增：插件清单状态列（版本/大小/解析/启用/加载/
  设置页/最近错误）、插件错误段（含栈）、渲染层日志优先 error/插件行、支持文件绝对路径；
- 新命令「OHSidian 诊断: 清空插件错误记录」；设置「诊断」组入口同步改名。

**任务 2：手写笔控件在浮层打开时不可触**

- 现象：设置界面弹出时，手写笔工具条仍浮在上面且可点（文件列表/大纲抽屉同理）。
- 修法：`ohsidian-ink.js` 新增 `overlayOpenNow()` / `refreshOverlayGuard()`（350ms 轮询）：
  检测 `.modal-container`/`.prompt`/`.suggestion-container`/`.menu`/`.workspace-drawer.is-open`
  以及 `body.is-left-sidedock-open` / `is-right-sidedock-open`；命中时给 `<body>` 加
  `ohsidian-overlay-open`，CSS 令 ink 工具条/菜单/清除面板/选区条 `pointer-events:none` 且透明；
  浮层关闭自动恢复。我们自己的 ink 菜单被排除在检测外，不会自己把自己关掉。
- 笔端同受保护：`isExcluded()` 已把浮层内目标排除在绘制路径外，浮层内笔触不会画到正文。

**验证**（本机）：`--repatch` 内嵌 `verify-asar` 全绿（新增 ink 浮层守卫标记、插件错误记录器标记、
记录器行为用例 7 条：sourceURL 归属、`Plugin failure:` 归属、无归属不入表、连续去重、持久化、清空）；
`assembleHap` BUILD SUCCESSFUL；HAP 内 asar 复核 rev 201；`verify-release` / `check-docs` 全绿。
**真机待验**：① 打开设置/文件列表/大纲 → 工具条不可见不可点，关闭后恢复；② 插件报错后
  `plugin-errors.json` 出现且诊断「插件错误」段显示，重启后仍显示（标"上次会话"）。

### 十三、rev 202：抽屉浮层守卫修复 + 插件设置页去重

**问题 1：文件列表/大纲抽屉打开时工具条仍可点**

- 根因：rev201 的 `overlayOpenNow()` 只看 `<body>` 的 `is-left/right-sidedock-open` 与
  `.workspace-drawer.is-open`。实际此布局把开关类加在 **`workspace.containerEl`**
  （`is-<side>-sidedock-open`），且移动端抽屉本体 `.workspace-drawer` 是"关闭 display:none、打开显示"
  的开关方式，两个信号都没被检测到。
- 修法：`overlayOpenNow()` 增加 ① `workspace.containerEl` 的 sidedock 类（仅移动布局生效，PC/2in1
  常驻侧栏不隐藏工具条）② 可见的 `.workspace-drawer`（computed display 非 none 且 rect 有面积）。

**问题 2：诊断里"已注册插件设置页"出现两个 obsidian42-brat**

- 根因：补注册在 layout-ready 回调内执行，可能早于插件自己的 `onLayoutReady` 回调；我方先注册
  `settingsTab`，插件随后用同一对象再 `addSettingTab`，内核不去重 → 设置导航出现两个同名条目。
- 修法：补注册改为按**插件 id** 幂等；调度从 layout-ready 内 + 1500ms 改为 **layout-ready 之后 3.5s**
  且不在 layout-ready 循环里注册；新增 `ohsidianDedupePluginSettingTabs()` 在每次补注册/诊断时清理
  `pluginTabs` 中的重复项（保留第一个并刷新导航）。

**验证**：`--repatch` 全绿（新增「浮层能看到抽屉」「插件设置页去重」两条标记）；`assembleHap`
BUILD SUCCESSFUL；HAP 内 asar 复核 rev 202；`verify-release` / `check-docs` 全绿。
**真机待验**：① 打开文件列表/大纲 → 工具条消失、点不到，关闭后 0.5s 内恢复；② 设置导航里每个插件
  只有一个设置页（诊断「已注册插件设置页」列表无重复）；③ 设置/命令面板等原有浮层行为不变。

### 十四、rev 203：设置页诊断中心 + console.log 进状态报告 + 沙箱原因诊断 + Nutstore 设置键修复

**设置页 = 诊断中心（任务要求）**

- 设置 →「诊断」组现在包含：插件排查（清单/错误/日志）、补丁与设置状态、运行日志捕获（显示当前档位，
  按钮循环切换）、清空插件错误记录、支持文件（console.log / plugin-errors.json 路径 + 复制路径）；
  Pandoc 环境检查保留。命令面板入口全部保留。
- 「补丁与设置状态」报告（命令与设置入口共用）追加 `▍渲染层日志`：console.log 尾部（优先错误/插件行）
  与日志文件路径 —— 与插件排查报告共用同一套 `ohsidianLogTailLines()`，不再各写一份。

**沙箱为什么失败：诊断直接给原因**

- ArkTS 新增发布 `sandboxDeclared`（本包是否在 requestPermissions 声明 CUSTOM_SANDBOX）与
  `sandboxApi`（设备 API），渲染层据此把「强沙箱」细化为：
  ①本包未声明（默认构建不带该权限）→ 先 `weak-sandbox.mjs apply` 再重签；
  ②已声明但未授予 → 签名 profile 缺 ACL，用带 ACL 的 profile 重签；③设备 API < 18。
- 本机实测状态：`module.json5` 未声明、签名 profile 的 7 条 ACL 里也没有 `CUSTOM_SANDBOX`/
  `READ_WRITE_USER_FILE` → 当前 HAP 必然是 strong；两条都要补（声明 + profile ACL）后才能弱沙箱。

**插件还有什么要修：真机日志审计结论**

- `Nutstore Sync: duplicate setting key "group:模块开关"`（3 次，当前版本仍复现）：内核设置项 key 由
  `type:heading` 生成，插件有两个同名 heading 的 group 必冲突（日志由内核打印，会误导为重渲染异常）。
  修复：内核 `$2()` 的 key 增加位置后缀（`(type:heading)#index`）——唯一且跨重渲染稳定，告警消失，
  也避免 keyed diff 把两组 DOM 复用到一起。
- BRAT 设置页重复 / 抽屉守卫漏检：已在 rev202 修（见 §十三）。
- 日志中的 `r.plugins.isEnabled is not a function`、`{}`、`Failed to load settings: {}` 均为
  rev196 P0 构建或坏包时代的旧会话记录（`app.plugins` 曾变成 Promise / 旧 console bridge 把 Error 记成
  `{}`），当前构建不存在。
- 结论：当前已知插件侧缺陷只剩上面已修的 Nutstore 键冲突；未见其它插件异常。

**验证**：`--repatch` 全绿（新增 4 条门禁：设置诊断中心、状态报告带日志、沙箱原因诊断、内核设置键唯一）；
`assembleHap` BUILD SUCCESSFUL；HAP 内 asar 复核 rev 203；`verify-release` / `check-docs` 全绿。
**真机待验**：① 设置「诊断」组各按钮可用；② 状态报告含日志尾部；③ 沙箱行显示"本包未声明…"（默认构建）；
④ 打开 Nutstore 设置不再出现 duplicate setting key 告警。

### 十五、rev 204：日志尾部只显示本会话 + 新增「清空渲染层日志」

- 现象：诊断报告（以及"补丁与设置状态"）的日志段把**跨启动追加**的 console.log 尾部原样列出，早期坏包/P0
  构建时代的报错（`R is not a function`、`{}`、`Failed to load settings`）每次都出现，看起来像"现在还在报"。
- 修法：`ohsidianLogTailLines()` 按行首时间戳与 `window.__ohsidianBootAt` 过滤，只保留本会话的行（栈续行跟随
  其头部），并标注"已折叠更早会话 N 行"；本会话没有错误行时显示"(本会话还没有日志行)"。
- 新增「清空渲染层日志」：设置「诊断」组一行 + 命令 `OHSidian 诊断: 清空渲染层日志`，直接清空 console.log，
  便于"清空 → 复现 → 报告只含新证据"的排障流程。
- 门禁：verify-asar 增两条标记；verify-plugin-install 增行为用例（旧启动的行必须被丢弃、折叠计数与格式正确）。

**验证**：--repatch/verify-asar/verify-release/check-docs 全绿；assembleHap BUILD SUCCESSFUL；HAP 内 asar
复核 rev204。**真机待验**：状态报告日志段只含本会话行；「清空渲染层日志」后报告显示空/本会话新行。

### 十六、rev 205：内置 Pandoc 3.10（WebAssembly）——PC 与平板都能用真 pandoc

**需求**：不申请弱沙箱，且 PC/平板都要能调用 pandoc（平板禁 `fork+exec`，HNP/HAP-bin 仅 PC/2in1）。

**落地**：内置官方 `pandoc/pandoc-wasm`（Pandoc 3.10，GPL-2.0-or-later），在渲染进程内执行。

- `scripts/build-pandoc-wasm.mjs`：按 `scripts/pandoc-wasm.lock.json` 下载并校验 npm 包（pandoc-wasm@1.1.0、
  @bjorn3/browser_wasi_shim@0.4.2），生成 `pandoc.wasm.gz`（15.5 MB）+ `pandoc-service.cjs`（83 KB，
  core.js+WASI shim 由 esbuild 打包）+ GPL/来源说明；`--check` 只校验 lock；`--update-lock` 用于升级。
- `scripts/pandoc-wasm/service-core.mjs`：CLI 适配（`shellSplit`/`parseArgs`）、文件/参考文档/模板/bib/csl/
  Lua filter/本地图片收集、`--version` 不加载 wasm、二进制输出必须 `-o`、PDF 与可执行 filter 明确拒绝、
  `selfTest()`。Node 行为门禁实测：md→docx 80–300 ms（首次 ≈1 s）、285 KB md→html ≈2.8 s。
- `scripts/patches/pandoc-wasm.js`：`Module._load` hook 替换 `child_process`（exec/execFile/spawn 接管 pandoc，
  同步 API 明确报错）、`lookpath`/`which` 占位路径；`pandocDir` 从模式文件读取（ArkTS `publishPandocDir`），
  暴露 `window.__ohsidianPandoc`。
- 设置「诊断」新增「Pandoc（内置 WASM）」状态+自检；状态报告新增 `Pandoc(内置)`；命令
  `OHSidian 诊断: Pandoc（内置 WASM）自检`。
- CI（`build-release.yml`）：cache 下载 → `build-pandoc-wasm.mjs` → `verify-pandoc-wasm.cjs`；
  HAP 增大 ≈16 MB（120.5 → 137.7 MB）。

**限制**：无 PDF（需外部 LaTeX/Typst，指向内置 PDF 导出）、不联网、仅 Lua filter、同步 API 不支持；
内存峰值 +100–200 MB。**GPL**：HAP 内附许可证与源码说明。

**验证**：`verify-pandoc-wasm` 全绿（真实 docx/html 转换、reference-doc、Lua filter、本地图片、PDF/exec-filter
拒绝、--version 快速应答）；`--repatch`/`verify-asar`/`verify-release`/`check-docs` 全绿；HAP 内 asar 复核
rev 205 与 patch 标记、`modules.abc` 含 `publishPandocDir`、HAP 含 `resources/resfile/pandoc/*`。
**真机待验**：① 设置→诊断→Pandoc 自检通过；② 用 Enhancing Export 导出 docx/pptx/epub；③ 平板与 PC 同一 HAP 均可用；
④ PDF 导出给出明确提示。

### 十七、rev 206：修复内置 pandoc 的自检无弹窗与资源路径未发布

真机第一次运行 rev205 暴露两个问题：

1. **设置里「Pandoc（内置 WASM）」点自检没有弹窗**：资源缺失时 `getService()` 同步抛错，被 click 处理器的
   try/catch 静默吞掉。修法：`selfTest()`/`run()` 始终返回 Promise，失败走 `.catch` 并**总是**打开报告弹窗，
   内容含错误 + 路径探针（模式字段 / execPath / resourcesPath / appPath / 每个候选目录是否存在）；
2. **`pandocDir` 未发布 / 资源未找到**：rev205 直接拼 `resourceDir + '/resources/resfile/pandoc'`，与设备实际
   安装布局不符。修法：ArkTS `publishPandocDir()` 改为用 `fileIo.accessSync` 探测
   `resourceDir`/`bundleCodeDir` × `''`/`/resources/resfile`/`/resources` 候选矩阵，发布命中目录，并写入
   `pandocDirTried`/`resourceDir`/`bundleCodeDir`；渲染层多候选路径 + 失败不缓存（晚发布可自愈）+
   `execPath`/`resourcesPath`/`appPath`/固定绝对路径兜底；新增命令「OHSidian 诊断: Pandoc 路径探针」。

**验证**：`--repatch`/`verify-asar`（新增 pandoc 路径探针标记）/`verify-pandoc-wasm`/`verify-release`/
`check-docs` 全绿；`assembleHap` BUILD SUCCESSFUL；HAP 内 asar 复核 rev206、`modules.abc` 含
`pandocDirTried`/`bundleCodeDir` 探测逻辑。
**真机待验**：① 设置→诊断→Pandoc（内置 WASM）→自检能弹出结果；② 若仍报未找到，自检弹窗/「Pandoc 路径探针」
会列出候选目录与存在性，据此可直接定位安装布局；③ 成功后用 Enhancing Export 导出 docx/pptx/epub。

### 十八、rev 207：渲染进程无 WebAssembly → pandoc 自动改由主进程执行

真机 rev206 自检报告：`pandoc 3.10 · 未初始化`，`FAIL version · WebAssembly is not defined`。
说明该鸿蒙 Electron 引擎的渲染进程 V8 没有 WebAssembly（不是资源路径问题——资源目录已正确解析到
`/data/storage/el1/bundle/electron/resources/resfile/pandoc`）。

修法：
- 主进程补丁注册 `ohs-pandoc-call`（runCli/query/selfTest/info，串行执行）与 `ohs-pandoc-host`（typeof
  WebAssembly + node/electron 版本）；主进程 `require()` 资源里的 `pandoc-service.cjs`，实例按 servicePath 缓存；
- 渲染层检测 `typeof WebAssembly`：不可用时用 `ipcRenderer.invoke` 代理到主进程，接口与本地服务一致；
- 自检/失败报告新增「执行位置」与「宿主 WebAssembly（渲染/主进程）」；若主进程也没有 wasm，报告会直接显示
  `主进程=undefined`，届时需要纯 JS 解释器/预编译 asm.js 方案（另立项）；
- 「Pandoc 环境检查」设置按钮同时弹出报告窗口。

**验证**：--repatch/verify-asar（新增「pandoc 主进程回退」「主进程 pandoc host」两条标记）/
verify-pandoc-wasm/verify-release 全绿；assembleHap BUILD SUCCESSFUL；HAP 内 asar 复核 rev207，
main.js 含主进程服务 host。
**真机待验**：① 自检报告应显示「执行位置: 主进程」且 version/html/docx 通过；② 若宿主 WebAssembly 行显示
主进程也是 undefined，把报告发我，下一步做预编译 JS 方案；③ 通过后运行 Enhancing Export 导出 docx/pptx/epub。

### 十九、rev 208：引擎 V8 为 jitless → pandoc 改在独立工具进程（--no-jitless）执行

rev207 真机结果：执行位置已显示「主进程」，但仍 `WebAssembly is not defined` → 主进程 V8 也没有 WASM。
检查引擎 `libelectron.so`：存在 `"v8_enable_webassembly": 1`（功能已编译）与 `--jitless` 标志；Node 实测
`--jitless --no-jitless` 可恢复 WebAssembly → 引擎以 jitless 启动 V8。

修法：
- 新增随包 `pandoc-host.cjs` 工具进程入口（支持 utilityProcess parentPort / child_process IPC 两种传输）；
- 主进程优先 `utilityProcess.fork(..., {execArgv:["--no-jitless"]})`，失败退回 `child_process.fork` +
  `ELECTRON_RUN_AS_NODE=1`；主进程自身有 WASM 时直接主进程执行；工具进程崩溃只影响导出；
- 新增「OHSidian 诊断: Pandoc 宿主诊断」命令（renderer/main/utility 的 wasm 类型、js-flags、transport、错误）；
  自检失败弹窗也显示工具进程状态；
- 若工具进程仍 `wasm=undefined`，即平台禁 JIT，需转向纯 JS 转换方案（另立项）。

**验证**：--repatch/verify-asar（新增「pandoc 宿主诊断」「main pandoc utility host」标记）/
verify-pandoc-wasm（新增 host.cjs lock/内容检查）/verify-release 全绿；assembleHap BUILD SUCCESSFUL；
HAP 内 resources/resfile/pandoc 含 `pandoc-host.cjs`，asar 复核 rev208。
**真机待验**：① 自检通过且显示「工具进程 wasm=object」；② 若失败，运行「Pandoc 宿主诊断」把报告发回
  （可据此判断是 utilityProcess 不可用、--no-jitless 未生效还是平台禁 JIT）。

### 二十、rev 209：pandoc 工具进程的临时目录修复（自检 docx EACCES）

rev208 真机自检：`pandoc 3.10 · 已就绪`，`version`/`markdown -> html` 通过，`markdown -> docx` 报
`EACCES: permission denied, open '/ohsidian-pandoc-selftest.docx'`——utility 进程的 `process.cwd()` 是 `/`，
自检写临时文件没有权限。

修法：
- 主进程在每次请求里带上 `tmpDir = app.getPath("temp")`；主进程直跑路径同样传入；
- `pandoc-host.cjs` 创建服务时使用该 tmpDir，并回退 `TMPDIR/TEMP`；
- `service-core.mjs` 自检文件改为 `<tmpDir>/ohsidian-pandoc-selftest-<pid>.docx`，目录不存在时先 mkdir；
- 自检/命令报告的执行位置改为「主进程 / 工具进程（渲染进程 WebAssembly 不可用）」。

**验证**：build-pandoc-wasm 重建并更新 lock；--repatch/verify-asar（rev209 标记）/verify-pandoc-wasm/
verify-release 全绿；assembleHap BUILD SUCCESSFUL；HAP 内 pandoc-host.cjs 含 tmpDir 逻辑。
**真机待验**：自检三项全部 OK（docx 应有字节数）；随后用 Enhancing Export 导出 docx/pptx/epub。

### 二十一、rev 210：设置「诊断」收敛为三张卡片（纯事实报告、统一格式），命令面板诊断命令移除

此前设置「诊断」组 10 行、报告里大量分析/建议句，且 Pandoc 路径输入在整理时被弄丢。现在：

- **三张卡片、同一版式**：通用诊断 / Pandoc / 插件诊断；每张 = 标题 + 右侧实时状态（补丁号、内置 pandoc 状态、
  插件数量与设置页数量）+ 一个主按钮「运行」（清理类动作为文字链接），无说明段落；
- **Pandoc 卡片恢复路径输入**：环境检查用的 Pandoc 路径输入框回到卡片内（保存在 ui-prefs，仅用于检查，不参与导出）；
- **报告统一为纯事实**：头部固定「补丁: / 内核:」，正文为 ⟍小节 + 「键: 值」行；新增 `ohsidianCompactLines()`
  过滤分析/建议句（"请…/建议…/→…/结论…"与以 。结尾的句子），三份报告格式一致；
- **日志档位切换移到「常规」组**（运行日志捕获 → 档位: 仅错误 / 全量 / 关闭），诊断卡片只读；
- **命令面板诊断命令全部移除**（`ohsidian-diag-*`、`ohsidian-console-capture`），设置页是唯一入口。

**验证**：--repatch/verify-asar（新增「三卡片/纯事实/路径输入/日志移到常规/无诊断命令」标记）/
verify-plugin-install/verify-release 全绿；assembleHap BUILD SUCCESSFUL；HAP 内 asar 复核 rev210。
**真机待验**：设置→诊断只有三张卡片、样式一致；Pandoc 卡片能输入路径；三份报告只有「键: 值」行；
命令面板无诊断命令。

### 二十二、rev 211：设置诊断改为原生行 + Pandoc 信息分区 + 独立日志分区（一次只跑一个诊断）

按反馈重排设置页底部：

- **原生行**：不再用自定义卡片，全部使用与页面其它设置相同的 setting-item 行（标题 + 说明 + 右侧控件）；
- **Pandoc 分区**（新增，位于诊断上方）：版本 / 状态 / 位置 / 宿主 四行只读信息，便于他人了解内置引擎；
  「外部路径」输入默认值改为**内置引擎位置**（不再默认 harmonybrew 路径），仅用于环境检查；「自检」单独一行一个按钮；
- **诊断分区**：通用诊断 / Pandoc 诊断 / 插件诊断 / 清空插件错误记录——每个功能单独一行、单独按钮，不复用；
  `ohsidianDiagRunWithLock()` 保证同一时刻只跑一个诊断：报告关闭（关闭按钮/点遮罩）后才释放，期间其它按钮提示；
- **日志分区**（最底部，独立）：日志档位、清空渲染层日志、日志文件路径、插件错误记录路径；
- 报告格式保持纯事实格式（补丁/内核头 + ▍小节 + 键: 值）。

**验证**：--repatch/verify-asar（新增「原生分区行 / 日志独立分区 / Pandoc 默认内置 / 单诊断锁」标记）/
verify-plugin-install/verify-release 全绿；assembleHap BUILD SUCCESSFUL；HAP 内 asar 复核 rev211。
**真机待验**：页面底部依次为 Pandoc / 诊断 / 日志 三个分区，样式与其它设置一致；诊断每次只能运行一个；
Pandoc 外部路径默认显示内置位置；自检按钮单独一行。

### 二十三、rev 212：高级信息默认隐藏、路径改复制按钮、日志分区加开关与选项卡

按反馈继续收敛：

- **普通用户默认看不到**：常规组新增「显示高级信息」开关（默认关，保存在 ui-prefs），关闭时 Pandoc/诊断/日志三个
  分区整体隐藏；只有排障时才展开；
- **路径只提供复制按钮**：Pandoc「位置」、日志「日志文件 / 错误记录」不再内联显示（会被截断），改为每行一个「复制」
  按钮，复制成功/失败有短反馈；
- **日志分区可开关 + 选项卡**：「日志捕获」开关（开=按默认仅错误记录，关=不写日志）、「详细日志」开关（全量级别）；
  「日志详情」选项卡在「运行日志 / 插件错误」间切换并预览内容，另有「复制日志」「清空当前日志」各自独立行；
- **诊断不再混日志**：通用诊断报告去掉日志尾部/日志行（日志由独立分区提供）。

**验证**：--repatch/verify-asar（新增「高级信息默认隐藏 / 路径复制按钮 / 日志开关+选项卡 / 诊断无日志」标记）/
verify-plugin-install/verify-release 全绿；assembleHap BUILD SUCCESSFUL；HAP 内 asar 复核 rev212。
**真机待验**：改动后三个分区默认不可见；「显示高级信息」打开后出现；Pandoc/日志路径行只有复制按钮；
日志开关与两个选项卡可用。

### 二十四、rev 213：新增更改审计的 5 项缺陷修复（NF-019~NF-023）

输入：外部审计《OHSidian-新增更改审计报告 e528275→c40f584》（2026-11-22，2 个 P2 + 3 个 P3）。
四条前案建议（NF-015~018）经该审计独立复现判定"已落地"，本轮只修新发现缺陷，不改已通过项；
版本号建议（NF-024）留到发布决策。

**F-1 → NF-019（P2）：pandoc hook 不再杀死非 pandoc 的同步 child_process**
rev205 的 `Module._load` hook 对**所有**命令伪造了 `execSync`/`spawnSync`：非 pandoc 的 `execSync`
抛 "unavailable in this sandbox"、`spawnSync` 返回 `{status:127}`。这与 2574d04"还给插件完整 Node"
的方向直接冲突（HB-2/3/8/11 的探针全靠真实 errno）。现在非 pandoc 调用一律透传原始 API，
只有 pandoc 的同步调用保留"只支持异步"的明确错误。

**F-2 → NF-019（P2）：外部路径探针拿回真实 child_process**
pandoc hook 先于 touch-mode.js 安装，设置页「Pandoc 环境检查」的两个探针
（`ohsidianProbeExecutable` / `ohsidianProbeExecModes`）过去拿到的是伪造 shim，于是对**从未执行过**
的路径输出「能启动，但退出码 127 —— 路径没问题，问题在这个程序内部」（正是 HB-2 消灭过的反向诊断）。
现在 hook 暴露 `window.__ohsidianPandoc.realChildProcess`，探针优先使用它；报告新增
「执行面: 原始 child_process（直测 execve）/ 内置引擎已接管」，拿不到原始模块时判 `probe-taken-over`。

**NF-020：门禁补「补丁交互」维度**
`verify-asar` 新增 vm 内的 hook 行为门禁（7 项）：非 pandoc 的 execSync/spawnSync 透传、非 pandoc 的
exec/spawn 委托、pandoc 同步调用仍是明确错误、原始模块可从两处取到。每个门禁只测自己那半、单点全绿
而交互回归不可见，正是 rev196 P0 的同类盲区。

**NF-021（P3）：pandoc wasm 锁改钉原始 wasm**
gzip 压缩流跨 Node/zlib 版本不可复现（同一输入、同一长度、不同 sha256），旧锁钉 `.gz` 导致 Node 24
环境本地构建必红。现在锁记录 `outputs-wasm-raw`（解压后 sha256 + 字节数），门禁由 gunzip 后比对，
gz 只记大小；顺带修掉 `checkHash('pandoc-wasm'/'wasi-shim')` 与锁键名（`pandocWasm`/`wasiShim`）
不匹配、下载 tgz 实际从未被校验的老问题。

**NF-022（P3）：BRAT 指纹文案去罪化**
未收录哈希不再判"非官方/重打包"，改为"未收录的构建（可能是较新的官方版、镜像站重打包或开发版）"；
只有注册失败信息含 "is not a function" 时才指向 bundle 内部函数缺失。防止 BRAT 发新版后所有正常
用户被批量误判（rev200 同型事故的预防）。

**NF-023（P3）：docs/README 断链 + 门禁口径**
`docs/README.md` 指向从未入库的 `BUG-BACKLOG.md`（452bfe8 引入的存量断链）已移除该行；
`docs/RELEASE.md` 检查清单新增"门禁结论必须抄当次实际输出"，不再凭印象写"全绿"。

**验证**：`build-pandoc-wasm --check`（新锁，解压后 wasm 55.9 MB 校验通过）/`--repatch`（verify-asar
含新交互门禁 7/7）/`verify-plugin-install`/`verify-pandoc-wasm`（新锁 gunzip 校验 + 行为全过）/
`verify-release`/`check-docs`（0 broken）全部通过；`assembleHap` BUILD SUCCESSFUL；HAP 内 asar
复核 rev213 与新标记。
**真机待验**：①「Pandoc 环境检查」报告首行出现「执行面: …」，外部路径给出真实 errno/exit；
② 非 pandoc 的 `execSync`/`spawnSync` 插件（git 类、同步格式化类）行为恢复；③ Enhancing Export
导出 docx/pptx/epub（同时判别 pandoc hook 对插件是否生效，审计 §4.1 的判别项）。

、release 2.1.0：版本号 2.0.1 → 2.1.0（versionCode 2010000）

按审计报告 NF-024 的建议，本窗口（rev193~213）含**内置 Pandoc**与**窗口状态机**两项功能级变更，
外加一处 P0 修复（rev197）与四条插件链修复（NF-015~018），按 2.0.2 发布不足以表达语义，
提升到 **2.1.0**。

- `AppScope/app.json5`：`versionCode` 2000001 → **2010000**，`versionName` 2.0.1 → **2.1.0**
  （编码规则 `主*1e6+次*1e4+修订`）；CI 的 tag 流程会按 tag 覆盖这两个值，仓库值用于本地构建、
  关于页与冒烟包；
- `docs/CHANGELOG.md` 新增 2.1.0 段：内置 Pandoc / 窗口与形态 / 插件链 / 设置与诊断 / 审计修复；
- `docs/RELEASE.md` 版本头、versionCode 示例、关于页、HAP 文件名示例与 tag 命令全部对齐 2.1.0；
  `docs/STYLUS.md` 三处版本引用同步（状态行、版本对照、release HAP 验收值）；
- `scripts/ci/release-notes-template.md` 改为 2.1.0 发布说明（新增内置 Pandoc 能力与限制、
  仍存在的插件失败面、已知问题）。

**验证**：`assembleHap` 重建后 HAP 内 `module.json` 的 `versionName/versionCode` 应为
2.1.0/2010000；verify-asar / verify-plugin-install / verify-pandoc-wasm / verify-release /
check-docs 全绿。obsidian.asar 与 patch rev 不变（仍 rev213），本次只需重打 HAP。
**发布动作（需人工）**：打 tag `v2.1.0`，由 CI 以 tag 重建对外包并生成 SHA256SUMS。


### 二十六、许可合规补齐：内置 Pandoc 的许可证全文、第三方声明与源码提供（2026-11-22）

内置 Pandoc 采用官方 `pandoc-wasm@1.1.0`（Pandoc 3.10）：引擎 GPL-2.0-or-later，
`pandoc-wasm` 封装 MIT，`browser_wasi_shim` MIT OR Apache-2.0。原实现只附了许可证
**声明**与来源 URL，复核发现三处缺口，本轮补齐（产品形态不变：组件仍随 HAP 内置，
不做运行时下载，国内网络环境无需额外拉取）：

1. **GPL-2.0 全文随包**：新增受版本管理的 `scripts/licenses/GPL-2.0.txt`（FSF 官方文本，
   sha256 `edaef632…`），构建时复制为 `resources/resfile/pandoc/LICENSE-GPL-2.0.txt`；
2. **WASI shim 许可文本随包**：`scripts/licenses/browser-wasi-shim-LICENSE-MIT.txt`
   （补版权行 bjorn3/contributors）→ `LICENSE-browser-wasi-shim.txt`；
3. **精确源码声明**：`PANDOC-SOURCE.txt` 重写为完整第三方声明——三个组件的版权/许可、
   Hackage `pandoc-3.10.tar.gz` 与 GitHub tag 3.10、两个 npm tarball 的 sha256（取自 lock）、
   项目胶水代码归属（BSD-3），以及 GPL-2.0 §3 源码提供声明（含书面 offer 渠道与三年有效期）；
4. **项目 `LICENSE`** 新增中英双语「第三方组件」一节：逐组件版权/许可/随包许可证路径/源码
   地址/源码提供声明，并明确「随包内置、用户无需下载」；
5. `README` / `README_EN` 许可段与 `docs/PLATFORM-ADAPTATION.md` §6.11 合规段同步；
6. **门禁**：`build-pandoc-wasm --check` 与 `verify-pandoc-wasm` 新增许可断言（GPL 全文、
   shim MIT 全文、声明含版本与 sha256、项目 LICENSE 已登记），防止后续构建漏带许可证。

**验证**：`build-pandoc-wasm` 重新生成 8 个 pandoc 资源文件、`--check` 输出
"licenses present"、`verify-pandoc-wasm` 通过、`--repatch`/`verify-asar`、`verify-release`、
`check-docs` 全绿；HAP 重建后在 `resources/resfile/pandoc/` 下可直接看到三份许可证与声明。
**未改变**：引擎仍随包内置、离线可用；不新增运行时下载；patch rev 不变（仍 rev213）。


### 二十七、release 2.1.1：许可合规单独发版（versionCode 2010001）

背景：`v2.1.0` tag 已于 `67c9076`（版本号提交）建立并发布；随后补齐的内置 Pandoc 许可材料
（`229c4cd`：GPL-2.0 全文、WASI shim MIT 全文、精确源码声明、LICENSE「第三方组件」一节）
在 tag **之后**，因此 2.1.0 的发布包不含这些文件。经确认 2.1.0 已对外，不移动既有 tag，
改为**把许可合规作为 2.1.1 发布**（功能与 2.1.0 完全一致）。

- `AppScope/app.json5`：`versionName` 2.1.0 → **2.1.1**，`versionCode` 2010000 → **2010001**
  （主*1e6+次*1e4+修订）；
- `docs/CHANGELOG.md` 新增 2.1.1 段（许可合规内容 + 与 2.1.0 的关系说明）；
- `docs/RELEASE.md`（版本头、versionCode 示例、关于页、HAP 文件名、tag 命令）、
  `docs/STYLUS.md`（状态行、版本对照、release HAP 验收值）、
  `scripts/ci/release-notes-template.md`（标题 2.1.1 + 许可合规条目）同步；
- 许可材料本身未变（仍是 `229c4cd` 的内容：`scripts/licenses/` 两份受版本管理的许可证 +
  `PANDOC-SOURCE.txt` 生成逻辑 + 门禁断言）。

**验证**：`assembleHap` 重建后 HAP 内 `module.json` 的 app.versionName/versionCode 应为
2.1.1/2010001，且 `resources/resfile/pandoc/` 仍含三份许可证与 `PANDOC-SOURCE.txt`；
`build-pandoc-wasm --check`（licenses present）、`verify-pandoc-wasm`、`verify-asar`、
`verify-release`、`check-docs` 全绿。obsidian.asar 与 patch rev 不变（仍 rev213）。
**发布动作（需人工）**：`git push origin main` 后打新 tag `v2.1.1`，由 CI 重建对外包
（2.1.0 的 tag 与发布包保持原样）。





### 二十八、内核 1.13.7 → 1.15.1（2026-11-24）

依据内核升级审计报告（2026-11-23）。审计基线是 2.0.0，实际工作面比其 12 条锚点更多：
2.1.x 新增的 NF-015/NF-018/rev203 补丁也绑定了旧压缩名，本轮共迁移 **13 处 app.js + 6 处 main.js**。

- 取件校验：gz 8,562,390 B，sha256 与 obsidian-releases 一致，RSA-SHA256 验签通过；asar
  24,715,194 B / 368 条目；pdf.js 三件与 1.13.7 逐字节相同；`obsidian-artifacts.json` 新增 1.15.1
  条目（保留 1.13.7 以便回滚），pin 改 1.15.1。
- 结构差异：1.15.1 把 tslib 状态机换成原生 async/await，插件下载合并进单一 `async function UEe(o,t)`，
  NF-015 因此从 5 处 `case` 锚点改为 1 个整函数替换；换仓改成 `Bm()` 双写，抽屉保留前缀、设置页下拉
  一并改走 `openVaultChooser`；其余锚点按新压缩名重锚（`fi/$t`、`no/k`、`E/T`、`Ke/vt`、`AEe` 等）。
- 新增 R1：1.15.1 首窗路径读 `r.nativeTheme.shouldUseDarkColors`，引擎主进程无该模块 → 一行守卫
  （缺失=非深色），避免首窗构建 TypeError。
- 门禁：`verify-asar` 6 个漂移标记同步 + 4 条新断言；`verify-plugin-install` 改为 sentinel 切出
  `UEe()` + 内核真实 `TV/IV` + 5 个合成下载用例；`refresh-app-patch` 复刻锚点同步。
- 验证：`--repatch` 无 WARNING，asar 25,419,547 B；`verify-asar`/`verify-plugin-install`/
  `verify-release` 全绿；HAP 136,650,185 B（较 2.1.1 −1.06 MB）。
- 待真机：popup-token、startup-snapshot 首屏时序、关于页更新提示。


### 二十九、Issue #2 缓解：ArkTS 候选段记账（2026-11-24）

依据 Issue #2 审计定谳报告：根因在 `libadapter.so` 桥面缺组字通道与选区回读，手写替换语义退化为
`deleteBackward(n)+insertText(候选)`，n 偏小时逐笔累积。采用报告 §7.1 的最低成本缓解，落在
`web_engine/src/main/ets/adapter/IMFAdapter.ets`：

- `insertText` 记录上一次插入；40 ms 内"删除紧跟插入且同前缀"判为候选修订，先补足欠删再插入；
  只补欠删（≤12 字符、候选段 ≤16 字符），前删/回车/移动光标/detach 清空记账；
- `deleteLeft` 照原样下发（零延迟），仅记录删除量；命中写日志便于真机判定；
  `IME_SEGMENT_CORRECTION_ENABLED=false` 一行回滚；
- 新增 `docs/IME-BRIDGE.md`（根因、边界、真机清单、回滚、引擎侧长期修法）；`verify-release`
  新增 ArkTS 标记断言。

**未宣称已修复**：组字通道仍在引擎桥面，需真机回归后由维护者判定；未采用渲染层 `ime-fix.js`
（2.5 s 时间窗两向误判，且不在补丁管线内）。


### 三十、手写笔反馈减噪：ink rev 62（2026-11-24）

复盘：`inkStatus` 在「切工具 / 切视图 / 成形 / 选中 / 清除确认 / 自动写回 PDF」等常规操作上都发一行字，
而这些结果本来就在屏幕上可见；`penChromeHint()` 还会在笔尖点到 Obsidian 界面时每 20 秒弹一次 Notice。
在**没有手写内容的笔记**里（常处编辑视图、笔触经常落在界面上）尤其吵，直接打断书写思路。

- 新增 `inkQuietStatus()`：常规确认默认静默；设置项「安静反馈」改为「减少提示」（默认开），关闭后恢复逐条提示。
  26 处常规调用改走该函数（笔/橡皮、阅读视图切换、手写层准备、一笔成形、选中/复制/删除、清除确认、
  PDF 自动写回等）；错误与受阻（无 PDF、视图无手写层、墨迹过多、写回失败）仍然提示。
- `penChromeHint()` 不再发 Notice，只留 `inkTrace`（吞掉笔触的行为不变，掌托过滤依赖它）。
- 首次用笔一次性提示：`笔：写画 · 手指：操作界面 · 双击笔杆：工具条`，`inkIntroSeen` 持久化，只出现一次。
- `OHSIDIAN_INK_REV` 61 → 62；`verify-asar` 新增两条断言（常规反馈静默 + 一次性上手提示）；
  `docs/STYLUS.md`（状态行、设置表、反馈说明）与 `docs/CHANGELOG.md` 同步。

**验证**：`--repatch` 后 `verify-asar` / `verify-plugin-install` / `verify-release` 全绿；HAP 重建后
asar 内 `OHSIDIAN_INK_REV = "62"`、`inkQuietStatus` 与一次性提示串均在位；反馈改动只影响提示文案与
提示时机，不改变笔事件处理、墨迹数据与 PDF 写回路径。


### 三十一、新增更改审计（c40f584→53efe8b）落地：IME 两处修复 + 三项门禁补盲（2026-11-24）

审计（《OHSidian-新增更改审计报告-c40f584至53efe8b-2.2.0线》）结论：无 P1/P2，245 项门禁在审计环境
复现全绿；P3 项与本轮落地的处置如下。

**IME 记账两处修复（审计 B-4 / B-1，B-4 实为缺陷）**

- **B-4（真缺陷）**：`IMFAdapter` 经 `Inject.getOrCreate()` 解析，`bind(...).toSelf()` 是 inversify
  默认 **transient** 作用域——每次原生回调都可能拿到新实例。实例字段会在回调/聚焦切换间被重置，
  `showTextInput()` 在新实例上还会因 `IMEonListen=false` **重复注册**监听（文字双投风险）。
  修复：记账状态与"监听已注册"标志移到模块级 `ImeSegmentState`（与绑定作用域无关），
  `onListenIME()` 增加一次性注册守卫。
- **B-1（单位分叉）**：`prev.length` 为 UTF-16 码元、IMF `deleteLeft(length)` 为平台字符单位，BMP
  汉字重合、扩展区字符（生僻字/emoji）分叉。修复：候选段含代理对时**跳过纠正**（`imeHasSurrogate`），
  宁可少一次缓解也不按错误计数删除。
- B-2（`Date.now()` 非单调）与 B-3（无删除的追加式前缀扩展插入会被当作修订）按审计建议只补文档：
  `docs/IME-BRIDGE.md` 新增 B-1~B-4 边界表与真机"生僻字/emoji"用例；B-3 标注"首字被吞"时的日志定位分支。
- `verify-release.cjs` 的 IME 断言 6 → 9 项（模块级状态、监听守卫、代理对跳过）。

**三项门禁补盲（审计 G-1 / G-2 / G-3）**

1. **G-1 原生库 LFS 完整性**（新增 `scripts/verify-native-libs.cjs`）：`electron/libs/arm64-v8a/`
   五只 `.so` 必须非 LFS 指针、ELF 魔数、尺寸与 sha256 与登记值一致（`libadapter.so` = 1,500,704 B /
   `a7f6e4be…30b0`）。构建机漏 `git lfs pull` 时指针文件会被打进 HAP 且现有门禁全都看不见。
2. **G-2 index.html 引用面**（`verify-asar.cjs` 新增 2 条）：asar 内 `index.html` 必须仍有
   `enhance.js` 挂载点与 1.15.x 的启动快照 iframe 骨架，防上游静默改挂载面。
3. **G-3 内容指纹**（新增 `scripts/asar-fingerprint.cjs`）：打印 `app.js` / `main.js` 的 sha256 + 字节数
   （跨 `@electron/asar` 版本稳定）与 asar 整体哈希（辅助）。`RELEASE.md` 门禁清单与 HAP 归档条目
   已引用；CI 增加 "Verify native engine libraries" 与 "Record asar content fingerprints" 两步。

**当前产物指纹（本轮实测，归档口径）**：app.js 4,037,710 B
`419ebb03923f6cdb925b9d6bbeacdbe1ef23421d963c43318761be56297025e3`；main.js 253,633 B
`f2811332ab5155dd86a5efdeb1c47dba16dca5cf4af08522323794f68b2def23`；asar 25,420,696 B
（辅助哈希 `7fce6be6…ba342`；审计环境重建为 25,414,539 B，差异只在 asar 头部，内容指纹一致口径）。

**未落地**：F-3 真机回归（唯一硬闸门，清单见审计 §九 I-1）、F-1 打 tag（审计通过后执行）。


### 三十二、Issue #2 真机复发定位：桥面 DeleteBackward 忽略数量（2026-11-24）

真机（MatePad Air / 7.0.0 / 应用 2.2.0 rev62）复测：手写"我爱北京天安门"写成
`我 我我 我我我 我我爱 我我爱北…`。随附 HiLog 给出决定性证据：

```
50.130 ImsaKit DeleteLeft,length: 2
50.142 OnCursorUpdate,left: 1606   ← 只退 1 个字符（1570=0/1606=1/1642=2）
50.375 ImsaKit DeleteLeft,length: 2
50.388 OnCursorUpdate,left: 1642   ← 又只退 1 个
```

即：IME 发出的 `deleteLeft(length)` 数量正确，但**引擎桥面的 DeleteBackward 忽略数量参数、每次只删
1 个字符**。手写的"替换整个候选"因此每轮残留 `候选长度−1` 个字符，候选越长残留越多。此前 ArkTS 记账
判据（只补"IME 删少了"的欠删）在数量本身正确时不会触发，所以复发——根因比定谳报告的假设更底层。

**修复**（`IMFAdapter.ets`）：

- 新增 `imeDeleteBack(count)`：把"删 N 个"展开为 N 次 `DeleteBackCallback(1)`；n>1 时写
  `IME multi-delete emulated: N characters (engine ignores the count)` 便于真机复核。
- `applyImeDeleteLeft` 与候选段补删统一走该函数；`IME_EMULATE_MULTI_DELETE` 常量用于引擎日后
  修好 count 语义时一行关闭（否则会变成 N×N 次删除）。
- `verify-release` 的 IME 断言 9 → 10 项（多删展开 + 单删循环 + 日志串）。
- `docs/IME-BRIDGE.md` §1.5 / §2 / §7 记录该桥面缺陷，并把"DeleteBackward 按 count 实现"加入
  引擎侧长期修法。

**验证（本轮）**：`verify-release` / `verify-asar` / `verify-plugin-install` / `verify-native-libs` /
`check-docs` 全绿；HAP 重建后 `modules.abc` 含 `imeDeleteBack` 与 `IME multi-delete emulated`；
真机效果待用户复测（预期：逐笔写"我爱北京天安门"不再累积残留，日志可见多删展开行）。
