# OHSidian 修改与审查登记(2026-09)

本文档登记本 fork 相对上游(HanversionOvO/OHSidian @ 9d76ec6)的全部修改:
**第一部分是 Commit 计划**(每个逻辑单元对应一条建议的 commit),
**第二、三部分是变更详情**,**第四部分是全量代码审查报告**,**第五部分是安全评估**。

> 一键回滚基线:`git stash` 或 `git checkout -- <path>`;asar/二进制走 LFS。

---

## 一、修改登记表(Commit 计划)

| # | 建议 commit message | 涉及文件 | 目的 |
|---|---------------------|----------|------|
| 1 | `feat(kernel): upgrade Obsidian 1.12.7 -> 1.13.7 (signed, verified)` | `web_engine/.../app/obsidian.asar`、`app/package.json`、README×2 | 内核升级;官方 SHA256+RSA 双校验通过 |
| 2 | `revert(tablet): keep system status bar visible (immersive experiment dropped)` | `WebAbility.ets`(移除布局全屏/隐藏状态栏/双通道隐藏/PC 模式恢复栏)、`pages/Index.ets`、`pages/WindowNode.ets`(移除 expandSafeArea)、`WebWindow.ets`、`WebWindowNode.ets`(移除平板整窗合成) | 第 2/9/10/12 轮的隐藏状态栏尝试全部回退(用户决定保留状态栏):系统栏交还系统管理;启动强制回全屏改用 `maximize(FOLLOW_APP_IMMERSIVE_SETTING)`(铺满但保留栏);第 17 轮最终态:布局全屏(背景延伸至栏下)+ 真实 insets 经 mode 文件下发渲染层做内容避让,详见第 15/17 轮 |
| 3 | `feat(touch): auto-follow system mode + manual toggle command` | `scripts/update-obsidian.mjs`(asar 注入 v4:模式文件同步 + 安全区清零)、`WebAbility.ets`(writeTouchModeFile) | 平板正常模式→移动布局,PC 窗口模式→桌面布局,2in1 永远桌面;命令面板三档开关(自动/触摸/桌面),override 持久化;清零 emulate-mobile 模拟刘海(59px),修触摸模式顶部留白,详见第 12 轮 |
| 4 | `feat(touch): tunable engine flags (touch slop / scale factor)` | `utils/EngineFlags.ets`(新)、`app/ohsidian-flags.json`(新)、`components/WebWindow*.ets`×3 | 触摸容差可调,修"按钮触发范围极小";界面缩放可调;改 JSON 即可调参无需改码 |
| 4b | `feat(deeplink): register obsidian:// scheme for OAuth callbacks` | `electron/src/main/module.json5`、`WebAbility.ets`、`scripts/update-obsidian.mjs`(asar 深链桥)、`scripts/cert-obsidian.pem`(新) | 坚果云/Remotely Save 等浏览器 OAuth 登录后,`obsidian://` 回调能直接唤起应用并送达插件回调,详见 2.5 |
| 5 | `fix(window): correct drawable rect computation (double left subtraction)` | `WebAbility.ets`×3 处、`SubWindowAdapter.ets`(adjustBounds top/left 笔误)、`AppWindowAdapter.ets`(setBounds/createWindow 高度边框混加 `+leftBorder`,上游遗留,改对称 `+topBorder`) | PC 窗口模式下引擎收到的视口尺寸错误;带边框窗口尺寸错误 |
| 5b | `fix(viewport): tablet immersive bounds + first-launch viewport settle` | `WebAbility.ets`、`WebWindowNode.ets` | ①沉浸式设置前移到 loadContent 之前(引擎启动时自查系统避让区,隐藏必须先完成,否则触摸模式顶部留白一条状态栏高度)②平板全屏按整窗上报边界(PC 模式浮窗保持避让;判定放宽为 `!pcModeEnabled`,防设备类型上报异常)③`repushViewportBounds()`:首启 600/1500/3000ms 补推边界(修"首次启动只显示左上角")+ **PC 模式切换后 500/1500ms 再补推**(修切换后视口残留旧偏移 ≈1cm 留白)④`setWindowSystemBarEnable([])` 第二隐藏通道⑤error 级诊断日志(设备类型/避让区/补推值)⑥第 13/15 轮重构(以第 15 轮最终态为准):视口合成统一 `computeViewportBound`(原 4 处重复,固定 drawableRect 语义)、`settleViewportLater` 去重定时器、新增 `avoidAreaChange` 监听重推视口(官方推荐)、消解遮蔽 `window` 模块的局部变量;沉浸式设置与 PC 模式恢复栏已随第 15 轮回退删除 |
| 5c | `fix(viewport): start browser only after XComponent surface has real size` | `utils/SurfaceReady.ets`(新)、`components/WebWindow.ets`、`components/WebWindowNode.ets` | 引擎只在浏览器启动时读一次 surface 尺寸,onLoad 直接 runBrowser 会在首帧布局前查到 0×0(日志实锤 `Get xcomponent surface size success:0 0`),渲染视口退化 → 冷启动铺不满。SurfaceReady 轮询 surface 真实尺寸(50ms×100,超时兜底)后再启动;并统一主窗口(WebWindow)与新建窗口(WebWindowNode)两条路径的初始尺寸语义(第 15 轮定为 drawableRect 直传)。详见第 14 轮 |
| 6 | `fix(crash): suppress benign destroyed-object IPC errors` | `scripts/update-obsidian.mjs`(asar main.js IPC 守卫)、`app/main.js`(uncaughtException 兜底) | 修用户实测的 `TypeError: Object has been destroyed` 错误弹窗 |
| 6b | `fix(compat): report Electron 28.2.3 past Obsidian 1.13 runtime gates` | `scripts/update-obsidian.mjs`(asar 注入) | 引擎 shim 把 Electron 上报为旧版本;1.13.7 主进程门(<18,文本级 bypass)与渲染层门(≥28.2.3,运行时 Object.assign 整体替换)双重拦截导致弹"Manual update required";注入脚本带结果校验,匹配失败显式告警 |
| 7 | `fix(pasteboard): implement missing StringUtil.filterFileDocs` | `utils/StringUtil.ts`、`PasteBoardApadter.ets` | 调用了不存在的方法(编译/运行必炸);顺带过滤非 file URI |
| 8 | `fix(ble): null-deref crashes, listener dedup, missing catch` | `BluetoothLowEnergyAdapter.ets` | writeDescriptor/createCharacteristic/createDescriptor 缺 return 崩溃;通知监听去重;getServices 补 catch |
| 9 | `fix(adapters): harden error handling (JSON parse, null refs, lost callbacks)` | `DialogAdapter.ets`、`ElectronAppAdapter.ets`、`DeviceAdapter.ets`、`PermissionManagerAdapter.ets`、`SpeechAdapter.ets`、`OcrAdapter.ets`、`IMFAdapter.ets`、`SubWindowAdapter.ets`、`NotificationAdapter.ets`、`ContextPathAdapter.ets`、`AppLifecycleAdapter.ets`、`common/DragParamManager.ets`、`common/InjectModule.ets` | 渲染端畸形输入不再抛未捕获异常;失败路径必回调不再挂死;IMF off 后可重新挂载;OCR PixelMap finally 释放 |
| 10 | `fix(leaks): fds, timers, common-event subscribers, pixelmaps` | `PrintAdapter.ets`、`CloudSyncAdapter.ets`(轮询单例化+fd)、`WebAbility.ets`(mode 文件 fd)、`BatteryAdapter.ets`、`ScreenlockMonitorAdapter.ets`、`NetConnectionAdapter.ets` | 重复注册/打开导致的泄漏;云同步轮询从"每窗口一个"收敛为"全应用一个" |
| 11 | `security(sync): sanitize cloud paths (traversal) + scheme allowlist for openExternal` | `CloudSyncAdapter.ets`、`ExternalProtocolAdapter.ets` | `..` 无法穿越到其它用户云端前缀(含 listCloudFiles);外部拉起仅允许 http/https/mailto/tel/obsidian |
| 12 | `security(main): remove dead updater and unverified asar side-load` | `app/main.js`(-290 行) | userData 侧载无签名校验=持久化代码执行面;死更新器含遥测;一并解决"手动检查更新无反馈"(stub 仍发 check-end) |
| 13 | `security(logs): keep secrets out of hilog + login state check` | `CertManagerAdapter.ets`、`BluetoothAdapter.ets`、`CloudSyncAdapter.ets`、`QuickLoginButtonComponent.ets` | 证书口令/PIN/unionId 不再进日志;华为登录回读 state 防 CSRF;删除未用导入 |
| 14 | `chore: pin reflect-metadata to locked 0.2.1` | `web_engine/oh-package.json5` | ^0.1.13 与锁文件 0.2.1 不一致,消除 0.x caret 跨次版本风险 |
| 14b | `fix(subwindow): report failures, destroy dead windows, size empty requests` | `SubWindowAdapter.ets` | ①createSubWindow/loadContent/showWindow 失败路径此前不回调,渲染层永久挂死,现统一回调 false 并销毁死窗口②触摸模式(移动布局)请求子窗口时尺寸传 0×0 → WMS 挂载超时"管理仓库"不可用(日志铁证 `UpdateViewportConfig: invalid width: 0, height: 0`);现改用父窗口矩形(兜底 800×600)并打 WARN |
| 14c | `chore(diag): log engine setBounds requests and actual window rects` | `AppWindowAdapter.ets` | 引擎主进程会主动 setBounds(桌面版恢复窗口位置行为),在全屏窗口被系统拒绝(1300010 + `window should not move`);打印请求矩形 + 实际 windowRect/drawableRect(error 级),用于归因视口留白 |
| 14d | `perf(trash): vault-rename first, native trash as fallback` | `app/main.js` | 原生 shell.trashItem 返回成功但文件未删,原顺序每次删除固定卡 3 秒(轮询等待)后才兜底;现 Vault 内文件直接改名进 `.trash`(瞬时,Obsidian 回收站可找回),Vault 外路径才走原生 trash(等待缩短至 1s) |
| 14e | `fix(viewport): expand engine surface into the status bar safe area` | `pages/Index.ets`、`pages/WindowNode.ets` | API 24 平板 `setWindowLayoutFullScreen` 不被支持(WMS "device not support"),surface 默认避开状态栏 → 触摸模式顶部留白;根容器加 `expandSafeArea(SYSTEM/TOP)` 组件级延伸,不依赖被限制的窗口级 API |
| 15 | `docs: change log, env guide, review & security report` | `docs/`、`build-profile.example.json5`、`.gitignore` | 本文档;API 24 提升说明;构建工具忽略项 |
| 16 | `perf(power): foreground-gate cloudsync poll, keep-screen-on guard, geolocation dedup, log truncation` | `adapter/CloudSyncAdapter.ets`、`ability/WebAbility.ets`、`adapter/RunningLockAdapter.ets`、`adapter/GeolocationAdapter.ets`、`common/LogDecorator.ts` | 耗电专项(第 27 轮):登录轮询仅前台运行;最后一个窗口退后台强制清 keepScreenOn;GNSS 订阅去重;日志序列化异常防护+截断 |
| 17 | `perf(power): disable dormant cloudsync login-trigger poll (no writer in 1.13.7 kernel)` | `adapter/CloudSyncAdapter.ets`、`ability/WebAbility.ets` | 耗电追问(第 28 轮):确认触摸/窗口模式链路为事件驱动;发现 `.hcs-login-pending` 在 1.13.7 内核下无写入方,3s 死轮询停用(恢复路径注释在案) |

> asar 的四处注入(触屏模式命令、IPC 守卫、深链桥、Electron 版本 shim)由 `scripts/update-obsidian.mjs` 在每次升级内核时自动重放,不手工维护。
> ⚠️ `web_engine/BuildProfile.ets` 是 hvigor 构建生成文件(DEBUG 标志随构建模式翻转),**不要跟随功能提交**——提交前 `git checkout -- web_engine/BuildProfile.ets` 还原,或单独一次性 chore 提交。

---

## 二、功能与内核变更详情

### 2.1 Obsidian 内核 1.12.7 → 1.13.7

- 官方 `obsidian-1.13.7.asar.gz`,SHA-256 哈希 + 官方 RSA-SHA256 签名均通过(证书与官方更新器一致)。
- ⚠️ 闭源中间层(libelectron.so,内嵌 Chromium 132)按 1.12.7 验证,1.13.7 **必须装机实测**;
  回滚:`git checkout -- web_engine/src/main/resources/resfile/resources/app/`。
- 上游 4 个月未发新版中间层(最后提交 2026-06-01,仅一个 release),升级内核是当下唯一可行的更新路径。

### 2.2 平板状态栏自动隐藏

`deviceInfo.deviceType === 'tablet'` 时 `setSpecificSystemBarEnabled('status', false)`;
手机与 2in1 PC 模式不受影响。

### 2.3 触屏模式跟随系统 + 手动开关

```
ArkTS (WebAbility)                          Obsidian 渲染进程 (app.js 补丁 v5)
deviceType + window_pcmode_switch_status → 写 <userData>/ohsidian-mode.json
{ systemMode: touch|desktop,               启动时 + 每 5s 轮询;override=auto 跟随系统,
  override: auto|touch|desktop,             touch/desktop 强制;变更时切 EmulateMobile 后重载一次
  insets: { top, bottom } }                 真实系统栏避让区(CSS px),avoidAreaChange 时刷新,
                                            渲染层作 body 内联 CSS 变量(背景延伸/内容避让)
```

| 场景 | 布局 |
|------|------|
| 平板·正常模式 | 触屏(移动)布局 |
| 平板·PC 窗口模式 | 桌面布局 |
| 电脑(2in1) | 永远桌面 |

命令面板:**"OHSidian: 切换触屏模式 (自动 → 触摸 → 桌面)"**;`override` 持久化。

### 2.4 触摸参数(修"按钮触发范围极小")

引擎为 Chromium 移植,支持 `--touch-slop-distance` / `--force-device-scale-factor`
(已在其二进制开关表中确认)。`ohsidian-flags.json` 当前默认 `touchSlopDistance: 16`,
难按就调大(8~48);界面偏小可试 `forceDeviceScaleFactor: 1.25/1.5`。hilog 过滤 `EngineFlags` 验证生效。

### 2.5 obsidian:// 深链注册(坚果云/Remotely Save 浏览器登录回调)

**问题**:浏览器 OAuth 登录(坚果云、Remotely Save 等插件的授权流程)完成后,
浏览器会跳转 `obsidian://...` 回调网址,但应用从未注册该 scheme,
系统不会唤起 OHsidian,登录流程卡死在浏览器。

**实现**(三层配合):

1. **scheme 注册**(`electron/src/main/module.json5`):EntryAbility skills 新增
   `uris: [{"scheme": "obsidian"}]` —— 系统从此把 OHsidian 列为 `obsidian://` 的打开方式;
2. **ArkTS 接收**(`WebAbility.openNewWindow`):运行中收到 `obsidian://` 深链时
   **不**开新窗口(会出空白窗),而是追加写入 `<userData>/ohsidian-protocol.json`
   (带时间戳,保留最近 5 条);
3. **引擎内分发**(asar main.js 注入的深链桥):每 1.5s 轮询该文件,
   把新 URI 喂给 Obsidian 主进程自己的协议处理管线
   (`app` 的 `open-url` / `second-instance` 监听器,与桌面版行为一致),
   由 Obsidian 路由到插件的 `registerObsidianProtocolHandler` 回调,已处理的条目从文件移除。

**行为**:应用在后台/前台时,浏览器登录完成 → 系统弹出/直接唤起 OHsidian → 回调送达插件。
应用完全未运行时走冷启动路径(URI 经启动参数进引擎,上游既有设计)。

**防重放**:深链桥只处理时间戳晚于自身启动时间的条目(冷启动经 argv 处理的 URI 不会二次分发);
写入侧仅保留最近 5 条,文件被清空/损坏时自动重建。

### 2.6 targetSdkVersion 提升到 API 24(评估结论)

API 22=6.0.2(现)/API 23=6.1.0/API 24=6.1.1(需 DevEco 6.1.1)。
`build-profile.example.json5` 已注释写法。**建议**:先用 22 装机跑通,再单独改 target 24 回归
(中间层按 22 验证,勿一次引入两个变量)。

---

## 三、用户实测崩溃修复(Object has been destroyed)

根因:Obsidian 主进程几十个 `ipcMain.on` 处理器用 `BrowserWindow.fromWebContents(t.sender)`
取窗后直接操作;窗口销毁瞬间 IPC 仍在处理(登录/开关 Vault 高发)即抛错。

双层修复(版本无关):
1. asar `main.js` 顶部注入 IPC 守卫:`ipcMain.on/once/addListener/handle` 全部包裹,
   命中 "Object has been destroyed" 记日志并吞掉;
2. wrapper `main.js` 的 `uncaughtException` 对该类错误静默(写 obsidian.log),不再弹框。

---

## 四、全量代码审查报告(2026-09-25)

方法:3 个并行审查代理通读 web_engine 全部适配器/基础层 + electron 模块/配置(约 17.6k 行),
人工复核安全关键项。共记录 50+ 项,**修复 34 项**,其余登记在案(见 4.2)。

### 4.1 已修复(按文件)

| 文件 | 修复内容 |
|------|----------|
| `utils/StringUtil.ts` | **实现缺失的 `filterFileDocs`**(原代码调用不存在的方法,粘贴板含 URI 即炸);仅接受 file/docs scheme,异常返回空串 |
| `adapter/PasteBoardApadter.ets` | 调用处过滤空路径,非文件 URI 不再塞进结果 |
| `adapter/BluetoothLowEnergyAdapter.ets` | ①writeDescriptor 缺 return(空引用崩溃)②createCharacteristic ③createDescriptor 同型崩溃;④通知监听按设备去重(原来一条通知回调 N 次)+ 退订清理;⑤getServices 补 catch |
| `adapter/PermissionManagerAdapter.ets` | checkAccessTokenSync 异常分支缺 return → 同一次检查双回调(false+true),已加 return |
| `adapter/SpeechAdapter.ets` | `extraParams` 可选字段非空断言改为显式判空(undefined 时 TTS 直接失败) |
| `adapter/OcrAdapter.ets` | PixelMap 释放移入 finally(原来失败分支泄漏整图内存) |
| `adapter/IMFAdapter.ets` | offListenIME 未复位 `IMEonListen` → 之后软键盘输入永久失效,已复位 |
| `adapter/DialogAdapter.ets` | 三处 `JSON.parse(settings)` 无防护(渲染端畸形输入直接抛);messageBox 查不到 parent 时回调丢失(渲染端挂死)——均已修复,失败走取消回调 |
| `adapter/ElectronAppAdapter.ets` | `getDisplayByIdSync` 对非法 id 抛异常而非返回空,原判空形同虚设;补 try/catch 兜底 |
| `adapter/DeviceAdapter.ets` | USB 事件数据 JSON.parse 未捕获(公共事件回调里抛未捕获异常) |
| `adapter/SubWindowAdapter.ets` | ①adjustBounds 用 `drawableRect.left` 加到 top(与 SystemFloatingWindow 对照确认是笔误)②addReuseWindow 判空缺 return |
| `adapter/NotificationAdapter.ets` | 通知先入队后鉴权:未授权时请求滞留,之后授权成功会把陈旧通知全部发出来;改为授权后再入队 |
| `adapter/ContextPathAdapter.ets` | `documentSaveResult[0]` 空数组时 `uri.replace` 抛 TypeError |
| `adapter/AppLifecycleAdapter.ets` | terminateSelf 无 catch(unhandled rejection) |
| `common/DragParamManager.ets` | ①拖拽兜底路径 `/storage/User/` → `/storage/Users/`(拼写错,下游 IO 必失败)②bookmark/webCustom buffer 判空(缺省时 TypeError)③summary JSON.parse 包 try/catch |
| `common/InjectModule.ets` | `getOrCreate` 的 `finally{return}` 会吞异常并静默替换错误结果,重构为 try/catch 直接返回 |
| `adapter/PrintAdapter.ets` | 打印文件 fd 从不关闭且列表只增(多次打印后 fd 耗尽);新增 closePrintFiles,打印结束/取消/失败统一关闭并清空 |
| `adapter/BatteryAdapter.ets` | 重复注册覆盖 subscriber 不退订(监听器泄漏+回调重复);重订阅前先退订 |
| `adapter/ScreenlockMonitorAdapter.ets` | 同上;stop 后置空,可安全重启 |
| `adapter/NetConnectionAdapter.ets` | ①CommonEvent 订阅泄漏;②unregisterAll 不退订 CommonEvent、不复位 `registered` → 之后网络事件永久失联;均已修 |
| `adapter/CloudSyncAdapter.ets` | 见安全评估 5.2(路径穿越、fd、日志、轮询单例化) |
| `ability/WebAbility.ets` | ①云同步 3s 轮询从"每个窗口一个永不清理的 setInterval"改为适配器单例持有一个;②writeTouchModeFile 的 fd 放入 try/finally;③mode 文件 JSON 解析非对象时兜底 |
| `electron/.../QuickLoginButtonComponent.ets` | 见安全评估 5.2(state 校验、死导入) |
| `app/main.js`(wrapper) | 见安全评估 5.2(死更新器/侧载移除等,-290 行) |

### 4.2 登记在案、暂不修改(需真机验证或产品决策)

| 位置 | 问题 | 不修原因 |
|------|------|----------|
| `AppWindowAdapter.ets:137/346/701` | createWindow/setBounds 的 Promise 无 catch;showHuaweiQuickLogin 失败不回调(登录挂起);loginWindow 双开竞态;边框补偿不对称(宽 +left×2、高 +top+left) | 核心开窗路径,改动需真机回归;涉及登录窗口与用户报的崩溃相关,建议下一轮带日志修 |
| `AppWindowAdapter.ets:225` | getWindowButtonVisibility 用 `\|\|`(任一可见即 true)语义存疑 | 需确认 Electron 语义后改 |
| `adapter/DeviceUserAuthAdapter.ets:122` | 生物认证 NOT_ENROLLED 时按成功放行(本地鉴权形同虚设) | 改 false 可能把未录入指纹的用户锁在 Vault 外,需产品决策 |
| `adapter/BluetoothLowEnergyAdapter.ets:307/277` | readCharacteristic 立即回旧值(真值从未回传);GetGattDevice 未 connect 不入表 | 需 BLE 真机验证 API 行为 |
| `adapter/FontAdapter.ets`、`MediaAdapter.ets`、`GeolocationAdapter.ets`、`FilePickerAdapter.ets`、`DisplayAdapter.ets`、`BluetoothAdapter.ets`(static 回调)、`PowerMonitorAdapter.ets` | 各自缺 try/catch 或重复注册泄漏;定位 1Hz 全功率耗电 | 低频路径,同型修复模式已建立,随下一轮批量处理 |
| `adapter/SubWindowAdapter.ets:74/209` | 窗口复用时 localStorage 中 id/callback 不更新(靠两端都认旧 id 自洽) | 现逻辑自洽,改动风险大于收益 |
| `common/LogDecorator.ts` | 所有 @LogMethod 全量 JSON.stringify 入参写 hilog(剪贴板/通知正文进日志;大参数双倍序列化) | 建议装饰器加长度截断+白名单脱敏,属横切改造,单独一轮 |
| `electron/.../QuickLoginButtonComponent.ets:453` | 《用户服务协议》《隐私协议》点击无跳转(合规硬伤) | 需产品提供正确 URL |
| `EntryAbility.ets:50` | initAgc fire-and-forget,冷启动立即登录可能未就绪 | 实测确认后再定 |

---

## 五、安全评估

### 5.1 总体结论

- 无硬编码密钥/私钥;登录凭证(authCode/idToken)未发现写日志;
- 无明文流量配置,硬编码 URL 均为 https;
- `build-profile.json5`、签名材料、agconnect-services.json 均正确排除在 git 之外;
- 权限清单存在**过度申请与配置失真**(见 5.3-R1),整体攻击面以"渲染进程完全可信"为前提设计
  (渲染进程有完整 Node 能力 + 248 个 JSBind 绑定无来源校验),社区插件即攻击面,属架构级现状。

### 5.2 已修复的安全问题

