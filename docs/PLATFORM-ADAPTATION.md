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
| A5 | 插件 `require` 被移动模拟门控（**已修，2.0.1**） | `loadPlugin` 的 shim：`a=document.body.hasClass("emulate-mobile")`，命中时白名单（仅 `obsidian` + CodeMirror 6 + Lezer）之外的模块一律 `null` | 触屏模式下凡顶层 `require` Node 模块的插件直接抛错 →「插件加载失败」；懒加载的则设置页空白。**本移植的渲染层有完整 Node**（内核自己就用 `window.require` 取 `fs`/`electron`），`null` 是纯策略误判 | 已把判据常量化为 `a=!1`（保留白名单优先），触屏模式与桌面模式插件语义一致；`verify-asar` 有正/负断言。布局侧的 `isMobile/isTablet/isPhone` 分支不受影响 |
| A6 | 应用内 execve 外部二进制被内核拒绝（**诊断已修正，第 215/216 轮**） | 诊断面板三候选：`.../Cellar/pandoc/3.12.1/bin/pandoc` 文件层全绿却 `EPERM`；`.local/share/pandoc` `ENOENT`；`harmonybrew/Cellar/pandoc` `EACCES`（目标是目录） | 旧探针模板只有 ENOENT/EACCES/ENOEXEC/ETXTBSY/超时，`EPERM` 落到"能启动但退出码非零"的兜底句 → 误报"问题在这个程序内部"；目录目标被误报成 SELinux/沙箱拒绝 | 已补 `EPERM` 分支（强制代码签名 + 应用执行域裁决，路径/chmod/调用方式均无效，应用层无解：HNP 随包或 HiShell）与 `isDirectory()` 特判（给出正确写法 `<keg>/<版本>/bin/pandoc`，并跳过无意义的 execve 实测）。第 216 轮再把 `EACCES` 按文件层证据分化（缺执行位/X_OK → `exec-eacces-perm`，**可修**）、只对绝对路径实测、shell 侧改 argv 传参，并在报告顶部给「结论汇总」+ HiShell 自证与「导出 Markdown 到电脑端转换」两步绕行。能力出路本身是产品决策（HB-1） |

## 二、引擎能力

| # | 依赖点 | 原文 | 后果 | 建议 |
|---|--------|------|------|------|
| B1 | ~~`@electron/remote` 兜底对象只有两个键~~ **不成立** | 包装层确有 `remote={initialize,enable}` 两键兜底，但 `@electron/remote` **整包已随 HAP**（`resfile/resources/app/node_modules/@electron`） | 不会走到那个兜底 | 无需处理 |
| B2 | 剪贴板按 electron 主版本分支 | `app.js@757916`：`mf<40?electron.clipboard:electron.remote.clipboard` | 我们把版本钉成 28.2.3 → 只走渲染层 `clipboard`，若兼容层只镜像 remote 侧则复制失效 | 实测后统一走 remote |
| B3 | ~~`app.relaunch()` 无实现~~ **不成立** | 引擎已实现：`ElectronAppAdapter.relaunch()` → `applicationContext.restartApp(want)`，并把 `electronRelaunchArgs` 透传 | 剩下的风险只是上游 `app.relaunch(); app.quit()` 的顺序——quit 可能把刚发起的重启关掉 | 若要修，只调整调用顺序/屏蔽随后的 quit |
| B4 | 麦克风权限只预检 macOS | `app.js@3146503` | 鸿蒙拒权不弹提示，录出空文件 | 接 `abilityAccessCtrl` |
| B5 | 回收站语义 | 包装层 `main.js:150-192` 用 vault `.trash` 重命名替代 `shell.trashItem` | 与"系统回收站"设置不一致 | 已在文档说明，暂不动 |
| B6 | 外部链接外呼走隐式 Want（**已升级，第 215 轮**） | `ExternalProtocolAdapter.openExternal`：`startAbility(want, FLAG_START_WITHOUT_TIPS)` | http/https 缺少"没有匹配应用时的浏览器兜底"与域名校验（官方自 API 12 推荐的入口不是它） | 已改 `context.openLink(url, {appLinkingOnly:false})`，失败/不支持时回落到原隐式 Want；`mailto`/`tel`/`obsidian` 属 Deep Linking，保持 `startAbility` |

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

### 1. C1 定案：引擎**会**把 web 侧的 app-region 变成窗口拖动，但只在**无边框**路径

第 181 轮真机三档对照（用户实测）：

| 档 | 系统标题条 | web 标题栏 | 标签栏空白区 |
|----|------------|------------|--------------|
| `native` | ✅ 能拖 | （不存在，被我们隐藏） | ❌ 不能拖 |
| `hidden` | （无） | ✅ 能拖 | ✅ 能拖 |
| `custom` | （无） | ✅ 能拖 | ✅ 能拖 |

结论修正：

- **引擎确实消费 app-region**（`custom` 的 `.titlebar{-webkit-app-region:drag}`、`.workspace-tab-header-container-inner{drag}` 都能拖），第 175 轮"工具栏 no-drag"的方向因此**是成立的**；
- 但这条能力只在**无系统边框**时生效：`native` 档下同样的 CSS 拖不动，说明引擎的 web 拖动面按"窗口是否有系统标题条"分流（有 caption 时拖动交还 WMS）；
- 二进制里查不到 `DraggableRegion` 符号不能证伪（符号被剥离），第 179 轮"很可能不实现"的推断**已被真机推翻**。

**所以第 178 轮的风险解除**：`hidden / custom` 收起系统标题条后，窗口仍然拖得动（靠 web 侧的 app-region）。

