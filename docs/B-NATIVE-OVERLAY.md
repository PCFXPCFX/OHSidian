# B：内联原生视频覆盖层（第八修订：静默 HEVC 失败 + 文字边界 + 触控/抽屉修复）

> W（WebCodecs）已被 AVC 对照证伪：AVC/HEVC 都 0 帧，`isConfigSupported` 不是解码证据。W 代码与 asar 注入已回退。B 的目标不是新开窗口，而是把系统 `AVPlayer` 的 surface 按 `<video>` 的矩形叠回阅读页。

## 目标

在 Obsidian 阅读视图里，用 ArkTS `AVPlayer` + `XComponent` **叠在 `<video>` 的矩形位置**，由系统硬解 HEVC；阅读连续性优先，不切换全屏播放页。B′（独立全屏播放页）仍不作为产品形态；本切片的“全屏”只是同一 surface 的布局扩展。

## 本切片范围

### 入口与预览

- HEVC/H.265 的 `<video>` 报错或 8s 无帧时，**不再弹“编码不受支持/建议转码”的 Notice**；只要常驻入口创建成功，就直接静默失败。音频、以及无法解析本地路径的视频仍保留 Notice/系统打开兜底。
- 8s 无帧只判断**确实尝试播放过**的媒体（`play` 事件 / 非 paused / `currentTime>0`）。暂停的本地音频只有 metadata 时不会误报；本地视频在 `loadedmetadata` 就预挂常驻入口，避免“不误报”变成“没有入口”。
- 同时给该 `<video>` 挂一个**常驻入口**“▶ 内置播放器”。Notice 消失、原生播放器关闭、视频播完后入口都还在。
- 入口由 **document 捕获阶段事件委托**处理，不再依赖按钮自身的 click listener；Obsidian 重渲染替换按钮后仍能响应。`MutationObserver` 在视频节点被重新插入时补回入口。
- 预览：渲染层先发 `thumb`，`open` 请求再携带同一个 `thumbFile`，避免单请求文件被 `open/rect` 覆盖导致预览丢失；`Index.ets` 用 `AVImageGenerator` 在 1s 处取帧（失败回退 0s），缩放到 480×270，编码 JPEG 写入 `<userData>/ohsidian-thumb-*.jpg`。渲染层优先用 `Blob` URL，失败回退 data URL；图片透明底、`pointer-events:none`，入口按钮保持最高层级。
- 预览图仅作为点击后的占位，不替代原生 surface；生成失败不会阻塞入口和播放。

### IPC（优先）+ 文件（兜底）

- 每个 `Index` 在本窗口 ArkUI 身份 `xcomponentId` 下启动一个 **127.0.0.1 临时端口** TCP server（`port: 0`）。
- 端口发布到 `<userData>/ohsidian-native-port-<safe-xcomponentId>.json`：`{ "port": 12345, "xcomponentId": "Widget_...", "token": "<uuid>" }`，临时文件 + rename 原子写。
- 渲染层按 `xcomponentId` 读端口，建立一个 keep-alive socket；newline-delimited JSON。连接成功先发 `{"hello":1,"token":"<uuid>"}`；Index 未收到匹配 token 前不消费任何请求、也不停文件轮询。
- `Index` 收到第一条 IPC 载荷后停止 200ms 文件轮询；socket 断开后恢复轮询。文件通道保留为 IPC 不可用时的兜底。
- `open` 不是“写出去就算成功”：`Index` 校验 `xcomponentId`/`windowId`/rect 并装上覆盖层后，写 `ohsidian-native-opened-<identity>.json` 并发 `{"event":"opened","seq":...}`；renderer 收到匹配 ack 才暂停/隐藏 HTML。1.2s 无 ack 会 close 未确认的 native 请求并保留 HTML，避免身份不匹配时黑屏。空 identity 的请求直接被拒绝。
- 为消除“socket 先连上、文件里的 `open` 还没读”竞态，`Index` 在第一条 IPC 载荷前先主动 `pollNativeRequest()` 一次。
- 文件兜底轮询从 40ms 降到 **200ms**，避免空闲时 25Hz 唤醒；IPC 下 `rect` 每个 rAF 帧发送，跟随 60fps 滚动。
- tracker 只在矩形/区域实际变化时发请求；文件兜底仍按 40ms 节流，IPC 可用时不再节流。

### 矩形跟随与遮蔽

