# OHSidian 变更记录（2026-10）

承接 `docs/CHANGES-2026-09.md`：格式、真机取证习惯（hilog / 模式文件 / 探针）、
六维审计标准（必要性/正确性/安全性/代码质量/架构/耗电性）与 9 月一致。

## 第 99 轮(2026-10-18):切换仓库后工具栏不跟随 IME + 新仓库窗口跳转

**用户报告**:①切换仓库后,编辑栏不再移动到输入法上方;②打开新仓库时
窗口跳转错误;③关闭旧窗口后新窗口没有恢复。

**根因(真机取证,两个独立故障)**

1. 键盘链路不是"事件没到",而是"值写对了、读错了窗口"。真机 hilog +
   模式文件采样:非主窗口 522 确实收到 `keyboardHeightChange` 并写入
   `windows["522"].keyboard=344`;但渲染层把自身定位成 520(旧窗口,
   keyboard=0),`--keyboard-height` 恒为 0,工具栏不动。定位错的机制:
   触摸模式所有窗口都是同一块整屏矩形 `1244x818@(0,0)`,旧算法尺寸
   匹配后 `screenX/Y` 也全为 0,只能退回 `bySize[0]`(= 最小键 = 最老
   窗口)。
2. 旧窗口条目为什么一直留着:窗口销毁时 `removeWindowGeometryEntry()`
   先调 `mainWindow.getWindowProperties()`,而销毁阶段该调用抛 1300002,
   整段清理被跳过(hilog:`failed to remove window geometry entry:
   {"code":1300002}`,紧随 WMS `terminate persistentId: 520`)。所以
   "关掉旧窗口也不恢复"——死条目一直在,且一直排在最前。
3. 窗口跳转:新仓库 ability 由 starter(仓库选择器)窗口发起,而 starter
   在同步 `vault-open` 返回后立刻 `window.close()`;调用方随即销毁,
   系统随后把新窗口切到后台、焦点还给前一个窗口(第 31 轮只是记录了
   这个回弹,未能定位触发点)。另:`16000067` 降级重试丢掉了
   `windowMode`,全屏启动退化成系统默认浮动小窗后再被纠正,即肉眼看到
   的"窗口跳一下"。

**修复**

| 侧 | 变更 | 目的 |
|----|------|------|
| ArkTS | `onWindowStageCreate` 缓存 `ownerWindowId`,`removeWindowGeometryEntry` 只用缓存值 | 1300002 不再阻断销毁清理 |
| ArkTS | WINDOW_ACTIVE/WINDOW_INACTIVE → `cfg.focusedWindow` | 给渲染层一个真实窗口身份 |
| ArkTS | 清理条目时顺带清掉指向自己的 `focusedWindow` | 不留悬空焦点 |
| asar | `resolveGeometry` 优先 `focusedWindow`,再尺寸,同尺寸取唯一 `keyboard>0`,最后 `bySize[0]` | 同几何下不再退回最老窗口 |
| asar | 位置消歧仅在 `screenX/Y` 非 0 时启用 | 整屏窗口不再误判 |
| ArkTS | 新窗口启动上下文改为"主窗口 → 最老窗口",不再用即将销毁的 starter | 消除启动后焦点回弹 |
| ArkTS | `16000067` 降级链保留 `windowMode` | 全屏不再退化成浮动小窗 |

**验证要点**:①两窗共存时在非主窗口输入 → `--keyboard-height` = IME 高度
(CSS px);②关闭旧窗口 → hilog 出现 `window geometry entry removed: <id>`
且 `windows` 只剩新窗口;③打开新仓库 → hilog `launch from primary window
context`,新窗口保持焦点不回弹;④单窗口输入仍正常(`entries.length===1`
路径未改)。

**真机结论**:①②成立(第 100 轮前已用 hilog 复核销毁清理);①的"新窗口
工具栏"在双窗口下仍不生效,见下一轮。

## 第 100 轮(2026-10-18):第 99 轮未被真机接受 —— 尺寸门不可靠,身份改走焦点

**用户复测**:切换仓库后新窗口的工具栏仍然不生效;把旧窗口杀掉后才生效,
但杀窗口时屏幕闪烁。

**真机取证(渲染层自证)**:第 99 轮把焦点信号只放进"尺寸候选内",而设备
上渲染层自报的视口与条目矩形并不可靠相等。同一块整屏窗口在不同阶段
采样到 `1140x724`(启动初期)、`1245x818`(布局稳定后,差值 1px,能命中)、
`1468x966`(dpr 2.25 的那个窗口),而 ArkTS 用
`getWindowProperties().windowRect` 发布的条目是 `1244x818`(vp)。

所以尺寸门**会漏**,一漏就:

- `resolveGeometry()` 在两个窗口以上时返回 `null` → 所有消费方退回
  顶层镜像字段(`cfg.keyboard`,只有主窗口会写,= 0);