**遗留的不一致**（低优先，纯体验）：`native` 档下标签栏不能拖窗——这是引擎的分流规则，CSS 改不动；用户仍可拖系统标题条，且有 WMS 的拖动能力（第 58 轮已经确保 `setWindowTitleMoveEnabled(true)` 与标题条可见性同步）。若将来要补齐，只能走 ArkTS 侧的手势转发（风险高，暂不做）。

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
## 五、弱沙箱（`CUSTOM_SANDBOX`）落地：决策与操作面

> 决策：2026-11-18，采纳移交包 HB-1 的**第 ④ 条**——申请 ACL 权限
> `ohos.permission.CUSTOM_SANDBOX`，让应用域可以 execve harmonybrew 的 adhoc 产物
> （pandoc 等），代价是沙箱强度降级。这是四条路线里**唯一零随包体积、直接复用 brew
> 生态**的一条；① HNP 随包（离线导出独有优势）、③ 云端/桌面侧导出仍是备选。

### 5.1 权限事实（SDK `toolchains/lib/PermissionDefinitions.json` 实测）

| 权限 | grantMode | availableLevel | since | 含义 |
| --- | --- | --- | --- | --- |
| `ohos.permission.CUSTOM_SANDBOX` | `system_grant` | `system_basic`（**ACL**） | 18 | 弱沙箱：允许应用域 execve 非系统签名产物 |
| `ohos.permission.READ_WRITE_USER_FILE` | `system_grant` | `system_basic`（**ACL**） | 13 | 被 execve 的程序读写用户家目录（pandoc 输入/输出、`~/.pandoc`） |

两条都是 `system_grant`：**没有用户授权弹窗**，授予与否只取决于签名 profile 的
`acls` 列表。因此"装完没效果"的唯一可能原因是 profile 没挂 ACL（B-WS-5）。

### 5.2 生效的五个条件（缺一条都退回强沙箱）

1. `electron/src/main/module.json5` 的 `requestPermissions` 声明两条权限 →
   `node scripts/weak-sandbox.mjs apply`；
2. 签名 profile 的 `acls` 里含同两名——**这两条的获取难度不同**（2026-11 实测 + 官方文档）：
   - `READ_WRITE_USER_FILE`：在 DevEco **自动签名**支持的 ACL 清单里（5.0.3 起）。在
     `module.json5` 声明后重新自动签名，DevEco 会向 AGC 换一个含它的 Profile；
   - `CUSTOM_SANDBOX`：**不在自动签名支持的 ACL 清单里**，自动签名会报
     `Unsupported restricted ACL permission exist in the configuration`。必须走**手动签名**：
     `Build → Generate Key and CSR`（生成 .p12/.csr）→ 在 AGC 申请**调试证书**（.cer）与
     **调试 Profile**（.p7b，申请 ACL 时勾 `CUSTOM_SANDBOX`）→ `File → Project Structure →
     Signing Configs` 取消自动签名，填 p12/cer/p7b；且 `CUSTOM_SANDBOX` 属于**受限开放权限**，
     AGC 要按“特殊场景”审核（申请入口：AGC → 证书、APP ID 和 Profile → ACL 权限申请），
     **普通应用（例如仅为运行 pandoc）不保证能批**；
   - 离线改 `.p7b` 再自签不可行：profile 由 AGC 签名，改一个字节验签即失败；
   - 因此**没有内部受限权限渠道时，弱沙箱事实上不可得**——发行包只能保持强沙箱，
     pandoc 执行需求应改走“随包 HNP / 服务端导出”路线（§五开头的备选）。
3. 重新构建并**重签** HAP；
4. 设备 API ≥ 18；
5. 验证（§5.5）通过。

**rev203 起诊断能直接指出缺哪一步**：ArkTS 额外把 `sandboxDeclared`（该 HAP 是否在
`requestPermissions` 声明了 `CUSTOM_SANDBOX`）和 `sandboxApi`（设备 API 级）写进模式文件，
渲染层拼成「强沙箱（…）· 本包未声明… / 签名 profile 缺 ACL… / 设备 API <18…」——不用再靠猜。
默认构建**不带**这两条权限，所以拿默认构建实测必然看到"本包未声明"，这是预期。

默认构建**不带**这两条权限（`weak-sandbox.mjs revert` 回到原样）：声明了却拿不到
ACL 的包不能当发行包用。

**本机实测（2026-11-18）**：`node scripts/weak-sandbox.mjs status` 会直接读
`build-profile.json5` 指向的 `.p7b`（华为签名的 profile，JSON 载荷是明文，可只读解析）
并列出 `acls.allowed-acls`。当前调试 profile **已有 7 条 ACL**——
`kernel.ALLOW_WRITABLE_CODE_MEMORY`、`READ_WRITE_DESKTOP_DIRECTORY`、`SYSTEM_FLOAT_WINDOW`、
`READ_WRITE_DOCUMENTS_DIRECTORY`、`READ_PASTEBOARD`、`FILE_ACCESS_PERSIST`、
`READ_WRITE_DOWNLOAD_DIRECTORY`——说明 ACL 申请流程本来就在用；**缺的正是
`CUSTOM_SANDBOX` 与 `READ_WRITE_USER_FILE`**，把这两条加进同一条申请流程、重新下载
profile 再重签即可。离线改 profile 再自签**不可行**：profile 由 AGC 签名，改一个字节
验签就失败（这也是 `weak-sandbox.mjs` 只做只读检查、不代改 profile 的原因）。

### 5.3 代码侧已落地（第 217 轮）

