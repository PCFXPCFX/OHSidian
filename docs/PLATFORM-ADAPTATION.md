# 平台能力适配清单（HarmonyOS）

> 来源：对 `obsidian.asar`（1.13.7）与自家补丁的差异审计。
> 用途：这些点是"Obsidian 假设了某个桌面平台能力、在鸿蒙上不成立"的地方，按影响排序留档，不急着全改。
> **锚点约定（第 178 轮）**：`app.js` 的字节偏移会随 extraction 漂移（实测同一份代码存在 3 组不同 delta，约 114.8k/115.5k/117.5k），一律以**唯一子串**为准；`app.css` 的行号稳定（误差 1 行，0-based），可以照用。

## 一、平台判定分支

| # | 依赖点 | 原文 | 鸿蒙上的后果 | 适配建议 |
|---|--------|------|--------------|----------|
| A1 | `hasPhysicalKeyboard` 启动时被置 true | `rd.isDesktopApp=!0,rd.isDesktop=!0,rd.hasPhysicalKeyboard=!0` | **只在桌面模式成立**：触摸模式的 `EmulateMobile` 分支（唯一子串 `rd.hasPhysicalKeyboard=!1,o.addClass("emulate-mobile")`）已自行改成 false。真正暴露的只剩"桌面模式 + 无物理键盘"（2in1 拆掉键盘） | 不建议改；若要做，用 `inputDevice.getDeviceList()` 取真值，且只在桌面模式判断 |
| A2 | `isPhone` 由**视口** `matchMedia` 判定 | `rd.isTablet=i.matches,rd.isPhone=!i.matches`，`i=window.matchMedia("(min-width:600px) and (min-height:600px)")`；该段**只在触摸模式的 EmulateMobile 分支里执行** | 桌面模式 `isPhone` 恒 false；触摸模式下按视口宽高判 tablet/phone，小窗触摸会被判成 phone 布局 | 目前无实际症状，观察为主 |
| A3 | 更新链接硬拼平台 | `app.js@1170582`：`"win32"===t?"win":"darwin"===t?"mac":"linux"` | "检查更新"给出 linux/x64 安装包链接，鸿蒙上无法安装（当前更新器已禁，影响小） | 返回 HAP 下载页或官网 |
| A4 | ctime 假设 | `app.js@3710117`：`"win32"!==pne&&"darwin"!==pne` | 文件时间戳分支按 Linux 走，优先级低 | 暂不处理 |

## 二、引擎能力

| # | 依赖点 | 原文 | 后果 | 建议 |
|---|--------|------|------|------|
| B1 | ~~`@electron/remote` 兜底对象只有两个键~~ **不成立** | 包装层确有 `remote={initialize,enable}` 两键兜底，但 `@electron/remote` **整包已随 HAP**（`resfile/resources/app/node_modules/@electron`） | 不会走到那个兜底 | 无需处理 |
| B2 | 剪贴板按 electron 主版本分支 | `app.js@757916`：`mf<40?electron.clipboard:electron.remote.clipboard` | 我们把版本钉成 28.2.3 → 只走渲染层 `clipboard`，若兼容层只镜像 remote 侧则复制失效 | 实测后统一走 remote |
| B3 | ~~`app.relaunch()` 无实现~~ **不成立** | 引擎已实现：`ElectronAppAdapter.relaunch()` → `applicationContext.restartApp(want)`，并把 `electronRelaunchArgs` 透传 | 剩下的风险只是上游 `app.relaunch(); app.quit()` 的顺序——quit 可能把刚发起的重启关掉 | 若要修，只调整调用顺序/屏蔽随后的 quit |
| B4 | 麦克风权限只预检 macOS | `app.js@3146503` | 鸿蒙拒权不弹提示，录出空文件 | 接 `abilityAccessCtrl` |
| B5 | 回收站语义 | 包装层 `main.js:150-192` 用 vault `.trash` 重命名替代 `shell.trashItem` | 与"系统回收站"设置不一致 | 已在文档说明，暂不动 |

> 未找到：`trafficLightPosition` / `titleBarOverlay` / `windowControlsOverlay` / `setWindowOpenHandler` 在 `app.js` 中都不存在；`setVibrancy` 只在 darwin 分支。

## 三、CSS 变量与类