| # | 问题 | 修复 |
|---|------|------|
| S-A | **云端路径穿越**(高):`buildCloudPath` 不过滤 `..`,传 `filePath=../../<其它userId>/...` 可读写删其它用户云端对象 | 按 `/` 分段过滤 `.`/`..`/空段,空结果拒绝;upload/download/delete 三处调用点全部校验 |
| S-B | **未校验 asar 侧载**(中):启动时扫描 userData 加载 `obsidian-*.asar`,签名/哈希校验只存在于已禁用的下载路径——能写 userData 即可持久化主进程代码执行 | 移除侧载路径,只加载 HAP 内置 asar;更新一律走 HAP 重打包(scripts/update-obsidian.mjs) |
| S-C | **死更新器与遥测**(低):queueUpdate 无条件 return 使更新器 ~200 行不可达,但含持久设备 ID 遥测代码;每小时空转;手动"检查更新"无任何反馈 | 死代码整体删除;queueUpdate 保留为 stub 且仍发 `check-end`(UI 不挂);顺带 `uncaughtException` 吞 net::ERR 前先记日志 |
| S-D | **敏感信息进日志**(中):`installPersonalCert` 的证书库口令、`setDevicePinCode` 的 PIN 经 @LogMethod 全参明文进 hilog;unionId/openId 明文 | 三个敏感方法去装饰器/去明文渲染 |
| S-E | **openExternal 无 scheme 白名单 + FLAG_START_WITHOUT_TIPS**(中):渲染进程可静默拉起任意 URI handler | 仅放行 http/https/mailto/tel |
| S-F | **华为登录 CSRF 校验未闭环**(低):`authRequest.state` 生成后从未比对 | 回读比对(系统未下发 state 时跳过,兼容性优先) |
| S-G | **CertManager readFile** 无异常处理且 `OpenMode.CREATE` 可能意外创建文件 | try/catch/finally + 只读模式;fd 必关 |
| S-H | **hcs-user.json 写入 fd 泄漏** | try/finally 关闭 |

### 5.3 遗留风险与建议(按优先级)

| # | 风险 | 建议 |
|---|------|------|
| R1 | **权限清单过度申请**:`READ_PASTEBOARD` 为 `when:"always"`(后台读剪贴板)、LOCATION 三件套含后台定位(笔记应用无定位功能)、全部 usedScene 写着工程里不存在的 `FormAbility`(审核风险) | 装机验证通过后单独一轮:删 LOCATION_IN_BACKGROUND、READ_PASTEBOARD 降为 inuse、usedScene 改为真实 Ability。**不与本次改动混在一起**,避免权限变化干扰本轮回归定位 |
| R2 | EntryAbility `exported:true` + skills uris 为空:任意应用可携带任意 URI 拉起开窗(渲染进程有 Node 能力,风险放大) | 装机后确认 file-open 功能依赖,再收紧 uris(如 scheme 白名单/文件类型),并在 onCreate/onNewWant 入口加 URI 校验 |
| R3 | JSBind 暴露面:248 个绑定无来源校验(证书安装、任意路径 Trash、Relaunch 等) | 架构级;中期方案是高频敏感入口加调用方 token 校验 + TrashAdapter 限定 vault 前缀 |
| R4 | web_engine/module.json5 `definePermissions` 重声明系统权限 `ALLOW_WRITABLE_CODE_MEMORY`(JIT 需要) | 属错误用法(真正授权靠签名 profile ACL);上架前梳理 profile ACL 支撑,避免误删导致 Chromium JIT 失效,**需真机验证** |
| R5 | 闭源引擎内含 `--remote-debugging-port=9222` 字符串(content-shell 默认值,未证实启用) | 装机后 `hdc shell netstat` 验证;若真开了调试端口即为高危,需向原作者反馈 |
| R6 | agconnect-services.json(真实文件)若含 `client_secret` 会随 HAP 分发 | 构建前检查;HarmonyOS 侧 AGC 文件不应含 secret |
| R7 | LogDecorator 全参数落日志(剪贴板/通知内容) | 横切改造:装饰器加脱敏/截断(见 4.2) |

---

## 六、第二轮审查:对全部改动本身的五维审查(2026-09-25)

方法:人工逐项核对 + 独立对抗性代理通读完整 diff(排除二进制)。
五维结论:**必要性/正确性/安全性/代码质量/架构合理性**。

| 维度 | 结论 |
|------|------|
| 必要性 | 通过。每项改动对应一个实测 bug、明确需求或安全暴露面;`StringUtil.filterFileDocs` 一项实为修复 HEAD 上既有的编译断裂 |
| 正确性 | 通过(修复 5 项后)。逐个核对了缺 return 位置、回调语义(NotificationAdapter 先鉴权后入队与 Electron 语义一致)、CloudSync 净化不误伤正常路径(中文/空格/子目录/带点名字) |
| 安全性 | 通过(修复 2 项后)。新引入的文件通道与既有 `.hcs-login-pending` 先例同目录同模式,无新特权边界 |
| 代码质量 | 通过。fd 均在 finally、JSON.parse 均有防护、轮询自限(重试≤30s 自停)、失败可观测 |
| 架构合理性 | 通过。mode/protocol 两个 JSON 通道与项目既有"文件轮询"模式完全一致;flags 配置放只读 resfile 符合构建期配置定位;补丁注入由脚本自动重放,不产生手工维护面 |

本轮审查发现并修复(全部落地):

| # | 级别 | 问题 | 修复 |
|---|------|------|------|
| R-1 | 必须 | **CloudSync 净化漏了 `listCloudFiles`**:vaultName 裸拼接,`..` 仍可枚举其它用户云端前缀 | 复用 `sanitizeCloudSegment`,空则拒绝返回空列表 |
| R-2 | 高 | **wrapper main.js 三处修复静默未生效**(一次性 patch 脚本精确匹配失败且无校验):net::ERR 未记日志、trash 回退未加固、zlib 死导入残留——CHANGES 承诺未交付 | 手工补齐三处;删除危险的静默 no-op 脚本;顺带清理 `currentBaseVersion/currentPackageVersion` 死变量 |
| R-3 | 高(疑似) | **`@electron/remote` 未经 `enable(webContents)`**:渲染进程 remote 通道可能不可用 → 触屏模式/模式文件通道整体静默失效 | wrapper main.js 增加 `app.on('web-contents-created')` 中 `remote.enable(wc)`(幂等、失败仅告警);真机仍需验证 |
| R-4 | 中 | **ExternalProtocol 白名单误伤**:插件从应用内 `shell.openExternal('obsidian://…')`(Advanced URI、跳转 Vault)会被拦截 | 白名单加入 `obsidian` |
| R-5 | 中 | **深链桥用墙上时钟过滤,时钟回拨则深链永久失效** | 改为单调递增 seq + `lastDispatchedSeq` 游标,与系统时钟解耦 |
| R-6 | 中 | **深链 URI 整条入日志**(OAuth code/token 可能泄露到 hilog),与本次日志脱敏方针自相矛盾 | 只记 scheme+path,query 截断为 `?…` |
| R-7 | 低 | 触屏切换命令写文件失败时仍提示已切换(未持久化) | Notice 追加"(写入失败,重启后失效)" |
| R-8 | 低 | 深链桥 IIFE 无幂等守卫(重复注入会双轮询) | 加 `__ohsidianDeepLink` 守卫;触屏补丁 marker 升级 v3 |

审查确认通过、无需改动的关键点:IPC 守卫不破坏 Electron 语义(当前内核无按引用移除 ipcMain 监听的用法,升级 1.14+ 需复查);新增 1.5s/3s/5s 轮询每 tick 仅一次 stat/短读,总量可忽略;`@electron/asar` 打包流程无逻辑错误;两个 JSON 通道的读改写竞态窗口极小且两侧读取均容忍半截文件,接受。

遗留观察项(不修,真机验证):`EngineFlags` 瞬时读失败会缓存空结果直到重启(文件为构建期产物,影响可忽略);`PrintAdapter` 并发打印边角;`DialogAdapter` 失败回调用 `button_id=-1`(与渲染层取消语义对齐留待后续);main.js 中 `insider/disable/silence` 标志由 asar 主进程 emit 保留(供上游语义兼容)。

---

## 七、测试清单(装机回归)

1. **基础**:1.13.7 启动正常,`帮助 > 关于` 版本正确;
2. **崩溃修复**:反复 创建/打开 Vault、华为登录(此前崩溃场景)不再弹 "Object has been destroyed";
3. **状态栏**:平板全屏隐藏、顶缘下拉可呼出;PC 窗口模式行为正常;
4. **触屏模式**:平板模式自动移动布局 → 切 PC 窗口模式自动回桌面;命令三档切换持久化;
5. **触摸触发范围**:默认 slop=16 体感;不行调 `ohsidian-flags.json`(24/32/48);
6. **窗口尺寸**:PC 模式下新建子窗口/弹窗位置尺寸正确(drawableRect 修复的回归点);
7. **云同步**:登录后上传/下载/删除一个文件(路径穿越修复的回归点);
8. **粘贴**:跨应用复制文件/图片粘贴进 Obsidian(PasteBoard 修复的回归点);
9. **深链登录**:系统浏览器打开 `obsidian://remotelysave` 之类测试链接 → 应弹出/切换到 OHsidian;
   完整走一遍坚果云(或 Remotely Save)OAuth:浏览器登录完成后回调能自动送达插件
   (应用在后台与已关闭两种状态各测一次);
10. hilog 关注 TAG:`WebAbility`、`EngineFlags`、`CloudSyncAdapter`、`ExternalProtocolAdapter`。

---

## 八、真机实测记录(迭代日志)

### 第 1 轮(2026-09-25,MatePad Air / HarmonyOS 6.1.0.135)

**现象 1**:启动弹 "Manual update required - This version of Obsidian is no longer
supported" 并跳转浏览器,Obsidian 未加载。

**根因**(已在 asar 1.13.7 main.js 定位,证据确凿):
```js
var fo=process.versions.electron, bo=parseInt(fo.split(".")[0]);
if (bo<18) { showErrorBox("Manual update required", ...) }
```
1.13.7 新增"Electron 主版本 ≥18"运行时门槛;闭源引擎 shim 把
`process.versions.electron` 报成老版本(引擎内含 `Electron/5.0.0` 默认字符串)。
上游 1.12.7 无此检查,故未暴露。

**修复**:`scripts/update-obsidian.mjs` 的 MAIN_PROCESS_PATCH / TOUCH_MODE_PATCH
在 asar main.js 与 app.js 最前部把 `process.versions.electron` 覆盖为 `22.0.0`
(高于门槛、足够保守,不激活 Obsidian 面向更新 Electron 的功能分支),
仅当真实上报值 < 18 时才覆盖。

**现象 2**:弹窗后约 4 分钟,原生 SIGSEGV 崩溃(CrBrowserMain 线程,
libelectron.so 内,堆损坏特征)。**判断**:发生在"版本门拦截 → 主进程提前
半初始化退出"的异常状态之后,属引擎在退化路径上的次生问题;待版本门修复、
Obsidian 正常启动后观察是否复现,再决定是否深挖(闭源,只能凭日志)。

**风险提示**(登记在案):版本门槛存在的原因正是 1.13.7 可能使用引擎缺失的
新 Electron API。版本 shim 让它越过检查,但如果引擎 API 面确实不够,
可能出现启动后异常。备选方案(按序):`node scripts/update-obsidian.mjs 1.13.2`
逐级降版本试;或 `git checkout -- web_engine/.../app/` 回滚 1.12.7。

### 第 2 轮(2026-09-25):版本 shim 未生效,改为双保险

**现象**:重新构建安装后仍弹 "Manual update required"。

**分析**:第 1 轮的运行时方案是 `process.versions.electron="22.0.0"`(直接赋值)。
最可能失败原因:引擎的 `process.versions` 对象是只读/冻结的,非严格模式下对
只读属性的赋值**静默无效**(不抛错),所以 try/catch 与补丁都"看起来执行了"。
已核实 asar main.js 中该解析值(`bo`)全文件仅有定义+门槛判断两处消费。

**修复(双保险,已验证落地)**:
1. **文本级(确定性)**:注入时把 `bo=parseInt(fo.split(".")[0])` 改写为
   `bo=Math.max(parseInt(fo.split(".")[0]),22)` —— 无论引擎上报什么,门槛恒过;
2. **运行时(兜底)**:`process.versions` 改为整体替换
   (`process.versions=Object.assign({},process.versions,{electron:"22.0.0"})`),
   绕过对象本身只读的情况。
更新脚本对文本改写做了**结果校验并显式打日志**(吸取第 2 轮 patch 脚本静默
no-op 的教训),上游未来改版时若匹配不到会输出 WARNING 提示人工检查。

### 第 3 轮(2026-09-25):界面已能加载,剩两个问题已修

**进展**:主进程版本门已过,Obsidian 界面正常加载(第 1 轮的崩溃未再出现)。

**问题 1:右上角仍弹"需要进行一次较大的更新"通知。**
根因:渲染进程 app.js 内有**第二个更高的门槛**——常量 `Iie="28.2.3"`,
`Uy(vf,Iie)` 要求 Electron ≥ 28.2.3 才不显示该通知;我们之前只 shim 到 22。
且渲染层的 `process.versions` 同样可能只读,直接赋值会静默失败。

**修复**:两侧 shim 统一提升到 **28.2.3**(1.13.7 官方要求的最低 Electron,
与引擎 Chromium 132 同代);渲染层同样改为 `Object.assign` 整体替换。
主进程文本级门槛同步提至 28。

**问题 2:页面顶部有约 1cm 空白。**
根因:高度恰为状态栏高度——平板上我们隐藏了状态栏,但系统给引擎的初始
可绘制区域(drawableRect)仍带着状态栏避让偏移,引擎视口整体下移一条
状态栏的高度。此前 1.12.7 状态栏可见时该偏移被状态栏遮盖,不可见。

**修复**:
- `WebWindowNode.setDefaultBounds`:平板上向引擎上报的初始 drawableRect
  合成为整个窗口(0,0,全宽,全高);
- `WebAbility` 三处边界回调(windowSizeChange/windowRectChange/
  WINDOW_SHOWN):平板非 PC 模式时同样按整窗上报
  (`useFullWindowBounds()`,PC 模式浮窗保持装饰区避让行为)。

### 第 3 轮结果与第 4 轮排查(2026-09-25)

**更新通知**:已消失(渲染层 28.2.3 门槛修复生效)。

**顶部留白**:仍在。新线索:PC 窗口模式**无**留白,平板全屏模式有 →
引擎很可能是**自行向系统查询避让区**,而非使用我们上报的边界,
文本级边界合成无法覆盖。已加两类措施:
1. 追加第二种隐藏 API `setWindowSystemBarEnable([])`(与
   `setSpecificSystemBarEnabled('status',false)` 双管齐下,可能促使避让区塌陷);
2. 注入诊断日志:启动 2 秒后输出 windowRect/drawableRect/系统避让区实际值,
   用于定位留白来源(引擎自查 or 系统未塌陷)。

**切换问题**:加了两处健壮性(观察器注册失败时改为直读设置值一次;
touch mode 日志输出 override 当前值)。待用户反馈具体现象 + hilog。
另:若手动切换命令曾把 override 切到"触摸/桌面",自动跟随即被关闭——
需循环切回"自动"才会重新跟随系统模式(设计如此,但易踩)。

**问题 3:平板全屏模式首次启动视口只占左上角,右/下留白;二次启动正常。**
典型"错过 resize"模式:首启窗口先小尺寸创建再最大化,引擎在 surface 就绪前
错过了 windowSizeChange,视口被钉在初始小尺寸;二次启动系统直接按全屏创建。
**修复**:loadContent 后 600/1500/3000ms 三次主动补推当前窗口边界
(`OnWindowSizeChange`),并打 `re-pushed viewport bounds` 日志。

**留白根因确认(第 4 轮,代码考古)**:`app.css` 的 `:root` 将
`--safe-area-inset-top` 定义为 `env(safe-area-inset-top)`(引擎把系统避让区
注入该 CSS 环境变量);桌面路径 app.js 会无条件把它清零,所以 PC/桌面布局
无留白;触摸模式(移动布局)下留白来自**引擎在启动时自行查询的系统避让区**
——而我们的隐藏调用原本发生在 loadContent 之后,引擎查询时栏还没隐藏完。

**修复**:把全部沉浸式设置(`setWindowLayoutFullScreen` /
`navigationIndicator` 隐藏 / 平板状态栏隐藏 / `setWindowSystemBarEnable([])`)
从 loadContent 回调**前移到 onWindowStageCreate 里加载内容之前**,
确保引擎启动查询避让区时状态栏已经隐藏。诊断日志与边界补推保留在回调中。

**问题 4:触摸模式下"管理仓库"无法使用。**
日志特征:走子窗口复用路径(`reusableWindow browser4`)后,WMS 报
`window attach state timeout`——子窗口未挂载到窗口场景,内容渲染不出来。
注意 `size 0` 是复用缓存列表长度而非窗口尺寸(日志语义易误导)。
**已修**(确定性部分):SubWindowAdapter 所有失败路径(createSubWindow /
loadContent / showWindow 失败)此前不回调导致渲染层永久挂死,现统一回调
false 并销毁死窗口。**触摸模式下复用窗口挂载超时的具体根因待定位**,
需要:从点击"管理仓库"那一刻起的完整 [WebEngine] 日志(复用之前的
首次创建过程),以及"无法使用"的具体表现(空白窗/无窗口/卡死)。

### 第 5 轮(2026-09-25):留白未消,加双向诊断

启动日志关键发现:`AppWindow --> Failed to set the window bounds {1300010}`×4 +
`MoveToAsync: window should not move, winId:3619, mode:1` —— **引擎在主动
setBounds 窗口边界**(桌面版恢复窗口位置的行为),被系统以全屏模式拒绝;
`getAvailableArea 2800x1840` 全高 → 系统层避让区已塌陷。
另发现用户抓取的日志缺少 info 级行,无法确认 tablet 分支是否执行。

**本轮改动(诊断为主)**:
- `useFullWindowBounds()` 从 `deviceType==='tablet'` 放宽为 `!pcModeEnabled`
  (防设备类型上报异常导致分支全跳过);
- 启动时 error 级打印 `deviceType/sdkApiVersion`;
- `immersive diagnostics`、`re-pushed viewport bounds` 日志升为 error 级;
- `AppWindowAdapter.setBounds` 打印引擎请求的矩形 + 实际 windowRect/drawableRect
  (error 级)——用于判定留白是否来自引擎自请求的矩形。

### 第 6 轮(2026-09-25):真机日志定案两个根因

**管理仓库打不开(铁证)**:`UpdateViewportConfig: invalid width: 0, height: 0,
id: 3632` —— 触摸模式(移动布局)下渲染层请求子窗口**尺寸传 0×0**(移动模式
无窗口概念),适配器照单创建 0×0 窗口 → WMS 挂载超时 → 空白不可用。
**修复**:bounds 为 0 时改用父窗口矩形(兜底 800×600),并打 WARN 日志。

**留白/切换(实锤)**:`re-pushed viewport bounds {577,158,1650,1170}` 为
悬浮窗矩形;抓取期间 getAvailableArea 从 top:87 切到 top:0 —— 用户在
PC/平板模式间切换,而引擎视口没跟随重推,残留 87px 旧偏移(≈1cm 留白)。
**修复**:补推逻辑提取为 `repushViewportBounds()`,除首启三次外,
**PC 模式切换后 500ms/1500ms 再补推两次**,视口随模式切换收敛。

**管理仓库的剩余风险**:复用路径的 id/callback 绑定契约(L4)仍按上游设计,
若新构建后触摸模式管理仓库仍有问题,需进一步定位复用窗口的内容绑定。

### 第 7 轮(2026-09-25):NaN 漏网修复(触摸模式几何参数缺失族)

真机日志确认两个残留:`setBounds requested={}`(触摸模式下引擎传空几何,
全 undefined)与子窗口 0×0 仍在——原因相同:**undefined 参与 `<= 0` 比较为
false,绕过了数值检查**。

**修复**:
- `AppWindowAdapter.setBounds`:width/height 为 NaN/undefined → 保持当前
  矩形直接回调(不再带着 NaN 移动/缩放被 1300010 拒绝);left/top 缺失 →
  取当前窗口位置;
- `SubWindowAdapter`:空几何判断改为 `!(w>0)||isNaN(...)||isNaN(top/left)`
  全覆盖,undefined 也会触发"改用父窗口矩形"的兜底。

至此触摸模式几何参数缺失族(管理仓库 0×0、setBounds {})在适配层闭环。
若管理仓库仍有问题,下一层是复用窗口的内容绑定契约(14b 备注)。

### 第 8 轮(2026-09-25):删除文件卡顿 3 秒

**根因**(用户日志):移植层原生 `shell.trashItem` **返回成功但文件并未删除**,
包装器进入 `waitForMissing(3000)` 轮询 3 秒后才走 Vault .trash 兜底——
每次删除冻结 3 秒(日志 `[HMOS-TRASH] native trash returned but the file still exists`)。

**修复**:调整 trashItem 包装器顺序——
1. **快路径(瞬时)**:Vault 内文件直接改名进 `<vault>/.trash`(同卷 rename,
   Obsidian 回收站视图原生识别);
2. **慢路径**:Vault 外路径才走原生 trash(等待缩短 3s→1s),失败仍兜底改名。

语义说明:Obsidian"系统回收站"删除选项在本移植上原生 trash 不可用,
统一落 Vault .trash(用户可在 Obsidian 回收站视图找回)。

### 第 9 轮(2026-09-25):留白真正根因确认——setWindowLayoutFullScreen 不受支持

真机日志:`WMSImms E OnSetWindowLayoutFullScreen device not support` ——
**API 24 平板上 setWindowLayoutFullScreen 已不被支持**(构建期警告
"This API is unavailable to tablet, 2in1" 同源)。全屏布局失败 →
ArkUI 界面(引擎 surface)默认避开状态栏从 y=87 开始 → 状态栏隐藏后
87px 成为空白。这与边界上报无关,surface 本身没有延伸进状态栏区域。

**修复**:主窗口两个页面(`pages/Index.ets`、`pages/WindowNode.ets`)的
根容器追加 `.expandSafeArea([SafeAreaType.SYSTEM], [SafeAreaEdge.TOP])`
—— 组件级安全区扩展,不依赖被限制的窗口级 API,surface 覆盖状态栏区域。

### 第 10 轮(2026-09-25):targetSdkVersion 提升至 API 24

触摸模式显示问题在原生层全部成功(全屏布局/状态栏隐藏/避让区)后仍存在,
启动日志暴露最后一块拼图:**系统按应用 API 版本决定全屏与避让区语义**
(`SetLayoutFullScreenByApiVersion: win 3677 status 1`),且 API 22 语义下
状态栏避让区(top 87px)仍上报给引擎。设备本身是 API 24(6.1.0.135)。

**变更**:本地 `build-profile.json5` 的 `targetSdkVersion` → `"6.1.1(24)"`
(`compatibleSdkVersion` 保持 6.0.2(22))。预期:系统按 API 24 语义处理
全屏/避让区,触摸模式留白消失;编译期 "unavailable to tablet" 警告消失。
若构建报 SDK 缺失,在 DevEco Settings > HarmonyOS SDK 安装 6.1.1(24)。
回滚:targetSdkVersion 改回 6.0.2(22)。

### 第 11 轮(2026-09-25):真凶确认——应用被系统以悬浮窗状态恢复

API 24 构建生效(`apiTargetVersion: 60101024`,**避让区全空**——API 22 时代的
87px 顶部偏移已消失)。但新日志暴露:`IsPcMode 1` + 窗口以悬浮矩形
`[578,219,1644,1233]`(mode 102)创建——**系统把应用按上次状态以悬浮窗恢复**,
用户看到的"两个信息栏大小的留白"是悬浮窗上方的桌面区域,不是应用内部问题。

**修复**:平板非 PC 模式时强制窗口回全屏——
`updateWindowPcmodeSwitchStatus` 在 `!newStatus` 时于 500/1500ms 两次调用
`mainWinSetFullscreen()`(`maximize(ENTER_IMMERSIVE)`,项目内已有同款用法)并重推视口。
若 `WindowMode.WINDOW_MODE_FULLSCREEN` 枚举名与 SDK 不符,以编译错误反馈修正。

### 第 12 轮(2026-09-25):触摸模式顶部留白的最终根因——渲染层模拟刘海

