# OHSidian 窗口状态机

> 本文档是 TODO 6（窗口状态机重构）的规范。所有窗口几何相关代码
> （WebAbility.ets、AppWindowAdapter.ets）必须与本表一致；后续改动先改表再改代码。

## 1. 三种形态

| 形态 | 判定 | 窗口矩形 | 系统栏/标题条 | 渲染层职责 |
|------|------|----------|---------------|------------|
| 平板触摸模式 | `tablet && !pcModeEnabled` | **正好全屏** `(0,0,display.w,display.h)`，启动/切回时校正一次（forceFullscreen 被拒的残留浮窗矩形除外，见 §9 C2） | 状态栏+导航条由系统管理（可见）；无标题条 | 按 `cfg.insets` 避让上下系统栏 |
| 平板窗口模式 | `tablet && pcModeEnabled` 的自由窗口 | 正常浮窗大小；不得超出屏幕（超出→钳制）；用户可记忆化 | WMS 系统标题条（名称+三钮）必然存在 | 无避让（浮窗不压系统栏）；`windowDecor=system` → 隐藏 Obsidian 自绘 .titlebar |
| 平板窗口模式（最大化） | 同上 + 整屏判定 | windowRect=整屏（边到边），导航指示条浮于窗口上 | 无标题条（全屏化） | 视口=**全矩形**（沉浸；第 87 轮反转第 56/63 轮的显式扣条——被裁掉的底部既非内容也非系统栏，是死区）；insets 照实发布，渲染层 desktop-safe-pad CSS 避让，与触摸形态同构（见 §9 B1） |
| PC / 2in1 | `deviceType === '2in1'`（及 phone 走触摸分支） | 普通窗口，大小由用户决定 | 同上（自由窗口有标题条） | 同上 |

## 2. 事件 → 期望动作

| 事件 | 动作 |
|------|------|
| 启动（onWindowStageCreate） | ① 触摸形态：窗口校正为整屏（已整屏则跳过——重复 resize 会被 WMS 拒 1300002）。② 窗口/PC 形态：**不**强制尺寸（系统按上次状态恢复；记忆化由 Obsidian 主进程 `<userData>/<vaultId>.json` 完成，见 §4）。③ `setWindowTitleMoveEnabled(true)` 无条件启用（拖动面=系统标题条，见 §5）。 |
| `window_pcmode_switch_status` 变化 | 重写触摸模式文件 → 重发布 insets/decor → 触摸形态校正整屏 / 窗口形态钳制入屏。**不**再 500/1500ms 双延时补推（见 §3）。 |
| `windowSizeChange` / `windowRectChange` / `avoidAreaChange` / `WINDOW_SHOWN` | 统一走 `pushSafeAreaInsets()`（insets+decor 发布）+ `computeViewportBound()` 视口重推。引擎推送**无条件**（第 88 轮修订：值比对去重会吞掉同值事件——含 WINDOW_SHOWN 重申与 reason 标记的 rect 事件——引擎窗口状态机断裂，真机复现为"无法动态调整窗口/无法全屏贴合"）。无延时补丁。 |
| `windowStatusChange`（MAXIMIZE/FULL_SCREEN/FLOATING） | 补推 insets + 视口（第 56 轮，修"最大化后底部被导航条遮住"）。动画落定竞态：事件可能先于动画完成到达——随后**单发一次对账**（约 300ms 后重读矩形，无条件重推；第 87 轮 A2，第 88 轮去掉值比对，见 §3 说明）。 |
| `keyboardHeightChange` | 直接换算 css px → 发布本窗口条目 `cfg.windows[<id>].keyboard`（主窗口另镜像顶层 `cfg.keyboard`；不轮询，TODO 8；第 87 轮起按窗口拆分，见 §9 B2）。 |
| 首次启动 viewport 未落定 | **唯一允许的补偿**：`SurfaceReady` 稳定门（同矩形连续 3 次 50ms 轮询）在引擎侧解决，与窗口几何无关。 |

## 3. 已删除的补丁（本轮重构）

| 补丁 | 位置 | 删除理由 |
|------|------|----------|
| 启动 600/1500/3000ms 三连补推 | WebAbility.loadContent 回调 | SurfaceReady 稳定门已根治 0×0 启动；定时器补推只是掩盖。 |
| 模式切换 500/1500ms 双连补推 | updateWindowPcmodeSwitchStatus | 同上；且补推会抢在 WMS 落定前把旧矩形推给引擎，反而制造不匹配。 |
| 触摸模式切换后强制 maximize | settleViewportLater(forceFullscreen) | 改为 `forceFullscreenWindow()`（显式 resize 到 display 矩形）在切换处理里**同步调用一次**；maximize(ENTER_IMMERSIVE) 在 API 24 平板语义不稳（第 11 轮实测 2385x1711 vs 2800x1753）。 |
| `setWindowLayoutFullScreen(true)` 无条件调用 | onWindowStageCreate | 第 9 轮实锤：API 24 平板 WMS 直接拒（`device not support`），调用无效但无害仅限触摸形态；**窗口模式下该调用会把 web 内容铺到标题条热区之下，正是"标题条拖不动"的根因**。改为：仅触摸/手机形态尝试调用（失败静默），窗口模式不调用、进入窗口模式时显式 `setWindowLayoutFullScreen(false)` 复位。 |