- 键盘高度因而恒为 0,工具栏不动;
- 杀掉旧窗口后 `entries.length===1`,走的是函数**最前面的早退分支**,
  与尺寸无关,于是"一杀就好"。

杀窗口时的闪烁同源:死条目前后解析从"镜像字段"切到"自己的条目",
安全区内边距变化,页面重排一次。

**第 99 轮错在哪**:把 `resolveGeometry` 的尺寸门当成可信前提,只在门**内**
加身份。单窗口之所以正常,只是因为早退分支绕过了那道门。

**修复**

| 侧 | 变更 | 目的 |
|----|------|------|
| asar | 新增 `focusedEntry()`:`cfg.focusedWindow` 指向的条目即"我";触摸模式直接信任,桌面/PC 模式仍要求 `document.hasFocus()` | 用真实身份取代尺寸猜测;PC 多窗口不误取前台几何 |
| asar | 新增 `resolveKeyboardEntry()`:焦点 → 唯一条目 → 唯一 `keyboard>0` → 最大 `keyboard` | 键盘彻底脱离尺寸门 |
| asar | `resolveGeometry()` 在尺寸候选为空时回退焦点条目 | 安全区不再退回可能过期的镜像 |
| asar | `pollTick` 隐藏时由"跳过"改为 1s 节流 | 新窗口可能在 STARTUP_HIDE 后被误报 hidden,曾冻结该窗口全部消费方 |
| asar | `focus`/`blur` 监听 → 立即重算键盘与安全区 | 焦点信号参与决策后,焦点变化必须立即重估 |

**验证要点**:①双窗口下在新窗口输入 → `--keyboard-height` = 344 且工具栏
上移;②单窗口与 PC 模式行为不变。

**真机结论**:成立 —— 用户复测"新旧窗口都能正常提升工具栏"。

## 第 101 轮(2026-10-18):选完仓库,前台还是旧仓库(任务栈顺序)

**用户复测**:第 100 轮后新旧窗口的工具栏都正常;但在仓库管理页选中仓库后,
前台显示的还是旧仓库窗口,必须手动滑动(切任务)才能到新窗口。

**原因**:引擎的 `vault-open`(`main.js`:`ipcMain.on("vault-open",(t,n,s)=>
{…t.returnValue=p(n)})`)永远**新建一个 BrowserWindow**,即一个新的
EntryAbility 实例 = 一个独立的 OHOS mission。`AppWindowAdapter` 里
`startupVisibility = param.show ? STARTUP_SHOW : STARTUP_HIDE`,引擎建窗用
`show:!1` 再 `g.show()`,于是新窗口的 mission 是**后台**的。真机 hilog 顺序:

```
565 created (main=false)   → focused window: 565     // 曾被短暂激活
563 removed (starter 自我关闭) → focused window: none → 559   // 焦点弹回旧仓库
…2.6s 后(用户手动切)      → focused window: 565
```

即:chooser 窗口销毁时,HarmonyOS 把焦点还给**它下面那个 mission**——
旧仓库窗口。新窗口在栈顶之下,所以要手动滑动。

**修复**:本 SDK 没有 `moveAbilityToForeground`(`AbilityContext.d.ts` 内
不存在,已核实),无法从后台把 mission 提到前台,因此改为**触摸模式下单一
仓库窗口**(已获用户确认):新仓库窗口启动时先 `show()/moveTop()/focus()`
自己,再 `close()` 同级的其它仓库窗口(`starter.html`/help/sandbox/devtools
全部排除,桌面/PC 模式不启用)。旧窗口消失后焦点无处可去,只能落到新窗口。
这与用户在真机上的手工做法一致(他们本来就在手动杀旧窗口),而现在由代码
在正确时机完成,不再有中间态闪烁。

| 侧 | 变更 | 目的 |
|----|------|------|
| asar | `reapSiblingVaultWindows()`:触摸模式下新仓库窗口收起同级仓库窗口 | 消除"前台还是旧仓库" |
| asar | 收起前先 `show()/moveTop()/focus()` 自身 | 旧窗口消失时不留空前台 |
| asar | 模式文件读不到时不动作(重试 ≤6 次),桌面模式不改多窗口语义 | 不在未知模式下关窗口;不动仓库选择器与 PC 行为 |

**验证要点**:①触摸模式在仓库管理页选另一个仓库 → 前台直接是新仓库,无需滑动;
②再选回去同样成立;③仓库选择器(starter)不受影响;④PC/桌面模式仍可多窗口共存;
⑤`hilog -x | grep 'window geometry entry removed'` 只应看到旧窗口被清理。

## 第 102 轮(2026-10-18):窗口模式冷启动"闪动放大再恢复记忆"(形态解析晚于形态动作)

**用户报告**:系统处于窗口模式(平板 PC 模式)时冷启动应用,窗口先被放大到
整屏,再"恢复"到上次关闭时的浮窗大小(一次启动里表现为"放大 → 缩小"的
闪动);触摸模式没有该现象。

