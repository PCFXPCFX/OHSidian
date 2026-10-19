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

## 第 106 轮(2026-10-19):换库窗口启动失败 / 多窗口 pcmode 观察者 / 启动期重复副作用

**输入**:真机 hilog 分析(14:48:02–14:48:50,平板触摸形态冷启动 + 换库)。
第 102 轮的闪动修复在该链路上**验证通过**:`resolvePcModeAtBoot` 的首读
(`02.286`)早于 `LoadContent`(`02.306`);`pc mode handled: enabled=false,
changed=false` 说明是首同步而非模式切换;全程无 `forced fullscreen rect:`
(窗口创建时已是 `[0 0 2800 1840]`,整屏校正的尺寸守卫直接跳过);布局全屏只有
一次调用(`02.302` 发起、`02.314` 生效)。但同一条日志暴露了 5 个新问题:

1. **P0 换库新窗口创建失败**:`09.070 closeWindow(1)` → `09.074 createWindow`
   → `09.079 launch from primary window context`(选中的正是正在销毁的
   browser1)→ `16000067` → geometry-only 也失败 → bare `16200001`;`09.081`
   旧窗口销毁,新窗口从未创建。`12.079 XComponentManager::CreateWindow
   browser4 timeout`,随后 20 秒 `getProxy failed, proxyId: browser4/browser0`
   与 `Failed to obtain the main window`。`24.827` 才出现一个新实例(819,
   新 xcomponentId browser5,与引擎等待的 browser4 错位),日志末尾两个
   obsidian 窗口互相抢焦点。
2. **P1 pcmode observer 是进程级单例**:`07.442 register ... res:false` +
   `npai_settings_register_observer, already registered`——回调只挂在首个窗口
   (811)的 ability 上;`09.087` 811 销毁并注销后,存活的 813 在 15 秒里**完全
   收不到** PC 模式切换,直到 `24.872` 新实例再注册。
3. **P1 每个窗口重复进程级副作用 + 监听器泄漏**:813(`07.43x`)、819
   (`24.86x`)各自重跑 `publishSystemFonts`(277–280 条映射)、
   `publishStyleFonts`(最多 40 次字体描述符解析)、`publishThemeFontPath`、
   `publishDocumentsDir`;`registerSystemConfigListener` 每个窗口注册一次且
   **从不 off**,闭包指向已销毁的 ability。
4. **P2 启动期同值视口突发**:`02.389–02.392` 3ms 内 5 次
   `re-pushed viewport bounds`(完全相同),`02.512 ProcessJank`。
5. **P2 触摸全屏上的无效窗口 API**:`setBounds` 四次全被 `1300010` 拒绝;
   `setWindowLimits` 在 `07.531–07.541` 连发四组(0..MAX → 1800×1463 →
   固定 1800×1463 → 1800×1519),WMS 每次回 `fullscreen or compatible mode
   could not update new size`,窗口始终 2800×1840——引擎的尺寸认知与实际
   窗口分裂。诊断日志 `setBounds requested={}` 也源于 `JSON.stringify` 对
   napi `WindowBound` 打印空对象。

**修复**

| 侧 | 变更 | 目的 |
|----|------|------|
| ArkTS `LaunchHelper` | `LaunchWithOptions` 增加可选 `onAllFailed`;三级重试梯子(完整 → 仅几何 → bare)全部失败、上下文缺失、调用抛异常时各回调一次(回调内异常被吞)。**审计补丁**:每级 rung 单独 try/catch(同步抛也回调),且首个错误不是 16000067 时不再进入梯子、直接回调(16200001 等错误原本会静默跳过验收锚点) | 让"窗口永远不会出现"从引擎侧 20 秒 `proxy not found` 的间接现象变成一条明确的创建失败日志 |
| ArkTS `AppWindowAdapter` | 新增 `closingWindows: Set<string>`;`closeWindow()` 在 `terminateSelf()` **之前**标记 `browserN`;**审计补丁**:`launchContext` 先按当前 proxy 列表修剪已消失的标记,`closeWindow` 无 context / `terminateSelf` 失败时回滚标记 | `terminateSelf` 是异步的,proxy 要到 `onWindowStageDestroy` 才移除;不标记就会把"正在终止"的窗口当成可用启动上下文 |
| ArkTS `AppWindowAdapter.launchContext` | 跳过 closing 窗口;优先存活 primary(`DEFAULT_WINDOW_ID`),否则最老存活窗口;全部在关闭时 warn + 回退 activeContext | 换库时旧 primary 已在关闭,原实现仍首选它 → 三次启动必败(16000067/16200001 是终止中上下文的表现) |
| ArkTS `AppWindowAdapter.createWindow` | 传入 `onAllFailed`:`createWindow: every launch attempt failed for window N` | 失败窗口有单一可 grep 的验收锚点 |
| ArkTS `WebAbility` | 静态 `liveInstances` + `addLiveInstance/removeLiveInstance`;`onWindowStageCreate` 顶部(所有形态)入表,`onWindowStageDestroy` 顶部出表,`onDestroy` 再兜底出表一次 | 进程级回调需要"当前存活窗口"集合;放在形态分支之外,手机也能收到字体/字号回推;异常的销毁路径不会把死实例留在广播表里 |
| ArkTS `WebAbility` | `ensurePcmodeObserver()` 进程级单注册 + `broadcastPcmodeChange()` 广播到所有存活实例;最后一个窗口销毁才 `unregisterKeyObserver`;观察者拥有者窗口先死时用存活窗口重绑。**审计补丁**:注册优先用 `getApplicationContext()`(进程级、不随窗口死亡失效),ability context 仅作回退 | 修正"回调绑死首个窗口"与"首个窗口一销毁就失去运行时切换";app context 也消除了"重绑失败后整个进程没有 observer"的路径 |
| ArkTS `WebAbility` | `bootPublishesDone` 静态 once,收敛 `publishSystemFonts/publishFontId/publishStyleFonts/publishThemeFontPath`;`systemFontsPublished/publishedFontFamilyCount/systemFontsPublishing` 改 `static`。**审计补丁**:`registerSystemConfigListener()` 与 `publishDocumentsDir()` 留在 once 块**外**(各有自己的 once/值比较 guard,首次失败后下一窗口还能重试);`removeLiveInstance` 在字体尚未发布时回滚 `bootPublishesDone`;`onFontIdUpdated` 无存活窗口时同时清 `systemFontsPublished` | 这些写的是**共享** mode 文件、扫的是全局字体描述符;每个窗口重跑是纯浪费,但 once 不能以"注册失败后永不重试"为代价 |
| ArkTS `WebAbility.registerSystemConfigListener` | 静态 once;`onFontIdUpdated/onFontSizeScaleUpdated` 改为 `dispatch*` 到 `primaryLiveInstance()`,不再闭包捕获 `this` | 消除监听器累积与"死窗口回调"泄漏;字体列表变化仍能触发重发布 |
| ArkTS `WebAbility.repushViewportBounds` | 相同 bound 且距上次推送 < `REPUSH_DEDUPE_MS`(150ms)时跳过。**审计补丁**:新增 `force` 参数,`scheduleViewportReconcile` 以 `force=true` 调用;推送 latch 移到 native 调用成功之后;窗口舞台重建时清零 latch | 只合并启动期同值突发;对账推永远送达(round 88 的"同值重申"语义不破),native 抛异常也不会吞掉同突发的下一条 |
| ArkTS `AppWindowAdapter` | 新增 `isFullscreenWindow()`/`isTouchFullscreen()`:`setBounds` 仅在"触摸形态(平板触摸/手机)+ 窗口 `FULL_SCREEN`"时短路;`setBounds` 诊断日志改标量字段。**审计补丁**:**不**短路 `setWindowLimits`/`setResizable`——它们携带状态(尺寸限制/不可缩放),全屏时丢弃会在窗口离开全屏后失效,比多一次 WMS 往返更糟;触摸判定改用严格读(读失败不跳过) | `setBounds` 在触摸全屏下被 WMS 证明必败(1300010);短路后不再连发,并让日志可读(不再 `requested={}`) |

**六维审计**

| 维度 | 结论 |
|---|---|
| 必要性 | 每条都能追到日志时间戳:P0 = `09.070–12.081` 的换库失败链;P1 = `07.442 res:false` 与 `09.087` 注销后 15 秒空窗;P1 = `07.43x/24.86x` 的重复字体发布与监听注册;P2 = `02.389–02.392` 五连推 + `02.512` jank;P2 = `07.531–07.541` 的 limits 抖动与 `setBounds` 全拒。没有"顺手重构" |
| 正确性 | `closingWindows` 在 `terminateSelf` 前**同步**写入,并按 proxy 列表修剪/失败回滚;`launchContext` 只在"无存活窗口"时回退(失败可见);广播遍历快照,单实例异常不影响其他窗口;观察者优先 app context,注销/重绑只在回退注册时可能发生;静态 once 只覆盖**进程级共享**资源(字体/主题/观察者/配置监听),窗口级状态(形态、decor、insets、per-window 条目)仍逐窗口;150ms 去重只吞"同值且同突发",对账推 `force=true` 永不吞;`setBounds` 短路要求 `触摸形态 && FULL_SCREEN`,窗口形态的恢复路径不受影响;limits/resizable 携带状态,不短路 |
| 安全性 | 不新增权限、网络、外部输入;`closingWindows`/`liveInstances` 只存 window id 与实例引用,不落盘;新日志只含 window id/布尔/异常 JSON,不含路径与令牌;`onAllFailed` 回调异常被吞,不影响启动梯子本身的返回 |
| 代码质量 | 进程级 vs 窗口级的边界写进静态字段注释与函数注释;新增日志可直接作为验收锚点;`setBounds`/skip 日志带 window id,多窗口真机可核对;`setBounds` 诊断不再依赖 napi 对象的 `JSON.stringify`;无新增 import(`Set`/`Array.slice/indexOf`、`window.WindowStatusType`、`Context` 均为既有能力) |
| 架构 | 首次把"进程级单例资源"显式建模(静态 once + 存活注册表),修正了"窗口 = 进程"的隐含假设;状态机新增不变量(见 `docs/window-state-machine.md` 文末 Round 106):进程级资源只初始化一次、启动上下文不得来自 closing 窗口、视口推送允许同值突发合并(对账推除外)、触摸全屏下只短路 `setBounds` |
| 耗电性 | 每个新窗口省掉一次 277–280 条字体映射、最多 40 次描述符解析、主题字体全描述符扫描与一次配置监听注册;省掉 4 次必败 `setBounds` 的 WMS 往返;启动期同值视口推送从 5 次降到 1 次。limits/resizable 仍按引擎请求下发(audit P2-1 的取舍)。新增成本仅为进程内 `Set`/数组操作与一次 `unregister/re-register`(仅窗口切换时) |

**自查审计**

- R106-1 `closingWindows` 会不会误伤后续窗口?引擎 window id 在进程内单调分配
  (`browserN` 递增),adapter 是进程单例,进程重启即清空;不存在 id 复用。
- R106-2 `launchContext` 在"所有窗口都在关闭"时回退 activeContext,可能仍是
  终止中上下文?是,而且**没有**更好的选择:审计建议改用 `ctxAdapter.getContext()`
  (应用级上下文),但 SDK 的 `ApplicationContext extends Context` 并**没有**
  `startAbility`(只有 `UIAbilityContext`/`UIExtensionContext`/`AppServiceExtensionContext`
  有),换过去只会在运行期抛错。因此保留 activeContext 回退 + warn,
  失败由 `onAllFailed` 暴露;该场景(所有窗口同时关闭)属极端,见"未改项"。
- R106-20 审计 P2-2:此前 `isTouchFullscreen` 复用 `isTabletPcMode()`(读失败
  → false = 触摸),等于把"settings 读失败"翻译成"跳过 setBounds"这一**破坏性**
  分支。已改为 `isTouchFormFactorStrict()`:只有成功读到 `'false'` 才算触摸,
  读失败/未知按非触摸处理(不跳过),与 WebAbility "读失败保持窗口形态"的
  既有不变量同向。
- R106-21 审计 P3:`dispatchFontScaleUpdate` 去掉了单实例 `fontScale` 字段比较
  (该字段只由 `onConfigurationUpdate` 更新,与 listener 是两条通道,可能落后);
  交给 `writeFontScaleToFile` 的文件级比较。
- R106-22 审计 P3:primary 判定仍用 `ConfigData.DEFAULT_WINDOW_ID`(`browser1`),
  与 `WebBaseAbility` 的"引擎 id 未必是 1"注释不一致 → 本轮不扩接口,改为在
  退化到"最老存活窗口"时打明确日志
  (`primary browser1 unavailable`),避免验收时把正常退化误读成失败;给
  `WebProxy` 增加 `isMain` 标记留待后续。
- R106-3 是否破坏 round 99("不能从即将销毁的 chooser 启动")?没有:仍优先
  primary;只有当 primary **已在关闭**时才退到最老存活窗口——round 99 的前提
  是"存在稳定窗口",该前提在本轮日志的场景里不成立(换库时旧的正在关、
  chooser 是唯一存活者)。代价与收益记录在"未改项"。
- R106-4 广播到已销毁实例?`liveInstances` 与 `onWindowStageCreate/Destroy`
  同步维护,`removeLiveInstance` 在任何早退之前执行;每条广播仍包 try/catch。
- R106-5 `ensurePcmodeObserver` 返回 `true` 现在表示"进程 observer 已就绪",
  不再表示"本次注册成功";日志 `res:true` 的语义随之变化(验收按此读)。
- R106-6 观察者重绑失败怎么办?注册优先用 `getApplicationContext()`(进程级,
  不随窗口死亡失效),ability context 仅作回退;只有回退注册时 owner 先死才需要
  重绑,重绑失败 `warn` 并置 `pcmodeObserverRegistered=false`,后续窗口创建会再
  尝试;期间运行时切换失效,但窗口创建时的读取仍保证首帧形态正确。
- R106-7 静态字体标志被 `onFontIdUpdated` 重置后,若当时无存活窗口,重发布
  会丢?不会:无实例分支同时清 `bootPublishesDone` 与 `systemFontsPublished`,
  下一个窗口启动会重跑发布块并通过 publish-once 守卫;不依赖丢失的那次事件。
- R106-8 150ms 去重会吞掉 round 88 依赖的"同值重申"吗?不会:对账推
  (`scheduleViewportReconcile`)以 `force=true` 调用,永不合并;窗口状态切换后
  的带 reason rect 事件/`WINDOW_SHOWN` 重申走 `OnWindowRectChange`,不经该
  通道;只有同一帧内多个事件源(size/rect/avoidArea/status)的同值推送会被合并。
- R106-9 触摸全屏短路 `setBounds` 会妨碍"引擎把全屏窗口恢复成浮窗"吗?
  不会:短路要求触摸形态(无 PC 模式);窗口形态(`pcMode=true`)不短路,引擎的
  记忆化 `setBounds` 原样下发。
- R106-10 `setWindowLimits`/`setResizable` 全屏短路会不会丢状态?审计 P2-1
  指出会(离开全屏后限制/不可缩放状态失效,且引擎不会补发),因此**已回退**:
  只短路必然失败且无状态的 `setBounds`;limits/resizable 继续按引擎请求下发,
  多一次 WMS 往返是可接受代价。
- R106-11 静态注册表在窗口舞台重建(`onWindowStageDestroy → onWindowStageCreate`
  同实例)时会不会重复入表/重复注册?`addLiveInstance` 用 `indexOf` 去重;
  observer/config listener 都有静态 once;`removeLiveInstance` 对不在表中的
  实例是 no-op;`onDestroy` 的兜底出表与 `onWindowStageDestroy` 重复调用也
  是 no-op(`splice` 索引 -1、观察者标志已清)。
- R106-12 编译验证:`hvigorw assembleHap` **BUILD SUCCESSFUL**
  (最终一轮 2026-10-19 15:47:29,HAP 221,777,488 B);`build.log` 的
  `electron:default@CompileArkTS` 输入清单包含 `web_engine` 源,该任务多轮
  重跑(最后一次 14.6s),无 `ArkTS:ERROR`。未跑真机,验收以真机为准。
- R106-13 本轮做过一次**逐段静态核对**(对照日志时间戳与既有 round
  88/99/102 不变量),并跑过多次全量编译;另起过独立只读审计 agent,其**第一份**
  审计在提交前未返回,提交后补到(见 R106-14..19),P1/P2 发现已通过增量提交并入。
- R106-14 审计 P1:非 16000067 的首个错误(如终止中上下文的 `16200001`)原本
  不会进入重试梯子、也不会回调 → 已改为 `if` 分支显式回调,且梯子每一级
  `startRung` 都包同步 try/catch(同步抛同样回调)。P0 的验收锚点现在覆盖
  "首个错误即失败"与"梯子耗尽"两条路径。
- R106-15 审计 P2-6:`closingWindows` 会永久保留(terminate 被拒/无 context/
  引擎 id 复用)→ 已加 `pruneClosingWindows()`(按当前 proxy 列表修剪)、
  无 context 与 `terminateSelf` 失败时回滚标记。
- R106-16 审计 P2-7:观察者注册改用 `getApplicationContext()` 优先(进程级
  不随窗口死亡失效),ability context 仅回退;重绑路径只在回退注册时可能走到。
- R106-17 审计 P2-2:对账推改为 `force=true` 调用,永不被 150ms 突发合并;
  latch 移到 `OnWindowSizeChange` 成功之后,窗口舞台重建时清零。
- R106-18 审计 P2-3/P2-5:`onFontIdUpdated` 无存活窗口时同时清
  `systemFontsPublished`(否则下一窗口被 publish-once 守卫挡住);
  `registerSystemConfigListener()`/`publishDocumentsDir()` 移出 once 块
  (各自的 once/值比较 guard 保留),首次失败后下一窗口仍会重试;
  `removeLiveInstance` 在字体尚未发布时回滚 `bootPublishesDone`(audit P2-4
  的自愈部分;异步发布仍使用首个窗口的 ability context,见"未改项")。
- R106-19 审计 P2-1:`setWindowLimits`/`setResizable` 的"全屏短路"已回退——
  两者携带状态,离开全屏后丢弃会让限制/不可缩放失效;只保留无状态的
  `setBounds` 短路。`isTouchFullscreen` 同时覆盖 phone;skip 日志带 window id;
  "all windows are closing" 从 error 降为 warn(后面还会回退 activeContext,
  可能成功)。