| 部分 | 内容 | 位置 |
| --- | --- | --- |
| 清单开关 | `apply` / `revert` / `status`，幂等，CRLF 安全；`status` 打印五行生效条件与 profile 路径 | `scripts/weak-sandbox.mjs` |
| 运行时自检（WS-5） | 启动时 `checkAccessTokenSync(tokenID, CUSTOM_SANDBOX)` → 把 `sandbox: "weak"|"strong"` 写进 `ohsidian-mode.json`（字段自有合并），失败方向为 `strong` | `WebAbility.publishSandboxField()` |
| 消费侧（WS-1） | 渲染层读该字段：诊断面板显示「沙箱形态」，pandoc 探针在**弱沙箱下 EPERM 不再讲签名故事**（B-WS-6），改为查 noexec/损坏/架构并提示先确认 ACL 生效 | `touch-mode.js` `ohsidianSandboxMode()` / `ohsidianProbeExecutable()` |

### 5.4 边界（不要记错）

- 弱沙箱放开的是**签名身份裁决**这一层：adhoc/自签产物可以 execve；
- **SELinux 域策略不变**，所以仍可能出现 `EPERM`——那时原因不再是签名（B-WS-6），
  而是域拒绝、`noexec` 挂载或文件损坏；
- 它**不**让应用获得系统二进制/其它应用数据的访问；vault 与导出路径的可达性仍需
  `READ_WRITE_USER_FILE` 与实际路径逐一验证（V-WS-2/V-WS-3）；
- 开发者侧载渠道下 ACL 可调试态实测；若将来改上架，受限权限需重新过审。

### 5.5 验证矩阵（弱沙箱 dev 包必跑，V-WS-1~7）

1. **V-WS-1** 装完先在诊断面板确认「沙箱形态: 弱沙箱」（等价 `weak-sandbox.mjs status` + 模式文件 `sandbox=weak`）；
2. **V-WS-2** 环境仿真：pandoc `--version` 可用后，同一路径在诊断里 verdict=`ok`；
3. **V-WS-3** 数据边界：vault 读、导出写、`~/.pandoc` 数据目录三条路径都可达；
4. **V-WS-4** 冷启动与 UI：大文件首次 execve 的耗时（探针超时文案已改为"超时≠坏文件"），不冻结主线程；
5. **V-WS-5** 双形态共存：强沙箱包与弱沙箱包各自安装/升级后 `sandbox` 字段与文案都正确（B-WS-3 双版本文案漂移）；
6. **V-WS-6** 重签回归：故意用不带 ACL 的 profile 重签一次，确认**降级为 strong 且文案不骗人**（B-WS-5）；
7. **V-WS-7** 弱沙箱下 EPERM 残余的场景（noexec 挂载、坏二进制）文案指向正确，不再说"签名裁决"（B-WS-6）。

### 5.6 仍未做（本决策的后续项）

- **WS-2** 探针"环境仿真"段（真转一次 docx 的可行性判定）——需要弱沙箱包在手才能取数；
- **WS-6** 探针异步化 + 超时预算分层——现在三段 execve 是同步的，弱沙箱下首次执行可能真的变慢；V-WS-4 取值后再决定；
- **WS-3** 自有导出功能的 `spawn` 五条纪律（现在没有自有导出实现，先作为规范）；
- **WS-4 收口**：插件路径执行面收窄到"只实测绝对路径"（已做第一步），"执行前确认清单"随弱沙箱包一起做。

## 六、插件加载与 `secretStorage`（2026-11-22 定谳，NF-015~NF-018）

> 输入：外部审计《OHSidian-坚果云与 BRAT 插件加载失败——合并定谳报告》（审计对象
> `main @ e528275`）。报告结论一句话：**两个插件不是同一种死法，也都不是 2.0 的代码改动
> 杀的**。工程侧可修的是它列的 NF-015/016/017/018 四条，本轮全部落地（补丁 rev **210**）；
> 报告里"2.0 无关"的增量考古（补丁层/引擎层 diff 与 eval/require/loadPlugin 零交集）不再
> 赘述，见原报告第三部分。

### 6.1 两种死法（一句话版）

| 对象 | 死法 | 工程侧对策 |
| --- | --- | --- |
| 坚果云 1.6.2（**有** 563「插件加载失败」弹窗） | 4.18 MB 的 `main.js` 在不稳链路被中段截断（审计实测确定性断点 1,548,288 B）→ `window.eval` 直接 SyntaxError → `enablePlugin` catch → 563 弹窗；设置页是下游症状（注册在 `onload` 最后一行） | **NF-015** 安装前完整性校验 + 代理重试 + 显式失败；**NF-016** 让失败有日志可取证 |
| BRAT 2.2.0（**无**弹窗，只有设置页消失） | 设置页注册在吞错异步链末端：`loadSettings → migrateTokensToSecretStorage → app.secretStorage.setSecret` → 内核桌面适配器 `k6` 读 `window.electron.remote.safeStorage` → 引擎零实现 → TypeError 被 `.catch(console.error)` 吞掉 → 注册永不执行、每启动复发 | **NF-018** `safeStorage` 明文兜底（对齐内核移动端 `C6` 语义）；**NF-016** 让被吞的那行 `console.error` 有据可查 |

两类失败的现场判别（支持用）：**有弹窗 = 同步链抛错**（先查 `main.js` 完整性）；
**无弹窗但设置页消失 = 吞错型**（先查 `secretStorage` 状态）。§6.6 给了 1 分钟话术。

### 6.2 NF-015：插件安装完整性（`installPlugin` 零校验）

原链（`app.js`，上游逐字）：`zy()` 只在**请求抛异常**时才走 `releases.obsidian.md/proxy`
重试；若对端在中段重置而网络栈仍报成功，`installPlugin` 把残缺字节**原样落盘**，
之后每次 `loadPlugin` 的 `eval` 必 SyntaxError，用户只看到 563，永远无法自愈。

新流程（`scripts/update-obsidian.mjs` 文本补丁，注入 `Plugins.prototype.__ohsidianFetchPluginBundle`）：

