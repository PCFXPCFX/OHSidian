# 文档索引

> 发布前只需要读 **发布** 一栏；`archive/` 是历史取证，不是当前行为。
> 新增内容请并入下面对应文件，不要再建平行文档。

## 发布

| 文档 | 用途 |
|---|---|
| [RELEASE](RELEASE.md) | 发布前检查清单、CI、签名、哈希、tag 流程 |
| [CHANGELOG](CHANGELOG.md) | 对外版本记录（2.0.0 / 1.x） |
| [STYLUS](STYLUS.md) | 手写笔方案、18 场景评测、发版验收清单 |
| [PERFORMANCE](PERFORMANCE.md) | 真机性能结论与已修复项 |

## 使用与功能

| 文档 | 用途 |
|---|---|
| [README](../README.md) / [README_EN](../README_EN.md) | 项目介绍、构建、文档入口 |
| [FEATURES](FEATURES.md) | 相对原版 Obsidian 的功能与差异 |
| [tablet-demo](tablet-demo.md) | 平板功能演示（含 GIF） |

## 开发与设计

| 文档 | 用途 |
|---|---|
| [ARCHITECTURE](ARCHITECTURE.md) | 分层、模块、适配器、目录结构 |
| [DEV-ENV-SETUP](DEV-ENV-SETUP.md) | 从零搭建 DevEco 环境并装到平板 |
| [window-state-machine](window-state-machine.md) | 三种窗口形态的状态机与历史修正 |
| [PLATFORM-ADAPTATION](PLATFORM-ADAPTATION.md) | 平台能力差异清单与优先级 |
| [DRAG-DROP-INBOUND](DRAG-DROP-INBOUND.md) | 拖入/分享/碰一碰的入站管线 |
| [B-NATIVE-OVERLAY](B-NATIVE-OVERLAY.md) | 内联原生视频覆盖层设计 |
| [HEVC-HARDWARE-DECODE-ANALYSIS](HEVC-HARDWARE-DECODE-ANALYSIS.md) | HEVC 硬解可行性评估 |

## 历史与问题记录

| 文档 | 说明 |
|---|---|
| [CHANGES-2026-09](CHANGES-2026-09.md) / [CHANGES-2026-10](CHANGES-2026-10.md) | 逐轮开发日志，含真机取证；只用于追溯 |
| [BUG-BACKLOG](BUG-BACKLOG.md) | 使用中撞到的 bug 登记与状态 |
| [archive/](archive/README.md) | 审计、性能、体积等已完成的历史报告 |

## 维护约定

1. **一个主题一个文件**：手写只改 `STYLUS.md`，发布只改 `RELEASE.md`，不要另起
   `STYLUS-XXX.md` / `RELEASE-NOTES-XXX.md`。
2. **结论与证据分离**：当前行为写进顶层文档；一次性取证、审计、长日志放
   `archive/` 或 CHANGES，顶层只留结论和链接。
3. **版本号只写一处事实源**：`AppScope/app.json5`；README、CHANGELOG、RELEASE
   必须与它一致。
4. **发布前跑链接检查**：`node scripts/check-docs.cjs`（相对链接必须存在）。