| # | 依赖点 | 原文 | 后果 | 建议 |
|---|--------|------|------|------|
| C1 | `-webkit-app-region` 共 32 处 | `app.css:4138/4150` 等；`.mobile-toolbar` 也在其中 | 见下方"矛盾记录" | 已对工具栏做 no-drag（第 175 轮） |
| C2 | 折叠箭头只在 hover 显形 | `app.css:7928-7936`：`opacity:0` + `@media (hover:hover){:hover{opacity:1}}` | 触摸设备恒定 `opacity:0` → 折叠按钮点不到；同类 hover 媒体查询共 149 块 | 触摸端常显 |
| C3 | 分栏分隔条过窄 | `app.css:2198`：`--divider-width:1px; --divider-width-hover:3px` | 手指无法命中 1–3px | 触摸端 ≥12px |
| C4 | 自绘滚动条 | `app.js@3884513` + `app.css:9654`：非 mac 加 `styled-scrollbars` | 滚动条宽度参与布局，与移动 overlay 语义不符 | 触摸模式跳过该类 |

## 四、输入与手势

| # | 依赖点 | 原文 | 后果 | 建议 |
|---|--------|------|------|------|
| D1 | 长按→`contextmenu` | ~~`rd.isIosApp&&…dispatchEvent(new MouseEvent("contextmenu"…))`~~ | **原判断错误（第 178 轮更正）**：用户实测长按能唤出右键菜单 | 见下方"更正" |

> **更正（第 178 轮，两次迭代后）**：
> - **事实**：`app.js` 里**唯一**的"长按→contextmenu"实现确实只有 iOS 那一条（`rd.isIosApp && … dispatchEvent(new MouseEvent("contextmenu"))`）。全文件另有 5 处合成 `contextmenu`，都与长按无关；我们的补丁里 `contextmenu`/`longPress` 命中数为 0。
> - **但真机长按确实能出菜单**：来源是**引擎**——ArkTS 已把 PanGesture/PinchGesture 转发进引擎（`WebWindowNode.ets:187-214`），引擎识别出长按后由 Blink 派发 DOM `contextmenu`，命中桌面那套 `on("contextmenu", ".nav-file-title…", openFileContextMenu)`。
> - **因此不要按本条去改**：把条件换成 `isMobile`/OHOS 会造成**双触发**（引擎一次 + Obsidian 一次），还会引入 `-webkit-touch-callout:none` 与 800/1200ms 的手势竞争（引擎约 500ms 就认）。结论：保持现状，本条移出清单。
| D2 | 中键/修饰键语义 | `app.js@1133443`：`1===e.button?"tab":isModifier(t,"Mod")…` | 中键新标签、Ctrl 点击、Alt 拆屏、Shift 连选全不可用 | 补长按菜单/多选入口 |
| D3 | 缩放只认 wheel | `app.js@1727661`、`@2418740` | 图片/Canvas/图谱无法双指缩放 | 合成 pinch → scale |
| D4 | Ctrl+滚轮字体缩放 | `app.js@3101987` | 触摸不可用（系统档已由 fontScale 补丁覆盖，用户手动缩放失效） | 设置项接 `fontScaleOverride` |

## 优先适配 Top 3（第 179 轮，两轮审计后）

1. **C3 分栏分隔条热区 1–3px → ≥12px**（88%，纯 CSS，几乎无回归）。
2. **A3 更新链接改 `os=ohos`**（85%，一行锚点替换；影响被"更新器已禁"削弱）。
3. **C2 折叠箭头常显**（78%，一条 CSS；前提 `hover:hover` 的读数已加进诊断）。

> A1/A2 已被实测代码否掉大半，D1 直接作废，B1/B3 不成立 —— 详见下表。

## 可信度评级（"改动能真正修好且不引入回归"的主观概率）