**验证要点**(真机,重点看换库与多窗口)

1. 换库(A → B):hilog 应出现 `closeWindow: window browser1 marked closing` →
   `launch from oldest live window context: browserN`(primary 未被关闭时才出现
   `launch from primary window context`);**不得**出现
   `createWindow: every launch attempt failed for window`、
   `12.x XComponentManager::CreateWindow ... timeout`、连续
   `getProxy failed, proxyId: browserN`。
2. 换库后只有一个窗口存活且进入前台;任务列表里旧任务消失,新窗口标题为
   新库名(不出现两个 obsidian 窗口互相抢焦点)。
3. 多窗口 + 设置里切 PC 模式:每个存活窗口各打一条
   `update window_pcmode_switch_status, new status:...` 与
   `pc mode handled: ...`(主窗口做整屏/钳制,副窗口只切布局全屏);
   关掉主窗口后再切,存活窗口**仍然**响应。
4. 冷启动日志:每个进程只有一次 `publishSystemFonts: begin`、一次
   `system configuration listener registered`;换库/新窗口不再重复。
5. 系统设置里换字体/字号:`onFontIdUpdated` 后仍能发布新映射(dispatch 路径),
   且不会在已关闭窗口上执行。
6. 启动期视口:同值突发只出现 1 条 `re-pushed viewport bounds`,其余为
   `re-push skipped (identical bound within burst)`;状态切换后 300ms 的
   `re-pushed viewport bounds` **必须**出现(对账推 `force=true`,即使同值
   也不得被 skip)。
7. 触摸形态新窗:`setBounds skipped: window <engineId> is fullscreen on touch
   form factor`;不再连发 `1300010` / `MoveToAsync: window should not move`。
   **注意**:`setWindowLimits`/`setResizable` 仍会下发(audit P2-1 的取舍),
   因此 `could not update new size` / `set dragEnabled end` 仍可能出现,
   不算失败。
8. 窗口形态冷启动不回归:仍出现 `update window_pcmode_switch_status, new
   status:true` → 引擎 `setBounds requested=<left>,<top> <w>x<h>`(标量字段
   可读)→ 窗口恢复到记忆矩形;标题条可拖。
9. 手机 / 2in1 冷启动与改动前一致(手机触摸布局、2in1 桌面窗口;2in1 仍不做
   pcmode 启动读取,H15)。

**未改项/已知风险**

- P3:tablet 上必然 801 的 `setWindowTitleMoveEnabled` / `setWindowTopmost` /
  `setWindowModal` 调用保持原样(本轮不动,避免改变窗口能力探测语义)。
- `onSystemConfigurationUpdated` 注册后**永不注销**(进程级资源,随进程结束);
  目前无 off 路径,避免与窗口销毁竞态。
- `launchContext` 在"所有窗口都在关闭"时仍回退 `getActiveContext()`:SDK 里
  `ApplicationContext` 没有 `startAbility`(只有 `UIAbilityContext` /
  `UIExtensionContext` / `AppServiceExtensionContext` 有),进程级上下文不能
  替代;这种 close-then-create 且无任何存活窗口的组合仍会走三连失败,由
  `onAllFailed` 日志暴露(唯一失败路径,不再静默)。
- primary 识别仍按 `browser1` 字面量:引擎 id 复用时可能识别不到 primary,退化
  为"最老存活窗口"(日志已注明 `primary browser1 unavailable`)。给 `WebProxy`
  增加 `isMain` 需要改接口与全部实现,留待后续。
- `closingWindows` 只覆盖引擎显式 `closeWindow`;用户点标题栏 X 或系统侧销毁
  (无 closeWindow 调用)不会标记 → 极小概率仍会从将死窗口启动,失败时由
  `onAllFailed` 日志暴露。
- 换库时若唯一存活窗口是 starter/chooser(它随后会自己关闭),round 99 记录的
  "新窗口被系统压到后台/焦点回跳"风险仍存在;彻底修法是引擎侧"新窗口
  `windowStageCreate` 后再关闭旧窗口",属于渲染层/引擎顺序改动,本轮不做。
- 静态发布按进程一次:若首个窗口在字体服务就绪前发布失败,重试梯子仍在其
  实例上跑;实例提前销毁且此后无窗口时,下次窗口启动会重跑(见 R106-7),但
  中间事件会丢。
- `isTabletPcMode()`(建窗)与 `resolvePcModeAtBoot()` 的读失败默认值仍相反
  (false vs true),round 102 已记录为已知风险;本轮未统一,需真机验证建窗
  路径后再动。
- 2in1 的 pcmode 观察者仍按 H15 注册,本轮广播后**每个** 2in1 窗口都会跑一次
  `updateWindowPcmodeSwitchStatus`(旧代码只有首个窗口的回调生效)。行为与旧
  代码单窗口时一致,但暴露面变大;2in1 真机需确认 `forceFullscreenWindow`
  不会被 `false` 事件触发(该风险在旧代码已存在)。
- **异步字体/主题发布仍钉在触发它的 ability context 上**(audit P2-4):首个
  窗口在 5s/8s 超时链完成前被销毁时,`this.context` 已死、写 mode 文件失败;
  本轮加了 `removeLiveInstance` 的 `bootPublishesDone` 回滚让下一窗口重试,
  但没有把文件 IO 改成进程级 `ApplicationContext`。彻底修法需要统一换
  `getApplicationContext().filesDir`,留待真机确认影响面。
- `setWindowLimits` 的全屏抖动(0..MAX → 1800×1463 → 1800×1519)本轮**保留**
  (audit P2-1:它携带状态,短路会丢)。日志里仍会看到
  `fullscreen or compatible mode could not update new size`,属于可接受噪音。
- 工作区里另有一个并行会话的未提交改动(引擎渲染层的 `startupVisibility`
  触摸形态显示启动页、native overlay、`electron/` 页面等),**不属于本轮**,
  也未进入本轮提交;真机验收 P0 时需注意该改动会改变 `StartOptions.startupVisibility`。
- `onSystemConfigurationUpdated` 注册后**永不注销**(进程级资源,随进程结束);
  目前无 off 路径,避免与窗口销毁竞态。


## 第 106 轮(2026-10-19): HEVC 内联原生播放器（B 路由）

**用户报告**:HEVC/H.265 内嵌视频在 Obsidian 的 `<video>` 里黑屏/无声；需要不离开笔记、在原视频矩形内播放，并保留主题、滚动和触控分区。

**根因**:引擎有 HEVC 硬解能力，但解码后的呈现环在首帧后断裂（AVC 对照同样复现）；W（WebCodecs）已因 0 帧判 No-Go。应用层不能修闭源引擎，只能绕开呈现环。

**方案**:B = 同一页面的 `Stack` 内叠 `AVPlayer + XComponent(SURFACE)`，按 `<video>` 的完整矩形定位；content region 只做裁剪，不缩放视频。入口常驻、预览图占位、关闭后恢复 HTML。IPC 优先、文件兜底；renderer 把 rect/region/theme 下发给 ArkTS。

**本轮审计修复**:

| 问题 | 修复 |
|---|---|
| 首击被 Pan 起点置为“控件已显示”，随后的单击误判成播放/暂停 | touch-down 只唤出；Pan 起点不碰 UI；`userRevealedControls` + 450ms grace |
| open 只确认写出，未确认 ArkTS 接受，身份不匹配会黑屏 | Index 接受后写 opened ack + IPC `event:opened`；renderer 收到 ack 才隐藏 HTML，1.2s 无 ack 保留 HTML 并 close |
| 8s 无帧 watcher 把暂停的本地音频误报为编码不支持 | 只判断确实尝试播放的媒体；本地视频在 loadedmetadata 预挂入口 |
| 多窗口关闭标记串扰 | close marker 带 windowId/xcomponentId，tracker 身份匹配才停 |
| 同页换视频不重建 | `source` 加 `@Watch`，release 旧 AVPlayer 后按新文件 init |
| 静止切主题不更新 | 几何稳定时 1.2s rect 心跳携带 theme |
| 主题 8 位 alpha/临时文件并发/缩略图泄漏 | ARGB 转换、唯一 tmp + rename 重试、预览 onload 后清理 |
| 重试预算/快速重建 fd 泄漏 | playing 5s 稳定后才清零；token 失配关闭本次 fd |
| 旧 inject 脚本会回退 guard | 删除 `inject-b-native-asar.mjs`，唯一路径是 repack |

**六维审计**

| 维度 | 结论 |
|---|---|
| 必要性 | 引擎无法稳定呈现 HEVC 帧；B 是保留笔记上下文的唯一可行应用层路径 |
| 正确性 | surfaceId 只在 initialized 写；open ack + 空 identity 拒绝；source/close 身份、首击时序、音频误报均已修；resize 保留 currentTime |
| 安全性 | 仅 127.0.0.1 临时端口 + INTERNET 权限；thumb 目标限制 filesDir；不新增外部网络。`@electron/remote` 是既有宽权限面，B 依赖它，仍建议后续收窄 |
| 代码质量 | 关键状态机有注释；IPC/file 双通道；唯一 tmp、写失败 close、ack 超时安全回退；smoke 覆盖协议/几何/ack/恢复 |
| 架构 | 不新开窗口；renderer 只写请求，ArkTS 拥有 AVPlayer/XComponent；文件通道仅 IPC 降级；W 不复活 |
| 耗电性 | IPC 下 rect 每帧、文件兜底 40ms、主题心跳 1.2s；rAF 每帧 DOM 几何仍有优化空间，需真机功耗/发热复核 |

**验证**:ArkTS 编译通过；renderer smoke `B RENDERER SMOKE OK`；HAP `221,792,861 B / E1D4F043...`，内嵌 asar `25,919,752 B / EEF8AD6B...` 与源文件一致。**真机尚未验证**（本机无 hdc），下一步按 `docs/B-NATIVE-OVERLAY.md` 验收 1–25。

**已知风险**:pinned drawer 与视频矩形重叠时未从 region 排除侧栏；共享请求文件仍是最后写者赢；`color-mix()/oklch()` 主题色可能 fallback；rAF 几何查询的耗电需实测。

## 第 107 轮(2026-10-19):触摸模式换库后窗口停留在 PC 模式记忆尺寸

**用户报告**:触摸模式(PC 模式关闭)下切换仓库,切换成功,但新窗口**不是整屏**,而是"上次窗口模式记忆的窗口大小"。

**根因(以代码为准,对照 `docs/window-state-machine.md` §1/§2)**

`forceFullscreenWindow()` 的第一道门是 `if (!this.isMainAppWindow) return;`(第 88 轮为保护"引擎创建的浮窗"而加)。但 `isMainAppWindow` 的真实语义是"**启动 want 里没有 xcomponentId**"——`WebBaseAbility.onCreate` 仅在 xcomponentId 为空时置 true——**不是**"应用当前的主窗口":

1. 换库窗口由引擎 `createWindow()` 发起,want 必带 `xcomponentId`(`AppWindowAdapter.createWindow` 的 `'xcomponentId': param.window_id`)→ 新窗口 `main=false`;旧窗口随后销毁,新窗口**不会**被重新标记为主窗口(日志实证:`window id captured: 813, main=false`)。
2. 触摸形态的三个整屏校正执行点全部被这道门挡掉:启动首同步 `updateWindowPcmodeSwitchStatus` → `forceFullscreenWindow()`、`loadContent` 回调的触摸重申、运行期切回触摸的同一条路径。
3. 引擎随后按桌面版记忆(`<userData>/<vaultId>.json`)`setBounds` 到 PC 模式的记忆矩形;此时新窗口若不是全屏(浮窗),`moveWindowToAsync`/`resizeAsync` 成功 → 窗口停在记忆尺寸。(主窗口看不到该现象:它已被整屏,`setBounds` 被 WMS `1300010` 拒绝。)
4. 浮窗来源(任一即可):① `LaunchHelper` 三级重试的最后一档传空 `StartOptions`,丢了 `windowMode=FULLSCREEN`,本设备支持自由窗口(`windowModeSupportType=63`)时可能以浮窗创建;② 系统在 show/恢复阶段给回浮窗,而代码没有任何触摸兜底。

第 99-101 轮审计的"已知残留风险 1"已经记录"触摸模式换库后本会话不再有主窗口,仅主窗口的启动期作业不会再跑",但当时判定这些作业"运行期无依赖"——整屏校正正是运行期依赖,该判断本轮修正。

**修复**

| 侧 | 变更 | 目的 |
|----|------|------|
| ArkTS `WebAbility.forceFullscreenWindow` | 删除 `isMainAppWindow` 门,改为**形态门**:`pcModeEnabled` 返回(窗口形态不强制)、非 `tablet`/`phone` 返回(2in1 保持桌面窗口);触摸形态下**所有** EntryAbility 窗口(主窗口/换库窗口/starter/panel)都校正为 display 矩形 | 形态不变量按形态判定,不再按"是否主窗口";换库后 `main=false` 的窗口也能恢复整屏 |
| ArkTS `LaunchHelper.startRung` | 第三档重试从空 `StartOptions`(bare)改为 **"windowMode-only"**:保留 `options.windowMode` | 启动降级不得丢形态信息;第三次尝试仍以触摸全屏创建,减少"以浮窗起步再靠校正"的窗口 |
| Docs | `window-state-machine.md` §2 启动行"仅主窗口"→"该形态下所有窗口";新增 Round 107 小节与 4 条不变量 | 规格与实现一致;明确 `isMainAppWindow` 只表示启动 want 无 xcomponentId,不得用于形态判定 |

**六维审计**

| 维度 | 结论 |
|---|---|
| 必要性 | 真机现象可直接追到代码:触摸换库窗口 `main=false` → 三个整屏校正点全被 `isMainAppWindow` 门挡掉 → 引擎桌面记忆 `setBounds` 成功。第 99-101 轮审计已记录"换库后本会话无主窗口",本轮证明整屏校正在这批作业里且属运行期依赖,不是新增假设 |
| 正确性 | 形态门与 Round 102 的不变量同向:窗口形态(`pcModeEnabled=true`)绝不强制尺寸,2in1 绝不强制;触摸形态下窗口就是 display,校正幂等(已整屏直接 return,避免 1300002);`loadContent` 重申与启动首同步走同一函数,天然覆盖"show 前 resize 被拒"的兜底;启动梯子只在"全量 StartOptions 与仅几何都失败"时降级,降级仍保留 windowMode,不改变成功路径 |
| 安全性 | 不新增权限/外部输入/网络;只对**本应用**自己的窗口调用 resize/move;2in1/窗口形态被门排除,不会误改桌面窗口;新增日志不含路径与令牌 |
| 代码质量 | 删除的是语义错误的条件(`isMainAppWindow` 语义与用法不匹配),不是功能;注释写明语义与历史(第 88 轮为何加、第 99-101 轮为何误判);`windowMode-only` 日志可 grep;`forceFullscreenWindow` 仍单点、无新增调用方 |
| 架构 | 状态机不变量从"主窗口特权"修正为"形态约束":触摸整屏对所有窗口、窗口形态只钳制、`isMainAppWindow` 仅服务进程级一次性副作用;规格 §2 与 Round 107 同步,后续改动可静态审查 |
| 耗电性 | 触摸形态新增的窗口校正只在"窗口不是 display 尺寸"时发生(已整屏幂等返回);启动梯子第三档保留 windowMode 可减少"浮窗→校正"的一次 WMS resize 往返;无新增定时器/轮询 |

**自查审计**

- R107-1 删除 `isMainAppWindow` 门会不会把引擎创建的**子窗口**也拉全屏?
  触摸形态下没有合法的浮窗/子窗口:引擎的 vault 窗口、starter/chooser、
  panel 在触摸下都必须是 display 矩形(`createWindow` 也强制
  `WINDOW_MODE_FULLSCREEN`);真正的子窗口走 `SubWindowAdapter`,不经过
  本类。窗口形态由 `pcModeEnabled` 门排除,2in1 由 deviceType 门排除。
- R107-2 会不会在窗口模式误强制?不会:`pcModeEnabled=true` 时第一道门直接
  返回;Round 102 的 `resolvePcModeAtBoot` 保证该字段在首次几何动作前已
  解析,窗口模式的 `forceFullscreenWindow` 调用全部被挡(已有日志
  `force fullscreen ignored: window form factor`)。
- R107-3 2in1 会不会被误强制?不会:2in1 的 `pcModeEnabled` 可能为 false
  (H15 跳过启动读取),所以加了 `deviceType !== 'tablet' && !== 'phone'`
  直接返回;2in1 的桌面窗口几何保持原样。
- R107-4 触摸下每次窗口创建都会多一次 resize 吗?不会:函数内"已整屏则
  return";新建窗口若启动即全屏则零 WMS 交互;只有"以浮窗起步"的窗口才
  需要一次 `resize` + `moveWindowTo(0,0)`(正是本次要修的场景)。
- R107-5 校正与引擎 `setBounds` 的竞态?两者都是异步:我们的启动首同步在
  `loadContent` 之前发起,引擎的桌面记忆恢复在 `runBrowser` 之后;即使
  引擎的 `setBounds` 先落地(窗口浮窗时成功),随后到达的校正会把窗口拉回
  整屏,最终状态正确。不追求"零闪动"(见"未改项")。
- R107-6 启动梯子第三档保留 `windowMode` 会不会让"本该失败"的启动变成
  半成功?不会:`windowMode` 是合法 StartOptions 字段,Round 99 已实测被拒
  的是 `processMode`/`startupVisibility`;保留它只会让系统按全屏创建,
  失败仍由 `onAllFailed` 上报。
- R107-7 第 102 轮验收要点 7("非主窗口冷启动不做整屏校正")自本轮起
  **不再成立**,以本轮 §2/Round 107 为准;该条只保留在历史记录里。
- R107-8 编译验证:`hvigorw assembleHap` **BUILD SUCCESSFUL**
  (2026-10-19 16:55:36,HAP 221,792,861 B;`CompileArkTS` 11.5s,无
  `ArkTS:ERROR`)。改动前后逐段静态核对 `forceFullscreenWindow` 的调用方
  (启动首同步、`loadContent` 重申、模式切回)与 `startRung` 的三档参数。
  未跑真机,验收以真机为准。

**验证要点**(真机,触摸模式)

