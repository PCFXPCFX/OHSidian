# 外部审计修复记录（2026-09-29）

针对外部 agent 提交的《OHSidian 功能性 Bug 深度审计报告》（约 70 条）逐条**以仓库代码为准**复核后的修复记录。每条给出：审计声称 → 代码核实（file:line）→ 结论（已修复 / 误报不修 / 跳过）→ 修复说明。

原则：
- 审计者可能出错，一切以当前代码与既有变更记录（`CHANGES-2026-09.md`）的真机验证结论为准；
- 华为云同步相关 Bug 不修（该功能已在本 fork 移除，见第 65 轮）；
- 修复时审计上下文函数，保证正确性、安全性，注释只写代码本身表达不了的约束。

## 结论汇总

| 编号 | 主题 | 结论 |
|------|------|------|
| F1 | maxCount=1 丢新窗口 | 误报不修 |
| F2 | popup/floating/embedded 关闭不 removeProxy | 已修复 |
| F3 | popup createWindow 父代理缺失时崩溃 | 部分修复（崩溃论断错误，补显式守卫） |
| F4 | SurfaceReady 与 adapter 失败回调冲突 | 已修复 |
| F5/F6 | CloudSync 分页/登录恢复 | 跳过（华为云已弃用移除） |
| F9 | getWindowContext 互相递归栈溢出 | 已修复 |
| F10 | onPrepareTermination 异步 kAppQuit 被杀 | 已修复 |
| F12 | checkSingleInstance 死代码 | 已修复（删除） |
| F13 | pcmode observer 永不注销 | 已修复 |
| F33 | 六处高度边框 top+left 混算 | 已修复（5 处，第 6 处本就正确） |
| F34 | 快捷登录并发创建/失败锁死 | 已修复 |
| F35 | destroy() 对同一 context 重复 terminateSelf | 已修复 |
| F36 | 浮窗 loadContent 失败三重泄漏 | 已修复 |
| F37 | onSessionDestroy 缺 removeProxy | 已修复 |
| F38 | WebWindow 字段初始化捕获 undefined | 误报不修 |
| F42 | BaseAdapter 构造器 nativeContext 竞态 | 误报不修 |
| F43 | warm restart 不清全局状态 | 误报不修（appUnInit 无人调用） |
| F44 | onAcceptWant 冷启动回退 browser1 | 误报不修 |
| F45 | 动态 import 失败被静默吞掉 | 已修复 |
| F46 | LaunchHelper 同步返回 true | 不修（JSBind 同步契约，见条目） |
| F47 | 重试阶梯只覆盖 16000067 | 不修（设计如此，见条目） |
| F48 | SurfaceReady 异常不重置 stablePolls | 已修复 |
| F14 | IME changeSelection 传计数器 | 已修复 |
| F15 | showTextInput 不重挂 IME 监听 | 已修复 |
| F16 | dragEnter summary 解析为 Array | 已修复 |
| F17 | SDK≥15 多条目拖拽 file.uri=undefined | 已修复 |
| F19 | 自定义光标 PixelMap 泄漏 | 已修复 |
| F20 | NativeThemeAdapter 构造器重置主题 | 误报不修 |
| F21 | 模式文件 200ms 轮询不停 | 部分修复（隐藏暂停 + insets 重应用） |
| F22 | 协议文件读改写竞态丢 OAuth 回调 | 已修复 |
| F23 | insets 单独变化不重跑 applySafeArea | 已修复 |
| F24 | refresh-app-patch 不做文本补丁 | 已修复（缺标记即中止） |
| F25 | verify-asar 缺关键补丁校验 | 已修复 |
| F26 | 切模式盲 800ms reload | 已修复（写盘完成后 reload） |
| F27 | activateFileAccessPersist 命名误导 | 不修（语义本就正确，见条目） |
| F28 | getPrivacyDownloadDir 弹 Save 对话框 | 已修复 |
| F29 | TrashAdapter 仅 /storage 前缀补 docs | 已修复 |
| F30 | 同名媒体文件互相覆盖 | 已修复 |
| F31 | 另存为只保留第一个扩展名组 | 已修复 |
| F32 | 非粘贴板权限类型永不回调 | 已修复 |
| F39 | WebAbility 8 个窗口监听器不 off | 误报不修（见条目） |
| F40 | startUri replace 截断路径 | 误报不修（见条目） |
| F41 | 手机分支缺 insets/fullscreen | 误报不修（见条目） |
| F49 | EngineFlags 永不失效 | 不修（见条目） |
| F50 | background 时仍 keepScreenOn(false) | 误报不修（见条目） |
| F51 | isOnBatteryPower 读静态快照 | 误报不修（batteryInfo 是实时单例） |
| F52 | BLE 多设备 unsubscribe/重连失效 | 已修复（disconnect 清理） |
| F52b | BLE discovery 重复注册泄漏 | 已修复（重注册前 off） |
| F53 | OCR/人脸不查 error、泄漏 pixelMap | 已修复 |
| F54 | 打印 onStartLayoutWrite 重复写 PDF | 已修复 |
| F55 | imageArrival 重复注册 | 已修复 |
| F56 | 预览硬编码 320×240 | 误报不修（无分辨率参数可传） |
| F57 | SetContextMenu callback 赋值时序 | 误报不修（同步块内完成） |
| F58 | RemoveFromStatusBar finally 双回调 | 已修复 |
| F59 | TTS 重建不 shutdown 旧引擎 | 已修复 |
| F60 | 不订阅 LOCALE_CHANGED | 不修（引擎无此回调，见条目）；重复注册泄漏已修 |
| F61 | Battery 只更新 3/6 字段 | 部分修复（见条目）+ 修复 BatteryInfo 悬空导入 |
| F62 | 证书签名失败不 abort 句柄 | 已修复 |
| F63 | DeviceAdapter 错误路径不回调 | 已修复（getRawDescriptor；openDevice 有布尔返回无需修） |
| F64 | OCR 回调签名不一致 | 已修复 |
| F65 | trash 自检改用户 obsidian.json | 已修复（不再写 obsidian.json） |
| F66 | pad 返回 number | 已修复 |
| F67 | WebPage onLoadIntercept 恒 false | 已修复（scheme 白名单） |
| F68 | AccessibilityAdapter 空壳 | 不修（见条目） |
| F69 | DEV-ENV-SETUP 写错 API 版本 | 已修复（22 → 6.1.1(24)） |
| F70 | 两个"第 27 轮" | 不修（文档已有编号说明，见条目） |

