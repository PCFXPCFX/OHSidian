# OHsidian HEVC / H.265 硬解可行性评估

> 评估对象：本仓库当前分发的 Electron 兼容层（`libelectron.so`，Chromium 132.0.6834.161 的 OpenHarmony 移植版）在 Obsidian 内嵌 `<video>` 中播放本地 HEVC/H.265 文件，并走硬件解码的可行性。
> 评估日期：2026-10-18。依据：本仓库第 95–98 轮真机日志与源码、OpenHarmony/Chromium 公开源码、HarmonyOS 官方媒体文档。**本文没有新增真机实验**；文中"设备实测"均引自仓库既有记录。
>
> **2026-10-19 决策更新**：W（WebCodecs + Canvas）已因 AVC 对照同样 0 帧被判 No-Go；最终采用 **B：内联原生覆盖层**（`AVPlayer` + `XComponent` 叠回 `<video>` 矩形），实现与验收见 [`B-NATIVE-OVERLAY.md`](B-NATIVE-OVERLAY.md)。本文 §4.W/§5 的 W 排期保留为历史评估，不再作为当前路线。

---

## 0. 结论先行

| 问题 | 结论 | 关键证据 |
| --- | --- | --- |
| 设备支持 HEVC 硬解吗？ | **支持**。`CreateByMime(video/hevc)` 成功，1080p 8-bit/10-bit 均能解出帧 | 第 96f/98e 轮 hilog |
| 引擎里有 HEVC 解码路径吗？ | **有**。OHOS 构建默认 `enable_platform_hevc=true`，桥接层显式支持 `video/hevc`，能力探测覆盖 Main/Main10 | `media_options.gni`、`ohos_media_decoder_bridge_impl.cc` |
| 有"打开硬解"的开关吗？ | **没有**。`PlatformVideoDecoder` 旗标与路由无关；`enable_platform_hevc` 是 GN 构建参数且已为真 | 第 95c/96d 轮对照实验 |
| 当前 HEVC 为什么播不了？ | **不是缺解码器，是解码后的呈现环在首帧后断裂**。该缺陷对 H.264 硬解同样成立 | 第 98r 轮 `norelay` 直连实测 |
| 应用层能修吗？ | **不能直接修引擎内部**；但可以绕开（转码 / 原生播放器）或自编译引擎修 | 第 96–98 轮共 18 轮边界探测 |
| 当前采用路线（2026-10-19） | **B（内联原生覆盖层）**：AVPlayer + XComponent 按 `<video>` 矩形叠回阅读页；W 已 No-Go | [`B-NATIVE-OVERLAY.md`](B-NATIVE-OVERLAY.md) |
| 有没有更快的折中？ | **P（画中画卡片）**：原生硬解，笔记保持可读，不做 rect 跟随；3–5 天；但不是内联 | §4.P |
| B′（全屏原生播放页）呢？ | **只作技术验证/harness，不作为产品形态**：它把笔记切换成播放页，违背"连贯、无异物感"；1–2 天可搭出来验证 AVPlayer/fd | §4.H |

**一句话**：HEVC 的"解码能力"已经存在，缺的是**把解出的帧稳定送到屏幕**这一段；这不是编码格式问题，也不是加一个 Chromium flag 能解决的问题。W 已因 AVC 对照 0 帧出局，当前走 **B（内联原生覆盖层）**；B′ 只用于验证播放器核心，不作为产品形态。

> 重要区分：**当前应用里连 H.264 都不是硬解**。平台硬解对 H.264 同样首帧后断，H.264 能播是因为 Chromium 回退到了 ffmpeg 软解。所以"开启硬解"的真实含义是"修复平台硬解的呈现环"，收益同时覆盖 AVC 与 HEVC。

---

## 1. 验收定义

本文把"支持 HEVC/H.265 硬解"定义为：

1. 本地 vault 中的 `.mp4/.mov/.mkv`（HEVC 8-bit Main 与 10-bit Main10）在 Obsidian 内嵌 `<video>` 中直接播放；
2. 起播 < 1s，连续播放 60s 无中断，seek / 暂停 / 恢复 / 音量 / 全屏可用；
3. 音画同步，CPU 占用显著低于软解（硬解的首要意义）；
4. 不劣化现有 H.264 / VP9 / AV1 播放；
5. 8K 不在本期范围（设备 HAL 对 8K HEVC 的 `Configure` 直接返回 `AV_ERR_INVALID_DATA`，第 96f/96i 轮已证）。

---

## 2. 证据链：从构建配置到设备日志

### 2.1 引擎身份与构建参数