1. 触摸模式切换仓库:新窗口 hilog 应出现 `forced fullscreen rect: 2800x1840 @ (0,0)`
   (修复前**不会**出现,因为换库窗口 `main=false`);引擎 `setBounds` 被
   `1300010` 拒绝;肉眼新窗口整屏、底部导航条不遮内容。
2. 窗口模式(PC)切换仓库:不得出现 `forced fullscreen rect:`;窗口保持
   浮窗/记忆矩形;标题条可拖动。
3. 触摸模式下反复换库 3 次:窗口始终整屏;无 `isMainAppWindow` 相关回归
   (启动权限仍只在第一个窗口申请,`startup permission granted` 次数不变)。
4. 触摸模式切到 PC 模式再切回:切回时存活窗口被整屏(多窗口场景下所有
   存活窗口都整屏,触摸语义);窗口模式侧仍只钳制。
5. 启动梯子:若出现 `geometry-only retry failed ... - launching windowMode-only`
   → 新窗口仍应全屏创建(旧日志会显示 `launching bare`)。
6. 2in1/手机冷启动不回归(2in1 桌面窗口不被拉全屏)。

**未改项/已知风险**

- C 方案(触摸形态下 `setBounds` 一律跳过)未做:留作加固项。当前依赖
  "校正先于/后于 setBounds 都能收敛到整屏",可能在"引擎 setBounds 先成功、
  校正稍后到达"时有一次短暂跳变(最终状态正确)。
- 触摸形态下若将来出现**合法浮窗**(目前不存在),本轮改动会把它拉全屏;
  届时需要按 `isPanel`/子窗口类型加白名单。
- `isMainAppWindow` 仍用于启动权限申请与 `clearStaleWindowEntries`(进程级
  一次性语义,正确);但"换库后本会话无主窗口"意味着这些作业本轮仍不会
  补跑(第 99-101 轮已记录),与整屏校正无关,留待单独立项。
- `LaunchHelper` 的日志标签由 `bare launch` 改为 `windowMode-only launch`,
  旧验收脚本若 grep `bare launch` 需同步更新。
- 本轮未跑真机;编译为 ArkTS 唯一门(见 R107-8 与提交说明)。

## 第 111 轮(2026-10-19):触摸模式冷启动后窗口被最小化且回不到前台

> 编号说明:并行会话未提交的第 108-110 轮(HEVC 内联播放器系列)已占用
> 108-110,本轮取 111,不改动那些小节。

**用户报告/输入**:真机日志 18:08:39–18:08:48(触摸形态**冷启动**,含一次
"应用自己最小化后再也回不到前台")。日志里**没有换库**操作,因此同时作为
第 102/106/107 轮的回归证据。

**日志证据(时间线)**

| 时间 | 事件 | 判定 |
|---|---|---|
| 39.959–39.969 | `window id captured: 1028, main=true` → pcmode 读 `false` → `layout fullscreen true applied` → `pc mode handled: enabled=false, changed=false` | 第 102/106 轮启动链正常 |
| 40.054–40.058 | 1 次 `re-pushed viewport bounds` + 3 次 `re-push skipped` | 第 106 轮去重生效 |
| 40.559–40.622 | 4 次 `setBounds skipped: window 1 is fullscreen on touch form factor` | 第 107 轮触摸整屏不变量生效 |
| **42.290–42.298** | 8ms 内:`showWindow(1)` → `maximize(1)` → `setWindowLimits(450,282,…)` → `showWindow(1)` → **`minimize(1)`** → WMS `Minimize: id 1028` → `Hide` → `onBackground` | 应用被自己最小化 |
| 42.293 | WMS `Maximize: The device is not supported`,但适配器仍打 `Succeeded in maximizing the window.` | 观测失真 |
| 42.616 | 引擎再 `showWindow(1)` → `showAbility rejected by WMS (16000067), window left as-is`;此后到日志结束(48s)无任何 show/foreground | 无法回前台 |
| 全日志 | `InputKeyFlow` 仅 1 条 Subscribe,`ConsumePointerEventInner`/`HandleInputEvent` 为 0 | 不是用户点最小化 |

**根因(以代码为准)**

1. `AppWindowAdapter.minimize()` 无条件执行桌面语义的 `windowClass.minimize()`。
   触摸形态是"单窗口=整块 display"的形态(状态机 §1/§2),**没有"最小化窗口"
   这个状态**;引擎侧(桌面窗口状态恢复 / 自绘标题栏)一次 `win.minimize()`
   就把应用藏起来。工作区里 ArkTS 侧没有任何 `minimize()` 调用方,调用来自
   引擎 JS 的 `AppWindow.Minimize`。
2. `AppWindowAdapter.showWindow()` 只发 `context.showAbility()`,而该 WMS
   构建对 `showAbility` 固定回 `16000067`,代码把它当"启动期无害 no-op"
   直接吞掉。窗口已在后台时,这条路径**必然失败且没有兜底**——日志 42.616
   即实证。
3. `AppWindowAdapter.maximize()` 在触摸形态下对"本来就是 display 的窗口"
   调用桌面 maximize;WMS 明确 `device not supported`,Promise 仍 resolve,
   旧日志打 `Succeeded`,会误导 Obsidian 把 `isMaximized=true` 写进记忆状态。

**修复**

| 侧 | 变更 | 目的 |
|----|------|------|
| ArkTS `AppWindowAdapter.minimize` | 触摸形态(严格读,读失败保持旧行为)直接忽略并 `warn` | 触摸形态没有最小化状态;断掉"启动即被藏起来"。系统级回桌面不经过该 binding,不受影响 |
| ArkTS `AppWindowAdapter.showWindow` | `showAbility` 返回 `16000067` 时,触摸形态改走新增 `bringWindowToFront()`:窗口 `MINIMIZE` 则 `restore()` 后 `show()`,否则直接 `show()` | 即使窗口被别的路径收起,也能重新显示出来(旧代码把失败当 no-op 静默吞掉) |
| ArkTS `AppWindowAdapter.maximize` | 触摸形态直接忽略并记录;不再执行桌面 maximize、不再打假 `Succeeded` | 触摸窗口已是 display;避免污染 Obsidian 的 `isMaximized` 记忆与验收日志 |
| Docs | `window-state-machine.md` 新增 Round 111:触摸形态"最小化/最大化"不是合法状态变更;前台恢复的兜底路径 | 规格与实现一致,后续改动可静态审查 |

**六维审计**

| 维度 | 结论 |
|---|---|
| 必要性 | 三条日志级证据:42.298 的 `minimize` 无输入事件、42.616 的 show 失败、42.293 的假成功;每条都对应代码里一个无条件执行点,不是猜测 |
| 正确性 | 取消 `minimize` 是"非破坏性方向"(应用保持可见);PC 形态完全不受影响(严格读为 false 才取消);`showWindow` 兜底只在 `16000067` + 触摸形态触发,其他错误码走原日志;`maximize` 忽略仅限触摸形态;`bringWindowToFront` 的 `restore()` 只在窗口状态确为 `MINIMIZE` 时调用,`show()` 幂等 |
| 安全性 | 不新增权限/外部输入/网络;只操作本应用自己的窗口;新增日志只含窗口 id/错误码;严格读失败时保持旧行为(不会因读失败阻止 PC 形态的最小化) |
| 代码质量 | 三个改动点都复用既有形态判定 `isTouchFormFactorStrict()`,不新增第二套形态判断;`bringWindowToFront` 单点、带 try/catch;注释写明设备日志时间戳与"为何取消是安全的" |
| 架构 | 状态机补一条不变量:触摸形态的窗口状态只能由形态动作(整屏/布局)与系统(Home/返回)改变,桌面窗口状态调用(最小化/最大化)不得改变它;前台恢复不依赖 `showAbility`(该 WMS 固定拒绝) |
| 耗电性 | 无新增定时器/轮询;触摸形态下每次 `minimize`/`maximize` 调用直接返回(省一次 WMS 往返);`showWindow` 只在失败路径多一次 `getWindowStatus()` 读 |

**自查审计**

- R111-1 取消 `minimize` 会不会让用户无法退到后台?不会:触摸形态没有系统
  标题条/最小化入口;系统 Home/任务切换由 WMS 发起,不经过
  `AppWindow.Minimize`。PC 形态仍可最小化。
- R111-2 严格读失败时怎么办?保持旧行为(执行 minimize/maximize),最坏退化
  为本轮之前的行为;与第 106 轮 P2-2 的"破坏性动作需要严格读"同向。
- R111-3 `window.show()` 是否足以把应用带回前台?`show()` 让窗口可见,该 WMS
  下是否切前台需真机确认;若仍停在后台,下一步改用
  `windowClass.maximize()/restore()` 组合或 `startAbility`,本轮先按最小改动
  落地并列入验证要点。
- R111-4 为什么不动 `setFullScreen` / `setSimpleFullScreen`?它们走
  `windowClass.maximize(ENTER_IMMERSIVE*)`,用于视频等前台全屏切换;触摸形态
  下窗口已整屏,未在日志中观察到副作用,本轮不动以免影响媒体功能。
- R111-5 为什么 42.298 会调 `minimize`?日志无输入事件、ArkTS 无调用方,只能
  确定来自引擎 JS(桌面窗口状态/标题栏路径);本轮按"触摸形态没有该状态"
  取消,不依赖定位具体调用者。若真机仍出现该调用,说明形态读取失败,日志会
  保留 `minimize ...` 而非 `ignored`。
- R111-6 第 107 轮与第 111 轮的关系:107 保证触摸窗口是整屏(不被引擎记忆
  矩形改),111 保证它不会被桌面状态调用藏起来、且被藏起后能回来。
- R111-7 编译验证:`hvigorw assembleHap` **BUILD SUCCESSFUL**(见下),本轮
  改动逐段静态核对 `maximize/minimize/showWindow` 的调用方(引擎 JS binding,
  无 ArkTS 调用方)。
- R111-8 未跑真机;验收以真机为准(要点见下)。

**验证要点**(真机,触摸模式)

1. 触摸模式冷启动 5 次:hilog **不得**出现 `Minimize: id:` 与
   `Hide: Window hide [... reason:1]`;若引擎确实调用了 minimize,应看到
   `minimize ignored: touch form factor has no minimized state`。
2. 触摸模式不再出现 `Succeeded in maximizing the window.`(应为
   `maximize ignored: touch form factor window is already the display`)。
3. 若窗口被系统/桌面路径收起,点击应用图标恢复:应出现
   `showAbility rejected; window brought to front via window.show()`,窗口回到
   前台(不是 42.6 那种 `window left as-is` 后继续隐藏)。
4. PC 模式(窗口形态)冷启动:`win.maximize()`/`win.minimize()` 仍生效,
   日志不出现 `ignored: touch form factor`。
5. 换库、多窗口、第 107 轮整屏验收不回归。

**未改项/已知风险**

- `window.show()` 在该 WMS 上是否真正切前台未验证;若只让窗口可见但应用仍在
  后台任务栈,需追加 `restore()`/`maximize()` 或 `startAbility` 方案(R111-3)。
- 引擎侧究竟哪段代码在启动时调 `minimize` 未定位(无输入事件);本轮是
  "取消非法状态"而非"修调用者"。
- `setFullScreen`/`setSimpleFullScreen` 仍走桌面 maximize 语义,触摸形态下未
  加门(避免影响媒体全屏),留待真机确认。
- `maximize` 在触摸形态被忽略后,Obsidian 记忆里的 `isMaximized` 可能仍为
  true(历史状态),不再被本次启动刷新;属无害状态(触摸窗口本来就是 display)。
- 本轮未跑真机;编译为 ArkTS 唯一门。

## 第 108 轮 (2026-10-19): 触摸端"点一下视频就关" / 模式切回后矩形不刷新

**用户报告**:①触摸端轻点视频，控件出现的同时视频关闭（手指持续按着则不会关）；
②从平板窗口模式切回触摸全屏模式后，原生视频的位置/尺寸没有刷新。

**根因 1（点一下就关；hilog 16:59:45.971 → 46.001）**
`Index.ets` 的区域裁剪盒用 `.hitTestBehavior(HitTestMode.Transparent)`。ArkUI 的
Transparent 语义是"自己被命中后，**被遮挡的兄弟节点也继续参与命中**"，因此视频上
的一次点击同时到达下层 WebEngine 的 XComponent：Chromium 把光标放进隐藏
`<video>` 背后的笔记正文（编辑器 `focusin`），renderer tracker 按"编辑即关闭"
规则发 `close`，原生 surface 摘除；紧接着 Chromium 为聚焦的可编辑节点重新
`attachTextInput`，软键盘升起（`keyboardHeight: 773`）——用户看到的就是"点一下
视频，视频关掉还弹键盘"。长按不产生 click，所以"一直按着反而不关闭"。

**修复 1**:裁剪盒改为"视频矩形 ∩ 内容区域"（`nativeClipX/Y/W/H`），不再等于整个
region；命中模式改 `Default`。视频矩形内由播放器独占，矩形外仍是普通页面滚动区，
不会把整篇笔记的触摸吃掉。播放器仍按完整矩形布局、由裁剪盒裁切，顶部/底部溢出
行为不变。

**根因 2（模式切回后位置不刷新）**
`applyNativeRect/moveNativeRect` 用 `px2vp(cssPx * dpr)`。只有 renderer 的
`devicePixelRatio` 与当前窗口密度一致时两个因子才抵消；现场日志里窗口从
1650x1241@1.9125 切到 2800x1840@2.25，两侧更新有先后，乘积差 15%~18%，surface
停在旧位置/旧尺寸。
**修复 2**:本引擎里 1 CSS px 恒等于 1 vp，直接用 CSS 矩形，删掉 dpr 往返；请求里
保留 `dpr` 字段兼容旧 renderer。

**附带加固**
- tracker 的 `focusin` 关闭规则要求最近 1s 内页面上有真实 `pointerdown`/
  `touchstart`：原生层挂载/卸载会引起 ArkUI 焦点迁移，Chromium 会重新聚焦上次的
  可编辑节点，属"引擎噪声"；用户点编辑器时仍有 pointerdown，规则照常生效。
- `close` 请求新增 `reason`（keyboard/focus/occluded/offscreen/detached/
  writefail/noack/loop），Index 侧打印
  `NativeVideoIpc close accepted reason=...`，下次现场日志可直接归因。

**验证**:`hvigorw assembleHap` **BUILD SUCCESSFUL**（2026-10-19 17:34，exit 0）；
renderer smoke `B RENDERER SMOKE OK`（close 请求已带 `reason:"occluded"`）；
HAP `electron-default-signed.hap` **221,792,784 B**，SHA-256
`9F2EFAFBCF8F2EBD66392D124CF727948F304ADB2D558F7A5A2A078422ACD22E`；HAP 内
`resources/resfile/resources/app/obsidian.asar` **25,920,570 B**，SHA-256
`6A628DB70C4FE851967FA2DF211A78FAF58B520B20A9B386709B017465AC2AAF`，与仓库
文件一致（已解包复核）。**真机待验证**。

**验收要点（触摸端）**
1. 轻点视频：控件出现，视频不关闭、不弹软键盘；日志无 `close accepted`。
2. 连点两次：第一次只唤出控件，第二次播放/暂停。
3. 视频矩形外上下滑动仍滚动笔记；矩形内横滑 seek、竖滑音量。
4. 平板窗口模式 → 触摸全屏模式：视频矩形随新布局刷新，不残留旧位置/旧尺寸。
5. 点编辑器/输入框：原生 surface 关闭、软键盘正常升起（`reason=focus`）。

## 第 109 轮 (2026-10-19): 从"能用"到"好用"——控件语汇统一、入口无感、缩略图时序

**用户反馈（真机通过后的审美问题）**:控件太丑、图标不统一；预览图与 Obsidian 美学不匹配、看视频时容易"出戏"；进入 HEVC 视频的方式和普通 AVC 不一样；缩略图有时必须先点进视频才出现。

**根因**
1. **图标三套语汇混排**：播放/暂停用文本 `❚❚ ▶`、重播用 `↻`、静音用 emoji `🔇 🔊`、全屏用制表箭头 `⤡ ⤢`、关闭用 `✕`。字重、基线、光学尺寸全不同，所以控件永远"像外挂"。
2. **入口是叠加物**：角落一个 `▶ 内置播放器` 文本按钮 + 一张单独定位的预览 `<img>`。视频本体与按钮/预览是三层不同来源的视觉，和 Obsidian 的 `<video>` 不是一个东西。
3. **缩略图请求时序**：旧 `ohsidianRequestNativeThumb` 在 `xcomponentId` 未解析时就发 `thumb`（Index 无法归属窗口，直接丢弃），文件名随机、加载后又把文件删掉 —— 于是只有"先点开一次播放器"（open 路径带 identity）才可能生成，重开笔记也不会复用。

**修复**
| 项 | 变更 |
|---|---|
| 控件图标 | `NativeVideoOverlay.ets` 新增 `glyph()` builder：`Shape`+`viewPort(24)`+`Path.commands`，统一 1.7vp 描边、圆头端点/圆角连接；播放三角填充；图标换成 Lucide 几何（play/pause/rotate-ccw/volume-2/volume-x/maximize/minimize/x） |
| 控件版式 | 条高 40→44，按钮命中区 36–40；时间码定宽 88 防跳动；滑块 block 10；顶边加 1vp hairline；速度 chip 保留文本 `1×`（与 Obsidian 一致），不再混用 emoji |
| 入口 | 删除角落文本按钮与独立预览层，改为视频自身盒子：`span.ohsidian-native-shell`（`inset:0`、圆角 `var(--radius-s)`、底色 `var(--background-primary)`）+ `img` 首帧 poster + 居中 46px 播放圆盘（13:8 三角形） |
| 无感判定 | 新增 `ohsidianCodecOf()`：只扫文件首/尾 256 KiB 的 `stsd` 采样描述，`hvc1/hev1` → HEVC、`avc1/avc3` → AVC，结果按路径缓存；配合 `canPlayType('hvc1')` 守卫，**AVC 完全不建层、不弹 Notice**，HEVC 才显示 poster |
| 缩略图 | 确定性缓存 `ohsidian-thumb-<basename>-<size>-<mtime>.jpg`；先查缓存直接 set src（零 IPC）；identity 未解析时等待重试（250ms×40，每 2s 重发一次）；加载后保留文件复用 |

