# 手写特性回归评测（stylus-eval）

发布前跑一遍，确认这次改动没有破坏**已经上线过的手写功能**；同时把每个功能录成
MP4 + GIF，直接用于酷安/B 站宣传。

- 脚本：`scripts/stylus-eval/`
- 场景定义：`scripts/stylus-eval/manifest.mjs`
- 产物：`artifacts/stylus-eval/<时间>-<版本>/`（已 gitignore）
- 不需要设备也能验证链路：`node scripts/stylus-eval/run.mjs --selftest`

## 术语

| 叫法 | 指什么 |
|---|---|
| **原版 Obsidian** | 官方 Obsidian（桌面/移动端），没有鸿蒙平板适配，也没有手写层 |
| **平板适配版** | 本项目早期只做触摸/窗口/避让的提交（`initial` … `window frame update`） |
| **手写魔改版** | 当前版本：在平板适配之上加了 M-Pencil、PDF 写回、一笔成形等（ink v58） |

报告里的“原版”列统一指**原版 Obsidian**；仓库里的 commit 都是我们的平板魔改，
不再用某个旧 tag 冒充原版。

## 一、为什么这样设计

手写功能没法用纯单元测试覆盖：输入是笔尖压力、倾斜、设备采样率，输出是画布像素、
边车 JSON 和写回后的 PDF 二进制。所以评测分成三层：

| 层 | 手段 | 能发现什么 |
|---|---|---|
| 行为 | 按提示用笔操作，逐场景录屏 | 手感、闪烁、错位、颜色 |
| 探针 | 渲染层 `probeHook` → ArkTS `InkUI` → hilog | 压力/线宽/事件计数/写回结果等硬指标 |
| 断言 | `manifest.mjs` 里的不变量 + `baseline.json` 漂移 | 增量代码把旧功能改坏 |

**人工引导**是刻意的：一笔成形、点预测、压感橡皮依赖 HarmonyOS 的笔事件，脚本无法
伪造出真实压力与 Pen Kit 回调。脚本负责“计时、录屏、抓日志、判卷、切片”，人只负责
按提示画。

## 二、探针

渲染层 console 不会进 hilog（既有结论），所以探针走
`window.__ohsidianNativeSend({action:"inkLog"})` → `Index.ets` → `console.info('InkUI', …)`。
每个事件带 `_ts`（渲染层 `Date.now()`），用于把事件映射到场景时间窗。

| 事件 | 关键字段 | 证明什么 |
|---|---|---|
| `boot` | `rev`、`inner`、`dpr` | 装的是 **agent 构建**（release 构建没有探针） |
| `inkStroke` | `tool`、`points`、`pressureMin/Max`、`widthMin/Max`、`ms`、`straight`、`shape`、`predict`、`blend` | 压感、线宽、长按拉直、形状、预测、PDF 混合模式 |
| `inkErase` | `mode`、`removed`、`changed`、`ms` | 局部/整笔/压感橡皮 |
| `inkShape` | `source`(native/local)、`type`、`points`、`closed` | 一笔成形与本地兜底 |
| `inkShapeGuess` | `type` | 抬笔时的本地形状判断（含未命中） |
| `inkLasso` | `points`、`selected` | 套索圈选 |
| `inkLassoAction` | `action`(move/duplicate/delete)、`n` | 套索移动/复制/删除 |
| `inkPredict` | `firstMs` | 点预测真正被使用 |
| `inkPref` | `key`、`value` | 设置项切换（橡皮模式、点预测开关等） |
| `pdfBlend` / `pdfEmbedBlend` | `mode` | 浅色 PDF 页使用 `multiply` |
| `pdfPayload` | `strokes`、`hl`、`tools`、`originX/Y` | 写回载荷含荧光笔、CropBox 原点 |
| `pdfWriteEnd` | `ok`、`ms`、`bytes` | PDF 写回成功 |