- 引擎自报 Chromium **132.0.6834.161**、Electron `5.0.0-Release`（第 96b 轮二进制取证）。
- 上游源码公开：`openharmony-tpc/chromium_src` 分支 `pc_chromium_132`；Electron 覆盖层 `openharmony-sig/electron`（Gitee 已迁 GitCode/AtomGit）。
- 构建脚本 [`electron_build.sh`](https://raw.gitcode.com/openharmony-sig/electron/raw/master/electron_build.sh) 的关键参数：

  ```text
  target_os="ohos"
  use_musl=true
  ozone_platform="ohos"
  proprietary_codecs=true
  ffmpeg_branding="Chrome"
  is_component_ffmpeg=true
  ```

- [`media/media_options.gni`](https://raw.gitcode.com/openharmony-tpc/chromium_src/raw/pc_chromium_132/media/media_options.gni)：

  ```gn
  enable_hevc_parser_and_hw_decoder =
      proprietary_codecs &&
      (use_fuzzing_engine || is_win || is_apple || is_android || is_linux || is_ohos)
  enable_platform_hevc =
      proprietary_codecs && (enable_hevc_parser_and_hw_decoder ||
                             is_cast_media_device || is_chromeos_lacros || is_ohos)
  ```

  → OHOS 上 `enable_platform_hevc` 为真：HEVC 的 demux/parse、MIME 接受、MSE `isTypeSupported`、平台解码器注册全部打开。**不存在"再打开一次 HEVC"的构建开关。**

二进制侧证（`strings libelectron.so`）：

- 存在：`video/hevc`、`hevc main`、`hevc main 10`、`CreatePlatformVideoDecoder`、`kIsPlatformVideoDecoder`、`OH_MD_KEY_WIDTH`、`OH_MD_KEY_HEIGHT`、`OH_VideoDecoder_Configure`、`Deferred WaitForFrameAvailable() timed out`；
- **不存在**：`OH_MD_KEY_PIXEL_FORMAT`（与 §2.3 源码一致）；
- `libffmpeg.so` 只有 `ff_hevc_profiles` / `hevc` 解析串，没有 `ff_hevc_decoder`/`hevcdec`（无 HEVC 软解）。

### 2.2 Chromium 的 HEVC 支持模型：只有平台解码

- `media/base/supported_types.cc` 的 `IsDecoderHevcProfileSupported()` 仅在 `ENABLE_PLATFORM_HEVC` 下放行，并按平台能力缓存判断；
- `media/filters/ffmpeg_video_decoder.cc` 的 `IsCodecSupported()` 只允许 H.264；`third_party/ffmpeg/ffmpeg_generated.gni` 不含任何 `libavcodec/hevc*` 源文件；
- 因此 **HEVC 100% 依赖平台解码器**，没有"软件回退"可开。Electron 官方构建也是同一模型：Windows/macOS/Linux 靠 Media Foundation / VideoToolbox / VA-API。

这解释了为什么"给 Chromium 加个 flag"不可能成功：HEVC 不是被 feature 关掉的，而是被编译进/不编译进的问题；OHOS 构建已经把它编译进来了。

### 2.3 OHOS 移植的实现路径

调用链（源码可查）：

```text
GpuMojoMediaClientOHOS::CreatePlatformVideoDecoder()
  └─ OhosVideoDecoder::Create(... VideoFrameFactoryImpl ...)
       └─ CodecAllocator → MediaCodecDecoderBridgeImpl::CreateVideoDecoder()
            ├─ video/avc  → OH_VideoDecoder_CreateByMime("video/avc")
            └─ video/hevc → OH_VideoDecoder_CreateByMime("video/hevc")
                 └─ ConfigureBridgeDecoder(DecoderFormat{width,height})
                      → SetBridgeOutputSurface(OHNativeWindow)
                      → PrepareBridgeDecoder() → StartBridgeDecoder()
```

关键源码事实：

- [`ohos_media_decoder_bridge_impl.cc`](https://raw.gitcode.com/openharmony-tpc/chromium_src/raw/pc_chromium_132/media/base/ohos/ohos_media_decoder_bridge_impl.cc)：只分派 `video/avc` 与 `video/hevc`，无 VP9/AV1 平台路径；`DecoderFormat` 只带 width/height，**没有 `OH_MD_KEY_PIXEL_FORMAT`**。
- [`ohos_video_decoder.cc`](https://raw.gitcode.com/openharmony-tpc/chromium_src/raw/pc_chromium_132/media/gpu/ohos/ohos_video_decoder.cc)：`NeedsBitstreamConversion()` 返回 `true`（HEVC 走 AnnexB→HVCC 转换）；`GetMaxDecodeRequests()` 返回 **2**；能力探测 `GetHEVCSupportedConfig()` 的 profile 下限是 `HEVCPROFILE_MIN`，Main10 只有在设备上报时才可用。
- [`video_frame_factory_impl.cc`](https://raw.gitcode.com/openharmony-tpc/chromium_src/raw/pc_chromium_132/media/gpu/ohos/video_frame_factory_impl.cc)：帧格式写死 `PIXEL_FORMAT_ABGR`，通过 `VideoFrame::WrapSharedImage()` 交给 GPU，`allow_overlay=false`。
- [`native_image_texture_gl_owner.cc`](https://raw.gitcode.com/openharmony-tpc/chromium_src/raw/pc_chromium_132/gpu/command_buffer/service/ohos/native_image_texture_gl_owner.cc) / [`ohos_native_image.cc`](https://raw.gitcode.com/openharmony-tpc/chromium_src/raw/pc_chromium_132/ui/gl/ohos/ohos_native_image.cc)：`OH_NativeImage_Create(texture_id, GL_TEXTURE_EXTERNAL_OES)` → `OH_NativeImage_AcquireNativeWindow()` → 交给解码器 `SetSurface`；每帧 `OH_NativeImage_UpdateSurfaceImage()`。
- [`codec_output_buffer_renderer.cc`](https://raw.gitcode.com/openharmony-tpc/chromium_src/raw/pc_chromium_132/media/gpu/ohos/codec_output_buffer_renderer.cc) + [`codec_buffer_wait_coordinator.cc`](https://raw.gitcode.com/openharmony-tpc/chromium_src/raw/pc_chromium_132/media/gpu/ohos/codec_buffer_wait_coordinator.cc)：
  - `RenderToTextureOwnerBackBuffer()`：若 `IsExpectingFrameAvailable()` 为真则**直接返回 false**，不调用 `ReleaseToSurface()`；
  - 否则 `ReleaseToSurface()`（= `OH_VideoDecoder_RenderOutputBuffer`）→ `SetReleaseTimeToNow()`；
  - `RenderToTextureOwnerFrontBuffer()` → `WaitForFrameAvailable()` → `UpdateNativeImage()`；
  - `max_wait_` 默认 **0ms**（可调 5–20ms），所以 `WaitForFrameAvailable()` 是"延迟检查"而非阻塞等待；日志里的 ~110ms 是**距上次释放的时间**，不是等待阈值。

**修正仓库文档的两处描述**：

1. 第 96k 轮称帧工厂"只有 `CopyRGBATextureToVideoFrame`（RGBA 拷贝）"。开源代码显示 OHOS 帧工厂实际走 `WrapSharedImage` + `NativeImageTextureOwner`（OES 外部纹理导入）；`CopyRGBATextureToVideoFrame` 字符串在 `libelectron.so` 里存在，但不在该文件，归属未定位（可能在预编译适配层）。**"没有 NV12 直接导入、HAL 的 NV12 输出必须经 surface 消费"这个结论不变**。
2. "约 100ms 超时后拆除"应表述为：首帧释放后约 110ms，下一次 front-buffer 检查发现帧事件仍未置位，随即按错误拆除；不是"等了 100ms 没等到"。

### 2.4 三层缺陷与排除矩阵

| 层 | 缺陷 | 证据 | 现状 |
| --- | --- | --- | --- |
| L1 配置层 | `Configure` 只给 width/height，HAL 拒绝 | 第 95c 轮 `OH_VideoDecoder_Configure invalid argument`；垫片补 `NV12` 后 1080p 全绿 | 垫片已证可修，但垫片已撤销 |
| L2 格式层 | HAL 只出 NV12，桥接队列默认 RGBA，帧工厂无 NV12 导入 | 第 96i/96j 轮；RGBA 被 HAL `unsupport interface` 拒绝 | 中继/GPU 转换可绕过，但引入 L3 |
| L3 呈现层 | 解码器输出后只上屏 1 帧，~110ms 后拆管线 | 第 98r 轮 `norelay` 直连：**AVC 与 HEVC 都只 1 帧**（21 pushes / 1 render / 7 frees） | 断点在引擎内部，垫片不可达 |

第 98 轮的排除矩阵（全部真机实证）：编解码器（avc/hevc）、位深（8/10-bit）、数据源（file/http）、音轨（有/无）、中继（relay/norelay）、时间戳（无 pts/原始 pts）、缓冲属性（usage/geometry/预灌/fence）——**全部不影响"1 帧后停"**。这条矩阵把"HEVC 特有问题"彻底排除，剩下的是平台硬解呈现环本身。

### 2.5 源码级可疑点（供自编译修复用，非已证根因）

1. **`FrameInfoHelperImpl::ProcessRequestsQueue()` 的尺寸快路径（首选假设）**：

   ```cpp
   } else if (visible_size_ == request.buffer_renderer->size()) {
     std::move(request.callback).Run(std::move(request.buffer_renderer), frame_info_);
   } else {
     DVLOG(2) << "OnGpu::ProcessRequestsQueue will GetFrameInfo";
     on_gpu_.AsyncCall(&OnGpu::GetFrameInfo)...
   }
   ```

   首帧 `visible_size_` 为空、尺寸不等，走 `OnGpu::GetFrameInfoImpl()`，其中调用 `RenderToTextureOwnerFrontBuffer()`——首帧的 `ReleaseToSurface()` + `UpdateNativeImage()` 就发生在这里。第二帧起尺寸相同，走快路径，**不再调用 `RenderToTextureOwnerFrontBuffer()`**，呈现责任交给合成器的 `CodecImage::UpdateAndBindTexImage()`。若合成器没有按预期调用，输出缓冲不归还。这与"恰好 1 帧上屏、`FreeOutputData ×7`、~110ms 后 Deferred timeout"高度吻合。
2. **`RenderToTextureOwnerBackBuffer()` 的早退**：`IsExpectingFrameAvailable()` 为真时不 `ReleaseToSurface()`，输出槽不归还；在途请求上限只有 2，输出槽一旦不归还，解码器很快停摆。
3. **`release_time_` 生命周期**：只有 front-buffer 路径会清空它；若某路径只 back-buffer 不 front-buffer，状态机永久停在"期待帧"。

> 以上均为假设，必须在自编译版里用 `TRACE_EVENT`/`LOG(INFO)` 逐点验证后再改；不要在闭源二进制上盲改（第 96g 轮已论证证据面不足）。即使假设 1 不成立，也不影响结论：断点在呈现环，不在解码能力。

---

## 3. 为什么"打开硬解开关"不成立

第 95b 轮曾注入：

```text
--enable-features=PlatformVideoDecoder,kIsPlatformVideoDecoder,PlatformAudioDecoder,kIsPlatformAudioDecoder
```

第 95c 轮真机日志出现 `CodecClient [h.vdec]{Configure} invalid argument` / `NativeVideoDecoder {OH_VideoDecoder_Configure} configure failed`，证明**路由已经命中**；第 96d 轮进一步证明：删掉该 flag，`CreateByMime(video/hevc)` 依然发生——**flag 与路由无关**。

当前 [`ohsidian-flags.json`](web_engine/src/main/resources/resfile/resources/app/ohsidian-flags.json#L2) 已撤回该 flag，并在注释中写明原因；[`verify-asar.cjs`](scripts/verify-asar.cjs#L29) 还断言了实验开关已被移除。

结论：**不存在"加一个开关就能 HEVC 硬解"的路径**。`enable_platform_hevc` 是 GN 参数且已为真；`PlatformVideoDecoder` 不是这个移植版的运行时门控。

---

## 4. 可行路径评估

| 路径 | 应用内播放 HEVC | 是否硬解播放 | 工作量* | 主要风险 | 适用场景 |
| --- | --- | --- | --- | --- | --- |
| **A. 自动转码**（HEVC→H.264/MP4，缓存后播） | ✅ | ❌（播放仍走软解） | 3–7 天 | 首次等待、缓存占空间、画质损失、仅本地文件 | 立刻可用，覆盖多数本地录制 |
| **B. 原生覆盖播放器**（ArkTS `AVPlayer` + `XComponent` 叠在 `<video>` 位置） | ✅ | ✅ | 2–4 周（+1–2 周补实时通道） | 坐标/滚动/缩放同步、全屏、多窗口、输入穿透、插件兼容；内联但异物感最强，**W 不可行时的备选** | 必须内联且 W 不可行 |
| **H. 内置原生播放页（B′）**（`AVPlayer` + `XComponent` 全屏/弹层） | ✅ | ✅ | 1–2 天（harness） | 把笔记切换成播放页，违背"连贯/无异物感"；**只作技术验证，不作为产品形态** | 验证 AVPlayer/fd/XComponent |
| **W. WebCodecs + Canvas 自绘播放器**（`VideoDecoder` 硬解 → canvas） | ✅ | ✅ | 2–4 周（spike 通过后） | 需真机 spike 确认 HEVC WebCodecs；自研 MP4 demux/音画同步；一次帧拷贝 | **内联首选**：滚动/缩放/主题/模态天然一致 |
| **P. 画中画卡片**（原生硬解，浮在角落，笔记仍可读） | ✅ | ✅ | 3–5 天 | 不是内联；卡片遮挡少量内容；无 rect 跟随 | W/B 之前的过渡、边看边记 |
| **C. 自编译引擎，修呈现环** | ✅ | ✅（AVC/HEVC 都受益） | 4–8 周 | 构建环境、patch 漂移、SDK ABI、签名分发 | 根治 + 可向上游提 PR |
| **D. 自编译引擎 + FFmpeg HEVC 软解** | ✅ | ❌ | 2–4 周（在 C 的构建基础上） | 1080p 可行、4K 吃力；专利池；LGPL 合规 | 不想碰呈现环，接受 CPU 成本 |
| **E. 换更新预编译引擎** | ❌ 已证否 | ❌ | 0（无可换产物） | 上游最新 HAP 引擎与本地逐字节一致；SIG 无 release；138 源码未修 | 不要在这条路上投入 |
| **F. 继续 `libnative_media_vdec.so` 垫片** | 已证否 | — | — | 呈现层不可达；引擎升级即失效 | 不建议 |
| **G. 系统播放器外部打开**（现状兜底） | ❌（跳出应用） | ✅ | 已实现 | 体验割裂 | 兜底 |

\* 一名熟悉本仓库的工程师的粗略量级，不含真机回归与发版。

### A. 自动转码（兜底路线，非硬解）

HarmonyOS 官方 `media.createAVTranscoder()` 的目标格式表就是 **MP4 + AVC(H.264) + AAC**，即 HEVC→H.264 是官方支持的标准用例；用 `canIUse('SystemCapability.Multimedia.Media.AVTranscoder')` 做能力门控。

实现要点：

- 渲染层现有的 HEVC 错误/悬挂检测（[`update-obsidian.mjs`](scripts/update-obsidian.mjs#L681) 的 `ohsidianOfferSystemPlayer`）改为"转码并替换源"；
- 输入/输出都用 fd（AVPlayer/AVTranscoder 不支持裸路径），输出放应用缓存目录，按源文件 hash 命名，避免重复转码；
- 转码期间显示进度；完成后把 `<video>` 的 `src` 指向缓存文件，原文件不动；
- 大文件/4K 设阈值，超限仍走系统播放器。

优点：不碰引擎、不碰专利（系统编解码器由设备授权）、当天可验证。缺点：首次播放有等待、缓存占空间、**不是硬解播放**。

### B. 原生覆盖播放器（体验路线，真硬解）

架构：

```text
Obsidian 渲染层（asar 补丁）
  └─ 检测 HEVC <video> / 播放失败 → 读取 rect、src、播放状态
       └─ 经既有文件通道或 IPC 上报 ArkTS
ArkTS（web_engine）
  └─ 在浏览器 XComponent 之上叠一个定位到 rect 的 XComponent
       └─ AVPlayer.setSurfaceId(...) 播本地 fd；回传 play/pause/seek/timeupdate
```

可行性要点：

- [`WebWindow.ets`](web_engine/src/main/ets/components/WebWindow.ets#L83) 当前是 `NodeContainer` 里的 `XComponent`；页面层（[`Index.ets`](electron/src/main/ets/pages/Index.ets#L97)）可以改成 `Stack`，在上层放一个按 rect 定位的 `XComponent`/`Video` 节点，`hitTestBehavior` 只覆盖视频区域。
- `AVPlayer` 支持 `fdSrc` 播本地文件、`surfaceId` 输出到 XComponent；H.265 在 HarmonyOS 是 API 10 起的必选解码能力（`media-kit-intro`），硬解由系统负责。
- **不要用 ArkWeb 的 `enableNativeMediaPlayer`/`onCreateNativeMediaPlayer`**：那是 ArkWeb `Web` 组件的接口；本应用是 Electron 自己的 Chromium 表面（XComponent + `libelectron.so`），该接口不适用。
- 难点在"贴合"：滚动、窗口 resize、Obsidian 缩放、多窗口、全屏、CSS transform；需要 `ResizeObserver` + `scroll` + `rAF` 节流上报 rect，ArkTS 侧做边界裁剪。
- **隐藏难点（2026-10-18 补充）**：现有 JS→ArkTS 只有 200ms 文件通道（`ohsidian-mode.json`/`ohsidian-protocol.json`），追不上 60fps 滚动；要做 B 必须再补一条本地 socket 通道（ArkTS `TCPSocketServer` + Electron `net`），额外 1–2 周。否则只能"滚动时隐藏 overlay、停下再显示"，闪烁/异物感仍在。
- 音频：覆盖播放器出声时把 HTML `<video>` 置 `muted`，避免双声道；音量/静音双向同步。

这是"应用内硬解 HEVC"体验最好的路线，但工程量与边缘场景最多。

#### B 的 bug 面（为什么"不推荐先做"）

| # | 风险 | 触发原因 | 用户可见后果 | 缓解成本 |
| --- | --- | --- | --- | --- |
| 1 | 滚动/坐标漂移 | rect 每帧变，ArkTS 更新滞后 | 视频"浮"在错位处 | 高：rAF 节流 + hide-on-scroll |
| 2 | 输入被吞 | 原生 surface 盖住页面 | 点不动、滚不动、右键失效 | 高：`HitTestMode.None` + 原生控制条 |
| 3 | 模态 z 序 | 原生 surface 永远在 web 之上 | 设置/命令面板被视频盖住 | 中：MutationObserver 隐藏 |
| 4 | 全屏 | HTML fullscreen 改 rect，原生全屏另一套 | 双状态/退出错乱 | 高 |
| 5 | 多视频/悬停预览 | 只有一个 overlay | 切视频错位/串台 | 中 |
| 6 | 缩放/DPR/insets | CSS px→vp 换算 | 偏移几像素到几十像素 | 中 |
| 7 | 多窗口 | 每窗一个 surface | 串窗/叠错 | 高 |
| 8 | 插件播放器 | 第三方自定义 DOM | 不匹配 | 不可控 |
| 9 | 双声道 | HTML 与 AVPlayer 同时出声 | 回声 | 低：mute |
| 10 | 生命周期 | 导航/关闭未 release | 泄漏/黑屏 | 低 |
| 11 | 字幕 | `<track>` 在 DOM 层 | 丢失 | 中 |
| 12 | 性能 | 额外 surface + 每帧 rect | 低端机卡顿 | 中 |

结论：B 的"贴合"不是一个小模块，而是一套跨 JS / ArkTS / 窗口系统的状态机；2–4 周是保守估计。**先用 H（B′）拿到硬解能力，再决定是否为"内联"付这套成本。**

### H. 内置原生播放页（B′，仅作技术验证）

> 2026-10-18 二次评估（用户反馈）：**B′ 不是产品形态。** HarmonyOS 里它不是新 OS 窗口，而是同窗口全屏 `Stack`；但体验上仍是"离开笔记"，桌面版等价于单独开播放器窗口。对 Obsidian 的"连贯阅读/无异物感"是硬伤。保留它只作为 **1–2 天的技术 harness**（验证 `AVPlayer` + fd + `XComponent`），不作为发布路径。

一句话：点一下 HEVC 视频，弹一个应用内的全屏原生播放页。仍然是 `AVPlayer` 硬件解码，但不做 rect 跟随、不做输入穿透、不和页面 z 序打架——B 里 80% 的坑直接消失，代价是**把笔记切换成播放页**。

架构：

```text
Obsidian 渲染层（asar 补丁）
  └─ 检测 HEVC（读文件头找 hvc1/hev1）→ 原子写 <userData>/ohsidian-native-video.json
ArkTS（electron/Index.ets）
  └─ 200ms 轮询同一个文件 → Stack 顶层显示 NativeVideoPlayer
NativeVideoPlayer（web_engine）
  └─ XComponent + AVPlayer.fdSrc → 播放/暂停/seek/关闭；关闭时 release
```

为什么能成立（均已核验）：

- **文件通道现成**：ArkTS 写 `filesDir/ohsidian-mode.json`，渲染层读 `app.getPath("userData")/ohsidian-mode.json`，证明二者是同一目录；反向复用即可（[`WebAbility.ets`](web_engine/src/main/ets/ability/WebAbility.ets#L334)、[`update-obsidian.mjs`](scripts/update-obsidian.mjs#L211)）。
- **路径权限现成**：`web_engine` 已声明 `READ_WRITE_DOCUMENTS_DIRECTORY` / `DOWNLOAD` / `DESKTOP` 与 `FILE_ACCESS_PERSIST`（[`module.json5`](web_engine/src/main/module.json5#L68)），`fileIo.openSync(absPath)` 可直接拿 fd；不需要把视频拷进沙箱。
- **`AVPlayer` 就是官方推荐**：`fdSrc` + `surfaceId`，HEVC 由系统硬解；`XComponentController.getXComponentSurfaceId()` 在 `onLoad` 里取。
- **为什么不用 ArkUI `Video` 组件**：官方文档限定它的 `src` 只支持 `$rawfile`、`file://<bundleName>/<sandboxPath>`（应用沙箱）和网络 URL，不支持 vault 的任意绝对路径或 fd；把大视频拷进沙箱不可接受。所以用 `AVPlayer.fdSrc` + `XComponent`。
- **页面结构只需一层 `Stack`**：`Index.build()` 现在是 `Row(){ WebWindow() }`，改成 `Stack(){ Row(){...}; if(showPlayer){ NativeVideoPlayer(...) } }`；`onBackPress` 优先关播放器。
- **不需要改 `JsBindingMethod`、也不需要 `callArkTSFunction`**：引擎二进制里未命中 `callArkTSFunction` 字符串（`strings libelectron.so` 已核验），别在这上面赌；文件通道最稳。

> 复用关系：播放器核心（fd/state/seek/controls）与 B 共用；B 的增量是 overlay host + rect/scroll/z-order。所以 B′ harness **只 de-risk 播放器，不 de-risk B 的难点**；真正决定 B 成败的是"贴合"状态机。

实现清单（1–2 天 harness）：

> 若只是验证播放器，1–2 天足够；若要打磨成可发布的全屏播放页，约 3–6 天，但产品形态不推荐（见上方定位修正）。

| 步骤 | 文件 | 内容 |
| --- | --- | --- |
| 1 | 新增 `web_engine/.../components/NativeVideoPlayer.ets` | `XComponent(SURFACE)` + `AVPlayer`；`fdSrc`/`surfaceId`/`stateChange`/`timeUpdate`；控制条（播放、进度、时间、关闭）；`aboutToDisappear` release + close fd |
| 2 | `electron/.../pages/Index.ets` | `Stack` 顶层挂播放器；`setInterval(200ms)` 读 `filesDir/ohsidian-native-video.json`，`seq` 变化才打开；`onBackPress` 先关播放器 |
| 3 | `scripts/update-obsidian.mjs` | 复用 `ohsidianResolveMediaPath`；文件头 sniff `hvc1`/`hev1`；在现有失败 Notice 里加"用内置播放器打开"按钮（MVP），或替换成占位卡片 |
| 4 | 同上 | 失败/权限不足时回退现有系统播放器；主窗口之外先不接（多窗口后续） |
| 5 | 验证 | 1080p 8/10-bit HEVC 起播、seek、60s、CPU、退出重进；H.264 不受影响 |

风险（都远小于 B）：

1. **路径权限**：Documents/Download/Desktop 之外的 SAF 目录可能 `open` 失败 → 回退系统播放器；先按"vault 在 Documents"验收。
2. **200ms 通道延迟**：只用于"打开"，不影响播放流畅度；原子写避免半截 JSON。
3. **`AVPlayer` 状态机**：`initialized→prepared→playing`、seek、release 要按官方示例；建议先做 30 行 spike 再铺 UI。
4. **多窗口**：`Index` 只覆盖主窗口；子窗口先回退系统播放器，后续用 windowId 路由。
5. **字幕**：外挂 `<track>` 不会显示；内嵌字幕依赖 `AVPlayer` 能力，先不承诺。
6. **8K**：设备 HAL 限制仍在，超过 4K 给提示。

体验取舍：**不是内联**，是"点开一个原生播放页"。对"连贯阅读"是硬伤；因此它只作为 harness 或极少数场景的兜底，不作为主体验。真正的主体验是 W（内联）或 P（画中画）。

### W. WebCodecs + Canvas 自绘播放器（内联首选，spike 通过后 2–4 周）

如果"必须内联"且不想碰 ArkTS 覆盖层，这是比 B 更干净的方向：**用 WebCodecs 的 `VideoDecoder` 走平台硬解，把 `VideoFrame` 画到 `<canvas>`，完全活在 Obsidian 页面里**——没有原生 surface、没有坐标同步、没有输入穿透、没有模态 z 序问题。

为什么它最符合 Obsidian：

- **DOM 原生**：`<canvas>` 就在笔记流里，滚动、缩放、主题、分屏、模态全部天然一致；不会出现"视频浮在错位处"。
- **硬件解码仍在**：`VideoDecoder` 走平台解码器，硬解不变；只是多一次帧拷贝（GPU→canvas）。
- **失败模式温和**：spike 不通过就不做，不会留下 overlay 的长期 bug 和边缘场景。
- **代价**：2–4 周，demux、音轨、控制条、seek 都要自己写。

可行性证据（`strings libelectron.so`）：

- 存在 `VideoDecoderConfig`、`isConfigSupported`、`hvc1`/`hev1.`、`GetPlatformSupportedVideoDecoderConfigs`，以及 HEVC 专用报错 "If you're using HEVC formatted H.265 you must fill out the description field in the VideoDecoderConfig" → **WebCodecs 与 HEVC 配置路径都在引擎里**。
- WebCodecs 的帧直接交给 JS，不经过 `<video>` 那条已经断裂的 `CodecOutputBufferRenderer`/`FrameInfoHelper` 呈现环，所以**有可能绕开 98r 的 1 帧停**。
- 但"有 API"不等于"设备上可用"；**必须先做 1 天真机 spike**：

  | # | 检查 | 判定 |
  | --- | --- | --- |
  | 1 | `window.isSecureContext`、`'VideoDecoder' in window` | 两者都为真 |
  | 2 | `await VideoDecoder.isConfigSupported({codec:'hvc1.1.6.L120.B0'})`（再试 Main10 `hvc1.2.4.L120.B0`） | `supported: true` |
  | 3 | mp4box 取 hvcC + 首个关键帧 → `configure` → `decode` → 数 3 秒 `output` 帧 | 持续出帧（不是 1 帧） |
  | 4 | 记录 `VideoFrame.format`、CPU、`drawImage` 到 canvas 的耗时 | 1080p30 可接受 |
  | 5 | 同一路径喂 AVC 作对照 | AVC 正常、HEVC 也正常才通过 |

  判定：连续出帧 → W 可行；只出 1 帧/报错 → 回 B/P/A。

工程量与坑：

1. **解封装**：WebCodecs 只吃 `EncodedVideoChunk`，要自己 demux MP4。用 `mp4box.js`（~几十 KB，可打进 asar）取 `hvcC`、sample、时间戳、关键帧索引；MKV 还要另一套（可先只支持 MP4/MOV）。
2. **音画同步**：视频帧由 canvas 画，音频要么用 `<audio>` 播"只含音轨的 remux MP4"（mp4box 可做），要么用 WebCodecs `AudioDecoder`（AAC）+ WebAudio 调度；后者更统一但更费工。
3. **CPU/内存**：`drawImage(VideoFrame)` 可能触发 GPU→CPU 拷贝；1080p30 预计可接受，4K 要实测；`VideoFrame.close()` 必须及时，否则解码器停摆。
4. **播放器 UI**：进度、seek（从最近关键帧重解）、倍速、全屏、字幕都要自己写；等于重做一个 `<video>`。
5. **插件兼容**：只接管 Obsidian 原生 `<video>`，第三方播放器插件不保证。

结论：**架构最优雅（纯 JS、内联、真硬解），但工作量与 B 同量级（2–4 周），且有一个"WebCodecs HEVC 是否真的可用"的前置门槛。** 建议先花 1 天 spike；spike 通过再排期，不通过就回到 B、P 或 A。

### P. 画中画卡片（低工程量折中，3–5 天）

不把视频放进笔记流，也不全屏接管：点 HEVC 视频 → 右下角浮一个 320×180 左右的原生卡片（`AVPlayer` + `XComponent`），笔记仍然可读、可滚。

- 优点：不做 rect 跟随、不做输入穿透、不做全屏；3–5 天；比 B′ 的"离开笔记"轻得多。
- 缺点：不是内联；卡片会遮住一小块笔记；模态 z 序仍需处理（可先接受，或用 MutationObserver 隐藏）。
- 定位：W spike 不通过、又不想等 B 的 2–4 周时的过渡方案；也可作为"边看边记"的长期功能。
- 复用：与 B′ 共用同一个播放器核心，只是宿主从全屏改成角落卡片；后续可把同一 surface 挪到视频 rect，演进成 B。

### C. 自编译引擎（根治路线）

关键事实（此前文档称"闭源"不准确）：

- 移植源码公开：`openharmony-tpc/chromium_src` 分支 `pc_chromium_132`（Chromium 132.0.6834.161）；Electron 覆盖层 `openharmony-sig/electron`；
- `libelectron.so` 由 [`electron_build.sh`](https://raw.gitcode.com/openharmony-sig/electron/raw/master/electron_build.sh) 用 GN/Ninja 构建（`target_os="ohos"`, `use_musl=true`, `out/musl_64`）；
- 但构建门槛高：Ubuntu 22.04、>200GB 磁盘、>32GB 内存、arm64/musl（无 x86，模拟器不可用）；当前 master 与 `pc_chromium_132` 存在 patch 不匹配（上游 issue #64），需要固定 manifest/commit；
- 引擎与 OHOS SDK 6.0.2.130 的预编译适配层 ABI 绑定，换 SDK 有链接风险。

在这条路上修 §2.5 的呈现环，收益是 AVC/HEVC 硬解一起修好，且可向上游提 PR；风险是周期与维护成本。若只为 HEVC，投入产出比不如 A/B。

### D. FFmpeg HEVC 软解（C 的替代）

Chromium 上游**没有** HEVC 软解：`FFmpegVideoDecoder::IsCodecSupported()` 只允许 H.264，`ffmpeg_generated.gni` 不含 `hevcdec.c`。要加软解，至少改四处：

1. `third_party/ffmpeg/ffmpeg_generated.gni`：加入 `libavcodec/hevc/*`、`h265` parser/BSF（用 `media/ffmpeg/scripts/generate_gn.py` 重新生成）；
2. `media/base/supported_types.cc`：让 HEVC 在无平台解码器时也判定为可解（补 profile 判断，当前走 `ENABLE_PLATFORM_HEVC` + 平台能力缓存）；
3. `media/ffmpeg/ffmpeg_common.cc`：`AVCodecIDToVideoCodec()` 增加 `AV_CODEC_ID_HEVC → kHEVC`，`VideoCodecToAVCodecID()` 补反向映射；
4. `media/filters/ffmpeg_video_decoder.cc`：`IsCodecSupported()` 放行 `kHEVC`，并补 HEVC 的线程数/`GetCodecID` 分支。

此外要阻止平台解码器先"认领"HEVC（否则仍走断裂的呈现环），例如让 `OhosMediaCodecUtil::GetHEVCSupportedConfig()` 返回 `nullopt` 或加开关。

代价：1080p HEVC 软解在平板 CPU 上可行但占用高，4K 基本不可用；分发含 HEVC 软解的二进制涉及 HEVC 专利池与 FFmpeg LGPL 合规（Chromium 默认不开正是这个原因）。**仅建议作为 C 的备选，不作为首选。**

### E. 换引擎（2026-10-18 核验：当前没有可换的新预编译引擎）

结论：**这条路暂时走不通**，而且不是"没找"：

1. **上游最新预编译 HAP 的引擎与本地逐字节相同**。取 `HanversionOvO/OHSidian` 最新 release（`latest`，HarmonyOS-1.12.7，2026-05-30，219 MB）的 ZIP 中央目录，读出 `libs/arm64-v8a/` 五个库的 CRC32/尺寸，与本地 `electron/libs/arm64-v8a/` 计算值比对：

   | 库 | 上游 HAP CRC32 | 本地 CRC32 | 尺寸 |
   | --- | --- | --- | --- |
   | libelectron.so | 0x7fb1d370 | 0x7fb1d370 | 160,722,000 |
   | libadapter.so | 0x7cfc8211 | 0x7cfc8211 | 1,500,704 |
   | libffmpeg.so | 0x7721d3ec | 0x7721d3ec | 2,181,032 |
   | libextractor.so | 0x65d1d58c | 0x65d1d58c | 1,267,840 |
   | libc++_shared.so | 0x1b04d3a7 | 0x1b04d3a7 | 1,261,960 |

   五个全部一致 → 上游最新发布版没有更新引擎。

2. **SIG 仓库没有预编译产物**：`openharmony-sig/electron` GitCode 页面 Tags=0、无 release、仓库内没有 `libelectron.so`；README 要求自行 `electron_build.sh` 构建，产物在 `src/out/musl_64`。

3. **更新的 138 源码里，三个可疑缺陷一个没修**（`pc_chromium_138` 分支实测）：
   - `ohos_media_decoder_bridge_impl.cc` 仍只设 `OH_MD_KEY_WIDTH/HEIGHT`（无 `OH_MD_KEY_PIXEL_FORMAT`）；
   - `ohos_video_decoder.cc` 仍 `GetMaxDecodeRequests() == 2`；
   - `frame_info_helper.cc` 仍是 `visible_size_` 快路径；`codec_buffer_wait_coordinator.h` 仍 `max_wait_` 默认 0ms；`codec_output_buffer_renderer.cc` 仍是同一套 back/front 状态机。

4. **不能"只换 libelectron.so"**：`libelectron.so` 与 `libadapter.so`（`getNativeContext`/`NativeContext`/`JSBind`/`runBrowser`）以及 ArkTS 侧 `JsBindingUtils` 是版本耦合的；换单个库会直接破坏 `WebWindow` 的 `runBrowser` 调用链。

因此 E 从"1–3 天验证"降级为"已证否"；要换引擎只能走 C（自编译），而且不能指望换到 138 就自动修好 HEVC。

---

## 5. 推荐路线

| 阶段 | 动作 | 验收 | 预估 |
| --- | --- | --- | --- |
| P0 | ✅ 已完成引擎核验：上游 latest HAP 引擎与本地逐字节一致、SIG 无预编译产物、138 源码未修三处缺陷（见 §4.E）。剩余：向上游提 issue（附 §2.4 证据） | issue 有编号 | 1–2 天 |
| P0.5 | B′ harness（1–2 天）：只验证 `AVPlayer` + fd + `XComponent` 能硬解 HEVC，**不发布** | 1080p HEVC 能播/seek | 1–2 天 |
| P1 | **W spike（代码已落地，待真机）**：`VideoDecoder.isConfigSupported` + 实际文件解码 60 帧；这是 Go/No-Go | 明确 supported/unsupported + 连续帧数 | 1 天（代码完成，待设备结果） |
| P2 | W 通过 → W（2–4 周，内联、无异物感）；不通过 → B（2–4 周，内联覆盖层）或 P（3–5 天，画中画） | 方案通过 §1 验收 | 2–4 周 / 3–5 天 |
| P2b | A 转码兜底（可并行） | 1080p HEVC 首次转码后可直接播；二次播放无重复转码 | 3–7 天 |
| P3 | 若产品必须"零妥协"：C（自编译 + 修呈现环），或 D（软解）作为过渡 | 上游 PR 或私有构建通过 §1 全部验收 | 4–8 周 |

**不建议**：再投入垫片、替换来源不明的 `libffmpeg.so`、或在闭源二进制上做 ARM64 盲改。

> "新版本总是好的"在本项目不成立：138 分支的 media 代码仍带着 W/H-only Configure、`GetMaxDecodeRequests()==2`、`visible_size_` 快路径这三处缺陷，升级引擎不会自动修好 HEVC；换引擎只能自编译（C），且必须自己改代码。

### W spike 已落地（2026-10-18）

这一版先把 **Go/No-Go 探针**做完，不急着铺完整播放器；探针结果决定 W 是否继续。

**新增文件**

| 文件 | 作用 |
| --- | --- |
| [`scripts/ohsidian-webcodecs-mp4.cjs`](../scripts/ohsidian-webcodecs-mp4.cjs) | 最小 MP4/MOV 解析：`hev1`/`hvc1`/`avc1`、`hvcC`/`avcC`、`stts`/`stsc`/`stsz`/`stco`/`co64`/`stss`，输出 sample 表；可选 audio/esds |
| [`scripts/ohsidian-webcodecs-probe.cjs`](../scripts/ohsidian-webcodecs-probe.cjs) | 渲染层命令：检查 `isSecureContext`/`VideoDecoder`，对实际文件做 `isConfigSupported` + 解码 60 帧；支持显式路径/AVC 对照；主路径失败时自动试 Annex B / 无 description / prefer-hardware / no-latency 变体，并写首样本 NAL 诊断 |
| [`scripts/ohsidian-webcodecs-player.cjs`](../scripts/ohsidian-webcodecs-player.cjs) | Canvas + 控制条播放器壳（已独立语法检查；尚未接到解码器） |
| [`scripts/update-obsidian.mjs`](../scripts/update-obsidian.mjs) | 把上面三个补丁前置进 `app.js`；缺文件只告警，不阻断旧流程 |
| [`scripts/inject-webcodecs-asar.mjs`](../scripts/inject-webcodecs-asar.mjs) | 本机已在 asar 上验证过：不重新下载 Obsidian，直接把补丁注入现有 asar（更新器网络不可用时的兜底） |

**真机步骤**

1. 用 DevEco/CI 重新构建 HAP；CI 的 `build-release.yml` 会执行 `node scripts/update-obsidian.mjs <version> --repatch`，自动注入；本地 `obsidian.asar` 已注入，可直接构建。
2. 安装后，把任意 HEVC `.mp4/.mov` 放进 vault（或先打开它）。
3. 命令面板执行 `OHSidian: WebCodecs HEVC 探针`。
4. 结果在 vault 根目录 `OHSidian-WebCodecs-Probe.json`；同时写到应用 `files/ohsidian-webcodecs-probe.json`，方便 `hdc file recv`。

**判定（四条同时看）**

| 字段 | 通过条件 | 失败含义 |
| --- | --- | --- |
| `secureContext` / `hasVideoDecoder` | 都为 `true` | 渲染层根本没开 WebCodecs，W 直接出局 |
| `configs.hevcMain.supported` | `true` | 平台没有 HEVC 解码配置，W 出局 |
| `decode.hevc.frames` | `> 1`（目标 60） | 只出 1 帧/0 帧：解码或呈现仍有问题 |
| `decode.hevc.error` / `drawMs` | `null` / 平均 `drawMs/frames` 可接受（1080p30 < 33ms，60fps < 16ms） | 帧拷贝/绘制太重，需换 WebGL/降低分辨率 |
| `decodeVariants` | 主路径失败时看这一组；任一变体 `frames > 0` 即仍有救 | 全部 0 帧：优先怀疑码流/10-bit，而不是界面 |

**2026-10-18 真机结果（BKY-W10）**

用户提供 `hevc_main10.mp4`（`hvc1`、1920×1080、38286 samples、约 185 MB，v2 + v3 结果）：

- `hvc1.2.4.L150.90`，Main10（`diag.hvcC.profileIdc=2`），hvcC 3 个 array（VPS 25 / SPS 42 / PPS 6），首 key 是 IDR_N_LP（NAL type 20），lengthSize=4；
- v2：`configs` 全 `supported`；`length+desc` fed 60、frames 0、`EncodingError`；
- v2：`annexb+nodesc` fed 60、flush 成功、frames 0：没有 VPS/SPS/PPS，解码器不报错但出不了帧；
- v2：`annexb+desc` 只 fed 17 就 `DataError: key frame is required`：description 与 Annex B 格式冲突；
- v3：`annexb+params`、`annexb+params+hw`、`length+params+desc` 全部 fed 60、frames 0、`EncodingError`，且 `parameterSetCount=3`，证明 VPS/SPS/PPS 已确实前置；
- v4（8-bit `hevc.mp4`，Main profile、1280×720、300 samples）：主路径 + 全部变体仍然 0 帧；`annexb+params` 带 3 个参数集、fed 60，依旧 `EncodingError`；`annexb+nodesc` flush 成功、0 帧。

结论：**Main10 假设被 8-bit 720p 直接排除**。最简 8-bit Main 720p 都出不了帧，说明不是 10-bit、不是分辨率/level、也不是缺参数集；`isConfigSupported` 只能证明“配置可声明”，不能证明“该 OHOS/Electron 构建的 WebCodecs HEVC 实际可解码”。**HEVC 的 W 路线在这台设备上判 No-Go**，不要再加 HEVC 变体。

**AVC 对照实测（2026-10-18，v5）：也 0 帧。**

- `avc.mp4`（H.264 High、1280×720、300 samples、avcC 45 B）：`configs.avc.supported=true`，`decode.avc` fed 60、frames 0、`EncodingError`；
- 同一份 AVC 文件上，`configs.hevcMain` 用 **没有 description 的 fallback codec** `hvc1.1.6.L120.B0` 也返回 `supported:true`——这证明 `isConfigSupported` 只做 codec 字符串检查，**不是解码器实例化**，不能作为 W 的 Go 依据；
- 探针曾把 avcC 当 hvcC 解析，导致 `diag.hvcC.lengthSize=1`、`firstNalType=0`、`lens=[]`；已修：AVC 现在走 `parseAvcC`，真实 `lengthSize=4`、首个 NAL 是 SEI（type 6，787 B），样本本身有效。

结论升级：**WebCodecs 视频解码整体不可用，W 整体 No-Go**，不是 HEVC/10-bit 问题，也不是 MP4 解析问题。

这与第 96/98 轮垫片的结论对得上但不同层：垫片当年修好 `OH_VideoDecoder_Configure` + NV12 后，**硬件解码能出 1 帧**，断在**呈现环**；现在 WebCodecs **0 帧**，断在更前面的解码/输出。共同点是**闭源引擎的 OHOS 视频解码/呈现链**，不是 JS 层能补的细节。源码级证据见 [CHANGES-2026-09.md](CHANGES-2026-09.md) 第 4642–4674 行。

如果命令面板报 `已扫描 ... 未找到 hvc1/hev1 (HEVC)`，那是旧探针的选择器只认 HEVC，不是 AVC 解码失败：先在 Obsidian 里点开 `avc.mp4` 作为活动文件再跑。新探针已加选择回退：活动文件优先 → 扫 HEVC → 扫 AVC → 第一个视频（`source=scan-avc` / `scan-fallback`）。

B 路线的最低成本测试：在笔记里直接写 `![[hevc_main10.mp4]]`（Obsidian 的媒体嵌入本质是 `<video>`）。能播放，就说明 inline `<video>` 可用；不能播放，再考虑 P/A/原生。注意：H.264 `<video>` 有软解回退（现有 H264 能播），HEVC 没有编译软解，所以 B 对 HEVC 的成功率本来就低。

**8-bit / 10-bit 隔离矩阵（2026-10-18 本机生成）**

用 `ffmpeg 9.0.2 + libx265` 生成 2 秒 `testsrc2`、48 samples、`hvc1`、无音频：

| 样例 | profile | 分辨率 | samples | 大小 |
| --- | ---: | --- | ---: | ---: |
| [`hevc.mp4`](../.cache/webcodecs-test/hevc.mp4) | Main (1) | 1280×720 | 300 | 1.0 MB |
| [`hevc_8bit_1080p.mp4`](../.cache/webcodecs-test/hevc_8bit_1080p.mp4) | Main (1) | 1920×1080 | 48 | 1.3 MB |
| [`hevc_10bit_720p.mp4`](../.cache/webcodecs-test/hevc_10bit_720p.mp4) | Main10 (2) | 1280×720 | 48 | 0.6 MB |
| [`hevc_10bit_1080p.mp4`](../.cache/webcodecs-test/hevc_10bit_1080p.mp4) | Main10 (2) | 1920×1080 | 48 | 1.3 MB |

W 已对 HEVC 判 No-Go；这组样例保留给后续 `<video>`/原生解码的 HEVC 能力测试，不再用于 WebCodecs 变体。若之后测 `<video>` HEVC，逐个打开记录 `videoWidth`/`canplay`，不是 `decode.hevc.frames`。

| 观察 | 结论 |
| --- | --- |
| 8-bit 720p/1080p 出帧，10-bit 两个都 0 | 10-bit/Main10 是限制；W 可支持 8-bit，Main10 需转码/原生 |
| 8-bit 1080p 0，8-bit 720p 出帧 | 1080p/level 或分辨率路径问题，先降分辨率验证 |
| 10-bit 720p 出帧，10-bit 1080p 0 | level 5.0/1080p 组合问题，优先降级或原生 |
| 四个都 0 | 该构建 WebCodecs HEVC 实际解码不可用；W 判 No-Go，回 B/P/A |

**已做的本机验证（不是设备结论）**

- 用真实 `hev1` 样例（1280×720、300 samples、`hvcC` 2024 B）跑通解析器：`hev1.1.6.L93.90`、首个 key sample 的 NAL type=19、lengthSize=4、单 NAL 长度匹配；
- 用 fake `VideoDecoder` 跑通探针控制流：60 帧计数、`diag`/`decodeVariants` 结构、canvas 绘制、userData+vault JSON 写入、Notice 都正常；
- 用“只认 key chunk 里带 VPS”的 fake 解码器验证 `annexb+params`：60 帧、`parameterSetCount=3`，证明 hvcC 参数集确实被前置进 Annex B；
- 用 `avc.mp4` 对照验证探针 AVC 分支：`decode.avc.frames=60`、HEVC 分支正确标记 skipped；设备上的 AVC 对照仍待执行；
- 播放器壳由子智能体 B 在 Edge headless + CDP 上 43/43 通过（canvas/dpr、`VideoFrame.close()`、控件、destroy）；该套 Chromium 测试未在本机复跑；
- 预置补丁 + 真实 `app.js` 合并后 `node --check` 通过；asar 重打包后 `verify-asar.cjs` 41 项全过。

**边界**

- 只支持非分片 MP4/MOV；MKV/WebM 另做；
- 探针不解音频，不验证音画同步；
- 文件 > 256 MB 直接报错（spike 范围）；
- `hev1` 的 `hvcC` 缺失时 `description` 为空，探针会尝试不带 description 的 config；
- 自动扫描读“头 64 KB + 尾 256 KB”；找不到 HEVC 时，先在 Obsidian 里打开那个视频，或在 DevTools 里 `__ohsidianWebCodecsProbe('/absolute/path.mp4')`。

**探针通过后的 W 主体（2–4 周）**：把 `OhsidianMp4` 的 sample 表接到 `VideoDecoder` 的实时调度；canvas 替换 `<video>`；音频用“只含音轨的 remux MP4 + `<audio>`”或 `AudioDecoder`+WebAudio；补 seek（从最近关键帧重解）、倍速、全屏、字幕与 `VideoFrame.close()` 背压。探针不通过则回 B（内联覆盖层）或 P（画中画）/A（转码）。



---

## 6. 真机验证清单（每条都要有日志/数据）

1. **能力**：`OH_AVCodec_GetCapabilityByCategory(OH_AVCODEC_MIMETYPE_VIDEO_HEVC, false, HARDWARE)` 是否非空；`OH_AVCapability_GetVideoSupportedPixelFormats()` 是否含 NV12；`GetMaxSupportedInstances()`。
2. **路由**：hilog 过滤 `CreateVideoDecoder video/hevc`、`CreatePlatformVideoDecoder`、`OH_VideoDecoder_Configure`。
3. **呈现**：`RenderOutputData #N` 是否随帧增长；`Deferred WaitForFrameAvailable` 是否消失；`relayed`/`render` 计数（若走垫片）。
4. **播放**：8-bit Main / 10-bit Main10、1080p / 4K、有/无音轨、file:// 与 http://、seek、暂停恢复、60s 连续、多视频同页。
5. **回归**：H.264/VP9/AV1 完整播放；窗口 resize/多窗口/全屏；CPU/内存/发热。
6. **边界**：8K HEVC 应给出明确提示（设备 HAL 限制），不得崩溃或悬挂。

---

## 7. 风险与合规

- **平台硬解**（AVCodec/AVPlayer）：解码器由设备提供，应用不分发编解码器，专利授权随设备；风险最低。
- **FFmpeg 软解**：FFmpeg 为 LGPL-2.1+，动态链接需满足源码提供等义务；HEVC 本身有专利池（Access Advance / MPEG LA），分发含 HEVC 软解的二进制存在专利风险，Chromium 默认 `proprietary_codecs=false` 正是出于此。
- **转码**：使用系统 AVTranscoder，不引入第三方编解码器；输出 H.264 无额外专利问题。
- **不要**从其他 Electron/Chromium 构建中替换 `libffmpeg.so`：ABI/符号版本不一致会导致引擎加载失败，且许可证来源不可控。

---

## 8. 证据索引

**仓库内**

- 第 95 轮 HEVC 首次定位：[CHANGES-2026-09.md](docs/CHANGES-2026-09.md#L3523)
- 95b 硬解路由开关：[CHANGES-2026-09.md](docs/CHANGES-2026-09.md#L3604)
- 95c 真机结论（Configure invalid argument）：[CHANGES-2026-09.md](docs/CHANGES-2026-09.md#L3820)
- 96f 垫片 1080p 全链路成功：[CHANGES-2026-09.md](docs/CHANGES-2026-09.md#L3998)
- 96k 帧工厂根因：[CHANGES-2026-09.md](docs/CHANGES-2026-09.md#L4164)
- 97 surface 中继：[CHANGES-2026-09.md](docs/CHANGES-2026-09.md#L4210)
- 98r 直连 1 帧终审：[CHANGES-2026-09.md](docs/CHANGES-2026-09.md#L4642)；提交 `bffc0c2`（98r 实验）、`fd77a95`（最终撤销）
- 当前 flag 状态：[ohsidian-flags.json](web_engine/src/main/resources/resfile/resources/app/ohsidian-flags.json#L2)
- 当前用户兜底：[update-obsidian.mjs](scripts/update-obsidian.mjs#L681)
- 垫片已撤销断言：[verify-asar.cjs](scripts/verify-asar.cjs#L29)
- 内置播放页（B′）落点：[WebAbility.ets](web_engine/src/main/ets/ability/WebAbility.ets#L334)（`filesDir` 写 mode 文件）、[update-obsidian.mjs](scripts/update-obsidian.mjs#L211)（`userData` 读同一目录）、[module.json5](web_engine/src/main/module.json5#L68)（目录权限）、[Index.ets](electron/src/main/ets/pages/Index.ets#L97)（页面 `Stack`）、[WebWindow.ets](web_engine/src/main/ets/components/WebWindow.ets#L83)（XComponent）
- WebCodecs 证据（`strings libelectron.so`）：`VideoDecoderConfig`、`isConfigSupported`、`hvc1`/`hev1.`、`GetPlatformSupportedVideoDecoderConfigs`

**上游源码（分支 `pc_chromium_132`）**

- 解码器：[ohos_video_decoder.cc](https://raw.gitcode.com/openharmony-tpc/chromium_src/raw/pc_chromium_132/media/gpu/ohos/ohos_video_decoder.cc)
- 桥接/Configure：[ohos_media_decoder_bridge_impl.cc](https://raw.gitcode.com/openharmony-tpc/chromium_src/raw/pc_chromium_132/media/base/ohos/ohos_media_decoder_bridge_impl.cc)
- 能力探测：[ohos_media_codec_util.cc](https://raw.gitcode.com/openharmony-tpc/chromium_src/raw/pc_chromium_132/media/base/ohos/ohos_media_codec_util.cc)
- 帧工厂：[video_frame_factory_impl.cc](https://raw.gitcode.com/openharmony-tpc/chromium_src/raw/pc_chromium_132/media/gpu/ohos/video_frame_factory_impl.cc)
- 呈现/等待：[codec_output_buffer_renderer.cc](https://raw.gitcode.com/openharmony-tpc/chromium_src/raw/pc_chromium_132/media/gpu/ohos/codec_output_buffer_renderer.cc)、[codec_buffer_wait_coordinator.cc](https://raw.gitcode.com/openharmony-tpc/chromium_src/raw/pc_chromium_132/media/gpu/ohos/codec_buffer_wait_coordinator.cc)
- GPU 客户端：[gpu_mojo_media_client_ohos.cc](https://raw.gitcode.com/openharmony-tpc/chromium_src/raw/pc_chromium_132/media/mojo/services/gpu_mojo_media_client_ohos.cc)
- NativeImage：[ohos_native_image.cc](https://raw.gitcode.com/openharmony-tpc/chromium_src/raw/pc_chromium_132/ui/gl/ohos/ohos_native_image.cc)
- 构建参数：[electron_build.sh](https://raw.gitcode.com/openharmony-sig/electron/raw/master/electron_build.sh)、[media_options.gni](https://raw.gitcode.com/openharmony-tpc/chromium_src/raw/pc_chromium_132/media/media_options.gni)
- FFmpeg 源列表：[ffmpeg_generated.gni](https://raw.gitcode.com/openharmony-tpc/chromium_third_party_ffmpeg/raw/pc_chromium_132/ffmpeg_generated.gni)

**HarmonyOS 文档**

- 视频解码（Buffer/Surface 两种模式、HEVC）：`https://raw.githubusercontent.com/openharmony/docs/master/zh-cn/application-dev/media/avcodec/video-decoding.md`
- 能力查询：`https://raw.githubusercontent.com/openharmony/docs/master/en/application-dev/reference/apis-avcodec-kit/capi-native-avcapability-h.md`
- AVPlayer/媒体能力（H.265 必选）：`https://cdn.jsdelivr.net/gh/openharmony/docs@master/en/application-dev/media/media/media-kit-intro.md`
- AVTranscoder（目标仅 AVC/AAC/MP4）：`https://cdn.jsdelivr.net/gh/openharmony/docs@master/en/application-dev/media/media/using-avtranscoder-for-transcodering.md`
- ArkWeb 原生媒体接管（本应用不适用，仅作对比）：`https://cdn.jsdelivr.net/gh/openharmony/docs@master/en/application-dev/web/app-takeovers-web-media.md`