**验证**：`hvigorw assembleHap` **BUILD SUCCESSFUL**；renderer smoke `B RENDERER SMOKE OK`（新增 `poster shell / shell class / poster from cache / codec hevc / codec avc / codec cached / close reason` 断言）；HAP **221,807,574 B**，SHA-256 `C704BEFEF87DBFAED146FB9A7C2638748984FD8BC6445B89B1E8EC0C01EE29D3`；HAP 内 asar **25,924,440 B**，SHA-256 `F25766F70EBA704BFF36634C878AD9A345EDFA38BA7AACA36E61DA014DF23139`（已解包复核）。**真机待验证**。

**验收要点（触摸端）**
1. H.264 内嵌视频：**零变化** —— 没有 poster、没有按钮、没有"编码不支持"Notice。
2. HEVC 内嵌视频：显示首帧 + 居中播放圆盘；轻点一次即播；控件图标风格统一（无 emoji/制表字符）。
3. 新增/打开笔记时 poster 立即出现（或 1s 内），不需先进入播放器；重开同一笔记应瞬时出现（缓存）。
4. 播放中 3s 底栏隐去；轻点/悬停重现；暂停与错误时保持可见。
5. 关闭后回到 poster，不残留原生黑框。

## 第 110 轮 (2026-10-19): 控件对齐/放大、竖向音量手势、触屏与指针双密度

**用户反馈**:播放圆盘与底部控件不在一条直线上；控件太小；上下滑动调音量没有生效；并留了一个问题——现在这套控件适合桌面还是触摸，两端都要特化该怎么改。

**根因**
1. **不在一条直线**：poster 的播放圆盘按 `.internal-embed` 的 `inset:0` 居中，原生播放器按 `<video>` 的 rect 居中。embed 盒子有 padding/边框/说明行时两者中心不同，于是"两个播放键不在同一轴线"。
2. **控件小**：上一版是 40vp 条高、34–40vp 命中区、18–19vp 图标，只够指针用；触摸端的最小命中区应是 48vp。
3. **竖向音量不生效**：手势是 `PanDirection.All` + distance 12，方向靠运行时 `|dx|>=|dy|` 猜；另外 `volumeByGesture` 以 `lastAreaH` 为行程，首帧尚未测量时为 0，一次 1vp 的移动就会被除成 0%/100%（表现为"滑了没反应/直接静音"），且父级手势识别器可以抢走拖拽。

**修复**
| 项 | 变更 |
|---|---|
| 对齐 | shell 改为按 `<video>` 的 `getBoundingClientRect` 相对 host 定位（left/top/width/height），不再 `inset:0`；圆盘中心与原生暂停圆盘严格同点 |
| 放大 | 新增 `pointerMode` 双密度：触摸 56vp 条高 / 48vp 命中区 / 24–27vp 图标 / 13fp 时间码 / 3vp 轨 / 14vp 滑块；指针 40 / 34 / 19 / 11 / 2 / 10 |
| 暂停态 | 原生层新增居中播放盘（触摸 64vp、指针 44vp），与 poster 圆盘同尺寸同三角比例 |
| 竖向音量 | 拆成分方向的 `PanGesture(Vertical)` / `PanGesture(Horizontal)`（distance 8）+ `GestureMask.IgnoreInternal`，方向在 `onActionStart` 即确定；音量行程 `max(160, lastAreaH)`，避免首帧 0 高度导致的跳变 |
| 模式来源 | renderer 用 `(hover: hover) and (pointer: fine)` 判定并随每个请求下发 `pointer`；Index 透传给 `NativeVideoOverlay.pointerMode`；poster 在指针模式只在 hover 时显示圆盘 |

**验证**：`hvigorw assembleHap` **BUILD SUCCESSFUL**；smoke `B RENDERER SMOKE OK`（新增 `shell aligned to video rect` 断言）；HAP **221,847,479 B**，SHA-256 `5440B4A2BD56024A7014F4F685FA34F6E5A9098322B9785EDC9964EB917D179F`；HAP 内 asar **25,936,962 B**，SHA-256 `719E0B515E699ABD70A553242BC86AFD28F34CAB6D7C08C5D529DA56A92F7C8E`（已解包复核）。**真机待验证**。

**验收要点**
1. 暂停时，poster 圆盘与原生暂停圆盘在同一像素位置（进出播放器不跳动）。
2. 触摸端底栏 56vp、图标明显放大；指针端（窗口模式）自动变紧凑。
3. 视频内竖滑：出现"音量 xx%"并按比例增减；首滑不会直接静音或拉满。
4. 视频内横滑仍为 seek；双击 ±10s、单击唤出/播放暂停不受影响。

## 第 111 轮 (2026-10-19): 布局系统性错误——圆盘掉到底部、HUD 被控制条挡住、切视频闪旧帧

**用户反馈**:暂停圆盘不在中间、跑到下面；控件还是没有对中；切换视频会有一瞬间显示上一个视频的画面；音量提示被控制条挡住。

**根因（一处，解释三个现象）**
`build()` 的根 `Stack({ alignContent: Alignment.Bottom })`。在这版 ArkUI 里，子组件上的 `.align()` 不是"在父 Stack 内定位"的覆盖项（它是设置组件自身内容对齐的通用属性），因此：
- 居中播放盘 `.align(Alignment.Center)` 无效 → 被 `alignContent: Bottom` 放到**底部居中**；
- 手势 HUD `.align(Alignment.Top)` 无效 → 同样落到底部，正好被控制条压住；
- `2×` 角标 `.align(TopEnd)` 无效 → 也在底部。

"圆盘在下面"和"提示被挡"是**同一个 bug**，上一轮只调尺寸没查容器对齐，是我的失职。

**修复**
| 项 | 变更 |
|---|---|
| 根容器 | `alignContent: Bottom` → `Center`；所有"靠边"的内容改用**容器属性**定位，不再依赖子组件 `.align()` |
| 提示 HUD | 全尺寸 `Column` + `justifyContent(Start)` + `alignItems(Center)`，顶部 14vp，`hitTestBehavior(None)` |
| 2× 角标 | 全尺寸 `Stack` + `alignContent(TopEnd)` |
| 控制条 | 全尺寸 `Column` + `justifyContent(End)` 包住 `Row`：触摸端 96% 宽**悬浮药丸**（中心轴与圆盘一致）、指针端 100% 贴边；圆角四角统一 |
| 切换视频 | 新增 `switching` 状态：`onSourceChanged` 置真并立即盖一层不透明 `theme.bg` + "载入中…"，新文件首次 `playing` 时撤除；`fail()` 也撤除（错误面板不被遮） |

**验证**：`hvigorw assembleHap` **BUILD SUCCESSFUL**；HAP **221,865,835 B**，SHA-256 `C3AD913978E4D4DD84157A4909E890251778F8B138AA2B59A170A9114DD99E3C`；HAP 内 asar **25,939,637 B**，SHA-256 `7CB612610383F3A53B9B2324B138C43821E8CF1184750D901608A775C37BD9FD`；`ets/modules.abc` 已确认含 `载入中`/`switching`/`discSize`/`pointerMode`。**真机待验证**。

**验收要点**
1. 暂停：圆盘在画面正中心（不是底部），与进入前的 poster 圆盘同点。
2. 控制条在底部、水平居中：触摸端为 96% 悬浮药丸，中心轴与圆盘垂直对齐。
3. 竖滑调音量：提示出现在**顶部居中**，不被控制条遮挡；数值按比例增减。
4. 同页切换视频：旧画面不再闪现，直接进入"载入中…"再出新画面。

## 第 112 轮 (2026-10-19): poster 准、原生层不准——密度误判 + 对齐不可靠

**用户反馈**:进入播放器前 poster 的圆盘居中且大小合适；点进播放器后，暂停盘不在中心而且变小；底栏控件仍不对齐。

**根因（两处，都在"原生层"）**
1. **密度误判**：`pointerMode` 来自 renderer 的 `(hover: hover) and (pointer: fine)`。这块平板同时支持鼠标，媒体查询可能为真，于是进入播放器那一刻整套控件切到桌面密度（44vp 盘 / 40vp 条 / 34vp 按钮 / 19vp 图标）——"点进去就变小"。poster 在 DOM 里用 CSS 固定 64px，所以进入前是"对的"。
2. **对齐不可靠**：`Stack.alignContent` / `Column.justifyContent` + 子组件 `.align()` 在这版 ArkUI 的实测布局里没有稳定生效（圆盘落到下边缘）。poster 用 CSS `left/top:50%` 与 `margin` 定位，所以永远准；原生层依赖容器对齐，所以"奇怪"。

**修复**
| 项 | 变更 |
|---|---|
| 密度 | 不再用媒体查询：`__ohsidianMouseAt` 记录真实 `mousemove/pointermove(mouse)`，4s 内有鼠标活动才用紧凑密度，**默认触摸密度** |
| 密度实时生效 | Index 新增 `@State nativePointer`，`open`/`rect` 都更新它并透传 `pointerMode`，鼠标出现/离开会在下一个 rect 心跳（≤1.2s）切换 |
| 圆盘 | 不再依赖 `alignContent`：`discX=discY=` 按实测帧尺寸计算，`.position({x,y})` 显式落位 |
| 底栏 | `barX=(frameW-barW)/2`、`barY=frameH-barH-gap-lift`，`.position()` 显式落位；触摸端 96% 药丸，中心轴与圆盘同一竖线 |
| 可观测 | `onAreaChange` 新增日志 `layout area=<w>x<h> pointer=<bool> bar=<h> disc=<size>`，下次现场日志可直接判断是帧尺寸问题还是密度问题 |

**验证**：`hvigorw assembleHap` **BUILD SUCCESSFUL**；HAP **221,863,713 B**，SHA-256 `7AD332E12DAAA15EBBCF2D7709836B7ACA53B49EFFCDAF4075518865AA33EF73`；HAP 内 asar **25,940,184 B**，SHA-256 `21FB273DE27A0F75948F3FB07EE572D24A6ED629A371D8E71ACFD7B70FD570CA`；`ets/modules.abc` 已确认含 `discX`/`barX`/`barY`/`nativePointer`/`载入中`。**真机待验证**。

**验收要点**
1. 进入播放器后暂停：圆盘与 poster 圆盘同点同大小（64vp）。
2. 触摸端底栏为 96% 居中药丸，中心与圆盘同一条竖线；鼠标移动后 ≤1.2s 自动切紧凑。
3. hilog 出现 `layout area=WxH pointer=... bar=... disc=...`，其中 `area` 应与视频矩形一致。

## 第 113 轮 (2026-10-19): 三处"机制性"错误——poster 消失、密度误判、摆放依赖测量

**用户反馈**:新版本连进入前的 poster 也没了；图标仍然小；底栏不居中；全屏时控制条要等一会才移动。

**以代码为准的根因**
1. **poster 消失**：`touch-mode.js` 的 `loadedmetadata` 用 `!ohsidianEngineCanHevc(el)` 作为建层条件。该引擎对 `hvc1` 的 `canPlayType` 返回乐观值，于是 HEVC 也跳过 poster；此前的"能显示"只是错误/8s 兜底路径碰巧触发。
2. **图标仍小**：`ohsidianPointerMode` 监听 `mousemove` 判鼠标。Chromium 在触摸点击后会合成兼容鼠标事件，触摸端因此恒为 true → 一直用桌面密度（40/34/19/44 盘）。这解释了"越改越小"。
3. **摆放靠测量**：`disc`/`bar` 先依赖根 `Stack.alignContent: Bottom`（把圆盘压到底部），再改用 `lastAreaW/H` 的 `.position()`（全屏切换要等 `onAreaChange`，所以"一会才反应过来"）。三种机制都不可靠。

**修复**
| 项 | 变更 |
|---|---|
| poster | 删除 `canPlayType` 门；只看文件 `stsd` 的 `hvc1/hev1`（`ohsidianCodecOf`），未知编码仍走失败兜底 |
| 密度 | renderer 的 `pointer` 恒为 false；ArkTS 用 `onHover`（手指永不触发）置 `hoverSeen`，默认触摸密度 56/48/24–27、盘 64 |
| 摆放 | 圆盘/底栏改为**全尺寸 Column + justifyContent/alignItems** 的布局约束；不再用子组件 `.align()`、不再用 `.position(测量值)`，全屏切换同帧到位 |
| 裁切补偿 | 视频被底部 toolBar 裁掉时，圆盘按隐藏高度上移，保证"视觉中心"而非"矩形中心" |
| 工程 | 补丁源已重构到 `scripts/patches/touch-mode.js`（原 `update-obsidian.mjs` 改为 `readPatch`）；`repack`/smoke 同步指向该文件 |

**验证**：`hvigorw assembleHap` **BUILD SUCCESSFUL**；smoke `B RENDERER SMOKE OK`；HAP **221,881,814 B**，SHA-256 `22DBFA471B829206641982E594D6AD94ECA97CAB2F428663FB29A94C2FA9391A`；HAP 内 asar **25,944,941 B**，SHA-256 `43D2689A8F1DFEEC8ED2347E8B8E0ADD54E220CB8DAB339D294B66B47F032688`；asar 内已核对 `pointer 恒 false`、无 `canPlayType` 门、shell/cache 均在。

## 第 114 轮 (2026-10-19): 图标"小且不居中"的真因是缩放方式，长按倍速找回，双击全屏

**用户反馈**:播放条本身正常、倍速文字正常，但暂停/声音/放大/关闭四个图标偏小且不居中；长按倍速失效；希望加双击全屏。

**以代码为准的根因**
`glyph()` 之前用 `Shape().viewPort({24x24}).width(size).height(size)`。`viewPort` 只定义**路径坐标系**，不会把 24 单位的绘制内容缩放到更大的节点：Path 仍按 24 单位绘制，锚在节点左上角。于是按钮是 48vp、字形只有 24vp，且视觉重心偏左上——同时解释了"小"和"不居中"。播放条正常，是因为它由 Text/Slider 正常排版，不经过这个 Path。

**修复**
| 项 | 变更 |
|---|---|
| 图标 | `glyph()` 改为固定 24×24 布局 + `.scale({x:size/24,y:size/24})`：以中心缩放，尺寸与居中都是确定的；触摸 30vp / 指针 21vp，播放三角 30/22，暂停盘内字形 0.46×盘径 |
| 长按倍速 | 手势从 38vp 的 Text 移到 **48×56 的整个单元格**（Stack），400ms 长按不再因为按偏/过窄而丢失 |
| 双击 | 中间 1/3 → 全屏；左右 1/3 → ±10s（移动端惯例，一个手势两种职责） |

**验证**：`hvigorw assembleHap` **BUILD SUCCESSFUL**；HAP **221,885,342 B**，SHA-256 `7B9D78671BE7382BB4C75BA77D547661847F93BA1CF9718993841C00CAA63103`；HAP 内 asar **25,947,644 B**，SHA-256 `8A6AE160730C8931C5B113B21CF7EB2380FF0318940C3E4095B4831106698685`；asar 内已复核 `pointer 恒 false`、无 `canPlayType` 门、shell/cache/reason 均在。**真机待验证**。

**验收要点**
1. 底栏四个图标明显变大，且在 56vp 条内垂直居中；与倍速文字同一条基线。
2. 长按倍速：按住底栏「1×」约 0.4s 变 2×，松手回 1×。
3. 双击画面中间进/退全屏；双击左右两侧 ±10s。

## 第 116 轮 (2026-10-19): 对照 poster 审计——圆盘"偏上"是我加的补偿，图标"小"是 Lucide 内边距

**用户反馈**:图标和暂停盘仍偏上、偏小；并指出"进入前 poster 上的暂停盘才是正常的"。

**审计结论（对照 poster 实现逐项核）**
1. **圆盘偏上**：第 113 轮我给圆盘容器加了 `padding(bottom: controlsBottomClip)`（视频被底栏裁切时上移"视觉中心"）。但 poster 是 CSS `50%/50%`，按**视频矩形**居中，没有任何补偿。原生层的 frame 就是视频矩形，这段 padding 一旦非 0 就把圆盘顶高——"偏上"由此而来。**已删除**。
2. **圆盘内三角偏小**：poster 的三角是 19.8×23.2（64 盘），而 Lucide play 路径只占 24 栅格的 13.5×15.6，按 24 缩放后视觉只有 17×20。**改为按 20 单位"光学盒"缩放**（路径留白 2 单位），0.48×64 时视觉 20.7×24，与 poster 对齐。
3. **底栏四个图标小**：同一原因。pause 旧路径只占 6×15，close 只有 12×12；按 24 缩放后视觉 7.5×18.8 / 15。**pause 改为 8×16、close 改为 16×16，统一 20 光学盒**，触摸 26vp → pause 10.4×20.8、close 20.8，明显放大。
4. **顺手修掉一个真 bug**：上一版把"光学右移"的 `translate` 加在了**圆盘节点**上（会把整个圆一起挪走）。现在只作用于字形内层 Stack，2%。
5. **居中链路复核**：每个图标格 48×56，Stack 居中 24 布局盒；整条链路无 padding/margin/align 偏移（逐个核过 play/pause/volume/fullscreen/close/speed）。

**验证**：`hvigorw assembleHap` **BUILD SUCCESSFUL**；HAP **221,907,096 B**，SHA-256 `4DB3B7832C6045263B9545EB8EB2DE32758A5F77BA17919036BCB5BD8F5FEA92`。**真机待验证**。

**验收**：① 暂停盘与 poster 盘同点同大；② 底栏四个图标明显变大且垂直居中；③ 倍速/时间码与图标同一条中线。

## 第 117 轮 (2026-10-19): 截图定量——紧凑密度被触控板触发；图标改为零 transform；全屏比例与模式切换补数据通道

**用户反馈（附截图）**:图标仍小且偏上；全屏仍拉伸；模式切换未按预期隐去再出现。用户提出"是否把图标右下角当 0 点"。

**截图定量（这是本轮的关键证据）**
- 底栏高度约 40vp、图标约 18vp ⇒ **紧凑密度生效**。来源是 `hoverSeen`：平板接了键盘/触控板，hover 事件把 `compactControls()` 置真，触摸使用也被降到 40/34/18/44。之前几轮"越调越小"就是**目标密度在变**，不是常量不对。
- 图标偏上/偏左 ⇒ 字形依赖 `Shape` 的 `viewPort` + `.scale()`。截图尺寸说明缩放没有按中心生效，视觉落在原始 24 栅格的左上区域；用户的"锚点"直觉是对的。