release 构建由 `scripts/update-obsidian.mjs` 的 `stripDevProbeCalls()` 剥掉
`probeHook(...)` 调用与探针实现，`verify-release.cjs` 会拦截残留符号。

## 三、场景

| # | id | 功能 | 窗口 |
|---|---|---|---|
| 01 | `pen-pressure` | 压感笔迹 | 12s |
| 02 | `hold-straight` | 长按拉直 | 10s |
| 03 | `highlighter-pdf` | PDF 荧光笔（黑字不被冲淡） | 14s |
| 04 | `pdf-writeback` | PDF 标注写回与坐标 | 16s |
| 05 | `eraser-partial` | 局部橡皮 | 10s |
| 06 | `eraser-stroke` | 整笔橡皮 | 12s |
| 07 | `pressure-eraser` | 压感橡皮 | 14s |
| 08 | `shape-square` | 一笔成形：方形 | 10s |
| 09 | `shape-circle` | 一笔成形：圆形 | 10s |
| 10 | `lasso-move` | 套索选择/移动 | 14s |
| 11 | `lasso-copy-delete` | 套索复制/删除 | 22s |
| 12 | `predict` | 点预测（实验） | 12s |
| 13 | `markdown-highlighter` | Markdown 荧光笔 | 12s |
| 14 | `undo-redo` | 手写撤销 / 重做 | 16s |
| 15 | `pdf-embed` | Markdown 内嵌 PDF 手写 | 16s |
| 16 | `canvas-ink` | Canvas 白板手写 | 12s |
| 17 | `eraser-hl-only` | 只擦荧光笔 | 14s |
| 18 | `palm-rejection` | 掌托防误触 | 12s |

每个场景在 `manifest.mjs` 里声明：原版行为、我们的行为、准备步骤、操作、时间窗、
必需探针、断言、宣传文案。新增功能时**必须同时加场景**，否则 gate 不会保护它。
`palm-rejection` 没有可自动断言的探针，只做人工目视（`PASS*`），其余场景的
断言都参与 gate。

## 四、跑法

### 1. 生成带探针的安装包

```powershell
node scripts/build-agent.mjs
```

它会：

1. `--repatch --agent` 注入探针；
2. 构建 HAP；
3. 复制到 `artifacts/agent/OHSidian-agent-<版本>-<时间>.hap`（**不覆盖 release 包**）；
4. 无论构建成功与否，都重新 repatch 回 release 并跑 `verify-release`。

> agent 包只用于演示/评测，**绝不发布**。日常发版走普通 `hvigorw`；
> `build-agent.mjs` 结束后工作区的 asar 已经恢复成 release 状态。
> 性能探针里的“滚动 PDF 采样”默认关闭，只有显式
> `window.__ohsidianPerfScroll = true` 才会运行，避免评测时 PDF 自己往下滑。

### 2. 第一次：安装 + 推测试素材

```powershell
node scripts/stylus-eval/run.mjs --mode list
node scripts/stylus-eval/run.mjs --mode doctor   # 先确认 hdc/hilog/录屏/探针
node scripts/stylus-eval/run.mjs --mode capture --version v2.0.0 `
  --install artifacts/agent/OHSidian-agent-2.0.0-<时间>.hap `
  --push-fixtures --vault "/storage/Users/currentUser/Documents/Obsidian Vault"
```

`--mode doctor` 会启动应用、检查 `probe:boot` 是否存在、测一次 `screenrecord`
参数与截图命令、读一次 hilog、算设备时钟偏差，并把能力写到
`artifacts/stylus-eval/doctor-<时间>/doctor.txt`。第一次联机建议先跑它。

`--vault` 只需给一次，会写进 `scripts/stylus-eval/config.local.json`（已 gitignore）。
素材在 `scripts/stylus-eval/fixtures/vault/ink-eval/`：`01-pen.md` 空白页、
`02-pdf.pdf` 上半页印刷黑字、下半页留白。

