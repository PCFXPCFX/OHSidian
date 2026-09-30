# 外部内容拖入 / 注入管线（DRAG-DROP-INBOUND）

本文描述"外部内容进入 Obsidian 编辑器"的完整链路：系统拖拽（中转站、文件管理器、
截图悬浮窗、跨设备拖拽）以及未来的碰一碰 / 分享目标注入。修复记录见
`docs/CHANGES-2026-09.md` 与 `docs/AUDIT-FIXES-2026-09-29.md`（F16/F17）。

## 链路总览（入站）

```
系统拖拽 → XComponent onDragEnter/onDragMove/onDrop（WebWindow 等 4 个组件）
  → DragDropAdapter.dragEnterData / dropData
    → DragParamManager.handleDropDataForEnter（拖入占位）
    → DragParamManager.handleDropDataForDrop(dragData, isLocalDrag)（落点解析）
    → [仅外部拖拽] DragParamManager.sanitizeExternalDropData（可读性修复 + 数据清洗）
      → nativeContext.OnDropCB(id, dropData, fileUris)
        → libelectron.so（闭源）把 OhosDropData 拼成 renderer 的 DataTransfer
```

关键事实：**引擎从 `OhosDropData.fileUris` 构建 `DataTransfer.files`（File 对象），
从 `text`/`url` 构建 `text/plain` / `text/uri-list`（链接）**。Obsidian 对 File
走"复制为附件并插入"；对 uri-list 走"打开链接"——`file://` 链接触发
"Open external link?" 弹窗，无论确认与否都不会插入内容。

## 单张图拖入失败的根因（已修复）

中转站/hiwrite 单张截图的 UDMF 形态与多张不同，两个缺陷叠加：

1. **`general.file-uri` 记录被短路吞掉**（`DragParamManager.handleDropDataFromRecordsForEntries`）：
   旧代码在 `case UTD_FILE_URI` 里先用 `getRecordForEntries(UTD_FILE_URI)`（读
   `records[0]` 的 entry）判断"是否是网页图片拖拽"，单条 file-uri 记录自己匹配自己，
   恒为真 → URI 永远不进 `fileUris`。多张图走的是 `general.image`/`general.file`
   类型记录（FILE 分支 + F17 的 `entryMap[UTD_FILE_URI]` 兜底），所以能成功。
   现在该短路只在**本地拖拽**（`isLocalDrag=true`，即 Obsidian 自己发起、引擎已有
   该文件的场景）生效；外部拖拽一律提取 URI，并增加 record 级兜底
   （`File.uri` / `Image.imageUri`）。

2. **文件路径以 PlainText 漏给引擎**：hiwrite 单张拖拽常把文件路径放在
   PlainText 记录里。`fileUris` 为空时引擎把它降级成 uri-list 链接 → 弹窗。
   现在 `sanitizeExternalDropData` 会：
   - 把 path-like 的 `text`/`url`（`file://`、`/storage/`、`/data/` 开头）**清空**，
     避免引擎拼出链接；纯文本不受影响；
   - 若清洗后 `fileUris` 仍为空而 text/url 是路径 → **提升**为 fileUris；
   - 对每条 URI 做**可读性检查**：本进程按路径可读（共享存储、自身沙箱、引擎
     临时文件）→ 原样透传（文件管理器拖拽的现状路径，不动）；不可读（跨应用
     沙箱，如 `.../appdata/el2/base/com.huawei.hmos.hiwrite/...`）→ 利用落点
     授予的临时 URI 权限 `fs.openSync(uri, READ_ONLY)` 读出并**复制到
     `<cacheDir>/drag-in/`**（按 appdata→`file://<bundle>/data/storage/...`
     的映射做第二次尝试），把 fileUris 替换为缓存副本。引擎随后像读本地文件
     一样读副本，Obsidian 得到真正的 File → 走附件插入。

副本目录 `drag-in/` 每次落点前清理 24h 以上的旧文件（`purgeStaleDragInCopies`）。

## 本地拖拽不受影响

`DragDropAdapter.dragSourceWindowId` 只在 Obsidian 自己发起拖拽
（`startDrag`）期间非空。`dropData` 据此判定 `isLocalDrag`：
- 本地（编辑器内移动图片/文本）：与旧逻辑完全一致，不做复制与清洗；
- 外部：走上述解析修复 + 清洗管线。

## 统一注入入口（碰一碰 / 分享目标 / 未来的跨设备传输）