**修复（去掉整类问题，而不是再调参）**
| 项 | 变更 |
|---|---|
| 密度 | 取消双密度：始终 56vp 条 / 48vp 格 / 30vp 图标 / 64vp 盘（`compactControls()` 固定 false） |
| 图标 | 全部改为 **30 栅格路径 + 30×30 盒、零 transform、零 viewPort**：路径坐标即 vp，Stack 居中盒子，不存在锚点歧义 |
| 盘内三角 | 独立 40 栅格大三角（视觉约 20×26），对应 poster 的 19.8×23.2 |
| 全屏比例 | `videoSizeChange` 写入 `videoAspect`；另加**兜底**：进全屏前若仍未知，用内联帧宽高比（Obsidian 的 `<video>` 就是文件比例），并打日志 `aspect from inline frame=` |
| 模式切换 | renderer 每次请求附带 `mode`（0 触摸 / 1 窗口 / -1 未知）；Index 检测到翻转即 `Visibility.Hidden`，等 **400ms 布局稳定后**的新矩形再显示，1.5s 兜底 |
| 清理 | 去掉不被 AVPlayer 类型支持的 `videoSizeChanged` 旧事件（编译期即拒绝） |

**验证**：`hvigorw assembleHap` **BUILD SUCCESSFUL**；smoke `B RENDERER SMOKE OK`（请求已带 `mode`）；HAP **221,905,346 B**，SHA-256 `8E5C5AA9806454239608A22A6F629519A69BE1DCE2E726DAFAD48452E3C3C7FB`；HAP 内 asar **25,948,112 B**，SHA-256 `2AC4D18E72ED3CE6B275D2D12905247E1AEB29C930DBD582403D2724EF3ADC97`；字节码与 app.js 已确认含 `videoAspect`/`glyphBig`/`ICON_PLAY_BIG`/`nativePc`/`mode:ohsidianModeFlag()`。

## 第 118 轮 (2026-10-19): 打包审计结论——asar 正确；加"时间码长按"诊断读数

**用户疑问**:重构补丁到 `scripts/patches/` 后，包内 asar 是否正确？

**审计方法**:解包 HAP 内 asar → 与 `scripts/patches/touch-mode.js` 逐字节比对 + 结构计数。

| 检查项 | 结果 |
|---|---|
| HAP 内 asar | 25,948,112 B / `2AC4D18E…`，与 `web_engine/resfile` 源文件一致 |
| `var __ohsidianNativeVideoSeq=0;` 出现次数 | **1**（无重复 B 块，不存在"旧函数后定义覆盖新函数"） |
| `function ohsidianEnsureNativeShell` | 1 |
| `/*OHSIDIAN-PATCH-END*/` | 1 |
| `function ohsidianModeFlag` / `mode:ohsidianModeFlag()` | 1 / 1 |
| 整个 touch 补丁前缀 vs 补丁文件 | 长度均 130,206；唯一差异是 repack 在 B 块接缝多插一个空行（无行为影响） |
| main.js | 228,618 B，主进程补丁已应用（原生视频走 renderer↔ArkTS 回环，不经过 main.js） |

结论：**拆分补丁后的打包链路是对的**，HAP 里的 renderer 就是 R117 代码。

**新增诊断（关键）**：长按底栏**时间码** 0.6s，左上角出现读数：
`v117 WxH aspect=…` / `bar=… btn=… disc=… compact=…`

- `bar=56 btn=48 disc=64 compact=false` → 新构建已生效；
- `bar=40 … compact=true` → 装的是旧包（或进程未重启）；
- `aspect=n/a` → 全屏比例走内联帧兜底。

**验证**：`hvigorw assembleHap` **BUILD SUCCESSFUL**；HAP **221,909,505 B**，SHA-256 `B2B59704DDB5EFF36BB6D09AFB75C1352FA7B397111B68DF812CB8C20C99555D`（21:38）。

## 第 119 轮 (2026-10-19): 读数证明构建生效，量出"小"的真因是路径墨迹只占 53–66%

**证据**：用户长按时间码截图读数 `v117 700x394 aspect=1.778 / bar=56 btn=48 disc=64 compact=false`。
⇒ 新构建已安装、密度正确、比例已获取。那"图标小"只可能来自**字形本身**。

**逐条量路径墨迹（30 栅格）**
| 图标 | 旧墨迹 | 占盒比 | 修正后 |
|---|---|---|---|
| play | 15×19 | 50–63% | 17.5×23 |
| pause | 8×20 | 27–67% | 11×24 |
| replay | 18×18 | 60% | 26×26 |
| volume | 20×20 | 67% | 22×26 |
| maximize | 18×18 | 60% | 26×26 |
| close | 16×16 | 53% | 24×24 |

盒子是 30vp，但**墨迹只有 16–20vp**，在 56vp 条里当然显小。现在按 Material 的"24dp 图标 / 48dp 目标"标准把墨迹做到 24–26vp；盘内三角 21×28（poster 19.8×23.2）。盒子仍 30/40、**零 transform**，不重新引入锚点问题。

**验证**：`hvigorw assembleHap` **BUILD SUCCESSFUL**；HAP **221,909,503 B**，SHA-256 `683E58915D28E83D99B1307A9192636DB56D37CD698B998884E871C11DDCE17A`。

## 第 120 轮 (2026-10-19): 读数加"实测值"——用布局自证，而不是靠肉眼看缩略图

**背景**：R119 的读数确认 `bar=56 btn=48 disc=64 compact=false`，但截图里圆盘与图标仍显小。截图在我这边是缩放预览，凭像素估算不可靠（同一条底栏我算出 40vp 与 56vp 两种结论），所以不再用眼睛量。

**新增**
- 诊断读数第二行（黄色）：`measured bar=<onAreaChange 实测高> disc=<实测直径>`。
- pause 墨迹 11×26、close 26×26（上一版 11×24 / 24×24）。

**判读规则**
| 实测值 | 含义 | 处理 |
|---|---|---|
| `measured bar=56 disc=64` | 布局正确，小的是墨迹 | 继续按数值加大墨迹（26→30） |
| `measured bar≈44 disc≈44` | 声明值没有被渲染出来，上层有缩放/约束 | 查 clip 帧与 vp↔px 映射 |

**验证**：`hvigorw assembleHap` **BUILD SUCCESSFUL**；HAP **221,919,003 B**，SHA-256 `739A5BFC02E51594A1402A078CB2AD58CE81221987B34CCCBD6A2278CC3CE680`。

## 第 121 轮 (2026-10-19): 实测证明布局正确（bar=56/disc=64），问题在"笔画太细、观感弱"

**证据**：用户读数 `v117 700x394 aspect=1.778 / bar=56 btn=48 disc=64 compact=false / measured bar=56 disc=64`。
⇒ 声明值与实测值一致：**布局没有缩水**，小的是"观感"——1.7vp 描边配 24–26vp 墨迹，在 56vp 条里像细线。

**本轮**
- pause 改为**实心两条**（6×26 每条），不再用 2.6 描边；
- 全部图标描边 1.7 → **2.8**；
- 底栏 56 → **60**，按钮格 48 → **52**，圆盘 64 → **68**（poster 仍 64，视觉等大偏大）；
- 诊断读数版本号 `v117` → **`v121`**，便于确认装的是这版。

**验证**：`hvigorw assembleHap` **BUILD SUCCESSFUL**；HAP **221,918,999 B**，SHA-256 `A376ADA8B7B32E00960042C82FC756EBFD4A74D9028A2D7973349928D594EADA`。

## 第 122 轮 (2026-10-19): 栏的构成与中线审计——每个图标格都缺显式 alignContent

**用户要求**：分析栏的构成、中线在哪，别再试。

**栏的构成（逐层）**
1. 外层 `Column`（100%×100%，`justifyContent(End)`，底部 10vp padding）→ 把药丸贴在画面底部；
2. 药丸 `Row`：96% 宽 × 60vp，左右各 10vp padding，`alignItems(Center)`；
3. 内容：5 个固定格（52×60：播放/倍速/音量/全屏/关闭）+ 时间 `Text`（宽 108）+ `Slider`（layoutWeight 1）。

**中线定义**
- 覆盖层中线 = `overlayTop + H/2`
- 圆盘中线 = `discTop + discMeasured/2`（应等于覆盖层中线）
- 底栏中线 = `barTop + barMeasured/2`
- 图标格中线 = `iconTop + iconH/2`（应等于底栏中线）

**发现的缺陷**：5 个图标格是 `Stack` + 固定宽高，但**没有显式 `alignContent`**。这版 ArkUI 的 `Stack` 会忽略子组件的 `.align()`，内容位置完全由 `alignContent`（显式或默认）决定——根 Stack 曾因 `alignContent: Bottom` 把圆盘压到底部，正是同一类错误。所以"图标不在中线上"不是尺寸问题，是**容器没钉死对齐**。

**修复**
- 全部 5 个图标格 + 暂停盘显式加 `.alignContent(Alignment.Center)`（6 处）；
- 诊断读数新增第 4 行（蓝色）：`center ov=… disc=… bar=… icon=…`，直接给出三条中线；
- 读数版本号 → **v122**。

**验证**：`hvigorw assembleHap` **BUILD SUCCESSFUL**；HAP **221,920,527 B**，SHA-256 `7BD9AF3BAFB8CF134D149320BA8896D3828B46344B6D51F8C1E8A3556CE85BCC`。

## 第 123 轮 (2026-10-19): 中线读数证明纵向正确；真正错的是"横向"——覆盖层被钉在裁剪帧左上角

**读数**（用户截图）：`v122 … bar=60 btn=52 disc=68` / `measured bar=60 disc=68` / `center ov=375 disc=375 bar=532 icon=532`。
⇒ **纵向中线精确相等**：圆盘在画面中线、图标在底栏中线。用户说的"位置错误"不是纵向。

**横向的结构缺陷**
- `Index` 把覆盖层 `.position({x: rect.left - clipX, ...})` 钉在**裁剪帧左上角**；
- 裁剪帧 = 视频矩形 ∩ 内容区。笔记右侧有滚动条留白时，交集比视频矩形**窄几个 vp**；
- 于是整个覆盖层（连同底栏）被整体**向左推**了那个差值。截图上就是左间隙 ~15px、右间隙 ~32px 的不对称。

**修复**：非全屏时把覆盖层在裁剪帧内**水平居中**（`x=(clipW-宽度)/2`）；纵向仍钉住矩形，保证滚动时视频跟随笔记。

**验证**：`hvigorw assembleHap` **BUILD SUCCESSFUL**；HAP **221,920,516 B**，SHA-256 `A8FC6F44216531EF800FD5C046BC7D5DCB640ADEE485C03D7BB9B45F721F4575`。

## 第 124 轮 (2026-10-19): 容器中线已对齐（591 vs 590），字形偏左的真正原因是 Shape 的绘制原点

**读数**：`center ov=433 disc=433 bar=590 icon=591` ⇒ 容器全部对齐（1vp 舍入差）。
但截图里**圆盘的三角明显偏左**——容器居中而墨迹不居中，说明问题在**绘制层**。

**机制**
`Shape` 是绘制节点：路径从节点的**左上角**开始画。当它被布局得比"墨迹设计盒"更大时（例如 68vp 的圆盘里放 40 栅格的三角），墨迹就贴在左上角：
- 三角墨迹中心在 40 栅格里是 (23.5, 20)，若 Shape 被撑到 68，视觉上就**偏左 10.5vp**；
- 底栏图标同理：30 栅格的墨迹在 52×60 的格里，被撑大后整体偏左上。

这解释了为什么"加粗、加大"都没修好位置：**盒子变大了，墨迹仍锚在左上**。

**修复**
- `glyph`/`glyphBig` 里把 `Shape` 包进**固定尺寸 Column**（30×30 / 40×40，justify/align Center），绘制盒与设计栅格一一对应，墨迹才真正居中；
- 读数版本号 → **v124**。

**验证**：`hvigorw assembleHap` **BUILD SUCCESSFUL**；HAP **221,919,507 B**，SHA-256 `DE5F00D47F6CB48F94368A2639E9489320DE908152897769A55940CA4EA7A7BF`。

## 第 125 轮 (2026-10-19): 加"物理标尺"诊断——先测清 1vp 等于多少 CSS px

**为什么**：读数 `center ov=471 disc=471 bar=628 icon=629` 已证明容器对齐，但截图目测仍偏小/偏左。反复出现约 0.7 的比值，说明**怀疑单位换算**（ArkUI vp ↔ 页面 CSS px），而这是靠眼睛和假设都分不清的。

**做法**：诊断层在读数下方画一个 **100vp 的红色方框**。截图里用方框宽度与视频宽度（已知 700 CSS）相比，就能反推出 `100vp = ? CSS px`，一次定死单位。

**判读**
- 方框 ≈ 视频宽的 1/7 → 1vp = 1 CSS，单位没问题，剩下是墨迹/光学问题；
- 方框明显更小 → 1vp < 1 CSS，之前所有尺寸都被"缩水"，应按比例放大控件。

读数版本号 → **v125**。

**验证**：`hvigorw assembleHap` **BUILD SUCCESSFUL**；HAP **221,927,106 B**，SHA-256 `048E417F6EF4B8EEF8D4142CB3DF0F0245C04451CCE1EBD447B7EC3444AAA3F3`。

## 第 126 轮 (2026-10-19): 标尺给出单位比——CSS px ≠ vp，整个覆盖层一直比页面视频框小

**标尺读数**：诊断层 100vp 的方框只占 700 CSS 视频宽的 **12.2%**；若 1vp=1CSS 应为 **14.3%**。
⇒ **1 CSS ≈ 1.17 vp**（vp 比 CSS 小）。这也解释了全部症状：
- 覆盖层一直按 CSS 数值当 vp 布局 → 整体比页面视频框**小约 15%**；
- poster 圆盘是 64 **CSS**，原生圆盘 68 **vp ≈ 58 CSS** → 看起来更小；
- 图标同理，全都被缩了同样的比例。

**修复（单位层，不是像素层）**
| 层 | 变更 |
|---|---|
| Index | 新增 `cssToVp() = dpr * px2vp(1)`（每次请求现算，mode 切换不会留旧值）；rect/region 统一 ×k |
| Overlay | 新增 `@Prop unitScale`；`barHeight/btnSize/discSize/glyphSize/timeWidth/timeFontSize/blockSize/trackThickness` 全部 ×`u()` |
| 字形 | 固定 30/40 绘制盒 + `.scale({x:u,y:u,centerX:'50%',centerY:'50%'})`，中心锚点显式，避免旧偏移 |
| 读数 | 版本 → **v126** |

**验证**：`hvigorw assembleHap` **BUILD SUCCESSFUL**；HAP **221,928,171 B**，SHA-256 `500B4D50307C77284D11884FF26AFACA20A8F0CA0BFA70AB73E2D322213560C9`。

## 第 127 轮 (2026-10-19): 以代码为准复盘——R126 的乘数从未生效，字形还被百分比原点拖偏

**代码级事实（不是看图推断）**
1. `Index.ets:153` 的 `nativeCssToVp` 是**普通字段**，不是 `@State`；`unitScale: this.nativeCssToVp` 传给子组件 `@Prop`，非观察变量不参与同步，子组件可固定停在初值 `1`。R125 读数 `bar=60 disc=68`（若 k=1.17 应为 `70.14/79.56`）正是这个失效的读数。
2. `.scale({centerX:'50%', centerY:'50%'})` 的百分比原点在 ArkUI 里按**父容器**解析 → 原点落在格子中心 (26,30)，而字形盒中心是 (15,15)，每次放大把字形往左上拖约 1.9vp / 2.5vp。
3. 图标**墨迹本身偏心**：`ICON_PLAY` 墨迹 x=10..27.5，中心 **18.75**（格子中心 15，偏右 12.5%）；`ICON_PAUSE` 墨迹 8..24，中心 16。
4. `controlsBottomClip` 由 `Index.ets:1048` 算出、`NativeVideoOverlay.ets:87` 声明，注释写着"transport must stay inside the visible region"，但 build 里**一次都没用**——控制条贴在未裁剪的视频矩形底部，被裁剪帧切掉多少就是"又小又不居中"。

**修复（乘数来源 + 几何原点，不动任何像素常数）**
| 层 | 变更 |
|---|---|
| Index | `nativeCssToVp` 改 `@State`；新增 `@State nativeCssW`（rect 的 CSS 宽度原值，两条 rect 路径都写） |
| Overlay | 新增 `@Prop @Watch cssWidth`；`u()` 改为 `lastAreaW / cssWidth` **实测**换算，`unitCache` 为 `@State`，`unitScale` 仅作兜底 |
| Overlay | `lastAreaW/H` 改 `@State`，尺寸/信箱帧随实测盒重算 |
| 字形 | 原点改数值 `centerX:15/20`；`glyph` 的 `size` 参数真正生效（`size/30`） |
| 图标 | `ICON_PLAY → M6.25 3.5 23.75 15 6.25 26.5z`（墨迹中心 15）；`ICON_PAUSE` 双杠 7..13/17..23；`ICON_PLAY_BIG` 墨迹 21×28 居中于 (20,20) |
| 控制条 | 底部内缩 = `10u + clamp(controlsBottomClip, 0, 0.4H)`，`barBottomInset()` |
| 读数 | 版本 → **v127**，新增 `k=/unitScale=/clip=/inset=/css=` |

**验证**
- `hvigorw assembleHap` **BUILD SUCCESSFUL in 42 s**；HAP **221,937,329 B**，SHA-256 `B0ABBC72649ED321353AF9AEEB82E6B2DA020BFEE11F052FCE998E6A6944ABB7`。
- 内嵌 `obsidian.asar` **25,948,112 B** `2AC4D18E72ED3CE6B275D2D12905247E1AEB29C930DBD582403D2724EF3ADC97`——与本轮前一致，说明只改了 ArkTS 层，渲染层补丁未被覆盖。
- `ets/modules.abc` 命中 `v127`、`k=`、`unitScale=`、`css=`、`inset=`、新 play/pause/big 路径；**旧的偏心灵迹路径 `M10 3.5 27.5 15 10 26.5z` / `M13 6 34 20 13 34z` 已不存在**。
- `node --check scripts/patches/touch-mode.js` OK；`B RENDERER SMOKE OK`。

