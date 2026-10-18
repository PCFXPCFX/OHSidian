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
