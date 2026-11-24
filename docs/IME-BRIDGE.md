# Issue #2：手写输入法文字重复堆叠——桥面定谳与适配层缓解

> 根因在 electron-ohos 移植层的输入法桥面（`libadapter.so`），不在渲染层也不在 Obsidian 内核。
> 本轮（2.2.0）在 ArkTS 适配层补候选段记账：**缓解，不是定谳修复**，需真机回归确认。

## 1. 根因

1. `libadapter.so` 与 IMF 相关的导出只有 12 个符号，全库无 `preview`/`composition` 符号、
   无 `selection` 字符串；`IMFAdapterTextConfig` 只有 `inputPattern`/`enterKeyType`/`cursorInfo`/`windowId`。
2. 平台层不缺能力：OpenHarmony ArkWeb 的 NWeb 适配层有完整组字链路
   （`SetPreviewText`/`FinishTextPreview`，Attach 时声明 `isTextPreviewSupported = true`）。
3. 渲染层是就绪的：出货 app.js 的 CodeMirror 6 composition 处理器完整（`isComposing` 90 处，
   1.15.1 原版 88 处）——"零 composition 事件"只能来自引擎不发货。
4. 手写"逐笔重识别、替换当前组字区间"在无组字通道、无选区回读的桥面上只能退化为
   `deleteBackward(n)+insertText(候选)`，n 由输入法自记；n 偏小（实测 0 或 1，正确值应为
   上一候选长度）时，每轮修订留下上一段，逐笔累积成 `AB → AAAB`。

升内核或升 app 都不解决：内核 1.15.1 渲染层组字面完整存活，桥面不发货则事件依旧不来。

## 2. 本轮改动（`web_engine/src/main/ets/adapter/IMFAdapter.ets`）

不改桥面 ABI，只处理已经到达的事件：

- 记录上一次插入的候选文本；
- `deleteLeft(n)` 照原样下发（零延迟），40 ms 窗口内累加删除量（一次修订可能拆成多块）；
- `insertText(新候选)` 到达时，若 40 ms 内且与上一次插入**同前缀**，判为一次候选修订：
  先补 `上一候选长度 − 已删长度` 个 `DeleteBackCallback`（只补欠删），再插入；
- 前删 / 回车 / 移动光标 / detach / attach 一律清空记账；单次补删 ≤12 字符，候选段 ≤16 字符；
- 命中写日志 `IME candidate revision: removed N leftover char(s) of "…"`，作为真机判定依据。

**边界与风险**：只纠正欠删（过删无法安全恢复，不猜）；若某输入法在退格后 40 ms 内提交一个
以上一候选为前缀的新词，会被误判为修订而多删一次（上限 12 字符，可撤销）。

## 3. 未做

- 未补组字通道（需要 `libadapter.so` 新增 preview 符号 + `libelectron.so` 接 `ImeSetComposition`，
  属引擎层工作）；
- 未采用渲染层 `ime-fix.js`（2.5 s 时间窗 + 文本相似度，两向误判，且挂在 `index.html`、不在补丁
  管线内，repatch / 升内核即静默丢失）；
- 未改 `changeSelection`（历史上用假光标计数反而污染候选高亮）。

## 4. 真机回归清单

1. 手写逐笔写一个词（≥4 笔、候选多次变化）：不堆叠、不吞字；
2. 手写连写两个词：第一个词不被第二个词的修订吃掉；
3. 拼音/英文键盘正常输入、退格后快速输入：不多删字；
4. 手写后立刻退格再输入不相关文字：只删 1 个字符；
5. 移动光标后输入、多窗口切焦点后输入：无跨位置删除；
6. 日志切全量后，若出现多删应能看到 §2 的命中日志（判定是否误判的直接证据）。

## 5. 回滚

`IMFAdapter.ets` 顶部把 `IME_SEGMENT_CORRECTION_ENABLED` 改为 `false` 即整体关闭，重新构建 HAP 生效。

## 6. 引擎侧长期修法

请移植层补：`RegisterPreviewTextCallback`/`RegisterFinishPreviewCallback`（或按 ArkWeb 在 Attach 的
TextConfig 里带 selection range 与 `isTextPreviewSupported`）；`libelectron.so` 把 preview 事件映射到
Blink 的 `ImeSetComposition`/`ImeFinishComposingText`；并补 `GetLeftTextOfCursor`/selection 回读。
完成后 §2 的记账即可删除。

## 7. 相关

[CHANGELOG](CHANGELOG.md) 2.2.0 段 · [RELEASE](RELEASE.md) 清单 · [PLATFORM-ADAPTATION](PLATFORM-ADAPTATION.md) §7