- `open` 创建覆盖层；`rect` 平移并更新宽高；宽高变化不再关闭，`XComponent.onAreaChange` 防抖后原地重建 surface，保留 `currentTime`/播放态；`close` 立即释放。
- 渲染层每帧计算**完整视频矩形**和**安全内容区域**（顶部到文字实际裁剪边界、底部 toolbar/导航条），不再把视频高度 clamp 到 toolbar；`Index.ets` 把覆盖层放在区域盒子里并 `.clip(true)`，视频 surface 保持完整尺寸，只裁掉区域外的部分。
- **上边界以当前 leaf 的 `.view-content` 顶边为准**，不再全局取第一个 `.view-header`：先用 `el.closest(".view-content")` 取当前视频所在滚动容器，再优先 `el.closest(".workspace-leaf")` 内最近 header；全局 header 只在没有 content/leaf 时兜底。底部同理优先使用当前 `.view-content` 底边。这样覆盖层上沿与文字被裁掉的位置一致。
- **触摸**：区域盒子和覆盖层根节点 inline 模式 `Transparent`，`XComponent` 保持 `None`（纯绘制，不吞竖滑）；视频上方单独一层媒体手势区用 `Default` 命中，Pan 横滑 seek / 竖滑音量、Tap 短按/双击都在这一层处理。控制条和错误面板用 `Default`（自身和子节点可点，挡住底层兄弟），不用 `Block`——`Block` 会连子节点命中测试一起阻断，导致播放/暂停、Slider、重试按钮全部失灵。全屏根节点用 `Default`，阻断底层页面但保留子控件。
- 视频完全离开区域、键盘升起、模态/drawer 出现时 close；部分离开时继续跟随并由区域裁剪。
- 渲染层 rAF 跟踪滚动/resize/键盘/模态：
  - 视频矩形跟随滚动，IPC 下每帧发送；
  - 键盘升起（`--keyboard-height > 0`）时 close；
  - 可编辑元素 `focusin` 立即 close；
  - 模态/菜单/提示条：`.modal-container` / `.prompt` / `.menu` / `.suggestion-container` / `.modal` / `.modal-bg`；
  - **移动抽屉**：Obsidian 1.13.7 的实际 DOM 是 `.workspace-drawer`（展开 `show()`、收起 `hide()`，没有 `.workspace-drawer.is-active` / `.workspace-drawer-active`）；用 `getComputedStyle + getBoundingClientRect` 过滤，只有可见且非 `is-pinned` 的 `.workspace-drawer` 或可见 `.workspace-drawer-backdrop` 才算遮挡。裸查 `.workspace-drawer-backdrop` 在收起时元素仍存在，会恒真，不能再这么写。检测结果缓存 150ms，避免每帧 `querySelectorAll + getComputedStyle`；
  - 顶部安全区：当前 leaf 的 `.view-content` 顶边；无 content 时回退 leaf 内 `.view-header`/`.workspace-leaf-header`，再回退全局 header；
  - 底部安全区：当前 `.view-content` 底边、`--safe-area-inset-bottom` 以及 `.mobile-toolbar` / `.mobile-navbar` / `.status-bar` 的更靠上者；
  - 左右安全区取 `--safe-area-inset-left/right`，作为区域边界而不是 close 条件。

### 窗口身份

- 请求带 `windowId`（渲染层按 size/focus 解析的 OHOS 窗口 id）和 `xcomponentId`（该窗口 ArkUI 页身份）。
- `Index.ets` 优先用 `xcomponentId` 精确匹配；旧 mode entry 没有该字段时回退 `originWindowId` 对 OHOS id。
- 请求 identity 在 `open` 时冻结，后续 `rect` / `close` 复用；避免 `focusedWindow` 漂移把覆盖层“迁移”到别的窗口。

### 原生播放器

- `surfaceId` **只在 AVPlayer `initialized` 状态写入**；`fdSrc` 之后、`prepared/playing` 期间不再写。写入失败走 retry，避免 `Operate Not Permit: the attribute(SurfaceID) can only be set in the initialized state`。
- 初始化/prepare/play/AVPlayer error 自动重试 2 次，仍失败显示实际错误 + “重试”。
- `surfaceId` 变化（全屏/布局重建）时只在 `initialized` 重新绑定。
- 全屏：同一个 overlay/player 扩展到页面全尺寸；尺寸变化会触发一次 320ms 防抖后的 surface 重建，重建前保存 `currentTime`/播放态；返回键先退全屏。
- 静音：`AVPlayer.setVolume(0/1)`，图标切换；音量手势按 0–1 连续设置，静音时向上拖动自动解除静音。
- 拖动 seek：拖动时只更新预览，`SliderChangeMode.End/Click` 才真正 `seek`。
- 向后 seek：使用 `SEEK_CLOSEST`，并在 `seek` 后设置 guard；`timeUpdate` 在拖动或 guard 内不覆盖 slider，直到 `seekDone` 或 guard 到期。修复“向前可以、向后被 timeUpdate 拉回”的问题。
- 长按速度 chip：临时 `setSpeed(2.00)`，松手回 `1.00`。视频 surface 不再绑长按手势，避免抢占页面竖滑。
- **视频矩形内是媒体手势区**：单指横滑预览并 seek（横向位移映射到时长），单指竖滑调 AVPlayer 音量并显示顶部 HUD，双击左/右半区 −/+10s；单指短按延迟 240ms 判定，避免双击同时触发播放/暂停。手势层用 `Default` 命中，视频内的触摸不再同时传给 WebView。
- **首击时序**：touch-down 只负责“唤出控件”，不再等单击回调；Pan 的 `onActionStart` 只记录起点，不碰控件可见状态；单击回调带 450ms reveal grace，防止 touch 产生的 hover/起点把首击误判成播放/暂停。这是“点击视频却暂停/黑屏”的根因修复。
- **底栏可见性**：inline 视频可能被 content region 的底部裁掉；Index 把 `controlsBottomClip` 传给 overlay，底栏按可见区域上移，避免进度条被 toolbar/裁剪框吃掉。
- **视频矩形外仍是页面手势区**：覆盖层只存在于视频矩形内，视频外没有全局监听；页面滚动/选择由 WebView 自己处理。视频内竖滑现在是音量，不再承担页面滚动——这是“媒体区/页面区”分区的明确取舍。
- 控件默认不显示；单击/悬停显示，播放中 3 秒无操作自动隐去；暂停/错误/拖动进度时保持可见。
- 播完点 `↻`：`seek(0, SEEK_CLOSEST)` → `seekDone` → `play()`，带 300ms 兜底。