**根因(对照 `docs/window-state-machine.md` §1/§2,真机日志链路)**

`pcModeEnabled` 字段默认 `false`(语义 = 触摸),真值由
`updateWindowPcmodeSwitchStatus` 写入,而该首读位于 `loadContent` 回调
**末尾**;启动几何块 `if (!this.pcModeEnabled) forceFullscreenWindow()`
与无条件 `setWindowLayoutFullScreen(true)` 都在它**之前**执行。于是窗口
模式冷启动的实际序列是:

1. 系统按上次状态恢复记忆浮窗矩形;
2. 启动几何块把窗口 `resize` 到 display 整屏矩形(hilog
   `forced fullscreen rect:`),肉眼"放大";同时
   `setWindowLayoutFullScreen(true)` 把 web 内容铺到标题条热区(第 9/50 轮
   已知问题);
3. 回调末尾的首读把 `pcModeEnabled` 翻成 `true`:只复位布局全屏,
   **没有任何代码把窗口缩回去**;
4. 引擎主进程按桌面版记忆化(`<userData>/<vaultId>.json`)主动
   `setBounds` 到上次关闭时的矩形(hilog `setBounds requested=...`),
   窗口缩回,肉眼"恢复记忆"。

触摸模式观察不到,是因为步骤 2 的整屏矩形让引擎 `setBounds` 被系统拒绝
(`1300010` / `window should not move`)——"该失败"本来就是触摸形态的
预期(第 5/14c 轮已记录)。这不是时序巧合:字段默认值与真实形态在首读前
不可区分,状态机缺少"解析先于动作"的约束。

**修复(方案 C:形态解析先于一切几何/布局动作)**

| 侧 | 变更 | 目的 |
|----|------|------|
| ArkTS | 新增 `resolvePcModeAtBoot()`:无副作用同步读 `window_pcmode_switch_status`;非 tablet 返回 false;读异常返回 true(保持窗口形态,随后首读若确为 false 走 modeChanged 自愈) | 形态在第一次几何动作前确定,字段默认值不再被当成形态 |
| ArkTS | `onWindowStageCreate` 顶部 seed `this.pcModeEnabled` 并复位 `pcModeObserved = false`;`clearStaleWindowEntries()` 由 loadContent 回调前移至此 | 首读会先写本窗口条目,先清再写才不会被自己删掉;每个窗口舞台的首同步都算首同步(窗口舞台重建时仍完整 apply) |
| ArkTS | `registerKeyObserver` + 首读 `updateWindowPcmodeSwitchStatus` 整块前移到 `loadContent` **之前**;注册改用 `this.context`(与销毁期 unregister 同源),并包 try/catch | 形态应用点唯一且在内容加载前;`getContext()` 依赖已加载 UI;该调用现在在主路径上,异常不得中断窗口创建 |
| ArkTS | 删除启动路径上的独立 `setWindowLayoutFullScreen(true)`;phone 分支改为 `writeTouchModeFile(false)` + `applyLayoutFullscreenForMode()` | 布局全屏收敛为 `applyLayoutFullscreenForMode()` 单入口(触摸 true / 窗口显式 false;2in1 保持历史行为不触碰) |
| ArkTS | `loadContent` 回调里的 `setWindowDecorVisible(!hideTitleBar)` 改为**仅触摸形态**执行;窗口形态的 decor 只由 `pushSafeAreaInsets()` 决定 | 顺序反转后该调用会变成"最后写入者",把窗口形态系统标题条又藏掉(系统条 + Obsidian 自绘条同时消失) |
| ArkTS | `loadContent` 回调里的 `if (!pcModeEnabled) forceFullscreenWindow()` 改为**触摸专属、幂等**兜底(保留) | 不是第二条 resize 链:窗口形态被守卫挡掉、已整屏直接跳过;兜底"窗口 show 前 resize 被 WMS 拒"(1300002 / MoveToAsync timeout) |
| ArkTS | `forceFullscreenWindow()` 增加"窗口形态直接忽略"守卫 | 不变量:触摸专用校正不得作用于窗口形态(当前调用图无触发路径,纯防御) |
| ArkTS | `computeViewportBound()` 在 `drawableRect` 宽/高 ≤ 0 时回退 `windowRect` | 形态在最早一批几何事件就已解析,标题条尚未合成时不能推 0×0 视口 |
| ArkTS | `updateWindowPcmodeSwitchStatus` 的 `getValueSync` 改为内层 try/catch,读失败回退已解析形态 | 读失败不再跳过 apply(否则触摸形态会失去唯一的整屏校正) |

**六维审计**