| # | 条目 | 可信度 | 依据 / 扣分点 |
|---|------|--------|----------------|
| C3 | 分隔条热区 | **88%** | `body.is-mobile{--divider-width-hover:12px}`；扣分：pdf 侧栏复用同一变量、边缘 6px 误触 |
| A3 | 更新链接 | **85%** | 锚点替换 `n="win32"===t?…` → `"ohos"`；扣分：上游代理白名单、升级内核时锚点失配 |
| C2 | hover 交互常显 | **78%** | `@media (hover:none){…opacity:1}`；扣分：`opacity` 不阻断命中（是"看不见"而非"点不到"），149 块只覆盖 1 处的体验不一致 |
| C4 | 跳过 styled-scrollbars | **72%** | 触摸模式摘类；扣分：去掉后可能换成更宽的原生滚动条，主题 CSS 依赖该类 |
| D4 | 字号缩放入口 | **68%** | 命令/按钮 → `vault.setConfig("baseFontSize")`；扣分：需新 UI，与 fontScale 叠加 |
| B2 | 剪贴板分支 | **62%** | 先加诊断（已加 `clipboard=…`），暂不改版本钉 |
| D3 | 双指缩放 | **60%** | 先测 pinch 是否已转成 `wheel+ctrlKey`；必要时合成事件 |
| B3 | 重启 | **55%** | 引擎已实现 `relaunch`，只剩 `quit()` 时序；改 `main-process.js` 的 ipcMain 包装器特判 |
| B4 | 麦克风权限 | **50%** | 需 `abilityAccessCtrl` + 引擎 RequestPermissionCode 链路 |
| A1 | `hasPhysicalKeyboard` | **45%** | 触摸模式已被 Obsidian 置 false；改则伤外接键盘 → **建议不改** |
| A2 | `isPhone` | **40%** | 是视口 `matchMedia` 且只在触摸模式执行，77 处消费 → **建议不改** |
| D2 | 中键/修饰键 | **35%** | 触摸无中键，属"新做交互"而非修 bug |
| A4 | ctime | **25%** | 只影响 Sync 的 ctime 采纳，改了有数据风险 → **不改** |
| D1 | 长按右键 | **15%（=不要改）** | 引擎已派发 `contextmenu`；再开 iOS 分支＝双菜单 + 800/1200ms 手势竞争 |
| B1 | remote 兜底 | **不成立** | `@electron/remote` 整包随 HAP，且 `app.js` 有 `if(!i.remote)i.remote=n("@electron/remote")` 自愈 |
| B5 | 回收站 | **不动** | 包装层 `.trash` + 渲染层 `OHSidianTrash` 已两层接管；改删除路径的数据风险最高 |

## 第 179 轮新增的三条（比原 D1 更值得排期）

### 1. C1 的方向性答案：引擎很可能**不**实现 app-region

- `WebAbility.ets:724-727` 的注释自述 "engine has no `-webkit-app-region` implementation (**verified in libelectron.so: no DraggableRegions interface**)"；
- 子代理独立复核二进制：`DraggableRegion / draggable_regions / SetDraggableRegions` **0 命中**，`-webkit-app-region` 只有 3 处、全是 Blink 的 CSS 属性名字符串表；
- 但字符串 0 命中 ≠ 必然没实现（符号可能被剥离），所以仍要靠实验落锤：**注入 `body,body *{-webkit-app-region:no-drag!important}` 后若仍能拖窗 ⇒ 引擎有自有热区；若立刻不能拖 ⇒ 引擎真在读 app-region。**

**派生风险（重要）**：若引擎确实不读 app-region，那么第 178 轮把 `隐藏 / Obsidian 风格` 的系统标题条收起后，**这两种档位下窗口没有任何可拖动面**。装机第一件事就是拖一下窗口；拖不动就说明这条命中，需要改用 ArkTS 侧的 `window.startMoving()` 或恢复系统标题条。

### 2. 触摸端双击/双指缩放在 ImageView 被**主动跳过**（确定缺陷）

`app.js@1845253` 末尾：`a.addEventListener("dblclick", e=>{ … jv(e) || … || o.applyDoubleTapZoom(…) })`，而 `jv()` 对触摸合成的鼠标事件返回 `true`（`app.js@885633`）——所以触摸下双击缩放永远进不去。这条不依赖"引擎是否转 wheel"，可直接修。

### 3. 三条"前提未证"已经变成可读数字

诊断命令新增（第 179 轮）：

```
媒体查询: hover=hover|none  pointer=fine|coarse  clipboard=object|undefined
最近右键: trusted=true|false  firesTouch=…  button=0  Ns 前
```

- `hover` 决定 C2 立不成立（文档里两条旧记录互相矛盾，从未实测）；
- `clipboard` 决定 B2 要不要动；
- `最近右键` 的 `trusted=true` + `firesTouch=true` 就坐实"引擎派发的 contextmenu"，D1 彻底结案。

## 明确查不到的部分

- 引擎派发 `contextmenu` 的代码行（符号已剥离，`HandleGestureLongPress` 等 0 命中）；
- `reload` 后 `quit()` 的实际结果；
- pinch 是否被转成 `wheel+ctrlKey`（建议在图片视图加一个 `wheel` capture 探针，一次两指张合即可判定）。