**官方文档调研结论**(官方页面为 JS 渲染,经搜索摘要+多来源交叉确认):
1. 组件级 `expandSafeArea` 是官方推荐的沉浸式实现方式(窗口级
   `setWindowLayoutFullScreen` 在部分形态受限时,组件级方案仍然生效);
2. `setWindowLayoutFullScreen(true)` 只让布局延伸到栏下,**不隐藏状态栏**,
   隐藏须配合 `setWindowSystemBarEnable([])` / `setSpecificSystemBarEnabled`
   ——现有实现组合正确;
3. 分屏/悬浮窗(自由窗口)模式下系统栏由系统接管,三方应用无法隐藏,
   只能依靠 `maximize(ENTER_IMMERSIVE)`(第 11 轮已加)回全屏。

**真凶**(从 1.13.7 asar 解包确认):触摸模式走 `EmulateMobile` 时,Obsidian
app.css 存在硬编码模拟刘海:

    body.emulate-mobile {
      --safe-area-inset-top: 59px;     /* 模拟 iPhone 刘海 */
      --safe-area-inset-bottom: 34px;
    }

且 app.js 只在桌面模式下清零这些变量(`rd.isDesktopApp && body.setCssProps
({"--safe-area-inset-top":"0",...})`),移动(触摸)模式不清零。59 CSS px
× DPR ≈ 两个状态栏高度,与真机现象完全吻合。桌面模式有清零,故只看到
系统栏那 1 道空隙。

**修复**(scripts/update-obsidian.mjs,patch 标记 v3→v4):渲染层注入
`zeroSafeArea()`——对 `document.body` 内联设置
`--safe-area-inset-*: 0px`(内联样式优先级高于 body.emulate-mobile 规则),
启动时 + DOMContentLoaded + 每次模式同步轮询(5s,含无变化分支)幂等执行。
这与官方沉浸式语义一致:系统栏已隐藏、页面已扩展到栏下,应用不应再自行
避让。窗口模式(悬浮窗)下渲染层同样清零,顶部由系统桌面区域隔开,
不影响可用性。

**重新打包**:已执行 `node scripts/update-obsidian.mjs --repatch`
(缓存命中,SHA256+签名校验通过),obsidian.asar 已含 v4 patch,
直接编译 HAP 即可。验证要点:触摸模式顶部贴顶(仅剩
`max(var(--safe-area-inset-top), var(--size-4-3))` 回退的 12px 内建间距);
桌面模式行为不变(桌面本来就清零)。

### 第 13 轮(2026-09-25):窗口/显示逻辑专项审查——理顺模式状态机

对 WebAbility + 窗口适配器做了一次纯显示逻辑的审查与重构,不改行为语义,
只理顺结构并修复审查发现的缺陷:

**发现的缺陷(已修)**
1. **AppWindowAdapter 边框混加(上游遗留,两处)**:`setBounds` 高度按
   `height + topBorder + leftBorder` 计算(宽度是对称的
   `width + leftBorder + leftBorder`),`createWindow` 的像素图/窗口高度同款
   (`height + leftBorder + topBorder`)。带边框窗口在左边框宽度 ≠ 顶边框
   高度时尺寸错误。统一改为对称:`height + topBorder + topBorder`,并提取
   `outerWidth/outerHeight` 消除像素图与 StartOptions 的重复表达式。
   (无边框窗口 border=0,真机行为不变。)
2. **PC 模式系统栏不对称**:切到 PC(自由多窗)模式时,启动期留下的
   "隐藏状态栏" 窗口属性会泄漏到 PC 桌面。新增
   `restoreSystemBarsForPcMode()`(`setWindowSystemBarEnable(['status',
   'navigation'])`),进 PC 模式时把系统栏还给系统;平板模式由既有的
   隐藏路径接管,模式切换后状态对称。
3. **PC 模式注册分支重复**:`if (res) { update() } else { update() }` 两分支
   完全相同,合并为一次调用(注释说明两种情况都需要读一次初值)。

**结构理顺(等价重构)**
4. **视口合成去重**:全/避让两种矩形合成逻辑原本在 4 处重复
   (repush、windowSizeChange、windowRectChange、WINDOW_SHOWN),统一为
   `computeViewportBound(prop)`;`windowRectChange` 从"事件 rect+属性
   drawableRect 混搭"改为统一读 `getWindowProperties()`(与
   windowSizeChange 同源,事件只提供 reason)。
5. **定时器去重**:PC 模式处理里 4 个 setTimeout 块合并为
   `settleViewportLater(delay, forceFullscreen)`;首启 600/1500/3000ms 补推
   走同一 helper。首次读取仍无条件强制全屏(保留第 11 轮浮窗恢复修复)。
6. **沉浸式设置抽方法**:onWindowStageCreate 里 50 行内联调用抽为
   `applyImmersiveWindowSettings()`;`mainWinSetFullscreen` 模块函数收编为
   `enterImmersiveFullscreen()`;类头注释补充完整的三态显示模式状态机
   (平板沉浸/平板 PC 模式/其他设备)。
7. **新增 `avoidAreaChange` 监听**(官方推荐的适配方式):避让区翻转
   (栏隐藏落定/模式切换/旋转)时重推视口,替代依赖固定定时器兜底。
8. **卫生**:`loadContent` 回调里遮蔽 `window` 模块的局部变量改名为
   `mainWin`,`import win` 别名随之删除;repush 日志 error→info;修复
   writeProtocolUriFile 的换行格式。

**验证要点**:平板沉浸模式行为不变(隐藏/全屏/补推);切 PC 模式后状态栏
应恢复显示(新增);切回平板模式回到沉浸;创建带边框窗口的场景(若存在)
尺寸应正确。

### 第 14 轮(2026-09-25):启动铺不满的真凶——引擎以 0×0 surface 起浏览器

第 13 轮重构后的日志(14:57)证实 ArkTS 侧已经全对:窗口 rect 全程
`[0,0,2800,1840]`(fullscreen)、避让区全零、视口按整窗 2800×1840 推送
7 次、pcMode=false。但日志里有一条决定性的:

    Adapter: debug info:Get xcomponent surface size success:0 0

引擎只在浏览器启动时读**一次** XComponent surface 尺寸,而 runBrowser 在
XComponent onLoad 时就被调用——此时首帧布局还没跑完,surface 还是 0×0。
引擎以 0×0(退化为默认尺寸)创建渲染视口,之后不再重查,ArkTS 侧再怎么
推视口也补不回来。这就是"一启动铺不满"的完整因果链(时序竞态,与上游
代码相同,在 HarmonyOS 6.1 平板上必然触发)。

**修复**(新 utils/SurfaceReady.ets + 两个组件接入):
- `SurfaceReady.whenReady(getRect, start)`:轮询
  `XComponentController.getXComponentSurfaceRect()`(50ms×100 次,SDK 确认
  API 12+,本机 24),surface 出现真实尺寸才调用 runBrowser;超时兜底照常
  启动,不让浏览器无限等待。
- **WebWindow.ets(主窗口活跃路径,pages/Index)**与
  **WebWindowNode.ets(pages/WindowNode,新建窗口)**的 onLoad 都改为
  surface 就绪后再 setDefaultBounds + runBrowser(+ kNewWindow)。
- 顺带修正:第 5b 轮的"平板 drawableRect 整窗合成"当时只加在了
  WebWindowNode.ets,但主窗口实际渲染路径是 WebWindow.ets——已把合成逻辑
  补进 WebWindow.ets 的 setDefaultBounds(此前 drawableRect 未陈旧时无感,
  一旦系统晚落定避让区,主窗口路径就会漏)。

**验证要点**:冷启动日志应出现 `SurfaceReady: surface ready after N poll(s)`,
且其后引擎查询 surface 尺寸应返回真实值(约 2800×1840);启动即铺满;
触摸模式配合第 12 轮的渲染层清零,顶部不应再有留白。

### 第 15 轮(2026-09-25):按用户决定保留顶部状态栏——状态机整体回退 + 全面验证

**政策变更**:放弃隐藏状态栏的全部尝试,系统栏(状态栏 + 导航指示条)
始终可见、由系统管理。窗口铺满屏幕,内容自然避让栏区。

**代码变更**
1. `WebAbility.ets`:删除 `applyImmersiveWindowSettings()`(布局全屏、
   隐藏 navigationIndicator、平板隐藏状态栏、setWindowSystemBarEnable([])
   四组调用全部移除)与 `restoreSystemBarsForPcMode()`(栏从不隐藏,
   无需恢复);删除 `useFullWindowBounds()`,`computeViewportBound()` 固定为
   drawableRect 语义(内容区 = windowRect 偏移 + drawableRect 尺寸);
   `enterImmersiveFullscreen()` → `forceFullscreenWindow()`,maximize 表现从
   `ENTER_IMMERSIVE`(进沉浸、隐藏栏)改为 `FOLLOW_APP_IMMERSIVE_SETTING`
   (跟随应用全屏设置——我们不设置,即铺满且保留栏,SDK 枚举语义已核实)。
2. `WebWindow.ets` / `WebWindowNode.ets`:移除"平板 drawableRect 整窗合成"
   (那是隐藏状态栏时对陈旧避让区的补丁,现在 drawableRect 本身就是权威
   内容区);`OnWindowInitSize` 原样透传系统给的 windowRect/drawableRect。
   SurfaceReady 延迟启动(第 14 轮 0×0 修复)保留,不受影响。
3. `pages/Index.ets` / `pages/WindowNode.ets`:移除 `.expandSafeArea(TOP)`
   (状态栏可见,surface 不得延伸到栏下)。
4. 保留不动:AppWindowAdapter 的 `setFullScreen/setSimpleFullScreen`
   (Electron 显式全屏请求,隐藏栏是正确的 Electron 语义)、
   `avoidAreaChange` 重推监听、首启/切模式 settle 定时器、渲染层 patch v4
   的安全区清零(状态栏可见时内容已在栏下,emulate-mobile 硬编码的 59px
   模拟刘海仍需清零,否则"栏 + 59px"双重空隙)。

**状态机静态验证(grep + 通读,全部通过)**
- 沉浸式 API 零残留:`setWindowLayoutFullScreen` / `setSpecificSystemBarEnabled` /
  `setWindowSystemBarEnable` / `expandSafeArea` 在全部 .ets 中无匹配;
  `ENTER_IMMERSIVE` 仅剩 AppWindowAdapter 三处 Electron 语义路径(合理保留)。
- 六个改动文件括号平衡检查全部 OK;无未使用 import。
- 视口语义一致性:repush / windowSizeChange / windowRectChange /
  WINDOW_SHOWN 四路统一 `computeViewportBound`(drawableRect);与
  OnWindowInitSize 的 drawableRect 透传、页面无 expandSafeArea( surface ==
  drawable 区)三点互相一致,不再有"整窗 vs 内容区"混用。

**运行时状态转移表(新)**
| 输入 | 动作 |
|---|---|
| 冷启动 | 建监听(size/rect/avoidArea/SHOWN)→ loadContent → SurfaceReady 等真实 surface → OnWindowInitSize(透传)→ runBrowser;tablet 首读 PC 设置后 500/1500ms maximize(保留栏)+ 重推 ×2;600/1500/3000ms 重推;2000ms 诊断 |
| PC 模式开 | touch 文件=desktop;500/1500ms 重推(不强制 maximize) |
| PC 模式关 | touch 文件=touch;500/1500ms maximize(保留栏)+ 重推 |
| avoidAreaChange | 重推视口(栏显隐/旋转自适应) |
| windowSizeChange / rectChange / SHOWN | 按 drawableRect 语义推送 |
| 引擎 setFullScreen(true/false) | ENTER_IMMERSIVE / EXIT_IMMERSIVE(Electron 语义,仅此路径隐藏栏) |
| 引擎 setBounds({}) | NaN 守卫保持当前矩形(1300010 规避) |

**真机验证要点**:①状态栏常驻可见,应用内容从栏下开始,无叠加;②启动
即铺满(SurfaceReady 生效);③触摸模式顶部无"栏下 + 59px"双重空隙
(patch v4 清零生效);④自由多窗拖拽/恢复正常,回到平板模式自动最大化。

### 第 16 轮(2026-09-25):后半段(第 11-15 轮)改动二次审查 + 发布基建

**五维评估结论**

| 维度 | 结论 |
|---|---|
| 必要性 | 每项改动都有真机日志实锤对应(0×0 surface、视口不收敛、PC 模式切换残留、浮动恢复);沉浸式实验回退由用户决策驱动,回退本身登记为 commit 计划第 2 行 |
| 正确性 | 逐项核对通过;发现并修复 4 处小缺陷(见下)。关键语义复核:①PC 模式首读时强制 maximize 必须无括号 modeChanged 条件(保留第 11 轮浮窗恢复修复)②SurfaceReady 超时兜底保证引擎不会永不启动③渲染层 v4 安全区清零在"保留状态栏"政策下依然必要(去 emulate-mobile 硬编码 59px 模拟刘海,否则"状态栏+59px"双重空隙) |
| 安全性 | 新增 ArkTS/JS 代码无文件/网络/IPC 攻击面;make-commits.sh 带 BuildProfile.ets 守卫(本地签名数据绝不入库);.gitignore 复核确认 node_modules、.tmp-update 缓存(含 8.4MB 安装包)、package-lock 均被排除 |
| 代码质量 | helper 单一职责、注释记录"为什么";日志降级(repush error→info)降噪;就绪日志带真实 surface 尺寸便于诊断。已接受的重复:WebWindow/WebWindowNode 两份近似 WindowNodeController(上游结构,合并收益小于回归风险,已注释说明) |
| 架构 | 显示模式收敛为"系统接管 + drawableRect 单一语义",分支从"3 设备 × 2 边界语义"降为"平板/其他 × PC 开关";ArkTS↔渲染器仅经 mode 文件单向通信;CI 与本地共用 build-profile.example.json5,签名策略可插拔(secrets 注入或 unsigned) |

**审查修复(本轮)**
1. `forceFullscreenWindow()`:maximize 同步异常加 try/catch(防逃逸到 setTimeout 回调)。
2. 诊断日志 `immersive diagnostics` → `avoid-area diagnostics`(政策已改,命名随之)。
3. SurfaceReady 就绪日志附带实际 surface 尺寸(`surface ready after N poll(s): WxH`)。
4. commit 表 5b/5c 描述与第 15 轮最终态对齐(删除已回退项的表述)。
5. .gitignore 去重(tooling 段重复追加)。

**发布基建(新增)**
- `.github/workflows/build-release.yml`:LFS checkout → JDK17/Node20 →
  官方 command-line-tools(下载直链经仓库变量 `HARMONYOS_CLI_URL`,华为会
  轮换直链;缺失时告警跳过)→ 由 example 生成 CI 用 build-profile
  (22/24 组合,unsigned)→ 可选 secrets 注入签名(`SIGN_*`)→
  `ohpm install --all` + `hvigorw assembleHap` → SHA256/MD5 清单 →
  tag 推送自动建 Release(workflow_dispatch 产 artifact)。含
  `permissions: contents: write`。
- `docs/RELEASE.md`:CI 说明、签名三方案(CI 签名/用户自签/自行编译)、
  哈希校验命令、发布操作顺序。
- `scripts/make-commits.sh`:按文件不相交的 5 组分批提交,dry-run 验证
  无 node_modules/缓存/BuildProfile 混入;忽略 `scripts/package-lock.json`
  (仓库既有决定)。

**人工排查清单**:见回复/下方"真机实测记录"第 16 轮验证要点——
状态栏常驻、启动即铺满、触摸模式无双重空隙、自由多窗往返正常、
坚果云 OAuth 深链回跳、删除秒删、仓库管理面板可用。

### 第 17 轮(2026-09-25):底部导航条避让不美观——切换为官方"背景延伸 + 内容避让"模式

**问题**:第 15 轮回退后窗口不设布局全屏,系统把整窗内容切在导航条上方,
应用背景没延伸到底部,导航条下露出一条死白/死黑背景带,手势条浮在其上
——不美观。这恰是官方沉浸式文档要解决的场景。

**方案(官方推荐模式:背景延展、内容避让)**
1. `WebAbility.ets`:恢复启动期 `setWindowLayoutFullScreen(true)`(官方沉浸
   第一步,loadContent 之前)。应用背景从此延伸到状态栏/导航条之下,两大
   系统栏保持可见(遵守用户"保留状态栏"的决定,不隐藏任何栏)。
2. **真实 insets 通道**(新增):`pushSafeAreaInsets()` 读取
   `getWindowAvoidArea(TYPE_SYSTEM)`(状态栏高度,兼三键导航栏底部)与
   `TYPE_NAVIGATION_INDICATOR`(手势条高度),按 display 密度换算成 CSS px,
   写入 `ohsidian-mode.json` 的新字段 `insets: {top, bottom}`。触发时机:
   启动 settle、`avoidAreaChange`(栏显隐/旋转)、PC 模式切换。取值规则:
   平板/手机且非 PC 模式 → 真实值;PC 浮窗与 2in1/PC → 0(浮窗不与栏重叠)。
3. `computeViewportBound()`:恢复 pcMode 感知双语义——布局全屏下系统上报
   drawableRect == windowRect(不再切栏),整窗即内容区;PC 浮窗保留
   decorated 语义防标题栏叠加。
4. 渲染层 patch v4→v5:废弃"一刀切清零",改为从 mode 文件读取真实 insets,
   以 body 内联样式写入 `--safe-area-inset-top/bottom`(左右恒 0),内联
   优先级压过 emulate-mobile 硬编码(59px/34px 模拟刘海);新增
   MutationObserver 监听 body style 变化,Obsidian 桌面初始化的清零写入会被
   立即纠正(比较后写入,无死循环);5s 模式轮询同步刷新(insets 变更即时生效)。
5. asar 已重新打包(`--repatch`,签名校验通过)。

**效果预期**:底部手势条悬浮在 Obsidian 背景之上,无死背景带;触摸模式
底部工具栏按真实手势条高度(≈28css px)抬升;顶部内容按真实状态栏高度
(≈38.7css px)避开,状态栏区域显示应用背景,浑然一体;桌面模式标题栏
同样按真实 insets 下移。**与引擎自查避让的潜在叠加**(若 nweb 自行上报
env(safe-area-inset-*) 并内部避让,会出现双重内边距)需真机确认——若
出现,降级方案是把 insets 写 0 验证引擎自查行为后取舍。

### 第 18 轮(2026-09-25):触摸模式仓库管理无法跳转——复用子窗口显示旧页面

**日志实锤**(15:48):引擎请求 536×62 的仓库切换弹窗
(`createSubWindow`,LogMethod 打印 `{}` 是 JSBind 对象不可枚举的假象,真实
bounds 在)→ ArkTS 从复用缓存命中上次会话遗留的 `browser3`(日志
`reusableWindow browser3 size 0` 的 0 是 splice 后的列表长度,非窗口尺寸)
→ 旧路径仅 resize+show 后直接回调引擎 → 弹窗显示的是**上一会话的旧页面**,
引擎为本次请求准备的内容永远不可见 → 用户点击菜单项后弹窗直接
hide+cancel,仓库管理页(最新页面)始终没出现。

**根因**:复用路径没有重新加载窗口页面。旧 XComponent 仍绑定上一次的
网页 surface,onLoad 不会再次触发,而引擎(与全新创建路径一致)要等
onLoad 后才会把新内容挂到该 surface——所以复用窗口永远停在旧内容上。

**修复**(`SubWindowAdapter.ets` 复用路径重写):
1. 复用时对旧窗口**重新 `loadContent('pages/SubWindow')`**:XComponent 重建、
   onLoad 重新触发,原生注册表以同一 window id 重新绑定新 surface,时序与
   全新创建路径完全对齐(onLoad → 引擎回调 → 引擎挂内容)。
2. 重载前把当前请求的 `callback`、`size`、`init_color_argb` 重新写入
   `subWindowParams`(旧路径直接用旧请求的回调,当前请求回调被丢弃;
   新路径由重建后的 XComponent onLoad 触发当前回调,故必须先换上)。
3. 引擎回调不再由 ArkTS 直接调用,统一走 XComponent onLoad(消除双路径
   回调时序不一致)。
4. `setSubWindowBounds` 增加空几何守卫(引擎更新可能带 `{}`,NaN 调用会被
   WMS 拒绝);窗口找不到时告警而非静默。

**真机验证要点**:触摸模式点左下角仓库名 → 弹出菜单显示**最新**内容;
点"管理仓库"能打开仓库管理页;连续开关弹窗多次(验证复用+重载链路);
PC(2in1)模式下弹窗行为回归正常。

### 第 19 轮(2026-09-25):窗口改动二次自查——修复自查发现的 3 处缺陷

对全部窗口相关 diff(WebAbility/SubWindowAdapter/AppWindowAdapter/
WebWindow/WebWindowNode/WebEmbeddedWindow/pages/渲染层 patch)逐 hunk
对照上游复核。

**确认无回归的项**
- WebAbility 中原局部变量 `window`(遮蔽模块)全部正确更名为 `mainWin`
  (12 处实例调用,无一处漏改,`grep window.set*` 零残留);
- 上游两处 `.left` 笔误(adjustBounds top、setBounds/createWindow 高度混加)
  修复正确;窗口关闭监听、decor/标题栏/topmost 等上游逻辑原样保留;
- CloudSync 3s 轮询从 WebAbility 迁入适配器单例(此前轮次)无双跑;
- 视口四路推送、settle 定时器、PC 模式状态机时序复核一致。

**自查发现并修复**
1. **复用回调可能卡死引擎(第 18 轮方案的脆弱假设)**:重载后若框架不重建
   XComponent,onLoad 不触发,引擎回调永不发生 → 弹窗卡死。改为
   **exactly-once 通知**:包装回调(onLoad 正常触发即用它;2 秒兜底定时器
   补报;双路径都不会二次通知)。
2. **重载失败窗口泄漏**:loadContent 失败时旧窗口仍留在活动列表。现在
   失败即从列表移除 + destroyWindow,并回调 false 让引擎走新建。
3. **WebEmbeddedWindow(嵌入式窗口)存在同款 0×0 竞态**:onLoad 直接
   runBrowser。补 XComponentController + SurfaceReady 延迟启动(kNewWidget
   分支不依赖 surface,保持原样)。至此三条 runBrowser 路径
   (主窗口/新建窗口/嵌入式窗口)全部覆盖。
4. `createSubWindow` 复用路径的 `init_color_argb` 加空值守卫(上游直接把
   undefined 赋给 XComponent 背景色)。

**结论**:除上述 4 项已修复外,未发现其他由窗口改动引入的功能破坏。

### 第 20 轮(2026-09-25):回滚第 18/19 轮复用重载方案——子窗口复用机制整体移除

**用户实测反馈**:第 18/19 轮改动后"新建窗口相关的都无法正确调用"——
重载方案引入了比原问题更广的回归。

**原因复盘**:第 18 轮的"复用时重新 loadContent"依赖框架在重载后重建
XComponent 且时序与引擎挂载对齐,这两个前提都无法在不看引擎源码的情况
下保证。实际效果是引擎可能在旧 surface 已拆除、新 surface 未注册的间隙
挂载,导致弹窗整体失效(比"显示旧内容"更糟)。第 19 轮的 exactly-once
兜底只是缓解回调丢失,救不了挂载竞态。

**最终方案(确定性优先)**:子窗口复用机制整体移除。
1. `cancelSubWindow`:由 minimize+缓存改为**立即 destroyWindow**——弹窗
   关闭即销毁,不存在跨请求的旧 surface;
2. `createSubWindow`:删除复用命中分支,**总是走全新创建路径**(引擎分配
   window_id → 以该 id 建窗 → loadContent → onLoad 后引擎挂浏览器——这是
   "会话内首个弹窗"一直正常的那条路径);
3. 删除 `reusableSubWindow`/`globalCache`/`findReuseableSubWindow`/
   `addReuseWindow`/`getTotalSubWindowNum`/`MAX_TOTAL_SUB_WINDOW_NUM`
   全部复用设施(约 90 行),不再有"Global cache is inconsistent"类错误源;
4. `hideSubWindow`(minimize)语义保留——hide/show 循环是同一弹窗同内容
   的临时隐藏,与复用(把旧窗口当新窗口用)有本质区别,不受影响。