| 维度 | 结论 |
|---|---|
| 必要性 | 每处改动都能追到真机现象:窗口模式冷启动 hilog 顺序 `forced fullscreen rect` → `update window_pcmode_switch_status,new status:true` → `setBounds requested`(引擎恢复);触摸模式同一序列里 `setBounds` 被 1300010 拒绝。文档 §2 明文要求"窗口/PC 形态不强制尺寸",旧代码违反该表。后半段改动都来自本轮审计发现的顺序侧效(invariant 收敛),不是"顺手重构" |
| 正确性 | 形态解析(seed)→ 形态应用(首读)→ 内容加载 → 引擎 `setBounds`,单链且各一次;`pcModeObserved` 语义未变(首读置位、seed 复位,保证每次窗口舞台的首同步完整 apply);布局全屏与系统标题条各自单点写入;整屏校正幂等(已整屏跳过);窗口形态只钳制、不 resize;`drawableRect` 未合成时不推 0 视口 |
| 安全性 | 不新增权限面与外部输入;`settings.getValueSync` 读的用户属性只用于本进程分支;新增日志只含布尔与异常 JSON,不含路径/令牌;`writeTouchModeFile` 仍走原子写 |
| 代码质量 | 手机/平板/2in1 分支与原逻辑等价(仅搬家);删除重复决策链;注释只写代码表达不了的约束(形态默认值不可信、1300002/1300010、单应用点、decor 最后写入者);无新增 import,`Context` 沿用全局类型;"是否整屏/是否等值"等判断统一 `===` |
| 架构 | 状态机新增**不变量**:"形态解析先于任何几何/布局动作;未解析 ≠ 触摸形态;窗口形态启动只允许钳制;布局全屏标志与系统标题条各自只有一个写入者";规格 §2/§3 同步、文末 Round 102 小节记录;`applyLayoutFullscreenForMode` 成为布局全屏唯一入口,可静态审查 |
| 耗电性 | 未新增定时器/轮询;`resolvePcModeAtBoot` 仅一次同步读(与首读重复读一次,代价为 page-cache 读);观察者注册提前不改变触发频率;`loadContent` 的触摸重申在已整屏时立即 return(无 WMS 交互);整体减少 WMS 交互次数 |

**自查审计**

- R102-1 `resolvePcModeAtBoot` 读失败返回 true(窗口形态)会不会让触摸形态
  不整屏?不会:随后首读读到 false 时 `modeChanged=true`,照常整屏;只有
  两个读**同时**失败才失去校正,而此时"不动窗口"是安全默认。函数注释已写明。
- R102-2 首读前移到 `loadContent` 之前,`this.mainWindow` 是否就绪?是:
  `onWindowStageCreate` 中 `getMainWindowSync()` 在诊断块之前;`pushSafeAreaInsets`
  内部另有判空。
- R102-3 `nativeContext.UpdateWindowPcmodeSwitchStatusCB` 提前调用会不会在
  引擎未起时丢失?与旧代码同为启动期(旧首读也在 `runBrowser` 之前),且该
  方法在**每次** fire 都调用(第 94 轮),不依赖首次。
- R102-4 观察者提前注册是否重复/泄漏?注册仍在 `onWindowStageCreate` 一次;
  销毁期 `unregisterKeyObserver(this.context,...)` 与注册同源。
- R102-5 2in1 启动期仍不做首读(H15),本轮不改变;`resolvePcModeAtBoot`
  对非 tablet 返回 false,与历史默认一致 → 无新增回归(见"未改项")。
- R102-6 删除回调内 `getContext(this)` 是否影响其它调用?文件内已无其他
  `getContext(this)`;`Context` 由全局提供,无 import 变更。
- R102-7 静默失败面是否扩大?两处读失败都有 `warn` 且行为确定(保持窗口
  形态 / 回退已解析形态),不存在"读了但不知道"。
- R102-8 顺序反转后**最后写入者**是否改变?decor 就是受害者:旧顺序里
  `pushSafeAreaInsets` 在回调末尾收尾,现在它先在启动期跑,回调里的
  `setWindowDecorVisible(!hideTitleBar)` 反而成为最后写入者 → 已改为仅触摸
  形态执行,窗口形态 decor 单点归 push(审计 P1)。
- R102-9 `registerKeyObserver` 现在位于窗口创建主路径,异常会中断
  `loadContent`/监听注册 → 已包 try/catch,注册失败仍继续首读(审计 P2)。
- R102-10 触摸形态唯一整屏校正提前到 `loadContent` 之前(窗口可能尚未 show),
  WMS 若拒绝则没有后备 → 保留回调内的幂等重申作为兜底(审计 P3)。
- R102-11 同一 ability 实例窗口舞台重建时 `pcModeObserved` 若不复位,第二次
  首读会被 early-return 吞掉 → seed 处已复位(审计 P4)。
- R102-12 形态提前解析后,窗口形态从第一个几何事件起走 `drawableRect`;
  标题条未合成时 `drawableRect` 可能为 0 → 已加回退 `windowRect`(审计 P10)。