---

## 已修复

### F2 — popup / floating / embedded 关闭后不移除 proxy，同 id 二次打不开
- **代码核实**：属实。`PopupWindowAdapter.ets` `closeWindow` 只 `destroyWindow`；`SystemFloatingWindowAdapter.ets` `closeWindow` 只销毁窗口并清 manager 缓存；`WebEmbeddedAbility.ets` `onSessionDestroy`（系统发起的销毁路径）不 `removeProxy`。`AbilityManager.addProxy` 按 id 去重，残留的死 proxy 会让同 id 重建被拒、后续调用全部打到已销毁窗口上静默 no-op。
- **审计中错误的部分**：审计称 `SubWindowAdapter` 的 loadContent 失败路径同样漏 removeProxy —— 不属实，`SubWindowAdapter` 从不调用 `addProxy`（弹窗走的是 `PopupWindowAdapter`，二者是不同链路），无可移除之物。
- **修复**：
  - `PopupWindowAdapter.closeWindow`：destroy 成功回调里 `removeProxy(id)`；
  - `SystemFloatingWindowAdapter.closeWindow`：`destroyWindow().then()` 成功后 `removeProxy(id)`；
  - `WebEmbeddedAbility.onSessionDestroy`：补 `removeProxy(this.xcomponentId)`（与 `closeWindow` 路径对齐）。

### F3 — PopupWindowAdapter.createWindow 父代理缺失
- **代码核实**：审计的"抛 `Cannot read property 'then' of undefined` 崩溃"**是错的**。`proxy?.createSubWindow(x).then(...)` 中 `?.` 会短路**整条**后续调用链（JS 可选链语义），`proxy` 为空时整个表达式求值为 `undefined`，不抛异常——实际症状是**静默 no-op**。
- **修复**：补显式守卫 + `LogUtil.error`（与 `SubWindowAdapter.createNewWindow` 的既有风格一致），让"父代理缺失"可见。

### F4 — SurfaceReady 超时后无条件 start()，与 adapter 的 callback(false) 冲突
- **代码核实**：属实。`SurfaceReady.whenReady` 在 MAX_ATTEMPTS 后仍 `start()`；`SubWindowAdapter` 的失败路径（show/focusable 失败 → `discardFailedSubWindow`）会先回调 `callback(false, id)`，若 XComponent 已 onLoad、轮询已在跑，引擎会先收 `false` 再收 `true`，状态机错乱。
- **修复**：
  - `SurfaceReady.whenReady` 增加可选 `isCancelled?: () => boolean`，每个轮询 tick 与 start 前都检查；
  - `CommonInterface` 新增 `SubWindowCancelToken`，挂在 `IParams`/`ISubWindowInfo` 上；
  - `SubWindowAdapter` 创建弹窗时生成 token，所有失败路径（父代理缺失、create 拒绝、loadContent 失败、discardFailedSubWindow、cancelSubWindow）置 `cancelled = true`；
  - `WebSubWindow.onLoad` 把 token 检查传给 `whenReady`。
- **附带修复**：loadContent 失败路径原先直接 `destroyWindow`，条目残留在 `subWindowList` 里；现统一走 `discardFailedSubWindow`（移出列表 + 置 token + 销毁）。

### F9 — BaseWindowAdapter.getWindowContext 与 ContextAdapter.getActiveContext 互相递归
- **代码核实**：属实。`BaseWindowAdapter.getWindowContext()` → `ctxAdapter.getActiveContext()` → `getProxy(activeWindow).getWindowContext()`。一旦 active proxy 是 popup/floating 适配器自身（它们都继承 `BaseWindowAdapter` 且会 `addProxy(this)`），无限递归栈溢出。
- **修复**：`BaseWindowAdapter` 新增 `windowContext` 字段，创建窗口时捕获**宿主 Ability 的 context**（popup 取父代理的 context；floating 取 `getActiveContext()` 的当次结果），`getWindowContext()` 直接返回它。`getActiveContext()` 的语义不变（返回活动窗口的 context），但递归链被剪断。
- **影响面核对**：`getWindowContext()` 的全部调用方（AppWindowAdapter close/show/hide、AppLifecycleAdapter.destroy、ContextAdapter.getActiveContext）在该语义下行为正确或更优。

### F10 — onPrepareTermination 异步发 kAppQuit 后立即 TERMINATE_IMMEDIATELY
- **代码核实**：属实（`WebAbilityStage.onPrepareTermination`，`is_sync: false`）。系统在回调返回后立即杀进程，异步命令可能永不执行，引擎 will-quit flush（未保存笔记、socket 清理）全部跳过。
- **修复**：改 `{ is_sync: true }` 同步派发（在本回调内阻塞执行，给引擎完成清理的机会）；同时 `this.nativeContext` 未就绪时回退 `JsBindingUtils.getNativeContext(kMainProcess)`，避免首 tick 内终止时命令丢失。