**代价**:每次弹窗新建窗口(约百毫秒级),换取行为完全确定。
**真机验证要点**:触摸模式仓库管理弹窗每次打开都是最新内容、点"管理仓库"
可进入管理页;连续开关多次正常;右键菜单/各弹窗正常;PC 模式弹窗回归。
若仍失败,需要抓取失败时刻前后的 hilog(关注 createSubWindow/attach/
surface 相关行),因为剩余怀疑点在引擎侧时序,无日志无法定位。

### 第 21 轮(2026-09-25):窗口新增调用链全链路走查

对四条窗口创建路径逐环走查(引擎入口 → ArkTS → 页面 → XComponent →
runBrowser/回调 → 引擎挂载),并补齐 4 处会让引擎永久等待或泄漏窗口的
链路断裂隐患。

**链路图(走查确认)**
1. 主窗口:EntryAbility(WebAbility)→ loadContent(pages/Index)→
   WebWindow → onLoad → SurfaceReady 等真实 surface → setDefaultBounds →
   runBrowser → 引擎起浏览器。
2. 新建全窗口:引擎 → AppWindowAdapter.createWindow(EntryAbility 多实例,
   want 带 window_id/instanceKey)→ StartOptions 定位尺寸 → 同主窗口链路;
   checkSingleInstance 因 want 已带 xcomponentId 而正确放行;平板上
   PC 模式首读会把它 maximize(符合全窗口预期)。
   注:BrowserAbility/pages/WindowNode 为上游死代码(无人启动),
   WebWindowNode 的 SurfaceReady 同步保留以防未来启用。
3. 弹窗子窗口:引擎 → SubWindowAdapter.createSubWindow(带真实 bounds,
   LogMethod 打印 {} 是 JSBind 假象)→ createNewWindow → 代理
   WebBaseAbility.createSubWindow → windowStage.createSubWindow →
   initSubWindow(move/resize → loadContent(pages/SubWindow) →
   focusable(false) → show)→ WebSubWindow XComponent onLoad →
   callback(true, id) → 引擎挂浏览器。关闭:hideSubWindow(minimize,
   同内容可再 show)/ cancelSubWindow(destroy,第 20 轮)。
4. 嵌入式窗口:WebEmbeddedAbility → WebEmbeddedWindow(SurfaceReady 同步)。

**本轮补齐的链路断裂隐患(均为引擎挂起/窗口泄漏类)**
1. `createNewWindow`:父代理解析失败时此前静默返回,引擎永久等待 →
   现在回调 false。
2. `adjustBounds`:bounds 为 undefined 时会抛异常(同样挂起引擎)→
   空对象兜底,交给调用方的零尺寸回退逻辑。
3. `initSubWindow` 的 catch:同步异常时引擎仍在等待 → 补 callback(false)。
4. focusable/show 失败路径:窗口已加载但不可用且泄漏 → 统一
   `discardFailedSubWindow`(移出活动列表 + destroy)后再回调 false。

**安全性确认**:所有窗口销毁均 async catch 兜底;失败路径一律
先清理再回调;无引擎回调双发路径(每条失败路径 return 后不再到达
成功回调);SurfaceReady 超时兜底不阻塞启动。

### 第 22 轮(2026-09-25):新建全窗口彻底失效的真凶——StartOptions 校验失败 16000067

**日志实锤**(16:46):`LaunchHelper excute failed: {"code":16000067}` ×2、
`XComponentManager::CreateWindow browser3/browser4 timeout`、随后刷屏
`getProxy failed: browser3 not found`。查 SDK:UIAbilityContext.d.ts 明确
**16000067 = "The StartOptions check failed"**——Ability 启动参数校验失败,
窗口实例从未创建,引擎 3 秒超时。`showAbility fail 16000067` 是后果
(对未启动的实例 showAbility 必然失败)。

**根因**:引擎在触摸(移动模拟)流程下请求新建窗口时可以携带空几何
(与同日志的 `setBounds({})` 同款)。`AppWindowAdapter.createWindow` 直接
`param.bounds.width + ...` 计算 StartOptions → NaN → 系统 StartOptions
校验失败 → **能力从未启动**。这不是窗口代码问题,是引擎→Ability 启动
链路在空几何下必然崩,上游同样存在。

**修复**(`AppWindowAdapter.createWindow`):
1. 几何修复:width/height 非法(NaN/≤0)或 left/top 为 NaN 时,回退到
   活动窗口的 windowRect(仍无效则 1280×800 兜底),边框清零重算;
2. `image.createPixelMap` 补 `.catch`:图标失败不再静默吞掉整个启动
   (此前 promise 拒绝无 catch,launch 永不执行),降级为无图标启动。

**同轮修复:强制全屏改显式矩形**。日志显示浮窗恢复时
`OnSetWindowLayoutFullScreen device not support`(浮窗不支持),且
`maximize(FOLLOW_APP_IMMERSIVE_SETTING)` 并未铺满(最终 2385×1711,
工作区 2800×1753,还伴随 `MoveToAsync Layout timeout`)。
`forceFullscreenWindow` 改为显式 `resize(display.width, display.height -
topInset) + moveWindowTo(0, topInset)`(topInset 取当前系统避让区,布局
全屏成功时为 0=整屏,被系统拒绝时系统自动钳制到工作区,两种情况都收敛)。

**附带说明**:日志中 `CLI server error: EPERM .obsidian-cli.sock` 是
Obsidian 1.13 自带 CLI 服务在沙箱内监听 socket 被拒,Obsidian 自身已捕获,
非致命,不处理。

**验证要点**:①新建窗口(含启动后立即新建)能创建并显示,日志无
16000067/browserX timeout;②主窗口浮窗恢复后 500/1500ms 两次校正后铺满
工作区,日志有 `forced fullscreen rect:`;③仓库管理弹窗(第 20 轮)回归。

### 第 23 轮(2026-09-25):创建/关闭窗口双双失效——审计与修复

**审计发现 1(主要嫌疑):forceFullscreenWindow 作用域过宽**。
每个 EntryAbility 实例(含新建窗口)都继承 WebAbility 并在 PC 模式首读时
执行强制全屏——新建窗口被引擎放到请求位置(常为带标题栏的浮窗)后
500/1500ms 又被我们 resize+move 拉成全屏,与引擎的窗口管理直接对抗;
带装饰窗口在布局中途被改尺寸会触发 WMS `MoveToAsync Layout timeout`
(16:46 日志实锤),窗口进入假死态:**看起来"创建失败"、标题栏 X 无响应**。
修复:`forceFullscreenWindow` 限定主窗口(`DEFAULT_WINDOW_ID='browser1'`,
每次冷启动主窗口即 browser1);新窗口完全尊重引擎请求的几何。

**审计发现 2:StartOptions 被拒后启动彻底放弃**。LaunchHelper 的
startAbility 失败仅记日志(16000067 无法确定具体是几何还是
processMode/startupVisibility 配对被当前 WMS 拒绝)。修复:捕获 16000067
后用**裸 want 重试一次**(系统默认位置启动)——窗口至少能出现、能关闭;
成功后由引擎的 setBounds/repsh 收敛位置。同时补 `excute success` 日志。

**审计发现 3:closeWindow 静默无操作**。代理缺失时 `context?.terminateSelf()`
直接跳过,引擎以为窗口已关而窗口仍在屏上。补显式错误日志与成功日志。

**其余链路复核(无问题)**:AbilityManager 数字 id 归一化
(browser+N)正确;checkSingleInstance 对带 xcomponentId 的 want 正确放行;
X 关闭的系统链路(session 销毁 → onWindowStageDestroy → removeProxy →
WINDOW_CLOSE 事件)完整。

**验证要点**:①新建窗口出现且位置/大小为引擎所请求,不再被拉全屏,可正常
交互;②点 X 能关闭;③若仍失败,抓取点击时刻前后日志,关注
`AppWindowAdapter#createWindow`、`excute success/failed`、
`retry with bare want`、`closeWindow`——首次能区分"引擎未调用"与"启动被拒"。

### 第 24 轮(2026-09-25):触摸模式仓库弹窗空白——子窗口存在与主窗口相同的 0×0 竞态

**行为复盘**(15:48 日志):弹窗创建+显示正常,用户点一下,弹窗在 67ms 内
hide+cancel,没有任何动作执行——与"弹窗内容空白,点击被当成点外关闭"完全
吻合;而弹窗子窗口的回调时序与主窗口当初渲染损坏的竞态一模一样:

    showWindow → XComponent onLoad → 立即 callback(true) → 引擎挂浏览器
    → 引擎读 surface 尺寸(可能仍为 0×0)→ 内容渲染进退化视口 → 空白

主窗口已在第 14 轮用 SurfaceReady 修复(runBrowser 延迟到 surface 有真实
尺寸),但弹窗子窗口的 WebSubWindow 没有同款门控。

**修复**:
1. `WebSubWindow`:补 `XComponentController`,onLoad 改为 SurfaceReady 门控
   ——surface 出现真实尺寸后才向引擎回调 readiness(引擎随后挂浏览器,读到
   的必然是真实 surface);
2. `SubWindowAdapter.createSubWindow`:显式记录解析后的弹窗几何
   (`sub window browserX bounds: {...}`,LogMethod 打印 JSBind 对象为 {}
   的假象导致此前看不到真实 bounds)。

**待下一份日志确认的疑点**:引擎请求的弹窗几何为 536×62 物理像素
(238×27.5vp,约单行高度)。若弹窗本应是多行仓库菜单,则是引擎侧几何计算
问题(或单位不一致),新加的 bounds 日志将直接暴露请求值;若几何合理而
内容仍不显示,则继续查引擎挂载后的渲染链。

**验证要点**:触摸模式点左下角仓库名 → 弹窗内能看到菜单内容(非空白);
点仓库条目能切换;点"管理仓库"能进入管理页;日志含
`sub window browserX bounds:` 与 `surface ready after N poll(s)`。

### 第 25 轮(2026-09-25):仓库弹窗空白真凶——tooltip 弹窗拦截触摸

**新日志(22:06)先确认了两件事**:
1. 第 24 轮 SurfaceReady 修复完全生效:`Get xcomponent surface size
   success:536 61`(不再 0×0)、`surface ready after 1 poll(s): 536x61`,
   弹窗创建→挂载→显示→输入链路全部打通;
2. 弹窗生命周期呈现循环:点仓库切换器 → 92ms 后弹出 536×61 条带 →
   用户点条带 → 100ms 内 hide+cancel → 引擎又建新的 → 无限循环,
   菜单永远无法使用。

**单位假设的纠正**:曾推测引擎传 DIP 需乘密度,但坐标精确分析否定了它——
弹窗底缘 1739+61=1800px 恰好是底部栏顶缘(800css×2.25),这个精确贴合
证明引擎传的就是物理像素(DIP 经系统钳制底缘应为 1840)。536×61px
(238×27.5vp)是引擎有意的单行条带 = **悬停提示(tooltip)**。
已回滚本轮中途尝试的 DIP 缩放(DisplayMetrics 移除),避免误伤。

**真凶**:tooltip 在桌面端有悬停延迟、且点击可穿透;触摸模拟下 hover
瞬时触发,**tooltip 弹窗直接生成在手指下方,吞掉本该落到仓库切换器和
页面内菜单的点击**——菜单(页面内 HTML)永远打不开,点条带只会关掉
tooltip,循环往复。

**修复**(`SubWindowAdapter.initSubWindow`):弹窗子窗口增加
`setWindowTouchable(false)`(SDK 确认 API 9+,本机 24)——tooltip 纯视觉
显示,点击穿透到下方主窗口:页面内仓库菜单可以打开、条目可以点。
focusable(false) 保留;失败路径(dispose+callback(false))同步覆盖
新加的 promise 环节。

**已知代价**:tooltip 显示期间若与页面内菜单重叠,视觉上可能遮挡部分
菜单(但不拦点击);引擎在后续交互中会自行 hide/cancel 它。

**验证要点**:①点仓库切换器,tooltip 条带出现但**不再吞点击**,页面内
菜单能打开;②菜单条目可点、能切换仓库;③"管理仓库"能进入管理页;
④连续开关正常;⑤若菜单与 tooltip 视觉重叠影响阅读,反馈后可加自动消隐。

### 第 26 轮(2026-09-25):回滚第 25 轮触摸穿透——弹窗承载真实交互内容

**用户实测**:点击"管理仓库"毫无反应。日志(22:25)实锤:14 次点击
全部落在 wid:181(主窗口)——第 25 轮的 `setWindowTouchable(false)` 让
弹窗触摸穿透,而 536×61 条带是**可交互的仓库菜单条**(用户点击的
"管理仓库"就在其中),穿透后弹窗的网页内容永远收不到点击,
管理仓库的处理逻辑从未触发(全程无 createWindow)。

**回滚**:`setWindowTouchable(false)` 移除,弹窗恢复可触摸(SurfaceReady、
全新创建链路、createWindow 16000067 修复均保留)。

**此前"点条带只关闭"的真相重估**:第 18 轮时代(15:48 日志)点击
"管理仓库"其实已经到达弹窗并触发处理,但当时 createWindow 存在
16000067 缺陷,管理窗口启动静默失败——表现恰似"没有反应"。如今
createWindow 已修复(第 22/23 轮,用户已确认新建窗口正常),
**触摸可达的弹窗 + 可用的 createWindow 首次同时成立**。

**验证要点**:点仓库切换器 → 弹窗出现 → 点击"管理仓库" → 管理窗口打开
(日志应出现 `AppWindowAdapter#createWindow ... in` 与 `excute success`)。
若仍无 createWindow,则问题在弹窗渲染层→引擎的 IPC,需要渲染进程
console 日志(Electron tag)进一步定位。

### 第 27 轮(2026-09-25):耗电优化专项

**方法**:全量扫描持续性负载路径——定时器/轮询(3 个 setInterval、
asar 注入补丁 2 处轮询、SurfaceReady)、事件监听注册/退订配对、
保活(RunningLock)、横切日志成本(LogDecorator)。按"后台是否持续 ×
单次成本 × 累计频率"排序,先评估后动手。

**热点清单与处置**

| # | 热点 | 评估 | 处置 |
|---|------|------|------|
| 1 | CloudSync 登录轮询:`setInterval` 3s 全生命周期运行(含后台),每 tick 一次 stat;`checkLoginTrigger` 挂 @LogMethod → 每 3s 两条 hilog + Context 全参序列化(≈28,800 次/天) | 主要持续性开销,后台轮询无功能意义(登录弹窗后台弹不出) | **改**:前台门控 + 去 @LogMethod |
| 2 | keepScreenOn 泄漏面:引擎 `RunningLock.Start` 后若无配对 Stop,退后台屏幕常亮 | 移动端潜在最大耗电项,缺保险 | **改**:退后台强制清,回前台按引擎请求恢复 |
| 3 | Geolocation:每次 StartListening 都注册一个系统级 1Hz GNSS 订阅(4.2 旧登记项"定位 1Hz 全功率耗电"),N 次 Start = N 份功耗 | 引擎多次调用时功耗翻倍;请求参数(1Hz)语义保留 | **改**:单订阅分发给 N 个回调;stop 幂等 |
| 4 | LogDecorator 横切:每方法调用 2 条 hilog + 全参 `JSON.stringify`×2;**参数含循环引用时装饰器抛异常并吞掉原方法调用**(隐藏可靠性 bug) | CPU + 日志 I/O 持续成本;剪贴板/通知内容全量进日志(R-7) | **改**:safeStringify(try/catch + 256 字符截断) |
| 5 | asar 深链桥 1.5s existsSync、渲染层 5s 模式轮询、SurfaceReady 50ms(就绪即停) | 单次 stat/read 微秒级,累计能耗可忽略;改 asar 需 `--repatch` 重打包(网络+二进制产物风险) | **不改**(评估记录) |

**改动明细**

1. `CloudSyncAdapter.ets`:轮询改"前台引用计数"模型——
   `notifyAppForeground/notifyAppBackground` 计数,>0 才启动 3s interval,
   =0 清表;`startLoginTriggerPolling` 保留原签名(首个调用者提供 context);
   interval 回调内对 context 再判空;`checkLoginTrigger` 去 @LogMethod。
   计数泄漏(ability 异常销毁未走 onBackground)时退化为旧行为(照常轮询),无新失败模式。
2. `WebAbility.ets`:新增 `onForeground()/onBackground()`(Entry/Browser/
   Stateless 三类 ability 均继承生效),转发给 CloudSync 与 RunningLock,
   全部 try/catch + warn 日志。
3. `RunningLockAdapter.ets`:`engineRequested` 记忆引擎请求;前台计数,
   最后一个窗口退后台时 `setWindowKeepScreenOn(false)`(兜底防泄漏),
   首个窗口回前台且引擎请求仍有效时自动恢复;`start/stop` 语义不变。
4. `GeolocationAdapter.ets`:内部回调数组 + `subscribed` 标记,多次
   StartListening 只注册一个系统 locationChange(修复 N 份 GNSS 功耗叠加),
   逐回调 try/catch 隔离(一个插件回调异常不再影响其它);stopListening
   幂等(先清列表再 off,未订阅时 off 不再盲发)。请求参数(1Hz/0m)不动,语义优先。
5. `common/LogDecorator.ts`:`safeStringify` 统一两个装饰器的参数/返回值
   序列化——try/catch(循环引用不再中断方法调用)、超 256 字符截断
   (`...(len=N,truncated)`)、undefined 归一。长参数(剪贴板内容、
   base64、文件列表)不再双倍全量序列化。

**五维评估**

| 维度 | 结论 |
|------|------|
| 安全性 | 无新攻击面/新文件通道/新 IPC;`checkLoginTrigger` 去装饰器 + 日志截断进一步落实 S-D/R-7 的"敏感信息不进日志"方向(Context、长内容不再全量落 hilog) |
| 可靠性 | 修复 LogDecorator 循环引用异常吞方法调用的隐藏 bug;Geolocation 回调异常隔离 + off 幂等;keepScreenOn 防泄漏;所有新路径 try/catch,失效即退化为旧行为(等价本轮之前,无新增失败模式) |
| 结构性 | 沿用既有模式:适配器单例 + 方法暴露,未引入新组件/新通信通道/新依赖;WebAbility 钩子为标准 UIAbility 生命周期;asar 注入补丁零改动(标记 v5 不变,无需 repatch) |
| 回归风险 | ①登录触发:仅"退后台瞬间写 trigger 且 30s 内不回前台"才错过,旧行为下弹窗同样不可见,差别可忽略;②多窗口:计数>0 不熄屏/不停轮询,语义正确;③视频/演示场景回前台自动恢复常亮(引擎亦可重新 Start);④Geolocation 单订阅:多次 Start 仍收到回调(分发),多次 Stop 全清(off 语义与上游一致) |
| 必要性 | 1/2/4 直接对应用户"耗电大"诉求;3 是 4.2 旧登记项落地;5 经评估主动不动,避免 repatch 风险 |

**验证(已完成)**

- clean 后全量 `assembleHap` 构建成功(BUILD SUCCESSFUL,39s,产出
  `electron-default-signed.hap`);`web_engine/BuildProfile.ets` 基线
  sha1 与构建前一致(生成文件未随构建漂移)。
- 5 个改动文件括号平衡检查全过;编译日志中零条与改动文件相关的
  error/warning。
- 说明:`assembleHar` 严格路径会报 10 条诊断(BatteryAdapter/OcrAdapter/
  PasteBoard/PowerMonitor 从 `CommonInterface` 导入不存在的导出成员、
  `NativeContext` 缺 `PowerMonitor` 成员等)——核对 HEAD 确认全部为
  **上游基线问题**(该文件从未有过这些导出),非本轮引入;DevEco 的
  HAP 构建路径不视为致命(同工作树 16:09/16:45 构建成功)。登记待
  后续轮次随 4.2 批量处理。

**装机回归清单(本轮新增)**

1. 耗电对比:设置 > 电池,观察后台耗电是否下降(本轮主要收益);
2. 云同步登录:前台点击 Obsidian 登录 → 弹窗正常;退后台再回前台后
   登录仍可用(轮询恢复);
3. 屏幕常亮:使用过常亮功能后(视频/演示)退后台,屏幕应正常熄灭,
   回前台恢复;
4. 定位类插件:多次启停监听后仍能持续收到定位回调;
5. hilog:不再每 3s 出现 CloudSync 双条日志;长参数日志出现
   `...(len=N,truncated)` 后缀属预期。



### 第 27 轮(2026-09-25):触摸模式仓库链路代码考古——以 app.js 为准

**"PC 正常 / 触摸异常"的分叉点**(直接审计 1.13.7 app.js 得出):

1. 触摸模式(EmulateMobile)下仓库切换器是**抽屉里的 `<select>` 下拉**,
   监听 change 事件。此前所有日志里的 536×61 弹窗 = 引擎渲染的
   **原生 select 下拉弹窗**(单行高度),不是 tooltip;
2. 选中项的处理:`"manage-vaults"===n ? i.app.openVaultChooser()
   : (Wf(n), localStorage.setItem("mobile-selected-vault",n), location.reload())`
   ——选"管理仓库"走 `openVaultChooser()`;选仓库名走**移动端机制**:
   写 `mobile-selected-vault` + 重载,真机上由手机外壳读该键;
3. `openVaultChooser()` 分支:`rd.isDesktopApp` 恒为 true(桌面版 asar
   无条件置位)→ 走桌面分支 `ipcRenderer.sendSync("starter")`;
4. 主进程 `ipcMain.on("starter")` → `ye()` → 创建 800×650 的 starter
   窗口(starter.html,仓库选择器)→ 引擎 createWindow——**与已修复的
   新建窗口同一条路径**。

**结论**:PC 模式正常(桌面 UI 直达 createWindow);触摸模式两处断裂:
①第 25 轮的触摸穿透让 select 下拉收不到点击(第 26 轮已回滚);
②**选仓库名的移动端机制在桌面主进程中不存在**(`mobile-selected-vault`
在 asar main.js 中零引用),重载后仍加载原仓库 → 切换静默失败(上游缺陷,
真桌面不带此 UI 故从未暴露)。

**修复**(update-obsidian.mjs 新增 app.js 文本补丁,带命中校验):
将抽屉选仓库名的 `(Wf(n), localStorage.setItem(...), location.reload())`
替换为 `i.app.openVaultChooser()` —— 选仓库名与选"管理仓库"统一打开
starter 仓库选择器窗口(桌面机制,createWindow 已修复),选择器内
完成切换/创建/管理。补丁已在重打包时确认命中。

**验证要点**:触摸模式点仓库切换器 → select 下拉出现 → 选"管理仓库"
或任一仓库名 → starter 仓库选择器窗口打开(800×650)→ 可切换/新建仓库,
主窗口随之加载所选仓库。日志链:`createSubWindow`(下拉)→
`AppWindowAdapter#createWindow ... in` → `excute success`。

### 第 28 轮(2026-09-25):耗电追问——"触摸/窗口模式能否系统通知替代定时查询" + 死轮询停用

> 编号说明:本文档因并行会话出现两节"第 27 轮"(耗电优化专项 / 触摸模式
> 仓库链路代码考古),编号冲突按历史原样保留;本节按文件顺序编为第 28 轮。

**用户问题**:触摸模式 ↔ 窗口模式切换是否在定时查询状态?能否改为
系统通知驱动,通知到了才改变状态?

**逐环节代码结论(以代码与 SDK d.ts 为准)**

1. **ArkTS 检测系统 PC 模式:已经是事件驱动**。`WebAbility.onWindowStageCreate`
   用 `settings.registerKeyObserver(context,'window_pcmode_switch_status',
   USER_PROPERTY, cb)` 监听(SDK @ohos.settings.d.ts 原文:"callback when
   monitored key value is changed",API 11+,系统值变更推送)——启动读一次
   初值,之后由系统推送。模式切换后的 500/1500/3000ms 定时器是事件触发的
   一次性视口 settle(第 6/11/13 轮),非轮询。insets 经 `avoidAreaChange`
   事件刷新,同为事件驱动。
2. **渲染层应用模式:是 5s 轮询,且是链路中唯一的定时环节**。
   TOUCH_MODE_PATCH `setInterval(syncFromSystem,5000)` 每 5s 读
   `ohsidian-mode.json`(~200B,readFileSync+parse+body 样式比较,几十 µs)
   ——17,280 次/天,累计 CPU 每天不足 2 秒,功耗占比可忽略。
3. 深链桥 1.5s 轮询(维持第 27 轮评估:保留);启动期 250ms×120 app 就绪
   重试为自限设计,就绪即停。

**渲染层轮询为何暂不事件化(评估记录)**

事件化只有两条路:①渲染层 `fs.watch` mode 文件——依赖闭源引擎 Node shim
的 inotify 实现,无法静态确认;②主进程 watch + Electron IPC 推送——依赖
引擎 ipcRenderer/webContents 通道细节,同样需真机验证。两路都要求
`--repatch` 重打包 asar,收益仅是"模式切换 <100ms 生效(替代 ≤5s 轮询
延迟)"与微量功耗;且弹窗链路回归期(第 24-27 轮)不应同时引入 asar 变量
(同 R1 的变量隔离原则)。零风险的第三条路是降频(5s→15s),同样需
repatch,收益微小。三项均记录在案,待弹窗回归收口后按需重启。