- R102-13 改动后文件括号配对/字符串终止已用脚本核对(0 问题);另做了一次
  **独立只读审计**(另一 context 的审计 agent,对照 9 月六维标准),其 P1/P2/
  P3/P4/P10 已在本轮修复,剩余项记入"未改项";未跑全量构建
  (`hvigorw`/`ohpm` 不在本机 PATH),以逐段静态核对 + 真机验证为准。

**验证要点**(真机,`window_pcmode_switch_status=true`)

1. 窗口模式冷启动 5 次:hilog **不得**出现 `forced fullscreen rect:`;
   应出现 `update window_pcmode_switch_status, new status:true` →
   `pc mode handled: enabled=true` → 引擎 `setBounds requested={...}`
   (一次引擎恢复),肉眼无放大。
2. 窗口模式冷启动后标题条仍可拖动(布局全屏未被打开);最大化/还原、
   拖动改尺寸各一次正常。
3. **`frame=hidden`/`custom` 的窗口模式下冷启动**:系统标题条仍在(不得出现
   既无系统条、又无 Obsidian 自绘 `.titlebar` 的"无标题条窗口");
   `hilog | grep 'Failed to set window decor'` 无新增。
4. 关掉窗口模式后冷启动 / 切回触摸模式:仍出现 `forced fullscreen rect:`
   且窗口整屏,视口贴合、底部导航条不遮内容。
5. 手机 / 2in1 冷启动与改动前一致(手机触摸布局、2in1 桌面窗口)。
6. 设置里开关 PC 模式即时生效:观察者日志
   `pc mode handled: enabled=<新值>, changed=true`,且只出现一次整屏校正
   或一次钳制;重复同值事件打印 `pc mode unchanged (...)` 且无副作用。
7. 双窗口:非主窗口冷启动不做整屏校正(`isMainAppWindow` + 守卫),焦点
   窗口几何不被抢。
8. 若"系统恢复矩形越界"(换分辨率/旋转/上次在更大屏):接受
   "先钳制入屏、再被引擎 `setBounds` 恢复"的两次收敛(见"已知风险"),
   但不得出现整屏残留。

**未改项/已知风险**

- 2in1 启动期不读 `window_pcmode_switch_status`(H15 历史决策),
  `pcModeEnabled` 在首次观察者触发前保持 false;`computeViewportBound`
  因此可能仍用含标题条的 `windowRect`。本轮**未改**,需 2in1 真机验证后
  单独立项。
- `AppWindowAdapter.isTabletPcMode()` 是**第三处**形态解析(引擎建窗时决定
  `StartOptions.windowMode`),其读失败兜底是 `false`(触摸),与
  `resolvePcModeAtBoot` 的 `true`(窗口)相反。窗口模式下若该读瞬时失败,
  新窗会以整屏创建,而窗口形态"只钳制不 resize"不会缩回。属既有风险,
  统一两处默认值需真机验证建窗路径,本轮不动。
- 窗口模式冷启动且系统恢复矩形越界时,首读先 `clampWindowToWorkArea`(80%
  居中)再被引擎 `setBounds` 覆盖 → 可能出现"钳制 + 恢复"两次跳变。这是
  既有行为(钳制在引擎恢复之前),本轮未引入也未消除。
- `clearStaleWindowEntries()` 只清 `windows`,不清第 99 轮的 `focusedWindow`
  (硬杀会话残留的焦点标记若与新窗口 id 撞号,渲染层会信任错误条目)。
  `removeWindowGeometryEntry` 已清该字段,两处口径不一致;本轮不动,避免
  影响焦点链路。
- `resolvePcModeAtBoot` 与首读各读一次 settings(两次同步读);若将来加
  缓存,必须保持"未解析 ≠ false"这一不变量。
- 模式文件 `systemMode` 仍由 `writeTouchModeFile` 单点写;渲染层
  `desktopLayoutWanted` 的 mtime 缓存未改。

## 第 99-101 轮新增改动六维审计(2026-10-18)

审计范围:`scripts/update-obsidian.mjs`(渲染层补丁)、`WebAbility.ets`、
`AppWindowAdapter.ets`、`LaunchHelper.ets` 中本批新增的代码,逐块对照
HEAD 与真机日志复核。

**审计中发现并已修正的问题**

| # | 问题 | 处置 |
|---|------|------|
| A1 | `AppWindowAdapter.ets` 新增 `launchContext()` 时插在 `@LogMethod` 与原 `createWindow` 之间,装饰器被新方法"接管",`createWindow` 丢失日志装饰 | 已把 `@LogMethod` 移回 `createWindow` 正上方 |
| A2 | 临时探针 `probeOnce` 用 `readMode() || {}` 后整文件回写:一旦读失败,`systemMode`/`insets`/字体等全部字段会被只含探针的对象覆盖 | 探针已完成取证任务,整段删除;提交的代码不含调试写入 |
| A3 | `reapSiblingVaultWindows()` 在启动时只读一次模式文件,读不到就直接放弃,修复会静默失效 | 模式判定移入重试循环(≤6 次 × 400ms),未知模式永不动作 |
| A4 | `removeWindowGeometryEntry()` 把 `focusedWindow` 当字符串比较,若历史值写成数字则永远不等 | 改为 `'' + value` 防御性字符串化 |
| A5 | 注释与代码漂移(写过"尺寸门从未命中",实测是"会漏";写过"仅聚焦文档可信任焦点",触摸模式已改为无条件信任) | 注释改为按实测数据表述,只保留代码表达不了的约束 |