### F12 — checkSingleInstance 永不生效的死代码
- **代码核实**：属实。`super.onCreate`（`WebBaseAbility`）在 `onWindowStageCreate` 之前就分配了 `xcomponentId`，`CheckEmptyUtils.isEmpty(this.xcomponentId)` 永为 false，函数永返回 false，"重复启动 terminate"从未生效。
- **判断**：该保护本身冗余——launchType=specified 下重复启动由 `onAcceptWant` 按 instanceKey 路由到既有实例的 `onNewWant`（第 21 轮已走查确认）。
- **修复**：删除 `checkSingleInstance` 及其调用，留注释说明 specified 启动模式已覆盖该场景。

### F13 — window_pcmode_switch_status observer 永不注销
- **代码核实**：属实（`WebAbility.onWindowStageCreate` loadContent 回调内注册，`onWindowStageDestroy` 无对应注销）。Ability 销毁后 observer 仍持 `this` 闭包，系统设置变化会对已销毁窗口执行 display/window API。
- **修复**：`onWindowStageDestroy` 开头调用 `settings.unregisterKeyObserver(this.context, 'window_pcmode_switch_status', settings.domainName.USER_PROPERTY)`（SDK d.ts 确认 API since 11，与注册参数一致），try-catch 包裹。

### F33 — 高度边框把 xComBorder 加进 xComTop（应为 2×top）
- **代码核实**：属实 5 处（`AppWindowAdapter.setWindowLimits`、`PopupWindowAdapter.setWindowLimits`、`SystemFloatingWindowAdapter.setBounds`/`adjustBounds`/`setWindowLimits`）。项目既有约定（`AppWindowAdapter.setBounds` 注释，第 22/23 轮验证）是"边框对称：宽 +2×left，高 +2×top"。审计列的第 6 处 `SystemFloatingWindowAdapter.windowSizeChange` 监听器**本就正确**（宽减 2×left、高减 2×top），审计引用有误。
- **修复**：5 处 `xComTop + xComBorder` → `xComTop + xComTop`，与 setBounds 约定一致。

### F34 — showHuaweiQuickLogin 并发重复创建 / 失败后永久锁死
- **代码核实**：属实。`this.loginWindow` 只在异步 createWindow 回调里赋值，并发 show=true 都能通过守卫（第二个窗口泄漏）；show=false 时 destroy 失败会 early-return，`loginWindow` 指向已销毁窗口，后续 show=true 全部 fail-fast。
- **修复**：新增 `loginWindowCreating` 标志在 show=true 入口同步置位、create 回调所有出口复位；show=false 一律先释放引用再异步销毁（失败仅记日志，不再锁死）。注：此为华为账号快捷登录（非华为云同步），仍按审计修复。

### F35 — AppLifecycleAdapter.destroy 对所有 proxy 调 terminateSelf
- **代码核实**：属实。popup/floating proxy 的 context 实为其宿主 Ability 的 context，N 个窗口会对同一 Ability context 调 N+1 次 `terminateSelf`（仅第一次有效，其余 reject）。配合 F9 修复后语义已正确（杀宿主 Ability 即回收其子窗口），本条补**按 context 去重**，消除重复调用。

### F36 — SystemFloatingWindowAdapter.loadContent 失败三重泄漏
- **代码核实**：属实。失败只 log，window / SystemFloatingWindowManager 缓存 / AbilityManager proxy 全不清理。
- **修复**：失败路径 `windowClass.destroyWindow` + `removeSystemFloatingWindow` + `removeProxy`。注意 loadContent 回调第二参数是 void，销毁必须用外层 `windowClass`（回调参数遮蔽了外层 `data`）。

### F37 — WebEmbeddedAbility.onSessionDestroy 缺 removeProxy
- **代码核实**：属实。系统发起的 session 销毁不走 `closeWindow`，proxy 残留导致同 id session 无法重建。
- **修复**：`onSessionDestroy` 补 `removeProxy`。
- **审计中错误的部分**："监听器每次重建数量翻倍"不属实——`windowProxy` 是 session 级对象（`session.getUIExtensionWindowProxy()`），随 session 销毁一起释放，不跨 session 累积；不补 off。

### F45 — runTaskAsync 动态 import 失败被静默吞掉
- **代码核实**：属实（`.catch(() => console.log('import failed'))`，release 构建不可见）。
- **修复**：改用 `LogUtil.error`（hilog）输出错误对象。不引入重试/fail-fast：setTimeout 内 throw 会直接崩进程，重试属投机行为。

### F48 — SurfaceReady 异常时不重置 stablePolls
- **代码核实**：属实。`getRect()` 抛异常时保留旧的 `stablePolls`，过渡期旧尺寸在异常后重现会被误判为"已稳定"。
- **修复**：catch 分支 `stablePolls = 0`（`lastWidth/lastHeight` 保留作为下次比较基线）。

---

## 误报不修（审计与代码/事实不符）

### F1 — maxCount=1 导致"开新窗口"被静默丢弃
- **核实**：`AppScope/app.json5` 的 `multiAppMode.maxCount` 是**应用级多开（分身）**配置，与 UIAbility `launchType: "specified"` 的实例数无关。`CHANGES-2026-09.md` 第 22 轮真机日志实锤 `browser3/browser4` 实例均已创建（当时的问题是 StartOptions 校验 16000067，已修），第 21 轮亦明确"EntryAbility 多实例"链路走查通过。`onNewWant` 处理 `uri` 是给 obsidian:// 深链用的，引擎驱动的窗口走 instanceKey→onAcceptWant→新实例，不经过 onNewWant。
- **结论**：声称的"点新建窗口什么也不发生"与真机记录矛盾，不修。

