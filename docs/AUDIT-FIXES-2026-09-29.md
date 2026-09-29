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

## 待续

F14-F32（输入/IME/拖拽/补丁脚本/文件系统）、F39-F41、F49-F70 及跨切面 Pattern A-H 的核实与修复见后续批次章节。