**六维结论**

| 维度 | 结论 |
|---|---|
| 必要性 | 每处改动都能追到一份真机证据:1300002 销毁清理失败(hilog)、`--keyboard-height` 恒 0(模式文件)、`focused window: none → 559`(hilog)、启动上下文为即将自我销毁的 starter。调试用探针在取证完成后删除,提交物不含调试代码 |
| 正确性 | 身份链路单一来源(ArkTS 发布 `focusedWindow`),渲染层按"焦点 → 唯一条目 → 唯一非零 keyboard → 最大 keyboard"降级,键盘完全不经过尺寸门;`resolveKeyboardEntry`/`resolveGeometry` 行为用例 5/5 通过(触摸焦点压过 max-kb、焦点为空回退唯一 kb、桌面不信任焦点、触摸几何回退焦点、单条目);单窗口路径(早退分支)与 PC 模式(尺寸门 + hasFocus 守卫 + 不收起窗口)未改 |
| 安全性 | 未引入外部输入;渲染层本就开启 node integration 并使用 `@electron/remote`,关闭同级窗口不新增权限面;模式文件写入仍走原子写(`publishModeFileAtomic` / tmp+rename);未知模式绝不关窗口;新增日志只含窗口 id |
| 代码质量 | 删除调试残留,恢复装饰器;注释只写代码表达不了的约束(1300002、mission 顺序、尺寸门实测值);标识符与既有 `resolveGeometry`/`resolveWant` 风格一致;`update-obsidian.mjs` 补丁模板内无反引号/`${}` 插值(`new Function` 语法检查通过) |
| 架构 | 窗口身份由 ArkTS 单点发布,渲染层只消费;状态机规格 `docs/window-state-machine.md` §B2 同步更新;触摸模式"单窗口"策略收敛为 `reapSiblingVaultWindows()` 一处,并以 `systemMode` 为唯一开关 |
| 耗电性 | 隐藏窗口轮询从"完全跳过"变为每秒 1 次小文件读(33KB、page cache),且仅在窗口存在时发生;可见路径仍是 200ms(未变);focus/blur 为事件驱动,不新增常驻定时器;reaper 最多 6 拍(400ms 间隔)后自行停止 |

**已知残留风险(不修,记录在案)**

1. 触摸模式切换仓库后,若被收起的是主窗口,则本会话不再有主窗口:
   `clearStaleWindowEntries`/`clampWindowToWorkArea`/启动权限申请等
   仅主窗口执行的启动期作业要到下次启动才再跑一次。这些作业都是启动期
   语义,运行期无依赖。
2. `remote.getCurrentWindow()`/`moveTop()` 在该引擎上可能是空实现;
   真正的修复是"收起同级窗口",抬升只用于避免旧窗口消失瞬间没有前台。
3. 模式文件读不到时不收起窗口(失败即安全),代价是极端情况下仍需要
   手动切换一次。
4. 收起旧窗口会丢弃该窗口的视图状态(Obsidian 按仓库保存工作区,重新
   打开会恢复)。

## 第 104 轮(2026-10-19):侧滑返回"完全没反应"

**用户报告**:侧滑返回"完全没反应"(不是退出,也不是连退)。

**核实(以代码为准)**

1. 手势一定被消费:`pages/Index.ets` 与 `pages/WindowNode.ets` 的
   `onBackPress()` 先 500ms 防抖、再 `BackPressBridge.notify`,**永远
   return true** —— 窗口不再被销毁(第 96 轮目标达成),所以"没反应"只可
   能来自渲染层。
2. 渲染层在多数常见状态**没有任何可执行动作**:
   - 浮层清单只有 `.modal-container,.modal-bg,.suggestion-container,
     .menu,.prompt`;移动布局的文件列表/侧栏是抽屉,开合状态是 workspace
     容器上的 `is-left-sidedock-open`(asar:`expand()/onExpand()` 加、
     `collapse()/onCollapse()` 去),不在清单里;
   - 兜底动作 `app:go-back` 的 checkCallback 只要求
     `activeLeaf.view.navigation`,而 `History.go(-1)` 在 `backHistory`
     为空时**循环不执行、直接返回**(asar History 类)——无历史时它是纯粹
     的静默空操作;
   - 标签页切换器(`app.mobileTabSwitcher`)同样没有入口。
   三者叠加 = "打开应用 / 打开一篇笔记 / 抽屉打开时侧滑"都不产生任何可见
   变化。