### F38 — WebWindow/WebWindowNode 字段初始化捕获 @LocalStorageLink = undefined
- **核实**：同一模式在 `WebSubWindow` 中早有使用（`private xcomponentId: string = this.params.id`），若装饰器变量在字段初始化时不可用，所有弹窗的 XComponent id 都会变成 `:subXcomponent`，弹窗链路整体不可用——而第 20/21 轮已真机验证弹窗正常。说明 ArkTS 编译产物中装饰器属性先于后续字段初始化就绪。`WebWindowNode` 本身是上游死代码（第 21 轮注明"无人启动"）。
- **结论**：声称的"主窗口初始化路径完全失效"与真机事实矛盾，不修。

### F42 — BaseAdapter 构造器同步获取 NativeContext 与 runTaskAsync 竞态
- **核实**：`JsBindingUtils.getNativeContext` 在缓存未命中时**直接调用** `adapter.getNativeContext(contextType)` —— 与 `initNativeContext` 是同一个原生调用，拿到的是同一个原生上下文对象，不存在"未配置的 context 被缓存"的差异。
- **结论**：无可观察缺陷，不修。

### F43 — GlobalContext/GlobalThisHelper warm restart 不清状态
- **核实**：`appUnInit()` 在整个仓库**没有任何调用方**——DI 容器从不销毁，warm restart（进程存活）时容器与上下文本就持续有效，`isLaunched()` 保持 true 反而使 `appInit` 正确跳过。
- **结论**：给出的失败场景（"容器没重新绑定"）以"appUnInit 会被调用"为前提，该前提不存在，不修。

### F44 — onAcceptWant 冷启动永远回退 browser1
- **核实**：冷启动时引擎状态同样是新的（native context 与进程同生命周期），`kGetLastActiveWidget` 在新引擎里也无"上次活跃窗口"可还。返回 `browser1` 恰是冷启动首窗口的正确 key；warm 路径（`isLaunched()`）工作正常。
- **结论**：不构成缺陷，不修。

### F46 — LaunchHelper.LaunchWithOptions 同步返回 true
- **核实**：属实但**无法在不破坏 JSBind 同步契约的前提下修复**：`DefaultApplicationAdapter` 把返回值同步回给引擎，改成 `Promise` 会改变原生侧约定。失败路径已有 16000067 重试阶梯 + hilog 记录，引擎侧不依赖该布尔做关键决策。
- **结论**：记录为已知限制，不修。

### F47 — 重试阶梯只处理 16000067
- **核实**：设计如此（第 23 轮）。16000067 是该 WMS 构建对 StartOptions 的误拒，属"值得重试"的瞬时不匹配；16000049（ability not found）/16000050（invalid want）非瞬时错误，重试无意义。
- **结论**：不修。

### 华为云相关（F5 CloudSync 分页丢文件 / F6 userId 不恢复）
- **按用户决定跳过**：华为云同步功能已在本 fork 移除（第 65 轮，`WebAbility.onCreate` 仅留注释说明，CloudSyncAdapter 为惰性代码不再构造/注入/通知），不再投入修复。

---

## 已修复（批次 2：输入 / IME / 拖拽 / 补丁脚本）

### F14 — IMFAdapter.changeSelection 把计数器当文本喂给输入法
- **代码核实**：属实（`IMFAdapter.onListenIME` 的 insertText 回调里 `changeSelection("" + this.count++, 0, 0)`）。adapter 根本没有真实文本缓冲，每次插入都向 IME 谎报选区，导致候选词/高亮错乱。
- **修复**：删除 changeSelection 调用与 `count` 字段，留注释说明文本缓冲在 renderer、不可谎报选区。

### F15 — 公开 showTextInput 不重新注册 IME 监听器
- **代码核实**：属实。`offListenIME` 置 `IMEonListen=false` 后，公开 `showTextInput` 只弹键盘不重挂监听——打字无响应。
- **修复**：公开 `showTextInput` 入口补 `if (!this.IMEonListen) { onListenIME(); IMEonListen = true; }`（与 `showTextInputHelper` 一致）。

### F16 — dragEnter summary 被当 Array<string> 解析
- **代码核实**：属实。SDK 确认 `Summary.summary` 是 `Record<string, number>`（类型→大小映射）；旧代码 `JSON.parse(JSON.stringify(summary.summary)) as Array<string>` + `records[i][0]` 取首字符，switch 永不命中，外部拖入无占位数据。
- **修复**：`Object.keys(summary.summary)` 迭代类型键；删除对首字符的判断。

### F17 — SDK ≥ 15 多条目拖拽 `record as File` 取不到 uri
- **代码核实**：属实。多条目模式载荷在 `entryMap` 中（`uniformDataStruct.FileUri.oriUri`），`record as unifiedDataChannel.File` 的 `uri` 是 undefined，`dropData.fileUris.push(undefined)`。
- **修复**：FILE/IMAGE/VIDEO/AUDIO/FOLDER 分支改为取 `entryMap[recordType]`（回退 `entryMap[UTD_FILE_URI]`）的 `oriUri`，取不到时 warn（不再 push undefined）。

### F19 — setCustomCursor 每次新建 PixelMap 从不释放
- **代码核实**：属实。每次悬停带自定义光标的元素泄漏一个 PixelMap。
- **修复**：新增 `cursorPixelMaps: Map<windowId, PixelMap>`；设新光标前 `release()` 旧值；窗口无代理时立即 release 创建的 map。

### F21/F23 — 模式文件轮询（部分修复）
- **代码核实**：
  - F21 属实：渲染进程每窗口 200ms `readFileSync`，窗口隐藏也不停。审计建议的 `fs.watch` 在该沙箱/引擎组合下不可靠（chgmatch 语义与触发器未经验证），采用更保守的方案。
  - F23 属实：`pollTick` 内容变化时不调 `applySafeArea`，旋转/状态栏显隐只改 `cfg.insets` 时 safe-area 保持旧值。