1. **先下载、后写盘**：manifest + `main.js` 在插件目录创建之前一起预取；
2. **同一语法门槛**：对 `main.js` 做 `new Function(text.replace(f4,"")+v4)`——与
   `loadPlugin` 的 eval 包装同构（`f4` 剥 sourcemap、`v4` 补 `/* nosourcemap */`）；空体或
   <64 字符直接判不完整；
3. **一次代理重试**：语法失败 → 经 `https://releases.obsidian.md/proxy?url=…` 再取一次；
   代理自身失败不会吞掉"截断"结论（仍报不完整）；
4. **失败即中止**：**未写任何文件**，安装对话框显示「安装失败：插件文件下载不完整（疑似网络
   截断），请更换网络后重试」，`console.error` 带原始错误（NF-016 会落盘）；
5. **已装坏的文件**：`enablePlugin` 的 catch 对 `SyntaxError` 追加专用 Notice
   （「main.js 无法解析：文件可能下载不完整…」），与普通加载错误区分；
6. 正常下载（含全部主流大插件）零额外行为：解析 4 MB 约 100 ms，只在安装时一次。

**实现边界（如实记录）**：① 预取失败会让**整单安装中止**——旧代码在 main.js 下载失败时
只记一行 `main.js not found` 并继续写 manifest，等于装一个缺件的插件；② ID 不匹配时会
先多下载一次 main.js（"先校验后落盘"的代价），用户只会看到 `Plugin ID mismatch.`。

**实现约束（P0 教训）**：内核压缩后的类成员是**一条逗号表达式**
（`return v(t,e),method1=...,method2=...,t`）。往方法链里插新成员必须用 `,` 连接且**不能带
`;`**——否则 `return` 提前结束，类工厂返回的是被插的函数而不是类：`new Plugins(app)` 得到
helper 返回的 Promise，`app.plugins` 变成 Promise，启动即报
`TypeError: i.app.plugins.on is not a function`（2026-11-22 真机回归，见 CHANGES 第 219 轮 §十）。
门禁 `verify-plugin-install` 现在会**取出出货 asar 里的 PluginManager 类工厂并求值**，断言
`installPlugin/enablePlugin/checkForUpdates/__ohsidianFetchPluginBundle` 都在原型上，
这类"语法合法但运行时类被破坏"的补丁不会再静默出货。

**为什么不用 `content-length`**：GitHub/CDN 对文本常做 gzip，引擎 `requestUrl` 解码后的
字节数与响应头长度不可比，误判会把**好插件**判坏。语法探测对审计实测截断点全命中
（1.0/1.5/2/3/4 MB 全部 SyntaxError；随机切点 300 个里 3 个仍可解析，另一次 500 个切点实测
14 个 ≈ 2.8%）。**残余**：切在语句边界、恰好仍可解析的截断拦不住——它会以"加载后
`No exports detected`（不是 SyntaxError）→ 通用 563"出现；这类只能靠卸载重装或将来的
`requestUrl` 层长度校验处理，不要把它当成已覆盖。

**门禁**：`scripts/verify-plugin-install.cjs`（由 `verify-asar.cjs` 调用，CI 自动覆盖）——
从**出货 asar** 里取出 helper 与机上诊断函数，用合成下载/合成仓库跑 5 个下载行为用例、
3 个 `safeStorage` 兜底用例、7 个诊断输出断言；不是只对 marker 字符串做检查。

### 6.3 NF-018：`secretStorage` 明文兜底

断链点（内核 `app.js` 逐字）：`k6` 构造 `n.safeStorage=window.electron.remote.safeStorage`。
引擎侧 `safeStorage` 零实现（wrapper `main.js` 与 ArkTS 树 grep 均 0），于是
`isEncryptionAvailable()` 抛 TypeError → 内核 `load()` 的 catch 吞掉 → `adapter=null`
→ `setSecret()` 抛 "Secure storage is not available." → BRAT 迁移失败。

两侧补丁：

| 位置 | 内容 |
| --- | --- |
| `touch-mode.js`（渲染层前置） | 定义 `window.__ohsidianSafeStorageFallback`：`isEncryptionAvailable()=false`、`getSelectedStorageBackend()="basic_text"`、`encryptString/decryptString` 明文透传；并尽力写入 `window.electron.remote.safeStorage`（getter-only 时静默失败，不影响 k6 回退） |
| `update-obsidian.mjs`（`k6` 构造） | 引擎 `safeStorage` **四个方法齐全**才采用；缺任一即用上面的兜底对象（内联副本，window 对象缺失时也可用） |

明文保存这一点与内核移动端适配器 `C6` 相同；但 **`isEncryptionAvailable()` 的返回值比 C6
更诚实**：`E6.isEncryptionAvailable()` 对 C6 返回 true（`!(adapter instanceof k6)`），所以
移动端不会弹「密钥未加密」警告；本补丁走 k6 路径返回 false，反而会触发内核自带的警告
（带"了解/忽略"按钮）。安全结论不变：插件可用、密钥不加密。

**安全取舍（明确记录）**：`app.secretStorage` 里的密钥（如 BRAT token）**明文落盘**
（localStorage `secrets-encrypted`）。这不是本轮引入的新暴露面——移动端内核本来就这么做——
但仍需产品确认接受；若将来引擎实现真实 `safeStorage`，检测通过即自动改用，无需再改补丁。
边界：不改变 SELinux 域、签名身份裁决、文件权限；只修 `app.secretStorage` 的桌面适配器。

### 6.4 NF-016：渲染层错误日志默认落盘（T2-9）

原状：console bridge 纯 opt-in，且开了要下次启动才生效；本案整个 21 秒日志**零渲染层输出**，
插件失败只能靠代码考古。现在三态（`localStorage.ohsidianConsoleCapture`）：

