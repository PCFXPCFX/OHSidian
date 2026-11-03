# 版本记录

> 只记**对外发布**的版本与用户可感知的变化。逐轮实现细节、真机取证与回归分析见
> [CHANGES-2026-09](CHANGES-2026-09.md)、[CHANGES-2026-10](CHANGES-2026-10.md)
> （开发日志，不是发布说明）。

## 2.0.0（手写线首个版本）

`versionCode 2000000` · Obsidian 1.13.7 · 内核 `ink rev 58`

**手写笔**

- 华为 M-Pencil 压力/倾斜墨迹，笔杆双击/轻捏。
- 笔记、PDF、内嵌 PDF、Canvas 四个表面书写；墨迹侧车存 `.obsidian/ohsidian-ink/`。
- 长按拉直、一笔成形（方形/椭圆）、套索移动/复制/删除、点预测、压感橡皮、只擦荧光笔。
- 掌托过滤与笔事件仲裁；关闭手写笔模式后 PDF 不保留任何叠层。
- PDF 标注写回真实注释（`/PolyLine`，可切 `/Ink`），离开 PDF 时按脏页批量写，首次写入前备份。
- 修复 PDF 写回整体左下偏移：不再重复减 CropBox 原点。

**发布与评测**

- 新增 18 场景手写回归评测与宣传素材流水线（`scripts/stylus-eval/`）。
- agent 探针构建独立为 `scripts/build-agent.mjs`，产物只进 `artifacts/agent/`，不混入 release。
- 性能探针里的 PDF 自动滚动改为显式开启，不再影响正常阅读。
- `verify-release` 保证发布 asar 不含设备探针。

**平板与窗口**

- 触摸形态忽略浮窗记忆尺寸，修复启动画面不全屏（窗口被记忆成 869×706 的问题）。
- 2in1 保持原窗口行为，不受触摸形态整屏校正影响。

## 1.x 系列（平板适配）

- 窗口：layout fullscreen + 真实系统条 insets、触摸/桌面布局跟随系统、自由窗口钳制、
  标题栏与边框样式联动。
- 输入：键盘高度透传、格式化工具栏跟随输入法、触摸模式仓库切换。
- 外部内容：拖入即插入、跨应用文件取回、Share Kit 分享目标、碰一碰。
- 数据安全：删除进 `文档/OHSidianTrash/`，30 天自动清理，可恢复。
- 工程：`obsidian://` 深链、关闭自动更新、关闭 Release ArkGuard 混淆、CI 双图标发布。
- 性能：PDF 墨迹层按需分配、单页像素上限、pdf.js 真 worker；具体数据见
  [PERFORMANCE](PERFORMANCE.md)。

更早的逐轮记录从 [CHANGES-2026-09](CHANGES-2026-09.md) 开始。