- **修复**：
  - `pollTick` 在 `document.hidden` 时跳过读取；`visibilitychange` 恢复时清 `lastModeRaw` 强制立即重读（不丢事件，省下隐藏窗口的全部轮询开销）；
  - 内容变化时增补 `applySafeArea()`（在 syncFromSystem 之后、decor 之前），旋转/栏显隐在一个 tick 内收敛。
  - 主进程深链轮询保持 1.5s 不动：OAuth 回调恰恰发生在应用后台时，不能按可见性暂停。

### F22 — ohsidian-protocol.json 读改写竞态丢 OAuth 回调
- **代码核实**：属实。主进程轮询 `readFileSync → parse → 处理 → writeFileSync(lastDispatchedSeq)`，与 ArkTS `writeProtocolUriFile` 的追加写构成竞态：ArkTS 在主进程读与写之间追加的条目会被旧快照覆盖。窗口虽小，后果是登录回调静默丢失。
- **修复**：`lastDispatchedSeq` 移入独立游标文件 `ohsidian-protocol.json.cursor.json`（首 tick 回退读旧字段，避免升级后重发已派发条目）；主文件自此 ArkTS-only 写入，主进程永不回写。

### F24 — refresh-app-patch.mjs 不重做文本补丁
- **代码核实**：属实。脚本只剥+prepend IIFE；若对未经 `update-obsidian.mjs` 处理的 asar 运行，产物缺版本闸门/抽屉路由/更新器三处文本补丁，启动即"Manual update required"。
- **修复**：prepend 前检查剥离后的源码是否含三处文本补丁的**已修补形态**标记（`i.app.openVaultChooser()`、`bo=Math.max(...)`、`(at||(D.updateDisabled=!0))`），缺失即非零退出并提示改跑 update-obsidian.mjs。

### F25 — verify-asar.cjs 不校验两个关键文本补丁
- **代码核实**：属实（checks 表无 `bo=Math.max` 与 `openVaultChooser`）。
- **修复**：checks 新增 `main version-floor gate patched`、`app drawer switch routed`、`main deeplink cursor file`（顺带锁住 F22 的新游标文件行为）。已重刷 asar 并全绿通过。

### F26 — 切换阅读/编辑模式盲 800ms reload
- **代码核实**：属实。`applyMobile` 固定 `setTimeout(reload, 800)`，与 `syncActiveFileToTargetLayout` 的异步读+写 workspace 竞态；慢盘上 reload 先于写盘完成，第 57 轮修的"切模式丢文章"复发。
- **修复**：`syncActiveFileToTargetLayout` 增加 `done` 回调 + `settle()`（一次性、写链路 `.then/.catch` 双路径触发、所有 early return 与 catch 都兜底触发）；`applyMobile` 改为在 settle 回调里 reload。UI 提示与模式标记仍即时写入。

## 已修复（批次 3：文件系统 / 权限）

### F28 — getPrivacyDownloadDir 仍弹 Save 对话框
- **代码核实**：属实（`ContextPathAdapter` 仍用 `DocumentViewPicker.save(DOWNLOAD)`）。
- **修复**：改回 `environment.getUserDownloadDir()`（READ_WRITE_DOWNLOAD_DIRECTORY 已声明），无 UI、返回真实 Download 目录；失败回空串。

### F29 — TrashAdapter 仅对 /storage/Users/currentUser 补 docs 候选
- **代码核实**：属实。picker 返回的真实路径不一定在 /storage 前缀下（USB、沙盒），docs 候选不生成则删除失败。
- **修复**：对一切非 file:// 路径无条件加 `file://docs<path>` 候选（候选按顺序尝试，错误候选被 deleteToTrash 拒绝后继续下一个，无副作用）。

### F30 — 同名媒体文件复制互相覆盖
- **代码核实**：属实（tempDir/name 直接 CREATE 覆盖）。
- **修复**：目标名冲突时追加 `-1`、`-2`…序号（stem/ext 拆分，`fs.accessSync` 探测）。

### F31 — 另存为只保留第一个扩展名过滤组
- **代码核实**：属实（`fileSuffixChoices = [filterDescriptions[0]]`）。
- **修复**：`= filterDescriptions` 全量传入。

### F32 — openPermissionConfirm 非粘贴板类型永不回调
- **代码核实**：属实。default 分支后 `confirmParams.title` 为空即 return，callback 悬空，renderer 挂死。
- **修复**：无对话框类型补 `callback(ERROR)` + error 日志（ERROR=-1 与对话框 cancel 语义一致的既有约定）。

## 已修复（批次 4：杂项适配器 / 引擎文件）

### F52 — BLE 通知：disconnect 后重连失效
- **代码核实**：属实（多设备 unsubscribe 判定部分不成立——`CHARACTERISTIC_CHANGE_MAP` 为空才 off，A/B 场景正确跳过；真正的缺陷在 `disconnectGatt`：只 off 连接状态监听，不清 `NOTIFY_LISTENING_DEVICES` 与该设备的回调前缀，重连后新 GattClientDevice 永远不注册通知监听）。
- **修复**：`disconnectGatt` 补 `device.off('BLECharacteristicChange')`、清 `NOTIFY_LISTENING_DEVICES`、按 `deviceId_` 前缀清 `CHARACTERISTIC_CHANGE_MAP` 中该设备的残留回调。

### F52b — BLE startDiscoveryMonitor 重复注册泄漏
- **代码核实**：属实（Pattern B）。重复调用会叠加系统监听器，而 `ON_GATT_CHANGE_CALLBACK` 只记最后一个，stop 永远移不掉旧闭包。
- **修复**：注册前先 `ble.off('BLEDeviceFind', previous)`（previous 为 undefined 时跳过）。