| 值 | 含义 |
| --- | --- |
| 不存在 | **仅错误（默认）**：`console.error` + `window.onerror` + `unhandledrejection` 落盘 |
| `"1"` | 全量（log/info/warn/error/debug） |
| `"0"` | 关闭（显式 opt-out） |

设置 →「常规」→「运行日志捕获」→ 切换 循环切换（仅错误 / 全量 / 关闭，重启生效）；
主进程侧继续写 `<Documents|userData>/OHSidian/console.log`（512 KB 单轮转，限流 40 行/s 不变）。
诊断状态页「调试」段新增「日志捕获」行显示当前档位。

**本轮同时修掉一条从未生效的旧接线（P1，独立审查发现）**：round-96b 的桥接用
`require("@electron/remote").ipcRenderer`，而 `@electron/remote` 的 renderer 入口只导出模块
getter（`app`/`dialog`/`BrowserWindow`…），**不导出 `ipcRenderer`** → 恒 undefined → 旧桥从上线
起一行也没发出去，`console.log` 从未产生。现改为 `window.electron.ipcRenderer ||
require("electron").ipcRenderer`（与内核自身 `electron.ipcRenderer.sendSync(...)` 同一通道），
门禁新增接线断言防回退。同一根因的既有 bug 一并修复：「迁移仓库到文件管理可见的位置」最后
一步 `remote.ipcRenderer.sendSync("vault-open")` 同样恒失败（用户看到"打开新仓库失败"并停留
在旧仓库）。

**隐私面（明确记录）**：默认档会把 `console.error` 原文写入**公共 Documents** 下的
`<Documents>/OHSidian/console.log`（Documents 不可用时落 userData），插件错误串可能含仓库
路径、URL 或 token。这是"失败可取证"的取舍；要停用就切「关闭」档（显式 opt-out）。

### 6.5 NF-017：WMS decor 能力缓存（T2-2）

触屏冷启动固定 6+ 条 E/W：`SetWindowTitleMoveEnabled: The device is not supported` ×3 轮、
`GetTitleButtonVisible: device not support` ×2、`{"code":801}` ×3（title move/topmost/modal）。
新增 `web_engine/src/main/ets/common/WindowDecorCapability.ets`：

- 按调用 kind 缓存 801；**首次**一条 info 点名该能力，之后同类 801 降 debug（不再每次刷 E/W）；
- **不跳过任何调用**：801 可能是形态相关的（同一进程里触摸全屏窗没有标题条，
  而另一扇自由窗仍然需要 caption/拖动/modal），应用层无法可靠区分"设备不支持"与
  "当前形态不支持"，跳过会让后开的自由窗少配置一项——这是有回归风险的"优化"；
- 真正的噪声削减来自**调用点门控**：启动装饰块的标题条族只在窗口形态（`captionForm()`，
  即 `inWindowForm() || 2in1`）时调用；`AppWindowAdapter.setUseNativeFrame` 路径仍会调用
  （它必须按 Obsidian 的 frame 决策改标题条），那里只靠日志降级；
- 非 801 错误保持 warn（不静默）。

配套：启动装饰块里"标题条族"（titleMove/titleButtons/topmost/resizeDrag）只在窗口形态调用
——与 Round 154「decor 是形态属性」同一结论；2in1 必须用 `captionForm()` 显式纳入（其
`inWindowForm()` 恒 false，只按它判断会漏发）；触屏全屏只留一条 debug。
证据锚点：`decor API answered 801 (device does not support it): <kind> - repeats at debug level`
（每 kind 一次 info，之后 debug）。
`ensureSystemCaption` 的既有 801 语义（返回 false + latch）不变。
与状态机的关系：横切 A（装饰）**仍未**由形状机驱动（§8.3 差异 3 不变），本轮只做能力缓存
与噪声治理，避免把"能力缺失"误当成"状态错误"。

### 6.6 支持话术（用户/同学侧，1 分钟判定）

1. **有「插件加载失败」弹窗** → 同步链抛错（坚果云类）。**设置 → OHSidian 设置页 →「诊断」组
   →「插件排查（清单 / 错误 / 日志）」→ 检查**（或命令面板同名命令）：
   `BAD … main.js … 无法解析` = 文件被截断，卸载后换网络重装；字节数对但仍 BAD = 真损坏，
   重装同版本；`SKIP` = 超过 6 MB 未解析，需对照发行包大小人工确认。
2. **无弹窗、只是设置页不出现** → 吞错型（BRAT 类）。同一诊断看 `secretStorage` 行：
   `OK … true` 正常；`WARN … false（明文模式）` 可用（预期）；`BAD`/`THROWN` 才是引擎断链
   （本版已兜底，正常应显示 WARN）。
   若设置导航里出现**两个同名插件设置页**：这是补注册与插件自身注册重复（rev 202 已按插件 id 去重，
   打开设置时会自动清理，报告「插件加载状态」里也不会再重复列）。
   若同时看到「插件 “obsidian42-brat” 在加载时遇到错误」：那是 Obsidian 对**插件
   onLayoutReady 回调抛错**的提示（BRAT 2.2.0 在回调里才调 `addSettingTab`，抛错后设置页
   永远注册不上）。rev198 起：诊断的「插件加载状态」段会显示是否已补注册（`设置页自愈`），
   「渲染层日志」段直接给出该回调的错误栈；补丁本身也会在 layout-ready 后与每次打开设置页时
   自动补注册未注册的插件设置页（失败明细带栈写进日志）。
   若补注册失败信息里出现 `is not a function`（典型：`R is not a function`，`R` 是插件内部
   `getTranslations`）：这是**插件文件本身是残缺/非官方构建**——诊断的「BRAT main.js 指纹」段会给出
   字节/行数/sha256 并与官方对照；**注意内核安装会追加 `\n/* nosourcemap */`（+18 B、+1 行），
   诊断会先归一化再比对**：官方 2.2.0 原始资产 = 138,873 B/45 行/`d2fb579d4e83162a`，经内核安装后 = 
   138,891 B/46 行/`44956ba123c4d1a1`，两者都判「官方完整」。对不上才卸载重装官方包，不要改内核。
   另外诊断会比对 `main.js` 修改时间与本会话启动时间：重装插件后**必须完全退出应用再启动**，
   否则跑的还是旧代码（诊断显示「当前运行的是旧代码」）。