第 87 轮补充（A2 对账推与本表的关系），第 88 轮修订：唯一允许的延时
动作是 windowStatusChange 之后的**单发对账推**（`scheduleViewportReconcile`，
约 300ms 后重读矩形，**无条件重推**）。它与本表删除的"定时补推"的
区别：补推梯子在计时器上反复无条件推送，与 WMS 落定长期赛跑；对账推
单发、跟随最后一次状态转换重排（不堆叠），只做一次落定后的收敛。
**第 88 轮教训**：第 87 轮曾给对账推和事件推送都加"值比对去重"——
错在把引擎推送通道当成纯几何流，实际上引擎消费每个事件（WINDOW_SHOWN
的同值重申是隐藏期后的再同步锚点；windowRectChange 的 reason 参数是
最大化/恢复状态机的输入，同值事件被吞后 reason 丢失）。引擎推送通道
永不去做重；去重只属于文件写入通道（见 §7/§9 的 unchanged 检测）。

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

- ArkTS：`keyboardHeightChange` → css px → 本窗口条目
  `cfg.windows[<OHOS 窗口 id>].keyboard` 发布（主窗口另镜像顶层
  `cfg.keyboard`；第 87 轮 B2 拆分后不再互相覆盖）。每次变化必写
  （写侧 unchanged 检测只跳过相同值，不合并不同值）。
- 渲染层：**纯事件驱动**——统一的 200ms"文件内容变化"检查（无变化零工
  作）在内容真正变化时才重跑 applyKeyboard（更新 `--keyboard-height` 并
  派发 keyboardWillShow/Hide 各一次）；不再有 400ms/5s 自适应键盘轮询。
  键盘值按 §9 的窗口条目解析（匹配不到时回退顶层镜像）。
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


## 9. 第 87 轮窗口几何修正（窗口审计落地）

### B2：mode 文件窗口几何按窗口拆分

`ohsidian-mode.json` 过去是"全局单槽"：每个 EntryAbility 实例（每个
Obsidian 窗口）都写同一份顶层 `insets/windowDecor/keyboard`，多窗口下
一个 200ms 渲染轮询内就互相覆盖（窗口 A 最大化写入 insets>0，浮窗 B
写回 0，反之亦然）。

- **写侧**：窗口几何（insets/decor/keyboard + 窗口矩形 l/t/w/h，CSS px）
  写入 `cfg.windows[<OHOS 窗口 id>]`；各窗口只写自己的键（read-modify-
  write 保留他人键），窗口销毁时移除自己的键。顶层全局字段
  （systemMode/override/字体/documentsDir 等）不变。
- **主窗口兼容镜像**：主窗口（DEFAULT_WINDOW_ID）把自身几何同时镜像到
  旧顶层字段——主进程补丁（默认仓库/回收站清理）只读全局字段，单窗口
  会话（最常见情形）由顶层字段完整服务。`cfg.viewportAvoidsBars` 恒写
  false（B1 反转后保留字段，只为把旧版本写入的 true 收敛掉，防止存量
  文件永久抑制 CSS 避让）。
- **读侧（渲染层）**：渲染层拿不到 OHOS 窗口 id（引擎未暴露任何渲染层
  可见的窗口标识通道，已核实 @electron/remote、ipc、mode 文件均无），
  按窗口矩形**尺寸**匹配自身（outerWidth/outerHeight，±2px）：几何载荷
  （insets/decor）是整屏判定的纯函数，同尺寸窗口载荷必然相同，尺寸匹
  配无歧义。同尺寸窗口的 keyboard 值（跟随焦点窗口）用 screenX/Y 消歧。
  回退顺序：唯一条目 → 顶层镜像字段（前 B2 形态）。
- **生命周期（第 88 轮补）**：硬杀的窗口不跑 destroy 清理，残留条目会
  让尺寸匹配拿到死 insets——主窗口启动时 `clearStaleWindowEntries()`
  清空全部 `cfg.windows`（本次会话的窗口随后立即重写自己的条目）。
- **写入节流（第 88 轮补）**：矩形进了条目后，拖拽缩放的每帧
  windowSizeChange 都会触发写文件（UI 线程 I/O，真机上表现为窗口调整
  卡顿加重）——几何-only 变化（载荷 insets/decor/keyboard 不变）限频
  500ms 一次；载荷变化立即写。