> 评测开始前脚本会 `aa force-stop` 再启动一次应用，确保读到本次构建的探针；
> 没保存的笔记请先保存。

### 3. 正式录制（宣传素材）

```powershell
node scripts/stylus-eval/run.mjs --mode capture --version v1.4.2
```

PC 终端逐个场景提示“准备/操作”，按 Enter 后 3 秒倒计时，再给一个固定窗口用笔操作。
每个场景单独录一段，结束后自动切片、转 GIF、判卷。

### 4. 发版门禁（不录屏，快）

```powershell
node scripts/stylus-eval/run.mjs --mode gate
```

只跑断言，失败退出码 1。第一次跑完可以 `--bless` 把本次指标存成基线：

```powershell
node scripts/stylus-eval/run.mjs --mode gate --bless
```

之后 gate 会把指标和基线比，偏差 >50% 打警告；`--strict-drift` 可升级为失败。

### 5. 不联机自检

```powershell
node scripts/stylus-eval/run.mjs --selftest
```

用 ffmpeg `testsrc2` 合成画面、伪造 hilog 探针行，跑完整的
“解析 → 断言 → 切片 → GIF → 报告”链路，并验证一个**故意失败**的负向用例。
自检产物带 SELFTEST 水印，不能用于宣传。

## 五、产物

```
artifacts/stylus-eval/20261102-213000-v1.4.2/
  REPORT.md                 # 技术报告：逐场景断言、指标、片段、复现命令
  PROMO.md                  # 宣传素材包：清单 + 酷安/B站文案
  gate.json                 # 门禁结果
  session/
    hilog.txt               # 本次会话的原始 hilog
    console.log             # 渲染层日志（开了“运行日志捕获”才有）
    metrics.json            # 每场景 counts/values，供 baseline 使用
  scenes/
    01-pen-pressure/
      clip.mp4              # 1080p H.264 / yuv420p / faststart，直接传 B 站
      clip.gif              # 720px / 12fps，酷安正文预览（<10MB）
      poster.png            # 封面
```

## 六、录制策略

`--capture auto` 时按能力选择：

1. **screenrecord**（首选）：`hdc shell screenrecord --time N <path>`，整段录制后按
   场景时间窗切。平滑、体积小。不同 HarmonyOS 版本参数可能是 `--time` 或 `-t`，
   脚本读 `--help` 自动选。
2. **截图帧**（降级）：`snapshot_display`（或 `uitest screenCap`）循环抓帧，每帧带
   时间戳，按真实间隔拼成视频。约 2–5 fps，画面偏顿，但功能验证足够。
3. **fixture**（仅自检）：`testsrc2`。

GIF 超过 9.5MB 会自动降到 540px / 10fps 再编一次。

## 七、判卷规则

- 断言只写**不变量**：压力必须到达渲染层、线宽比必须 >1.35、整笔橡皮必须
  `removed>=1`、PDF 载荷必须 `hl>=1` 且写回 `ok=true` 等。人手每次画的线不同，
  绝对值只进报告，不参与通过/失败。
- 缺探针 = 失败：说明装错构建，或者改动把探针删了。
- `manual` 检查（如“按住期间没画出墨点”）只标 ⚠️，不参与 gate；需要人看 GIF。
- 基线只做漂移提示，避免人手抖动造成假失败；需要严格时加 `--strict-drift`。

## 八、已知限制

- 设备与 PC 时钟只对到秒级，场景窗两侧各留 1.2s 余量；相邻场景事件可能重叠，
  但事件类型不同，不会误判。
- `screenrecord` 在部分版本不存在或被策略禁用，自动降级为截图帧。
- 首帧/末帧可能包含 PC 终端的倒计时提示，切片时已各留 0.35s。
- 录屏会出现真实笔记内容，发布前自行检查隐私。
- 换设备/换分辨率后 GIF 尺寸会变，属正常。