### F53 — ShapeDetection 不查 error、不释放 pixelMap
- **代码核实**：属实。`recognizeText` 回调不查 error（失败时 data undefined 直接崩）；两条路径（OCR/人脸）的 pixelMap 从不 release。
- **修复**：OCR 先查 error；两条路径 try/finally 中 `pixelMap.release()`；人脸 `detect()` 包 try/catch 并在失败时 `callback([], 0)`（原先 promise 拒绝会吞掉回调）。

### F54 — PrintPdfFiles 每次 onStartLayoutWrite 都写完整 PDF
- **代码核实**：属实。onStartLayoutWrite 可能因属性变更多次触发，重复 `writeSync(fd, pdfData)` 会拼接出损坏的 PDF。
- **修复**：按 `jobId:fd` 记录已写入键，重复触发跳过写入、直接回 PRINT_FILE_CREATED_UNRENDERED（新 fd 新写）。

### F55 — getImageReceiver 重复注册 imageArrival
- **代码核实**：属实。N 次调用 N 个监听器，每帧 N 倍处理且第二次 release 抛异常。
- **修复**：`imageArrivalRegistered` 单次注册守卫。

### F58 — RemoveFromStatusBar finally 中 off 抛异常导致双回调
- **代码核实**：属实。onCompleted(true/false) 已发后 finally 中 `statusBarManager.off` 抛错会再发一次 onCompleted(false)。
- **修复**：finally 内 off 调用包 try/catch。

### F59 — TTS 重建引擎不 shutdown 旧引擎
- **代码核实**：属实。切语言重建时旧引擎 listener 仍活动。
- **修复**：`createTextToSpeechEngineAndSetListener` 入口先调既有 `textToSpeechEngineShutdown()`。

### F61 — Battery 字段（部分修复 + 悬空导入修复）
- **代码核实**：
  - `CommonInterface` 从未导出 `BatteryInfo`，而 BatteryAdapter `import { BatteryInfo } from '../interface/CommonInterface'`——审计没发现的真实编译错误（本批构建时一并暴露）。
  - 事件参数（soc/chargeState/present）之外，`estimatedRemainingChargeTime`/`remainingEnergy` 在 batteryInfo 模块与 BATTERY_CHANGED 参数里都**不存在**，无法"补全"；`nowCurrent` 自 API 12 起可从模块实时读。
- **修复**：CommonInterface 补 `BatteryInfo` 接口定义；事件更新块内刷新 `nowCurrent`；其余两个字段留 -1 并注释平台限制。

### F62 — signByCertUri 失败路径不 abort 句柄
- **代码核实**：属实（update/finish 失败只回调空 buffer，不释放会话）。
- **修复**：init 成功后定义 `abortSilently()`，update/finish 失败路径调用 `certManager.abort(handle)`。空 buffer 返回值契约不变（引擎侧同步接口，无法改签名）。

### F63 — DeviceAdapter 错误路径不回调
- **代码核实**：openDevice 部分**不属实**——它是同步布尔返回且 bind 原样透传，引擎能看到失败；getRawDescriptor 部分**属实**——void 返回且 catch 后静默，引擎挂等。
- **修复**：getRawDescriptor 失败补 `callback(new Uint8Array(0), 0)`；openDevice 不动。

### F64 — OcrAdapter 回调签名不一致
- **代码核实**：属实（错误/空图路径 `callback(wordsArray)` 缺长度参数）。
- **修复**：两处错误路径补 `callback(wordsArray, 0)`，与成功路径 `(words, length)` 一致。
- **附带修复**：`TextWord`/`OcrAdapterImage` 从未在 CommonInterface 导出（同 F61 的悬空导入）；`OcrAdapterImage` 补进 CommonInterface，`TextWord` 改用 SDK 自带 `textRecognition.TextWord`（type 别名）。

### F65 — trash 自检改用户 obsidian.json
- **代码核实**：属实（开发者放 `harmonyos-trash-test.enabled` 后自检直接注册/还原用户配置）。核心发现：`shell.trashItem` 根本不需要在 obsidian.json 注册 vault——注册纯属多余。
- **修复**：自检不再读写 obsidian.json，只建临时 vault + 测试文件验证 trashItem，finally 清理测试目录。 kill -9 残留脏条目的整类风险随之消失。

### F66 — pad(number) 返回 number
- **代码核实**：属实（依赖隐式转字符串）。
- **修复**：`return String(number)`。（注意：此文件是引擎侧**松散** main.js，不在 obsidian.asar 内。）

### F67 — WebPage.onLoadIntercept 恒 false
- **代码核实**：属实但无可达攻击路径（唯一调用方 QuickLoginButtonComponent 传硬编码协议 URL）。仍属廉价纵深防御。
- **修复**：拦截器改为 https/file/about:blank 白名单，其余 scheme 阻断并 hilog.error。

### F69 — DEV-ENV-SETUP.md API 版本过时
- **代码核实**：属实（文档写 6.0.2(22)，build-profile 实际 `6.1.1(24)`）。
- **修复**：文档两处更新为 6.1.1(24)，FAQ 反向说明同步更正。

## 误报不修（批次 2-4 补充）

### F20 — NativeThemeAdapter 构造器重置 colorMode
- **核实**：适配器经 `Inject.getOrCreate` 是进程级单例，构造器只跑一次；`InjectModule.destroy()`（unbindAll）全仓库无调用方，审计假设的"warm restart 容器重建"不存在。
- **结论**：无可观察缺陷，不修。

### F27 — activateFileAccessPersist "名字叫 persist 实际不 persist"
- **核实**：属实但**语义正确**：`fileAccessPersist`（persistPermission，跨重启）在 picker 选择路径调用；`activateFileAccessPersist`（activatePermission，本会话）在每次启动 `initPermissions` 调用——这正是 HarmonyOS 文档的持久化+激活两段式：persist 只需一次，activate 每个会话必需。仅命名有轻微误导。
- **结论**：行为正确，不修（不值得为改名牵动所有调用点）。