### 视觉：接入 Obsidian 语义令牌，而不是自定义品牌色

- renderer 从当前主题计算 `--background-secondary`、`--background-primary-alt`、`--interactive-normal`、`--interactive-accent`、`--text-normal`、`--text-muted`、`--text-faint`、`--background-modifier-border`、`--text-error`、`--text-on-accent` 以及 `--radius-s/m/l`，转成 ArkUI 可消费的 ARGB/数值后随 `open`/`rect` 的 `theme` 字段下发。
- `NativeVideoOverlay` 只消费 `NativeVideoTheme`：容器背景、底栏、进度轨道、已播放进度、按钮文字、时间码、错误面板、重试边框、2× chip、圆角全部来自令牌；源码中不再有播放器自定义深色/紫色硬编码（仅保留主题缺失时的兜底值）。
- 底栏用 `--background-secondary` 的 92% alpha，进度使用 `--interactive-accent`，轨道使用 `--interactive-normal`，时间码使用 `--text-muted`；主容器/底栏圆角取 `--radius-m`，错误面板取 `--radius-l`，小控件取 `--radius-s`。
- 控件默认隐藏，播放中 3 秒自动隐去；短按/悬停/拖动进度/暂停/错误时显示。错误面板居中，避免被 40vp 底栏盖住。

## 协议

文件兜底：`<userData>/ohsidian-native-video.json`；IPC：newline-delimited 同一 JSON。

```json
{
  "seq": 1760000000000,
  "ts": 1760000000000,
  "action": "open",
  "windowId": "520",
  "xcomponentId": "Widget_123",
  "path": "/storage/Users/currentUser/Documents/q/hevc_main10.mp4",
  "thumbFile": "",
  "title": "",
  "rect": { "left": 0, "top": 320, "width": 1280, "height": 720 },
  "region": { "left": 0, "top": 96, "width": 1280, "height": 1080 },
  "dpr": 2,
  "theme": {
    "bg": "#1e1e1e", "panel": "#252525", "bar": "#eb1e1e1e",
    "interactive": "#363636", "accent": "#8b7cf6", "onAccent": "#ffffff",
    "text": "#e8e8e8", "muted": "#b9b9b9", "faint": "#8a8a8a",
    "border": "#4a4168", "error": "#ff6b6b",
    "radiusS": 4, "radiusM": 8, "radiusL": 12
  }
}
```

- `action: "open"`：创建/切换覆盖层；`rect` 必须存在且宽高 > 0；`region` 缺省时退化为 `rect`。
- `action: "rect"`：平移视频矩形并更新区域；宽高变化不再关闭，覆盖层原地 resize，保留当前播放位置。
- `action: "close"`：释放覆盖层；`rect` 为 `null`。
- `action: "thumb"`：请求生成预览；`path` 为源视频，`thumbFile` 为目标 JPEG 绝对路径（必须位于应用 `filesDir` 下）。`Index` 不会因此打开覆盖层。
- `hello`：渲染层连接后的空载荷，用于让 `Index` 停止文件轮询；没有 `seq` 时被忽略。
- `windowId`：当前 renderer 解析出的 OHOS 窗口 id；`xcomponentId`：该窗口 ArkUI 页的 `xcomponentId`。
- `rect` 是 CSS px、视口坐标；本引擎里 1 CSS px 恒等于 1 vp，ArkTS 直接按 vp 使用，不再乘 `dpr` 再 `px2vp`（模式切换时两侧 dpr/密度更新有先后，往返换算会把矩形缩小 15%+）。
- `region` 是可视内容安全区域（CSS px，同样按 vp 使用）。裁剪盒尺寸为 **`rect ∩ region`**（`nativeClipX/Y/W/H`），播放器仍按完整 `rect` 布局、由裁剪盒裁切；`rect - clip` 是视频在盒子内的偏移。命中模式 `Default`：视频矩形内由播放器独占，矩形外仍是页面滚动区。
- `theme` 是 Obsidian 语义令牌快照（renderer 最多每 900ms 重算一次；`open` 必带，几何静止时每 1.2s 用 rect 心跳携带）；`close` 时为 `null`。ArkTS 端 `NativeVideoTheme` 只读消费，不自己发明颜色/圆角。
- `rect` 保持 `<video>` 的完整尺寸，不再被底部 toolbar clamp；区域外的部分由 `region` 裁掉。
- **窗口 resize**：`rect` 的宽高直接更新 ArkUI 组件，不再关闭覆盖层；`XComponent.onAreaChange` 在拖动结束后 320ms 触发一次 surface 重建，重建前捕获 `currentTime`/播放态，`prepared` 后 seek 回原位置再继续播。surface id 变化时同样走这条保位重建路径。
- **播放时隐藏 HTML**：打开原生覆盖层后，renderer 把 `<video>` 设为 `visibility:hidden`、`controls=false`、暂停并静音，同时隐藏预览图和入口按钮；关闭时按保存的原值恢复。原生关闭通过 IPC `{"event":"close"}` 通知，IPC 不可用时用 `ohsidian-native-closed.json` 文件标记兜底。
- **预览缩略图**：`AVImageGenerator` 先取 1s 关键帧、失败回退 0s；JPEG 打包失败回退 PNG；写入 `*.tmp` 后 rename，renderer 不会读到半张图。预览 `<img>` 用 `!important` 固定 `inset/宽高/object-fit/z-index`，避免 Obsidian 图片样式覆盖；按文件头识别 JPEG/PNG，避免 PNG 回退被错误 MIME 拒收。
- **IPC 回包**：renderer 按行缓冲 `{"event":"close"}`，不假设一次 `data` 就是完整 JSON；socket 断线时仍由 400ms 文件标记兜底。
- 写入：`scripts/update-obsidian.mjs` 的 `ohsidianWriteNativeRequest()`，唯一临时文件 + rename 原子写；rename 失败会 unlink 目标再重试，tracker 连续写失败会 close 并恢复 HTML。目标仍是共享请求文件，多窗口采用“最后写者赢 + 身份过滤”；IPC 正常时不走这条共享通道。
- 读取：`electron/src/main/ets/pages/Index.ets`；`seq` 严格递增，15s 之前的旧请求不恢复。