### B1：最大化窗口反转回"沉浸 + CSS 避让"

第 56/63 轮的"视口显式扣条"（computeViewportBound 整屏分支扣
底/左右 + `cfg.viewportAvoidsBars=true` 抑制渲染层 pad）产生死区：
底部条高区域既非 web 内容（Surface 被裁）也非系统栏（指示条只是浮线），
是暴露窗口背景的一条带——"最大化后底部无法融入界面"。第 87 轮反转：

- `computeViewportBound` 不再扣除任何避让区（PC/自由窗口 = drawableRect，
  触摸 = windowRect）；
- `cfg.viewportAvoidsBars` 恒 false（见 B2）；
- 渲染层 desktop-safe-pad 成为**所有**桌面布局窗口的唯一避让路径
  （触摸切桌面 + PC 最大化同构）。

需真机验证：最大化时指示条手势热区与 pad 后 Obsidian 状态栏落位。

### C2：栏重叠按矩形判定

insets 发布条件从"触摸模式无条件为真"改为纯几何判定（窗口矩形 ≥ 整屏）：
forceFullscreen 被拒残留的浮窗矩形不再拿到真实栏 insets（原"未定义
象限"）。`computeViewportBound` 触摸分支维持返回 windowRect——它天然
跟随实际矩形，无需改走 drawableRect。

### C3：删除 cfg.caption

`cfg.caption` 自发布起渲染层从未消费（仅注释提及）；captionCss 只在
windowTitleButtonRectChange 更新，全屏后不复位，是无消费者的死数据。
删除：captionCss 字段、标题条回调里的跟踪、writeInsetsToFile 的发布。
引擎通道 `OnCaptionButtonRectChange`（CaptionButtonRect 转发）不受影响。

### C1：desktop-safe-pad 覆盖 body 流 + 全屏浮层根（第 88 轮定型）

第 87 轮把 pad 从 `.app-container` 扩展到 `.modal-container`/
`.prompt-container`——真机复现顶部导航条仍不躲避。从 app.css 反查
（第 88 轮）得到三个事实，推翻了该实现：

1. `.titlebar`（~30px，含窗口按钮）在 **body 流内**、位于
   `.app-container` 之上——只 pad `.app-container` 时顶部那条 ( Obsidian
   自绘导航条 ) 仍画在系统状态栏底下；
2. `.modal-container` 是 `position:absolute`、`.suggestion-bg` 是
   `position:fixed`——完全脱离 body 流，祖先 padding 对它们无效；
3. `.prompt-container` **不存在**（第 87 轮那条规则是死的，prompt 活在
   `.modal-container` 里）。

第 88 轮定型：

- **body inline padding**（`!important` + `box-sizing:border-box`，
  dataset 标记 `data-ohsidian-pad` 只清理自己设的）把整个流（titlebar +
  app-container）推到栏内侧；
- `.modal-container` / `.suggestion-bg` 自身 padding（style 块）拉回
  flex 居中内容；
- pad 条件放宽为 `top>0 || bottom>0`（bottom-only 形态：无状态栏仅有
  手势指示条——旧 `ins.top>0` 漏掉它）。
- 光标锚定的 `.menu`/tooltip 仍无法用容器 padding 避让，待真机确认。

### 第 88 轮回归修复（第 87 轮真机复现的三症状）

| 症状 | 根因 | 修复 |
|------|------|------|
| 无法动态调整窗口；任何模式无法全屏贴合 | 第 87 轮的引擎推送"值比对去重"：`windowStatusChange` 先经 `OnWindowSizeChange` 推了中间矩形并记入 latch，落定后的 `windowRectChange(reason=MAXIMIZE)` 算出同值 bound 被吞——引擎从此收不到带 reason 的矩形事件，最大化/恢复状态机断裂；`WINDOW_SHOWN` 的同值重申（v7 时代就有的再同步锚点）同样被吞 | 引擎推送通道全部回退为无条件推送（v7 语义）；保留单发对账（300ms 后重读、无条件重推） |
| 拖拽缩放卡顿加重 | 窗口矩形进 `cfg.windows` 条目后，拖拽每帧 windowSizeChange 都绕过 unchanged 检测重写文件 | 几何-only 写入限频 500ms；载荷变化（insets/decor/keyboard）立即写 |
| 顶部导航条不躲避（触摸切桌面布局） | pad 只作用 `.app-container`，而 `.titlebar` 在 body 流内位于其上方；`.modal-container`/`.suggestion-bg` 是 absolute/fixed，祖先 padding 无效；`.prompt-container` 不存在 | body inline padding（border-box + dataset 自清理标记）+ `.modal-container`/`.suggestion-bg` 自身 padding；pad 条件 `top>0 \|\| bottom>0` |
| （防御）升级/强杀残留 `cfg.windows` 条目配出死 insets | destroy 清理只覆盖优雅退出 | 主窗口启动 `clearStaleWindowEntries()` 清空全部条目后由本会话窗口重写 |