### F39 — WebAbility 8 个窗口监听器从不 off
- **核实**：这些监听器全部注册在**本实例自己的** windowStage 主窗口对象上。specified 模式下每个 Ability 实例拥有独立窗口，实例销毁窗口随之销毁；不存在"旧监听器挂在存活对象上派发幽灵事件"的路径。
- **结论**：不修。

### F40 — startUri 的 replace("file://docs/","file:///") 截断
- **核实**：`String.replace` 字符串参数形式只替换**第一处**（replaceAll 才是全量）。vault 路径出现第二处 `file://docs/` 属构造性场景；语义等价于 startsWith+slice。
- **结论**：无可观察缺陷，不修。

### F41 — 手机分支缺 pushSafeAreaInsets/forceFullscreenWindow
- **核实**：`deviceTypes` 不含 phone，产品不支持手机；且 touch-mode 文件写入对 phone 有独立分支。审计自己也在文中承认是"将来开放手机支持"的假设。
- **结论**：不修。

### F49 — EngineFlags.cachedFlags 永不失效
- **核实**：flags 只在浏览器启动时被 `buildArgs` 消费一次，进程生命周期内本就该冻结（Chromium 命令行启动后不可变）。"OTA 后不杀进程取不到新值"与消费模型一致。
- **结论**：不修。

### F50 — notifyAppBackground 在 foregroundWindows=0 时仍 keepScreenOn(false)
- **核实**：`notifyAppBackground` 有 `if (foregroundWindows > 0)` 递减保护；归零后 `keepScreenOn(false)` 只是清除一个本就不存在的 keep 标志——`setWindowKeepScreenOn(false)` 幂等无害。"另一个窗口活跃时屏幕变暗"不成立：count 归零意味着没有前台窗口。
- **结论**：不修。

### F51 — isOnBatteryPower 读模块加载快照
- **核实**：`batteryInfo` 默认导出是系统服务的**实时同步单例**（SDK d.ts：const 字段随系统状态更新），不是模块加载时的静态快照；充电状态变化由 OnPowerStateChanged 事件另行推送引擎。
- **结论**：不修。

### F56 — previewReceiver 硬编码 320×240
- **核实**：属实，但 `getPreviewSurfaceId` 引擎绑定**无任何分辨率参数**可传（见 MediaAdapterBind），当前调用面无法表达"请求其他分辨率"。
- **结论**：无可修的调用路径，不修。

### F57 — SetContextMenu 先 update 后赋 rightMenuCallback
- **核实**：`updateStatusBarMenu` 是异步发起、`this.rightMenuCallback = callback` 在同一同步块内完成赋值；任何点击事件都不可能在当前同步执行结束前派发。
- **结论**：不修。

### F60 — I18nAdapter 不订阅 COMMON_EVENT_LOCALE_CHANGED
- **核实**：属实，但 `NativeContext` 接口（即闭源 libelectron.so 的绑定面）没有任何语言变更回调可调，应用侧无法把 locale 变更推给引擎。这是引擎能力缺口，不是适配器疏漏。
- **结论**：主体不修；Pattern B 相关的"重复注册前不注销"已顺手修复。

### F68 — AccessibilityAdapter 空壳
- **核实**：属实，但这是**未实现的功能**而非功能 Bug：`speech`/`shutDown` 显式标注 NOTIMPLEMENTED，引擎侧无对应绑定调用面。补齐需要原生引擎支持（闭源）。
- **结论**：超出本次修复范围，记录在案。

### F70 — CHANGES-2026-09.md 两个"第 27 轮"
- **核实**：文档 1107 行已有明确编号说明（"因并行会话出现两节'第 27 轮'……编号冲突按历史原样保留"），且历史轮次号被大量交叉引用，改号反而制造新歧义。
- **结论**：不修（审计者漏看了该说明）。

## 跨切面 Pattern A-H 核实结论

| Pattern | 结论 |
|---------|------|
| A. removeProxy 漏路径 | 部分属实 → F2/F36/F37 已修。审计多列的 SubWindowAdapter（从不 addProxy，无可移除之物）不成立 |
| B. 监听器只 on 不 off | 逐项核实：WebAbility 8 个监听器（不修，见 F39）、WebEmbeddedAbility（不修，session 级对象随 session 释放）、registerKeyObserver（已修 F13）、I18n 覆盖（已修）、BLE discovery（已修 F52b）、Media imageArrival（已修 F55）；DisplayAdapter/DeviceAdapter/PowerMonitor 为进程级单例订阅，生命周期=进程，无泄漏路径，不修 |
| C. file://docs URI 转换不一致 | 定向修复：F28（getPrivacyDownloadDir 改 environment API）、F29（trash 候选补全）；FilePicker/StringUtil 的 `uri.path` 语义（docs authority 由系统 fileUri 服务解析）为 HarmonyOS 正确用法，不改 |
| D. 单例 mutable state 跨窗口共享 | 通知/剪贴板/打印列表均为应用级单例语义（通知本来就是 app 级），不属于缺陷；Battery 见 F61；FontAdapter 的 getter 缓存行为正确 |
| E. JSON 深拷贝丢字段 | 不属实：StatusBarManager.processData 的输入源就是 `JSON.parse(menu_model)` 的纯数据（无 Date/Map/Set），round-trip 无损 |
| F. 错误路径不回调 | 已修：F32（权限确认）、F63（getRawDescriptor）、F53（人脸 detect）、F64（OCR 签名）；其余调用点逐一核对均有回调或布尔/错误返回 |
| G. 文本补丁对 minify 脆变 | 已修：F25（verify-asar 补两处关键校验）+ F24（refresh 脚本缺标记即中止）；配合上游重混淆时的显式失败路径 |
| H. @LogMethod 对 async 方法日志无效 | 属实 → LogDecorator 重构：抽取 `wrapLogged` 共用，Promise 返回值经旁链 `.then/.catch` 记录 settle 值/拒绝原因（`out(promise) =>` / `rejected =>`），不改返回的 promise 本体 |