## 文件

| 文件 | 作用 |
| --- | --- |
| [`web_engine/.../components/NativeVideoOverlay.ets`](../web_engine/src/main/ets/components/NativeVideoOverlay.ets) | AVPlayer + XComponent + surface 状态机 + 重试 + 全屏/静音/seek/长按 2× |
| [`web_engine/index.ets`](../web_engine/index.ets) | 导出组件 |
| [`electron/.../pages/Index.ets`](../electron/src/main/ets/pages/Index.ets) | Stack 区域裁剪、IPC server、200ms 文件兜底、rect/region 平移、thumb 生成、window 过滤、返回键 |
| [`scripts/update-obsidian.mjs`](../scripts/update-obsidian.mjs) | Notice + 常驻按钮 + 事件委托 + MutationObserver + 预览 + IPC 客户端 + 每帧 rect/region + 区域遮蔽 |
| [`scripts/repack-b-native-asar.mjs`](../scripts/repack-b-native-asar.mjs) | 在已注入的当前 asar 中替换 B renderer 块（含 `ohsidianOfferSystemPlayer`，避免旧 Notice 覆盖新 guard）；幂等 |
| [`docs/HEVC-HARDWARE-DECODE-ANALYSIS.md`](HEVC-HARDWARE-DECODE-ANALYSIS.md) | W no-go 证据与路径评估 |

## 验收（真机）

1. 打开含 HEVC 内嵌视频的笔记，触发错误/8s 无帧时**不出现“编码不受支持/建议转码”弹窗**；视频上应出现预览图和“▶ 内置播放器”入口。
2. 点入口，覆盖层出现在视频原位置，AVPlayer 起播；失败应自动重试，最终显示错误和“重试”。
3. **滚动笔记**：覆盖层跟着视频矩形平移，IPC 下应接近 60fps；顶部滚到文字实际消失线、底部滚到 toolbar 下时，surface 只被区域边界裁掉，不得覆盖/露出原视频条；左右安全区同理。
4. **分区手势**：视频矩形内短按切换播放/暂停，单指横滑 seek，单指竖滑调音量，双击左/右半区 −/+10s；视频矩形外竖滑页面正常滚动。控制条/错误面板的播放、Slider、静音、全屏、关闭、重试都必须可点；拖进度条不应带动页面。视频内竖滑不再滚页，这是媒体区与页面区的明确边界。
5. 打开左侧/右侧抽屉、命令面板、设置、菜单、模态：覆盖层关闭；抽屉收起后不误判为遮挡。
6. 点编辑器/输入框，键盘和 Obsidian 格式栏升起：覆盖层立即关闭。
7. 全屏按钮：同一播放器铺满页面；返回键先退全屏，再返回关闭。
8. 静音：声音消失/恢复，图标同步。
9. 拖动进度条：拖动只预览，松手才 seek；**向后拖动**必须落到目标位置，不被 `timeUpdate` 拉回。
10. 长按速度 chip：临时 2×，松手 1×；播完点 `↻` 从头重播。
11. 关闭后 HTML `<video>` 恢复可交互；入口还在；H.264 走 `<video>` 路径不受影响。
12. 在另一个 Obsidian 窗口打开视频，覆盖层不得出现在当前窗口。
13. 连续快速点入口/重开：按钮不能“时灵时不灵”；重渲染后入口仍在。
14. **窗口大小变化/旋转**：播放不关闭，覆盖层跟随新矩形缩放；允许一次短暂重建，但必须从原 `currentTime` 继续，不能回到 0:00，也不能退回 HTML。
15. **播放期间隐藏**：原生起播后预览图和原 `<video>` 控件不可见；关闭/返回后预览图、入口和 HTML 控件恢复；不会出现“预览图压在原生画面上”。
16. **上边界一致**：让视频部分滚入顶部 header 下沿，覆盖层可见部分的上边应与文字被裁掉的位置重合，不是按全局第一个 header 算出的偏移。
17. **主题自适应**：切换浅色/深色/任意社区主题，播放器底栏、进度、按钮文字、时间码、错误面板和圆角应随 Obsidian 语义变量变化，不应残留固定紫色/深灰。
18. **控件克制**：播放中静置 3 秒底栏隐去；短按视频或悬停重新出现；暂停、错误、拖动进度时保持可见；错误面板的“重试”不被底栏遮挡。
19. **横滑 seek**：视频内单指横滑显示目标时间 HUD，松手后落到目标位置；向左/向右都生效，不被 `timeUpdate` 拉回。
20. **竖滑音量**：视频内单指上滑增大、下滑减小音量，HUD 显示百分比；静音状态下上滑自动解除静音；视频外竖滑仍是页面滚动。
21. **双击跳转**：左半区 −10s、右半区 +10s；双击不应额外触发一次播放/暂停。
22. **首击只唤出控件**：控件隐藏时第一次点击必须在 touch-down 立即显示进度条，不得同时暂停视频；第二次点击才播放/暂停。Pan 手势的 `onActionStart` 不得修改控件可见状态；单击判定带 450ms reveal grace。
23. **多窗口关闭隔离**：A 窗口关闭原生播放器时，B 窗口正在播放的覆盖层不得被 `ohsidian-native-closed.json` 连带停止；关闭标记必须带 `windowId`/`xcomponentId` 并匹配当前 tracker。
24. **静止切主题**：视频播放但不滚动时切换浅色/深色/社区主题，1.2s 内底栏、进度、文字和时间码应更新，不需要等视频移动。
25. **同页换视频**：原生覆盖层已打开时再点另一个视频入口，surface 必须重建为新文件并从头播放，不能继续旧视频；这是 `source` 变更监听覆盖的路径。
26. **视频不抢焦点**：点视频只出现控件，不出现软键盘；XComponent/手势层/根节点不得获得焦点，`--keyboard-height` 不得因此变为非 0，覆盖层不得因“键盘升起”被 tracker 关闭。

