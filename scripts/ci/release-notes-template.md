OHSidian 是 [Obsidian](https://obsidian.md) 的非官方 HarmonyOS 移植版：在 HarmonyOS **平板 / 2in1 电脑**上直接运行原版 Obsidian。仅支持平板与 2in1 电脑，暂不支持手机。

> 目标系统：HarmonyOS 6.0.2 起（compatible API 22 / target API 24，真机验证）。遇到问题欢迎提 [Issue](https://github.com/PCFXPCFX/OHSidian/issues)。

## 本版亮点

- **手写笔**：华为 M-Pencil 压感墨迹、长按拉直、一笔成形、套索移动/复制/删除、压感橡皮、只擦荧光笔；
  笔记 / PDF / 内嵌 PDF / Canvas 均可书写。
- **PDF 写回**：标注写回真实注释，离开 PDF 时按脏页批量写入，首次写入前自动备份。
- 完整说明与验收项见 [docs/STYLUS.md](https://github.com/PCFXPCFX/OHSidian/blob/main/docs/STYLUS.md)。

## 相对 v1.4.2 的修复

- **鼠标滚轮 / 触控板捏合恢复**：主窗口、弹窗、内嵌窗口都能正常滚动与缩放。
- **删除更安全**：插件路径删除的旧文件不会再被清理逻辑当场永久删除。
- **切换仓库不再丢字**：旧仓库最后几秒的编辑与窗口布局在关窗前落盘。
- **PDF 写回更稳**：备份不再串到同名 PDF、双窗口同写不互相覆盖、"恢复原始 PDF"不再截断文件且荧光笔不会消失、单页笔迹过多会明确提示。
- **改名/移动文件**：墨迹跟随迁移改为原子写入，失败会提示。
- **设置页开关**：手写笔设置里的开关不会再有"只能开、点不灭"。
- 完整清单见 [docs/CHANGELOG.md](https://github.com/PCFXPCFX/OHSidian/blob/main/docs/CHANGELOG.md)。

**已知问题**：关闭应用前刚改过文件名、且此后再未书写时，最后一笔仍可能在退出时丢失（下一版补 `beforeunload` 兜底）；
同一 PDF 在第二个窗口打开时，"恢复原始 PDF"只对执行恢复的窗口立即生效，另一窗口重开该文档后同步。

## 下载

{{HAP_TABLE}}

同一版本提供两种桌面图标（下载表第一列即为图标预览）：**OHsidian 图标版**（本移植版专属）与
**Obsidian 官方图标版**，功能完全一致，按桌面图标喜好选择下载。
文件名中也带有图标标识，如 `OHSidian-v{{VERSION}}-obsidian-icon-unsigned.hap`
为 Obsidian 官方图标版。两个包签名后任选其一安装；换装另一版本时请先卸载
（或使用同一签名直接覆盖）。

## 安装与签名

HAP 是否可直接安装取决于文件名：含 `unsigned` 的需要先签名，含 `signed` 的已由项目证书签名。推荐使用图形化工具完成签名安装：

1. **小白调试助手**（原名 Auto-Installer）—— 基于 OpenHarmony HDC 工具的
   Flutter 图形化安装器：<https://github.com/likuai2010/auto-installer>
2. **HoKit** —— 一站式 Harmony NEXT 应用开发辅助工具，支持应用解析、
   重签名与一键安装：<https://github.com/yabi-zzh/HoKit>

也可以用 DevEco Studio 手动签名后安装，步骤见仓库
[docs/RELEASE.md](https://github.com/PCFXPCFX/OHSidian/blob/main/docs/RELEASE.md)。

## 校验值（OHSidian v{{VERSION}}）

下载后建议先校验文件完整性：

- Linux / macOS / Git Bash：`sha256sum -c SHA256SUMS.txt`
- Windows PowerShell：`Get-FileHash .\OHSidian-v{{VERSION}}-*-icon-unsigned.hap -Algorithm SHA256`

SHA-256:

```
{{SHA256}}
```

MD5:

```
{{MD5}}
```