```
DragDropAdapter.ingestExternalContent(xComponentId?, fileUris, text, html)
```

- `xComponentId` 为空时自动落到**当前聚焦窗口**（引擎通过
  `ContextAdapter.SetActiveWindow` 上报焦点，`ContextAdapter.getActiveWindow()`）；
- 内部与外部拖拽共用 `sanitizeExternalDropData`（复制/清洗/提升）；
- **派发时重放完整拖拽时序**：`OnDragEnterCB → OnDragMoveCB(编辑器中央) →
  （延时 ~120ms）→ OnDropCB`。引擎只为"已有活跃拖拽会话"的窗口合成
  renderer 落点——只发孤立 `OnDropCB` 会被静默忽略（2026-10-01 真机实测：
  分享注入时文件已复制、落点已派发，但编辑器无任何反应；补上 enter/move
  会话后修复）。坐标为 XComponent 表面像素（与真实拖拽路径
  `vp2px(windowX) - drawableRect.left` 同一坐标系），取可绘制区中心。
- 已有两条触发通路：
  1. **ArkTS 侧**：任何 Ability/Service 回调直接调用（WebAbility 已接入，见下）；
  2. **引擎 JS 侧**：`DragDropAdapter.IngestExternalContent(id, uris, text, html)`
     （`DragDropAdapterBind` 绑定），供 asar 补丁或引擎层未来接入。

`WebAbility` 已接入（`onNewWant` 热启动 / `onCreate`+延迟派发 冷启动）：
- 解析优先级：裸 `file://` want.uri → Share Kit 官方接收 API
  `systemShare.getSharedData(want)`（`@kit.ShareKit`，逐条读
  `SharedRecord.uri`/`SharedRecord.content`，**不依赖任何发送方私有键名**）
  → 参数启发式兜底（已知键 `uris` / `uriList` /
  `ability.want.params.uris` / `ability.want.params.uriList` / `fileUris`、
  文本键 `text` / `content` / `ability.want.params.text`，最后扫描全部
  parameters 里 path-like 的值，未知发送方也能接）；
- 冷启动（应用未运行时分享）：`onCreate` 暂存 want，`onWindowStageCreate`
  之后延迟 15 秒一次性派发（引擎与编辑器需要启动时间；尽力而为，若届时
  编辑器仍未挂载内容会丢失并留日志）。热启动分享即时插入，无此窗口。

## share-target 注册（已完成）

`electron/src/main/module.json5` 的 `EntryAbility` 已增加 share-target
`skills`：action `ohos.want.action.sendData`（含旧版
`sendMultipleData`），`uris` 按 UTD 穷举可接收类型并声明 `maxFileSupported`
（不声明默认 0，分享面板不会列出应用）：

- `general.image` / `general.video` / `general.audio` / `general.file`，
  `maxFileSupported: 9`；
- `general.plain-text` / `general.hyperlink` / `general.html`，
  `maxFileSupported: 1`。

`ohos.want.action.sendData` / `sendMultipleData` 常量定义在旧版
`@ohos.ability.wantConstant`（`@kit.AbilityKit` 重导出的
`@ohos.app.ability.wantConstant` 只有 `ACTION_SEND_TO_DATA`），导入时注意。

## 剩余验证项（真机）

1. 分享面板：图库/文件管理器分享时 Obsidian 出现在候选里，选中后内容
   插入当前聚焦笔记（单设备即可验证）；
2. 碰一碰（需双设备）：PC → 平板的投递形态决定走哪条通路——UDMF 跨设备
   拖拽复用拖拽链路（已覆盖）；Want 形式走分享目标路径（`onNewWant begin`
   日志会打出完整 want，如键名与启发式均未命中再补）；
3. 冷启动分享：应用未运行时分享 → 启动后 ~15 秒内容自动插入；
4. 观测点：hilog 过滤 `OhosDrag` 与 `WebAbility`（`getSharedData parsed` /
   `sanitizeExternalDropData` / `ingestExternalContent`）。

## 已知边界

- 跨应用源若连临时 URI 权限都没拿到（个别系统版本对 raw-path 形态
  `file:///storage/...` 不授权限），复制会失败并保留原 URI——行为退回修复前
  （弹窗），hilog 会打出具体错误码，便于针对性再适配；
- `html` 字段不做改写：多张图当前可插入的通路可能依赖它，保持不动以避免回归；
- `drag-in/` 副本在 cache 目录下，系统可随时回收，不占用用户空间预算。