3. 还有一处可能造成 100% 静默的闸门:旧实现先把 `lastBackSeq=bp.seq`
   推进、再判 `document.hasFocus()`;一次判假就把这次手势永久丢弃(不重
   试)。同一份补丁在第 100 轮已把键盘/几何的身份判定改成"触摸模式直接
   信任 `cfg.focusedWindow`"(`focusedEntry()`),返回没跟上。
4. 本链路自第 96 轮起**没有真机验收记录**(清单①-⑧无结论),唯一依据是
   Vitreus 的 500ms 连退经验。

**修复**(渲染层补丁 v19→v20,`scripts/update-obsidian.mjs`)

| 变更 | 目的 |
|---|---|
| 返回阶梯补两级:浮层 Escape → **标签切换器 `hide()`** → **抽屉 `leftSplit/rightSplit.collapse()`** → `app:go-back` | 对齐移动端 Obsidian 自身的返回语义;抽屉/切换器打开时不再"什么都不发生" |
| 身份判定对齐 `focusedEntry()`:触摸模式不再要求 `document.hasFocus()` | 去掉触摸模式下唯一能"整条链路静默"的闸门 |
| `lastBackSeq` 推进移到身份闸门之后 | 判假不再吞掉这次手势(可重试) |
| `verify-asar.cjs` 增两个 marker(v20 + 阶梯/身份) | 发布物自证 |

**验证**

- `scripts/refresh-app-patch.mjs` 重建 asar(v20),`verify-asar.cjs` 语法
  + 全部 marker 通过;
- 行为回归(把**发布后的** `applyBackPress()` 与 HEAD 版本同时抽出,在假
  DOM 上跑 11 例):触摸无焦点+抽屉开 → 只 collapse;无焦点+切换器开 →
  只 hide;无焦点且无浮层 → 仍执行 `app:go-back`(本轮修复点);桌面无焦
  点 → 不动作且 seq 不推进;桌面有焦点+抽屉类在 → go-back 且**不**收侧
  栏;浮层开 → 只有 keydown/keyup Escape;seq 已消费 → 不动;浮层+抽屉同
  时开 → 浮层优先。对照 HEAD:"无焦点"与"抽屉/切换器打开"三例复现
  go-back 空转、不关抽屉的旧行为。
- `hvigorw assembleHap` 构建成功;HAP(2026-10-19 08:17,
  221,653,586 B)内嵌 asar 已确认含 v20 与阶梯代码。

**真机验收清单**

1. 触摸模式展开左侧栏(文件列表)→ 侧滑:侧栏收起,笔记不后退;
2. 打开标签页切换器 → 侧滑:切换器关闭;
3. 打开设置/命令面板 → 侧滑:浮层关闭,笔记不后退;
4. 文件列表点笔记 A → 点笔记 B → 侧滑:回到 A;
5. 只打开一篇笔记(无历史)→ 侧滑:**无动作**(第 96 轮取舍,未改);
6. `hdc shell hilog -x | grep "back press published"`:每次侧滑一条、seq
   单调;没有则该手势没进 ArkTS 侧(另行处理)。

**六维审计**

| 维度 | 结论 |
|---|---|
| 必要性 | 三条静默路径都有 asar/源码证据(抽屉类名、History 空转、seq 先推进),不是猜测 |
| 正确性 | 阶梯顺序与移动端 Obsidian 一致;抽屉分支仅触摸模式(桌面两侧栏构造即展开,不能收);seq 单调与启动播种语义未改 |
| 安全性 | 不新增权限/网络/外部输入;只调用 Obsidian 自身 API 与既有 mode 文件 |
| 代码质量 | 补丁模板无反引号/`${}`(`vm.Script` 通过);新增分支带"为什么"注释与证据来源;`collapsed!==true` 防御性比较(沿用 A4 教训) |
| 架构 | 渲染层单点消费,ArkTS 侧未改;身份规则与 `focusedEntry()` 统一,不再有两套"我是谁" |
| 耗电性 | 无新增轮询/定时器;每手势最多多一次 classList 检查 |

**未改项/已知风险**

- 根状态(无浮层/无抽屉/无历史)仍无动作:第 96 轮的显式取舍,本轮不翻
  转,避免回到"侧滑退应用"的原始抱怨;若产品要对齐 Android"根状态退出",
  单独立项。**→ 第 105 轮按用户要求已改为退出应用。**
- 菜单/浮层关闭动画(150ms)内再侧滑,合成 Escape 打在正在销毁的节点上,
  该次手势被消耗但不产生二次动作。
- `ohsidianNativeOccluded()`(B 路由,未提交)用的
  `.workspace-drawer-active`/`.workspace-drawer.is-active` 在 1.13.7 不存
  在,原生播放器覆盖层不会被抽屉遮挡检测到;属 B 路由收尾项,本轮不动。

## 第 105 轮(2026-10-19):根状态下侧滑退出应用

**需求**(用户):第 104 轮保留了"根状态无动作"的旧取舍,用户明确要求
"需要退出应用"——没有可返回的东西时,侧滑应当关闭应用。