## 构建验证

- `web_engine` HAR（hvigor assembleHar，ArkTS 严格模式）：**BUILD SUCCESSFUL**（修复过程中先暴露并清掉了 11 个既有编译错误：CommonInterface 缺 BatteryInfo/OcrAdapterImage/PowerMonitor 声明、TextWord 缺失、PasteBoard URI 类型、字体 Promise null 回调、BLE forEach undefined key——均已修复，属于审计未覆盖的真实潜伏问题）。
- `electron` 模块 CompileArkTS：**BUILD SUCCESSFUL**。
- `node --check` 松散 main.js：通过。
- `refresh-app-patch.mjs` 重打 asar + `verify-asar.cjs` 全部 marker（含新增 3 项）：通过。
- `update-obsidian.mjs` 以当前 1.13.7 目标跑通（already up to date 路径）。

## 遗留说明

- 修复均未引入新的跨模块 API 变更；`SubWindowCancelToken`、`BatteryInfo`、`OcrAdapterImage`、`PowerMonitorContext` 为纯增量接口定义。
- 真机回归重点：弹窗反复开关（F2/F4）、PC 模式浮窗尺寸（F33）、退出时未保存笔记 flush（F10）、触屏/桌面切换（F26）、OAuth 登录回调（F22）、另存为多格式（F31）。
- 华为云同步（F5/F6）按用户决定不修，相关代码已随第 65 轮移除。

---

## 附录 A：真机崩溃分析（SIGTRAP @ libelectron.so，LastFatalMessage: OHOS.IDisplayManagerAgent）

**现象**（MatePad Air，1.2.1，进程存活 111s，前台）：关闭应用后立刻重启时进程崩溃。

**Faultlog 关键事实**：
- 崩溃信号 `SIGTRAP(TRAP_BRKPT)`，故障线程 `OS_IPC_4`（系统 binder 线程），栈顶两帧全部在闭源 `libelectron.so` 内，第三帧才是系统的 `DisplayManagerAgentStub::OnRemoteRequest`（libdm.z.so）——即引擎自身注册的显示代理在派发系统通知时命中引擎内部 CHECK（`LastFatalMessage` 是 IPC 接口描述符字符串）。
- 主线程（51160）与 `CrBrowserMain`（51366）都阻塞在 libelectron.so 同一地址（0x50e1b6c）的 `pthread_mutex_timedlock` 上——引擎内部锁 convoy。

**日志尾部 hilog 还原的完整时间线**：
| 时刻 | 事件 |
|------|------|
| 12:36:35.951 | 窗口 id=172 分离（用户关闭最后一个窗口） |
| 12:36:36.471 | AMS prepare terminate → `WebAbility.onPrepareToTerminate`（sync call）→ 返回 true（TERMINATE_IMMEDIATELY） |
| 12:36:36.625 | **重启的 want 进入** → `ScheduleAcceptWant` → `onAcceptWant` → 引擎 `kGetLastActiveWidget(is_sync=1)` 同步调用 |
| 12:36:39.627 | 引擎 `BrowserAdapter::ExecuteCommand Wait timeout`（3 秒无人应答——浏览器正在退出）；XCollie 记录 `MainThread:AcceptWant 3007ms` |
| 12:36:39.641 | 引擎报 "The browser process has exited"；`~Display` 析构 |
| 12:36:39.663 | **SIGTRAP**：DisplayManagerAgent 派发在显示对象销毁瞬间命中引擎 CHECK |

**根因链**：关闭最后窗口 → 立即重启的 want 路由进正在销毁的实例 → `onAcceptWant` 对正在退出的引擎发起**同步** `kGetLastActiveWidget` 查询 → 引擎主线程被 native 等待占住 3 秒（与 CrBrowserMain 形成锁 convoy）→ 浏览器退出、显示对象析构与 agent 派发在锁竞争窗口内相撞 → 引擎内部 CHECK 陷阱。

**归属判定**：
- 陷阱本身在闭源引擎内部（无源码可修），且 `onAcceptWant` 的同步查询是上游代码；
- 但**主线程 3 秒阻塞是 ArkTS 侧可控的 aggravator**，且"终止中重启"是正常用户操作路径。

**修复（本轮）**：
1. `GlobalThisHelper` 新增 `markTerminating()/isTerminating()/markAlive()`（进程级标记）；
2. `WebAbility.onPrepareToTerminate`：当关闭的是最后一个窗口（`getProxyCount() <= 1`，此刻本窗口代理尚未注销）时标记 terminating；
3. `WebAbilityStage.onPrepareTermination`（App 级退出路径）同样标记；
4. `WebAbilityStage.onAcceptWant`：terminating 状态直接快速路径返回 `browser1`（与冷启动一致的答案），跳过同步 native 查询；其余路径的 native 查询包 try/catch 兜底；
5. `WebAbility.onWindowStageCreate`（addProxy 后）调用 `markAlive()` 清除陈旧标记，保证后续重启恢复"上次活跃窗口"的能力不受影响。

**验证**：web_engine HAR 重建通过。

**残余风险与复测指引**：引擎侧 agent 派发的 CHECK 无法从应用层根除；若崩溃复现，抓取 hilog（过滤 `DMS`、`WMSSub`、`WebEngine`、`Adapter` 标签）并记录关闭→重启的操作间隔，确认主线程不再出现 `MainThread:AcceptWant` 3 秒阻塞（XCollie）。若引擎在无主线程阻塞的情况下仍触发该 CHECK，则属纯引擎缺陷，需上游（libelectron.so 提供方）跟进。