## 第 128 轮 (2026-10-19): 真机读数推翻 R126——k=1.000，问题回到"声明值本身不够大"

**真机读数（用户提供）**：`k=1.000`；第四排 `measured bar=60 disc=68`。

**结论：R126 作废。**
- `k=1.000` ⇒ 本机 **1 CSS px = 1 vp**，`dpr × px2vp(1)` 恒等于 1；
- `measured == declared` ⇒ 声明值就是渲染值，没有被任何上层缩放；
- 所以"整体小 15%"不成立。R126 的 1.17 来自**截图目测标尺**（100vp 占视频宽 12.2% vs 应 14.3%），目测误差被当成了结论——这是推断，不是实测，错误已撤回。
- 同时确认：R127 的 `centerX/centerY = 15/20` 在 `k=1` 时是恒等变换，**不可能是"不居中"的原因**；这一点也必须承认，不能再拿它当挡箭牌。

**"偏小"的唯一剩余解释**：声明值本身。用户列举的是 `暂停/声音/放大/关闭`——正好是控制条上从左到右的四个按钮（跳过速度），所以**只放大控制条**：

| 项 | R127 | R128 |
|---|---|---|
| barHeight | 60 | **74** |
| btnSize | 52 | **64** |
| glyphSize / playGlyphSize | 30 | **38** |
| timeFontSize | 13 | **15** |
| timeWidth | 108 | **128** |
| blockSizePx | 14 | **17** |
| trackThickness | 3 | **4** |
| discSize | 68 | **68（不变）** |

圆盘保持 68：它与海报圆盘（64 CSS px）等大，是进入播放时不该跳变的那一个；用户的四条抱怨里没有它。

**新增读数**：`glyph%=` / `disc%=`（相对播放器宽度），把"大小"变成可核对的百分比；`v128` 版本号用于区分安装包。

**验证**
- `hvigorw assembleHap` **BUILD SUCCESSFUL in 23 s 831 ms**；HAP **221,936,010 B**，SHA-256 `4386D68B116E239D967412D86D614A0D854065B643DE476B7161195162F181A8`。
- 内嵌 `obsidian.asar` 25,948,112 B `2AC4D18E…3ADC97`，与 R126/R127 完全一致——三轮都只改 ArkTS。
- `ets/modules.abc` 命中 `v128  `、`glyph%=`、`glyph=`、`measured bar=`、`(of player width)`；**`v127` 已不存在**。
## 第 129 轮 (2026-10-19): "都变大了"——R128 越过了仓库里写死的验收标准；尺寸改为按宽度取比例

**用户判定**：`所有的都变大了，不对，不对，不对，读代码`。

**读代码（含验收标准）得到的结论**
- `docs/B-NATIVE-OVERLAY.md` 第 32 条原本写死：**触摸端 56vp 条高 / 48vp 命中区**。R128 把条高抬到 **74**、命中区 **64**，**违反了自己仓库里的验收标准**。这是流程错误：尺寸的权威是验收表，不是我的"感觉"。
- 但这条标准也不完整：固定 vp 对 **360vp 手机视频** = 15.6%，对 **700vp 笔记视频** = 8%——同一个数字不可能同时正确。R121 按 56 实现被说"偏小"，R128 按 74 实现被说"变大"，中间几轮在 60/52 打转，本质都是在猜一个"绝对 vp"。

**修复（换模型，不是换数字）**
| 项 | 规则（W = 播放器宽度） | @700vp |
|---|---|---|
| 条高 | `0.094×W` 夹 [56,76] | **65.8** |
| 命中区 | `0.080×W` 夹 [48,64]，再受药丸宽度预算约束 | **56** |
| 图标 | `0.046×W` 夹 [26,34] | **32.2** |
| 圆盘 | `0.0914×W` 夹 [56,72] | **64.0（= 海报圆盘，零跳变）** |
| 时间码字号 / 宽 | `0.019×W` / `0.137×W` | 13.3 / 95.9 |
| 滑块钮 / 轨 | `0.019×W` / `0.0046×W` | 13.3 / 3.2 |

锚点是设备上**唯一被认可过的尺寸**：海报圆盘 64 CSS px / 700px 宽 = 9.14%。圆盘因此严格回到 64；控制条仍是 96% 宽、中心轴与圆盘一致（验收 #35 不变）。

**同时修掉一个真 bug（溢出）**：原来 5 个按钮是固定宽度 `52..64`，加上时间码在窄视频上会**超出药丸自身宽度**，右侧按钮被裁——看起来就是"被切掉/不居中"。现在 `btnSize` 取 `min(比例值, (药丸内容宽 − 时间码 − 边距)/5)`，并给滑块保留 40vp，任何宽度都不会溢出。

**验证**
- `hvigorw assembleHap` **BUILD SUCCESSFUL**；HAP **221,947,187 B**，SHA-256 `BEE4B047A959922BCC36315533189295DE6543BB5BDF56430B8723E694A70BF1`。
- `ets/modules.abc` 命中 `v129  `、`ratioOf`、`glyph%=`、`(of player width)`；`v127`/`v128` 均已不存在。
## 第 130 轮 (2026-10-19): 把"中线"变成读数——crop / shiftX / vclip

**动机**：连续三轮"不居中"都无法用读数证伪。几何结论（`disc == ov`、`icon == bar`、96% 药丸居中）已经成立，但**还剩一个未测量量**：覆盖层是被放在 `rect` 上，还是被放在 `rect ∩ 内容区` 上。若右侧有滚动条/侧栏把视频裁掉，`Index` 会把覆盖层左移 `|crop|/2` 以让控件留在可见中线——代价是**画面相对页面海报位移**。这就是"中线"最后一个可测的偏差来源。

**改动**
| 项 | 变更 |
|---|---|
| Overlay | 新增 `@Prop clipW`；读数新增 `crop=clipW-boxW`、`shiftX=crop/2`、`vclip=controlsBottomClip` |
| Index | 传 `clipW: nativeFullscreen ? 0 : nativeClipW()` |
| 读数 | 版本 → **v130** |

**判定规则（下次读数）**
- `crop=0 shiftX=0` ⇒ 视频盒完整可见，覆盖层零位移，中线由数字关闭，问题只能在观感层。
- `crop<0` ⇒ 内容区裁了视频，画面相对海报左移 `|crop|/2`；此时需要决定优先级：画面跟页面（`x=rect.left`）还是控件跟可见区（当前实现）。

**验证**
- `hvigorw assembleHap` **BUILD SUCCESSFUL in 22 s 437 ms**；HAP **221,944,299 B**，SHA-256 `52D2EABE5A9567180FF9E439C1FA88A2A0E5D5FBFFA4AAE7E5EE1E9132FDDE62`。
- `ets/modules.abc` 命中 `v130  `、`crop=`、`shiftX=`、`vclip=`、`ratioOf`、`glyph%=`；`v129` 已不存在。
- 内嵌 `obsidian.asar` 仍为 `2AC4D18E…3ADC97`（四轮未变）。
## 第 131 轮 (2026-10-19): 改用系统 Video 组件——控制条不再手写

**触发**：R130 读数 `crop=0 shiftX=0 vclip=0`、`measured bar=66 disc=64`，几何与声明完全一致，手写控件已无"可修的数学问题"；用户提出"华为有写好的整套视频控件吗"。

**答案：有 —— ArkUI 内置 `Video` 组件**。SDK 声明（本地 `sdk/default/openharmony/ets/component/video.d.ts`）确认：
- `controls(value: boolean)` 默认 true（播放/暂停、可拖进度、时间、全屏）
- `autoPlay` / `objectFit` / `loop` / `muted`
- `VideoController`：`start/pause/stop/setCurrentTime/requestFullscreen/exitFullscreen/reset`
- `onStart / onPause / onFinish / onPrepared / onUpdate / onSeeking / onSeeked / onError / onStop / onFullscreenChange(Callback<FullscreenInfo>)`
- 解码走系统媒体栈（内部 AVPlayer 同一核心），**HEVC 由系统解**，不经过 Chromium——正是 B 路线要解决的根问题

**实现（可回退）**
| 项 | 变更 |
|---|---|
| Overlay | 顶部新增 `const SYSTEM_VIDEO: boolean = true`；`build()` 分派到 `systemVideo()` 或 `legacyVideo()`（原 1500 行整体保留，仅改名为 builder） |
| 系统路径 | `Video({src, controller, currentProgressRate:1}).controls(true).autoPlay(true).objectFit(ImageFit.Contain)` |
| 源 | 笔记文件不在沙箱 → `fileUri.getUriFromPath()` 转 URI，失败则回退原路径 |
| 保留 | 自绘关闭按钮（系统控制条无"关闭"），复用 30 单位字形，44vp 命中区，右上角 |
| 全屏 | `onFullscreenChange` → `applySystemBars`（状态栏隐藏/恢复逻辑不变） |
| 渲染层 | 海报 / 入口 / rect 跟随 / 裁剪帧 / IPC / ack 全部不动 |

**损失（明示）**：倍速菜单与长按加速、控制条样式跟随 Obsidian 主题（改为系统样式）、调试读数（仅在手写路径）。

**验证**
- `hvigorw assembleHap` **BUILD SUCCESSFUL in 22 s 950 ms**；HAP **221,957,701 B**，SHA-256 `C109321F48187A77A69AAA04E50982A5AACC4863859422DAF25DE4EF75973A5B`。
- `ets/modules.abc` 命中 `system prepared duration=`、`getUriFromPath failed`、`系统播放器无法播放该文件`、`关闭播放器`；同时 `v130`/`ratioOf` 仍在（手写路径未删除，可一行切回）。
- 内嵌 `obsidian.asar` `2AC4D18E…3ADC97` 六轮未变。

**真机待验证**：HEVC 能否直接起播；系统控制条出现且贴视频盒底部；全屏按钮与返回；右上关闭按钮；同页换视频（`src` 变更是否重建，验收 #25）。
## 第 132 轮 (2026-10-19): 用户一句话点破根因——`Stack.alignContent` 不放置单个子组件；同时上线"玻璃"皮肤

**用户观察**：关闭按钮的 `X` 落在圆圈的**左上四分之一**。

**根因（一条，解释全部历史症状）**：该 ArkUI 构建上 **`Stack` 的对齐不作用于子组件**——无论构造参数 `Stack({alignContent: Alignment.TopEnd})` 还是属性 `.alignContent(Alignment.Center)`：
- `systemVideo` 里的关闭按钮本该在右上角，实际渲染在 **Stack 中心**，正好落在系统暂停态大播放圆盘的左上四分之一（用户看到的现象）；
- 更早的根 Stack 用 `Bottom` 把所有子组件压到底部，是同一失败的另一面；
- **控制条 5 个按钮格、圆盘内层、2× 徽标全都用 `Stack+alignContent` 居中 → 字形一直贴在格子左上角**。这就是二十轮"不居中"的真因，也解释了"图标偏小"（字形被挤在角落，视觉占比更小）和"圆盘偏高"。读数查不出来，因为 `onAreaChange` 量的是**格子**的中心，格子确实是对的。

**修复规则（写死）**：**任何居中/定位只用容器属性**——`Column` 的 `justifyContent + alignItems`、`Row` 的 `justifyContent + alignItems`、`Stack` 的构造参数一律不再用于放置子组件。
- 控制条 5 个格子、圆盘内层、关闭按钮：`Stack+alignContent` → `Column+justifyContent(Center)+alignItems(Center)`；
- 关闭按钮：`Stack(TopEnd)` + margin → **全屏 `Column`(Start/End) + padding** 定位；
- 2× 徽标：`Stack(TopEnd)` → `Column(Start/End)`。

**同时上线 R132「玻璃」皮肤（`NativeVideoPro.ets`）**：解码仍用系统 `Video`（`controls(false)`，HEVC 由系统解），视觉自绘：
磨砂胶囊 `backgroundBlurStyle(BlurStyle.Thick)`、居中紧凑药丸（86% 宽、54 高、圆角 27）、投影 + 1px 高光描边、顶部渐隐遮罩、暂停态 64vp 玻璃圆盘、显示/隐藏淡入上移 180ms、滑杆 3vp 轨 + 14vp 白色滑钮。
`NativeVideoOverlay` 顶部三档开关：`PRO_UI`（默认 true）/ `SYSTEM_VIDEO` / 手写 AVPlayer 路径，全部保留可回退。

**验证**
- `hvigorw assembleHap` **BUILD SUCCESSFUL in 23 s 178 ms**；HAP **222,018,194 B**，SHA-256 `D876B39E812893EC871297871F87DE3C9735450FF61772AFDF34704557BBEA6F`。
- `ets/modules.abc` 命中 `NativeVideoPro`(x6)、`播放/暂停`、`无法播放该视频`、`取消静音`、`系统播放器无法播放该文件`、`关闭播放器`。
- 内嵌 `obsidian.asar` `2AC4D18E…3ADC97` 七轮未变。

**真机待验证**：HEVC 起播；胶囊是否居中且磨砂可见；关闭按钮是否在**右上角**；圆盘播放三角是否在圆心；拖进度条 seek；全屏。
## 第 133 轮 (2026-10-19): 系统 `Video` 打不开仓库文件——解码回到 AVPlayer，玻璃皮肤搬过去

**真机日志（用户提供）**
```
AceVideo: Cannot find base path of storage/Users/currentUser/Documents/q/hevc 1.mp4
AceVideo: GetFileInfo failed, fileName=
AceVideo: Video media player set media source failed.
NativeVideoPro --> video onError
```
⇒ **系统 `Video` 组件的 `src` 只接受应用沙箱内 `file://<bundleName>/<sandboxPath>` 与网络 URL，不接受仓库绝对路径**（`fileUri.getUriFromPath()` 产物被当成相对沙箱路径解析，报 "Cannot find base path"）。R131/R132 的黑屏就是这个原因，不是皮肤问题。

**结论**：能读仓库的只有 **`fileIo` 打开 fd → `AVPlayer.fdSrc`**（R108 起一直可用）。所以解码留在这条路，皮肤搬到这条路上。

**本轮改动**
| 项 | 变更 |
|---|---|
| 开关 | `PRO_UI = false`、`SYSTEM_VIDEO = false` → 走 AVPlayer（可播放路径） |
| 玻璃胶囊 | 宽度 96%→**86%**（`maxWidth 620`）、`backgroundBlurStyle(BlurStyle.Thick)`、`#3D000000` + `#26FFFFFF` 1px 高光描边、`shadow(20, 4D000000)`、`borderRadius = barHeight/2` |
| 圆盘 | `#4D000000` + `BlurStyle.Thin` + 1px 描边 + `shadow(18)` |
| 图标 | 描边 2.8→**2.2**（玻璃上更利落） |
| 居中 | R132 的 `Stack.alignContent` → `Column` 修复全部保留（5 个按钮格、圆盘内层、2× 徽标） |
| 取证 | `aboutToAppear` 打印 `transport=pro|system|avplayer v133`——三个分支都会被编译，只有这行日志能证明真机跑的是哪条 |

**验证**
- `hvigorw assembleHap` **BUILD SUCCESSFUL in 25 s 6 ms**；HAP **222,017,852 B**，SHA-256 `7D8C4909A703BF74921CE94D388FFF05A06111C6A5F0230847726C797967757B`。
- `ets/modules.abc` 命中 `transport=`、`v133  `；内嵌 `obsidian.asar` `2AC4D18E…3ADC97` 未变。

**真机待验证**：日志出现 `transport=avplayer v133`；HEVC 起播；胶囊居中且磨砂可见；关闭按钮在右上角；圆盘三角在圆心。
## 第 134 轮 (2026-10-19): 固定尺寸容器不对齐——字形改成"全屏容器 + 内层固定盒"

**用户观察**：所有控件都落在"正方形四等分后左上那一格的中间"。

**判读**：子组件中心落在容器的 **25%** 处，是"子组件被钉在容器左上角、且只有容器一半大小"的精确指纹（30 盒塞进 56/64 格 → 15/56 ≈ 27%）。结合 R132 的关闭按钮现象，结论收紧为：
- `Stack.alignContent` 不放置子组件（R131/R132 已证）；
- **固定尺寸（如 44/56/64）的 `Column` 也不执行 `justifyContent/alignItems`**——否则不会出现 25%。
- 而 **`100%×100%` 的 `Column` 是有效的**：暂停圆盘一直靠它居中，读数 `disc == ov` 是硬证据。

**修复（只依赖被证明有效的形态）**
`glyph` / `glyphBig` 改为两层结构：
```
Column() {                       // 外层：100% x 100%（撑满格子），负责居中
  Column() { Shape() {...} }     // 内层：30/40 固定盒，负责尺寸与 scale
    .width(30).height(30)
    .scale({centerX:15, centerY:15})
}
.width('100%').height('100%')
.justifyContent(FlexAlign.Center).alignItems(HorizontalAlign.Center)
```
外层撑满格子 → 不存在"放在左上角"的余地；内层由**全屏容器**居中 → 用的是被验证过的那条路。同时读数字形尺寸不变。

**验证**
- `hvigorw assembleHap` **BUILD SUCCESSFUL in 22 s 434 ms**；HAP **222,025,037 B**，SHA-256 `B2C6726F585EBF9043326C95514EE9E68F0A363F409CE62851C7431A9BD29D44`。
- `ets/modules.abc` 命中 `v134  `、`transport=`；`v133` 已不存在；`obsidian.asar` `2AC4D18E…3ADC97` 未变。

**真机待验证**：日志 `transport=avplayer v134`；圆盘三角在圆心；五个按钮图标在各自格子中心；关闭按钮在右上角。
## 第 135 轮 (2026-10-19): 撤回臆断——按文档复核布局语义，改为"测量优先"

**用户指出**：我在猜接口，没有查文档。属实。

**查文档后的更正（`sdk/default/openharmony/ets/component/*.d.ts` 的 doc 注释）**
| 我之前的说法 | 文档原文 | 结论 |
|---|---|---|
| `Stack.alignContent` 不放置子组件 | "Sets the alignment of child components in the container"；默认 `Alignment.Center`；**属性优先于构造参数** | **错** |
| 固定尺寸 `Column` 不执行 `justifyContent/alignItems` | `alignItems` 默认即 `HorizontalAlign.Center`；`justifyContent` 为标准纵向对齐 | **错** |
| `.scale()` 的 `centerX` 有百分比歧义 | 默认 `centerX/centerY: '50%'`，数字按 **vp** 解释 | **错** |