**实现**(渲染补丁 v20→v21)

| 变更 | 目的 |
|---|---|
| 新增"裁决"通道:手势处理完把 `cfg.backAck={seq,handled}` 写回 mode 文件 | ArkTS 侧无法预知渲染层是否消费了手势;裁决只对本次 seq 有效,旧裁决永不复用 |
| 阶梯末级不再直接返回,改为回报 `handled:false` | 根状态第一次有了明确信号,不再"静默" |
| `.lightbox`(图片/媒体全屏查看器)并入浮层档 | 它和模态一样压在移动端返回栈上;不并进去会被判成"根状态"而误退出 |
| 根判定读叶历史 `leaf.history.backHistory.length`,不看 `view.navigation` 是否存在 | `app:go-back` 的 checkCallback 只要求 navigation 对象;`History.go(-1)` 在空历史时既不循环也不导航 |
| 两个 @Entry 页(`Index` 与 `WindowNode`,后者由 BrowserAbility 承载;触摸模式下存活的仓库窗口可能是它)都在发布后 350ms 取裁决:`UNHANDLED` + 触摸模式 → `terminateSelf()`;`UNKNOWN` 重试一次;`HANDLED`/仍未知 → 保持打开 | 退出只在"确认没人处理"时发生;漏读裁决绝不可能关应用;两个页面都覆盖到 |
| 桌面/PC 模式由 `isTouchMode()`(读 mode 文件的 override/systemMode)拦住 | PC 多窗口下返回不撕掉整个会话 |
| `BackPressBridge` 增加统一 `readMode()`、三态 `shouldExit()`;`notify` 返回本次 seq | 三处读文件的 try/catch 收敛;两个页面共用同一判定,发布者能等到自己的裁决 |

**验证**

- asar v21:语法 + 全部 marker 通过(`verify-asar.cjs` 新增两条 round-105
  marker)。
- 渲染层行为回归 12 例全过:抽屉 / 切换器 / 浮层(含 lightbox)/ 历史 →
  各自消费并回报 `true`;根状态 → 回报 `false`;桌面未聚焦 → 不回报;seq
  已消费 → 不回报;回报写入不丢 mode 文件其他字段。
- `hvigorw assembleHap` 全量重编译通过(这是本轮唯一能验证 ArkTS 改动的
  手段——仓里没有 ArkTS 单测);HAP(11:59:39,221,678,645 B)内嵌 asar 已
  确认含 v21 守卫、`backAck`、`.lightbox`、根判定与阶梯函数。
- 构建阻塞修复(B 路由未提交代码,非本轮功能,已单独注释):`AVPlayer.seek()`
  在该 SDK 声明为 `void`(不能 `.then()`),`ImagePacker.packing()` 的
  `PackingOption.quality` 是必填字段。两处最小修复后工作区才恢复可编译。

**真机验收**

1. 只打开一篇笔记(无浮层/无抽屉/无历史)→ 侧滑:**应用退出**(任务列表
   里该任务同时消失,`removeMissionAfterTerminate:true`);
2. 有历史(笔记 A→B)→ 侧滑:回到 A,不退应用;
3. 抽屉 / 标签页切换器 / 设置浮层 / 图片查看器打开 → 侧滑只关那一层;
4. PC 窗口模式(多窗口)→ 侧滑不退应用;
5. `hdc shell hilog -x | grep -E "back press published|OHSidian back exit"`:
   每次侧滑一条 `published`;根状态应无 `back exit` 失败日志。

**已知取舍**

- 退出有约 350–700ms 的判定延迟(渲染层 mode 轮询 200ms):这是"确认没人
  处理"的代价,也保证不会误杀。
- 仓库选择器(starter 页)不注入这套补丁,那里的侧滑仍是系统默认(未被
  消费 → 系统退出),与"退出应用"的预期一致。
- 退出前不做额外保存:Obsidian 的 vault 写入是即时的,不存在未落盘编辑。

**六维审计**

| 维度 | 结论 |
|---|---|
| 必要性 | 用户明确要求;不实现则第 104 轮"根状态无动作"仍会被当成"没反应" |
| 正确性 | 裁决按 seq 绑定;`UNKNOWN` 不退出(失败即安全);桌面模式双重拦截(渲染层 `hasFocus` + ArkTS `isTouchMode`) |
| 安全性 | 不新增权限/网络/外部输入;新增仅写既有 mode 文件;退出走标准 `terminateSelf()` |
| 代码质量 | 通道协议与竞态写在注释里;两处构建阻塞修复注明 SDK 依据;`readMode()` 收敛重复 try/catch |
| 架构 | 不改变 ArkTS↔渲染层既有方向(ArkTS 发布、渲染层消费并回报),复用同一 mode 文件,无新通道 |
| 耗电性 | 每次手势一个 ≤700ms 的一次性定时器;无新增轮询 |