3. **要完整栈**：默认已捕获 error 级；全量用命令面板切「全量」并重启，取
   `<Documents|userData>/OHSidian/console.log`（512 KB 轮转，旧文件 `.old.log`）。
4. 诊断输出都有复制按钮：报告弹窗「复制详细信息」、设置内联「复制结果」。
5. 坚果云版本锚点：1.6.2 `main.js` = **4,182,455 B**；BRAT 2.2.0 = **138,873 B**
   （其他版本对照 GitHub release 资产大小）。

### 6.7 真机定谳步骤（替代报告 §五的控制台探针）

1. 装本版（rev 210）HAP；设置 →「诊断」→「插件诊断」→ 运行；
2. `secretStorage` 行：期望 `WARN adapter=有 · isEncryptionAvailable=false（明文模式）`，
   `引擎 safeStorage: undefined（引擎缺口；补丁已兜底为明文透传）`——若 remote 对象整体缺失则
   该行显示 `window.electron.remote 不可用`，同属引擎缺口，补丁同样兜底；
3. BRAT：重装 2.2.0 → 设置页应出现；诊断里「BRAT 迁移标记: 存在（迁移已跑过）」；
4. 坚果云：市场卸载 → 重装 1.6.2 → 加载成功、设置页出现；若中途报「下载不完整」，
   那是 NF-015 按预期拦截，换网络重试即可（不会再落一个坏文件）；
5. 触屏冷启动：hilog 里 decor 噪声从 6+ 条降为**每个 kind 至多一条 info**
   （`decor API answered 801 (device does not support it): <kind>`；触屏预计 ≥2 个 kind：
   `modal` + `setUseNativeFrame` 路径的 `titleMove`/`titleButtons`）；WMS 原生打印的
   `SetWindowTitleMoveEnabled: The device is not supported` 只对未被门控的那几次调用保留；
6. 渲染层失败取证：故意禁用/删除某插件 `main.js` 后重启，`console.log` 应出现
   `[OHSidian:web][error] Plugin failure: …`。

### 6.8 验证记录（2026-11-22，本机）

- `node scripts/update-obsidian.mjs --repatch` → 内嵌 `verify-asar`（含
  `verify-plugin-install` 行为用例）全绿；
- `assembleHap` **BUILD SUCCESSFUL**；HAP 内 `ets/modules.abc` 含 `WindowDecorCapability`
  与 `decor API answered 801`；HAP 内 `obsidian.asar` 复核 `OHSIDIAN_PATCH_REV="210"`、
  四条 NF 标记、console bridge 错误默认档；
- `verify-release` / `check-docs` 全绿；
- 独立只读审查（2026-11-22，对照冻结态代码 + 出货 asar 逐字）：NF-015/017/018 无 P1/P2；
  NF-016 1 个 P1（bridge 接线死路）+ 3 个 P2（门禁假保障、文档入口、验收锚点），全部修复并
  复跑门禁，详见 `docs/CHANGES-2026-10.md` 第 219 轮 §九；
- **未做真机验证**（本机无设备），V-1~V-6 见 §6.7。

### 6.9 仍未做（本轮范围外）

- 报告 §1.5.1 的**引擎网络栈截断语义**仍无法从仓库闭环（NF-015 让上层可判定、可重试，
  但"半截响应是否被当成成功"取决于引擎闭源面）；若真机复现拦截率不足，再评估
  `requestUrl` 层长度校验；
- 安装完整性只覆盖**市场安装/更新**（`installPlugin`）：手动放入/BRAT 自装的插件只能靠
  §6.7 诊断事后判定；要做主动修复需在 `loadPlugin` 失败时引导重装（未做）；
- BRAT 2.3.0-beta 与旧版 2.0.8 回退话术待真机确认；
- `secretStorage` 的**真加密**（引擎补齐 `safeStorage`）仍是 NF-018 的长期项；
- NF-017 只覆盖 decor family；`GetTitleButtonVisible` 等**引擎内部**调用由引擎发起，应用层管不到。

### 6.10 插件排查面（rev 201，泛化）

设置「诊断」→「插件诊断」（唯一入口）从"BRAT 专用检查"
泛化为通用插件排查面，报告一次性给出：

1. **环境**：补丁 rev、内核版本、布局/沙箱、`secretStorage` 状态（明文/可用/断链）；
2. **插件清单**：每个已安装插件的版本、`main.js` 字节/行数/解析结论（与 `loadPlugin` 同一语法门槛）、
   已启用/未启用、运行中/未加载、设置页已注册/未注册，以及该插件**最近一次记录到的错误**；
3. **插件错误（最近 12 条）**：本会话 + 上次会话，含时间、插件 id、错误首行、`plugin:<id>:行:列`、
   前 4 行错误栈；记录去重（连续相同错误合并为 `×N`）并持久化到
   `<Documents|userData>/OHSidian/plugin-errors.json`（最多 60 条），重启后仍能看到；
4. **BRAT 专项**（安装时）：文件指纹（字节/行数/sha256，含内核安装标记归一化）、最近注册失败的源码位置、
   文件修改时间 vs 本会话启动时间（重装后未重启会被判"当前运行的是旧代码"）；