⇒ R134 的"全屏外层 + 内层固定盒"建立在错误前提上，**已撤回**；`glyph`/`glyphBig` 回到文档支持的简单形态（固定 30/40 盒 + `Column` 居中 + `scale`）。

**改为测量优先**：读数新增 `playCell=(x,y,w×h)`、`disc=(x,y,w)`，`onAreaChange` 直接量**实际盒子**；版本 → **v135**。

**判定矩阵（下一次读数）**
- `playCell` 宽高 ≠ 56×66 → 尺寸链路错（`btnSize/barHeight` 或父级缩放）；
- `playCell` 的 x/y 不在控制条内 → `Row`/药丸定位错；
- `playCell` = 56×66 且位置正确，但图标偏在格子左上 → 问题在字形自身（`Shape`/`Path`/`scale`），与容器无关。

**验证**：`BUILD SUCCESSFUL in 24 s 562 ms`；HAP **222,029,657 B**，SHA-256 `EB6F7873533D7D91E4E3D352ECA2EF42752940E41FE5F85DE6C4B9E31638AF9C`。
## 第 136 轮 (2026-10-19): 恢复"小矩形+圆角"美学；三层盒子全部描边（盒审计）

**用户要求**：① 恢复原来的小矩形+圆角外观；② 把每个控件的大小用方框框起来，直接看有没有居中。

**改动**
| 层 | 颜色 | 说明 |
|---|---|---|
| 药丸本体 | 白 `#FFFFFF` | 恢复 `theme.bar` 实底 + 10 圆角，去掉磨砂/投影；仍是 86% 宽（上限 620） |
| 按钮格 | 红 `#FF5F5F` | 5 个格子各 1px，露出命中区实际尺寸 |
| 字形绘制盒 | 青 `#5FD0FF` | 30/40 单位盒子，随 `scale` 一起描边 → 描的是**实际绘制范围** |
| 圆盘 | 青 `#5FD0FF` | 恢复 `#6b000000` 实底 |

三级颜色对应三个问题：**白框错** → 药丸定位/宽度；**红框内图标不居中** → 格子对齐；**青框内墨迹不居中** → 路径本身。

版本 → **v136**；读数保留 `playCell=(x,y,w×h)` / `disc=(x,y,w)`。

**验证**：`BUILD SUCCESSFUL in 22 s 276 ms`；HAP **222,022,211 B**，SHA-256 `82DCA1AFFC310ED617A0B35FA4174BBF59E8BB5965AD4B01EEB92184D83E8893`；`ets/modules.abc` 命中 `v136  `、`playCell=`；`obsidian.asar` 未变。
## 第 137 轮 (2026-10-19): 量到根因——`Path.commands` 坐标单位是 px，不是 vp

**截图实测（R136 三级描边 + Python 像素测量）**
| 图标 | 墨迹中心 | 盒子中心 | 偏移 |
|---|---|---|---|
| play/replay | (694,1380) | (712,1396) | (-8.7vp, -7.9vp) |
| volume | (1548,1380) | (1565,1396) | (-8.2vp, -7.9vp) |
| fullscreen | (1662,1380) | (1679,1396) | (-8.4vp, -7.9vp) |
| close | (1776,1380) | (1792,1396) | (-8.2vp, -7.9vp) |

同时墨迹只有 **24~26 px = 12~13 vp**，而路径写了 26 个单位 ⇒ **正好一半**（设备 1vp = 2px）。

**结论**：`Path.commands` 的坐标按 **px** 解释。30 单位网格在这台 2× 屏上只画出 15vp，且锚在盒子左上角——**墨迹中心落在盒子的 21% 处，就是"左上那一格中间"**。二十轮的"偏小 + 不居中"是同一根因。

**修复**：不再用 `.scale()`，改为**数值缩放路径坐标** `k = vp2px(1) × size / 30`（`scalePath()`，圆弧的 rotate/flags 不缩放；描边宽度同样 ×`vp2px(1)`）。线性缩放保持墨迹中心在盒子中心（网格本就以 15,15 / 20,20 为中心）。`glyph`/`glyphBig` 的盒子尺寸改为 `size` / `40u`，`Shape` 同步。

**离线验证（含圆弧极值的 bbox 计算）**
```
OK play/pause/replay/volume/mute/maximize/minimize/close/playBig/replayBig
ALL INK CENTRED  最大偏差 1.1px（0.5vp），墨迹 55.8px = 27.9vp（盒子 32.2vp）
```
（第一版测试对 `replay`/`volume` 报 BAD，是测试只取弧端点、没算弧凸出部分——修正测试后全部通过，不是图标本身偏。）

**验证**：`BUILD SUCCESSFUL in 23 s 719 ms`；HAP **222,032,617 B**，SHA-256 `9AE25C453170FC2D71D8450D286F142169BE01F9107CB1F61AE49C2717FA647E`；`ets/modules.abc` 命中 `v137  `、`scalePath`；`v136` 已不存在。
## 第 138 轮 (2026-10-19): 观感收口——笔画变细、药丸缩小、撤掉诊断描边

**反馈**：`现在没问题了，就是太粗了，然后这个长方形有点大，稍微小一些，精致一些`。

| 项 | R137 | R138 |
|---|---|---|
| 图标描边 | 2.2 | **1.7** |
| 条高 | `0.094W`→65.8 | **`0.078W`→54.6**（夹 [48,64]） |
| 命中区 | `0.080W`→56 | **`0.068W`→47.6**（夹 [40,56]） |
| 图标 | `0.046W`→32.2 | **`0.038W`→26.6**（夹 [22,30]） |
| 时间码 | 13.3 / 95.9 | **11.2 / 80.5** |
| 滑块钮 / 轨 | 13.3 / 3.2 | **10.5 / 2.6** |
| 圆盘 | 64 | 64（不变，与海报同尺寸） |
| 圆角 | 10 | **12** |
| 描边盒 | 白/红/青 | **全部移除** |

**验证**：`BUILD SUCCESSFUL in 22 s 767 ms`；HAP **222,033,320 B**，SHA-256 `0A79CDE614EEF210FB9B22B297B258D0CABC03F66AABFC5DB15E27CEB6F0FCC4`；字节码命中 `v138  `、`scalePath`；`v137` 已不存在；`obsidian.asar` 未变。
## 第 139 轮 (2026-10-19): 描边降到 1；长按面板升级为"媒体彩蛋"（真读 MP4 容器）

**反馈**：`还是太粗了…缩小到1试试`；`长按时间的做成彩蛋…加上视频的参数（像素、帧率、音频质量）`。

**改动**
| 项 | 变更 |
|---|---|
| 图标描边 | 1.7 → **1**（`strokeWidth` 仍 ×`vp2px(1)`，因为描边也是 px） |
| 彩蛋 | 长按时间码。面板改为左上角深色卡片：色板 `#E6141414`、圆角 10、1px `#26FFFFFF` 描边 |
| 内容 | 保留：编码/分辨率、帧率、音轨、时长、文件大小、平均码率、画面尺寸、`k`、版本；**删掉**：`playCell/disc/crop/shiftX/measured/center` 与 100vp 标尺 |
| 参数来源 | **真实解析 MP4 容器**（`probeMedia()`），不是猜 |

**容器解析（`probeMedia` / `probeTrack`）**
- 顶层盒用 16 字节 seek 遍历（`size/type`，支持 64-bit size 与 `size=0`），**只读 `moov`**，4GB 片子也只需几百字节 I/O；
- `trak → mdia/minf/stbl`：`hdlr` 判 `vide`/`soun`；
- `stsd`：视频取 sample entry 四字码（`hvc1/hev1/avc1/avc3`）与 **宽高**（entry+32/+34）；音频取 `mp4a` 的**声道数**（+24）与**采样率**（+32，16.16 定点）；
- `mdhd`：媒体 timescale（v0 @+12 / v1 @+20）；
- `stts`：首条 `sample_count/sample_delta` → **帧率 = timescale / delta**；
- 文件大小 / 平均码率：`文件字节 × 8 / 时长`。

**离线验证（Node 移植同一套解析，跑本地样片）**
```
avc.mp4              avc1 1280x720 30.00fps  | no audio | 0.92 MB
hevc.mp4             hev1 1280x720 30.00fps  | no audio | 1.01 MB
hevc_10bit_1080p.mp4 hvc1 1920x1080 24.00fps | no audio | 1.28 MB
hevc_10bit_720p.mp4  hvc1 1280x720  24.00fps | no audio | 0.60 MB
hevc_8bit_1080p.mp4  hvc1 1920x1080 24.00fps | no audio | 1.26 MB
```
分辨率/帧率/编码全部正确；`*-probe.mp4` 是 25 字节的合成文件，正确报 `no moov`。
**未验证**：带音轨的样片本地没有，`mp4a` 分支按 ISO BMFF 布局实现，面板在有音轨时会显示 `AAC · 48.0 kHz · 立体声`。

**验证**：`BUILD SUCCESSFUL in 26 s 247 ms`；HAP **222,779,564 B**，SHA-256 `EA5F57628D5B12169A48E33ABADFC5DB541472375250B0EE3159291671ABB554`；字节码命中 `v139`、`probeMedia`、`无音轨`、`fps`、`Mbps`；`obsidian.asar` 未变。
## 第 140 轮 (2026-10-19): 时间码字号与药丸厚度再收一档

| 项 | R139 | R140 |
|---|---|---|
| 条高 | `0.078W`→54.6 | **`0.066W`→46.2**（夹 [42,56]） |
| 时间码字号 | `0.016W`→11.2 | **`0.014W`→9.8**（夹 [9,12]） |
| 时间码宽度 | `0.115W`→80.5 | **`0.098W`→68.6**（夹 [62,96]） |
| 图标 | `0.038W`→26.6 | **`0.032W`→22.4**（夹 [19,27]） |
| 滑块钮 / 轨 | 10.5 / 2.6 | **8.4 / 2.1** |
| 命中区宽度 | 47.6 | 47.6（不变，只收纵向） |
| 圆盘 | 64 | 64（不变） |

@700vp：药丸 46.2 高、格子 47.6×46.2、图标 22.4、时间码 9.8。行内固定宽度合计 314.6，滑块仍有 275vp。

**验证**：`BUILD SUCCESSFUL in 31 s 42 ms`；HAP **222,054,509 B**，SHA-256 `F487AB8645239139E708789D59C133DF92F2593D1949BFF45A420F43F4E5F92E`；字节码命中 `v140`、`probeMedia`，`v139` 已不存在；`obsidian.asar` 25,948,112 B `2AC4D18E…3ADC97` 未变。
## 第 141 轮 (2026-10-19): 右侧三键单独收小 + 复盘

**改动**：`音量 / 全屏 / 关闭` 三个次级按钮单独一档尺寸（`glyphSizeRight` / `btnSizeRight`），与 `播放/暂停` 形成主次层级。
@700vp：图标 **22.4 → 18.6**，格宽 **47.6 → 42**；播放/暂停仍是 22.4 / 47.6。

**验证**：`BUILD SUCCESSFUL in 20 s 745 ms`；HAP **222,053,909 B**，SHA-256 `1E5C90A73A6638F475F74CA3EB71FF2257DEDFCF13008EEA839DE463903B7C42`；字节码命中 `v141`、`glyphSizeRight`，`v140` 已不存在。

## 复盘：为什么走了这么多弯路（R108 → R141）

**一句话**：一个"路径坐标单位是 px 不是 vp"的底层事实，被我当成"图标偏小 + 不居中"两个上层现象，追了三十多轮。

**根因链（按因果，不按时间）**
1. **没有观测通道却用推测代替测量**。设备没有 hdc，我用"看截图猜数字"替代"造一个可测信号"。真正的转折点是用户建议"把每个控件用方框框起来"——一旦有了彩色边框，Python 量一次像素就定位了。**我应该在 R110 就自己做这件事。**
2. **从未验证最底层假设**。整套 UI 都画在 `Path.commands` 上，三十多轮里我一次都没验证过它的单位。单位错一半，上层所有现象（偏小、偏左上、不居中）都成立，于是我在上层反复"修"。
3. **把"一半"当成"小"**。半尺寸 + 固定比例偏移（8.2/7.9vp ≈ (30−13)/2）是**单位失配的指纹**；我却把它拆成"偏小"和"不居中"两个问题分别追。
4. **凭现象反推 API 语义**。`Stack.alignContent 不生效`、`固定尺寸 Column 不对齐` 两个结论都不符合 SDK 文档，各消耗一轮（R132/R134），后来被 R135 的文档核对推翻。
5. **换技术栈前没查硬约束**。切系统 `Video` 组件前没确认它的 `src` 只接受沙箱路径，R131/R132 两轮黑屏。
6. **每轮都在"交付"而不是"证伪"**。R126 从截图目测标尺得出"1 CSS≈1.17vp"，没有写成可证伪的假设就当成事实往下传，污染了 R127–R130 四轮。
7. **沉没成本**。越调越觉得"再大/再小一点就行"，而没有回到第一性问题：**坐标单位是什么？**

**代价**：R108→R141，其中约 **10 轮**（R126–R130、R131–R135）直接由上述错误导致；真 bug 的修复本身只有一个概念 + 约 60 行解析/缩放代码。

**可复用 SOP（写进流程，不再靠记性）**
1. 位置/尺寸问题 → **先加可见边界 + 数值读数，再动代码**；
2. 坐标类 API → 第一轮就做**单位验证**（已知长度标尺 × 已知尺寸，用比值判定，不靠目测）；
3. 出现**成比例偏差**（1/2、25%、1.17×）→ 先怀疑单位，再怀疑布局；
4. 每个结论必须**可证伪**：写清"若 X 则 A，否则 B"，并让读数直接给出判别值；
5. 换方案前先查**硬约束**（能力/权限/路径/单位），5 分钟文档 > 2 轮构建；
6. 验收只认**可测量的一致性**，不认"看起来对了"。
## 第 142 轮 (2026-10-19): 彩蛋增加色彩深度/色度采样（读 hvcC，不靠猜）

**回答**：能。但**不能从 sample entry 的 `depth` 字段拿**——HEVC 即使 10bit，VisualSampleEntry.depth 也是 `0x18`。真实值在 **`hvcC` 的 profile_tier_level** 里：
```
hvcC payload: [1]=profile_idc(低5位) [12]=level_idc [16]=chroma_format(低2位)
              [17]=bit_depth_luma_minus8 [18]=bit_depth_chroma_minus8
```
实现：在视频 sample entry 内遍历子盒找到 `hvcC`（从 entry+86 开始走 `size/type`），取上述字节；`depth = (b[17] & 7) + 8`；`chroma` 映射到 `4:0:0 / 4:2:0 / 4:2:2 / 4:4:4`；`profile_idc` 映射 `Main / Main10 / Main Still / RExt`。

**面板现在长这样**
```
HEVC Main10 · 1920×1080
10-bit 4:2:0 · 24.00 fps
AAC · 48.0 kHz · 立体声
00:10 · 1.3 MB · 平均 1.0 Mbps
────────────────
画面 700×394 · k=1.000 · v142
```

**离线验证（本地样片，Node 移植同一解析）**
```
hevc_8bit_1080p.mp4   hvc1 Main   L4.0 1920x1080  8-bit 4:2:0 24.00fps
hevc_10bit_1080p.mp4  hvc1 Main10 L4.0 1920x1080 10-bit 4:2:0 24.00fps
hevc_10bit_720p.mp4   hvc1 Main10 L3.1 1280x720  10-bit 4:2:0 24.00fps
hevc.mp4              hev1 Main   L3.1 1280x720   8-bit 4:2:0 30.00fps
```
hvcC 头字节也对得上：8bit `01 01 60 … f8 f8`、10bit `01 02 20 … fa fa`（`&7` = 0 / 2）。
AVC 无 `hvcC` → 面板不显示深度行（`depthLabel()` 返回空），符合预期。

**验证**：`BUILD SUCCESSFUL in 19 s 470 ms`；HAP **222,057,282 B**，SHA-256 `66CE7CD5BA12A71C74DBA4B721D2C069ACD942F6751DE16FEC525AEA322B89D4`；字节码命中 `v142`、`Main10`、`-bit `、`hvcC`，`v141` 已不存在；`obsidian.asar` 未变。
## 第 143 轮 (2026-10-19): 控件再收一档（右侧贴近文字重量）+ 彩蛋补 HDR/VFR/视频码率

**尺寸（@700vp）**
| 项 | R142 | R143 |
|---|---|---|
| 播放/暂停 图标 | 22.4 | **18.9** |
| 右侧三键 图标 | 18.6 | **14.0** |
| 右侧三键 格宽 | 42 | **36** |
| 播放键 格宽 | 47.6 | **44.1** |
| 时间码/倍速 字号 | 9.8 | 9.8（不变） |

右侧三键现在与倍速文字的视觉重量接近（图标 14 vs 文字 9.8），不再是"突兀的大图标"。

**彩蛋新增（全部真读容器）**
| 项 | 来源 | 说明 |
|---|---|---|
| 色彩深度 / 色度 | `hvcC` +17/+18/+16 | R142 已验证 8/10-bit |
| **HDR / 色彩空间** | `colr`(nclx) primaries+transfer | 16=HDR10(PQ)、18=HLG、9=BT.2020、1=SDR |
| **VFR 标记** | `stts` 条目数 > 1 | 可变帧率提示 |
| **视频码率** | `btrt` avg→峰值回退 | avg 为 0 的编码器占多数，故显示"峰值"并标注 |

**离线验证**
```
hevc_8bit_1080p.mp4   hvc1 1920x1080 8-bit  24fps  btrt max=5.26Mbps avg=0.00
hevc_10bit_1080p.mp4  hvc1 1920x1080 10-bit 24fps  btrt max=5.34Mbps avg=0.00
hevc_10bit_720p.mp4   hvc1 1280x720  10-bit 24fps  btrt max=2.49Mbps avg=0.00
```
`btrt` 偏移（buffer/max/avg = +0/+4/+8）验证正确；样片 **avg 写 0**，因此实现里做了"avg>0 显示视频码率，否则显示峰值"的分档，不拿峰值冒充平均。
**未验证**：本地 5 个样片**都没有 `colr` 盒**（子盒为 `hvcC,fiel,pasp,btrt`），HDR 分支按 ISO/IEC 14496-12 布局实现，只有在存在 `colr` 时才会显示，否则该段自动省略。