**本轮落地:CloudSync 3s 死轮询停用(用户思路的正确落点)**

- **证据链**:`.hcs-login-pending` 的唯一写入方是上游 fork 注入 1.12.7
  asar main.js 的 `hcs-login` IPC handler(scripts/.tmp-update/
  obsidian-1.12.7-main.js:76 的 hcs-* 系列注入);1.13.7 起内核为官方
  asar(官方签名校验)+ 本项目 4 处注入(触屏命令/IPC 守卫/深链桥/版本
  shim,均不含 hcs 逻辑),asar 内 grep "hcs-login-pending" = 0
  ——**该文件自此无任何写入方**,3s 轮询(每 tick 一次 stat,第 27 轮
  已去 @LogMethod)成为纯死负载;连带发现 `triggerLogin`(华为登录弹窗)
  在 1.13.7 下已无 UI 入口可达,整条 hcs 登录链 dormant。
- **改动**:`WebAbility.onCreate` 不再调用 `startLoginTriggerPolling`
  (保留 `initCloudSync`);`CloudSyncAdapter` 的轮询/前台门控 API 保留,
  注释记录死因与恢复路径(重新引入触发写入方——asar 注入或直连 JSBind
  ——后在 onCreate 一行启用);`onForeground/onBackground` 对 CloudSync
  的通知保留(停用期间为 no-op 计数,轮询恢复后自动生效)。
- **连带更正**:第 27 轮装机回归清单第 2 项"云同步登录"前提不成立
  (登录入口在 1.13.7 已不存在),该项作废,不作为回归点。

**评估**

| 维度 | 结论 |
|------|------|
| 必要性 | 死轮询是本轮唯一"查了也没结果"的定时负载,停用即用户"不用定时查看"思路的完全体 |
| 安全性 | 纯减法,无新通道;触发文件机制保留未删,无攻击面变化 |
| 可靠性 | 无行为依赖(文件无人写,轮询永不可能命中);恢复路径有注释导航,不会静默丢失机制 |
| 结构性 | 不引入新组件;CloudSync dormant 状态与恢复条件在两处调用点注释闭环 |

**验证**:assembleHap 构建成功(25s);`BuildProfile.ets` 基线 sha1 不变
(8fccd545…);改动 2 文件零新增编译诊断(252/265/285 行等警告为全库既有
`arkts-no-classes-as-obj` 注入模式警告)。

**装机回归要点**:耗电后台对比(本轮与第 27 轮合并观察);触摸/窗口模式
切换行为应与此前完全一致(本轮未触碰该链路)。

### 第 28 轮(2026-09-25):触摸模式仓库切换的最终绕过——拦截抽屉 select 直开选择器

**新日志(22:51)结论**:SurfaceReady(主窗口 2 次轮询 2800×1840、弹窗 1 次
536×61)与触摸穿透回滚均生效;点击确实到达了弹窗窗口(wid:278-281 各
一次 down/up)——**但选择仍未发生,全程 0 次 createWindow**。

**引擎侧缺口确认**:每个弹窗在 surface 尺寸查询后立即出现
`filter sub window render: browserX`——引擎对 select 下拉弹窗的渲染被
过滤(空白条带),选项不可见不可点。这是引擎(libadapter)行为,ArkTS
侧无法令其显示内容。结合 app.js 审计:抽屉的仓库切换器是 `<select>`
(选项="管理仓库"+各仓库),change 事件才有后续动作——原生下拉不可用
= 整条链路断裂,且**原生 select 不会派发 change(无选择发生)**,
第 27 轮的文本补丁(改写 change 处理)因此从未执行。

**最终绕过**(渲染层 patch v6,`hookVaultSelect`):document 捕获阶段
监听 touchstart/mousedown/click,命中"含 `option[value=manage-vaults]`
的 select"即 preventDefault+stopPropagation(原生空白下拉不再弹出),
并调用 `window.app.openVaultChooser()`——打开桌面 starter 仓库选择器
窗口(800×650,走已修复的 createWindow 路径),切换/新建/管理在其中
完成。800ms 去抖防重复;仅命中抽屉该 select,不影响其他 select。

**保留**:第 27 轮 change 处理补丁(若某些场景原生下拉可用,选仓库名
仍路由到选择器)、SurfaceReady、全新创建链路、16000067 修复。

**验证要点**:触摸模式点抽屉仓库名 → **不再出现空白条带**,直接弹出
starter 仓库选择器窗口(800×650)→ 可切换/新建/管理仓库;主窗口加载
所选仓库。日志链:`AppWindowAdapter#createWindow ... in` →
`excute success`(注意:不再有 createSubWindow,属预期)。

### 第 29 轮(2026-09-25):仓库选择器窗口铺满修复 + StartOptions 单位修正

**新日志(23:00)确认**:①触摸模式进仓库管理 ✓(第 28 轮绕过生效:点抽屉
仓库名 → createWindow → starter 窗口);②主窗口全程 [0,0,2800,1840] 全屏 ✓;
③但 `createWindow({})` 仍 16000067 → 裸 want 重试成功 → starter 窗口
全屏打开,**而 starter 的 UI 是内容自适应的 menu(尺寸随内容计算),
在全屏窗口里只占一角 → "无法铺满"**;④`force fullscreen (rect) failed:
1300002`(窗口状态异常)×2——布局全屏已成功的窗口拒绝 resize,该次
resize 若成功反而会错误收缩窗口。

**修复**:
1. **StartOptions 单位修正**(16000067 的真正来源,SDK 文档:
   windowLeft/Top 单位 px,windowWidth/Height 单位 **vp**;引擎几何为
   DIP=vp,此前尺寸被按 px 传入——父窗回退值 2800×1840 远超工作区
   被拒):位置×density 转 px,尺寸以 DIP 直传(vp);边框 px→DIP 换算后
   对称加入;createPixelMap 图标尺寸按 px。修复后 starter 以设计尺寸
   (800×650 DIP)启动,menu UI 铺满其窗口;16000067 不再出现,
   裸重试仅作最后兜底。
2. **forceFullscreenWindow 前置判断**:窗口已达全屏尺寸(布局全屏成功)
   时跳过——此前每次 PC 模式轮询都触发 1300002 噪声,且若该 resize 被
   接受反而会按避让区错误收缩窗口。仅浮窗恢复(窗口小于屏幕)时执行。

**"无法铺满"的机理解释**:starter 窗口因几何丢失走了裸重试 → 全屏打开;
starter 的 menu UI 尺寸随内容计算,在全屏窗口里只占左上一角,其余为
空白 → 用户看到"窗口全屏但管理界面铺不满"。本修复让窗口回归设计尺寸,
UI 铺满窗口。

### 第 30 轮(2026-09-25):第 24-29 轮新增改动五维审计

**审计范围**:第 24-29 轮全部代码改动(WebSubWindow/SubWindowAdapter/
AppWindowAdapter/WebAbility/SurfaceReady/update-obsidian.mjs v6/
drawer 文本补丁),对照 git 工作区与本文档记录逐项复核。

| 维度 | 结论 |
|---|---|
| 必要性 | 每项均有日志/用户反馈实锤:子窗口 0×0 竞态(22:06 日志 surface 0×0→修复后 536×61)、触摸穿透误伤(22:25 日志 14 次点击全落主窗口)、select 下拉渲染被引擎过滤(`filter sub window render`)、StartOptions 单位错误(16000067×2) |
| 正确性 | R29 单位修正与 SDK 文档逐字段核对(left/top px;width/height vp;DIP=vp 直传;像素图 px);回退几何 DIP 化(父窗 px÷density)消除 16000067;forceFullscreen 增加"已全屏即跳过"(修 1300002 并消除误收缩);已知风险:引擎 createWindow 从未传过有效几何,DIP 假设未经真机正面验证——若错,starter 尺寸放大 2.25 倍,首次运行即可见、可回退 |
| 安全性 | 无新增 IPC/文件/网络面;hookVaultSelect 只调用本地 openVaultChooser;文本补丁为仓库内常量替换;CI 的 eval 仅处理仓库内受控文件;日志不含敏感值 |
| 代码质量 | 关键决策均有"为什么"注释(引擎过滤/DIP 单位/仅主窗口);回退干净(DisplayMetrics 零引用);R25 的误判与回滚全程留档,教训:交互类改动必须先确认弹窗内容的真实身份 |
| 架构 | 触摸模式仓库链路收敛为一条可测路径:抽屉 select(tap 拦截)→ openVaultChooser → starter 窗口(修正单位的 createWindow)→ SurfaceReady → 浏览器;三层兜底(单位修正→几何修复→裸重试)有序且逐层留日志。已知债务:hookVaultSelect 是对引擎 select 渲染过滤的绕过,引擎修复后应移除(已注释标记) |

**回归核对**:第 26 轮回滚后无 setWindowTouchable 残留(grep 0);
DisplayMetrics 已删除;make-commits.sh 的 commit 4 已包含 SurfaceReady.ets
与 WebSubWindow/AppWindowAdapter 改动;changes 文档第 2/5b/5c 行与
第 15/17 轮最终态一致(第 27 轮核对)。

### 第 31 轮(2026-09-25):铺满修复(A 确认)+ 仓库切换焦点链路审计

**A 确认后的机理闭环**:23:00 日志中引擎对仓库窗口执行
`setWindowLimits(1800,1463,1800,1463)`(px,min=max,即 800×650 DIP 固定)
——引擎期望仓库窗口就是 800×650 DIP;而裸重试打开的全屏窗口与之矛盾,
内容自适应的 UI 在全屏窗口中只占一角 = "无法铺满"。第 29 轮的
**800×650 DIP 居中回退与引擎 limits 完全一致**,窗口与 UI 尺寸匹配。

**切换"跳回 1 仓库"的日志审计**:切换本身成功——obsidian2(仓库 2 窗口)
全屏打开并于 30.776 获得焦点(UpdateFocusState focus:1);34.119 该
Ability 被系统切到后台(interactive:0, state:2)→ 隐藏 → 焦点回到
仓库 1 主窗口。时间点与 starter 会话的异步清理完成吻合,属系统焦点
迁移行为;未发现我方代码主动切换焦点。待复现时抓取 34 秒前后的
完整日志确认触发者。

**耗电性审计(新维度)**:
1. `checkLoginTrigger` 3 秒轮询:此前每次轮询将整个 Context(约 7KB)
   序列化进 hilog 两行(每小时约 240KB 日志写入 + 字符串构建 CPU)——
   @LogMethod 已移除,23:00 日志确认为 0 ✓;
2. 登录触发轮询整体已判死移除(触发文件无写入方)✓;
3. SurfaceReady 轮询:有界(≤100×50ms)✓;模式文件 5 秒轮询:小文件读,
   可接受;MutationObserver:事件驱动、比较后写入,无循环 ✓;
4. settle 定时器均为一次性 ✓;avoidAreaChange 文件写入为事件驱动 ✓;
5. 遗留观察项:LogMethod 装饰器在热路径(getAvailableArea 每次点击成对
   触发、setBounds 连发)产生大量 hilog I/O——debug 构建可接受,后续
   可按日志级别门控。

### 第 32 轮(2026-09-25):居中丢失的级联修复——LaunchHelper 三级重试梯子

**新日志(23:53)结论**:切换链路已通(管理页 obsidian1 → 点击仓库 2 →
obsidian1 关闭 → obsidian2 获得焦点 18.801 ✓);但**第 29 轮的单位修正
后 16000067 依然出现**——几何已是合法 vp 仍被拒 → 被拒字段是
`processMode/startupVisibility` 配对而非几何。裸重试成功但**丢失了
居中几何** → 窗口全屏、不居中。这是选项被拒后的级联 bug,不是特性。

**修复**(LaunchHelper 三级重试梯子):16000067 时先用**仅几何的
StartOptions**(windowLeft/Top/Width/Height,保留居中位置与设计尺寸)
重试;仍失败才裸启动。全量 options 保留在首次尝试(在支持该 option 集
的系统上语义完整)。

**"不居中"定性**:bug(选项拒绝的级联),非特性。梯子生效后管理窗口
应为 800×650 DIP 居中。

**耗电性补充**:梯子的失败重试每次多一次 startAbility 调用(约毫秒级),
仅在 16000067 出现时发生;checkLoginTrigger 3 秒轮询日志已确认清零
(23:53 日志 0 条)。

### 第 33 轮(2026-09-25):收尾审计(第 30-32 轮新增改动 + 未覆盖文件)与分批提交

**六维审计**(必要性/正确性/安全性/代码质量/架构/耗电性):

| 维度 | 结论 |
|---|---|
| 必要性 | 三级重试梯子:23:53 日志实锤全量 options 必被 16000067 拒绝而裸启动丢失居中几何;800×650 居中回退:引擎 setWindowLimits(1800,1463) 实证设计尺寸;forceFullscreen 跳过:1300002×2 实锤 |
| 正确性 | 梯子 reduced 逐字段从原 options 提取(本轮补 displayId 透传,多显示设备场景不丢屏);仅几何子集不含 processMode/startupVisibility(规避被拒配对),也不含 startWindowIcon/BackgroundColor(非必需);居中计算 displayClass.width 为 px 与 widthDip×density 一致;已知风险:show=false 窗口经几何重试后以默认可见启动,引擎随后的 hide 会掩盖(闪光窗口,外观级) |
| 安全性 | 重试仅复用原 options 的几何/显示字段,无外部输入进入 startAbility;openVaultChooser 打开本地窗口;日志不含敏感值;BuildProfile.ets(本地签名数据)由 make-commits.sh 硬守卫拦截 |
| 代码质量 | 梯子每级独立日志(excute success/geometry-only retry/bare retry),失败链路可从单份日志定位;余留 outerWidth/outerHeight 旧变量清零(grep 0) |
| 架构 | 启动语义分层:全量(语义完整)→ 仅几何(位置尺寸)→ 裸(系统默认),每层降级不改变"窗口终将打开"的底线 |
| 耗电性 | 梯子仅在 16000067 时多一次 startAbility(毫秒级、无常驻);forceFullscreen 跳过减少了 2 次/启动的被拒系统调用;GeolocationAdapter 单一 GNSS 订阅共享、RunningLockAdapter 后台亮屏锁守卫、LogDecorator 256 字符截断+防循环——三个此前未单独审计的文件均属耗电/日志质量修复,与六维一致 |

**覆盖核对**:GeolocationAdapter(共享 GNSS 订阅省电)、RunningLockAdapter
(后台亮屏锁守卫省电)、LogDecorator(256 字符截断 + 防循环序列化,
兼具耗电与日志泄漏修复)——三者为早期耗电轮次产物,本次补审计并入。
make-commits.sh 增补 WebSubWindow.ets/LaunchHelper.ets/make-commits.sh
自身;BuildProfile.ets 守卫验证有效。

### 第 34 轮(2026-09-26):CI Release 包真机闪退根因修复(ArkGuard 混淆)与发布基建

**现象**:用户自行签名安装 CI 构建的 v1.2.0 unsigned HAP,启动即闪退
(约 0.2s,JSCrash:`TypeError: undefined is not callable`,堆栈为混淆名
`at e85 (c1/q1.ts:9:25)`,触发点为 libtimer 的 TimerCallback,发生于
AbilityStage 初始化;系统按 Kill Reason: Js Error 杀进程)。

**排查**:
- 排除 LFS:仓库 LFS tracked 文件经 checkout lfs:true 正常入包
  (Release HAP 208.7MB,与 libelectron.so 160MB + asar 25MB 吻合);
- 排除签名:签名错误会在安装环节失败,不会进入运行时;
- 排除 SDK 组合:本地验证过的组合为 compatible/target 6.1.1(24),
  CI 原默认 compatible 6.0.2(22) 已改齐(2e864c7 并参数化 build_mode,
  供隔离验证用);
- 实锤:两模块 build-profile.json5 的 release buildMode 启用 ArkGuard
  (ruleOptions.enable: true),且 obfuscation-rules.txt 四项全开
  (property/toplevel/filename/export)。debug 构建不跑混淆器,故本地
  一直正常。闭源引擎经 JSBind 按名回调 ArkTS + 动态查找,改名后回调
  解析为 undefined。

**修复**:
- electron/web_engine 两个 obfuscation-rules.txt 改为
  `-disable-obfuscation`(四项 -enable-* 注释保留)并注释原因;
- AppScope/app.json5 版本提 1.2.1(versionCode 1020001);
- `napi_unwrap fail` 判定为模块注册期良性探测(崩前 40ms 出现,非死因)。

**发布基建**(此前轮次延续):
- 产物重命名 OHSidian-v<版本>-<unsigned|signed>.hap,哈希与工具指引
  (小白调试助手/DevEco)写入 Release 正文,正文来自可编辑模板
  scripts/ci/release-notes-template.md;
- workflow_dispatch 新增 compatible_sdk/target_sdk/build_mode 输入,
  默认对齐真机验证组合 6.1.1(24)/6.1.1(24)/release;
- 签名 Secrets 未配置时仍发 unsigned 包,文档引导用户用图形化工具签名。

### 第 35 轮(2026-09-26):窗口模式双关闭按钮修复(系统标题栏 vs Obsidian 自绘控件)

**现象**:release 包在平板 PC 模式(自由多窗)的窗口模式下,窗口顶部出现
两个关闭按钮:系统为自由窗口绘制的标题栏(min/max/close)与 Obsidian
桌面 UI 自绘的 `.titlebar-button-container.mod-right` 叠加。全屏(触摸
模式)下系统不画标题栏,故无冲突。

**修复**(信号通道复用 ohsidian-mode.json):
- ArkTS `pushSafeAreaInsets` 增加 `windowDecor` 字段:'system' 当
  pcModeEnabled(平板 PC 模式自由窗口,系统绘制标题栏),'none' 其他;
  启动(543/549)与 PC 模式切换(697)路径均已覆盖,写入即时生效;
- 渲染层补丁升 v7(TOUCH_MODE_PATCH):`applyWindowDecor` 按
  cfg.windowDecor==='system' 挂载/卸载
  `.titlebar-button-container.mod-right{display:none!important}`;
  启动、DOMContentLoaded、5s 轮询三处调用;guard 6→7 防旧补丁残留;
- update-obsidian.mjs 文档注释同步(补丁 v7)。

**asar 原位替换**:仓库 asar 已含 v6 补丁,update-obsidian.mjs 是
"下载原版→打补丁"流程,不适合重跑;采用剥离 v6(精确前缀 + END 标记)
→ 前置 v7 → createPackage 重打包,验证:vm.Script 语法通过、v6 残留 0、
guard 7×1、applyWindowDecor×4(1 定义 + 3 调用)、END×1、
openVaultChooser 钩子保留。

**遗留说明**:2in1 设备窗口若系统同样绘制标题栏,需另行确认后把
windowDecor 条件扩展;补丁生效依赖模式文件,切换 PC 模式后有系统
重载,延迟可忽略,轮询兜底 ≤5s。

### 第 36 轮(2026-09-26):关闭自动更新、删除路由到 .trash、图标答疑

**1. 关闭默认自动更新**(主进程补丁):main.js 的更新器门控为
`(at||D.updateDisabled)&&(e.emit("disable",!0)`;文本替换为
`(at||(D.updateDisabled=!0))&&...`——每次启动锁死 updateDisabled 并
广播 disable,设置页显示"Updates are disabled"。注意 `||` 优先级高于
`=`,赋值必须自带括号(第一版 `(at||D.updateDisabled=!0)` 是非法
左值,vm.Script 语法校验拦下后已修正)。鸿蒙分发走本仓库 Release,
更新器只会白白耗电探测 obsidian.md。

**2. 应用内删除 → 回收站**:HarmonyOS 不向三方应用开放系统回收站
API,引擎的 fs.trash 桥要么失败要么(最坏)直接 unlink。补丁 v7 增加
hookTrash:实例级覆写 vault.trash 强制走 trashLocal 分支(Obsidian
自带 .trash 文件夹,纯 JS mkdir+rename,可恢复),并覆写
getConfig("trashOption") 返回 "local" 保证删除确认框文案诚实;
boot/DOMContentLoaded/5s 轮询三处接线,插件调用同样受益。

**3. 图标答疑**:AppScope/resources/base/media/app_icon.png 随包分发,
桌面正常显示(日志 getCombIcon combinePicLength:40682 实证);
HarmonyOS 无运行时换图标机制,"自定义图标"= 替换该资源重新打包。

**asar 原位替换第二次**(app.js v7+hookTrash、main.js 更新门控):
双文件 vm.Script 语法校验通过;hookTrash×4、decor×4、guard7×1、
END×1、GATE_DEF/IPC guard/deeplink bridge/openVaultChooser 钩子全部
保留;UPDATER_DST 修正后重打包验证。

### 第 37 轮(2026-09-26):按官方沉浸式链路重推窗口状态机(顶部避让 + 双 X 根修)

**官方链路(API 24)应为**:① loadContent 前 setWindowLayoutFullScreen(true);
② 窗口矩形 = 整块屏幕 (0,0,display.w,display.h),不做避让加减;
③ avoidAreaChange/windowSizeChange → 读 TYPE_SYSTEM/TYPE_NAVIGATION_INDICATOR
的窗口相对矩形;④ 发布真实 insets 给渲染层 CSS 避让;⑤ 自由窗口的标题按钮
由 WMS 绘制,渲染层藏自绘控件。

**断点 1(顶部避让)**:forceFullscreenWindow 旧实现 resize 成
display.height−topInset 并挪到 y=topInset——状态栏区域变成窗口外死区
(应用背景不延伸到状态栏下),且窗口相对避让矩形归零,渲染层永远拿到
top=0。这解释了"底部好了、顶部没好"(窗口底部贴屏底,insets 有效)。
修复:resize(display.w, display.h) + moveWindowTo(0,0),死区消失,
insets 恒为真实条高;若 layout fullscreen 被拒,WMS 会把窗口钳到工作区,
几何避让自动生效,两条路都成立。

**断点 2(双 X)**:windowDecor='system' 只认 PC 模式开关,浮窗/分屏等
非 PC 模式自由窗口不触发。修复:按窗口实际尺寸判定——不铺满整屏的窗口
(PC 窗口/浮窗/2in1 桌面窗口)WMS 必画标题按钮 → 'system';铺满整屏的
触摸模式窗口 → 'none'。顺带覆盖 2in1 遗留项。

**配套**:windowSizeChange 监听器补 pushSafeAreaInsets(普通 resize 不
触发 avoidAreaChange,decor/insets 需跟随窗口矩形刷新);writeInsetsToFile
加变化检测(拖动高频触发时跳过未变化的文件写入与日志)。

**验证路径**:重建后触摸模式看状态栏(应用背景应在状态栏下延伸、内容
避让);窗口模式应只剩系统标题按钮一个 X;hilog 中 avoid-area
diagnostics 行可核对 systemAvoid.topRect.height 与发布的 top 一致。

### 第 38 轮(2026-09-26):首次启动"快速开始"报 folder not found 根修

**链路还原**(asar 实证):
- starter 快速开始按钮:`get-default-vault-path` → `vault-open(路径,true)`
  → 失败后**去掉创建标志重试** `vault-open(路径,false)` → 再失败则弹窗
  "Failed to open vault <错误>."(用户看到的 folder not found);
- `get-default-vault-path` 返回 `Kt=<Documents>/Obsidian Vault`
  (`F=app.getPath("documents")`),而鸿蒙沙箱内应用 Documents 不可写:
  vault-open 的 mkdirSync 抛 EACCES → 重试时目录不存在 → p() 返回
  "folder not found";
