# OHSidian 窗口状态机

> 本文档是 TODO 6（窗口状态机重构）的规范。所有窗口几何相关代码
> （WebAbility.ets、AppWindowAdapter.ets）必须与本表一致；后续改动先改表再改代码。

## 1. 三种形态

| 形态 | 判定 | 窗口矩形 | 系统栏/标题条 | 渲染层职责 |
|------|------|----------|---------------|------------|
| 平板触摸模式 | `tablet && !pcModeEnabled` | **正好全屏** `(0,0,display.w,display.h)`，启动/切回时校正一次 | 状态栏+导航条由系统管理（可见）；无标题条 | 按 `cfg.insets` 避让上下系统栏 |
| 平板窗口模式 | `tablet && pcModeEnabled` 的自由窗口 | 正常浮窗大小；不得超出屏幕（超出→钳制）；用户可记忆化 | WMS 系统标题条（名称+三钮）必然存在 | 无避让（浮窗不压系统栏）；`windowDecor=system` → 隐藏 Obsidian 自绘 .titlebar |
| 平板窗口模式（最大化） | 同上 + 整屏判定 | windowRect=整屏（边到边），导航指示条浮于窗口上 | 无标题条（全屏化） | 视口=drawableRect **显式扣除**导航条/系统栏避让区（drawableRect 不扣这些条；第 56 轮） |
| PC / 2in1 | `deviceType === '2in1'`（及 phone 走触摸分支） | 普通窗口，大小由用户决定 | 同上（自由窗口有标题条） | 同上 |

## 2. 事件 → 期望动作

| 事件 | 动作 |
|------|------|
| 启动（onWindowStageCreate） | ① 触摸形态：窗口校正为整屏（已整屏则跳过——重复 resize 会被 WMS 拒 1300002）。② 窗口/PC 形态：**不**强制尺寸（系统按上次状态恢复；记忆化由 Obsidian 主进程 `<userData>/<vaultId>.json` 完成，见 §4）。③ `setWindowTitleMoveEnabled(true)` 无条件启用（拖动面=系统标题条，见 §5）。 |
| `window_pcmode_switch_status` 变化 | 重写触摸模式文件 → 重发布 insets/decor → 触摸形态校正整屏 / 窗口形态钳制入屏。**不**再 500/1500ms 双延时补推（见 §3）。 |
| `windowSizeChange` / `windowRectChange` / `avoidAreaChange` / `WINDOW_SHOWN` | 统一走 `pushSafeAreaInsets()`（insets+decor 发布）+ `computeViewportBound()` 视口重推。无延时补丁。 |
| `windowStatusChange`（MAXIMIZE/FULL_SCREEN/FLOATING） | 最大化动画可能不尾随 windowSizeChange：补推 insets + 视口（第 56 轮，修"最大化后底部被导航条遮住"）。 |
| `keyboardHeightChange` | 直接换算 css px → 发布 `cfg.keyboard`（不轮询，TODO 8）。 |
| 首次启动 viewport 未落定 | **唯一允许的补偿**：`SurfaceReady` 稳定门（同矩形连续 3 次 50ms 轮询）在引擎侧解决，与窗口几何无关。 |

## 3. 已删除的补丁（本轮重构）

| 补丁 | 位置 | 删除理由 |
|------|------|----------|
| 启动 600/1500/3000ms 三连补推 | WebAbility.loadContent 回调 | SurfaceReady 稳定门已根治 0×0 启动；定时器补推只是掩盖。 |
| 模式切换 500/1500ms 双连补推 | updateWindowPcmodeSwitchStatus | 同上；且补推会抢在 WMS 落定前把旧矩形推给引擎，反而制造不匹配。 |
| 触摸模式切换后强制 maximize | settleViewportLater(forceFullscreen) | 改为 `forceFullscreenWindow()`（显式 resize 到 display 矩形）在切换处理里**同步调用一次**；maximize(ENTER_IMMERSIVE) 在 API 24 平板语义不稳（第 11 轮实测 2385x1711 vs 2800x1753）。 |
| `setWindowLayoutFullScreen(true)` 无条件调用 | onWindowStageCreate | 第 9 轮实锤：API 24 平板 WMS 直接拒（`device not support`），调用无效但无害仅限触摸形态；**窗口模式下该调用会把 web 内容铺到标题条热区之下，正是"标题条拖不动"的根因**。改为：仅触摸/手机形态尝试调用（失败静默），窗口模式不调用、进入窗口模式时显式 `setWindowLayoutFullScreen(false)` 复位。 |

## 4. 窗口大小/位置记忆化（TODO 1/2）

- Obsidian 桌面主进程**本来就做**记忆化：每窗口关闭时把 bounds 写
  `<userData>/<vaultId>.json`（main.js `me()`/`pe()`/`ee()`），启动时
  `pe(u)` 恢复 x/y/width/height（`Dt()` 校验落点在显示器内），`u.isMaximized`
  为真才 `maximize()`。经 BrowserWindow 构造参数 → 引擎 `AppWindow.CreateWindow`
  → `StartOptions.windowLeft/Top/Width/Height` 生效。