27. **点击不关闭/不弹键盘**：触摸端轻点视频只唤出控件，视频不关闭、不弹软键盘；日志不得出现 `close accepted`；长按与短按行为一致。
28. **模式切换（R161 改）**：触摸<->窗口模式切换时**直接关闭原生播放器**，由页面恢复自己的海报/入口，用户再点一次即以新模式的几何重新打开。理由：切换会同时改变窗口密度与 CSS 视口，保活 surface 会产生一整类竞态（隐藏/揭示时序、surface 重建、旧几何），关闭是确定性行为。日志 closed for mode switch (touch<->window)。

29. **AVC 零侵入**：H.264 内嵌视频不得出现 poster、入口按钮或编码提示；`ohsidianCodecOf` 必须把它判成 avc 并跳过 native 层。
30. **HEVC 入口无感**：HEVC 内嵌视频显示首帧 poster + 居中播放圆盘，轻点一次即播；控件图标为统一描边语汇（无 emoji/制表字符混排）。

31. **圆盘同轴**：poster 播放圆盘与原生暂停态圆盘在同一中心；进出播放器不得出现位置跳动。
32. **双密度与比例**（R129 改）：触摸端控件按**播放器宽度取比例**，并夹在硬上下限内——命中区 **≥48vp**（Material 下限，任何窄视频都不得低于此值，除非物理放不下，此时按 `(药丸内容宽 − 时间码 − 边距)/5` 让位，绝不溢出药丸）、条高 `0.094×W` 夹 [56,76]、图标 `0.046×W` 夹 [26,34]、圆盘 `0.0914×W` 夹 [56,72]（`0.0914 = 64/700`，即海报圆盘的比例，保证圆盘无跳变）。固定 vp 数值对 360vp 手机视频和 700vp 笔记视频不可能同时正确，旧条目隐含假设了手机宽度。
33. **竖向音量**：视频内竖滑按 `音量 xx%` 比例调整，首滑不得直接静音/拉满；横滑仍是 seek。

34. **圆盘居中**：暂停态播放圆盘位于画面正中心（不得贴底），与 poster 圆盘同点。
35. **控制条对中**：触摸端控制条为居中悬浮药丸（96% 宽），中心轴与圆盘一致；指针端可贴边。
36. **切换不闪旧帧**：同页切换视频时旧画面不得闪现，应先显示不透明"载入中…"再出新画面；音量 HUD 位于顶部，不被控制条遮挡。

## 本轮提交前审计修复（2026-10-19）