5. **渲染层日志**：`console.log` 优先列出 `[error]` 与插件相关行（最多 40 行）；
6. **支持文件**：`console.log` 与 `plugin-errors.json` 的绝对路径，报告可一键复制。

**错误归属规则**（`ohsidianRecordConsoleError`）：内核 `Plugin failure: <id>` 行、我们自己的
`plugin setting tab registration failed: <id>` 行、以及任何 `Error.stack` 里带
`plugin:<id>:<line>:<col>` sourceURL 的错误（所有插件模块都是经 `window.eval` 带 sourceURL 求值的）——
据此归到具体插件；没有归属的错误不进插件错误表（仍进 console.log）。
「插件诊断」卡片另有「清空错误记录」链接（同时删除持久化文件）。

**设置页注册去重（rev 202）**：补注册按**插件 id** 幂等；每次运行还会清理 `pluginTabs` 里同一插件的重复项
（保留第一个），并刷新设置页导航。背景：补注册若早于插件自己的 `onLayoutReady` 回调执行，双方各注册一次
同一 tab，真机上表现为设置页出现两个同名条目；调度已推迟到 layout-ready 之后 3.5s，且 layout-ready 回调内
不再补注册。

**设置页即排查入口（rev210 最终形态）**：设置 →「诊断」组只有三张卡片，版式与报告格式完全统一：
1. **通用诊断**：补丁/内核/窗口/布局/沙箱/日志路径与行数/插件数量；按钮「运行」「清空日志」；
2. **Pandoc**：外部路径环境检查（卡片内提供 Pandoc 路径输入框）+ 内置 pandoc 3.10 (WASM) 状态/宿主/自检；按钮「运行」；
3. **插件诊断**：插件清单（版本/大小/解析/启用/加载/设置页）、错误记录、BRAT 指纹、日志路径；按钮「运行」「清空错误记录」。
报告一律为「补丁/内核」头 + ▍小节 + "键: 值" 行，不含分析/建议语句；设置页是唯一入口（命令面板诊断命令已移除）。
日志档位切换属于普通设置，移到「常规」组的「运行日志捕获」。

**日志尾部只显示本会话（rev204）**：console.log 是跨启动追加的，早期版本报错会一直留在文件里，截图时看起来
像"现在还在报"。报告现在按行首时间戳与本会话启动时间过滤，只显示本会话的行，并注明"已折叠更早会话 N 行"；
本会话没有错误行时明确写"(本会话还没有日志行)"。要彻底重来，用设置里的「清空渲染层日志」。

**已修的两个插件相关问题（rev202/203 真机日志驱动）**：
- BRAT 设置页重复：补注册与插件自身注册撞车 → 按插件 id 幂等 + 去重（§6.10 上文）；
- Nutstore Sync 反复报 `duplicate setting key "group:模块开关"`：内核按 `type:heading` 生成设置项 key，
  插件里两个同名 heading 的 group 必冲突；rev203 给 key 加位置后缀（唯一且跨重渲染稳定），
  告警消失、也避免 keyed diff 把两组的 DOM 复用到一起。
- 历史上日志里的 `R is not a function`/`{}`/`Failed to load settings` 均来自坏包或 P0 构建时代的旧会话，
  不是当前缺陷。

**排查顺序建议**：先看「插件清单」的 `!` 尾注定位是哪个插件、再看「插件错误」拿栈、
最后看「渲染层日志」补齐上下文；把整份报告复制给维护者即可。

### 6.11 内置 Pandoc（WebAssembly，rev 205）

**目标**：在不申请 `CUSTOM_SANDBOX`（平板平台禁 `fork+exec`、HNP/HAP-bin 仅 PC/2in1）的前提下，
让 PC 与平板都能使用**真实 Pandoc**（不是子集实现）。