- 引擎对 asar 内部路径有完整 fs 支持(libelectron 内嵌完整
  asar-fs-wrapper),排除沙盒模板复制源问题。

**修复**(MAIN_PROCESS_PATCH 追加 IIFE):app ready 后注册
`get-default-vault-path` 的**后置监听器**(覆盖 returnValue),把默认
仓库重定向到 `<userData>/Obsidian Vault`(模式文件同根,可写性已被
实证),并用 mkdirSync 预创建。globalThis 守卫防重复注册。

**asar 原位替换第三次**:main.js 前缀刷新(正文保留更新器锁死与版本门);
vm.Script 语法通过,DefaultVault/updater latch/gate/deeplink/END×1 全部
在位;app.js 未动(hookTrash×4/decor×4/guard7×1)。

### 第 39 轮(2026-09-26):窗口模式标题栏反转——系统按钮隐藏,Obsidian 自带标题栏成为唯一标题栏

**用户反馈**:右上角 X 与右上角功能打架,要求独立的信息栏(名称+关闭/
放大/缩小),不与内容混叠。

**关键发现**:WebBaseAbility 的 minimizable/maximizable/closable 默认全
true——启动时 `setWindowTitleButtonVisible(true,true,true)` 是**主动请求
系统按钮显示**。双 X 的来源是应用自己的请求,不是 API 失效;因此隐藏
请求同样可信。

**新方案**(pushSafeAreaInsets 重构):
- 自由窗口(非整屏):setWindowDecorVisible(false) +
  setWindowTitleButtonVisible(false,false,false) 隐藏系统标题按钮,
  windowDecor='app' → 渲染层不藏任何东西,Obsidian 自带标题栏(名称+
  三个按钮,经引擎接真实窗口操作)成为唯一标题栏,与内容分离;
- 系统 API 抛错时 windowDecor='system' 回退(渲染层藏自绘按钮,至少
  消除双 X);
- 整屏(触摸模式)windowDecor='none' 不涉及。
- 每次窗口尺寸变化/PC 模式切换重新求值(标题按钮只在成为自由窗口后
  存在,启动时的一次性调用覆盖不到)。

渲染层补丁无需改动('system' 才注入隐藏 CSS,'app'/'none' 均不注入,
与新语义天然一致);touch-mode 补丁文档注释更新。

### 第 40 轮(2026-09-26):首次进入视口超宽 + 多窗口标题栏消失(以代码为准的再修)

**问题 1(触摸模式首次进入上下超宽,重进缓解)**:引擎只在浏览器启动时
读取一次 XComponent surface 尺寸;首次进入时窗口几何仍在过渡(恢复矩形
→ 强制整屏),首次非零报告冻结了过渡期视口 → 内容溢出屏幕边缘。退出再
进入时窗口直接以最终尺寸创建,首次读取即正确 → 症状消失。
修复:
- SurfaceReady 门控加**稳定条件**:相同的非零矩形连续 3 次轮询
  (150ms)才启动浏览器, MAX_ATTEMPTS 兜底不变;
- 首次启动的 startupSettle 强制参数从 false 改为
  `tablet && !pcModeEnabled`——触摸模式首启也强制整屏矩形,消除过渡。

**问题 2(多窗口模式标题栏整条消失)**:上一轮的"隐藏系统按钮 + 期待
Obsidian 自带标题栏"在**模拟移动布局**下失效——移动布局根本没有
.titlebar(全局 isMobile 化),系统按钮又被我们藏了 → 整条消失。
修复:反转回"让系统添加"——自由窗口保留并显示系统标题条
(setWindowDecorVisible(true) + 按钮全显),windowDecor='system';
新增 captionCss 字段(windowTitleButtonRectChange → 条高 ≈ top+height,
1vp==1csspx)发布到模式文件 cfg.caption;渲染层在 'system' 时**整体
隐藏 web .titlebar**(避免双栏)并给 body 加 paddingTop=caption,
两种布局下内容都避让系统标题条;整屏 'none' 不涉及。
教训:装饰显隐调用发生在启动时(窗口还是全屏,自由窗口标题条尚不
存在),必须随窗口尺寸变化重新求值(上一轮已加,本轮延续)。

**asar 原位替换第四次**(app.js 补丁刷新):vm 语法校验通过(注:
createPackage 落盘与紧随的 rename/读取存在瞬时竞争,两次出现
"Unexpected end of input"假象,重新读取验证均完好;后续脚本需加
重试验证)。main.js 本轮未动。

### 第 41 轮(2026-09-26):输入法高度透传,修复移动格式化工具栏被键盘遮挡

**机制(asar 实证)**:触摸模式下编辑器底部的格式化工具栏(加粗等)定位
为 `top: calc(100vh - var(--keyboard-height) - var(--mobile-toolbar-height))`,
并监听 keyboardWillShow/keyboardWillHide DOM 事件做动画——真机上这些由
Capacitor 键盘插件提供,引擎侧 IMFAdapter 只转发文字输入事件
(insertText/delete/cursor),**键盘高度从未进入渲染层**,工具栏沉底被
键盘盖住。CSS 另有 `.is-mobile .app-container{max-height:calc(100vh -
var(--keyboard-height))}` 同样消费该变量。

**修复**:
- ArkTS:主窗口监听 `keyboardHeightChange`(物理 px ÷ density → css px),
  变化时经 pushSafeAreaInsets 发布 `cfg.keyboard`;
- 渲染层:applyKeyboard 在 documentElement 上设置 `--keyboard-height` 并
  派发 keyboardWillShow/keyboardWillHide,复用 Obsidian 自己的动画与定位;
- 轮询改自适应:编辑焦点内 400ms(工具栏须快速跟随键盘),空闲 5s(省电),
  setTimeout 链替代固定 setInterval。

**asar 原位替换第五次**:本机验证脚本连续 5 次 "Unexpected end of input"
而事后直读完好——确认 createPackage 落盘与紧随的 rename/read 存在
Windows 落盘竞争,后续脚本统一带重试验证。终态 vm 语法通过,
keyboard/pollTick/hookTrash/drawer 全部在位。

### 第 42 轮(2026-09-26):仓库与 .trash 的文件管理器可见性(迁移命令)

**需求**:应用内仓库/垃圾桶(默认在应用沙箱 userData)无法被系统
文件管理器访问。

**机制结论(asar/引擎代码实证)**:
- 鸿蒙沙箱是硬约束:应用私有目录无法暴露给系统文件管理器;
  ohos.file.fileShare 只能对指定应用授权 URI,做不到"整体出现在
  文件管理器"。
- 正确姿势 = 把仓库放进**系统文件夹选择器授权的用户可见目录**:
  DialogAdapter 已实现 DocumentViewPicker(FOLDER 模式)+ 
  FILE_ACCESS_PERSIST 持久授权("下次打开无需重复授权"),选择器里
  看到的位置与文件管理器同源,仓库及其 .trash 随之可见。

**新增**:命令面板命令 "OHSidian: 迁移仓库到文件管理可见的位置"——
调起系统文件夹选择器 → 把当前仓库全部文件(含 .trash、.obsidian 配置)
递归复制到所选目录 → 经引擎 vault-open 打开新仓库。迁移为纯复制,
原仓库不动(失败可重试,无数据风险)。

**asar 原位替换第六次**:落盘竞争假象再次出现(重试 8 次内均读到
截断内容,数秒后自愈)——后续此类脚本的重试窗口需拉长到秒级;
终态直读 vm 语法通过,migrate/cmd/keyboard/trash 钩子全部在位。

### 第 43 轮(2026-09-26):窗口模式标题栏与内容之间的白条(双重避让)

**现象**:触摸→窗口模式切换后,系统标题栏与内容之间出现白色空条;
窗口模式直接启动则没有。

**根因(asar/ArkTS 代码实证)**:双重避让。引擎视口在 PC 模式下取
drawableRect——系统标题栏(setWindowDecorVisible(true) 后)已从可绘制
区排除,内容天然从标题条下方开始;而渲染层又给 body 加了
padding-top=caption 高度 → 内容再让一次,两次避让之间露出 body 白底。
"直接打开无白条"佐证:windowTitleButtonRectChange 首个事件发生在
监听器注册之前(该回调按引擎要求必须注册于 loadContent 之后),
captionCss 保持 0,未加 padding。

**修复**:移除渲染层的 body padding(applySafeArea 回归纯 insets 职责);
caption 字段保留发布(诊断/后续用途),渲染层不再消费。标题条避让
完全交给引擎 drawableRect 链路。

**asar 原位替换第七次**:确认 @electron/asar 模块在**同一进程内缓存
归档头**——rename 后同进程 extractFile 走旧头读新文件,必然截断假象
(本轮重试 20 秒仍失败即为确定性证据);**新进程首次读取才是可信
验证**。终态直读 vm 语法通过,padding 移除、migrate/keyboard/drawer
钩子全部在位。

### 第 44 轮(2026-09-26):应用图标变体(构建期选择)

**需求**:在 Obsidian 里切换应用图标(OHSidian / 原版 Obsidian / iPadOS 风格)。

**能力边界(先核实)**:鸿蒙**没有运行时更换桌面启动图标的公开 API**
(安卓的 activity-alias 技巧不存在;bundleManager 的 ability 启停是
系统 API)——"应用内切换立即生效"做不到。引擎虽有 set-icon/get-icon
IPC,但那只影响引擎内部窗口图标,不动桌面启动图标。

**方案:构建期选择**(确定性路径):
- 三套图标入库 `AppScope/resources/base/media/icons/`:ohsidian.png
  (现有图标,深蓝光环合成)、obsidian.png(官方 GitHub 头像,深底宝石
  460×460)、ipados.png(官方 App Store 图标,iTunes API artworkUrl512,
  512×512,JPEG→PNG 转换)。注意:asar 内的 icon.png 是 OHSidian 自己
  的宝石元素,不是官方独立图标(用户指正后已替换为真官方资产);
- CI 新增 `app_icon` 输入(ohsidian/obsidian/ipados,默认 ohsidian;
  也可用仓库变量 APP_ICON 做标签构建的默认值),构建前把所选图标
  复制为 `app_icon.png` + `startIcon.png`(启动图标同源,均解析到
  AppScope media);变体文件缺失时告警并回退 ohsidian。

**使用**:手动触发出包时在 app_icon 下拉里选;要换桌面图标=用对应
变体重装(覆盖安装,数据保留)。标签构建默认 ohsidian。

### 第 45 轮(2026-09-26):图标第四变体 + README 对外说明

- 图标新增 `ohsidian-gem`(原版 OHSidian 裸宝石,自 asar 提取)——
  用户指正 asar 内宝石即 OHSidian 图标元素,与光环合成版并列为两个
  OHSidian 变体;CI `app_icon` 选项扩为
  ohsidian / ohsidian-gem / obsidian / ipados;
- README 新增 "本 Fork 相对原版的改进" 章节(窗口与显示/输入与首次
  启动/数据安全与耗电/深链与工程化,链接 CHANGES 全记录),并修正
  过时的版本信息表(1.0.0→1.2.1,API 22→24)。

### 第 46 轮(2026-09-26):应用内切换图标可行性调研(以本地 SDK 代码为准)

**需求**:在 Obsidian 内切换启动图标(OHSidian/原版宝石/官方/iPadOS)。
用户提供了官方动态图标文档(appInfoManager,@kit.AppGalleryKit,API 15+)。

**SDK 实证结论**(DevEco 本地 SDK d.ts 核对):
- `@hms.core.appgalleryservice.appInfoManager.d.ts`:DynamicIconInfo
  的 iconUrl 为远程 URL,错误码含 service extension connect failed——
  动态图标由 AppGallery Connect 云侧管理、图库服务扩展下发,
  **要求应用市场分发身份**;自签名侧载(GitHub Release 分发)无
  AGC 记录,queryDynamicIcons 返回 1006800010/连接失败;
- `bundleManager.setAbilityEnabled`(安卓多 LAUNCHER ability 技巧的
  对应物):公开 SDK 中仅有文档交叉引用,**无函数声明**——@systemapi
  系统接口,公开 SDK 已剔除。

**结论**:自签名分发模式下,应用内切换启动图标的两条官方路线均不可用,
属分发模式硬约束。图标变体维持构建期选择(CI app_icon 输入)。
若未来转 AppGallery 分发,appInfoManager 路线可用,届时可按
queryDynamicIcons/selectDynamicIcon/disableDynamicIcon 接入命令面板。

### 第 47 轮(2026-09-26):CI 构建矩阵——每个 Release 同时出 ohsidian/ipados 两种图标

**需求**:一次构建同时产出两种图标的包(原 OHSidian / iPadOS 官方),
供用户按桌面观感选择下载。

**实现**:工作流重构为两段——
- `build` 作业以 strategy.matrix(icon: [ohsidian, ipados])并行双分支,
  各自物化图标 → 构建 → 产物命名
  `OHSidian-v<版本>-<icon>-<unsigned|signed>.hap`(避免同名冲突),
  独立上传 artifact;
- 新增 `release` 作业(needs: build,仅 tag 触发):checkout 模板与
  版本号 → download-artifact(merge-multiple)合并两分支产物 →
  重新汇总 SHA256/MD5 → 渲染发布说明(模板表格循环自动列出两个
  HAP)→ 创建单一 Release。单发布作业避免两分支竞争同一 tag。
- 原 app_icon 手动输入移除(矩阵固定两分支);ohsidian-gem/obsidian
  变体文件保留在 icons/ 目录,需要时把矩阵扩成三/四分支即可。

### 第 48 轮(2026-09-26):图标变体更名 + Release 双版本说明 + README 刷新

- 图标变体 `ipados` 更名为 `obsidian`(正常 Obsidian 官方图标,
  App Store 512×512 资产);矩阵改为 [ohsidian, obsidian];
  GitHub 头像版(与之几乎相同)移除,避免同质变体;
- Release 发布说明:下载表格按文件名区分"OHsidian 图标版 /
  Obsidian 官方图标版",模板正文说明两版本功能一致、按喜好选择;
- README 刷新:删除华为云同步章节、AGC 配置小节、TOC/简介相关
  条目(云同步功能未上线,不再宣称);自动更新章节改写为本 Fork
  已关闭更新、升级走 Release;Fork 改进章节的图标描述同步;
  适配层清单/依赖说明中的 CloudSync 条目为代码事实描述,保留。

### 第 49 轮(2026-09-26):接入系统字体(HarmonyOS Sans 优先)

**机制实证**:libelectron.so 内含 SkFontMgr_OHOS、
OH_Drawing_GetSystemFontConfigInfo、/system/fonts、HarmonyOS Sans——
引擎 Chromium 已对接鸿蒙系统字体管理器,系统字体对 web 内容可见
(引擎侧无需任何改动)。

**问题**:Obsidian 的默认字体栈 `--font-default` 是桌面系
(ui-sans-serif/Segoe UI/Roboto),在鸿蒙上基本落空;设置里
override(用户自选字体)永远优先,但未设置时的默认渲染没吃到
系统字体。

**修复**(渲染层补丁):注入常驻样式,把 `--font-default` 改为
"HarmonyOS Sans"/"HarmonyOS Sans SC"/"HarmonyOS Sans TC" 优先、
原桌面栈兜底;等宽栈不动(CJK 由逐字回退处理)。用户在
设置 → 外观里自选的字体仍然优先。

### 第 50 轮(2026-09-27):窗口状态机重构——启动不最大化、定时补丁全删、标题条拖动根修

TODO.md 1-6 项(窗口记忆化/启动不最大化/标题拖动/边框联动/切换 bug/
状态机重构)作为一个整体施工。新规范文档 **docs/window-state-machine.md**
(形态 × 事件 → 期望动作,代码必须与表一致)。

**以代码为准的三个关键实证**:
1. **记忆化本来就有,ArkTS 不用做**:Obsidian 桌面主进程把每窗口 bounds
   写 `<userData>/<vaultId>.json`(main.js `me()/pe()/ee()`),启动时
   `pe(u)` 恢复 x/y/w/h(`Dt()` 校验落屏),`isMaximized` 为真才最大化,
   经 BrowserWindow 构造参数 → 引擎 CreateWindow → StartOptions 生效。
   系统恢复的悬浮窗在窗口形态正是记忆化本身,只有触摸形态才需要矫正。
2. **标题条拖不动的根因**:窗口模式(自由窗口)下 layout fullscreen 仍
   处于开启状态(启动无条件调用),web surface 铺满整个窗口矩形、盖在
   WMS 标题条的拖动热区之下,点击全部落入 web 内容。
3. **补推竞态**:启动 600/1500/3000ms 三连与切模式 500/1500ms 双连
   setTimeout 补推,会在 WMS 落定前把旧矩形推给引擎,正是"偶发窗口
   不匹配/无响应"的温床(引擎 MoveToAsync 布局超时已有记录)。

**WebAbility.ets 变更**:
- `setWindowLayoutFullScreen(true)` 只在触摸形态(平板无 PC 模式/手机)
  的启动路径调用;新增 `applyLayoutFullscreenForMode()` 在每次模式切换
  时把该标志复位成与形态一致(窗口模式显式 false)——拖动热区归还给
  WMS 标题条;
- 删除 `settleViewportLater` 与全部 setTimeout 补推(含 2s avoid-area
  诊断 dump);启动时触摸形态**同步**调用一次 `forceFullscreenWindow()`
  (SurfaceReady 稳定门保证引擎在窗口定形后才读 surface,补推冗余);
- 切回触摸模式同样单次 `forceFullscreenWindow()`;进入窗口模式仍走
  `clampWindowToWorkArea()`(唯一保留的几何矫正,职责见状态机 §2);
- AppWindowAdapter 的 `setFullScreen/setSimpleFullScreen`(Electron 显式
  全屏 API)保留不动——那是用户主动行为,非启动补偿。

**验证要点**:平板窗口模式从系统标题条按住拖动应可移动窗口;触摸/窗口
模式来回切换各 5 次无窗口失配;触摸模式冷启动铺满;窗口模式启动大小=
上次关闭时大小(主进程记忆化)。

### 第 51 轮(2026-09-27):键盘高度纯事件驱动(去轮询)

TODO 8。渲染层删除 `isEditing()` 自适应轮询(编辑焦点内 400ms/空闲 5s,
最坏一个周期延迟+空闲耗电),统一为单一 **200ms 文件内容变化检查**:
`pollTick` 每周期只做一次小 readFileSync,内容与上次相同则零工作;内容
变化时才重跑 applyKeyboard(更新 `--keyboard-height`、派发
keyboardWillShow/Hide 各一次)与 decor/trash/模式同步。ArkTS 侧
`keyboardHeightChange` 每次变化都写模式文件(unchanged 检测只跳过同值,
不合并不同值),键盘弹出→工具栏跟随延迟收敛到 ≤200ms;安全键盘等无事件
场景如确认存在,兜底归 ArkTS 侧补事件源,不在渲染层恢复轮询。

### 第 52 轮(2026-09-27):"恢复系统字体"命令(默认态即系统字体)

TODO 7。机制实证(asar):Obsidian 字体设置写 `interfaceFontFamily /
textFontFamily / monospaceFontFamily`,经 `updateFontFamily()` 落为
`--font-*-override`(css 链:override → theme → --font-default);用户
自选字体永远优先,而**空 override 时默认栈生效——第 49 轮已把
--font-default 改为 HarmonyOS Sans 优先,故"开箱即系统字体"在默认态已
成立**。设置里原生没有"系统文字"选项(字体选择器 minified),新增命令
面板命令 **"OHSidian: 恢复系统字体 (HarmonyOS Sans)"**:清空三个字体
配置项(vault.setConfig,触发 config-changed → updateFontFamily)+移除
body 内联 override,渲染立即回到系统字体。优先级保持:用户自选 >
系统默认。

### 第 53 轮(2026-09-27):窗口边框样式联动核对(结论:实现正确,无需改码)

TODO 4 核对(细节见 docs/window-state-machine.md §8):设置三档经
main.js `Ae(frame)/Ue(titleBarStyle)` 在窗口创建时生效(hidden/custom
→ frameless,Obsidian 自绘 .titlebar;native → frame:true 系统装饰),
与 ArkTS `setWindowDecorVisible(!hideTitleBar)`(默认 true→无系统条)、
平板自由窗口 pushSafeAreaInsets 强制系统标题条(decor='system')的既有
决策不冲突;"隐藏→系统边框、Obsidian 风格→自绘边框"的期望映射方向
经 asar/引擎两侧核实无误。

### 工具链

- `scripts/refresh-app-patch.mjs`:asar 原位补丁刷新(strip 旧标记 →
  前缀新补丁 → createPackage → 回写),**新进程验证**拆分到
  `scripts/verify-asar.cjs`(语法 + 全部补丁标记,规避 @electron/asar
  同进程头缓存——第 43 轮教训的脚本化)。本轮刷新后验证全绿:
  语法 OK / 键盘事件驱动 / 系统字体 / 恢复字体命令 / trash / IPC
  guard / updater 关闭 / 默认仓库 / 深链桥全部在位。

### 第 54 轮(2026-09-27):模式切换后"文章变了"——跨布局同步当前文件

**根因(asar 实证)**:Obsidian 桌面/移动布局使用**两份独立的工作区文件**
——`.obsidian/workspace.json`(桌面)与 `.obsidian/workspace-mobile.json`
(模拟移动,`rd.isMobile ? e4 : J6`)。EmulateMobile 开关切换后重载,
`loadLayout` 从**另一份**文件恢复布局/活动叶,打开的自然是那个布局上次
的文章——这是原版设计(移动抽屉 vs 桌面分栏本就不同布局),不是 bug,
也无法合并两份布局。

**缓解**(渲染层补丁):applyMobile 在写入开关与重载**之前**执行
`syncActiveFileToTargetLayout(on)`——把当前活动文件路径写入**目标布局**
文件的 `lastOpenFiles` 头部(去重、上限 26)。空主布局(该布局此前无
文章)启动时 Obsidian 会打开 `getLastOpenFiles()[0]`(setLayout 实证,
case 8 分支),已有布局的用户也可在"最近文件"里一眼看到刚读的文章。
两份布局文件本身仍各自独立,桌面分栏/移动抽屉结构不受影响。

**工具链**:`scripts/refresh-app-patch.mjs` 支持带旧补丁的 asar 幂等
刷新;`scripts/verify-asar.cjs` 增加 mode-switch 文件同步标记检查,
本轮新进程验证全绿。

### 第 55 轮(2026-09-27):系统字体大小(followSystem)透传进 Obsidian

**现状核实**:AppScope 早已配置 `fontSizeScale: followSystem`
(`AppScope/app.json5` 引用 `configuration.json`,maxScale 1.45)——用户
提供的官方配置法在本项目**已经生效**,无需重复设置。fp 单位的原生文本
(arkts UI)会跟随系统字号,但引擎 web 内容不在此列。

**机制实证**:
- 引擎侧(libadapter/libelectron 字符串核对)有
  `ScreenAdapter::GetFontSizeScale` 与 `ElectronApp.GetFontSizeScale`
  绑定,但 **libelectron 从未查询**该绑定,Chromium 亦无字体缩放应用
  痕迹——web 内容拿不到系统字号缩放;
- Obsidian 自有字号体系:设置 → 字号写 `baseFontSize`(10-30 钳制),
  `updateFontSize()` 落为 `--font-text-size` + `html font-size`;
- SDK 实证(`@ohos.settings.d.ts`、`Configuration.d.ts`):
  `settings.display.FONT_SCALE` 可同步读当前缩放,
  `onConfigurationUpdate(config)` 携带 `config.fontSizeScale` 在变化时
  推送(API 12+,本机 24 满足)。

**"打架"分析与合成策略**:系统缩放与 Obsidian 字号是**两层不同维度**——
前者是用户对整个系统的无障碍缩放,后者是应用内排版基准。二者不该互斥,
应可组合:渲染层以 Obsidian 的 `baseFontSize` 为基准、乘系统缩放系数,
`--font-text-size = baseFontSize × fontScale`;系统缩放=1 时完全移除
覆盖,Obsidian 自己的设置原样生效(零回归)。应用内改字号立即生效
(updateFontSize 直改 CSS 变量,先于我们的覆盖),系统改字号 200ms 内
经模式文件跟随。UI 布局尺寸(px 定宽元素)不随缩放,避免乱版。

