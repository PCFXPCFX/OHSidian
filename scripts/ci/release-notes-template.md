OHSidian 是 [Obsidian](https://obsidian.md) 的非官方 HarmonyOS 移植版：在 HarmonyOS **平板 / 2in1 电脑**上直接运行原版 Obsidian。仅支持平板与 2in1 电脑，暂不支持手机。

> 目标系统：HarmonyOS 6.0.2 起（compatible API 22 / target API 24，真机验证）。遇到问题欢迎提 [Issue](https://github.com/PCFXPCFX/OHSidian/issues)。

## 本版新增与修复（2.1.0）

- **内置 Pandoc（无需安装、无需弱沙箱）**：随包内置官方 Pandoc 3.10（WebAssembly），Enhancing Export /
  pandoc 类插件导出 docx、pptx、epub、html 等直接可用；平板与 PC 同一构建。限制：不能输出 PDF、
  不联网、只支持 Lua filter（可执行 filter 会明确拒绝）。
- **窗口形态状态机**：2in1 最大化/分屏/浮窗与平板触摸形态的布局发布改为显式判定，不再误发布移动布局。
- **插件链修复**：触屏模式依赖 Node 的插件不再"加载失败"；插件安装先校验再落盘（截断不再写坏）；
  `secretStorage` 明文兜底让 BRAT 等插件设置页正常注册（密钥明文保存在本地，设置页会提示未加密）；
  error 级日志默认落盘，插件失败可查。
- **设置与诊断**：底部新增 Pandoc / 诊断 / 日志三个分区（默认隐藏，可在常规里打开「显示高级信息」）；
  诊断报告为纯事实格式，且一次只跑一个。
- 完整清单见 [docs/CHANGELOG.md](https://github.com/PCFXPCFX/OHSidian/blob/main/docs/CHANGELOG.md)。

**仍存在的失败面（属内核/平台策略，与本版无关）**：内核硬拒载名单（`settings-search`、旧版 `cmdr` /
`obsidian-image-toolkit`、`better-pdf-plugin` 1.4.0）、deprecated 版本表、真正只支持移动端的插件、
依赖原生模块或未实现 Electron API 的插件；内置 Pandoc 不支持 PDF 与可执行 filter。

**已知问题**：内置 Pandoc 的插件级端到端导出仍需真机确认；关闭应用前刚改过文件名、且此后再未书写时，
最后一笔仍可能在退出时丢失（下一版补 `beforeunload` 兜底）；同一 PDF 在第二个窗口打开时，
"恢复原始 PDF"只对执行恢复的窗口立即生效，另一窗口重开该文档后同步。

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