- **多窗口关闭串扰**：`ohsidian-native-closed.json` 是共享文件，旧判定只比较时间戳，A 窗口关闭会停掉 B 窗口。现在标记同时写 `windowId`/`xcomponentId`，tracker 只在身份匹配时接受；缺失字段保留旧标记兼容。
- **同页换视频不重建**：`NativeVideoOverlay.source` 改为 `@Prop @Watch`，源变化时 release 旧 AVPlayer、清空 resume、按新文件重新 init；不再依赖不会二次触发的 `XComponent.onLoad`。
- **静止主题不更新**：几何不变时每 1.2s 发一次 `rect` 心跳，主题令牌随心跳到达；只有 `open` 或超过 1s 才携带 theme，避免每帧重算。
- **主题颜色解析**：canvas 归一化出的 `#RRGGBBAA`/`#RGBA` 现在转换成 ArkUI `#AARRGGBB`；半透明背景算底栏时剥离源 alpha。
- **临时文件并发**：请求/关闭标记的 `.tmp` 改为唯一后缀，避免两个窗口 rename 互相覆盖。
- **缩略图磁盘泄漏**：预览 `onload` 后删除临时 JPEG/PNG；保留 Blob/data URL，不影响后续显示。
- **重试预算**：`playing` 不再无条件清零；只有距上次 retry >5s 才清零，防止“起播→立刻 error→重试”无限循环。用户 resize 单独给两次预算，不消耗解码错误预算。
- **快速重建 fd 泄漏**：`initPlayer` 在 token 失配且未被 release 接管时关闭本次打开的 fd。
- **暂停在 0:00 的 resize**：`resumeMs` 允许 0，重建后保持暂停而不是自动播放。
- **首击时序**（上一条交付已修）：touch-down 只唤出控件；Pan 起点不碰 UI；`userRevealedControls` + 450ms grace 保证首击不暂停。
- **open 回执**：Index 接受 `open` 后写 `ohsidian-native-opened-<identity>.json` 并发 IPC `{"event":"opened","seq":...}`；renderer 只有收到匹配 ack 才暂停/隐藏 HTML。1.2s 无 ack 则恢复 HTML 并 close 未确认的 native 请求，不再用“写出成功”冒充“ArkTS 已接受”。
- **视频不抢焦点/不弹 IME**：`XComponent`、媒体手势 `Column`、overlay 根 `Stack` 全部 `focusable(false)` + `focusOnTouch(false)`。实机日志证明点击视频会把焦点落到 `XComponent/secure_field` 并拉起 IME，renderer 随后因 `--keyboard-height>0` 主动 close，表现为“点一下视频就关”。
- **缩略图写入**：`fileIo.writeSync` 改为传 `ArrayBuffer`，修复 `13900020 Illegal write buffer`，预览图不再每次生成失败。
- **IPC 鉴权**：端口文件带 `util.generateRandomUUID()` token；renderer hello 携带 token，Index 未授权前不消费请求、不停止文件轮询；`seq` 限定 `0 < seq <= Date.now()+5s`，本机扫描端口无法用超大 seq 冻结 B 路由。空 identity 仍直接拒绝。
- **暂停媒体误报**：8s 无帧 watcher 只判断“确实尝试播放过”的媒体（`play` 事件/非暂停/currentTime>0），暂停的本地音频不再弹“编码不支持”；同时在 `loadedmetadata` 为本地视频预先挂常驻入口，避免修掉误报后入口也消失。
- **入口可见性**：Notice guard 从 `isConnected` 改为 `ohsidianNativeVisible(button)`；按钮存在但被 `display:none`/零尺寸包住时仍保留 Notice 兜底。Notice 配额在 `new Notice` 成功后才递增。
- **注入脚本退场**：删除会从旧 backup 覆盖当前 asar、并把 guard/8s watcher 打回旧版的 `inject-b-native-asar.mjs`；唯一更新路径是 `repack-b-native-asar.mjs`。
- **写入可靠性**：renderer 的 request/thumb 写入统一走 `ohsidianWriteJsonAtomic`（唯一 tmp、rename 失败 unlink+retry、失败清理），tracker 连续写失败 6 次会 close 并恢复 HTML；按钮恢复 `inline-flex`，不再丢原 display。

## 当前构建状态（2026-10-19 23:16，R134：全屏容器居中）

- HAP：**222,025,037 B**，SHA-256 `B2C6726F585EBF9043326C95514EE9E68F0A363F409CE62851C7431A9BD29D44`（**R134**：字形改为 `100%` 外层容器居中）。
- **两条路径并存**：`NativeVideoOverlay.ets` 顶部 `const SYSTEM_VIDEO = true` 走系统控制条；改成 `false` 即回到手写 AVPlayer + Shape/Path 控制条（代码完整保留的一行开关）。
- 内嵌 `obsidian.asar` 25,948,112 B `2AC4D18E…3ADC97` —— R126 起四轮完全一致，改动只在 ArkTS 层。
- **单位结论（真机实测，已推翻 R126）**：`k=1.000`、`measured == declared` ⇒ 本机 **1 CSS px = 1 vp**，覆盖层从未被缩小。R126 的 1.17 来自截图目测，作废。双保险链路保留，只对其他密度窗口生效。
- **R127 保留**：字形锚点数值化 `15/20`；play/pause/play-big 墨迹居中；`controlsBottomClip` 进入底部内缩。
- **R128 已撤回**：把条高改成 74 / 命中区 64，**越过了验收 #32 的 56/48**，用户判定"所有的都变大了，不对"。
- **R129（尺寸模型）**：尺寸改为按播放器宽度取比例并夹在上下限内（见验收 #32），锚点是海报圆盘的 `64/700 = 0.0914`。@700vp：条高 **65.8**、命中区 **56**、图标 **32.2**、圆盘 **64.0**（= 海报，零跳变）。同时修掉固定宽度导致**按钮溢出药丸被裁**的真 bug。
- **真机待验证**（长按时间码看读数）：
  1. `bar≈65.8 btn≈56 glyph≈32.2 disc≈64`，且 `measured` 与声明一致。
  2. `glyph%≈4.6` / `disc%≈9.1`。
  3. `center ov == disc`、`icon == bar`；右侧四个按钮**不得被药丸边缘裁掉**。
  4. **`crop=` / `shiftX=`（R130 新增）**：`crop=0 shiftX=0` ⇒ 视频盒完整可见，覆盖层没有为裁剪做位移，中线问题由数字关闭；`crop` 为负 ⇒ 内容区裁掉了视频、覆盖层左移了 `|crop|/2`，此时**画面会相对海报位移**，需要决定「画面跟页面走」还是「控件跟可见区走」。