**实现**:
- ArkTS(WebAbility):启动读 `settings.display.FONT_SCALE` 写入
  `cfg.fontScale`(onConfigurationUpdate 只报变化,初值必须补);
  `onConfigurationUpdate` 捕获 `config.fontSizeScale` 变化续写模式文件;
- 渲染层(补丁):新增 `applyFontScale()`,挂在统一的"文件变化"消费者
  上,把 `--font-text-size`/`html font-size` 设为基准×缩放(边界
  0.5x-3.2x);scale=1 时恢复 Obsidian 原值,不做任何额外干预。

**验证要点**:系统字体大小调到"大",Obsidian 正文应在 1s 内变大、UI
不乱版;应用内 字号 改动仍然即时生效;缩放回到"标准"后与原版行为一致。

### 附:TODO.md 与 .gitignore/.zcodeignore 清理(2026-09-27)

- TODO.md(个人备忘)、.zcodeignore(ZCode 工作区配置)加入 .gitignore;
- `web_engine/BuildProfile.ets` 为 hvigor 生成文件(随 debug/release
  反复变化),git rm --cached 移出跟踪并加 `**/BuildProfile.ets` 忽略
  规则(与 make-commits.sh 的硬守卫双保险);
- .zcodeignore 同步以上规则;
- 根目录 hs_err_pid*.log(JVM 崩溃转储)已被 `*.log` 覆盖,确认不入库。

### 第 56 轮(2026-09-27):窗口标题条拖不动的真根因(移动能力被禁用)+ 最大化后底部内容被导航条遮住

**问题一:标题条拖不动(用户反馈持续存在)**

**真根因(代码+SDK 实证,推翻此前"layout fullscreen 热区"推断的主导地位)**:
- 启动链路:`setWindowTitleMoveEnabled(!hideTitleBar)`,而主窗口
  `hideTitleBar` 默认/来自引擎的值是 **true**(无框 BrowserWindow)→
  **启动时 WMS 标题拖动能力被显式关闭**;
- 第 40 轮加的 pushSafeAreaInsets 的 decor='system' 分支把系统标题条
  **重新显示**,但**从未重新启用拖动能力**——条看得见却拖不动;
- 用户建议的 parallelGesture/priorityGesture 方向核实结果:ArkTS 侧
  PanGesture 仅转发滚轮/捏合给引擎(MultiInputAdapter 对 Finger 源
  直接丢弃),不在标题条热区,不是根因;引擎**没有实现**
  -webkit-app-region(libelectron.so 无 DraggableRegions 接口),系统
  标题条是唯一拖动面,`setWindowTitleMoveEnabled` 就是官方开关。

**修复**(三处,方向=让"可移动"与"可见标题条"始终同步):
1. onWindowStageCreate:`setWindowTitleMoveEnabled(true)` 无条件启用
   (全屏窗口无标题条,启用无副作用);
2. pushSafeAreaInsets 的 decor='system' 分支:显示标题条的同时
   `setWindowTitleMoveEnabled(true)`;
3. AppWindowAdapter.setUseNativeFrame:改为 `setWindowTitleMoveEnabled(true)`
   (隐藏系统边框时条本身不绘制,启用不损耗;防止用户切换
   Obsidian 风格边框后拖动被永久关闭)。

**问题二:平板窗口模式最大化后,底部导航条变高、显示截断一截、内容不更新**

**机制**:自由窗口被最大化后 windowRect 变为整屏(边到边),导航指示条
浮在窗口之上;但系统上报的 drawableRect **不扣除**该导航条 →
computeViewportBound(PC 分支)用 drawableRect 合成视口 → 引擎视口比
可见区域高一条导航条的量 → 底部内容被遮、且该状态只在"最大化"路径
出现(普通拖拽 resize 的 drawableRect 语义正确,故只有全屏化复现)。

**修复**:
- computeViewportBound(PC 分支):对"全屏化"的自由窗口(整屏判定)显式
  扣除真实避让区(TYPE_SYSTEM/TYPE_NAVIGATION_INDICATOR 的 bottom/left/
  right);非最大化自由窗口维持 drawableRect 语义不变;
- windowStatusChange:MAXIMIZE/FULL_SCREEN/FLOATING 翻转时补推
  pushSafeAreaInsets + repushViewportBounds(最大化动画可能不尾随
  windowSizeChange——用户看到的"内部画面没有更新"即此);
- windowRectChange:同样补 pushSafeAreaInsets(状态文件里的 caption/
  decor 须跟随新矩形)。

**验证要点**:窗口模式拖系统标题条应即刻可拖动;双击标题条最大化/
还原各 3 次后底部内容始终完整可见;最大化状态下上下留白=系统栏高度,
无截断;触摸模式行为不变。

### 第 57 轮(2026-09-27):跨布局同步修正——上一版只写 lastOpenFiles 是无效方案

**审查发现(上一轮方案失效原因)**:第 54 轮把当前文件写进目标布局的
`lastOpenFiles` 头部,但 asar 复查证实 `setLayout` **只在主布局为空时**
才用 `lastOpenFiles[0]` 打开文件(getLayout case 8 分支);目标布局文件
若已有上次模式的叶子节点,恢复走的是叶子里的视图状态,`lastOpenFiles`
根本不参与——所以切换后文章依旧变。

**正确的恢复键(asar 实证)**:布局 JSON 里每个叶子节点形如
`{id, type:"leaf", state:{type:"markdown", state:{file, mode}}}`,
反序列化经 `setViewState → view.setState`,markdown 视图的 setState 读
`state.file` 调 `loadFile`——**叶子节点里的 `state.state.file` 才是
"切过去后打开哪篇文章"的决定字段**(布局 `active` 字段标记活动叶 id)。

**修正**(渲染层补丁,syncActiveFileToTargetLayout 重写):
1. 读目标布局文件,定位 `active` 指向的叶子,把它的 markdown 视图
   `state.state.file` 改为当前文件;无 active 标记或该叶非 markdown 时,
   回退改写**第一个 markdown 叶**;
2. `lastOpenFiles` 仍然前置写入(兜底"目标布局为空"的首切场景);
3. 目标布局文件不存在(从未用过该模式)时,写入最小
   `{lastOpenFiles:[当前文件]}` 种子;
4. 写入时序安全:此时 Obsidian 自身的防抖保存写的还是**当前模式**的
   源布局文件(rd.isMobile 未变),不会覆盖我们写的目标文件;800ms 后
   重载按新 localStorage 进入目标模式,读到的即已改写的布局。

**验证要点**:触摸模式读 A 文章 → 命令/系统切到窗口模式:重载后打开的
应是 A(布局结构仍是桌面分栏);再切回触摸,仍是 A;两侧布局各自记忆
折叠/侧栏状态不变。

### 第 58 轮(2026-09-27):默认仓库迁移到用户可见的"文档"目录(卸载不丢数据)

**需求**:用户侧在文件管理器中**完全看不到**仓库和 .trash(仓库默认在
应用沙箱 userData,卸载即被清除)。期望:仓库放进系统"文档"目录方便
管理、卸载不丢数据、用户有知情/选择权、与原 OHSidian 数据兼容。

**可行性(SDK/代码实证)**:
- `READ_WRITE_DOCUMENTS_DIRECTORY` 权限**已声明**在 module.json5(此前
  为 FormAbility 场景配置);`@ohos.file.environment.getUserDocumentDir()`
  (API 11+)返回"文档"目录的沙箱映射路径,普通 fs 读写即可访问——
  写入的文件对系统文件管理器可见,且**不随卸载清除**;
- 该权限是 user_grant,需 `requestPermissionsFromUser` 运行时请求
  (PermissionManagerAdapter 已有 'directory_document' 通道,首次弹一次
  授权框,之后静默);
- 引擎 `app.getPath("documents")` 指向的位置不可写(第 38 轮实证),
  故不走该路径,改经 ohsidian-mode.json 通道下发真实目录。

**实现**:
- **ArkTS(WebAbility)**:启动即 `publishDocumentsDir()` 把
  `getUserDocumentDir()` 写入 `cfg.documentsDir`;主窗口创建后请求
  'directory_document' 权限,授权回调里再发布一次(覆盖首装未授权时
  拿不到路径的情况);权限被拒时 cfg.documentsDir 缺省,渲染层自动
  回退旧 userData 行为——**不破坏原版兼容**;
- **主进程补丁**:get-default-vault-path 改为优先返回
  `<documents>/OHSidian/Obsidian Vault`(懒创建,首次"快速开始"时才建
  目录,避免授权前残留空目录);documentsDir 不可用时回退
  `<userData>/Obsidian Vault`(与原版 OHSidian 完全一致);
- **渲染层补丁**:"迁移仓库到文件管理可见的位置"命令升级——检测当前
  仓库在沙箱内(卸载会丢)且文档目录可用时,**一键**迁移到
  `文档/OHSidian/<仓库名>` 并打开(复制式,原仓库不动,失败自动回退
  文件夹选择器);仓库已在外部则维持原选择器流程。

**用户沟通**:迁移命令执行时有 Notice 明示"当前仓库在应用沙箱内,
卸载会丢数据";README 后续补充默认仓库位置说明。新装用户从"快速
开始"创建的默认仓库天然落在文档目录,无需迁移。

**与原版 OHSidian 的兼容**:
- 旧版数据(<userData>/Obsidian Vault)保留在磁盘上,升级后打开仍指向
  原仓库,零迁移成本;想搬到可见目录用迁移命令,纯复制、无数据风险;
- 未授权/老设备自动回退到与原版完全一致的行为。

**验证要点**:首装授权后"快速开始"默认仓库应出现在 文档/OHSidian/
Obsidian Vault(文件管理器可见,含 .trash);卸载重装后该目录数据仍在;
旧沙箱仓库升级后可正常打开;拒绝授权则行为与原版一致。

### 第 59 轮(2026-09-27):字体缩放改走引擎 zoom(修复"设置不生效")+ 崩溃日志定性

**故障定性(用户提供的 JSCrash)**:SIGTRAP(TRAP_BRKPT)落在
`libelectron.so` 的 DisplayManagerAgent 回调栈(libdm OnRemoteRequest →
引擎 agent 处理内 `d4200000` 即 __builtin_trap),**进程内系统 IPC 线程**,
与应用 JS/ArkTS 代码无栈上关联——是引擎原生侧在处理系统推送的
display 配置事件(换字体大小/密度重配会触发)时的内部断言失败,76 秒
进程寿命恰与用户在系统设置改字号测试字体功能的时机吻合。闭源引擎
无法打补丁,只能规避触发(如出现,重启即可;与我们的补丁链无关)。

**字体缩放不生效的根因(自查)**:第 55 轮用"内联改写 body
--font-text-size + html font-size"实现,但 Obsidian 自身的
`updateFontSize()` 会在每次 css-change(baseFontSize 改动/主题加载/
插件样式)时**原样重写这两个属性**——我们的缩放值立刻被冲掉。这就
是"设置了还是没反应"。

**改法(引擎 zoom 通道,clobber-proof)**:
- `webFrame.setZoomFactor(scale)`(引擎 webContents shim 确认支持
  setZoomLevel/setZoomFactor)整体缩放页面,等价手机上的系统字号体验;
  CSS 再怎么重写也影响不到 zoom,只有我们的 applyFontScale 掌握它;
- `cfg.fontScale` 生效链保留:onConfigurationUpdate(fontSizeScale 变化)
  + 启动双源读取(context.config.fontSizeScale[followSystem 注入,权威]
  → settingsdata FONT_SCALE 兜底);
- **新增用户可选**:命令面板 "OHSidian: 界面文字缩放" 循环
  跟随系统 → 100% → 110% → 125% → 150% → 175% → 200% → 跟随系统,
  写入 `cfg.fontScaleOverride`(用户显式选择优先于系统因子;选择
  "跟随系统"即回到系统联动);
- zoom 不可用的引擎上保留 CSS 覆写兜底(有被 Obsidian 冲掉的老问题,
  但聊胜于无)。

**验证要点**:应用运行中在系统设置改字号 → 数百毫秒内 Obsidian 界面
与正文同步缩放;执行缩放命令手动选 125% 立即生效,选"跟随系统"后
回到系统联动;重启后保持;设置 → 缩放(Obsidian 自己的 slider)仍
独立可用(两者相乘)。

### 第 60 轮(2026-09-27):界面字体跟随系统设置 + 系统字体可选(修正第 59 轮需求理解)

**需求澄清**:用户要的不是字号缩放,而是**字体家族**——系统
"显示与字体 → 字体样式"里选的字体(以及用户安装的字体)能用于
Obsidian 界面与正文。

**机制实证**:
- 系统侧:`font.getSystemFontList()`(API 10+,FontAdapter 已封装
  GetSystemFontList 绑定)枚举全部已装字体家族;`Configuration.fontId`
  (API 14+)是系统当前样式字体的不透明 id,但**没有公开的 fontId→家族
  反查 API**;
- 引擎侧:SkFontMgr_OHOS 按家族名解析字体;我们的默认栈首家族就是
  "HarmonyOS Sans"——在支持把样式字体重映射到默认家族的系统上,
  跟随是自动的;不支持时需要显式指定家族名;
- 渲染层无法直接调 ArkTS 绑定,但 ohsidian-mode.json 通道是现成的
  桥。

**实现**(双通道:跟随系统为默认,显式自选兜底):
- **ArkTS**:启动 `publishSystemFonts()` 把
  `font.getSystemFontList()`(JSON,变化才写)发布为
  `cfg.systemFonts`;
- **渲染层**:新增命令 "OHSidian: 界面字体 (跟随系统/系统字体循环)"—
  - 每执行一次切换到下一个系统字体家族,写
    interfaceFontFamily/textFontFamily(vault.setConfig,立即生效且
    持久化,触发 Obsidian 自己的 updateFontFamily,不会被冲掉);
  - 循环末位回到"跟随系统":清空两个配置并移除 body 内联 override,
    恢复 HarmonyOS Sans 默认栈;
  - 列表上限 60 个家族,避免 Notice 刷屏过长;
- 第 59 轮的"界面文字缩放"命令保留(zoom 通道,与字体家族正交)。

**验证要点**:执行"界面字体"命令,Notice 显示切换到的家族名,界面
立即换字体;循环回"跟随系统"恢复默认;在系统设置改样式字体后,若
系统把默认家族重映射,跟随系统选项无需任何操作即跟随。

### 第 61 轮(2026-09-27):触摸设备桌面布局的系统栏避让(两个场景一并修复)

**场景一**:平板触摸模式窗口内手动切到"桌面模式"(EmulateMobile 关)→
顶部系统状态栏(时间/电量)压住内容。桌面布局的 CSS 完全不消费
--safe-area-inset-*(那是移动布局的变量),且 Obsidian 桌面初始化还会
把它们清零;而触摸设备的窗口是整屏+layout-fullscreen,内容天然顶到
屏幕最上沿。

**方案选择**:备选是"隐藏系统栏"(setWindowSystemBarEnable([]))或
"内容避让"。选**内容避让**:隐藏系统栏会改变全局系统 UI 行为(且系统
在手势时可能强制恢复),避让只影响应用自身、所见即所得。实现:
applySafeArea 在"桌面布局生效 且 窗口整屏(insets.top>0)"时注入
`.app-container{padding-top/bottom:var(--safe-area-inset-*)}` 样式
(ohsidian-desktop-safe-pad);移动布局/自由窗口(insets=0)不注入,行为
不变。

**场景二**:窗口模式(桌面布局)最大化到整屏后底部导航条仍遮内容。
根因:pushSafeAreaInsets 原来把 insets 发布**门控在 !pcModeEnabled**
上——PC 模式永远发 0,渲染层拿不到底栏高度;而最大化自由窗口是
边到边的,导航指示条浮在窗口上,避让区是真实存在的。

**修复**:insets 发布条件从"非 PC 模式"放宽为"窗口与系统栏重叠"
(整屏判定);最大化自由窗口现在也会发布真实 top/bottom insets。
三层避让齐备:①引擎视口扣避让区(第 56 轮) ②cfg.insets 真实值
(本轮) ③渲染层桌面布局 padding(本轮)。

**验证要点**:触摸→桌面模式切换后顶部时间/电量栏下方才是内容;窗口
模式双击最大化后底部内容完整(导航条上方);非最大化自由窗口与移动
布局行为不变。

### 第 62 轮(2026-09-27):启动时权限申请 + 平板触摸模式首启仓库管理窗口全屏适配

**权限**:文档目录权限(READ_WRITE_DOCUMENTS_DIRECTORY,user_grant)原来
只在 onWindowStageCreate 里请求一次;补齐为**启动即请求**,并把
directory_download 一并纳入(引擎另存/下载流程需要)。其余 user_grant
权限(剪贴板/蓝牙/相机/麦克风/定位/录屏)维持**按需申请**——引擎在对应
web 功能触发时才调用 RequestPermissionCode,避免首启弹一串对话框。

**平板触摸模式首启"仓库管理"界面长宽不对**(用户澄清:是平板默认触摸
模式,不是窗口模式;首启的 starter 仓库管理窗口本身就是错的长宽):
- 根因:starter/仓库窗口由引擎 CreateWindow 创建,bounds 是桌面尺寸
  800x650/800x600 DIP → 在平板触摸模式下落成一个小浮窗(比例和位置
  都不对);
- 修复:AppWindowAdapter.createWindow 新增触摸模式判定——平板且
  window_pcmode_switch_status=false(触摸模式)时,StartOptions 强制
  WINDOW_MODE_FULLSCREEN + 窗口 (0,0)(SDK 确认 windowMode 全屏仅对
  平板/2in1 生效,正合场景);PC 模式与 2in1 保持桌面窗口语义。
  isTabletPcMode() 读同一系统设置键,与 WebAbility.pcModeEnabled 同源。

**验证要点**:平板触摸模式冷启动:仓库管理窗口直接全屏;从 starter
选择/新建仓库跳转后的仓库窗口也全屏;PC 模式下 starter 仍是桌面
浮窗;首启权限弹窗(文档/下载目录)只各出现一次,拒绝后功能自动回退。

### 第 63 轮(2026-09-27):第 50-62 轮新增改动审计(未审部分全覆盖)

按既有审计惯例,对本批(第 50-62 轮)所有未审计改动做正确性/边界/
竞态/资源/安全五维复查,发现并修复 3 处,记录 1 处已知交互:

**修复 1(中等,避让双计)**:第 61 轮的桌面布局 `.app-container`
padding 与第 56 轮的引擎视口扣除,在"PC 模式最大化窗口"场景会**同时
生效**——surface 已扣除导航条,渲染层再 pad 一次,内容与系统栏之间
出现空白条(与第 43 轮白条同类)。修复:ArkTS 在模式文件发布
`cfg.viewportAvoidsBars` 标志(computeViewportBound 对整屏自由窗口
执行过扣除时为 true);渲染层 desktop-safe-pad 样式仅在
`!viewportAvoidsBars` 时注入,两条通道互斥。触摸模式该标志恒 false,
round 61 行为不变。

**修复 2(中等,潜在死循环)**:迁移命令的文件夹选择器路径允许选中
"当前仓库自身/其子目录",`copyDir(src,target)` 同树递归会自我复制
直到深路径耗尽。修复:执行前 resolve 归一比较,目标在源内(含相等)
时拒绝并提示;一键迁移路径(src=沙箱,dest=文档)根不相交,无此风险。

**修复 3(轻微,健壮性)**:字体循环命令在读取 `window.app.vault` 后才
判空,前面 `curFamily` 计算已经解引用 `window.app.vault`——仓库未就绪
时会先抛 TypeError(虽被 try 包住,但 Notice 语义错)。调整顺序:先判
空仓库再计算当前家族。

**修复 4(轻微,文档准确性)**:pushSafeAreaInsets 注释把底部避让修复
误标为"round 60",实为第 61 轮,已更正。

**记录 1(已知交互,暂不处理)**:系统字体缩放(webFrame.setZoomFactor)
与 Obsidian 设置→缩放滑杆写的是同一 Chromium zoom 层,后写者胜——
用户在 Obsidian 里调缩放会暂时覆盖系统跟随系数,直到下一次
cfg.fontScale 变化(模式文件变更)重新应用。二者相乘的组合需要追踪
Obsidian 自身 zoom 状态,收益低风险高,暂保持现状(验证要点已提示)。

**其余核查通过**:isTabletPcMode 上下文回退与失败默认(触摸全屏);
createWindow 全屏门控对 is_panel/模态窗口无副作用;pollTick 单文件
读+多消费者仅在内容变化时触发;文档目录 IPC 的路径来自自家 ArkTS
发布,无不可信输入;verify-asar.cjs 补齐 4 个新标记(自拷贝守卫/
字体循环/viewportAvoidsBars/documents 迁移),当前 21 项全绿。

### 第 64 轮(2026-09-27):Release 版本号以 tag 为准 + 注入步骤的 env 继承 bug

**问题**:连续数个 tag 发版的产物/Release 都显示 1.2.1——版本号写死在
`AppScope/app.json5`,CI 只读文件、tag 不参与,而"先手动改文件再打
tag"的流程容易被遗忘。

**修复 1(版本来源反转)**:build job 新增 "Resolve release version"
步骤——tag 构建( refs/tags/v* )剥出 tag 版本号作为唯一权威,workflow_
dispatch 构建回退文件值;解析出的版本在构建前由 node 注入 app.json5
(versionName + versionCode),HAP 内部版本与 tag/Release 三方一致。
versionCode 按仓库既有约定 主*1e6+次*1e4+修订 自动计算
(1.2.1→1020001,与历史手动 bump 吻合)。release job 同样改为优先 tag。

**修复 2(CI 实跑暴露)**:首次实跑 hvigor 报
`JSON5: invalid character 'u' at app.json5:5:20`——注入脚本在
node -e 的单引号脚本里读 `process.env.VERSION_CODE/VERSION`,但这两个
shell 变量**从未 export**,node 继承不到,把字面量 `"undefined"` 写进了
versionCode。改为把两个值作为展开后的命令行参数(argv)传入 node
脚本,不再依赖环境变量继承。本地 dry-run(1.2.3→1020003)验证通过。

**使用**:发版只需 `git tag v1.2.x && git push origin v1.2.x`,不再
需要手动改 app.json5(它只在无 tag 的手动构建时作为回退)。

### 第 65 轮(2026-09-27):本 Fork 完全移除华为云支持(攻击面收敛)

**动机**:华为云/AGC 相关代码攻击面过大(网络凭据、AGC 配置文件、云
存储桶访问),且该功能在本内核从未真正可用——登录触发 IPC 的写入端
在 1.13.7 内核 asar 中不存在,云同步链路本来就是死路(第 38 轮实证),
留着只有风险没有收益。

**移除的活代码**:
- `EntryAbility.initAgc()` 与 `@hw-agconnect/hmcore` 初始化(启动时读
  rawfile/agconnect-services.json 并调 initialize 的唯一入口);
- `electron/oh-package.json5` 的 `@hw-agconnect/hmcore` 依赖
  (lockfile 由 CI 的 ohpm install 自动再生成);
- `WebAbility.onCreate` 的 `CloudSyncAdapter.initCloudSync` 启动链路与
  onForeground/onBackground 的云同步通知(前台/后台只剩 RunningLock
  守卫);
- `rawfile/agconnect-services.example.json` 示例配置文件。

**保留的死代码(不接线,供参考)**:`CloudSyncAdapter.ets`(依赖
CloudFoundationKit 但从未被构造)、`CloudSyncAdapterBind.ets`、
`Login.ets`/`QuickLoginButtonComponent`、`AppWindowAdapter.
showHuaweiQuickLogin`(引擎侧无调用点,libadapter 探针确认)。
删除它们会牵动 JsBindingMethod/模块页注册,收益低,维持惰性。

**文档**:README/README_EN 简介去掉"华为账号一键登录/云同步"卖点,
新增"华为云支持已移除"专节(动机+升级说明:数据不受影响,同步需求
建议用 Remotely Save 等插件走自有存储);依赖表/目录树/页面表/AGC
配置章节同步更新;DEV-ENV-SETUP 第 2.2 节改为"无需配置"。

**验证要点**:构建通过(无 hmcore 依赖);启动日志无 AGC init 字样;
onForeground/onBackground 仅 RunningLock 生效;原上游用户升级后仓库
与设置不受影响。

