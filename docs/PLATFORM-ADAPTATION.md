# 平台能力适配清单（HarmonyOS）

> 来源：对 `obsidian.asar`（1.13.7）与自家补丁的差异审计。
> 用途：这些点是"Obsidian 假设了某个桌面平台能力、在鸿蒙上不成立"的地方，按影响排序留档，不急着全改。
> 每条都带 `文件:偏移` 或行号，可直接搜原文。

## 一、平台判定分支

| # | 依赖点 | 原文 | 鸿蒙上的后果 | 适配建议 |
|---|--------|------|--------------|----------|
| A1 | `hasPhysicalKeyboard` 写死 | `app.js@3940254`：`rd.isDesktopApp=!0,rd.isDesktop=!0,rd.hasPhysicalKeyboard=!0` | 触摸设备被当成有物理键盘：焦点/blur 逻辑反了（弹窗顶出输入法、设置项回车不收起、空状态显示 `(Ctrl+N)`） | 启动后按 `cfg.systemMode` 覆写为 false（一行） |
| A2 | `isPhone` 用屏幕尺寸判定 | `app.js@3884277`：`rd.isPhone=!i.matches`，`i="(min-width:600px) and (min-height:600px)"` | 小窗/手机形态连带 `canSplit`/`canStackTabs`/`canDisplayRibbon` 全关，桌面布局退化为单栏 | 按窗口宽度而非屏幕类判定 |
| A3 | 更新链接硬拼平台 | `app.js@1170582`：`"win32"===t?"win":"darwin"===t?"mac":"linux"` | "检查更新"给出 linux/x64 安装包链接，鸿蒙上无法安装（当前更新器已禁，影响小） | 返回 HAP 下载页或官网 |
| A4 | ctime 假设 | `app.js@3710117`：`"win32"!==pne&&"darwin"!==pne` | 文件时间戳分支按 Linux 走，优先级低 | 暂不处理 |

## 二、引擎能力

| # | 依赖点 | 原文 | 后果 | 建议 |
|---|--------|------|------|------|
| B1 | `@electron/remote` 兜底对象只有两个键 | 包装层 `main.js:9-21`：`remote={initialize:()=>{},enable:()=>{}}` | 若该模块缺失，`app.js@2643825` 的 `remote.getCurrentWindow()` 直接 TypeError，**整窗启动中断** | 兜底补 `getCurrentWindow` / `ipcRenderer` / `app.getPath` |
| B2 | 剪贴板按 electron 主版本分支 | `app.js@757916`：`mf<40?electron.clipboard:electron.remote.clipboard` | 我们把版本钉成 28.2.3 → 只走渲染层 `clipboard`，若兼容层只镜像 remote 侧则复制失效 | 实测后统一走 remote |
| B3 | `app.relaunch()` | `asar/main.js@199431`：`app.relaunch(),app.quit()` | 鸿蒙无进程重启语义，"重载"无效或直接退出 | 改由 ArkTS 重启 Ability |
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
| D1 | 长按→`contextmenu` 只在 iOS 安装 | `app.js@3884400`：`rd.isIosApp&&…dispatchEvent(new MouseEvent("contextmenu"…))` | 鸿蒙 `isIosApp` 恒 false → **没有任何右键通路**，重命名/删除/"更多"菜单不可达 | 条件换成 isMobile/OHOS |
| D2 | 中键/修饰键语义 | `app.js@1133443`：`1===e.button?"tab":isModifier(t,"Mod")…` | 中键新标签、Ctrl 点击、Alt 拆屏、Shift 连选全不可用 | 补长按菜单/多选入口 |
| D3 | 缩放只认 wheel | `app.js@1727661`、`@2418740` | 图片/Canvas/图谱无法双指缩放 | 合成 pinch → scale |
| D4 | Ctrl+滚轮字体缩放 | `app.js@3101987` | 触摸不可用（系统档已由 fontScale 补丁覆盖，用户手动缩放失效） | 设置项接 `fontScaleOverride` |

## 优先适配 Top 3

1. **A1 `hasPhysicalKeyboard`**——影响每个输入框的焦点与输入法弹出，面积最大、改动最小（一行覆盖）。
2. **C1 app-region / 窗口拖动**——桌面布局的窗口拖动与最大化目前依赖它，属"不能用"级别。
3. **D1 长按右键缺失**——鸿蒙上所有"更多菜单 → 重命名/删除"入口都会消失，功能面最广。

## 待澄清：`-webkit-app-region` 到底实不实现

- 代码注释写"引擎不支持"（`WebAbility.ets:684` 附近）；
- 但真机日志里，工具栏上 5px 位移就出现 `PAN RACC` + `AppWindowAdapter#startWindowMoving(1)`，**说明按下点的样式确实影响了引擎的拖动判定**；
- 第 175 轮据此把 `.mobile-toolbar` 改成 `no-drag`（待真机验证）。

两种可能：① 引擎实现了 app-region，注释过时；② 引擎有自己的"拖动热区"判定，恰好命中了这条 CSS。**下次装机先验证工具栏是否恢复点击**，那条结果同时决定 C1 的整组策略（若引擎确实实现，桌面标题栏拖动应改回依赖 app-region，而不是系统 caption）。