### Round 89：桌面布局全屏形窗口改为隐藏系统栏（CSS pad 降为兜底）

第 88 轮的 body padding 在真机上仍输掉"同一条屏幕区域的归属权之争"：
状态栏/三键导航条持续盖住 Obsidian 顶栏与底部栏，无论 CSS 如何避让。
栏与内容无法共享那条带子，第 89 轮起（经用户授权）改为**栏让位**：

- **隐藏条件**：`fullscreenLike 窗口 && 桌面布局意图`。桌面布局意图 =
  渲染层 resolveWant 的 ArkTS 镜像（override 优先，auto 跟随
  systemMode）。覆盖症状场景：触摸模式切桌面布局（override=desktop）
  与 PC 模式最大化（systemMode=desktop）。
- **API**：窗口级 `setWindowSystemBarEnable([])` 隐藏（状态栏+导航条），
  `['status','navigation']` 恢复。边缘滑动仍可临时唤出（系统行为）。
- **触发**：几何事件路径（pushSafeAreaInsets 开头重估）+ **1s 监视器**
  （barWatchTimer：override 由渲染层写入、无几何事件伴随，纯事件驱动
  会漏掉"切布局"瞬间）。监视器 tick 只读 mode 文件；
  applySystemBarVisibility 在 want===barsHidden 时早退。
- **insets 联动**：barsHidden=true 时 pushSafeAreaInsets 发布
  **0 / 底部指示条高**（第 90 轮修订：`setWindowSystemBarEnable([])`
  隐藏状态栏，但平板 WMS 仍保留手势小白条浮于底缘——真机实测；
  底部 inset 避让小白条，渲染层 bottom-only pad 抬升内容、背景延伸到
  小白条下；三键导航机型上三键同样可能不被该 API 隐藏，TYPE_SYSTEM
  底部读数一并取 max 覆盖），渲染层 pad 随 insets 收敛（200ms 内）。
- **降级**：WMS 拒绝隐藏时 barsHidden 保持 false，真实 insets 照常
  发布，第 88 轮 CSS pad（body + .modal-container/.suggestion-bg）继续
  兜底——退化为第 88 轮行为，不会更糟。
- **移动布局不受影响**：触摸+移动布局消费 inset vars 正常（round 87
  之前即工作），栏保持可见。
- **清理**：窗口销毁时停监视器并恢复系统栏显示。

### Round 91：最大化后收起残留 decor（日志驱动）

真机日志（窗口模式最大化）确认两件事：其一，第 90 轮的 bottom-only
inset 场景成立（最大化矩形=整屏、小白条 avoid area 高 63 物理 px），
该日志属第 89 轮部署；其二，**最大化后 WMS 不主动收起浮窗期开启的
caption**——hasDecor:1、drawableRect.top=71 残留，视口被裁出一条
caption 高的顶部死带。修复：fullscreenLike 窗口显式
`setWindowDecorVisible(false)`（decorVisibleLast 状态跟踪，跳变才
调用；启动路径同步登记），恢复浮窗时按原逻辑重新开启。

### Round 92：最大化判定改用 available area（修正第 91 轮）

真机日志（第二份，窗口最大化全程）确认本机几何：物理屏 2800×1840，
available area 2800×1753（top=87），**自由窗口最大化 = available
area**。整屏判定（rect≥display）在该场景恒 false，导致 insets/pad/
隐藏栏全部失活——小白条遮挡的主因。

- `coversDisplayArea(rect)`：整屏 **或** available area 即真；用于
  overlapsBars 与 applySystemBarVisibility。
- decor 判定**维持整屏基准**：available-area 最大化的窗口显示
  caption（恢复按钮所在，合法 UI），drawableRect.top 扣除是正确
  避让；第 91 轮的收起分支撤销（当时把 hasDecor:1 误判为残留）。
- 隐藏栏仅当用户选桌面布局（override=desktop）时激活；移动布局 /
  触摸布局走 insets 避让。

### Round 93：窗口边框默认改为 native（hidden frameless 冲突）

默认 hidden（无框）下，本机最大化自由窗口的 WMS 按钮（最小化/最大化/
关闭）浮在内容上、与 Obsidian 自绘右上角控件重叠，caption 条本身
不显示。native/custom 均正常（用户实测）。渲染层补丁 v10：app 就绪
时若 `vault.getConfig("frame") == null`（用户从未选择过）则写
`setConfig("frame","native")`（重启生效，Notice 提示一次）；用户
显式选择永远优先。