### 第 66 轮(2026-09-27):系统字体样式跟随(字体样式真正生效,补上第 60 轮缺的一半)

**审计结论(先答"为什么之前没效果")**:第 49/60 轮只做了两件事——静态
注入 `--font-default: "HarmonyOS Sans", ...` 和字号缩放(fontSizeScale)。
而"系统字体样式"(fontId)是另一个配置维度:`onConfigurationUpdate` 我们
只消费 fontSizeScale,fontId 变化被无视;渲染层 `--font-default` 是写死
的静态栈,没有任何"系统样式变化 → 更新 CSS"的路径。引擎 Skia 层
(SkFontMgr_OHOS)理论上可能把默认家族重映射到样式字体,但实测(用户)
未生效,被动路径不可靠。

**新依据(本地 SDK 24 d.ts 逐条核实)**:
- `ApplicationContext.onSystemConfigurationUpdated(callback)`(API 24,
  本机满足):专用系统配置监听,回调含 **onFontIdUpdated**(字体样式变化
  专用)、onFontSizeScaleUpdated、onFontWeightScaleUpdated——比
  onConfigurationUpdate 可靠且保证样式事件;
- `@ohos.graphics.text.getSystemFontFullNamesByType(SystemFontType.
  STYLISH)`(API 14+):枚举系统样式字体;`getFontDescriptorByFullName(
  fullName, STYLISH)` 取每个的 FontDescriptor(fontFamily/fullName)——
  补上"fontId → CSS 家族名"的反查映射。

**实现**:
- **ArkTS(WebAbility)**:
  - `publishFontId(fontId)`:发布 cfg.fontId(去重写);
  - `publishStyleFonts()`:STYLISH 枚举(上限 40)逐个取
    FontDescriptor,发布 cfg.styleFonts=[{id,family}](变化才写);
  - `registerSystemConfigListener()`:注册
    onSystemConfigurationUpdated——onFontIdUpdated → 重发 fontId+映射;
    onFontSizeScaleUpdated → 复用既有 writeFontScaleToFile;
  - 启动:`context.config.fontId` 初始值 + 两项发布 + 监听注册;
- **渲染层**:
  - `applySystemFonts` 重写为动态:`cfg.fontId` 在 styleFonts 映射到
    家族 → `--font-default` 前插该家族;fontId 存在但映射不上 →
    **探针法**兜底(canvas 测宽对比 serif 基线,找出渲染宽度不同的
    非 HarmonyOS 家族,按 fontId 缓存);都没有 → 回落默认栈;
  - 家族变化才重写样式(去重);挂入 200ms 文件变化消费者;
  - "界面字体循环"命令的"跟随系统"提示现在会显示解析出的当前样式
    字体名。

**验证要点**:系统设置 → 显示与字体 → 字体样式 切换 → 约 1s 内
Obsidian 界面字体变化(Notice/hilog 可见 fontId 更新);切回原样式同样
生效;重启后初始 fontId 正确;Obsidian 设置里自选字体仍优先;探针仅在
fontId 无映射时运行且按 id 缓存。

### 第 67 轮(2026-09-29):字体样式跟随的真根因——OhosThemeFont(日志实证)

**用户日志关键三行**:
```
LoadThemeFont: shaonianzhangyangsiyiailian.ttf
RegisterTypeface: Succeed in registering typeface, family name: OhosThemeFont
tag: WebAbility --> onFontIdUpdated: hf2183168533 / font id published: ...
```

**结论**:第 66 轮的 ArkTS 链路本身是通的(监听器触发、fontId 发布
成功),但系统把用户选的样式字体加载后**统一注册为固定家族名
`OhosThemeFont`**(共享内存注入进程内文本引擎),而不是字体的原始
家族名——所以第 66 轮"fontId→原始家族名映射"的产物在 Skia 里根本
解析不到,CSS 栈等于没换。同时日志确认 fontSizeScale=1.0,缩放链路
与本次问题无关。

**修复**(渲染层):`--font-default` 栈改为 `"OhosThemeFont",
"HarmonyOS Sans", ...` ——设置了样式字体时 OhosThemeFont 解析为该
字体;未设置时该名字不解析,自然落到 HarmonyOS Sans。不再依赖
fontId→原始名映射与探针(相关代码移除;styleFonts/fontId 发布保留,
fontId 仍作为"样式已变化"的信号源,循环命令的诊断提示继续用)。

**验证要点**:安装新包后,系统设置切换字体样式 → 回到应用约 1s 内
界面字体跟随(日志 fontId 发布 + OhosThemeFont 注册先行);恢复默认
样式后应用回到 HarmonyOS Sans;Obsidian 设置自选字体仍优先。

### 第 68 轮(2026-09-29):外部审计修复收尾(批次4)+ 11 处潜伏编译错误清零 + 真机崩溃(SIGTRAP)分析与缓解

**背景**:外部 agent 的《功能性 Bug 深度审计报告》(约 70 条)逐条
**以代码为准**复核,批次 1-3(窗口生命周期/输入 IME/补丁脚本/文件
系统权限,共 20 项修复 + 16 项误报判定)已随 f06ee10 落地;逐条
核实证据、修复说明与误报理由全部登记在 `docs/AUDIT-FIXES-2026-09-29.md`。
本轮是该工作的收尾批次 + 两项构建/真机硬问题的修复。

**批次 4 修复(杂项适配器,均先核实再修)**:
- BLE:`disconnectGatt` 补 off 通知监听 + 清 per-device 标记与残留
  回调(重连后通知失效的根因);`startDiscoveryMonitor` 重复注册先
  off 旧闭包(stop 永远只能移除最后一个的泄漏);
- ShapeDetection:OCR `recognizeText` 先查 error(失败时 data 为
  undefined 直接崩);OCR/人脸 pixelMap finally 释放(每次调用泄漏
  一个);人脸 `detect()` 包 try/catch(原先 promise 拒绝吞回调);
- Print:`onStartLayoutWrite` 按 jobId:fd 去重(属性变更重触发的
  重复写入会把多份 PDF 拼接成坏文件);
- Media:`getImageReceiver` 单次注册守卫(重复叠加监听每帧 N 倍处理);
- StatusBar:`RemoveFromStatusBar` finally 中 off 包 try/catch
  (onCompleted 已发后 off 抛错导致第二个矛盾的回调);
- Speech:重建 TTS 引擎前先 shutdown 旧引擎(切语言时双引擎抢
  speak、旧 listener 仍触发);
- I18n:`registerTimeZoneListener` 重复注册前先 unsubscribe(旧
  subscriber 泄漏,每次时区变化连旧回调一起触发);
- CertManager:签名 update/finish 失败路径补 `certManager.abort`
  (弃置会话耗尽句柄槽);
- Device:`getRawDescriptor` 失败补回调空描述符(原先静默返回,
  引擎挂等;openDevice 的布尔返回本就透传,无需改);
- OCR:错误/空图路径回调补长度参数 `callback(words, 0)`(与成功
  路径签名一致,引擎侧 length 不再是 undefined);
- 引擎侧松散 `main.js`(非 asar 内):trash 自检不再读写用户
  obsidian.json(`shell.trashItem` 本就不需要注册 vault,kill -9
  残留脏条目的整类风险消失);`pad()` 补 String() 转换;
- WebPage:`onLoadIntercept` 从恒 false 改 https/file/about 白名单
  (唯一调用方传硬编码协议 URL,无可达攻击路径,纯纵深防御);
- 文档:DEV-ENV-SETUP 的 API 版本从 6.0.2(22) 更正为 6.1.1(24)
  (与 build-profile 实际一致,新开发者装错 SDK 会直接构建失败)。

**误报判定(不修,证据在审计文档)**:NativeTheme 构造器重置主题
(单例构造一次,destroy 无调用方)、activateFileAccessPersist 命名
(两段式 persist+activate 本就正确)、WebAbility 窗口监听器不 off
(实例级窗口随实例销毁,无幽灵事件路径)、startUri replace(字符串
replace 只换首处)、手机分支、EngineFlags 缓存(消费模型只读一次)、
RunningLock 后台清 keep(幂等无害)、电池快照(batteryInfo 是系统
实时单例)、预览 320×240(绑定无分辨率参数)、SetContextMenu 赋值
时序(同步块内完成)、LOCALE_CHANGED(引擎无此回调,能力缺口)、
"两个第 27 轮"(文档 1107 行已有编号说明)。BatteryAdapter 顺手修
事件里刷新 `nowCurrent`(API 12 起可实时读)。

**11 处潜伏编译错误清零(审计未发现,构建时暴露——此前 full build
应为失败状态)**:
- `CommonInterface` 从未导出却被导入的符号:补 `BatteryInfo`/
  `OcrAdapterImage`/`PowerMonitorContext`(挂到 NativeContext 上)
  三个接口定义;`TextWord` 改用 SDK 自带 `textRecognition.TextWord`;
- PasteBoard:API 24 中 `PasteDataRecord.uri` 已是 string,`filterFileDocs`
  签名改为接 string 内部自行解析(唯一调用方);
- WebAbility 字体链路:`Promise.all` 回调显式过滤 null(ArkTS 无
  filter 谓词收窄),entries 才写入 mode 文件;
- BLE:HashMap.forEach 的 key 按 possibly-undefined 防御。
附带:`LogDecorator` 重构——async 适配器方法的 "out =>" 日志从恒
`{}` 改为经旁链记录 settle 值/拒绝原因(`out(promise) =>`/
`rejected =>`),不触碰返回的 promise 本体(LogMethod/LogAll 共用
同一 wrapLogged)。

**真机崩溃分析与缓解(附录 A,完整证据链在审计文档)**:
MatePad Air faultlog(SIGTRAP@libelectron.so,LastFatalMessage:
`OHOS.IDisplayManagerAgent`)+ 尾部 hilog 时间线实锤为**关闭最后
窗口 → 立即重启**的竞态:
- 12:36:35.951 窗口分离 → 36.471 prepare terminate(返回 true)
  → 36.625 重启 want 进入,`onAcceptWant` 对正在退出的引擎发起
  **同步** `kGetLastActiveWidget` → 39.627 引擎 3s 超时
  (XCollie:`MainThread:AcceptWant 3007ms`)→ 39.641 浏览器退出、
  `~Display` 析构 → 39.663 引擎 DisplayManagerAgent 派发在显示
  对象销毁瞬间命中内部 CHECK;主线程与 CrBrowserMain 堵在同一把
  引擎锁上(锁 convoy)。
- 归属:陷阱在闭源引擎内部,同步查询是上游代码;但主线程 3s 阻塞
  是 ArkTS 侧可控的 aggravator。
- 修复:`GlobalThisHelper` 增加进程级 terminating 标记
  (`markTerminating/isTerminating/markAlive`);最后窗口的
  `onPrepareToTerminate`(代理数 ≤1)与 App 级 `onPrepareTermination`
  均标记;`onAcceptWant` 在 terminating 时跳过同步 native 查询
  直接快速路径返回 browser1(与冷启动一致),其余路径的查询包
  try/catch;`onWindowStageCreate`(addProxy 后)清除陈旧标记,
  "恢复上次活跃窗口"不受影响。

**验证**:web_engine HAR 与 electron 模块 ArkTS 双双 BUILD
SUCCESSFUL;`node --check` 松散 main.js 通过;asar 已重打且
`verify-asar.cjs` 全部 marker(含新增 3 项)通过。

**真机回归要点**:①关闭应用 → 立即重启,不崩溃,日志无
`MainThread:AcceptWant` 3s 阻塞(XCollie);②OCR/人脸多次调用
无持续内存增长;③BLE 连接 A/B 两设备、断开 A 重连后通知仍可达;
④打印多页任务输出为单份完整 PDF;⑤切 TTS 语言后 speak 正常;
⑥证书签名连续失败后服务仍可用;⑦另存为对话框显示全部格式组;
⑧电池/时区/深链回归(本轮动了相关适配器)。

### 第 69 轮(2026-09-29):主题字体进 web 的正确姿势(FontFace 文件桥)+ 设置字体列表补全

**用户反馈两个事实**:①界面仍不跟随系统样式字体;②设置字体页只有
Inter / Source Code Pro 两项。

**根因(代码+日志实证)**:
- ① TexGine 隔离:`OhosThemeFont` 是 ArkUI 文本引擎运行时注册的
  (RSInterfaces 共享内存),而 web 引擎 Skia 的字体管理器只读静态
  系统字体配置(OH_Drawing_GetSystemFontConfigInfo)——两条通道不通,
  CSS 写 OhosThemeFont 永远解析不到。字体文件本体可达:同 uid 的
  框架进程刚加载过它(font.getFontByName 可查路径)。
- ② Obsidian 字体枚举(Zne):硬编码种子 ["Inter","Source Code Pro"]
  + 桌面字体探测表(鸿蒙上几乎全落空);补全依赖引擎 get-fonts 模块,
  而引擎未实现(libelectron 探针 0 命中)。

**修复**:
- **主题字体桥**:ArkTS `publishThemeFontPath()` 用
  font.getFontByName('OhosThemeFont') 取 FontInfo.path 发布为
  cfg.themeFontPath(启动+fontId 变化时);渲染层 `applyThemeFontFace`
  用 Node fs 读字体字节 → `new FontFace("OhosThemeFont", buffer)` →
  document.fonts.add —— CSS 栈里原本就首位的 OhosThemeFont 从此真实
  解析(路径变化才重载;引擎无 FontFace 时静默跳过);
- **字体列表补全**:新增 app.js 文本补丁(fontListSrc→Dst),把
  `cfg.systemFonts`(启动时以 window.__ohsidianSystemFonts 暴露,文件
  变化时刷新)concat 进 Zne 种子数组 —— 设置 → 字体现在列出全部系统
  字体家族,点选即写 --font-*-override(Skia 可解析 /system/fonts 里
  的真实文件,直接生效);
- `refresh-app-patch.mjs` 升级:支持幂等重放 body patches(抽屉切换 +
  字体列表),与 update-obsidian.mjs 的 APP_BODY_PATCHES 保持同步;
- verify-asar.cjs 新增 3 个标记(font picker 注入/FontFace 桥/原有),
  当前全绿。

**与第 67 轮的关系**:67 轮把栈首换成 OhosThemeFont 方向正确但解析
不了;本轮补上"文件桥"让它真正解析。用户自选字体(设置点选/循环
命令)依然最优先。

**验证要点**:①系统切样式字体 → 应用约 1s 内界面变化(hilog 应见
`theme font path published: /data/...`);②设置 → 外观 → 字体列表应
出现 HarmonyOS Sans 等系统家族;③点选任一系统字体立即生效并持久化;
④未设样式字体的设备回退 HarmonyOS Sans。

### 第 70 轮(2026-09-29):主题字体路径改走 STYLISH 文件 API(第 69 轮日志复盘)

**新日志证据**:`font.getFontByName('OhosThemeFont')` 在真机上
**查不到运行时注册的主题字体**——TexGine 报
`ParseFontDescriptor: Failed to find font name OhosThemeFont`
(该别名只在 ArkUI 文本引擎内,不在 @ohos.font 的静态查询范围),
cfg.themeFontPath 被发布为空,渲染层 FontFace 桥无文件可载。

**修复**:publishThemeFontPath 改用字体引擎文件 API
`text.getFontPathsByType(text.SystemFontType.STYLISH)`(API 23+,返回
样式字体文件路径数组)——优先取 .ttf/.otf,命中即经
writeThemeFontPath 发布;链路其余部分(onFontIdUpdated 触发、渲染层
FontFace 加载、设置字体列表注入)第 69 轮已就绪,本轮只换路径来源。
日志新增 `STYLISH font paths: [...]` 便于核对。

**验证要点**:装新包切样式字体后,hilog 应出现
`STYLISH font paths: [...含主题字体 ttf...]` +
`theme font path published: <路径>` → 界面 1s 内跟随;若 STYLISH 也
为空(设备无样式字体),回退 HarmonyOS Sans 属预期。

### 第 71 轮(2026-09-29):字体文件桥收尾——CUSTOMIZED 优先 + fontFiles 按需 FontFace

**新日志两个事实**:①STYLISH 枚举返回的是六个内置样式字体
(/sys_prod/fonts/ShuS-SC.ttf 等),**不含用户下载的主题字体**
(shaonianzhangyangsiyiailian.ttf)——它属于 CUSTOMIZED(自定义)类型;
②设置里点选注入的系统字体提示"系统中不存在此字体"——列表名来自
ArkTS/TexGine 侧,但其中 /sys_prod 与自定义字体对 web 引擎 Skia 的
静态字体配置不可见,canvas 探测解析失败。

**修复**:
- `publishThemeFontPath` 改为 **CUSTOMIZED 优先**
  (`text.getFontPathsByType(CUSTOMIZED)`,日志打
  `CUSTOMIZED font paths`),空则回退 STYLISH——主题字体 ttf 应从此
  枚举拿到;
- `publishSystemFonts` 同时发布 **cfg.fontFiles**(family→file 路径
  映射,font.getFontByName 逐个查询);
- 渲染层 `refreshSystemFontGlobals` 扩展:对 fontFiles 里 Skia 解析
  不到的家族(canvas 测宽判等),按需 `readFileSync + FontFace` 注册
  (上限 40、一次性、已解析者跳过)——设置里点选任何系统字体都能真实
  生效,主题字体家族亦同;全部解析到则零开销;
- 设置字体列表补丁(第 69 轮)不动,两机制叠加。

**验证要点**:①切主题字体后 hilog 依次出现 `CUSTOMIZED font paths`
(应含 shaonianzhangyangsiyiailian.ttf)→ `theme font path published`
→ 界面跟随;②设置字体列表点选宋体/楷体等不再报"不存在",立即生效;
③恢复默认样式回 HarmonyOS Sans;④全部字体可解析时无 FontFace 开销。

### 第 72 轮(2026-09-29):主题字体路径终极方案(ALL 描述符兜底)+ 渲染层 FontFace 卫生

**新日志铁证**:`CUSTOMIZED font paths: []` ——用户下载的主题字体
不属于 CUSTOMIZED 枚举;STYLISH 又只有六个内置 /sys_prod 字体。
路径获取的三条公开枚举全部失效,但 SDK 文档明确
`SystemFontType.ALL` 覆盖"系统 + 样式 + **用户安装**"三类——主题字体
即用户安装字体,用 ALL 全量描述符逐个取 path,**过滤掉静态目录
(/system/fonts、/sys_prod)后剩下的就是运行时安装的主题字体**。

**ArkTS(publishThemeFontPath 重写)**:
1. CUSTOMIZED 路径(保留,日志照打);
2. 兜底:getSystemFontFullNamesByType(ALL) → 逐个
   getFontDescriptorByFullName(ALL) → 取 path,过滤 /system/fonts 与
   /sys_prod、仅收 .ttf/.otf;找到即 writeThemeFontPath;
3. 全部落空则发布为空(渲染层回退 HarmonyOS Sans),日志明确打
   "no non-static font path found"。

**渲染层(外部审计确认的四个缺陷全修)**:
- **旧 FontFace 不清理**:FontFaceSet 按插入顺序解析同 family,旧
  主题字体永远胜出("切换无效"的主因)——applyThemeFontFace 现在先
  遍历删除全部 OhosThemeFont 旧 face 再注册新的;
- **空 catch 吞错**:stat/read/FontFace/load 每个失败路径都打
  console.warn(含路径与错误消息),不再静默;
- **reject 仍 add broken face**:load 失败不再 add,置
  themeFontLoadedPath=null 允许下轮重试;
- **fontFiles 桥的单次守卫**:去掉 !__ohsidianFontBridge 整体闸门,
  改为按 family 增量跳过(晚装的字体也能桥接);上限 40→80。

**验证要点**:切主题字体后 hilog 依次出现 `CUSTOMIZED font paths: []`
→ `ALL font names: N` → `candidate font path: <主题字体路径> (<名>)`
→ `theme font path published` → 界面 1s 内跟随;若 ALL 也无,日志见
"no non-static font path found"(此时只能等华为开放 API,应用回退
HarmonyOS Sans);设置点选系统字体不再报"不存在"。

---

## 九、文档与构建管线(2026-09-30 ~ 10-01)

### 9.1 README 双语重写与许可分层

- README.md 按阮一峰《中文技术文档的写作规范》重写:全角标点、
  中英文间距、引用式链接、代码块语言标注;修正依赖表断裂、
  克隆地址、项目树旧目录名;README_EN 整体重写对齐中文版
  (旧版残留华为云/AGC/自动更新章节);两份 README 顶部互加
  语言切换入口;
- 许可查证:上游 290 个 .ets/.ts 源文件带文件级 BSD 3-Clause 头
  (Copyright Haitai FangYuan Co., Ltd.),libelectron.so 闭源中间层
  随上游同声明分发,obsidian.asar 为专有(包装层 UNLICENSED)。
  LICENSE 改为 BSD 3-Clause 三版权行(Haitai FangYuan 原始代码 /
  HanversionOvO(昵称 MikannQAQ)上游作者 / PCFXPCFX 本 Fork 修改),
  附适用范围说明;中英文许可段按"源码 / 闭源中间层 / 专有组件 /
  第三方组件"分层;reflect-metadata 0.2.x 实为 Apache-2.0(旧表误写 MIT);
- Obsidian 层口径修正:"未经修改的官方应用代码"不实——
  update-obsidian.mjs 实际注入大量运行时补丁。架构图与两份 README
  改为"官方签名产物 + 可复现运行时补丁",专有组件段注明
  "修改与再分发超出其使用条款授权,如有侵权请联系移除"。

### 9.2 平板功能演示文档

- docs/tablet-demo.md:9 项平板功能的说明 + 建议拍摄内容 + 素材占位
  (01~09 GIF/MP4,位于 docs/media/tablet-demo/,含命名约定);
- "平板状态栏自动隐藏"按产品决定取消:代码已撤,全部文档移除并重编号。

### 9.3 架构图生成脚本

- scripts/render-architecture.mjs:数据驱动生成
  docs/images/architecture{,.en}.svg/png(@2x),中英文案集中于 I18N 表;
  Edge/Chrome 无头渲染(PNG),跨平台浏览器探测;
  scripts/package.json 注册 npm run render-architecture。
  两份 README 的 ASCII 架构图弃用。

### 9.4 obsidian.asar 出库 + CI 产物管线

- 动机:git 仓库不再托管修改过的专有二进制(再分发面);asar 出库
  (25 MB,LFS 指针删除),本地文件保留,.gitignore 防误提交;
- build-release.yml 新增产物管线(构建前置):读 app package.json
  钉住版本 → actions/cache 按版本缓存 asar.gz →
  update-obsidian.mjs <版本> --repatch(官方源下载,SHA-256 +
  RSA-SHA256 双校验,注入补丁,重打包安装)→ verify-asar.cjs
  断言语法 + 24 个补丁标记(复用现有脚本,本地全绿);
- --repatch 为必选:asar 出库后普通路径会"已是最新"直接退出
  不产出;版本升级 = PR 改 package.json,CI 不追 latest;
- 收益:供应链校验前置(每次构建重验哈希与签名)、仓库瘦身
  25 MB、再分发面缩小(只有 Release HAP 含修改版 asar)。

### 9.5 本地构建自动补全(hvigor 挂钩)

- 根 hvigorfile.ts 调用 scripts/ensure-obsidian-asar.mjs:asar 存在
  则 0.17 s 放行(日常零开销,升级仍显式跑 update-obsidian.mjs);
  缺失(新 clone 首次构建)则按需 npm ci + --repatch 全流程,
  DevEco GUI 与 hvigorw 同样生效;无法产出时中止构建并给出指引,
  绝不静默打包无应用载荷的 HAP;OHSIDIAN_SKIP_ASAR_ENSURE=1 跳过;
- 实测:本机直连 github.com 下载失败(CN 网络,releases.obsidian.md
  的 asar 路径本身 404),失败信息含离线预置通道——官方
  obsidian-<版本>.asar.gz 放入 scripts/.tmp-update/ 后管线照常校验
  哈希与签名,预置来源不需要被信任;CI runner 出网不受影响;
- README 构建步骤、项目树注释、DEV-ENV-SETUP 与实际机制对齐;
  DEV-ENV-SETUP 遗留的"状态栏自动隐藏"验证行替换为触屏模式检查。
