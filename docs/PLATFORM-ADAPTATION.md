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

## 优先适配 Top 3（第 178 轮复核后）

1. **C3 分栏分隔条 1–3px → ≥12px**——纯 CSS，改动最小、几乎无回归风险。
2. **C2 只认 `hover` 的交互**——折叠箭头等触摸端常显（`@media (hover:hover)` 共 149 块，只需挑高频的几处）。
3. **D4 Ctrl+滚轮缩放替代**——已有 fontScale 通道，补一个设置项即可。

> **A1 已移出 Top 3**：触摸模式下 Obsidian 自己就把 `hasPhysicalKeyboard` 改成了 false（`EmulateMobile` 分支），真正暴露的只剩"桌面模式 + 没接键盘"，属于可接受行为。
> **C1 暂不定性**：取决于"引擎到底实不实现 app-region"，见文末。

## 可信度评级（"改动能真正修好且不引入回归"的主观概率）

| # | 条目 | 可信度 | 依据 / 扣分点 |
|---|------|--------|----------------|
| C3 | 分隔条加宽 | **85%** | 单条 CSS 覆盖，命中 `--divider-width`；扣分：拖拽命中区还受 `-webkit-app-region`/指针事件影响 |
| C2 | hover 交互常显 | **75%** | CSS 覆盖可做；扣分：149 处 `hover` 媒体查询需逐处挑，漏掉的地方仍不可见 |
| D4 | Ctrl+滚轮缩放替代 | **70%** | 已有 fontScale 通道，加设置项即可；扣分：与系统字体缩放叠加语义要定清 |
| C1 | app-region / 拖动 | **60%** | 工具栏 `no-drag` 已改，等真机确认；若引擎实现的是"自有热区"而非 app-region，整组结论要改 |
| C4 | 跳过 styled-scrollbars | **60%** | 一个 body 类；扣分：滚动条宽度参与布局的补偿逻辑在别处 |
| B4 | 麦克风权限 | **55%** | 需 `abilityAccessCtrl` + 引擎侧转发；扣分：引擎录音链路是否可用未验证 |
| B2 | 剪贴板分支 | **50%** | 取决于兼容层是否提供渲染层 `clipboard`；未实测 |
| D2 | 中键/修饰键语义 | **40%** | 触摸设备没有中键，只能做替代入口，本质是产品设计而非修 bug |
| D3 | 双指缩放 | **35%** | 要合成 wheel/scale 事件链，图片/Canvas/图谱三处各自实现，工作量大且易被上游改写 |
| A2 | `isPhone` 改按窗口宽 | **30%** | 只在触摸模式下执行、且当前是 `is-tablet`；动了会牵 `canSplit/canStackTabs` 一串派生行为，收益极小 |
| A1 | `hasPhysicalKeyboard` | **25%** | 触摸模式下 Obsidian 已自行置 false；只剩"桌面模式无键盘"，且强行置 false 会误伤带键盘的 2in1 |
| A3 | 更新链接 | **不做** | 更新器已禁用，纯展示问题 |
| A4 | ctime 分支 | **不做** | 影响极低 |
| B5 | 回收站语义 | **不做** | 已有 `.trash` 替代并在文档说明 |
| B1 | remote 兜底 | **不成立** | 整包已随 HAP，兜底对象走不到 |
| B3 | `app.relaunch()` | **不成立** | 引擎已用 `restartApp(want)` 实现；只剩 quit 顺序的边角 |
| D1 | 长按右键 | **不适用 / 不要改** | 长按由引擎手势派发 `contextmenu`；改条件会双触发 |

## 待澄清：`-webkit-app-region` 到底实不实现

- 代码注释写"引擎不支持"（`WebAbility.ets:684` 附近）；
- 但真机日志里，工具栏上 5px 位移就出现 `PAN RACC` + `AppWindowAdapter#startWindowMoving(1)`，**说明按下点的样式确实影响了引擎的拖动判定**；
- 第 175 轮据此把 `.mobile-toolbar` 改成 `no-drag`（待真机验证）。

两种可能：① 引擎实现了 app-region，注释过时；② 引擎有自己的"拖动热区"判定，恰好命中了这条 CSS。**下次装机先验证工具栏是否恢复点击**，那条结果同时决定 C1 的整组策略（若引擎确实实现，桌面标题栏拖动应改回依赖 app-region，而不是系统 caption）。