## 已知风险

- **区域裁剪依赖 ArkUI surface 裁剪**：`Index.ets` 用 `.clip(true)` 裁 `XComponent` 子 surface；社区做法如此，但本机无法真机验证。若设备上 surface 不遵守父级裁剪，顶部/底部仍可能溢出，需要改用 surface 尺寸交集方案。裁剪盒现在是 `rect ∩ region`，命中也随之收敛到可见区域。
- **媒体区/页面区手势仲裁**：视频内透明层改为 `Default` 命中 + `GestureGroup(Exclusive)`（Pan + 双击 + 单击），媒体手势会赢得该矩形；视频外 WebView 不受影响。真机必须确认：横滑 seek、竖滑音量、双击 ±10s、单击 240ms 延迟、控制条子控件不被手势层的 Pan 抢走；若 Pan 在 12vp 前误判，调 `distance` 或把媒体层限制在视频可视面积内。
- **IPC 首次可用性**：端口文件发布、loopback 权限、socket 生命周期依赖真机；失败会退回 200ms 文件通道，功能不丢，但 rect 跟随会变慢。
- **rect 滞后**：IPC 下每个 rAF 帧发送，正常接近 60fps；若 socket 背压或渲染层掉帧仍可能轻微滞后。
- **resize 会短暂重建 surface**：拖动结束 320ms 后重建 AVPlayer，位置/播放态会恢复，但会有一小段黑屏/停顿；这是为了绕开部分设备 surface buffer 不随组件 resize 的兼容做法，不是关闭重开。
- **原生 surface z 序**：已用键盘/焦点/模态/drawer 主动 close + region 裁剪规避，但不排除第三方插件自定义浮层未被选择器覆盖。
- **抽屉遮挡判定**：1.13.7 的 `.workspace-drawer` 常驻、展开/收起走 inline `display`，无 `.is-active`；已改为 computed style + rect 可见性并跳过 `.is-pinned`，每 150ms 缓存一次。静态代码证据充分，但手机布局根节点未做真机 DOM dump。
- **窗口 id 解析**：依赖 mode 文件 size/focus 匹配；某窗口读不到几何时 `windowId` 为空仍会接受，需要真机日志再收紧。
- **预览生成失败**：`AVImageGenerator` 对个别 HEVC profile 可能取帧失败；已做 1s→0s 回退、JPEG→PNG 回退、临时文件 rename 和 open 后 600ms 重试。失败时只是没有预览图，入口和播放不受影响。
- **主题令牌桥接**：CSS 变量经 canvas 解析为 ARGB；若主题使用 `color-mix()`/自定义函数且 canvas 无法解析，会退回默认值。ArkTS 端圆角按 CSS px ≈ vp 消费，若设备缩放/主题用 rem 可能有 1–2vp 偏差，需要真机目测。
- **浮层遮罩线**：手机 `.is-phone.is-floating-nav` / `.auto-full-screen` 的 markdown 顶部渐隐终点是 `safe-top + --view-header-height + 12px`，已按 Obsidian CSS 对齐；若主题/插件改写 `--view-top-fade-mask`，需要再按实际 mask 调整。
- **坐标换算**：本机真机实测 **1 CSS px = 1 vp**（`k=1.000`，R128 读数），但不是所有窗口都必然如此——桌面窗口 / 不同密度屏可能不等。故沿用双保险：`rect`/`region` 进 Index 乘 `k = dpr * px2vp(1)`，Overlay 内再用 `u = 实测盒宽 / rect CSS 宽` 复核；`k=1` 时二者都是恒等变换，只有真的不等时才起作用。**不要再用截图目测标尺反推换算比**（R126 就是这么错的）。
- **单覆盖层**：只支持一个视频；多视频后续排队/替换。

---

## 实现摘要（R108–R149 合并）

> 40 轮迭代后的一页纸。上面各章是最初设计；本节是**最终落地形态**，冲突时以本节为准。

### 一、谁负责什么

| 层 | 文件 | 职责 |
|---|---|---|
| 渲染层 | `scripts/patches/touch-mode.js` | 海报、入口按钮、`rect/region` 心跳、主题令牌、遮挡/键盘/滚动判定、`opened` ack |
| 页面层 | `electron/src/main/ets/pages/Index.ets` | 裁剪帧、覆盖层定位、IPC 服务、模式切换隐藏/揭示、系统栏 |
| 覆盖层 | `web_engine/src/main/ets/components/NativeVideoOverlay.ets` | AVPlayer、SURFACE、控制条、手势、彩蛋、媒体信息解析 |