**用户视角的"还想要什么"清单**（按解释力排序，供后续取舍）
HDR/色彩空间（已做）→ 旋转（`tkhd` 矩阵）→ 视频/音频码率拆分（部分已做）→ 关键帧间隔/GOP（`stss`）→ 音轨语言/多音轨 → 解码器名与首帧耗时（运行时）→ 缓冲区/丢帧（系统不暴露）。

**验证**：`BUILD SUCCESSFUL in 20 s 81 ms`；HAP **222,063,231 B**，SHA-256 `2117F81B035CEA7D2A26A43B4D8EF1ECD42C25AFFE30519D2EF3C839E0D90723`；字节码命中 `v143`、`btrt`、`视频峰值`、`HDR10`、`HLG`、`VFR`；`obsidian.asar` 未变。
## 第 144 轮 (2026-10-19): 描边单位修正——"1"终于是网格上的 1 单位

**用户**：`感觉这个控件还是粗`。

**根因**（和 R137 同一类错误，这次错在描边）：路径坐标按 `pathScaleFor(size,30)=vp2px(1)×size/30` 缩放，但描边写的是 `stroke × vp2px(1)`——两者不同源。在 18.9vp 的图标上：
- 坐标缩放系数 k = 2 × 18.9/30 = **1.26 px/单位**
- 描边却是 1 × 2 = **2 px** ⇒ 相当于 **1.6 个单位**，凭空粗 60%

所以"调到 1 还觉得粗"是必然的：它从来不是 1。

**修复**
| 位置 | 之前 | 现在 |
|---|---|---|
| 控制条图标描边 | `1 × vp2px(1)` = 2.0 px | `1 × pathScaleFor(size,30)` = **1.26 px**（−37%） |
| 圆盘重播图标 | `2.2 × vp2px(1)` = 4.4 px | `1.4 × pathScaleFor(40u,40)` = **2.8 px**（−36%） |

换算到相对粗细：控制条描边 = 图标宽度的 **3.3%**（Material 是 8.3%），属于"细但不虚"的档。

**验证**：`BUILD SUCCESSFUL in 19 s 343 ms`；HAP **222,063,091 B**，SHA-256 `39FC9739214B142CCFCA54E7A1E611158849B1189305B39443F87B8A20EB53CF`；字节码命中 `v144`，`v143` 已不存在；`obsidian.asar` 未变。

**若还觉得粗**：描边参数现在是"网格单位"，1.0 → 0.8 即为再细 20%，一行可调；不需要再改缩放链路。
## 第 145 轮 (2026-10-20): 手势职责收干净——双击只 seek，长按加速回到画面

**用户问**：`双击到底是放大还是加10s减10s，长按加速也没了`。

**代码事实（改前）**
- `onDoubleTap`：**中间三分之一 → 全屏**，左右两侧 → ±10s。一个手势两个职责，所以"到底是哪个"没有答案；
- 长按加速绑在**倍速小格子**上，而同一个格子还挂着 `.bindMenu`（点按出菜单）——两者抢同一个手势，实际几乎按不出来。

**改法（对齐行业惯例）**
| 手势 | 改前 | 改后 |
|---|---|---|
| 双击 | 中间全屏 / 两侧 ±10s | **左半 −10s，右半 +10s**（只有这一个语义） |
| 长按画面 | 无 | **临时 2×，松手恢复到菜单里选的倍速**（450ms） |
| 长按倍速格 | 与 bindMenu 冲突 | 移除；点按仍出倍速菜单 |
| 全屏 | 双击中间 | 只走全屏按钮 |

手势组是 `GestureGroup(Exclusive)`：拖动 8vp 先满足 Pan → 赢；按住 450ms 不动 → LongPress 赢；更短就抬手 → Tap 赢。三者互斥，不会互相吞掉。

**验证**：`BUILD SUCCESSFUL in 25 s 615 ms`；HAP **222,063,356 B**，SHA-256 `0CD1C7ECADDE3031728C0D29D686E1350E87B85E21BDE1DA25E70909C13BE02A`；字节码命中 `v145`、`画面长按可临时加速`，`v144` 已不存在；`obsidian.asar` 未变。

**注意**：长按加速只在**播放中**生效（暂停时无可加速），这是 `beginBoost` 里 `if (!this.playing) return` 的既定行为。
## 第 146 轮 (2026-10-20): 全局倍速 + 接入 Obsidian 语义令牌（去硬编码色）

**一、全局加速**
倍速是**用户偏好**，不是单视频状态：`filesDir/ohsidian-native-speed.json` 持久化，`loadSpeed()` 在 `aboutToAppear` 读取，`setPlaybackSpeed()` 写入，`prepared` 状态每次（含 resize 重建 surface 后）重新 `applyPlaybackRate(this.speed)`。长按临时 2× **不写文件**，松手回到这个全局值——所以"全局加速"与"长按加速"不打架。

**二、颜色与圆角：全部改为语义令牌**

链路本来就是通的（`scripts/patches/touch-mode.js` 里 `ohsidianNativeTheme()` 已经把 CSS 变量转成 ARGB 送给 ArkTS）：

| 令牌 | Obsidian 变量 |
|---|---|
| bg | `--background-secondary` |
| panel | `--background-primary-alt` |
| bar | `--background-secondary` @92% |
| interactive | `--interactive-normal` |
| accent | `--interactive-accent` |
| onAccent | `--text-on-accent` |
| text / muted / faint | `--text-normal` / `--text-muted` / `--text-faint` |
| border | `--background-modifier-border` |
| radiusS/M/L | `--radius-s` / `--radius-m` / `--radius-l` |

缺口在 ArkTS 侧：还有 10 处硬编码。本轮全部替换：

| 位置 | 改前 | 改后 |
|---|---|---|
| 面板标题 / 图标 | `#ffffff` | `this.theme.text` |
| 面板次要文字 ×3 | `#d2d2d2` | `this.theme.muted` |
| 面板三级文字 | `#8f8f8f` | `this.theme.faint` |
| 面板背景 | `#E6141414` | `this.theme.panel` |
| 面板描边 / 分割线 | `#26FFFFFF` / `#2AFFFFFF` | `this.theme.border` |
| 圆盘底 / 关闭圆底 / 重播键 | `#6b000000` / `#66000000` / `#ffffff` | `this.theme.bar` / `this.theme.onAccent` |
| 药丸圆角 | `12` | `this.theme.radiusM`（8，Obsidian 主容器刻度） |
| 彩蛋面板圆角 | `10` | `this.theme.radiusM` |

现在源码里只剩 `DEFAULT_NATIVE_VIDEO_THEME` 的兜底值（渲染层没送到时用）与 `'#00000000'`（透明）——两者都不是"自选品牌色"。

**三、对照设计纲要做状态标记**
| 要求 | 状态 |
|---|---|
| 主色接入语义变量 | ✅ 本轮完成 |
| 圆角用系统刻度（4/8/12） | ✅ 完成（药丸用 8，圆形按半径） |
| 控件默认隐形、按需浮现 | ✅ 3.2s 自动隐去，触摸/悬停浮现 |
| 手势优先（横滑进度/竖滑音量/双击跳转/长按倍速） | ✅ 全部可用（双击已收敛为 ±10s） |
| 全局快捷键 / 命令面板控制 | ❌ 未做，需要主进程把按键路由给原生层 |
| 时间戳链接 / 转录联动 | ❌ 未做，属渲染层特性，需与 `touch-mode.js` 的 DOM 挂钩 |
| 离屏暂停/释放 | ⚠️ 部分：遮挡/键盘/滚出时渲染层会 close，`aboutToDisappear` 释放 player |
| 可访问性 | ⚠️ 部分：所有控件有 `accessibilityText`，缺键盘操作 |

**验证**：`BUILD SUCCESSFUL in 21 s 638 ms`；HAP **222,072,910 B**，SHA-256 `F497649672D4743E89C314E71B9B91A7CA66B132A4D41D970EF1A31F7593A3F6`；字节码命中 `v146`、`saveSpeed`，`v145` 已不存在；`obsidian.asar` 未变。
## 第 147 轮 (2026-10-20): 彩蛋从"一横条"改成内容自适应的小卡片

**用户**：`彩蛋的样式也要优化，现在占一横条，不太美观`。

**根因**：面板内部放了一个 `Divider()`。**Divider 默认撑满父容器宽度**，于是内层 `Column` 被它撑到满宽，整张卡片变成一条横贯视频的横条。

**改法**
| 项 | 改前 | 改后 |
|---|---|---|
| 分割线 | `Divider()`（撑满父宽） | **删除**，改用 6vp 上间距 |
| 宽度 | 内容 + Divider 撑满 | `constraintSize({ maxWidth: 260 })` 真正按内容收紧 |
| 标题字号 | 13 | 12 |
| 正文字号 | 11 | 10 |
| 末行（画面/k/版本） | 10 | 9 |
| 行距 | 3/2/2 | 2/1/1（更紧凑） |
| 内边距 | 12/12/10/10 | 12/14/9/9 |
| 投影 | 无 | `radius 12 / #33000000 / y 4`，与面板层级一致 |
| 圆角 | `theme.radiusM` | 不变（8，Obsidian 主容器刻度） |

顺带把分辨率里的 `x` 改成排版用的 `×`。

**验证**：`BUILD SUCCESSFUL in 18 s 745 ms`；HAP **222,073,130 B**，SHA-256 `E6D221BFB9DE54C231574C175DF740AA86867A3B9E86F22CD5AF0DBAFF247AB2`；字节码命中 `v147`、`maxWidth`，`v146` 已不存在；`obsidian.asar` 未变。
## 第 148 轮 (2026-10-20): 模式切换链路审查——三个真缺陷

**审查范围**：`windowSizeChange` → `hideNativeForResize` → `revealNative` → `applyNativeRect/moveNativeRect` → 覆盖层 `syncUnit/u()` → `scheduleSurfaceResize`。

### 缺陷 1：揭示基准时间被反复前推（Index）
```ts
if (this.nativeHidden) {
  this.nativeHideAt = Math.max(this.nativeHideAt, Date.now() - 0);  // == Date.now()
  return;
}
```
注释写"不要越推越远"，代码却在推。一次拖动/切换会连发几十个 `windowSizeChange`，`nativeHideAt` 恒等于"现在"，于是 `ts >= hideAt+400` 与 `Date.now() >= hideAt+1200` **永不成立**，只有兜底定时器能把画面放回来 ⇒ **切换后视频消失 0.4~1.5s**。
**修复**：重复事件直接 return，不移动基准；兜底 1500ms → **900ms**（仍大于实测 400-500ms 的 settle），并加日志 `native revealed by safety net`。

### 缺陷 2：全屏时单位换算冻结（Overlay）
`syncUnit()` 在全屏直接 return（没有 CSS 矩形可测），而 `u()` 优先返回 `unitCache` ⇒ 全屏状态下切模式（密度 1.9125→2.25）后 `unitScale` 更新了但控件仍用旧缓存，尺寸错。
**修复**：`u()` 在全屏分支优先用 Index 现算的 `unitScale`，回退才是缓存。

### 缺陷 3：`open` 不复位隐藏态（Index）
若在"切换隐藏中"点开另一个视频，`open` 只等 `revealNative` 的时间闸门，没有任何地方清 `nativeHidden` ⇒ 多黑 400ms 或等兜底。**修复**：`open` 自带完整 rect，直接 `nativeHidden = false` 并清掉兜底定时器。

### 审查后确认没问题的点
- `nativePointer`/`nativeCssToVp`/`nativeCssW` 都是 `@State`，模式切换会触发重建；
- `nativePc` 用请求里的 `mode` 判定，不依赖窗口尺寸（注释已说明"切换瞬间窗口尺寸可能不变"）；
- `cssToVp() = dpr × px2vp(1)` 每次请求现算，不留旧值；
- 关闭/销毁路径会复位 `nativePc`、`nativeHidden` 并恢复系统栏；
- 覆盖层 `unitCache` 由 `实测盒宽 / rect CSS 宽` 得到，密度变化后自校正。

### 仍存在的边界（如实）
- 全屏期间 `rect` 分支跳过几何更新（只更新主题），退出全屏到下一次心跳之间可能有一帧旧尺寸；
- 覆盖层 `Visibility.Hidden` 期间 `onAreaChange` 若未触发，`lastAreaW` 会滞后，需靠 reveal 后的下一次布局修正。

**验证**：`BUILD SUCCESSFUL in 19 s 205 ms`；HAP **222,072,915 B**，SHA-256 `3DAF71062171650A3664727EDF8810C5AC87B6C16350481862B7D692689D8C4E`；字节码命中 `v148`、`revealed by safety net`，`v147` 已不存在；`obsidian.asar` 未变。
## 第 149 轮 (2026-10-20): 打扫战场——删除死代码路径，合并文档

**删除**
| 项 | 规模 | 原因 |
|---|---|---|
| `NativeVideoPro.ets` | 13,257 B | 建在系统 `Video` 上，而它读不到仓库路径（R133 日志已证），整条路径不可用 |
| `systemVideo()` + `SYSTEM_VIDEO`/`PRO_UI` 开关 | ~75 行 | 同上；三路分支收敛为一条 |
| `syncSystemSrc()` / `systemSrc` / `systemController` / `fileUri` 导入 | ~25 行 | 仅服务上面那条死路径 |
| 诊断态 11 个（`iconTop/Left/W/H`、`barMeasured/barTop`、`discMeasured/Top/Left`、`overlayTop/overlayH`）+ 3 个 `onAreaChange` 处理器 | ~60 行 | 彩蛋改版后已无读者，且每次布局都会触发无谓的状态写入 |
| 死方法 5 个（`glyphPct/discPct/cropDelta/boxLeft/n1`）+ `toggleBoost` | ~50 行 | 无调用方 |
| 死属性 `pointerMode`（含 Index 传参） | ~10 行 | `compactControls()` 恒为 false，无人读取 |

覆盖层 **87,936 B / 2,308 行 → 81,970 B / 2,108 行**（−6.8%），连同删除的 Pro 文件共减少约 **21 KB**。

**合并**：`docs/B-NATIVE-OVERLAY.md` 新增《实现摘要（R108–R149 合并）》——三条硬约束（坐标单位 px、居中只能用撑满的 Column、系统 Video 读不到仓库）、尺寸模型、手势表、主题令牌来源、彩蛋字段、验收状态，全部收敛到一页；原设计章节保留作历史。

**审核结论**：构建通过；`ets/modules.abc` 仍命中 `v149`、`transport=avplayer`、`无音轨`、`视频峰值`、`maxWidth`；`obsidian.asar` 未变。

**验证**：`BUILD SUCCESSFUL in 20 s 558 ms`；HAP **221,977,127 B**，SHA-256 `ABF2CC0438EDBC349B7D518FBD9FB37C22F9257D46BDF33F8B1E35A8B5A7234B`。
## 第 150 轮 (2026-10-20): 模式切换的真正问题——重建链的次数、预算与时序竞争

### 一次切换的完整时序（按代码顺序）

| # | 发生什么 | 代码位置 |
|---|---|---|
| 1 | OS 换形态 → 主线程 `windowSizeChange` → 覆盖层立刻 Hidden | `Index.hideNativeForResize()` |
| 2 | 渲染层重排 → 每帧请求带 `rect/region/mode` → 隐藏中也更新几何 | `Index.moveNativeRect()` |
| 3 | 请求里的 `mode` 翻转 → 再隐藏一次（幂等） | `Index` rect 分支 |
| 4 | 400ms 后满足 `ts >= hideAt+400` 的首个 rect → 覆盖层 Visible | `Index.revealNative()` |
| 5 | 覆盖层面积变化 → 320ms 防抖 → `retry('surface area')` → **release + 280ms + initPlayer** | `Overlay.scheduleSurfaceResize()` |
| 6 | 同时 XComponent 尺寸变化 → `onLoad` → surfaceId 变了 → `retry('surface resized')` | `Overlay` XComponent.onLoad |

### 三个缺陷（全在第 5、6 步）

**① 一次切换触发两次重建。** `onLoad` 与面积防抖各调一次 `retry()`，每次 `release()` 掉解码器 ⇒ 两段黑帧、两段音频中断。

**② 重建消耗"解码错误预算"。** `retry()` 里有 `if (retryCount >= 2) fail()`；面积路径会先清零，但 **`onLoad` 路径不清**。切两次模式后 `retryCount` 就到 2，**下一次 resize 直接 `fail()`** ⇒ 播放器显示"播放器初始化失败"并死掉。这是"切几次就不能播了"的来源。

**③ 揭示早于重建完成。** 揭示闸门 400ms；重建链 = 320ms 防抖 + 280ms 重试延迟 + prepare/play ≈ **600–900ms**。于是覆盖层在"新解码器还没出第一帧"时就显示了 ⇒ **黑矩形**。

### 修法

| 改动 | 作用 |
|---|---|
| 新增 `retryResize(reason)`：清零预算 + 500ms 去重 + 置 `resizeCover` | ①②同解：不再吃错误预算、一次切换只重建一次 |
| `onLoad` 与面积防抖统一走 `retryResize` | 消除双重建 |
| 新增 `resizeCover`：不透明 `theme.bg` + 「正在适配…」，在 `playing` / `paused` / `fail` 时清除 | ③：即使揭示早于重建完成，看到的也不是黑矩形 |

`resizeCover` 必须在 `paused` 也清除——暂停态完成的重建不会经过 `playing`，否则遮罩会永久盖住画面。

### 为什么前两次"修"没解决

- R148 修的是**揭示基准被反复前推**（隐藏时间过长），属于"隐藏逻辑"；
- 这次的问题**不在隐藏**，在**重建的次数、错误预算、以及重建与揭示的时序竞争**。两个问题在同一现象下叠加，只修前一个看起来就像"还是有问题"。

**验证**：`BUILD SUCCESSFUL in 21 s 69 ms`；HAP **221,983,446 B**，SHA-256 `C449A6BA0E480270913BED63297AA1112C80F42C6E54D72FB216B4ED083C1100`；字节码命中 `v150`、`retryResize`、`resizeCover`，`v149` 已不存在。