**方案**：内置官方 WebAssembly 构建 [`pandoc/pandoc-wasm`](https://github.com/pandoc/pandoc-wasm)
（Pandoc 3.10，GPL-2.0-or-later），在渲染进程内执行，不经过 `execve`。

| 部件 | 说明 |
| --- | --- |
| `scripts/build-pandoc-wasm.mjs` | 按 `scripts/pandoc-wasm.lock.json` 下载 npm 包并校验 sha256；生成 `pandoc.wasm.gz`（55.9 MB → 15.5 MB）+ 打包后的 `pandoc-service.cjs`（core.js + WASI shim + CLI 适配，≈83 KB）；同时写出 GPL/来源说明。 |
| `scripts/pandoc-wasm/service-core.mjs` | CLI 适配层：`shellSplit`/`parseArgs`、输入与资源读取、`--reference-doc`/`--template`/`--bibliography`/`--csl`/Lua filter/image 收集、`--version` 快速应答、PDF/可执行 filter 的明确拒绝；`createService(createPandocInstance,{wasmGzPath})` 懒加载 wasm。 |
| `scripts/patches/pandoc-wasm.js` | 渲染层补丁：`Module._load` hook，把插件的 `require("child_process")` 换成 shim（`exec`/`execFile`/`spawn` 接管 pandoc；`execSync`/`spawnSync` 明确报错）、`lookpath`/`which` 返回占位路径；定位 `pandocDir`（ArkTS 发布）并暴露 `window.__ohsidianPandoc`。 |
| `WebAbility.publishPandocDir()` | 把 `resourceDir + '/resources/resfile/pandoc'` 写入模式文件，渲染层据此读资源。 |
| 设置/诊断 | 设置「诊断」→「Pandoc」卡片：路径输入（环境检查用）+ 一键报告（环境 + 内置 WASM 状态/宿主/自检）。 |

**实测（本机 Node，pandoc-wasm@1.1.0）**：gunzip+实例化 ≈0.3 s；md→docx 80–300 ms（首次 ≈1 s）；
md→html/pptx/odt/epub 毫秒级；285 KB md→html ≈2.8 s；`--version` 不加载 wasm（1 ms）。
HAP 增大 ≈16 MB（原始 120.5 MB → 137.7 MB）。

**已知限制**（插件兼容边界）：
1. **不能输出 PDF**（Pandoc 的 PDF 需要外部 LaTeX/Typst/xelatex；拦截层返回明确错误并指向内置 PDF 导出）；
2. 沙箱内不联网：远程图片/URL 资源需由调用方先本地化（本地图片会被自动收集传入）；
3. 只支持 Lua filter，可执行 filter（`--filter` 指向脚本/程序）会被拒绝；
4. `execSync`/`spawnSync` 无法在异步 WASM 引擎上同步阻塞，明确报错（主流插件用异步 `exec`/`spawn`）；
5. 大文档在单线程 WASM 中较慢（≈3 s/300 KB），可接受；内存峰值 +100–200 MB。

**合规**：pandoc-wasm/pandoc.wasm 为 GPL-2.0-or-later；HAP 内附 `LICENSE-pandoc-wasm.txt` 与
`PANDOC-SOURCE.txt`（源码/构建来源）。项目源码本身公开，满足 GPL 的源码提供义务。

**rev206 修正（真机第一次运行暴露）**：
1. **`pandocDir` 未发布**：rev205 在 ArkTS 里直接拼 `resourceDir + '/resources/resfile/pandoc'`，设备上的实际
   安装布局与该假设不一致。现在 `publishPandocDir()` 用 `fileIo.accessSync` 对 `resourceDir`/`bundleCodeDir` ×
   `''` / `/resources/resfile` / `/resources` 的候选矩阵做存在性探测，发布真正包含 `pandoc-service.cjs` 的目录，
   并把 `pandocDirTried` / `resourceDir` / `bundleCodeDir` 一并写进模式文件；渲染层同样维护多候选路径、失败不缓存
   （ArkTS 晚发布也能自愈），并额外尝试 `execPath` / `resourcesPath` / `appPath` / 固定绝对路径。
2. **自检点下去没有弹窗**：资源缺失时 `getService()` 同步抛错，被点击处理器的 try/catch 吞掉。现在
   `selfTest()`/`run()` 一律返回 Promise（错误走 `.catch`），失败时**总是**打开报告弹窗，内容包含错误 + 路径探针
   （模式字段、引擎路径、每个候选目录是否存在），随「Pandoc」报告一起输出。

**rev207 修正（真机 rev206 暴露）**：设备渲染进程里 `WebAssembly is not defined`（该鸿蒙引擎的 V8 构建/上下文
没有 WebAssembly），因此 wasm 引擎不能在渲染进程初始化。修法：
1. 主进程补丁（`scripts/patches/main-process.js`）注册 `ohs-pandoc-call` / `ohs-pandoc-host` IPC：主进程持有
   pandoc-service 实例（`require` 资源里的 CJS bundle），转换串行化；
2. 渲染层 `getService()` 检测 `typeof WebAssembly`：不可用时自动改用主进程代理（`ipcRenderer.invoke`），
   对外接口不变（`runCli/query/selfTest/info`），插件与设置页无感知；
3. 自检报告新增「执行位置」与「宿主 WebAssembly：渲染进程/主进程」；失败弹窗也会带这两项，
   如果主进程同样没有 WebAssembly，报告会明确写出（下一步需换纯 JS/WASM 解释器方案）。
另外「Pandoc 环境检查」按钮现在也会弹出报告窗口（此前只写入设置页内联区域）。

**rev208 修正（rev207 真机验证暴露）**：主进程执行同样报 `WebAssembly is not defined`——说明该引擎把 **V8 以
`--jitless` 模式启动**（HarmonyOS 规避 JIT），而引擎二进制本身是 `v8_enable_webassembly: 1`；Node 实测
`--jitless --no-jitless` 可恢复 WebAssembly。因此：
1. 新增 `scripts/pandoc-wasm/pandoc-host.cjs`（随 HAP 打包）：在独立进程中加载 `pandoc-service.cjs`，通过
   `process.parentPort`（utilityProcess）或 IPC（child_process.fork）收发 `{id,kind,...}` 请求；
2. 主进程优先用 `utilityProcess.fork(hostPath, [], {execArgv:["--no-jitless"]})` 起这个工具进程；不可用时退回
   `child_process.fork(..., {env:ELECTRON_RUN_AS_NODE:1, execArgv:["--no-jitless"]})`；主进程自身有 WASM 时仍
   直接在主进程执行（PC 上可能如此）；工具进程崩溃只影响导出，不影响主界面；
3. 「Pandoc」报告内置宿主诊断：渲染进程/主进程/工具进程的 `typeof WebAssembly`、`js-flags`、
   utilityProcess 可用性、工具进程错误；自检失败弹窗也会带这些行；
4. 若工具进程报告 `wasm=undefined`，说明 `--no-jitless` 被平台拒绝（JIT 被禁），该路线在设备上不可行，
   需要另做纯 JS 转换方案。

**rev209**：utility 进程 cwd 为 `/`，自检写临时文件 EACCES → 主进程随请求传 `tmpDir=app.getPath("temp")`，
host 用该目录创建服务，自检文件名带 pid；成功后自检三项应全 OK。

**门禁**：`node scripts/build-pandoc-wasm.mjs --check`（lock sha256）与 `node scripts/verify-pandoc-wasm.cjs`
（真实转换：md→html/docx、reference-doc、Lua filter、本地图片、PDF/exec-filter 拒绝、`--version` 延迟）；
`verify-asar` 另有 2 条标记（patch 已内置、诊断已接线）。