### 二、三条硬约束（违反就会出"玄学"）

1. **`Path.commands` 的坐标单位是 px，不是 vp。** 2× 屏上 30 单位只画 15vp。所有字形走 `scalePath(cmds, vp2px(1) × size/grid)` 数值缩放，描边用**同一个系数**。
2. **居中只能用"撑满容器的 `Column` + `justifyContent/alignItems`"。** `Stack.alignContent`（构造与属性两种写法）在放置子组件时不生效；固定尺寸容器的对齐同样不可靠。
3. **系统 `Video` 组件读不到仓库路径。** 它的 `src` 只接受沙箱 `file://<bundle>/<path>` 与网络 URL；`fileUri.getUriFromPath()` 会被当成沙箱相对路径而报 `Cannot find base path`。解码只能走 `fileIo` fd + `AVPlayer.fdSrc`。

### 三、尺寸模型（按播放器宽度取比例，夹在硬上下限内）

| 元素 | 规则 | @700vp |
|---|---|---|
| 药丸高 | `0.066W` 夹 [42,56] | 46.2 |
| 播放键格 | `0.063W` 夹 [38,52] | 44.1 |
| 右侧格 | `0.0515W` 夹 [30,44] | 36.1 |
| 播放/暂停图标 | `0.027W` 夹 [16,24] | 18.9 |
| 右侧图标 | `0.020W` 夹 [12,18] | 14.0 |
| 图标描边 | 1 网格单位 × `pathScaleFor` | 1.26px |
| 圆盘 | `0.0914W` 夹 [56,72] | **64**（= 海报圆盘，零跳变） |
| 时间码 | `0.014W` / `0.098W` | 9.8 / 68.6 |

命中区受"药丸内容宽 − 时间码 − 边距"约束，任何宽度都不会溢出。

### 四、手势（`GestureGroup(Exclusive)`，互斥不抢）

| 手势 | 行为 |
|---|---|
| 单击 | 唤出/隐藏控制条（touch-down 即显示，450ms grace 防误暂停） |
| 双击左半 / 右半 | −10s / +10s（**只有这一个语义**） |
| 横滑 | seek，HUD 显示目标时间 |
| 竖滑 | 音量，HUD 显示百分比 |
| 长按画面 450ms | 临时 2×，松手回到**全局倍速** |
| 点倍速格 | `1× / 1.5× / 2× / 3×` 菜单 |

### 五、全局设置

倍速写入 `filesDir/ohsidian-native-speed.json`，`prepared` 时重新应用（含 resize 重建 surface 后）。长按加速不写盘。

### 六、主题

全部颜色/圆角来自渲染层转发的 Obsidian 语义令牌（`--background-secondary`、`--interactive-accent`、`--text-normal/muted/faint`、`--background-modifier-border`、`--radius-s/m/l`）。ArkTS 侧只剩 `DEFAULT_NATIVE_VIDEO_THEME` 兜底值与 `'#00000000'`。

### 七、彩蛋（长按时间码）

内容自适应卡片（非横条），字段全部**真解析 MP4**：编码/Profile、分辨率、位深与色度（`hvcC`）、HDR 色彩空间（`colr`，存在才显示）、帧率与 VFR（`mdhd`+`stts`）、音轨（`mp4a` 声道/采样率）、时长、文件大小、视频码率（`btrt`，avg 为 0 时降级为"峰值"）。

### 八、验收状态

已真机验证：HEVC 起播、圆盘居中、图标居中、玻璃/圆角外观、双击 seek、横滑 seek。  
未验证：HDR 标签（本地无带 `colr` 的样片）、音轨标签（无带音轨样片）、系统快捷键、时间戳链接。
### 九、状态机（R160–R167 收敛后的最终形态）

| 事件 | 行为 | 为什么 |
|---|---|---|
| 触摸 ↔ 窗口模式切换 | **直接关闭播放器**（\`closeForModeSwitch\`），页面恢复海报，再点重开 | 切换同时改变窗口密度与 CSS 视口，保活 surface 必然产生隐藏/揭示、重建、旧几何三类竞态 |
| 窗口拖动 / 缩放 | **不隐藏、不重建**，rect 心跳更新几何，覆盖层跟着走 | 曾经每次 \`windowSizeChange\` 都 \`.visibility(Hidden)\`，导致"视频消失—回来"和"黑→白→黑" |
| 视频全屏 ↔ 内联 | **只在宽高比变化时重建**；面积变化交给 ArkUI 原地缩放 surface | surface 本身按视频比例 contain，往返只是等比缩放 |
| resize 重建期间 | **不显示任何遮罩**（R164 删除） | 遮罩的出现本身比那 200–500ms 的画面跳变更伤观感 |
| 同页换视频 | 显示 \`载入中…\` 遮罩 | surface 仍持有上一段最后一帧，不盖会"闪旧片" |
| 画面底色 / letterbox | 纯黑 \`MEDIA_VOID\`，与主题无关 | 浅色主题下曾把留白刷成白色，留白变成画面里最显眼的东西 |
| 彩蛋面板 | 磨砂半透明（\`#59000000\` + \`BlurStyle.Thick\`）+ 白系文字 | 不透明面板压在画面上像一块板砖；半透明深底必须配白字 |