- 因此 **ArkTS 侧不再需要任何"启动最大化"补偿**：系统按上次状态恢复的
  悬浮窗（第 11 轮现象）在触摸形态才是问题，在窗口形态正是记忆化本身。
- TODO 2（启动不最大化）：删除 WebAbility 对 `setFullScreen/maximize` 的
  启动期调用后自然满足。AppWindowAdapter 的 `setFullScreen/setSimpleFullScreen`
  保留——那是 Electron 显式全屏 API（F11 等用户主动行为）。

## 5. 标题条拖动（TODO 3）

- **根因（第 56 轮定案）**：`setWindowTitleMoveEnabled(!hideTitleBar)` 在
  主窗口 hideTitleBar=true（无框 BrowserWindow）时**关闭了 WMS 标题拖动
  能力**；第 40 轮 decor='system' 把标题条重新显示但没重新启用拖动，
  于是"看得见拖不动"。引擎没有 -webkit-app-region 支持（libelectron.so
  无 DraggableRegions 接口），系统标题条是唯一拖动面。
- **修复**：`setWindowTitleMoveEnabled(true)` 无条件启用（三处：启动、
  decor='system' 分支、setUseNativeFrame）；"可移动"与"可见标题条"
  绑定同步。ArkTS PanGesture 只转发鼠标滚轮/捏合（Finger 源被
  MultiInputAdapter 丢弃），与标题条无竞争，无需 parallelGesture。
- `setWindowTitleMoveEnabled(!hideTitleBar)`（WebAbility:605、
  AppWindowAdapter.setUseNativeFrame:591）语义保留：隐藏自绘标题条时允许
  系统标题拖动。

## 6. 模式切换 bug（TODO 5）排查结论

- 主窗口从不在切换时被 `destroyWindow`（仅 login/sub/popup 子窗口走
  destroy，已审计）；"窗口无响应"的实际来源是 **WMS MoveToAsync 布局
  超时**——在 WMS 落定过程中 resize/move 自由窗口（forceFullscreenWindow
  注释中已记录）。删除双连补推后此类竞态窗口大幅缩小。
- `windowSizeChange` 等监听器只注册在主窗口且主窗口生命周期 = Ability
  生命周期，无"旧监听绑 null"路径。
- 切换后仓库不匹配：触摸模式文件 `ohsidian-mode.json` 在切换处理
  **第一时间**写入（writeTouchModeFile），渲染层轮询 400ms 内跟随；本轮把
  窗口几何动作收敛到单次同步调用后，"首次进入平板页面窗口不匹配"的
  补推竞态源被移除。

## 7. 键盘高度（TODO 8）

- ArkTS：`keyboardHeightChange` → css px → `cfg.keyboard` 发布。每次变化
  必写（writeInsetsToFile 的 unchanged 检测只跳过相同值，不合并不同值）。
- 渲染层：**纯事件驱动**——统一的 200ms"文件内容变化"检查（无变化零工
  作）在内容真正变化时才重跑 applyKeyboard（更新 `--keyboard-height` 并
  派发 keyboardWillShow/Hide 各一次）；不再有 400ms/5s 自适应键盘轮询。
- 覆盖缺口（安全键盘等无事件的场景）：ArkTS 侧 IMFAdapter 已有
  attach/detach 事件钩子，后续如确认存在无事件场景，在 ArkTS 侧补事件源，
  不在渲染层恢复轮询。

## 8. 窗口边框样式联动（TODO 4 核对结论，无需改码）

Obsidian 设置 → 高级 → 窗口边框样式（`D.frame`，三档：hidden / custom
"Obsidian 风格" / native），**重启后生效**（设置页自带"重新启动"按钮）。

| 档位 | main.js `Ae/Ue` | 引擎窗口装饰 | Obsidian 渲染层 |
|------|------------------|----------------|------------------|
| hidden（默认） | `frame:false, titleBarStyle:'hidden'` | ArkTS 启动即 `setWindowDecorVisible(!hideTitleBar)`，`hideTitleBar` 默认 true → 无系统标题条 | `is-hidden-frameless`：自绘 `.titlebar`（zI）成为标题栏 |
| custom（Obsidian 风格） | 同上 frameless | 同上 | 同上（自绘按钮显式可见） |
| native | `frame:true, titleBarStyle:'default'` | 引擎/系统绘制原生装饰 | 不建 frameDom；平板自由窗口上我们额外 `setWindowDecorVisible(true)`（pushSafeAreaInsets 的 decor='system' 分支），二者一致 |

方向核对结论：**"隐藏 → 系统边框、Obsidian 风格 → 自绘边框"的期望与
现有实现一致**（hidden/native 都映射到正确的装饰状态）；平板窗口模式下
pushSafeAreaInsets 强制显示系统标题条的行为优先级更高（第 40 轮决策，
触摸/移动布局没有自绘标题条），不受该设置影响。与拖动（§5）不冲突：
`setWindowTitleMoveEnabled(!hideTitleBar)` 仅在系统标题条存在时有意义。

