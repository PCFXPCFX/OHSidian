# OHSidian 真机探针 / 自动修复 Agent（内部 / 仅操作者）

> **仅开发操作者使用，不随 release 发布**：`tools/device-agent` 已标记为
> `.gitattributes export-ignore`，release HAP 也不包含它。release app.js 不注入
> `scripts/patches/ohsidian-probe.js`，并会在 repatch 时移除所有 `probeHook(...)` 调用。
> 使用者只需要连接设备；Agent 的运行由维护者（我）执行。

这个目录是“连上真机 → 模拟点击 → 读日志 → 看延迟/加载时间 → 定位并修复”的工具链。
它不替代 DevEco 调试器；它把重复的真机操作固化成可重放的场景，并把渲染层/ArkTS 的
结构化探针汇总成一份可比较的报告。

## 前置

- Windows + DevEco Studio（默认 `D:\program\DevEco Studio`，可用 `--hdc` 覆盖）。
- 设备已开启开发者模式/USB 调试，`hdc list targets` 能看到设备。
- 已安装一次 HAP（或使用 `agent.mjs install`）。
- 测试 PDF 已放进当前 vault；建议放在根目录并命名为 `agent-test.pdf`。
- 手写笔模式、手指绘制等设置按场景需要预先打开（Agent 也能点设置，但坐标因设备而异）。

## 快速开始

```powershell
# 1. 设备与包信息
node tools/device-agent/agent.mjs doctor

# 2. 安装当前 HAP（会覆盖安装，保留数据）
node tools/device-agent/agent.mjs install

# 3. 启动并清空 hilog
node tools/device-agent/agent.mjs launch

# 4. 跑一个场景（默认会读 profile 的坐标）
node tools/device-agent/agent.mjs run --scenario pdf-scroll

# 5. 只看日志/生成报告
node tools/device-agent/agent.mjs logs --out reports/manual.json
```

报告写到 `reports/<时间>-<场景>/`：

- `report.md`：人读的结论、指标、异常和建议。
- `report.json`：Agent 可继续消费的原始指标与探针事件。
- `screen-*.jpeg`：关键步骤截图（如果 `snapshot_display` 可用）。

## 场景

`scenarios/*.json` 是简单步骤 DSL：

```json
{
  "name": "pdf-scroll",
  "waitBefore": 1500,
  "steps": [
    { "click": [0.5, 0.35] },
    { "wait": 800 },
    { "swipe": [0.5, 0.75, 0.5, 0.25], "duration": 450 },
    { "wait": 2500 }
  ],
  "expect": { "maxFirstPageMs": 2500, "maxWhiteRate": 0.1 }
}
```

坐标可以写 `[x, y]` 物理像素，或 `{"css": [x, y]}`，由 profile 的 `dpr` 换算。
`click` / `swipe` / `longClick` / `text` / `key` / `wait` / `screenshot` 是内置动作。

## 探针（应用内）

渲染层在关键路径输出 `InkUI probe:<event> {json}`（hilog）：

| event | 关键字段 | 用途 |
|---|---|---|
| `boot` | `dpr/screen/touch/coarse/fakeWorker` | 确认设备几何与 worker 是否退回主线程 |
| `pdfSurface` | `pages/scale/overlay/dpr` | PDF 视图创建时 |
| `pdfDocLoaded` | `pages/ms/fakeWorker` | 首次解析耗时；`fakeWorker>0` 是慢/白屏的头号原因 |
| `pdfPagesInit` | `pages/ms` | 页对象初始化 |
| `pdfPage` | `page/ms/w/h/white/dark/afterWrite` | 每页渲染耗时、白页采样、写回后是否白屏 |
| `pdfReload` | `reloads/ms/afterWrite` | 写回后 viewer 重载 |
| `pdfViewerReplaced` | `afterWrite` | 写回触发 viewer 重建 |
| `pdfWriteStart/End` | `ms/ok/error/bytes/style` | 写回总耗时与结果 |
| `pdfPayload` | `strokes/pts/sample` | 写入前坐标/点数抽查（排查“艺术画”） |

ArkTS 侧：

- `PdfInkWriter timing load/add/save/verify ...`
- `PdfInk page=... style=... ms=... ok=...`

## 自动修复（保守）

```powershell
node tools/device-agent/agent.mjs fix --list
node tools/device-agent/agent.mjs fix --apply pdf-cap-50 --scenario pdf-scroll
```

每个 fixer 只做一处**可逆**的源码替换，然后 `update-obsidian --repatch` + `hvigorw
assembleHap` + 安装 + 重跑场景。只有指标变好才保留；否则自动回滚。当前 fixer：

| id | 触发症状 | 改动 |
|---|---|---|
| `pdf-cap-50` | 整窗宽 PDF 内存高/白页 | 高 DPI 触摸设备的 `capCanvasAreaFactor` 0 → 50 |
| `pdf-ink` | 折线注释不显示/不可接受 | 默认注释样式 polyline → ink |
| `pdf-lazy-overlay` | 长 PDF 打开卡 | 叠层观察范围/挂载策略（预留） |

自动修复不会改业务逻辑以外的东西；每次改动都有 inverse，失败会 `git checkout --`
对应文件（只限 fixer 自己改的文件）。

## 局限

- `uitest uiInput` 发送的是触摸，不携带笔压；笔压/倾斜需要手动书写或另接
  `uinput`/Pen Kit 采样。
- 不同 HarmonyOS 版本的 `uitest` 参数可能不同；本工具把命令原样打印，失败时可手工重放。
- 截图/坐标随设备分辨率变化，profile 需要校准。
- 报告里的“白页”是 32×32 降采样 + 暗像素阈值判定，扫描页/纯图片页可能误判。
